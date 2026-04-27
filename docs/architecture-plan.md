# Plan — `atoma` : atomes LLM à 3 niveaux, registre tri-tier, escalade symétrique

## Context

Le répertoire `/Users/mgtf/dev/atoma` est vide — greenfield. Chaque atome est un
**agent LLM** organisé en triptyque L1 / L2 / L3 avec un **protocole de supervision
symétrique** à chaque niveau et un **catalogue persisté** des types réutilisables
pour les trois tiers.

### Le triptyque et sa taxonomie

| Niveau | Modèle Claude | Rôle | Nommage | Créé par | Persisté ? |
|--------|---------------|------|---------|----------|------------|
| **L1** | Haiku 4.5 (`claude-haiku-4-5-20251001`) | Plan → exécute 1 tâche simple. Ne délègue pas. | Éléments (`Hydrogen`, `Helium`, …) | L2 | ✅ |
| **L2** | Sonnet 4.6 (`claude-sonnet-4-6`) | Supervise L1, peut mutualiser avec pairs L2, **fallback : exécute lui-même** | Molécules (`Water`, `Methane`, `Glucose`, …) | L3 | ✅ |
| **L3** | Opus auto-résolu (fallback `claude-opus-4-7`) | Supervise L2, **fallback : exécute lui-même**. Top. | Cellules (`Neuron`, `Erythrocyte`, `Hepatocyte`, …) | application | ✅ |

Métaphore biologique **éléments → molécules → cellules**. La couche d'assemblage
supérieure (« tissus/organes ») reste différée.

### Règles métier confirmées

1. **Création par le tier au-dessus — cascade complète et symétrique.**
   - **L1 créés par L2** : quand Sonnet juge qu'aucun élément existant ne convient,
     il conçoit un nouveau type L1 (Hydrogen, puis Helium, …)
   - **L2 créés par L3** : quand Opus juge qu'aucune molécule existante ne convient,
     il conçoit un nouveau type L2 (Water, puis Methane, …)
   - **L3 créés par l'application** au bootstrap (nom depuis `CELLS` : Neuron, …)
   - À chaque création, le créateur fournit la base de fonctionnement (description,
     system_prompt, outils, params de départ) via un appel LLM structuré.
   - Le registre SQLite partagé rend chaque création visible immédiatement aux
     autres superviseurs du même tier.
2. **Registre SQLite unique, partagé.** Tous les types (tous tiers) vivent dans la
   même base locale. Tous les L2 voient tous les L1 ; tous les L3 voient tous les
   L2 ; l'application voit tous les L3.
3. **Décision amont : reuse / create / mutualize.** Avant d'attaquer une tâche,
   chaque superviseur consulte le catalogue de son tier enfant et choisit entre
   réutiliser un type existant, créer un nouveau type, ou (pour L2 seulement)
   mutualiser avec un pair L2.
4. **Nommage.** L1 = nom complet d'élément (allocation séquentielle par numéro
   atomique). L2 = nom de molécule (liste curée ordonnée). L3 = nom de cellule
   (liste curée ordonnée). Pas de doublons (nom unique global).
5. **Mutation à scope explicite** (à chaque rejet) :
   - `ephemeral` — instance courante seulement, pas d'écriture
   - `branch` — crée un nouveau type dans le même tier ; l'instance bascule
   - `patch` — incrémente la version du type canonique ; version précédente
     archivée pour audit
6. **Escalade symétrique et fallback** (nouveau, confirmé) :
   - Si `superviseLoop` atteint `maxIterations` sans approbation :
     - Le superviseur **prend le relais et exécute lui-même**
     - La **trace complète** de l'enfant (plans, rejets, résultats, modifs) est
       injectée dans son contexte
     - Un **branch automatique** est créé : un nouveau type enfant est enregistré
       dans le registre, son system_prompt enrichi des leçons de l'échec, prêt à
       être réutilisé plus tard
   - Le résultat du superviseur est ensuite supervisé par **son propre parent**
     selon le même protocole (L3 supervise le résultat de L2, qu'il vienne de L1
     ou de L2 en self-exec)
   - L3 est le dernier recours : s'il n'obtient pas satisfaction après N itérations,
     l'erreur remonte à l'appelant (pas de L4)
7. **Auto-update L3.** Le modèle Opus est résolu via `client.models.list()` au
   démarrage (fallback hardcodé).
8. **Prompt caching** activé par défaut sur chaque appel.

### Protocole de supervision (le même à chaque lien parent→enfant)

```
superviseLoop(parent, child, task):
  planIter = execIter = 0
  while True:
    if planIter++ > MAX: → escalade (fallback parent)
    plan    = child.plan(task)
    verdict = parent.validatePlan(plan)
    if !verdict.approved:
        child = applyByScope(child, verdict)     # ephemeral | patch | branch
        continue
    if execIter++ > MAX: → escalade (fallback parent)
    result  = child.execute(task, plan)
    verdict = parent.validateResult(result)
    if verdict.approved: return result
    child   = applyByScope(child, verdict)
```

Escalade :
```
escalade(parent, childTrace, task):
  ctx = injectTrace(childTrace)
  # branch automatique du type enfant avec leçons apprises
  registry.branch(child.type, synthesizeLessons(childTrace), parent.name)
  # parent exécute lui-même
  plan   = parent.plan(task, ctx)
  result = parent.execute(task, plan, ctx)
  return result  # sera supervisé par parent-de-parent
```

## Structure du projet à créer

```
atoma/
├── package.json              # ESM, TS strict, @anthropic-ai/sdk, better-sqlite3, zod, vitest, tsx
├── tsconfig.json             # strict, target ES2022, moduleResolution NodeNext
├── vitest.config.ts
├── .gitignore                # node_modules, dist, .env, *.db
├── .env.example              # ANTHROPIC_API_KEY=..., ATOMA_DB_PATH=./atoma.db
├── README.md
├── src/
│   ├── core/
│   │   ├── types.ts          # Task, Plan, Result, Verdict, AtomModifications, MutationScope, RunContext, Trace
│   │   ├── errors.ts         # EscalationSignal (contrôle de flux, pas une vraie erreur), ModelResolutionError, RegistryFullError
│   │   ├── limits.ts         # maxPlanIterations, maxExecIterations (défaut 5)
│   │   ├── llm.ts            # wrapper Anthropic (prompt caching ephemeral, retries, JSON-mode via zod)
│   │   ├── models.ts         # resolveLatestOpus(), PIN_SONNET, PIN_HAIKU, fallback
│   │   ├── atom.ts           # base abstraite Atom + interfaces Supervisor, Peerable
│   │   └── supervisor.ts     # superviseLoop() + escalade unifiées
│   ├── registry/
│   │   ├── schema.sql        # DDL unifiée atom_types + atom_type_versions
│   │   ├── db.ts             # ouverture, migrations idempotentes, mode WAL
│   │   ├── taxonomies/
│   │   │   ├── elements.ts   # ELEMENTS[] 118+, nextAvailable()
│   │   │   ├── molecules.ts  # MOLECULES[] ~40, nextAvailable()
│   │   │   └── cells.ts      # CELLS[] ~20, nextAvailable()
│   │   └── atomRegistry.ts   # API unifiée tier-keyed : listByTier, getByName, create, patch, branch
│   ├── atoms/
│   │   ├── L1Atom.ts         # hydraté depuis un AtomType(tier=1) ; plan/execute
│   │   ├── L2Atom.ts         # supervise L1 + Peerable ; self-exec en fallback
│   │   └── L3Atom.ts         # supervise L2 ; self-exec en fallback (dernier recours)
│   ├── index.ts              # exports publics
│   └── examples/
│       └── research-brief.ts # démo bout-en-bout avec escalade provoquée
└── tests/
    ├── l1.test.ts
    ├── supervision.test.ts   # chaque scope de mutation ; max iterations
    ├── escalation.test.ts    # L2 self-exec après échec L1 ; L3 self-exec après échec L2 ; branch auto
    ├── registry.test.ts      # create/patch/branch par tier ; concurrence ; reprise DB
    ├── allocation.test.ts    # nextAvailable pour chaque taxonomie ; extension au-delà des listes
    ├── mutualization.test.ts # L2 délègue à pair L2
    ├── model-discovery.test.ts
    └── cache.test.ts
```

## Types centraux (`src/core/types.ts`)

```ts
export interface Task {
  readonly description: string;
  readonly inputs?: Record<string, unknown>;
  readonly constraints?: string[];
}

export interface Plan {
  readonly reasoning: string;
  readonly proposedAction: string;
  readonly toolCalls?: ToolCall[];
  readonly expectedOutput: string;
}

export interface Result {
  readonly output: unknown;
  readonly summary: string;
  readonly toolCallResults?: unknown[];
  readonly trace: TraceEntry[];
  readonly producedBy: { tier: 1|2|3; name: string; viaFallback: boolean };
}

export type MutationScope = 'ephemeral' | 'branch' | 'patch';

export type Verdict =
  | { approved: true;  reasoning: string }
  | {
      approved: false;
      reasoning: string;
      modifications: AtomModifications;
      scope: MutationScope;
      branchName?: string;
    };

export interface AtomModifications {
  systemPromptAppend?: string;
  systemPromptReplace?: string;
  addTools?: Tool[];
  removeTools?: string[];
  params?: Partial<GenerationParams>;
  additionalContext?: string;
}

// Trace consignée pour escalade (injectée dans le contexte du parent en fallback)
export interface TraceEntry {
  kind: 'plan' | 'verdict-plan' | 'execute' | 'verdict-result' | 'applied-modifications' | 'escalated';
  ts: string;
  atom: string;
  payload: unknown;
}
```

## Registre SQLite unifié (`src/registry/`)

### Schéma (`schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS atom_types (
  tier          INTEGER NOT NULL CHECK(tier IN (1,2,3)),
  ordinal       INTEGER NOT NULL,         -- numéro atomique (tier=1) ou rang (tier=2,3)
  name          TEXT UNIQUE NOT NULL,     -- 'Hydrogen', 'Water', 'Neuron'
  description   TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL DEFAULT '[]',
  params_json   TEXT NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL,            -- nom du parent créateur ou 'user' pour L3
  created_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tier, ordinal)
);

CREATE TABLE IF NOT EXISTS atom_type_versions (
  tier          INTEGER NOT NULL,
  ordinal       INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  modified_by   TEXT NOT NULL,
  modified_at   TEXT NOT NULL,
  reason        TEXT,                     -- reasoning du verdict déclencheur ou 'escalation'
  PRIMARY KEY (tier, ordinal, version)
);

CREATE INDEX IF NOT EXISTS idx_atom_types_name ON atom_types(name);
CREATE INDEX IF NOT EXISTS idx_atom_types_tier ON atom_types(tier);
```

### API (`atomRegistry.ts`)

```ts
export interface AtomType {
  tier: 1 | 2 | 3;
  ordinal: number;
  name: string;
  description: string;
  systemPrompt: string;
  tools: Tool[];
  params: GenerationParams;
  createdBy: string;
  createdAt: string;
  version: number;
}

export class AtomRegistry {
  listByTier(tier: 1|2|3): AtomType[]
  getByName(name: string): AtomType | null

  // transaction : alloue next ordinal, récupère le nom via la taxonomie correspondante
  create(tier: 1|2|3, seed: {
    description: string;
    systemPrompt: string;
    tools: Tool[];
    params: GenerationParams;
    createdBy: string;
  }): AtomType

  // transaction : archive ancienne version, écrit la nouvelle (version++)
  patch(name: string, mods: AtomModifications, modifiedBy: string, reason?: string): AtomType

  // transaction : create() avec seed = merge(current, mods)
  branch(fromName: string, mods: AtomModifications, createdBy: string, overrideName?: string): AtomType
}
```

Transactions `better-sqlite3` en mode WAL ; connexion unique par process.

### Taxonomies (`src/registry/taxonomies/`)

- `elements.ts` : ELEMENTS 1-118 avec `name` + `symbol`. Au-delà : `Element${n}`.
- `molecules.ts` : ~40 entrées curées (`Water`, `Methane`, `Ammonia`, `CarbonDioxide`,
  `Glucose`, `Sucrose`, `Ethanol`, `Caffeine`, `Serotonin`, `Dopamine`, `Adrenaline`,
  `Insulin`, `Hemoglobin`, `Chlorophyll`, `DNA`, `RNA`, `ATP`, `Methanol`, `Acetone`,
  `Benzene`, `Urea`, `Cholesterol`, `Testosterone`, `Estrogen`, `Cortisol`, …).
  Extension : `Molecule${n}`.
- `cells.ts` : ~20 entrées curées (`Neuron`, `Erythrocyte`, `Leukocyte`, `Macrophage`,
  `Hepatocyte`, `Myocyte`, `Osteocyte`, `Adipocyte`, `Keratinocyte`, `Melanocyte`,
  `Astrocyte`, `Oligodendrocyte`, `Enterocyte`, `Nephron`, …). Extension : `Cell${n}`.

`nextAvailable(tier, used: Set<number>)` retourne `{ ordinal, name }`.

## Base `Atom` et supervision (`core/atom.ts`, `core/supervisor.ts`)

```ts
export abstract class Atom<TTask extends Task = Task> {
  abstract readonly tier: 1|2|3;
  abstract readonly model: string;
  readonly name: string;
  readonly ordinal: number;

  protected systemPrompt: string;
  protected tools: Tool[];
  protected params: GenerationParams;
  protected injectedContext: string[] = [];

  abstract plan(task: TTask, ctx: RunContext): Promise<Plan>;
  abstract execute(task: TTask, plan: Plan, ctx: RunContext): Promise<Result>;

  applyModifications(mods: AtomModifications): void
  injectContext(text: string): void
}

export interface Supervisor<Child extends Atom> {
  readonly tier: 1|2|3;  // le tier DU SUPERVISEUR (donc 2 ou 3)
  validatePlan(child: Child, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict>;
  validateResult(child: Child, result: Result, task: Task, ctx: RunContext): Promise<Verdict>;
}
```

### Boucle unifiée avec escalade (`core/supervisor.ts`)

```ts
export async function superviseLoop<C extends Atom>(
  parent: Atom & Supervisor<C>,      // le superviseur est lui-même un Atom
  child: C,
  task: Task,
  ctx: RunContext,
  hooks: {
    applyByScope(child: C, verdict: NegativeVerdict): Promise<C>;  // ephemeral|patch|branch
    branchOnEscalation(child: C, trace: TraceEntry[], reason: string): Promise<void>;
  },
): Promise<Result> {
  const trace: TraceEntry[] = [];
  let planIter = 0, execIter = 0;

  try {
    while (true) {
      if (planIter++ > ctx.limits.maxPlanIterations) throw new EscalationSignal('plan');
      const plan = await child.plan(task, ctx);
      trace.push({ kind: 'plan', ts: now(), atom: child.name, payload: plan });

      const v1 = await parent.validatePlan(child, plan, task, ctx);
      trace.push({ kind: 'verdict-plan', ts: now(), atom: parent.name, payload: v1 });
      if (!v1.approved) { child = await hooks.applyByScope(child, v1); continue; }

      if (execIter++ > ctx.limits.maxExecIterations) throw new EscalationSignal('exec');
      const result = await child.execute(task, plan, ctx);
      trace.push({ kind: 'execute', ts: now(), atom: child.name, payload: result });

      const v2 = await parent.validateResult(child, result, task, ctx);
      trace.push({ kind: 'verdict-result', ts: now(), atom: parent.name, payload: v2 });
      if (v2.approved) return { ...result, trace };

      child = await hooks.applyByScope(child, v2);
    }
  } catch (e) {
    if (!(e instanceof EscalationSignal)) throw e;
    // --- ESCALADE ---
    trace.push({ kind: 'escalated', ts: now(), atom: parent.name, payload: { phase: e.phase } });
    // 1) branch automatique du type enfant avec leçons synthétisées
    await hooks.branchOnEscalation(child, trace, `escalation-${e.phase}`);
    // 2) parent injecte la trace et exécute lui-même
    parent.injectContext(renderTraceForContext(trace));
    const plan   = await parent.plan(task as unknown as Task, ctx);
    const result = await parent.execute(task as unknown as Task, plan, ctx);
    return { ...result, producedBy: { ...result.producedBy, viaFallback: true }, trace };
  }
}
```

Le résultat d'un parent en self-exec ressemble exactement à n'importe quel autre
résultat : il sera supervisé par *son propre parent* selon le même protocole.

## Atomes concrets

### `L1Atom`
- `tier = 1`, `model = PIN_HAIKU`
- Construit via `L1Atom.fromType(type: AtomType)`
- `plan()` / `execute()` conformes à `Plan`/`Result` (zod)
- Pas de `Supervisor` — ne délègue pas

### `L2Atom`
- `tier = 2`, `model = PIN_SONNET`, nom alloué depuis MOLECULES
- Implémente `Supervisor<L1Atom>` + `Peerable<L2Atom>`
- `run(task, ctx)` :
  1. `const cat = registry.listByTier(1)`
  2. Sonnet décide : `reuse(name)` | `create(seed)` | `mutualize(peerName)`
  3. Instancie ou hydrate L1 (ou délègue au pair)
  4. `superviseLoop(this, l1, task, ctx, hooks)` avec hooks branchés sur `registry`
  5. Si escalade → self-exec déjà gérée dans `superviseLoop`
- Expose `plan()` / `execute()` pour être supervisé par L3

### `L3Atom`
- `tier = 3`, nom depuis CELLS, `model = await resolveLatestOpus(client)` à la construction
- Implémente `Supervisor<L2Atom>`
- **C'est L3 qui crée les types L2**, exactement comme L2 crée les types L1 — le
  cascade complet est donc : *application → crée L3 → L3 crée L2 → L2 crée L1*.
  Quand Opus décide de créer un nouveau type L2, il conçoit lui-même la molécule
  (description, system_prompt Sonnet, outils, params) via un appel LLM structuré,
  puis `registry.create(tier=2, seed)` attribue le prochain nom de molécule libre
  (`Water`, puis `Methane`, etc.).
- Point d'entrée public `execute(task)` :
  1. `const cat = registry.listByTier(2)` — catalogue partagé visible à tous les L3
  2. Opus décide : `reuse(name)` (sélectionne un type L2 existant) ou
     `create(seed)` (dessine un nouveau type L2 et l'enregistre)
  3. Instancie L2 (hydrate depuis le type existant ou nouvellement créé)
  4. `superviseLoop(this, l2, task, ctx, hooks)`
  5. Si escalade → self-exec Opus avec trace L2 injectée ; un **branch
     automatique** du type L2 est enregistré (leçons apprises → nouveau type
     L2 persisté) ; pas de parent au-dessus, le résultat est retourné directement
     à l'appelant

## Auto-résolution Opus (`core/models.ts`)

Identique à la version précédente : `client.models.list()` → filtre `/opus/i` →
tri `created_at` décroissant → premier ; fallback `claude-opus-4-7`.
Pins `PIN_SONNET = 'claude-sonnet-4-6'`, `PIN_HAIKU = 'claude-haiku-4-5-20251001'`.

## Exemple (`src/examples/research-brief.ts`)

Premier run (DB vierge) :
- Application crée L3 `Neuron` avec un seed dédié à la rédaction de briefs
- `Neuron` reçoit tâche, consulte registre tier=2 (vide), crée L2 `Water` pour recherche
- `Water` consulte tier=1 (vide), crée L1 `Hydrogen` pour web-query, `Helium` pour extract
- Cycle de supervision normal ; une tâche est volontairement difficile pour forcer un
  rejet + `branch` → création de `Lithium`
- Un second scénario échoue tellement sur L1 que L2 escalade : self-exec de Water,
  création automatique de `Beryllium` comme branche enrichie

Second run (DB persistée) :
- `Neuron`, `Water`, `Hydrogen`, `Helium`, `Lithium`, `Beryllium` tous déjà présents
- Pas de création, uniquement réutilisation ; logs le confirment

## Fichiers critiques (ordre d'implémentation)

1. `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
2. `src/core/types.ts`, `errors.ts`, `limits.ts`
3. `src/registry/schema.sql`, `db.ts`, `taxonomies/*`
4. `src/registry/atomRegistry.ts` (+ tests)
5. `src/core/llm.ts` (cache), `models.ts`
6. `src/core/atom.ts`, `supervisor.ts` (avec escalade)
7. `src/atoms/L1Atom.ts`, `L2Atom.ts`, `L3Atom.ts`
8. `src/index.ts`
9. Suite de tests complète (escalation en priorité — c'est le mécanisme différenciant)
10. `src/examples/research-brief.ts`
11. `README.md`

## Vérification end-to-end

- `npm install && npm run build` : TS strict ok.
- `npm test` (LLM mocké) :
  - `AtomRegistry.create` : tier=1 → Hydrogen, tier=2 → Water, tier=3 → Neuron
  - `patch` incrémente version, snapshot archivé
  - `branch` alloue le prochain nom libre du tier ; pas de collision
  - Scopes de mutation : ephemeral (aucune écriture), patch (nouvelle version), branch (nouveau type)
  - **Escalade L1→L2** : après maxIter, L2 self-exec ; trace L1 injectée ; branch auto créé
  - **Escalade L2→L3** : même pattern un étage plus haut
  - **L3 dernier recours** : si L3 lui-même ne peut satisfaire, erreur remonte proprement
  - Mutualisation L2↔L2
  - `resolveLatestOpus` : succès, erreur, aucun opus → fallback
  - Headers `cache_control` présents
- `npx tsx src/examples/research-brief.ts` : exécution réelle, au moins un cycle
  d'escalade observable dans les logs, persistance DB vérifiable entre deux runs.

## Hors scope (différé)

- **Couche de composition au-dessus du triptyque** (tissus/organes assemblant
  plusieurs cellules pour des tâches plus vastes).
- Rollback de version depuis une CLI.
- Registre inter-process (HTTP/Redis) ; SQLite local suffit pour l'instant.
- Streaming token-par-token, OpenTelemetry, UI de visualisation, registre d'outils
  générique et découvrable.
- Évaluation automatique de la qualité des types persistés (métriques d'usage,
  nettoyage des types jamais réutilisés).
