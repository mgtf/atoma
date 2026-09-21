# Worker first-write EACCES — candidate and reproduction, 2026-09-14

Status: historical defect recorded; not reproduced in four current-worker cases.
The candidate was opened before executing the protocol below. No new gate,
permission heuristic or runtime fix is proposed. The cooling-off rule applies.

## Historical observation

The API run `dee609e4-4c81-4866-9170-eed46318ef2c` on 2026-09-02
recorded four failed `write_file` calls (`EACCES` on `/workspace/bookmarks-api.js`),
three failed server starts and one rejected shell command, then a delivered
runner epilogue. The [audit](../value-audit-2026-09-14.md) records trace and log
hashes. Later successful shell writes alone do not establish that the tool and
shell had different permissions at the same instant.

The repository already contains the related fix, commit
`5d697fd45831d4d3f2e1941c6dc78a0c9b69a349`, dated 2026-09-02 16:02:47 +0300:
`fix(tools): create the worker workspace on the host before the engine mounts it`.
Its message records a root-owned workspace created by the daemon and an
operator `chown` through the daemon **during the run**, after which the agent
landed the file. That dated record explains the apparent contradiction; the
trace alone does not establish the timing of the operator action.

[`ContainerToolExecutor.start`](../../src/tools/containerExecutor.ts) now
creates the host mount source before spawning Docker. A mock lifecycle test
pins that ordering; existing isolation tests exercise real container writes.
The [tools contract](../../src/tools/AGENTS.md) already records this incident
class even though it had no standalone incident file.

Manifest scope also matters: `write_file` imports the shared manifest helpers
to validate and merge writes to `.atoma-probes.json`. It does not record every
ordinary file write as a probe. `record_probe`, recorded HTTP requests and
browser observations own their machine evidence. A shell file write therefore
does not by itself prove that a promised general file-write attestation was
bypassed. Preserve the distinction between recovery friction and final proof.

## Reproduction protocol

Use the currently installed worker image by immutable local image ID, the
compiled production executor, a non-root WSL host identity and isolated scratch
directories. No LLM, product store, historical workspace, quota or production
corpus is used. Confirm no live run/container is active before the diagnostic.

[`scripts/reproduce-worker-first-write.mjs`](../../scripts/reproduce-worker-first-write.mjs)
tests two initial mount states: absent and existing empty. The first tool call
is `write_file`; only afterwards does a shell redirection write another file.
There is no chmod/chown or preparatory tool call. Both files are checked from
the host, UID/GID/mode and worker module hashes are recorded, and the production
drain must prove removal before scratch cleanup.

Invocation after compiling with the pinned Node runtime:

```text
node scripts/reproduce-worker-first-write.mjs /absolute/repo/dist/tools/containerExecutor.js sha256:<installed-image-id> [existing-scratch-parent]
```

Run once with a Linux-native scratch parent and once with a Windows-backed
WSL mount. The latter is an additional environment check, not reconstruction
of the original Linux workspace ownership. Do not replace `atoma-worker:latest`
or alter permissions to make a failed arm pass. A failure remains evidence.

## Observed result

Executed on 2026-09-14 with Docker Engine 28.3.2, WSL Debian, host Node
24.20.0, UID/GID 1000:1000, against the already installed image:

`sha256:9fc3d7899a6e8eeac8eff6dd14109158d6d0dd6f40d7d1933ea5100f2d7c5715`

Image creation timestamp: `2026-09-14T09:41:06.425180588Z`. The tag was resolved
once and both diagnostics used that immutable ID; the image was not rebuilt.
The executor came from `/tmp/atoma-depth-validation-20260914/repo/dist`.
All TypeScript files in its source tree matched the current source at
`a5865c521b68462f393f44d6a77d3be1575be43b` after CRLF normalization.

| Scratch filesystem | Mount source before launch | First `write_file` | Subsequent shell write | Host/worker workspace owner and mode | Confirmed drain |
|---|---|---|---|---|---|
| Linux `/tmp` | absent | passed | exit 0, bytes match | 1000:1000, 0755 | yes |
| Linux `/tmp` | empty | passed | exit 0, bytes match | 1000:1000, 0755 | yes |
| Windows-backed `/mnt/c` | absent | passed | exit 0, bytes match | 1000:1000, 0777 | yes |
| Windows-backed `/mnt/c` | empty | passed | exit 0, bytes match | 1000:1000, 0777 | yes |

The 0777 mode is the observed Windows-backed mount behavior, not a chmod
performed by the diagnostic. Worker UID/GID was 1000:1000 in every case.
Both invocations returned exit 0. Each host read verified the exact file bytes.
Scratch directories were removed after the executor confirmed worker removal.

SHA-256 values read inside each worker matched the corresponding compiled
files on the host in all four cases:

| `/app/dist/tools/` module | SHA-256 |
|---|---|
| `worker.js` | `9f981b686768532e175c793044de303f9f254736fd1dddf4bfe0b2cebfe50f81` |
| `builtin.js` | `3f24183cdc2ac288378e991a55ecba3eaccd703c8f410c7fa12c72cab0ecd938` |
| `sandbox.js` | `532ebce44ea79e52fe263450d27283f12e849b2a78d2a030d1ed6495c3287fad` |

Conclusion: the current host-creation path works for the tested fresh mount
states, consistent with the existing fix. This does not prove that pre-existing
root-owned directories, every deployment filesystem or the original image
would work. No reconstruction of the old image or permission mutation was
performed. The historical operator intervention also means that run's delivered
epilogue alone is not evidence of unaided autonomous recovery. No production
corpus was collected and no LLM calls were made.
