# Development setup — macOS, Linux, Windows

How to get from a clone to a green `npm run check` and a first real run, on each
platform. The rules here are not preferences: every warning below names the
measurement that produced it.

## What runs where

atoma splits into two paths with different platform requirements.

| Path | Commands | Needs |
|---|---|---|
| **Development** | `docs:check`, `typecheck`, `lint`, `build`, `viz` | Node only. Works on macOS, Linux and Windows. |
| **Verification** | `npm test`, `npm run check`, `release:check` | A POSIX host. Parts of the suite drive shells, `chmod`, `tar` and process groups on purpose. |
| **Runs** | `run:build`, `burnin`, `curriculum`, `benchmark`, operator runs through the MCP | macOS or Linux — see below. |
| **Container isolation** | `build:worker`, `doctor --container`, `release:container-smoke` | A real Docker daemon on a Linux/macOS host. |

Runs execute on **macOS or Linux only**, and
[`src/run/platform.ts`](../src/run/platform.ts) is the one place that says so. A
run is a detached process *group*, reaped through SIGTERM → grace → SIGKILL, and
its L1 children spawn shells, interpreters and browsers under a filesystem
sandbox. Windows has no equivalent: measured 2026-08-30, `npm` is a `.cmd` shim
Node refuses to spawn without a shell, and `process.kill(-pid)` has no meaning
without process groups, so cancellation reported success while orphans kept
running. The launcher now refuses before the spawn rather than failing silently
several processes deep. There is deliberately no override flag.

`npm run doctor` tells you which side you are on before you spend anything.

## Every platform

Node is pinned to **24.20.0** (`.nvmrc`), the runtime production runs;
`engines` accepts `>=24`. The 22.x line was dropped on 2026-09-07: the SQLite
driver needs Node-API 10 (22.14+), and keeping a second supported line meant a
second full CI arm for a version nothing deploys. Every CI job, the release
job and the mender image use the pin. The
[native SQLite incident](incidents/sqlite-node24-2026-09-06.md) records the
runtime evidence behind the driver requirement.

```bash
git clone https://github.com/mgtf/atoma.git
cd atoma
nvm install && nvm use
npm ci                            # `prepare` installs the husky hooks; needs .git
npm run check                     # docs:check + typecheck + lint + tests
npm run doctor:dev                # quota-free preflight, no build required
```

`npm ci` compiles `better-sqlite3` natively. A `node_modules` built for one
platform is unusable by another — never share one directory between a Windows
checkout and a WSL2 clone, or between host and container.

Organisation-scoped project runs (browser, MCP or `projects run`) additionally
require Docker and a provisioned host Haystack runtime. Follow the
[search setup](project-retrieval-haystack-only-2026-09-09.md#activation) and set
`ATOMA_PROJECT_RETRIEVAL_HAYSTACK` in the coordinator environment. Search is
mandatory for these runs, including an empty first corpus. The ordinary test
suite uses a ranking process fixture and needs no Haystack installation;
standalone operator runs have no tenant project corpus.

## macOS

Nothing beyond the common block is required for development, verification
and standalone operator runs. Two additional pieces:

- **Docker Desktop**, only for the container-isolation commands.
- **python3**, for the `start_static_server` element at run time, and
  **Pillow** for `viz:mark-turn:analyze`. Verify `python3 --version`; install
  Python if it is absent. Install Pillow in the Python environment used for the
  analysis script. Doctor reports missing Python as a warning.

Puppeteer downloads its own Chrome on `npm ci`, and macOS already carries the
libraries it links against.

## Linux (Debian / Ubuntu)

The reference platform — this is what CI proves. Beyond the common block, install
the system libraries Node's own install does not bring:

```bash
sudo apt-get update && sudo apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
  libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxkbcommon0 libxrandr2 libxss1 \
  build-essential python3 python3-pil
```

Why each group:

- **The `lib*` set.** Puppeteer downloads Chrome but not the shared objects it
  links against. Without these, every viz and browser test fails on a missing
  `.so` rather than on the change under test.
- **`build-essential`.** `better-sqlite3` ships linux-x64 prebuilds, but a
  prebuild miss must degrade to a local compile, not to a failed install.
- **`python3` / `python3-pil`.** As on macOS: the `start_static_server` element
  and `viz:mark-turn:analyze`. Use the distro package rather than `pip`, because
  Debian bookworm and later enforce PEP 668 on the system interpreter.

For container isolation, add Docker and put your user in the `docker` group.
Keep Chrome outside the workspace (`PUPPETEER_CACHE_DIR=~/.cache/puppeteer`, the
default) so `npm ci` cannot wipe it.

## Windows — through WSL2

Windows is a development host: edit, `typecheck`, `lint`, `docs:check`, `build`
and the compiled MCP smoke all pass there. Runs and the full test suite belong
in WSL2, in a clone on the Linux filesystem.

```powershell
wsl --install -d Debian          # then set it default if another distro exists
wsl --set-default Debian
```

Then, **inside** the distro, follow the Linux section above with the clone on
ext4:

```bash
cd ~ && mkdir -p dev && cd dev
git clone https://github.com/mgtf/atoma.git    # ~/dev/atoma, NOT /mnt/c/...
```

### Do not put the checkout on /mnt/c

Working against a Windows path from Linux carries two measured problems across
the boundary:

- **CRLF.** `core.autocrlf=true` ships in Git for Windows' *system* gitconfig
  and this repo has no `.gitattributes`, so a Windows checkout is CRLF in the
  worktree while the index is LF. Two tests and
  `benchmark/make-tabstat-seed.mjs --check` fail on that alone — the last one as
  a *false* seed drift, indistinguishable from real corruption of the benchmark
  instrument.
- **I/O cost.** A cross-filesystem mount plus host antivirus over an 81k-file
  `node_modules` is the plausible cause of the 187s typecheck and 182s lint
  measured on the Windows host, against roughly half that on a Linux
  filesystem.

Two clones on one machine is the normal arrangement: the Windows one for editing
in your IDE if you prefer it there, the WSL2 one for `npm run check` and runs.
They need separate `node_modules` (native modules, above).

### Windows traps worth knowing

- **Two different `$HOME`s.** Git Bash reports `MINGW64 ~/dev/atoma` with
  `HOME=/c/Users/<you>`; the distro reports `HOME=/home/<you>`. Same-looking `~`,
  two checkouts and two SSH keystores. Copy the key GitHub accepts into
  `~/.ssh` inside WSL2 (mode 600) if you push from there.
- **The viz is reachable from the Windows browser.** WSL2 forwards
  `localhost`, so a server bound to `127.0.0.1:5173` inside the distro opens at
  `http://localhost:5173` in Edge or Chrome on the host.
- **Docker Desktop's WSL integration** gives the distro a working `docker` CLI
  against the host daemon — enable it per distro in Docker Desktop's settings.

## Confirm you are operational

```bash
npm run check                     # expect rc=0
npm run doctor:dev                # expect READY, and no run-host failure
npm run viz:demo                  # a synthetic trace, mocked LLM, no spend
npm run viz:dev                   # UI :5173, API :4111
```

Then one real task. Pick the authentication you have:

```bash
# Every tier is REQUIRED and named as <api|sub>:<vendor>:<model>; there is no default.
ANTHROPIC_API_KEY=... ATOMA_MODEL_L1=api:anthropic:claude-haiku-4-5-20251001 \
  ATOMA_MODEL_L2=api:anthropic:claude-sonnet-5 ATOMA_MODEL_L3=api:anthropic:claude-opus-5 \
  npm run run:build:dev -- "a Node CLI that converts CSV to JSON"
ATOMA_MODEL_L1=sub:anthropic:haiku ATOMA_MODEL_L2=sub:anthropic:sonnet ATOMA_MODEL_L3=sub:anthropic:opus \
  npm run run:build:dev -- "…"                       # Claude subscription, no API key
ATOMA_MODEL_L1=api:ollama:qwen3:4b ATOMA_MODEL_L2=api:ollama:qwen3:14b ATOMA_MODEL_L3=api:ollama:qwen3:32b \
  npm run run:build:dev -- "…"                       # local models
```

Only one live run at a time on a machine: model quota is one account, and the MCP
run lease (`~/.atoma/mcp-run-lock.db`) is machine-global on purpose. Parallel
*editing* in two `git worktree` checkouts is fine and is described in
[`AGENTS.md`](../AGENTS.md).

## If something is red

- **`docs:check` fails on a link or a budget.** The message names the file and
  the rule; the contract is in [`AGENTS.md`](../AGENTS.md).
- **A browser test fails on a missing `.so`.** The apt list above is incomplete
  on your distro.
- **A run refuses with "not supported on win32".** You are in the Windows
  checkout, not the WSL2 one.
- **`npm run viz` fails to bind.** Ports are `strictPort`; set
  `ATOMA_VIZ_DEV_PORT` and `ATOMA_VIZ_API_PORT`, and stop a previous instance
  with Ctrl+C in its own terminal rather than killing the npm wrapper, which
  leaves both children listening.
- **Tests are flaky under load.** Several suites drive real processes with
  timing budgets. `npm test -- --maxWorkers=4` is the supported contended shape.
