<!-- Design proposal. The owner's answers to section 12 were taken 2026-08-28
     and are recorded there; the body below still reads as the proposal that
     was put to them, so the reasoning behind each choice stays legible. -->

# Per-tier host subscription — design proposal, 2026-08-28

This was a proposal for review: it names the choices, the alternatives it rejects, and the four
defects an adversarial pass found in earlier drafts. **The eight open questions were answered on
2026-08-28 and the answers are recorded in section 12** — six confirmed the proposal, one
reversed it. Nothing is implemented yet; the body below is left as it was put to the owner, so
the reasoning behind each choice remains readable next to the decision.

## 1. The ask, in the owner's terms

> "When I am logged in as a platform admin, I want to choose the default LLM per tier. In the
> model dropdown there would be, for example, 'Claude (host subscription) — Opus 5'."

So: the host's own Claude Code subscription becomes one more choice in the same per-tier picker
as the API-billed models, instead of an all-or-nothing transport switch.

## 2. What exists today, verified

Read before writing anything; three of these correct the framing of the ask.

- **The door is deployment-scoped and boot-frozen, not run-scoped, and it can only refuse.**
  `ProjectRunCoordinator`'s constructor snapshots `this.hostEnv = { ...(options.hostEnv ??
  process.env) }` once at server boot; `projectRunEnvironment` reads `input.hostEnv['ATOMA_LLM']`.
  Two consequences. On a host with `ATOMA_LLM=anthropic` there is **no** code path by which a
  platform admin reaches the subscription — the flag is only consulted *after* the host env
  already asked for it. On a host with `ATOMA_LLM=claude-cli` a non-admin's run is refused
  **entirely** (`ProjectRunConfigurationError`, queued→failed in `start()`), not downgraded.
  There is therefore no per-run switch to extend; the feature adds one.
- **The admin flag is instance-wide and org-agnostic.** `resolveSubscriptionGrant(principalId)`
  never reads `input.orgId`. An admin who is a member of a tenant organisation can already spend
  the host subscription on that org's project, journaled under that org.
- **A subscription run forwards no credential, including the org's own keys**
  (`const usableOrgKeys = subscriptionRequested ? {} : (input.orgProviderKeys ?? {})`, placed
  before tier resolution — finding 2.2, closed 2026-08-27). `OLLAMA_BASE_URL` does cross on that
  branch; "no credential" is exact, "nothing crosses" is not.
- **The engine already routes a tier to the subscription.** `PROVIDER_FACTORIES['claude-cli']`
  exists and `resolveCliModel` maps any model id onto `opus`/`sonnet`/`haiku`, reporting the
  alias back as `servedModel`. `cliEffortFor`/`cliThinkingFor` gate on the **resolved alias** —
  that gating is load-bearing and measured: under the CLI, an L3 prefilter capped at 256 tokens
  on the API path emitted 3,017 tokens over 35.6s, and five Haiku prefilters ate 87s, 35% of the
  whole run, until thinking was disabled on the haiku alias.
- **The catalogue is closed and says so.** `src/core/providerCatalog.ts`'s SCOPE docstring states
  that `claude-cli`/`codex` are "deliberately absent … exactly the credential-honouring transports
  `PROVIDER_FACTORIES` can build from an injected environment snapshot". `orgProviderIsReady`
  returns **true** for any entry whose `credentialEnvVar` is `null`.
- **The picker already makes a payer claim the runtime does not honour.**
  `OrgModelsForm.tsx` computes `canPickModels = billedKeyReady || platformAdmin` and passes
  `unlockAll: platformAdmin`, justified in its header comment by "their runs use the host CLI
  subscription". On any host with `ATOMA_LLM=anthropic` that is false: the admin's unlocked
  `anthropic:claude-opus-5` pick resolves against the **host's** `ANTHROPIC_API_KEY`.
- **`assertTransportHonoursCredentials` never fires on a project run.** It refuses `claude-cli:`
  tier pins (review 2026-08-18 §1.6) only when `startTask` was given a `providerEnv` snapshot;
  `runTask` calls `startTask(profile, argv)` and `spawnRun` replaces the child env wholesale.
  `projectRunEnvironment` is the sole gate.
- **`effectiveTierSelection` documents itself as the shared precedence function and has zero
  callers**, while `projectRunEnvironment` re-implements the chain inline with a third level
  (host env) the contract function does not model — and names it in its own docstring as though
  it called it.
- **`run.host_subscription` carries no `detail` at all**, only an English `summary`, written at
  two sites with different wording and different `actorType` (`src/viz/server.ts` → `principal`,
  `src/cli/projects.ts` → `cli`). `project_runs` has no payer column.

## 3. The shape of the answer

Two regimes, kept disjoint, plus one new stored value and one new record.

**Regime A — `ATOMA_LLM=claude-cli`** (today's single-machine deployment). Unchanged in every
observable: admin required, non-admins refused entirely, org keys blanked before tier resolution,
`ATOMA_LLM` canonicalised, isolation untouched. One payer for the whole run. What the feature
adds here is *honesty in the picker*: an admin may now pin a tier to `host-subscription:sonnet`
and see it labelled as the subscription, instead of pinning a dated Anthropic id that silently
collapses onto an alias.

**Regime B — `ATOMA_LLM=anthropic` plus `ATOMA_HOST_SUBSCRIPTION_ORG=<orgId>`.** The base
transport stays credentialled and its credential requirement stands. An admin may pin individual
tiers to the subscription. One run can be L1 on the org's Z.ai key, L2/L3 on the host
subscription, base on the host or org Anthropic key — and the journal names all four.

**The stored value is an intent, not a transport.** The picker writes
`host-subscription:opus|sonnet|haiku` into `auth_principal_model_pins` — the requesting
principal's own row, never the org table. `host-subscription` is in no `PROVIDER_FACTORIES` key
and no `KNOWN_PROVIDER_PREFIXES` entry, so a stored pin that leaks anywhere by any future path
resolves as an unknown model and fails; it cannot become a payer swap. Only
`projectRunEnvironment`, after the fail-closed authority answer, translates it — to
`claude-cli:<alias>` on regime B, to the bare `<alias>` on regime A (where the base client
already *is* the CLI, so a second CLI client would be waste).

**The run produces a payer ledger, not a boolean.** `projectRunEnvironment` returns
`{ environment, payers }`, computed in the same pass that builds the env, with **four** rows:
`base`, `l1`, `l2`, `l3`. That is what `run.host_subscription` journals.

One mixed run, end to end:

1. `start()` asks `resolveSubscriptionGrant(principalId)` — fail-closed, unchanged.
2. `projectRunEnvironment` walks `resolveTierChain` per tier: account pin → org default → host
   env, and now reports **which level won**.
3. A `host-subscription:` candidate is admissible only at the **account** level, only with the
   grant, and only when the declared org id equals this run's `orgId`. Otherwise it **throws**,
   naming the tier and the reason.
4. It never reaches `providerCredentialAvailable`, whose contract is a silent `continue`.
5. The ledger records `base: host-key/anthropic`, `l1: org-key/zai`, `l2: host-subscription`,
   `l3: host-subscription`, each with its chain source.
6. `onSubscriptionTransport` fires because the ledger contains a `host-subscription` row — not
   because the host env string matched — and both emitters render summary and detail through one
   shared builder.

## 4. Decisions

### D1 — The stored token is a non-routable sentinel, not `claude-cli:opus`

**Choice.** `host-subscription:<alias>`, translated to a transport only inside the coordinator,
downstream of the authority check.
**Alternative.** Store `claude-cli:opus` directly; `PROVIDER_FACTORIES` already understands it.
**Why the alternative loses.** `claude-cli:` is the exact string two independent guards exist to
refuse — `isCatalogueSelection` in the coordinator and the tier-pin half of
`assertTransportHonoursCredentials` (added by review 2026-08-18 §1.6 precisely because
`{ATOMA_LLM: 'anthropic', ATOMA_MODEL_L2: 'claude-cli:sonnet'}` used to construct a CLI client
that ignored the snapshot). Storing it in a tenant-readable table would make every future code
path that forwards a pin into an environment a potential subscription route, and would require
deleting the deliberately pinned assertion `isValidTierModelSelection('claude-cli:whatever') ===
false` in `tests/org-provider-catalog.test.ts`. The sentinel adds a concept beside a stated
rejection instead of tearing the rejection out.

### D2 — Account pins only; the org table refuses it on write **and** on read

**Choice.** `auth_principal_model_pins`, through `/api/account/models` PUT. `setOrgTierModels`
refuses the sentinel (400), and `orgTierModels` keeps degrading it to `null` on read.
**Alternative.** An org default, or a new browser-writable host/operator defaults table.
**Why the alternative loses.** `auth_principal_model_pins` is the only table whose primary key
*is* the key the authority is asked about: `resolveTierModels(principalId)` and
`resolveSubscriptionGrant(principalId)` read the same id, so cross-principal inheritance of a
payer-bearing value is structurally impossible rather than defended. An org default is inherited
by every member by construction, so every tenant run would need a fail-closed re-ask that fires
constantly — and a gate that fires constantly is a gate that gets ignored. A third table needs
persistence that outranks a boot-frozen env snapshot, has no owner to attribute the choice to,
and becomes a second definition of "host default" beside `ATOMA_MODEL_L*`, which is the
one-concept-two-definitions drift the root AGENTS.md names.

### D3 — The sentinel is admissible **by chain level**, not merely by value

**Choice.** `resolveTierChain` passes the level (`account` | `org` | `host`) to its `accept`
callback; only `account` may carry the sentinel. `ATOMA_MODEL_L2=host-subscription:opus` on the
host env is refused by the unchanged `isCatalogueSelection`, exactly as any unknown prefix is
today.
**Alternative.** Accept the sentinel wherever it appears in the chain.
**Why the alternative loses.** The host env is the third candidate for every tier. Accepting the
sentinel there would create the host-level default D2 explicitly rejects, by accident — and,
under the refusal rule of D5, one plausible operator env var (the spelling the new picker teaches
them) would fail **every** non-admin run on that deployment.

### D4 — The subscription is not a fourth `LLM_PROVIDER_CATALOG` entry

**Choice.** A separately typed `HOST_SUBSCRIPTION_FAMILY` constant beside the catalogue, unioned
into storage at exactly one place (a new account-level validator).
**Alternative.** A fourth entry with `credentialEnvVar: null`.
**Why the alternative loses.** Three concrete breakages, all verified in the files.
`orgProviderIsReady` returns `true` for any null-credential entry, so a fourth row would read as
**always ready** to every viewer inside `catalogOptions` — the exact inverse of the per-requester
requirement. `resolveOrgProviderKeys` iterates the catalogue and passes `provider.id` into a
`ProviderKeyProvider` parameter, so a fourth id is a compile error whose only fix widens a type
mirrored by the `CHECK (provider IN ('anthropic','zai','ollama'))` constraint on
`auth_org_provider_keys` — letting the org key table hold a row for a provider that must never
have a key. And `injectOrgProviderKeys` iterates the same array. Keeping it out is a positive
property, and it leaves the catalogue's SCOPE docstring true as written.

### D5 — A subscription pin whose authority is gone **refuses the run**; it never falls through

**Choice.** `ProjectRunConfigurationError` naming the tier and the reason, thrown inside the
candidate loop, before `providerCredentialAvailable` is consulted. Three distinct messages: no
grant, no declaration, wrong organisation.
**Alternative.** Fall through to the next chain level — which is what
`providerCredentialAvailable`'s `continue` gives for free.
**Why the alternative loses.** The loop already carries two mechanisms with two meanings:
`isCatalogueSelection` **throws** (a provider you may not use), `providerCredentialAvailable`
**continues** (a credential nobody brought). A revoked authority is the first kind. Falling
through changes the payer from a subscription to a billed credential with no event anywhere —
the defect class finding 2.2 closed on 2026-08-27. The generalisable rule this adds, and which
belongs in `src/projects/AGENTS.md` whatever else is decided: **fall-through is permitted within
a payer; refusal is required across payers.** Doing nothing selects the least honest option.

### D6 — The deployment declaration names the organisation; it is not a boolean

**Choice.** `ATOMA_HOST_SUBSCRIPTION_ORG=<orgId>`. One variable carrying two facts: this
deployment permits subscription tiers, and here is the single organisation whose runs may use
them. Absent → the feature does not exist on this host. Set → a subscription tier in any other
org refuses at launch, naming the org.
**Alternative.** A boolean `ATOMA_HOST_SUBSCRIPTION=1`, with an optional org restriction.
**Why the alternative loses.** `docs/saas-architecture.md` permits `claude-cli` only on the
operator plane — "atoma monitoring and maintaining its OWN deployment" — and requires that "the
refusal must be mechanical, not documentary. A tenant-plane run that resolves to `claude-cli` has
to fail at LAUNCH". An optional restriction that defaults to off is documentary. Today the plane
boundary holds *structurally*: the subscription is reachable only when the whole deployment sets
`ATOMA_LLM=claude-cli`, and such a deployment refuses every non-admin run, so it serves no
tenants. Regime B dissolves that property, so the boundary has to be re-established explicitly or
the feature quietly widens the vendor-clause reading. Making the org part of the same variable
means it cannot be set half-way. The precedent for "only the operator can assert this" is
`OLLAMA_BASE_URL`, whose comment already reasons exactly this way. Ergonomics: `npm run auth --
list` prints org ids, and `npm run doctor` names the declared org.

### D7 — Mixed runs are permitted; the base transport keeps its credential requirement

**Choice.** Regime B allows tier-by-tier payers. The `!apiKey && !orgAnthropicKey` refusal stays
exactly where it is, before the env is built.
**Alternative (rejected, and it was in an earlier draft).** Move that refusal after tier
resolution and require it only when the base is "reachable", so a keyless host could pin all
three tiers to the subscription with no API key anywhere.
**Why the alternative loses.** `src/run/auth.ts` documents, in measured detail, that
`new Anthropic({apiKey: null, authToken: null})` never throws and that the SDK then falls through
to profile / workload-identity resolution, which reads the real `process.env` and the config
directory — "a per-run snapshot cannot redirect that half" (also recorded as the remaining half
of A6 in `docs/saas-architecture.md`). So a keyless base does not fail loudly on the first base
call; it silently succeeds against the operator's `ant auth login` profile — a credential that
bills the same Anthropic org as an API key, is **not** the Claude subscription, and appears in no
ledger row and no journal. Deleting the one launch-time credential refusal to buy convenience on
a keyless host trades a loud failure for a silent payer. The keyless machine keeps regime A,
where per-tier alias choice still works and there is exactly one payer.

### D8 — Four ledger rows, including `base`

**Choice.** `RunPayerLedger` has `base`, `l1`, `l2`, `l3`, each `{ selection, provider, payer,
source }`, `payer ∈ host-subscription | org-key | host-key | host-selfhosted`.
**Alternative.** Three tier rows, as every earlier draft had.
**Why the alternative loses.** On regime B the base transport is the payer of last resort: every
call that does not carry a `provider:` prefix — an unpinned tier, `resolveLatestOpus` on the L3
path, anything reaching the default client — bills it. A three-row ledger that says "L2 and L3
were on the subscription" is silent about the account that paid for everything else, which is the
same omission finding 2.2 punished. The base row costs nothing to compute (the branch that writes
the credential already knows which one it wrote) and it is what makes "an admin pinned all three
tiers on a credentialled host" legible rather than invisible.

### D9 — The CLI transport is hardened to authenticate from its login session and nothing else

**Choice.** `ClaudeCliLlmClient` builds the Agent SDK subprocess env by **removing every
`ANTHROPIC_*` variable** plus `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`, instead of
today's `{ ...process.env, ANTHROPIC_API_KEY: undefined }`. In addition, `projectRunEnvironment`
never writes `ANTHROPIC_BASE_URL` into a child whose ledger contains a `host-subscription` row,
and **refuses the run** when the host declares a gateway and the base is still reachable.
**Alternative.** Rely on the existing single-variable strip.
**Why the alternative loses.** This is the fatal flaw all three reviews found, and it is real.
On the credentialled branch with a host key and no org key, `projectRunEnvironment` writes
`environment['ANTHROPIC_BASE_URL'] = baseUrl`. The CLI transport strips exactly one variable, so
a mixed run would spawn Claude Code with the host's third-party gateway base URL **and** the
machine's `claude /login` OAuth session — the operator's Claude credential presented to a
gateway, while the journal says `run.host_subscription`. The combination is unreachable today
only because the two branches are mutually exclusive; regime B makes them coexist for the first
time. The coordinator's own comment on the BYO path already does this reasoning for the key
("A BYO KEY GOES TO ITS OWN ISSUER"); the transport must do it for the session. A prefix rule
rather than an enumeration, because the enumeration is the thing that goes stale. Dropping the
gateway silently is not enough on its own — a host key issued **for** the gateway would then be
sent to `api.anthropic.com` and fail mid-run — hence the launch-time refusal of that specific
combination.

### D10 — No second in-child gate; the coordinator is the sole gate, and it is written down

**Choice.** No `ATOMA_SUBSCRIPTION_TIERS` variable, no arming of
`assertTransportHonoursCredentials` for project runs, and no relaxation of it either. It keeps
its text verbatim. `src/run/AGENTS.md` records the exception explicitly: project runs supply no
`providerEnv` snapshot, so the coordinator-built environment is the equivalent boundary and the
only gate; anyone who later arms the snapshot for project runs must reconcile the two rules
first, because a legitimate mixed env contains both a credential and a `claude-cli:` pin.
**Alternative A (rejected).** A new env var whose presence declares which tiers may hold
`claude-cli:` pins, checked in `startTask`.
**Alternative B (rejected).** Narrow `assertTransportHonoursCredentials` so a `claude-cli:` pin
passes when some other tier can use the supplied credential.
**Why they lose.** Alternative A is theatre: the coordinator writes both the declaration and the
pins, in the same function, from the same resolution — the check can only catch corruption
between two adjacent `Object.assign`s. What it *does* buy is real and bad: a new permissive
token at a process boundary whose current rule is a flat refusal. Alternative B weakens a safety
assertion on a path this feature never uses, and it re-opens precisely the configuration review
2026-08-18 §1.6 closed: `{ANTHROPIC_API_KEY, ATOMA_MODEL_L3: 'claude-cli:opus'}` would pass, so a
future in-process multi-tenant runner (the thing T10's snapshot exists for) would silently bill
the machine subscription. The honest move is to leave the rule alone and record why it does not
fire here. D9's transport hardening is the real second layer, because it defends the credential
regardless of who built the env.

### D11 — Aliases, not dated ids

**Choice.** The family offers exactly `opus`, `sonnet`, `haiku`, labelled as "whatever this
machine's Claude Code resolves".
**Alternative.** Dated ids matching the owner's example copy, "Claude (host subscription) — Opus 5".
**Why the alternative loses.** `resolveCliModel` maps any id onto the same three aliases and
reports the alias back as `servedModel`; `cliEffortFor`/`cliThinkingFor` gate on the resolved
alias. `host-subscription:claude-opus-5` and `host-subscription:opus` are the same call, one of
which stores, displays and journals a version claim the transport cannot keep. This is the one
place the design deliberately contradicts the owner's words, and the deviation most worth their
veto: if the dropdown must read "Opus 5", the honest form is a label over an alias value.

### D12 — `effectiveTierSelection` is replaced, not deleted and not left

**Choice.** Delete it; export `resolveTierChain(tier, {account, org, host, accept})` from
`src/contracts/tierModels.ts`, returning `{selection, source}`, and have `projectRunEnvironment`
actually call it in place of its three parallel `candidatesL*` arrays.
**Alternative A.** Delete it outright — free, zero callers.
**Alternative B.** Leave it and add the new value class to the inline arrays.
**Why they lose.** B entrenches a documented rule the code does not follow, in the file this
feature must edit — the drift the root AGENTS.md warns about. A is free but throws away the thing
the ledger needs: "which level chose this" is precedence logic, and D3's level-scoped
admissibility plus the ledger's `source` field both require it. The replacement is pure and has
no notion of credentials, grants or environments; those enter only through `accept`.

### D13 — Per-requester catalogue shaping, server-side

**Choice.** `/api/account/models` appends the subscription family only when
`viewer.platformAdmin` **and** the host declares the org **and** the viewer's active org is the
declared one — or when the viewer's own stored pins already name it (so it stays clearable).
`/api/org/models` never carries it. The unlock in `catalogOptions` stops keying on the role:
`unlockAll: platformAdmin` becomes unlock-follows-the-payer, computed from declared facts
(`hostCredentialProviders`, `orgProviderIsReady`, the subscription offer).
**Alternative.** Ship the full catalogue plus a capability flag and let the client decide.
**Why the alternative loses.** The route already holds `viewer.platformAdmin` and already ships a
per-deployment availability flag (`ollamaAvailable`), so shaping the payload is the established
pattern in the same handler. Shaping it server-side means a non-admin's browser never receives a
value it could POST back, so the store-side refusal is a second line rather than the only one.
And the current `unlockAll: platformAdmin` is a shipped lie: on a host with `ATOMA_LLM=anthropic`
it lets an admin pick billed Anthropic models that bill the **host's** API key with no org key
and no audit row, under a comment claiming the subscription pays. Narrowing it to declared facts
keeps the single-operator convenience honestly (the host key *is* theirs) and removes the false
claim.

## 5. The four fatal flaws the review raised

1. **The gateway leak into the subscription subprocess.** Fixed, two layers — D9. The transport
   strips the whole `ANTHROPIC_*` family plus the Bedrock/Vertex switches; the coordinator does
   not write `ANTHROPIC_BASE_URL` into a run with a subscription row, and refuses the combination
   where dropping it would misroute the base credential instead.
2. **The keyless base and the SDK's profile fallback.** Fixed by *not* making the change that
   caused it — D7. The anthropic credential precondition stays exactly where it is. The cost is
   that a keyless host gets per-tier alias choice only in regime A, and that is stated as such.
3. **The vendor-clause gate defaulting to off.** Fixed — D6. The declaration is a required org
   id, the refusal is mechanical at launch, and there is no "any org" spelling. What it does
   **not** do: invent an operator-organisation concept in `auth_organisations`. It reuses an
   existing org id as the operator plane's name, which is a smaller commitment and reversible.
4. **The second in-child gate being theatre.** Accepted and removed — D10. The coordinator is the
   sole gate; the rule is recorded rather than pretended around, and the assertion it appears to
   contradict is left verbatim rather than narrowed.

Two more, from the same reviews:

5. **The revoked admin's unrecoverable Settings.** Fixed. Today the account select's inherit
   option is `disabled={!canPickModels || !org.models[tier]}`, so an admin with a pin and no org
   default cannot clear it at all — and the guard meant to protect that case,
   `if (value === '' && !org.models[tier]) return;`, is **dead code**: the line above already
   maps `''` to `null`, so `value` is never `''`. The commit enables the inherit option whenever
   the stored pin is a subscription selection, keeps the family visible-but-locked for a viewer
   who holds such a pin, and removes the dead guard.
6. **The host env silently becoming a subscription default.** Fixed — D3, level-scoped
   admissibility.

## 6. Audit and accounting for a mixed run

The run: L1 `zai:glm-4.5-air` from the org default, L2 and L3
`host-subscription:opus` from the admin's account pins, base on the host's Anthropic key.

**What the journal says.** One `run.host_subscription` row, kind and severity (`security`) and
push audience (`null`) unchanged, now carrying a `detail` built by one shared function used by
both emitters:

```
base: { payer: 'host-key',         provider: 'anthropic', source: 'base' }
l1:   { payer: 'org-key',          provider: 'zai',       source: 'org',     selection: 'zai:glm-4.5-air' }
l2:   { payer: 'host-subscription', alias: 'opus',        source: 'account' }
l3:   { payer: 'host-subscription', alias: 'opus',        source: 'account' }
```

The trigger changes from "the host env says `claude-cli`" to "the ledger contains a
`host-subscription` row", which reads the resolved state instead of the request. The two emitters
keep their deliberate `actorType` difference (`principal` vs `cli`) and stop differing in what the
row *claims*. `detail` carries tier names, provider ids and payer kinds only — no credential, no
env value, no model-authored prose — and four such rows serialise far under the 2000-char cap.

**What the journal does not say, deliberately.** The ledger names **pins**, not calls. `L2Atom`
and `L3Atom` set `validationModel = args.validationModel ?? modelForTier(1)`, so an L1 pinned to
the subscription also puts L2's and L3's validation calls on it. The row is true about routing
identity and understates spend. The per-call truth stays recoverable from the trace: observability
wraps the **router** (`new MetricsLlmClient(new RecordingLlmClient(routedClient, recorder), …)`),
so `req.model` keeps the `claude-cli:` prefix per call. `ATOMA_CLAUDE_MODEL` — a process-wide
debug override that collapses every tier onto one model, and whose own comment forbids this use —
can also make the ledger describe an intent the run did not execute.

**What the money says.** Today `pricesFor` matches `/opus/i`, `/sonnet/i`, `/haiku/i`, and
`ClaudeCliLlmClient` reports the bare alias as `servedModel`, so a subscription call is priced at
API list rates by an established convention (stated in the codex price rows: leaving them
unmatched would make every call read as free and flatter any tiering comparison). A mixed run's
single `costUsd` therefore blends real org spend with notional host spend. The proposal fixes
this minimally, in the same commit, because the audit lie and the cost lie are one incident and
COOLING-OFF says design the contract once against all of them:

- `LlmCallMetrics` gains `requestedModel` (always `req.model`), set on the success and the
  `partialUsage` error path. `model` stays `servedModel ?? req.model` — accounting still follows
  the served model, per `src/core/AGENTS.md`; the routing identity is retained rather than
  discarded at the one place both are in hand.
- `runStatsSchema` gains `subscriptionCostUsd`, **nullable with `.default(null)`** for the same
  reason `uncoveredObligations` is: `parseRunStatsEpilogue` reads logs written by earlier builds.
  `null` means "this build did not report it", which is not `0`.
- The payer of a call is decided by one exported rule: read the prefix via
  `splitProviderModel(value, KNOWN_PROVIDER_PREFIXES)`, and **fall back to the base transport kind
  when there is none**. A bare prefix test alone reports 0% subscription on regime A, where the
  pins are bare aliases and the base client *is* the CLI — the run where the answer is 100%.

The field's doc comment must say what it is: what those tokens *would* have cost at API list
prices, not a bill. Subtracting it from `costUsd` does not yield "what the tenant owes" whenever
a host key is also in play. This is the part of the commit most defensible to defer; deferring it
means the journal row and the cost figure disagree from day one (owner decision below).

## 7. Change list, by subsystem

### `src/contracts/`

- **`runPayers.ts` (new).** `payerKindSchema`, `tierPayerSchema`, `runPayerLedgerSchema` (four
  rows), `HOST_SUBSCRIPTION_PREFIX`, `HOST_SUBSCRIPTION_ALIASES`, `isHostSubscriptionSelection`,
  `hostSubscriptionAlias`, `payerForSelection(selection, ctx)`, `runPayerDetail(ledger)` and
  `hostSubscriptionSummary(ledger)` — the one summary string both emitters render. A
  schema-parsed `EXAMPLE_RUN_PAYER_LEDGER` at module load.
  *Invariant:* `payerForSelection` is the only reader of a selection's payer, it delegates the
  prefix split to `splitProviderModel` rather than restating it (review 2026-08-14 §3.9's rule),
  and `runPayerDetail` never emits a credential, an env value or tenant text.
- **`tierModels.ts`.** Delete `effectiveTierSelection`; add `resolveTierChain` with a
  level-aware `accept`. Add `accountTierModelPinsSchema` (catalogue **or** sentinel) beside the
  unchanged `tierModelPinsSchema` (catalogue only), both instantiated from one private factory so
  the `{l1,l2,l3}` shape is stated once.
  *Invariant:* one shape, two admissible value spaces, both defined here; `null` keeps meaning
  "inherit" and never means "subscription"; `TIER_MODEL_PINS_EXAMPLE` still parses at module load.
- **`platformEvents.ts`.** Add kind `principal.subscription_pin` (severity `security`); extend the
  `run.host_subscription` doc comment — it now names tiers, not a whole run.
  *Invariant:* `PLATFORM_EVENT_SEVERITY` and `PUSH_ROUTES` stay exhaustive, so the kind does not
  compile until severity and audience are stated; the generic `detailSchema` gains no per-kind
  branch (a fourth exhaustive record would pull every domain's payload into the envelope
  contract, whose job is bounding and secrecy).

### `src/core/`

- **`providerCatalog.ts`.** `LLM_PROVIDER_CATALOG` unchanged. Add `HOST_SUBSCRIPTION_FAMILY` as a
  separately typed neighbour and `isAccountTierSelection` as the single union point; extend
  `tierModelSelectionLabel` to label the family; add a SCOPE paragraph saying why the family is a
  neighbour and not a member.
  *Invariant:* `orgProviderIsReady`, `orgHasBilledProviderKey`, `injectOrgProviderKeys` and
  `resolveOrgProviderKeys` keep iterating an array of credential-honouring providers only; the
  `credentialEnvVar === null ⇒ always ready` shortcut stays unreachable for the subscription.
- **`llmClaudeCli.ts`.** Build the SDK subprocess env by removing every `ANTHROPIC_*` variable
  plus `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`.
  *Invariant:* the subscription transport authenticates from its login profile and nothing else;
  no environment variable may re-credential or redirect it. This is now load-bearing for the
  payer guarantee, not tidiness, and must be pinned by a test on the constructed env.
- **`metrics.ts`.** `LlmCallMetrics.requestedModel`; a `subscriptionCostUsd(events, baseKind)`
  helper.
  *Invariant:* `pricesFor`, `summary()`, `formatSummary()` and the CSV keep reading `model`; a
  failed call keeps its partial tokens **and** its payer.

### `src/projects/`

- **`coordinator.ts`.** `projectRunEnvironment` returns `{ environment, payers }`. The three
  inline candidate arrays become one `resolveTierChain` call whose `accept` throws for a
  non-catalogue prefix (unchanged), throws for a sentinel outside the account level or without
  grant / declaration / org match, and continues on `providerCredentialAvailable` false
  (unchanged). Sentinels translate after the walk. `usableOrgKeys` stays byte-for-byte.
  `referencedProviders` derives from the ledger. `ANTHROPIC_BASE_URL` is withheld from a run with
  a subscription row, and the gateway-plus-reachable-base combination refuses.
  `SubscriptionTransportUse` gains `payers`; `start()` fires the observer from the ledger.
  *Invariant:* this stays the sole gate; authority is asked per run, never handed in; the
  fail-closed `resolveSubscriptionGrant` / fail-open `tierModelsFor` split is unchanged; the key
  map used during resolution is the same one used at injection; `ATOMA_CONTAINER` and
  `ATOMA_REQUIRE_ISOLATION` are untouched on every branch.
- **`AGENTS.md`.** The door section gains: the two regimes, the sentinel's non-routability, the
  level-scoped admissibility, the cross-payer refusal rule, the declared operator org, the base
  row, and why the whole-run withholding is regime A's rule. The existing finding-2.2 paragraph
  is kept verbatim and scoped explicitly.

### `src/auth/`

- **`store.ts`.** `setModelPins` validates with `accountTierModelPinsSchema`; `modelPins` reads
  through `allowedPrincipalSelection` (catalogue **or** sentinel). `setOrgTierModels` /
  `orgTierModels` keep the narrower `allowedStoredSelection`.
  *Invariant:* the store verifies **shape**, the route verifies **authority** — unchanged. The
  read-side degrade must not be the retirement lever for the sentinel: availability is decided at
  launch, so a withdrawn declaration is a loud refusal, never a quiet downgrade.

### `src/viz/`

- **`server.ts`.** Per-requester shaping of `/api/account/models` (D13) plus a
  `hostSubscription` block; account PUT refuses the sentinel for a non-admin and emits
  `principal.subscription_pin` when the subscription arms change; `/api/org/models` PUT refuses
  the sentinel with 400. Remove the dead `choices: TIER_MODEL_CHOICES` from both payloads —
  nothing in the client reads it. `onSubscriptionTransport` renders through the shared builder.
  *Invariant:* authority is read from the resolved session, never the body; an admin's writes stay
  bound to their active organisation, as everywhere behind the gate.
- **`push/routes.ts`.** `'principal.subscription_pin': null`.
- **`client/types.ts`.** `VizAccountModels.hostSubscription?`, absent meaning **not offered** —
  the inverse of `ollamaAvailable`'s tolerant default, because the failure here is a payer, not a
  dormant endpoint. Drop `choices`.
- **`client-gl/OrgModelsForm.tsx`.** `catalogOptions` takes declared facts instead of
  `unlockAll`; the family renders as one extra `<optgroup>` in the **account** picker only; the
  inherit option is enabled when the stored pin is a subscription selection; the dead
  `value === ''` guard is removed; the header comment's false payer claim is corrected.
  *Invariant:* lock-but-show survives (`disabled={!unlocked && value !== selected}`), so a pin
  never vanishes from the select that must be used to clear it. All decision logic lives in a
  pure helper, so nothing here needs a browser to prove.
- **`client/locales/en.json`.** EN only. `settings.hostSubscription`,
  `settings.hostSubscriptionUnavailable`, `settings.hostSubscriptionHint` (says plainly: these
  tiers spend the operator's own subscription, are billed to nobody's key, and are journaled),
  and a rewrite of `settings.orgKeysHintPlatform`, which currently promises admins the CLI
  subscription unconditionally.

### `src/run/`, `src/cli/`

- **`run/runner.ts`.** `machineRunStats` fills `subscriptionCostUsd`; the `llm provider:` startup
  line gains the mixed case.
  *Invariant:* all four epilogue sites go through `machineRunStats`, so a cancelled or failed run
  reports its subscription spend too.
- **`run/providers.ts`.** No code change. **`run/AGENTS.md`** records the project-run exception
  (D10).
- **`cli/projects.ts`.** Same shared summary and detail, keeping `actorType: 'cli'`.
- **`cli/doctor.ts`.** When the deployment declares the org, probe `claude auth status --json`
  (already present) and name the declared org.
  *Invariant:* doctor stays quota-free; `ProviderName` already contains `claude-cli`, so no union
  widens.

## 8. Migration

**No schema migration, no data migration.** `host-subscription:opus` is 22 bytes in the existing
`auth_principal_model_pins` TEXT columns. No existing row can hold the sentinel — the write
validator refused it and the read-side degrade would have nulled it — so every stored pin keeps
its exact meaning and no run changes payer on deploy.

**Regime A deployments are unchanged in every observable.** Org keys still blanked before tier
resolution; a non-admin's run still fails queued→failed with the same message; `ATOMA_LLM` still
canonicalised; isolation untouched; `run.host_subscription` still fires once — now because the
ledger says every row is subscription-paid rather than because the host env string matched. The
row gains a `detail` it did not have.

**Regime B deployments see nothing until the operator sets `ATOMA_HOST_SUBSCRIPTION_ORG`.** The
feature ships dark, which is the right default for a change that moves money. The coordinator's
`hostEnv` is boot-frozen, so the declaration takes effect on the next server start, exactly like
`ATOMA_MODEL_L*` today; until then a stored pin refuses rather than routes.

**Existing `run.host_subscription` rows** keep their old summary and carry no `detail`; readers
already tolerate that (`src/platform/events.ts` degrades an unparseable detail to absent). No
backfill, no read-side branch.

**Archived `ATOMA_RUN_STATS` epilogues** parse unchanged thanks to `.default(null)`; the burn-in
CSV gains a column empty for every historical row.

**The one migration hazard is the reverse direction.** Rolling back to a binary that does not know
the sentinel makes `allowedStoredSelection` degrade every subscription pin to `null` (inherit) and
move the payer onto whatever credential the chain finds — silently. The direction is the safe one
(spend moves onto a declared credential, never off one) but it is still silent, which is why a
test pins the degrade so a future retirement is a deliberate act rather than a discovery. Turning
the declaration **off** on a current binary is the loud direction by design: stored pins refuse,
naming the tier, until cleared.

## 9. Tests, and the boundary each crosses

1. **`tests/project-coordinator.test.ts` — the mixed run crosses the process boundary.** Assert on
   `driver.mock.calls[0][0].env`, the env the child actually receives (the pattern the existing
   door suite uses): `ATOMA_MODEL_L1 === 'zai:glm-4.5-air'`, `ZAI_API_KEY` present,
   `ATOMA_MODEL_L2 === 'claude-cli:opus'`, `ATOMA_LLM === 'anthropic'`, `ANTHROPIC_API_KEY`
   present for the base.
2. **The gateway refusal (D9), same boundary.** With `ANTHROPIC_BASE_URL` on the host and a
   subscription pin: the run refuses, the driver is never called. With the gateway and **no**
   reachable base: the child env carries no `ANTHROPIC_BASE_URL`.
3. **The transport strip crosses into the SDK options.** A unit test on `ClaudeCliLlmClient`'s
   constructed subprocess env: no `ANTHROPIC_*` key survives, and neither Bedrock/Vertex switch
   does. This is the invariant that no longer has a comment to rely on.
4. **Authority refusal, three reasons, at the launch boundary.** `platformAdmins: () => false`;
   grant but no declaration; grant and declaration but a different `orgId`. Each refuses naming
   the tier, the driver is never called, the run row goes queued→failed, and the tier is **absent**
   from any env — proving no fall-through happened.
5. **The two opposite failure modes, side by side.** `platformAdmins` throwing still refuses
   (fail-closed); `tierModelsFor` throwing still launches (fail-open). The existing door tests pin
   these; a per-tier value must not erode them.
6. **Level-scoped admissibility (D3).** `ATOMA_MODEL_L2=host-subscription:opus` on the host env
   refuses for an admin exactly as for anyone else — the host level is not a subscription default.
7. **Finding 2.2's regression, unchanged and green.** Regime A with org anthropic and zai keys and
   `anthropic:`/`zai:` pins: no key crosses, both pins dropped.
8. **The ledger, at the coordinator→emitter boundary.** `onSubscriptionTransport` fires once, its
   four rows carry the right payer and `source`, and `runPayerDetail` serialises under 2000 chars.
   Regime A yields four `host-subscription` rows.
9. **`tests/org-provider-catalog.test.ts` — the write validator boundary.** The pinned lines
   (`isValidTierModelSelection('claude-cli:whatever')`, `'codex:gpt-5'`) stay false;
   `isAccountTierSelection('host-subscription:opus')` is true and
   `'host-subscription:claude-opus-5'` is false (aliases only); the family id is absent from
   `llmProviderIds()`.
10. **The store boundary, both directions.** `setModelPins` accepts the sentinel and `modelPins`
    reads it back **unchanged**; `setOrgTierModels` refuses it; a sentinel written into
    `auth_org_tier_models` by direct SQL reads back as `null`; a sentinel in a principal row read
    by the *old* validator degrades to `null` (the rollback hazard, pinned deliberately).
11. **`resolveTierChain`, pure.** Account beats org beats host; a rejected candidate falls to the
    next level with the right `source`; a throwing `accept` propagates; a fully null chain reports
    `default`. The precedence rule finally has one implementation and one test.
12. **Metrics.** A mixed call sequence on base kind `anthropic` and again on `claude-cli`:
    `subscriptionCostUsd` is the CLI share in the first and the whole total in the second (the
    bare-alias trap). One failing call with `partialUsage` keeps both its tokens and its payer.
13. **`RunStats` across the build-generation boundary.** An archived epilogue string with no
    `subscriptionCostUsd` parses, yields `null`, and re-emits.
14. **`assertTransportHonoursCredentials`, unchanged.** Its existing behaviour re-asserted
    verbatim, so the AGENTS.md exception is visibly an exception and not a quiet relaxation.
15. **The HTTP authority boundary.** `/api/account/models` GET: no family for a non-admin, none
    for an admin on a non-declaring host, present for an admin in the declared org; present for
    any viewer holding such a pin. PUT of a sentinel: 403 for a non-admin, one
    `principal.subscription_pin` for an admin. `/api/org/models` PUT of a sentinel: 400.
16. **The picker without a browser** (`viz:smoke` is not in `release:check` since 2026-08-24, and
    CI's rasteriser measured 2023–3433ms per frame against ~17ms on a developer machine). Pure
    tests on the offer helper and `catalogOptions`: no optgroup when not offered; three options
    when offered; an already-selected sentinel renders enabled after the offer flips off; the
    inherit option is enabled for a viewer holding a sentinel with no org default.

## 10. Considered and rejected

- **A fourth `LLM_PROVIDER_CATALOG` entry with `credentialEnvVar: null`** — reads as always-ready
  to every viewer via `orgProviderIsReady`, and widens a provider-id set written in four places
  (`LlmProviderEntry['id']`, `ProviderKeyProvider`, the `auth_org_provider_keys` CHECK, doctor's
  `ProviderName`), letting the org key table accept a row for a provider that must never have one.
- **Storing the routable `claude-cli:opus`** — puts the string two guards exist to refuse into a
  tenant-readable table and requires deleting a deliberately pinned test line.
- **An org-level or host-level subscription default** — inheritable by principals who can never
  pass the authority check, so the gate would fire on nearly every tenant run; and a host table
  would be a second definition of "host default" beside a boot-frozen env snapshot.
- **Silent fall-through when the authority is gone** — the free behaviour of
  `providerCredentialAvailable`'s `continue`, and a change of payer with no event.
- **A boolean deployment switch with an optional org restriction** — documentary where
  `docs/saas-architecture.md` demands mechanical.
- **Moving the anthropic-credential precondition to buy a keyless per-tier host** — the SDK's
  profile/WIF fallback turns the intended loud failure into a silent, unaudited spend on the
  operator's `ant auth login` profile.
- **A new `ATOMA_SUBSCRIPTION_TIERS` env var checked in `startTask`** — theatre against a bug it
  cannot see, bought with a permissive token at a boundary whose current rule is a flat refusal.
- **Narrowing `assertTransportHonoursCredentials`** — re-opens review 2026-08-18 §1.6 on the exact
  configuration it closed, on a path this feature never uses.
- **Arming `providerEnv` for project runs in this commit** — a genuinely good second gate at the
  right boundary, but it is a `src/cli` + `src/run` change adjacent to the feature. Named as a
  follow-up, not smuggled in.
- **A new event kind for mixed-payer runs** — the operator's query is "which runs billed my login
  session", and a mixed run is one of its answers; two kinds make every consumer learn both.
- **A per-kind `detail` schema map in `platformEvents.ts`** — a fourth exhaustive record to keep in
  step with severity and audience, pulling every domain's payload into the journal envelope.
- **Dated ids under the subscription** — a version claim the transport cannot keep, stored and
  journaled as fact.
- **Probing `claude auth status --json` per HTTP request** — a subprocess in a GET handler; the
  operator declaration is the assertion, doctor keeps the probe.
- **Replacing `ATOMA_LLM=claude-cli` with the picker** — migrates working deployments and the
  door's test suite for no gain; regime A is kept as the degenerate one-payer case.
- **Reusing `ATOMA_CLAUDE_MODEL`** — its own comment forbids it: a process-wide debug override that
  collapses every tier onto one model and flattens the cost gradient the product exists to produce.
- **Splitting `project_runs.stats_json` into a full per-payer breakdown** — blast radius across the
  burn-in CSV, the runs table and the epilogue contract, for resolution one scalar already gives.

## 11. What this design does NOT do

- It does not invent an operator organisation in `auth`. It reuses an existing org id as the
  operator plane's name. If the owner wants a real carve-out, that is a separate reviewed change.
- It does not make the platform-admin flag org-aware in general. Only the subscription decision
  becomes org-scoped, through the declaration.
- It does not audit **host-key** spend. A platform admin's unlocked pick of a billed model on a
  deployment with a host key still bills the operator's API account with no journal row; the
  ledger now *names* that payer on runs that also touch the subscription, but a pure host-key run
  emits nothing beyond `run.started`. An event per non-BYO run is `run.started` with extra steps.
- It does not fix the pre-existing cross-payer fall-through for a keyless `zai:` pin (org key →
  host env). It predates this feature and deserves its own decision; the new rule
  ("refusal is required across payers") names it as a violation without changing it.
- It does not enable a keyless per-tier deployment. D7 keeps the base credential requirement.
- It does not arm the browser smoke in CI, and it adds nothing that needs one.
- It does not claim `subscriptionCostUsd` is a bill. It is what those tokens would have cost at
  API list prices, by the convention already stated in the codex price rows.
- It does not prevent an admin of the declared organisation from spending the host subscription on
  work that is arguably a customer's. It makes the crossing require an explicit operator
  declaration and makes it visible in the journal for the first time.

## 12. Questions for the owner — ANSWERED 2026-08-28

Six answers confirmed the proposal. **Q8 reversed it**, and Q7 was re-asked before it could do
damage: read literally, "remove `claude-cli` from `ATOMA_LLM`" would have deleted the transport
that every LOCAL run on this machine depends on — `npm run run:build`, the MCP server and the
benchmark protocol all pin it, against a dead API key. The scope was the ambiguity, not the
preference, and the owner settled it by keeping both paths.

| # | Decision |
|---|---|
| Q1 | **One declared organisation.** `ATOMA_HOST_SUBSCRIPTION_ORG` names it; the subscription is selectable there and nowhere else. Confirms the operator-plane reading of `docs/saas-architecture.md`. |
| Q2 | **Alias, no version.** "Claude (host subscription) — Opus". The transport serves `opus`/`sonnet`/`haiku` and reports the alias back; a dated generation would be a promise it cannot keep. |
| Q3 | **The cost fix rides in this commit.** `LlmCallMetrics.requestedModel` and a nullable `RunStats.subscriptionCostUsd`, so the journal row and the cost figure agree from the first mixed run rather than contradicting each other on day one. |
| Q4 | **A keyless host is refused.** D7 stands: the Anthropic SDK does not throw on a null credential, it silently resolves the operator's login profile, so a keyless base would spend the subscription with nothing saying so. |
| Q5 | **The admin catalogue unlock is narrowed now.** `unlockAll: platformAdmin` currently lets an admin pick a billed model with no org key — billing the operator's API key under a comment claiming the subscription pays. The unlock and the comment are corrected in the same commit as the feature. |
| Q6 | **A stale pin refuses the run.** A revoked admin's runs fail until the pin is cleared in Settings. Never a silent fall-through. |
| Q7 | **Both paths survive.** `ATOMA_LLM=claude-cli` stays the "whole deployment on the subscription" route and wins by construction, being read before any preference. The cost — two ways to say one thing — is paid down to one sentence in `src/projects/AGENTS.md`. |
| Q8 | **The in-child gate is built here, not deferred.** REVERSES the proposal. `assertTransportHonoursCredentials` never fires on a project run because `spawnRun` replaces the child env wholesale and `runTask` supplies no snapshot; threading `providerEnv` through gives a real second gate at the process boundary the payer decision crosses. It widens the diff into `src/run` and `src/cli`. |

The questions as they were put:

1. Is a per-tier host-subscription choice inside the operator-plane carve-out at all? This design answers 'only for the single organisation the operator declares in ATOMA_HOST_SUBSCRIPTION_ORG'. Confirm that reading of docs/saas-architecture.md, or say that the subscription must stay whole-deployment (regime A only), in which case the feature reduces to per-tier alias choice on a machine that serves no tenants.

2. The dropdown copy. The transport can only serve the aliases opus/sonnet/haiku and reports the alias back as servedModel, so 'Claude (host subscription) — Opus 5' is a version claim it cannot keep. Do you accept 'Claude (host subscription) — Opus' as the label over an alias value, or do you want the dated generation shown anyway, knowing the run may serve a different one?

3. Does the cost fix ride in this commit? Adding LlmCallMetrics.requestedModel and a nullable RunStats.subscriptionCostUsd is additive and defaulted, but it touches the epilogue contract, the burn-in CSV and the runs table. Deferring it means the journal row and the cost figure disagree from the day the feature ships.

4. Should a keyless host be able to run all three tiers on the subscription with ATOMA_LLM=anthropic? This design refuses it (D7), because the Anthropic SDK does not throw on a null credential and would silently resolve the operator's login profile instead. Accepting the refusal means your own machine keeps ATOMA_LLM=claude-cli for whole-run subscription work.

5. Does the platform-admin catalogue unlock get narrowed now? Today unlockAll: platformAdmin lets an admin pick billed Anthropic models with no org key, billing the host's API key, under a comment claiming the subscription pays. This design narrows the unlock to declared facts and corrects the comment. Narrowing it is a behaviour change for admins on a keyless host; leaving it means the feature ships beside a false payer claim.

6. When a revoked admin's stale subscription pin blocks their runs, is a hard refusal the product feel you want? The alternative is fall-through plus a new run.subscription_pin_ignored journal row — never fall-through alone. The refusal means every run of theirs fails until they clear the pin in Settings.

7. Do you want ATOMA_LLM=claude-cli to survive at all, now that the picker can express the same deployment? Keeping both means two ways to say one thing, and the host-env one wins by construction because it is read before any preference.

8. Is arming the in-child credential snapshot for project runs (threading providerEnv through spawnRun/runTask) worth scheduling as a follow-up? It is the only way to get a real second gate at the process boundary the payer decision crosses; this design deliberately leaves the coordinator as the sole gate.

---

*Status: decided 2026-08-28, not yet built. Per COOLING-OFF this lands as one reviewed commit — the write
validator, the store, the coordinator gate, the transport strip, the catalogue neighbour, the
picker, the audit row and the docs move together, or the guards contradict each other.*
