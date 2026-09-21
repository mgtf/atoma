# The production catalogue, measured — 2026-09-16

Read-only measurement of the live `atoma.run` store, taken the morning after
the platform fold ([one registry, one trust](../platform-trust-2026-09-15.md))
and the trust/reuse correction
([recoverable trust](../recoverable-trust-2026-09-15.md)) were deployed. It
closes the evidence gap that second record names: its production counts were
owner-supplied incident context, and nothing had queried the store.

No run has executed since either deployment, so these numbers are the state the
corrections left behind, not their effect.

## How it was taken

Three read-only queries against `/home/atoma/state/atoma.db`, run on the host as
the service user. The store is `0600 atoma:atoma` and the SSH account has no
passwordless sudo, so an agent cannot take this measurement unaided.

```bash
cd /home/atoma/current && sudo -u atoma node --input-type=module -e "
import D from 'better-sqlite3';
import { atomBehaviorKey } from './dist/registry/atomRegistry.js';
const db = new D('/home/atoma/state/atoma.db', { readonly: true });
const g = new Map();
for (const r of db.prepare('SELECT tier,name,system_prompt,tools_json,params_json,successes,failures,consecutive_successes FROM atom_types ORDER BY tier,ordinal').all()) {
  const k = atomBehaviorKey(r.tier, { systemPrompt: r.system_prompt, tools: JSON.parse(r.tools_json), params: JSON.parse(r.params_json) });
  (g.get(k) ?? g.set(k, []).get(k)).push(r);
}
for (const [, v] of g) console.log(v.map(r => \`\${r.tier} \${r.name} \${r.successes}/\${r.failures} streak=\${r.consecutive_successes}\`).join(' | '));
db.close();"
```

The other two group `atom_types` by sorted tool names, and count
`lifecycle_events` by kind. Grouping by TOOL SIGNATURE is not the same question
as grouping by `atomBehaviorKey`; the first measurement here made that mistake
and overstated how much the reuse rule would collapse.

## What the store holds

Twelve agent types: nine molecules, three cells, one tissue.

| Rank | Type | ✓/✗ | Streak | Tool signature |
|---|---|---|---|---|
| L1 | Water | 1/2 | 0 | web artefact (6) |
| L1 | Glucose | 11/6 | 0 | web artefact (6) |
| L1 | Sucrose | 3/1 | 0 | web artefact (6) |
| L1 | Methane | 0/0 | 0 | node server (7) |
| L1 | Ammonia | 1/0 | 1 | probe (6) |
| L1 | CarbonDioxide | 0/0 | 0 | full-stack (8) |
| L1 | Ethanol | 0/0 | 0 | full-stack (8) |
| L1 | Methanol | 0/0 | 0 | full-stack (8) |
| L1 | Acetone | 1/0 | 1 | full-stack (8) |
| L2 | Tracheid | 3/0 | 3 | web artefact (6) |
| L2 | Sclereid | 0/0 | 0 | node server (7) |
| L2 | Idioblast | 13/0 | 13 | full-stack (8) |
| L3 | Meristem | 0/0 | 0 | all (10) |

Trust threshold is three consecutive credited results, so Tracheid and
Idioblast are trusted and nothing else is.

## The ledger agrees with the store exactly

| Kind | Count |
|---|---|
| `type-success` | 33 |
| `skill-save` | 15 |
| `skill-success` | 12 |
| `counters-reset` | 12 |
| `type-failure` | 9 |
| `skill-failure` | 3 |

Store totals are 33 successes and 9 failures across all thirteen rows. The
ledger holds 33 `type-success` and 9 `type-failure`. No credit is lost anywhere.

**A hypothesis this refutes.** Idioblast carries thirteen successes while the
four molecules of its own tool signature carry one between them, and that was
read here as a broken L1 credit path — "the tier that does the work is not
being credited". The ledger says otherwise, and the real explanation is
routing: a full-stack cell may route a page-building leaf to a web molecule,
which the capability-match rule explicitly allows. Idioblast's thirteen
successes sit above Glucose's eleven and Sucrose's three. The full-stack
molecules were created speculatively and the router never needed them.

Do not re-derive the credit hypothesis from a cross-rank count. Compare the
ledger to the store first; they are in one file and one transaction precisely
so that comparison is cheap.

## What the reuse rule collapses, and what it does not

`atomBehaviorKey` is tier + system prompt (persona name normalised) + sorted
tools + params. Grouped by it, the nine molecules are **seven** groups:

- one group of three — Ethanol, Methanol, Acetone. Planning now sees a single
  identity here where it saw three. This is `createOrReuse` working.
- six groups of one, including Water, Glucose and Sucrose, which share a tool
  signature AND a byte-identical description but hold three different prompts.

Those three will never merge on their own. Their prompts diverged historically:
Water carries the canonical bootstrap prompt, the other two carry prompts
predating the correction or mutated by a validator patch.

## The open design question

**The prefilter reads descriptions; the reuse rule reads prompts. They
disagree, and nothing reconciles them.**

A description is `capabilityDescription(tools, tier)` whenever the planner's
suggestion looks task-themed, so every type with the same tool signature gets
the same description by construction — that honesty was deliberate and is
documented in `src/atoms/capability.ts`. The prefilter therefore sees three
indistinguishable catalogue lines for Water, Glucose and Sucrose and has no
signal to choose between them. Meanwhile the reuse rule inspects the full
prompt and refuses to treat them as one.

The consequence is that the correction reduced the rate of clone creation
without bounding the catalogue. A validator patch rewrites a system prompt
permanently, so the Ethanol/Methanol/Acetone group holds only until one member
is patched, after which it splits off for good and carries its own
description-identical catalogue line forever.

Left open on purpose. Designing the reconciliation belongs to a session that
did not surface it (the cooling-off rule in the root contract), and this record
exists so that session starts from measurements instead of intuition.

## What was deliberately not done

Four historical molecules duplicate two capabilities in the catalogue. Their
cost is prefilter tokens per run, not correctness, and merging them requires an
owner's arbitration: merging toward Water keeps the canonical prompt and
discards the one that earned eleven successes, merging toward Glucose does the
reverse. None of them is trusted either way. No `registry dedupe --apply` or
`mergeInto` was run: those write to the production registry, and the contract
requires archiving the store first.

Twelve `counters-reset` events against thirty-three successes is a third as
many trust wipes as credited results. Under the pre-correction rule each one
erased the totals, which plausibly explains why Water shows 1/2 today. Not
investigated further.
