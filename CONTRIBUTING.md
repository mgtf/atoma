# Contributing to atoma

Thank you for looking under the hood. This page is the short version; the
engineering contract itself lives in [`AGENTS.md`](AGENTS.md) and the
per-subsystem `AGENTS.md` files it maps, and it applies to humans and coding
agents alike.

## Before you write code

1. **Read [`AGENTS.md`](AGENTS.md)**, then the `AGENTS.md` of every subsystem
   you touch. Cost, safety and taxonomy rules are stated once, where the code
   is, and a change that violates one is declined regardless of its quality.
2. **Open an issue first for anything beyond a bug fix.** New gates, heuristics
   or validators are designed against collected incidents, not during the
   session that surfaced one; see the cooling-off rule in `AGENTS.md`.
3. **Sign the CLA** ([`CLA.md`](CLA.md)) on your first pull request. The bot
   asks for it; we cannot merge without it.

## Working on a change

```bash
nvm use
npm ci
npm run check          # typecheck + lint + tests, all offline, no paid calls
npm run docs:check     # subsystem map, README facts, architecture IR
```

- Tests live under `tests/`, use mocked LLMs and never spend money. A
  regression test must exercise the production path that failed, including
  any process or build boundary the bug crossed.
- Product copy is edited in `src/viz/client/locales/en.json` only; the other
  catalogues are filled by CI. Never hand-translate.
- Code, comments, commit messages and documentation are in English.
- Keep the worktree honest: `git diff --check` clean, every new source file
  tracked, no stores, traces, skills or workspaces in the commit.
- Runs execute on macOS or Linux. Windows is a development host; the full test
  suite runs in WSL2. [`docs/development-setup.md`](docs/development-setup.md)
  covers each platform.

## Pull requests

- One concern per pull request, with the rationale in the description and the
  tests that prove it.
- Rebase on `main`; CI must be green, including the hermetic and fresh-worker
  jobs.
- A change to a release path also needs `npm run release:check`; a container
  change also needs the worker build and isolation smoke.

## Security issues

Do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).

## Licence

atoma is free software under the GNU Affero General Public License v3.0
([`LICENSE`](LICENSE)). Your contribution is licensed to the project under the
terms of the CLA so that it can be released under the AGPL and, for organisations
that cannot accept the AGPL, under commercial terms. The CLA commits the project
to staying under an OSI-approved licence: the rights you grant will never be used
to take the code closed.
