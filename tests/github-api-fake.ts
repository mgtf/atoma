import { createHash } from 'node:crypto';

/**
 * A STATEFUL in-memory GitHub git API, shaped as a `fetch` implementation, so
 * the REAL `GitHubAppClient` composition runs against it.
 *
 * WHY IT EXISTS. `src/github/AGENTS.md` records that the git-data-cannot-start-
 * a-repository defect "survived because every publisher test mocks this client:
 * the suite pinned a sequence GitHub refuses". `tests/project-publisher.test.ts`
 * still hands the publisher a whole-client stub that always resolves and
 * never looks at any state — so it cannot observe a second commit, a branch
 * that already exists, a non-fast-forward, or an empty repository. Every
 * publication defect measured so far was invisible to it.
 *
 * This fake models git OBJECTS, not outcomes: content-addressed blobs, trees,
 * commits and refs, with the four behaviours that actually decide publication
 * correctness:
 *
 * 1. A repository with no refs REFUSES `git/blobs`, `git/trees`, `git/commits`
 *    AND the reference read with `409 {"message":"Git Repository is empty."}` —
 *    the git-data half measured against real GitHub on 2026-08-23 and recorded
 *    in `src/github/AGENTS.md`. 404 is reserved for a repository that HAS
 *    commits but not that branch, which is a different fact.
 * 2. `PUT /contents/{path}` works on an empty repository, creating the branch
 *    with a ROOT commit; on an existing branch it lands a commit with one
 *    parent, merging the file into the parent's tree. That parent count is the
 *    evidence the seed path checks.
 * 3. `POST /git/trees` honours `base_tree`, so a caller can choose between
 *    merging onto what is published and replacing it.
 * 4. `PATCH /git/refs/heads/{branch}` with `force: false` REFUSES a
 *    non-fast-forward with `422 {"message":"Update is not a fast forward"}`.
 *    Nothing else in this fake can move a ref backwards.
 *
 * Shas are real content hashes, so identical content yields an identical sha
 * and the empty-diff case is observable rather than stipulated.
 */

interface FakeCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

type TreeEntries = Map<string, { sha: string; mode: string }>;

interface FakeRepo {
  parentId?: string;
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  defaultBranch: string;
  readonly blobs: Map<string, Buffer>;
  readonly trees: Map<string, TreeEntries>;
  readonly commits: Map<string, FakeCommit>;
  readonly refs: Map<string, string>;
}

export interface FakeGitHubOptions {
  /** Repositories that already exist, as `owner/name`. */
  readonly existing?: readonly string[];
  readonly defaultBranch?: string;
}

function digest(kind: string, payload: string): string {
  return createHash('sha1').update(`${kind}\0${payload}`).digest('hex');
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A JSON field that must be a string, or a default. Never stringifies an object. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export class FakeGitHub {
  private readonly repos = new Map<string, FakeRepo>();
  private nextRepoId = 9_000_000;
  /** `METHOD /path`, in call order. The sequence is itself a contract. */
  readonly calls: string[] = [];
  readonly pullRequests: Array<{ html_url: string; owner: string; name: string; head: string; base: string }> = [];
  /**
   * The Authorization header of each call, index-aligned with `calls`. The
   * publisher deliberately uses a DIFFERENT token to create a repository than
   * to push into it, and that split is only observable here.
   */
  readonly authorizations: string[] = [];
  /**
   * How many reference moves asked for `force: true`. The composed flows must
   * never send it — `updateReference` hardcodes `force: false` and takes no
   * parameter — so this stays 0 and a test can prove it did.
   */
  forcedUpdates = 0;
  readonly defaultBranch: string;
  /**
   * What the App's installations can reach. `all` by default; `selected` with
   * `selectedRepositories` is the narrowed installation measured on
   * 2026-09-24 — it still mints tokens and still reads the repository, then
   * refuses the first write with 403 (`git/blobs`, `contents`).
   */
  repositorySelection: 'all' | 'selected' = 'all';
  readonly selectedRepositories = new Set<string>();
  /** Installation ids GitHub no longer knows: their token request answers 404. */
  readonly deletedInstallations = new Set<string>();

  constructor(options: FakeGitHubOptions = {}) {
    this.defaultBranch = options.defaultBranch ?? 'main';
    for (const slug of options.existing ?? []) {
      const [owner, name] = slug.split('/');
      this.createRepository(owner!, name!);
    }
  }

  createRepository(owner: string, name: string): void {
    this.repos.set(`${owner}/${name}`, {
      id: String(this.nextRepoId++),
      owner,
      name,
      defaultBranch: this.defaultBranch,
      blobs: new Map(),
      trees: new Map(),
      commits: new Map(),
      refs: new Map(),
    });
  }

  private repo(owner: string, name: string): FakeRepo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  private mustRepo(owner: string, name: string): FakeRepo {
    const found = this.repo(owner, name);
    if (!found) throw new Error(`fake GitHub has no repository ${owner}/${name}`);
    return found;
  }

  /** Head commit of a branch, or null when the branch does not exist. */
  refSha(owner: string, name: string, branch: string): string | null {
    return this.mustRepo(owner, name).refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Every path a branch's head tree holds, with its mode and decoded text. */
  filesOn(owner: string, name: string, branch: string): Map<string, { text: string; mode: string }> {
    const repo = this.mustRepo(owner, name);
    const head = repo.refs.get(`refs/heads/${branch}`);
    const files = new Map<string, { text: string; mode: string }>();
    if (!head) return files;
    const tree = repo.trees.get(repo.commits.get(head)!.tree);
    for (const [path, entry] of tree ?? []) {
      files.set(path, {
        text: (repo.blobs.get(entry.sha) ?? Buffer.alloc(0)).toString('utf8'),
        mode: entry.mode,
      });
    }
    return files;
  }

  /** Head-first commit history of a branch (first parent only). */
  historyOf(
    owner: string,
    name: string,
    branch: string
  ): Array<{ sha: string; message: string; tree: string; parents: readonly string[] }> {
    const repo = this.mustRepo(owner, name);
    const history: Array<{ sha: string; message: string; tree: string; parents: readonly string[] }> = [];
    let cursor = repo.refs.get(`refs/heads/${branch}`) ?? null;
    while (cursor) {
      const commit = repo.commits.get(cursor);
      if (!commit) break;
      history.push({ sha: cursor, message: commit.message, tree: commit.tree, parents: commit.parents });
      cursor = commit.parents[0] ?? null;
    }
    return history;
  }

  /**
   * A commit this product did not make — a human push, or another tool. Used to
   * build the REAL divergence case, which must not be reported with the words
   * reserved for "the branch already exists".
   */
  commitOutside(owner: string, name: string, branch: string, path: string, text: string): string {
    const repo = this.mustRepo(owner, name);
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref) ?? null;
    const base: TreeEntries = parent
      ? new Map(repo.trees.get(repo.commits.get(parent)!.tree) ?? [])
      : new Map();
    const blob = this.putBlob(repo, Buffer.from(text, 'utf8'));
    base.set(path, { sha: blob, mode: '100644' });
    const tree = this.putTree(repo, base);
    const commit = this.putCommit(repo, {
      tree,
      parents: parent ? [parent] : [],
      message: 'pushed by a human',
    });
    repo.refs.set(ref, commit);
    return commit;
  }

  /** Somebody deleted or renamed the branch. The repository keeps its commits. */
  deleteBranch(owner: string, name: string, branch: string): void {
    this.mustRepo(owner, name).refs.delete(`refs/heads/${branch}`);
  }

  private putBlob(repo: FakeRepo, bytes: Buffer): string {
    const sha = digest('blob', bytes.toString('base64'));
    repo.blobs.set(sha, bytes);
    return sha;
  }

  private putTree(repo: FakeRepo, entries: TreeEntries): string {
    const canonical = [...entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, entry]) => `${entry.mode} ${path} ${entry.sha}`)
      .join('\n');
    const sha = digest('tree', canonical);
    repo.trees.set(sha, new Map(entries));
    return sha;
  }

  private putCommit(repo: FakeRepo, commit: FakeCommit): string {
    const sha = digest('commit', `${commit.tree}|${commit.parents.join(',')}|${commit.message}`);
    repo.commits.set(sha, commit);
    return sha;
  }

  /** Is `candidate` a descendant of `ancestor`? The fast-forward test. */
  private descends(repo: FakeRepo, candidate: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const stack = [candidate];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = repo.commits.get(sha);
      if (commit) stack.push(...commit.parents);
    }
    return false;
  }

  private repoJson(repo: FakeRepo): Record<string, unknown> {
    return {
      id: repo.id,
      ...(repo.parentId ? { parent: { id: repo.parentId } } : {}),
      owner: { login: repo.owner },
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      default_branch: repo.defaultBranch,
      private: true,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
    };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const { pathname } = new URL(urlOf(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${pathname}`);
    this.authorizations.push(new Headers(init?.headers ?? {}).get('authorization') ?? '');
    const body: Record<string, unknown> =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    const tokenRoute = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(pathname);
    if (method === 'POST' && tokenRoute && this.deletedInstallations.has(tokenRoute[1]!)) {
      return json({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && pathname === '/installation/repositories') {
      const visible = [...this.repos.values()].filter((repo) =>
        this.repositorySelection === 'all' || this.selectedRepositories.has(`${repo.owner}/${repo.name}`));
      return json({ total_count: visible.length, repositories: visible.map((repo) => this.repoJson(repo)) });
    }
    if (method === 'POST' && tokenRoute) {
      return json(
        {
          token: 'ghs_fake-installation-token',
          expires_at: new Date(Date.UTC(2026, 7, 23, 23, 0, 0)).toISOString(),
          permissions: body['permissions'] ?? { administration: 'write', contents: 'write' },
          repository_selection: this.repositorySelection,
        },
        201
      );
    }

    // Repository creation, personal and organisation.
    const created = /^\/user\/repos$/.test(pathname)
      ? { owner: 'alice' }
      : /^\/orgs\/([^/]+)\/repos$/.exec(pathname);
    if (method === 'POST' && created) {
      const owner = Array.isArray(created) ? decodeURIComponent(created[1]!) : 'alice';
      const name = str(body['name'], 'unnamed');
      if (this.repo(owner, name)) return json({ message: 'name already exists on this account' }, 422);
      this.createRepository(owner, name);
      return json(this.repoJson(this.mustRepo(owner, name)), 201);
    }

    const repoRoute = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!repoRoute) return json({ message: `fake GitHub has no route for ${method} ${pathname}` }, 404);
    const owner = decodeURIComponent(repoRoute[1]!);
    const name = decodeURIComponent(repoRoute[2]!);
    const rest = repoRoute[3] ?? '';
    const repo = this.repo(owner, name);
    if (!repo) return json({ message: 'Not Found' }, 404);
    const empty = repo.refs.size === 0;

    if (method === 'GET' && rest === '') return json(this.repoJson(repo));
    if (method !== 'GET' && this.repositorySelection === 'selected' &&
      !this.selectedRepositories.has(`${owner}/${name}`)) {
      return json({ message: 'Resource not accessible by integration' }, 403);
    }
    if (rest === '/forks' && method === 'POST') {
      const destinationOwner = str(body['organization'], 'alice');
      const destinationName = str(body['name'], name);
      if (this.repo(destinationOwner, destinationName)) return json({}, 422);
      this.createRepository(destinationOwner, destinationName);
      const fork = this.mustRepo(destinationOwner, destinationName);
      fork.parentId = repo.id;
      for (const [key, value] of repo.blobs) fork.blobs.set(key, value);
      for (const [key, value] of repo.trees) fork.trees.set(key, value);
      for (const [key, value] of repo.commits) fork.commits.set(key, value);
      for (const [key, value] of repo.refs) fork.refs.set(key, value);
      return json(this.repoJson(fork), 202);
    }
    if (rest === '/pulls') {
      if (method === 'GET') {
        const query = new URL(urlOf(input)).searchParams;
        return json(this.pullRequests.filter(pr => pr.owner === owner && pr.name === name &&
          `${owner}:${pr.head}` === query.get('head') && pr.base === query.get('base')));
      }
      if (method === 'POST') {
        const pr = { owner, name, head: str(body['head']), base: str(body['base']),
          html_url: `https://github.com/${owner}/${name}/pull/${this.pullRequests.length + 1}` };
        this.pullRequests.push(pr);
        return json(pr, 201);
      }
    }
    const treeRead = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && treeRead) {
      const tree = repo.trees.get(treeRead[1]!);
      if (!tree) return json({}, 404);
      return json({ truncated: false, tree: [...tree].map(([path, entry]) => ({ ...entry, path, type: 'blob' })) });
    }
    const blobRead = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && blobRead) {
      const bytes = repo.blobs.get(blobRead[1]!);
      if (!bytes) return json({}, 404);
      return json({ encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    }


    // GET /git/ref/heads/{branch}
    const refRead = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === 'GET' && refRead) {
      const branch = decodeURIComponent(refRead[1]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      // 409 and 404 are DIFFERENT facts, and the publication flow decides from
      // exactly that difference: 409 is "this repository has no commits at
      // all", which the contents API exists to seed; 404 is "it has commits
      // but not this branch", which for a project that already published means
      // somebody deleted or renamed it.
      if (empty) return json({ message: 'Git Repository is empty.' }, 409);
      if (!sha) return json({ message: 'Not Found' }, 404);
      return json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }

    // GET /git/commits/{sha}
    const commitRead = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && commitRead) {
      const sha = commitRead[1]!;
      const commit = repo.commits.get(sha);
      if (!commit) return json({ message: 'Not Found' }, 404);
      return json({
        sha,
        message: commit.message,
        tree: { sha: commit.tree },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      });
    }

    // THE MEASURED REFUSAL: git data cannot start a repository.
    if (method === 'POST' && /^\/git\/(blobs|trees|commits)$/.test(rest) && empty) {
      return json({ message: 'Git Repository is empty.' }, 409);
    }

    if (method === 'POST' && rest === '/git/blobs') {
      const content = str(body['content'], '');
      const bytes =
        body['encoding'] === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      return json({ sha: this.putBlob(repo, bytes) }, 201);
    }

    if (method === 'POST' && rest === '/git/trees') {
      const entries: TreeEntries = new Map();
      const baseTree = body['base_tree'];
      if (typeof baseTree === 'string') {
        const base = repo.trees.get(baseTree);
        if (!base) return json({ message: 'base_tree is not a tree in this repository' }, 422);
        for (const [path, entry] of base) entries.set(path, { ...entry });
      }
      for (const raw of Array.isArray(body['tree']) ? body['tree'] : []) {
        const entry = raw as Record<string, unknown>;
        const path = str(entry['path'], '');
        const sha = str(entry['sha'], '');
        if (!repo.blobs.has(sha)) return json({ message: `blob ${sha} is missing` }, 422);
        entries.set(path, { sha, mode: str(entry['mode'], '100644') });
      }
      return json({ sha: this.putTree(repo, entries) }, 201);
    }

    if (method === 'POST' && rest === '/git/commits') {
      const tree = str(body['tree'], '');
      if (!repo.trees.has(tree)) return json({ message: `tree ${tree} is missing` }, 422);
      const parents = (Array.isArray(body['parents']) ? body['parents'] : []).map(String);
      for (const parent of parents) {
        if (!repo.commits.has(parent)) return json({ message: `parent ${parent} is missing` }, 422);
      }
      const sha = this.putCommit(repo, {
        tree,
        parents,
        message: str(body['message'], ''),
      });
      return json({ sha }, 201);
    }

    if (method === 'POST' && rest === '/git/refs') {
      const ref = str(body['ref'], '');
      const sha = str(body['sha'], '');
      if (repo.refs.has(ref)) return json({ message: 'Reference already exists' }, 422);
      if (!repo.commits.has(sha)) return json({ message: `commit ${sha} is missing` }, 422);
      repo.refs.set(ref, sha);
      return json({ ref, object: { sha, type: 'commit' } }, 201);
    }

    // PATCH /git/refs/heads/{branch} — the fast-forward gate.
    const refMove = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === 'PATCH' && refMove) {
      const branch = decodeURIComponent(refMove[1]!);
      const ref = `refs/heads/${branch}`;
      const sha = str(body['sha'], '');
      const current = repo.refs.get(ref);
      if (current === undefined) return json({ message: 'Reference does not exist' }, 422);
      if (!repo.commits.has(sha)) return json({ message: `commit ${sha} is missing` }, 422);
      if (body['force'] === true) this.forcedUpdates += 1;
      if (body['force'] !== true && !this.descends(repo, sha, current)) {
        return json({ message: 'Update is not a fast forward' }, 422);
      }
      repo.refs.set(ref, sha);
      return json({ ref, object: { sha, type: 'commit' } });
    }

    // PUT /contents/{path} — the only write that works on an empty repository.
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (method === 'PUT' && contents) {
      const path = contents[1]!.split('/').map(decodeURIComponent).join('/');
      const branch = str(body['branch'], repo.defaultBranch);
      const ref = `refs/heads/${branch}`;
      const parent = repo.refs.get(ref) ?? null;
      // UNMEASURED, and flagged as such: real GitHub is believed to answer 404
      // for a contents write naming a branch that does not exist in a
      // repository that HAS commits — you cannot create a branch this way. The
      // empty-repository case above IS measured (201). Verifying this exact
      // combination against real GitHub is a pre-registered check; until then
      // the fake refuses, which is the conservative direction.
      if (parent === null && !empty) return json({ message: 'Branch not found' }, 404);
      const entries: TreeEntries = parent
        ? new Map(repo.trees.get(repo.commits.get(parent)!.tree) ?? [])
        : new Map();
      const bytes = Buffer.from(str(body['content'], ''), 'base64');
      entries.set(path, { sha: this.putBlob(repo, bytes), mode: '100644' });
      const tree = this.putTree(repo, entries);
      const commit = this.putCommit(repo, {
        tree,
        parents: parent ? [parent] : [],
        message: str(body['message'], ''),
      });
      repo.refs.set(ref, commit);
      return json(
        {
          content: { path },
          commit: {
            sha: commit,
            tree: { sha: tree },
            parents: parent ? [{ sha: parent }] : [],
          },
        },
        parent ? 200 : 201
      );
    }

    return json({ message: `fake GitHub has no route for ${method} ${pathname}` }, 404);
  };
}
