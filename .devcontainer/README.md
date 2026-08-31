# Dev container — what it is for, and what it is not

This container exists so the **verification path** behaves identically on every
developer machine: `npm run docs:check`, `typecheck`, `lint`, `test`, `build`.
It mirrors the only environment the repo is actually proven in — CI runs every
job on `ubuntu-latest` with Node pinned to `22.13.0`
([.github/workflows/ci.yml](../.github/workflows/ci.yml)).

## Put the checkout on a Linux filesystem

**Do not open this container against a Windows path.** Bind-mounting a Windows
worktree into Linux carries two measured problems into the container:

- **CRLF.** `core.autocrlf=true` ships in Git for Windows' *system* gitconfig,
  and this repo has no `.gitattributes`, so a Windows checkout is CRLF in the
  worktree while the index is LF. Two tests and
  `benchmark/make-tabstat-seed.mjs --check` fail on that alone — the last one
  as a *false* seed drift, indistinguishable from real corruption of the
  benchmark instrument.
- **I/O cost.** Cross-filesystem bind mounts plus host antivirus over an
  81k-file `node_modules` is the plausible cause of the 187s typecheck / 182s
  lint measured on the Windows host.

Two ways to get a Linux checkout:

1. Clone inside WSL2 (`~/dev/atoma` on ext4), open the folder through the WSL
   remote, then **Reopen in Container**. Preferred, because the same WSL2
   instance is also where runs should happen — see below.
2. VS Code → **Dev Containers: Clone Repository in Container Volume**.

`node_modules` is a named volume in both cases, so a host install and a
container install can never overwrite each other. `better-sqlite3` is native:
one build is unusable by the other platform.

## There is no Docker socket in here, on purpose

`atoma` **spawns containers itself** for L1 tool isolation. Mounting
`/var/run/docker.sock` into this container would make those workers *siblings*
on the host daemon, and
[`src/tools/containerExecutor.ts`](../src/tools/containerExecutor.ts) binds the
workspace by **host path** (`${workspaceHostPath}:/workspace`) — a path that
does not mean the same thing on both sides of the socket. The bind mount would
silently point somewhere else.

It is also a privilege argument. That same function builds its isolation from
`--network none`, `--cap-drop ALL` and `no-new-privileges`; handing the
control-plane container a Docker socket grants it the equivalent of host root,
which is the opposite of what those flags buy. `--privileged` docker-in-docker
is worse.

So the split is:

| Task | Where |
|---|---|
| `docs:check`, `typecheck`, `lint`, `test`, `build` | this container |
| `build:worker`, `doctor --container`, `release:container-smoke`, real agent runs | a Linux host with a real daemon — WSL2 |

## What this container does not fix

It makes the Windows-host defects **invisible to you**, not absent. They still
ship: `atoma_run_trace` (one of the 13 exported MCP tools) refuses every trace
on a Windows host, `atoma_run_cancel` reports success without killing anything,
and the scratch-HOME confinement in
[`src/tools/sandbox.ts`](../src/tools/sandbox.ts) never engages because it tests
`HOME`, which Windows does not set. That last one is a credentials exposure, and
it is a design defect rather than a platform quirk — on Linux it fires by luck.

Whether Windows is a supported host is still an open decision for
[AGENTS.md](../AGENTS.md). This container is how you stop *paying* for that
decision daily; it is not the decision.
