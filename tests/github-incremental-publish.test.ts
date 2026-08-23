import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GitHubAppClient,
  GitHubBranchGoneError,
  GitHubDivergenceError,
  GitHubRefRefusedError,
  MAX_GITHUB_PUBLISH_FILE_BYTES,
  MAX_GITHUB_PUBLISH_FILES,
  MAX_GITHUB_PUBLISH_TOTAL_BYTES,
  MAX_GITHUB_REQUEST_BODY_BYTES,
} from '../src/github/client.js';
import { DEFAULT_ARTIFACT_LIMITS } from '../src/projects/artifacts.js';
import { FakeGitHub } from './github-api-fake.js';

/**
 * The REAL client composition against a STATEFUL GitHub. Everything the
 * publisher's own suite cannot see, because it mocks the client whole.
 *
 * The first cases pin the fake against behaviour already measured on real
 * GitHub (`src/github/AGENTS.md`): the git data API refuses an empty
 * repository, the contents API does not, and one file is one commit. If the
 * fake were wrong about those, nothing built on it would mean anything.
 *
 * Then the ceiling this file exists for: `mgtf/atoma-e2e-stopwatch-2` holds a
 * stopwatch with no lap button because run `a06b09ff` — delivered — was refused
 * with `GitHub repository branch already exists; initial publish refused`.
 */

function clientFor(fake: FakeGitHub, fetchImpl?: typeof fetch): GitHubAppClient {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return new GitHubAppClient(
    { appId: '123456', appSlug: 'atoma-test', privateKey, apiBaseUrl: 'https://api.github.test' },
    { fetch: fetchImpl ?? fake.fetch, now: () => Date.UTC(2026, 7, 23, 12, 0, 0) }
  );
}

const TOKEN = 'ghs_fake-installation-token';
const REPO = { owner: 'alice', name: 'clock' } as const;

function publish(
  client: GitHubAppClient,
  files: Array<{ path: string; content: string; mode?: '100644' | '100755' }>,
  expectedHead: string | null,
  message = 'atoma: publish artifacts for run one'
) {
  return client.publishManifestCommit({
    token: TOKEN,
    repository: REPO,
    branch: 'main',
    message,
    files,
    expectedHead,
  });
}

describe('the fake GitHub is faithful to what was measured', () => {
  it('refuses git data on an empty repository and accepts the contents API', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    await expect(
      client.createBlob({ token: TOKEN, owner: 'alice', repository: 'clock', content: 'x' })
      // `GitHubApiError` carries the STATUS and not GitHub's message body —
      // already recorded for repository creation's 422. So a caller can only
      // ever see "HTTP 409" here, which is why no flow may depend on reading
      // GitHub's prose.
    ).rejects.toThrow(/POST \/repos\/alice\/clock\/git\/blobs returned HTTP 409/);
    const seeded = await client.putContentsFile({
      token: TOKEN,
      owner: 'alice',
      repository: 'clock',
      path: 'index.html',
      content: '<h1>clock</h1>',
      message: 'seed',
      branch: 'main',
    });
    expect(seeded.parents).toBe(0);
    expect(fake.refSha('alice', 'clock', 'main')).toBe(seeded.commitSha);
  });

  /** 409 and 404 are different facts, and the flow decides from the difference. */
  it('discriminates an empty repository from a missing branch', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    expect(await client.readBranchHead(TOKEN, 'alice', 'clock', 'main')).toEqual({ state: 'empty' });
    await publish(client, [{ path: 'index.html', content: '<h1>clock</h1>' }], null);
    expect(await client.readBranchHead(TOKEN, 'alice', 'clock', 'other')).toEqual({
      state: 'missing',
    });
    const head = await client.readBranchHead(TOKEN, 'alice', 'clock', 'main');
    expect(head.state === 'head' && head.sha).toBe(fake.refSha('alice', 'clock', 'main'));
  });

  it('publishes one file as one root commit, never touching the git data API', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    const commit = await publish(client, [{ path: 'index.html', content: '<h1>clock</h1>' }], null);
    expect(commit.publishKind).toBe('created');
    expect(commit.baseSha).toBeNull();
    expect(fake.historyOf('alice', 'clock', 'main')).toHaveLength(1);
    expect(fake.calls.filter((call) => call.includes('/git/blobs'))).toEqual([]);
    expect([...fake.filesOn('alice', 'clock', 'main').keys()]).toEqual(['index.html']);
  });

  it('publishes several files as a seed plus one git-data commit', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    const commit = await publish(
      client,
      [
        { path: 'index.html', content: '<h1>clock</h1>' },
        { path: 'app.js', content: 'const t = 0;' },
        { path: 'run.sh', content: '#!/bin/sh\n', mode: '100755' },
      ],
      null
    );
    expect(commit.publishKind).toBe('created');
    expect(fake.historyOf('alice', 'clock', 'main')).toHaveLength(2);
    const files = fake.filesOn('alice', 'clock', 'main');
    expect([...files.keys()].sort()).toEqual(['app.js', 'index.html', 'run.sh']);
    // The recorded mode travels all the way to the tree.
    expect(files.get('run.sh')?.mode).toBe('100755');
  });
});

describe('incremental publication', () => {
  /** The inversion of `8597ec79` / `a06b09ff`: run 2 reaches the repository. */
  it('commits run 2 on top of run 1 and keeps what run 2 did not declare', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    const first = await publish(
      client,
      [
        { path: 'index.html', content: '<h1>clock</h1>' },
        { path: 'app.js', content: 'const t = 0;' },
      ],
      null
    );
    const before = fake.filesOn('alice', 'clock', 'main').get('app.js');

    // Run 2 declares ONLY the file it changed — which is what a manifest is.
    const second = await publish(
      client,
      [{ path: 'index.html', content: '<h1>clock with laps</h1>' }],
      first.commitSha,
      'atoma: publish artifacts for run two'
    );

    expect(second.publishKind).toBe('extended');
    expect(second.baseSha).toBe(first.commitSha);
    const history = fake.historyOf('alice', 'clock', 'main');
    expect(history[0]!.sha).toBe(second.commitSha);
    expect(history[0]!.parents).toEqual([first.commitSha]);
    const files = fake.filesOn('alice', 'clock', 'main');
    expect(files.get('index.html')?.text).toBe('<h1>clock with laps</h1>');
    // MERGE, NOT REPLACE: `app.js` was never declared by run 2 and is still
    // there, at its original blob. Replacing the tree would have deleted it
    // while it still sat on disk in that very run.
    expect(files.get('app.js')).toEqual(before);
  });

  it('records a manifest already on the branch as a no-op, with no commit', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    const files = [{ path: 'index.html', content: '<h1>clock</h1>' }];
    const first = await publish(client, files, null);
    const before = fake.calls.length;

    const again = await publish(client, files, first.commitSha, 'atoma: publish artifacts for run two');

    expect(again.publishKind).toBe('unchanged');
    expect(again.commitSha).toBe(first.commitSha);
    expect(again.baseSha).toBe(first.commitSha);
    const after = fake.calls.slice(before);
    expect(after.filter((call) => call.startsWith('POST /repos/alice/clock/git/commits'))).toEqual([]);
    expect(after.filter((call) => call.startsWith('PATCH'))).toEqual([]);
    expect(fake.historyOf('alice', 'clock', 'main')).toHaveLength(1);
  });

  it('preserves an executable mode a later run does not redeclare', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    const first = await publish(
      client,
      [
        { path: 'index.html', content: '<h1>clock</h1>' },
        { path: 'run.sh', content: '#!/bin/sh\n', mode: '100755' },
      ],
      null
    );
    await publish(client, [{ path: 'index.html', content: '<h1>v2</h1>' }], first.commitSha);
    expect(fake.filesOn('alice', 'clock', 'main').get('run.sh')?.mode).toBe('100755');
  });
});

describe('incremental publication refuses what it must not write', () => {
  /**
   * The guard that replaces the deleted empty-branch precondition.
   * `ensureRepository` ADOPTS a pre-existing repository on a 422 name
   * collision, and nothing in the projects DDL forbids two projects of one
   * organisation naming the same repository — so a first publication onto a
   * populated branch must still refuse, with zero writes.
   */
  it('refuses a first publication onto a populated branch, writing nothing', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    await publish(client, [{ path: 'index.html', content: '<h1>clock</h1>' }], null);
    const head = fake.refSha('alice', 'clock', 'main')!;
    const before = fake.calls.length;

    const failure = await publish(
      client,
      [{ path: 'index.html', content: '<h1>somebody else</h1>' }],
      null
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubDivergenceError);
    const error = failure as GitHubDivergenceError;
    // The historical sentence is preserved as a PREFIX — it is quoted in
    // AGENTS.md and stored on the live `a06b09ff` row — and the head it does
    // not own is now named.
    expect(error.message).toContain('GitHub repository branch already exists; initial publish refused');
    expect(error.message).toContain(head.slice(0, 7));
    expect(error.observedHead).toBe(head);
    // ONE call: the reference read. No blob, no tree, no contents write.
    expect(fake.calls.slice(before)).toEqual(['GET /repos/alice/clock/git/ref/heads/main']);
    expect(fake.refSha('alice', 'clock', 'main')).toBe(head);
    expect(fake.filesOn('alice', 'clock', 'main').get('index.html')?.text).toBe('<h1>clock</h1>');
  });

  it('refuses when the branch this project published has been deleted', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    const first = await publish(client, [{ path: 'index.html', content: '<h1>clock</h1>' }], null);
    // Somebody renamed or deleted `main`; the repository still has commits.
    fake.commitOutside('alice', 'clock', 'trunk', 'index.html', '<h1>moved</h1>');
    fake.deleteBranch('alice', 'clock', 'main');
    const before = fake.calls.length;

    const failure = await publish(
      client,
      [{ path: 'index.html', content: '<h1>v2</h1>' }],
      first.commitSha
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubBranchGoneError);
    expect((failure as GitHubBranchGoneError).reason).toBe('missing');
    expect((failure as GitHubBranchGoneError).message).toMatch(/no longer exists although this project published/);
    // Refused rather than re-seeded: a second root history in a repository a
    // tenant already cloned is worse than a stopped publication.
    expect(fake.calls.slice(before)).toEqual(['GET /repos/alice/clock/git/ref/heads/main']);
  });

  it('refuses when the repository this project published to has no commits', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    const failure = await publish(
      client,
      [{ path: 'index.html', content: '<h1>v2</h1>' }],
      'f'.repeat(40)
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubBranchGoneError);
    expect((failure as GitHubBranchGoneError).reason).toBe('empty');
    expect((failure as GitHubBranchGoneError).message).toMatch(/has no commits although this project published/);
  });

  /**
   * THE REAL DIVERGENCE, and it must not borrow one word from the sentence
   * above: somebody moved the branch while this publication was being built.
   */
  it('names a branch that moved under it, and converges on retry', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    let intruder: string | null = null;
    // Move the branch after the head read and the tree build, immediately
    // before the reference is moved.
    const racing: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/git/commits') && intruder === null) {
        intruder = fake.commitOutside('alice', 'clock', 'main', 'README.md', 'hand written');
      }
      return fake.fetch(input, init);
    };
    const client = clientFor(fake, racing);
    const first = await publish(client, [{ path: 'index.html', content: '<h1>clock</h1>' }], null);

    const failure = await publish(
      client,
      [{ path: 'index.html', content: '<h1>v2</h1>' }],
      first.commitSha
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubRefRefusedError);
    const refused = failure as GitHubRefRefusedError;
    expect(refused.reason).toBe('moved');
    expect(refused.message).toMatch(/moved from .* to /);
    expect(refused.message).not.toMatch(/initial publish refused/);
    expect(refused.message).not.toMatch(/already exists/);
    // The branch is the intruder's commit, and nothing was force-updated.
    expect(fake.refSha('alice', 'clock', 'main')).toBe(intruder);

    // A RETRY CONVERGES, where today it loops forever: the head read now finds
    // the intruder's commit and the manifest merges onto it.
    const retried = await publish(
      client,
      [{ path: 'index.html', content: '<h1>v2</h1>' }],
      first.commitSha
    );
    expect(retried.publishKind).toBe('extended');
    expect(retried.baseSha).toBe(intruder);
    const files = fake.filesOn('alice', 'clock', 'main');
    expect(files.get('index.html')?.text).toBe('<h1>v2</h1>');
    expect(files.get('README.md')?.text).toBe('hand written');
  });

  /**
   * 422 is ALSO how a ruleset answers. Reporting a protected branch as
   * "somebody pushed" sends an operator hunting a push that never happened.
   */
  it('distinguishes a protection rule from a push, on the same status', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const blocking: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET') === 'PATCH' && url.includes('/git/refs/heads/')) {
        return new Response(JSON.stringify({ message: 'Protected branch update failed' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return fake.fetch(input, init);
    };
    const client = clientFor(fake, blocking);
    const first = await publish(client, [{ path: 'index.html', content: '<h1>clock</h1>' }], null);

    const failure = await publish(
      client,
      [{ path: 'index.html', content: '<h1>v2</h1>' }],
      first.commitSha
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubRefRefusedError);
    expect((failure as GitHubRefRefusedError).reason).toBe('blocked');
    expect((failure as GitHubRefRefusedError).message).toMatch(
      /branch protection rule or ruleset forbids this update/
    );
    expect((failure as GitHubRefRefusedError).message).not.toMatch(/moved from/);
  });

  it('turns a branch created inside the seed window into explicit divergence', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    // The head read says empty; somebody creates the branch before the seed
    // lands, so the seed commit acquires a parent.
    const racing: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET') === 'PUT' && url.includes('/contents/')) {
        if (fake.refSha('alice', 'clock', 'main') === null) {
          fake.commitOutside('alice', 'clock', 'main', 'README.md', 'first!');
        }
      }
      return fake.fetch(input, init);
    };
    const client = clientFor(fake, racing);
    const failure = await publish(
      client,
      [{ path: 'index.html', content: '<h1>clock</h1>' }, { path: 'app.js', content: 'x' }],
      null
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubDivergenceError);
    // One file was written by then, and saying so beats piling the rest of the
    // manifest onto content this product never saw.
    expect(fake.calls.some((call) => call.includes('/git/blobs'))).toBe(false);
  });

  it('refuses a fast-forward that is not one, and never sends force', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    await publish(client, [{ path: 'index.html', content: '<h1>clock</h1>' }], null);
    const stale = fake.refSha('alice', 'clock', 'main')!;
    fake.commitOutside('alice', 'clock', 'main', 'README.md', 'hand written');
    await expect(
      client.updateReference({
        token: TOKEN,
        owner: 'alice',
        repository: 'clock',
        branch: 'main',
        commitSha: stale,
      })
      // The fake answers 422 {"message":"Update is not a fast forward"} and the
      // client surfaces only the status — which is why the composed flow
      // OBSERVES the reference instead of parsing an error.
    ).rejects.toThrow(/PATCH \/repos\/alice\/clock\/git\/refs\/heads\/main returned HTTP 422/);
    expect(fake.refSha('alice', 'clock', 'main')).not.toBe(stale);
    expect(fake.forcedUpdates).toBe(0);
  });
});

/**
 * TWO CEILINGS THAT MUST AGREE, across a boundary neither module may import.
 *
 * `src/github` must not import `src/projects` and vice versa, so nothing in the
 * type system can hold these together. This test is the only thing that does.
 *
 * The defect it closes: the publish TOTAL was 20 MiB while the artifact policy
 * accepted 50 MiB, so a 21-50 MiB deliverable was recorded `delivered` and then
 * failed every publish attempt for ever — with a byte-bound message that read
 * like a transient limit.
 */
describe('the publish bounds and the artifact policy agree', () => {
  it('never lets the artifact policy accept a manifest publication cannot carry', () => {
    expect(MAX_GITHUB_PUBLISH_TOTAL_BYTES).toBeGreaterThanOrEqual(
      DEFAULT_ARTIFACT_LIMITS.maxTotalBytes
    );
    expect(MAX_GITHUB_PUBLISH_FILE_BYTES).toBeGreaterThanOrEqual(
      DEFAULT_ARTIFACT_LIMITS.maxFileBytes
    );
    expect(MAX_GITHUB_PUBLISH_FILES).toBeGreaterThanOrEqual(DEFAULT_ARTIFACT_LIMITS.maxFiles);
  });

  it('derives the per-file bound from the request body cap and base64 inflation', () => {
    // Every file travels as its own base64 request body, which inflates by 4/3.
    expect(Math.ceil((MAX_GITHUB_PUBLISH_FILE_BYTES * 4) / 3)).toBeLessThan(
      MAX_GITHUB_REQUEST_BODY_BYTES
    );
  });

  it('refuses a single file over the per-file bound before any request', async () => {
    const fake = new FakeGitHub({ existing: ['alice/clock'] });
    const client = clientFor(fake);
    await expect(
      client.createBlob({
        token: TOKEN,
        owner: 'alice',
        repository: 'clock',
        content: Buffer.alloc(MAX_GITHUB_PUBLISH_FILE_BYTES + 1),
      })
    ).rejects.toThrow(/per-file publish byte bound/);
    expect(fake.calls).toEqual([]);
  });
});
