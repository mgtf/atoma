# atoma

Three-tier LLM agent framework with a shared, persisted taxonomy and symmetric
supervision.

## Concept

Each *atom* is an LLM-backed agent. Atoms are organized in three tiers:

| Tier | Model | Role | Naming taxonomy |
|------|-------|------|-----------------|
| L1 | Haiku | Plans and executes one simple task. Cannot delegate. | Periodic elements (`Hydrogen`, `Helium`, …) |
| L2 | Sonnet | Supervises L1, can mutualize with peer L2s, falls back to self-execution | Molecules (`Water`, `Methane`, …) |
| L3 | Opus (auto-resolved) | Supervises L2, falls back to self-execution | Cells (`Neuron`, `Erythrocyte`, …) |

Types are created top-down: **application creates L3 → L3 creates L2 → L2 creates L1**.
Once created, a type is persisted in a shared SQLite registry and reusable by any
atom at the same tier.

### Supervision protocol (same at every parent→child link)

```
child.plan(task)  → Plan
parent.validatePlan(plan) → Verdict
  approved  → child.execute(task, plan) → Result
              parent.validateResult(result) → Verdict
                approved → return Result ↑
                rejected → apply modifications (scope) → re-plan
  rejected → apply modifications (scope) → re-plan

after maxIterations → ESCALADE:
  branch a new child type with lessons from the trace
  parent runs plan/execute itself (fallback mode)
  result is supervised by parent's own parent (symmetric)
```

### Mutation scopes

A rejection carries modifications (`systemPrompt`, `tools`, `params`, `additionalContext`)
and a scope:

- `ephemeral` — mutate this instance only; nothing written to the registry
- `patch` — update the canonical type in the registry (version++)
- `branch` — create a new type with the modifications applied; get the next
  available name from the tier's taxonomy

## Install & run

```bash
npm install
cp .env.example .env        # fill ANTHROPIC_API_KEY
npm run typecheck
npm test
npm run example:research "vertical farming"
npm run example:build "Build a modular dashboard in a single index.html with a canvas2D fps meter, a mouse tracker, and a keystroke logger."
npm run viz                 # web UI for the persisted run traces under ./runs
```

## Layout

- `src/core/` — types, base `Atom`, `superviseLoop` with escalation, Anthropic
  wrapper (with tool-use loop + rolling prompt-cache breakpoint), cost/metrics
- `src/registry/` — SQLite registry, tier taxonomies (elements/molecules/cells)
- `src/atoms/` — concrete `L1Atom`, `L2Atom`, `L3Atom`
- `src/tools/` — `ToolSandbox`, the built-in toolbox (`write_file`, `read_file`,
  `list_files`, `run_shell`, `start_static_server`, `validate_html`) used by
  L1 to produce real artefacts
- `src/viz/` — run recorder + self-contained web visualiser (`npm run viz`)
- `src/examples/` — `research-brief.ts` (text research) and `build-app.ts`
  (end-to-end "build me a working web app" demo)
- `tests/` — vitest unit + integration tests (mock LLM)

## Model auto-update

`L3Atom.fromType(type, registry, anthropic)` calls `client.models.list()` and picks
the most recently released Opus. Falls back to `claude-opus-4-7` on error or when
no Opus is listed. L1 and L2 pin to `claude-haiku-4-5-20251001` and
`claude-sonnet-4-6`.
