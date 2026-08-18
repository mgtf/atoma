# Revue critique — fenêtre 2026-08-13 → 2026-08-18 (105 commits)

Date : 2026-08-18.
Méthode : lecture des commits `027ae42..08fc043` (HEAD), puis re-vérification
manuelle des chemins de production à HEAD. Les findings de
[`docs/code-review-2026-08-14.md`](code-review-2026-08-14.md) déjà fermés par
les batches runtime 1–10 ne sont pas re-litigés. Convention : **✓ = lu dans le
code actuel**. Les numéros de ligne référencent HEAD `08fc043`.

> **Working tree.** Quatre fichiers registry sont dirty
> (`atomRegistry.ts`, `molecules.ts`, `cells.ts`, `tissues.ts`). Ils retirent
> `isReservedTaxonomyName` et déplacent la collision sur `nextAvailable(...,
> takenNames())`. C’est une autre thèse que 08fc043 : le LLM *garde* le nom
> du pool, et `create()` saute l’entrée. Les tests commis ce matin
> (`CarbonDioxide-2`, ordinal 4 reste canonique) et le contrat AGENTS.md
> (« the branch collision guard reserves the whole taxonomy pool »)
> échoueraient. Ne pas merger cet in-progress tel quel.

## Vue d'ensemble de la fenêtre

105 commits, 358 fichiers, +47 999 / −13 029. Deux moitiés distinctes.

**13–15 août — clôture de la revue du 14 et réécriture GPU.** Les batches
runtime 6–10 ferment `startTask` / `servedModel` / backup hors machine /
payloads MCP bornés / ScrollPane / motion / parseurs CLI / épilogue
`cancelled` / horloge Ollama. Le visualiseur GPU est décomposé en vues sur
`RendererCtx`. Cette moitié est déjà consignée dans la revue du 14
(statuts des 15 août). Elle tient à HEAD.

**16–18 août — polish viz, fan-out L3, T10, T4, reset.** Un cluster viz
(ombres, palette, panneau de tuning, poll live, GC pointer-light), le
prompt « one phase per orthogonal GROUP », les credentials par run +
frontière OS obligatoire, le flip nom→`atom_id` des namespaces skills, puis
un `refactor!` qui supprime versioning / migrations et remet l’état à zéro.
Le dernier commit commis (08fc043) empêche un `overrideName` LLM de squatter
un nom de pool et de tuer le `create()` suivant.

Le flip T4 est le changement le plus chargé : l’affichage a été rattrapé
surface par surface (`list`, onglet Skills, `ledger tail`), mais
**l’adressage** (filtre, open-skill, review mécanique, promotion) est resté
à cheval entre nom et id.

## 1. Bugs confirmés (par gravité)

### 1.1 ✓ HIGH — `atoma_skills_review` indexe les outils par nom, les cherche par id

`src/mcp/readers.ts:327-341`. Depuis T4 le namespace disque est un `atom_id`.
Le MCP construit `toolsByAtom` avec `a.name` puis fait `toolsByAtom.get(ns)`
où `ns` est l’id. Le lookup est toujours `undefined` → `ownerToolNames: []`.

Conséquences, via `assessShareability` (`shareability.ts:125-141`) :

- `undeclaredToolMentions(prose, [])` marque **tout** outil builtin nommé
  comme `scope:undeclared-tool` — faux positifs massifs sur des recettes
  légitimes.
- `hostAllowsLoopbackNetwork([])` reste faux — scan trop strict pour les
  buckets HTTP.

Le CLI `skills review` a le fix (`cli/skills.ts:419-425` clé par
`atom_id`). Le MCP est la copie oubliée. Pas de test MCP tool-scope
id-keyed.

### 1.2 ✓ HIGH — La promotion résout l’hôte par `getByName(atomId)`

`src/atoms/L2Atom.ts:1543`. Après un succès skill-driven, `tryPromoteSkill`
reçoit `hostTools` pour calibrer le scan (loopback autorisé pour les
buckets HTTP). `skillNs` est un `SkillNamespace` (= `atom_id`), mais :

```
hostTools: (this.registry.getByName(skillNs)?.tools ?? []).map((t) => t.name)
```

`getByName` sur un UUID retourne `null` → `hostTools: []` →
`hostAllowsLoopbackNetwork([])` faux (`lifecycle.ts:894-896`). Un script
HTTP légitime (`fetch_url` / `start_node_server`) est refusé à la
promotion, stampé, et ne retentera pas tant que le body / la génération de
scan ne change. Le chemin L2 shared-catalog a déjà été corrigé au même
motif (`L2Atom.ts:691-694` : « with `getByName` every donor came back
null »). Celui-ci a échappé.

La promotion est gelée par défaut en from-scratch ; le bug est live dès
qu’un seed ou `ATOMA_SKILL_PROMOTE=1` l’arme.

### 1.3 ✓ HIGH — La trace viz jette `l1AtomId` ; « Open skill » 404

`SkillEventInfo` porte volontairement les deux champs (`types.ts:395-406`) :
`l1Name` = label, `l1AtomId` = clé disque / API. `recordSkillEvent`
(`viz/trace.ts:544-555`) ne persiste que `l1Name`. `VizSkillEvent` n’a pas
de champ id.

Depuis le timeline, le bouton construit
`skill.open.${event.l1Name}::${event.skillId}` (`runs.ts:1068-1071`).
`GpuApp.tsx:206-212` appelle `selectSkill({ l1Name })` puis
`/api/skills/:l1Name`, dont le contrat (`server.ts:453-454`) exige
**l’atom id**. Le prefetch du détail run (`GpuApp.tsx:96-104`) et le client
MUI (`RunsView.tsx:651`) font la même requête. 404 silencieux (`.catch` →
`null`).

Ironie : les events `learn` / `promote` / `demote` émis par
`SkillLifecycle` **marchent** par accident — `L2Atom.lifecycle()`
(`:906-917`) n’injecte pas `displayNameForNamespace`, donc `l1Name` y
reste l’UUID. Les events L2 qui font correctement le label (`match`,
`success`, `inject`) sont ceux qui cassent l’open.

### 1.4 ✓ HIGH — `--molecule Water` / `l1: "Water"` filtre une clé, pas un nom

`src/cli/skills.ts:122` et `src/mcp/readers.ts:219-220` :

```
function skillNamespaces(reg, l1?) { return l1 ? [l1] : reg.listNamespaces(); }
```

`listNamespaces()` rend des atom ids. L’opérateur voit « Water » dans
`skills list` / `atoma_skills_list` (labels résolus en *sortie*) puis
filtre par ce nom → zéro skill, pas d’erreur de résolution. Même trou pour
`stats` / `review`. Les positionnelles `show` / `drop` / `merge` / `reset`
prennent aussi la clé (`cli/skills.ts:484-522`) alors que la table affiche
le nom.

### 1.5 ✓ HIGH — `skills stats` suggère `merge` avec le label

`src/cli/skills.ts:223` groupe par `labels.get(ns) ?? ns`, puis `:266`
émet `skills merge ${p.l1} <keep-id> <absorb-id>`. `merge` exige la clé
namespace. Copier la suggestion après T4 échoue. C’est exactement la
surface que `docs/saas-architecture.md` §9.2 (c) listait comme à résoudre
*avant* le flip.

### 1.6 ✓ HIGH — T10 est incomplet : pins et garde Codex L1 lisent `process.env`

`startTask(..., { providerEnv })` est documenté comme le snapshot par run
(transport, clé, routing — `runner.ts:329-338`, saas A6 « DONE »). Deux
lecteurs restent sur l’ambiant :

- Garde Codex L1 (`runner.ts:386-390`) : `process.env['ATOMA_MODEL_L1']`.
  Un pin `codex:` *uniquement* dans `providerEnv` n’est pas refusé au
  launch. En pratique `modelForTier` lit aussi `process.env`
  (`models.ts:31-34`), donc les atomes n’utilisent pas non plus le pin du
  snapshot — le client Codex peut être *construit* (`buildReferencedProviders(providerEnv)`)
  et jamais *servi*, ou l’inverse si le pin est dans `process.env` et pas
  dans le snapshot.
- `assertTransportHonoursCredentials` (`providers.ts:179-187`) ne
  s’applique qu’au `ATOMA_LLM` de base. Un snapshot
  `{ ATOMA_LLM: 'anthropic', ANTHROPIC_API_KEY: 'sk-A', ATOMA_MODEL_L2: 'claude-cli:sonnet' }`
  passe la garde, puis la factory `'claude-cli': () => makeBaseClient('claude-cli')`
  (`:113`) ignore le snapshot et facture `claude /login` / `codex login`
  machine (`llmClaudeCli.ts:227-229`, `llmCodexCli.ts:511-515`).

Le chemin CLI (pas de snapshot) n’est pas touché. Le chemin que T10
prétend ouvrir — embedder / futur multi-tenant — l’est.

### 1.7 ✓ MEDIUM — `L1Atom.fromType` charge encore les skills par `type.name`

`src/atoms/L1Atom.ts:186-188`. L2 production appelle `fromType(l1Type)`
**sans** registry et hydrate via `namespaceOf` — ce site est mort en run.
L’API publique + le test d’intégration (`tests/skill-registry.test.ts:551-578`)
valident encore le monde name-keyed. Le commentaire de `namespace.ts:30-34`
promettait *un* test production-path « create atom → lifecycle →
répertoire = atomId » : il n’existe pas. Un appelant qui passe un
`SkillRegistry` file sous `skills/<name>/`, que plus rien ne lit.

### 1.8 ✓ MEDIUM — `assertCurrentIdentity` / `registry migrate-identity` n’existent pas

`src/skills/namespace.ts:50-52` affirme qu’un arbre encore name-keyed est
refusé au launch, et qu’une commande déplace les répertoires. Grep HEAD =
ce commentaire. Après `80a07c7` / `48f2990` (plus de versioning, plus de
migration, reset from-scratch), un `skills/Water/` à côté d’un store
id-keyed rend **zéro skill** sans message. Pire qu’un crash schéma
(`openDb` + `CREATE TABLE IF NOT EXISTS` laisse une vieille table sans
`atom_id` échouer fort sur l’index unique).

### 1.9 ✓ MEDIUM — MCP `skills_stats` / `skills_review` émettent encore l’UUID

`atoma_skills_list` a le contrat `l1` = nom, `l1Key` = id
(`readers.ts:259-261`). `skillsStats` (`:287-299`) et `skillsReview`
(`:345`) mettent `l1: ns` (l’id). Un hôte MCP qui a appris le contrat
list ne peut pas enchaîner stats/review. Les `mergeCandidates` MCP
portent aussi la clé brute.

### 1.10 ✓ LOW — Client MUI : tout poll live réécrit l’index

`src/viz/client/use-runs.ts:31-32`. Tant qu’une entry est live, chaque
tick de 2 s remplace le tableau (`anyLive ? next : current`) même si rien
n’a changé. Le client GPU a le delta serveur + structural sharing
(eea8345). Le MUI est gelé ; c’est une régression de coût, pas de
correctness. Mentionné parce que c’est le *même* incident que la revue du
14 §F (« rebuild à chaque poll ») sur le client qu’on a choisi de garder
en fallback.

### 1.11 ✓ LOW — Tuning persisté, pas de reset UI

`src/viz/client-gl/tuning-live.ts:28-60`. Le panneau est visible par
défaut (f357a35). Chaque drag écrit `localStorage['atoma.viz.tuning']`.
`TUNING_IDENTITY` n’est pas muté ; la *session suivante* recharge des
décalages dev. Dérive visuelle « production » si on oublie `?atomaTune=0`.

## 2. Erreurs de conception

**A. Le flip T4 a atterri comme une couche d’affichage, pas comme une
identité.** `namespaceOf` → `atomId` est une ligne. Les ~24 surfaces de
§9.2 (c) avaient besoin d’*une* paire `(label, key)` et d’*un* résolveur
inverse `Water → atomId`. On a ajouté `displayNamesByAtomId` / `l1`+`l1Key`
/ `l1Label` **par surface, au fil des 404**, et on a oublié les
consommateurs qui *écrivent* la clé (filtre, merge, review, open-skill,
`getByName`, `loadFor(type.name)`). C’est la classe
un-concept-deux-définitions appliquée à l’identité elle-même.

**B. T10 a le même trou que T4 : le snapshot est optionnel pour les
lecteurs qui comptent.** Les clients sont construits depuis `providerEnv` ;
les atomes choisissent le modèle via `modelForTier()` → `process.env` ; la
garde Codex et les flags lifecycle mutent `process.env` pour que les hooks
L2 les voient. Deux runs in-process concurrents (pas le MCP actuel, qui
spawn un child) se marchent dessus. Le document dit DONE ; le code dit
« CLI only, embedder best-effort ».

**C. Les commentaires portent encore le contrat de la migration
supprimée.** `visibility.ts:7` (« `./skills/<l1-name>/` — ZERO
migration »), `atomRegistry.ts:18` et `:628-631` (« skill store namespaces
by [name] »), `namespace.ts:50-52` (`assertCurrentIdentity`). Après un
`refactor!` qui efface le migrator, un commentaire qui promet une garde
est une régression opératoire.

**D. Cluster viz du 16 août = même journée, même widget, six commits de
drag.** `d7616d2` puis `5fbf662` / `b7598ac` / `3112f46` / `b01de43` /
`2a53572`. La règle de refroidissement vise les gates mécaniques, pas le
rendu ; le motif (fixer le symptôme du tick suivant) est le même. Le
pointer-light GC (e1050c1) et le poll sans rebuild (eea8345) sont au
contraire des fermetures propres d’incidents nommés.

## 3. Refactorings (rendement)

1. **Un résolveur `resolveMoleculeRef(raw) → { atomId, name }`** consommé
   par CLI, MCP (`l1` / `--molecule` / positionnelles), et la suggestion
   `merge`. Entrée = nom *ou* id ; sortie toujours les deux. Corrige 1.4,
   1.5, 1.9.
2. **Persister `l1AtomId` sur `VizSkillEvent`** et l’utiliser pour
   `/api/skills` / `skill.open` / prefetch. Le label reste `l1Name`.
   Injecter `displayNameForNamespace` dans `L2Atom.lifecycle()`. Corrige
   1.3.
3. **`getByAtomId(skillNs)` pour `hostTools`** (1.2) et `a.atomId` pour
   `toolsByAtom` MCP (1.1). Deux lignes, le CLI a déjà le patron.
4. **`modelForTier(env = process.env)`** + garde Codex L1 + logs de pins
   sur le même snapshot que `buildReferencedProviders`. Étendre
   `assertTransportHonoursCredentials` à `referencedProviderNames(env)`,
   pas seulement le base kind. Corrige 1.6.
5. **Implémenter ou retirer `assertCurrentIdentity`.** Un arbre
   name-keyed doit échouer fort avec le mode d’emploi (`skills/` reset, ou
   une vraie commande). Un test production-path create→lifecycle→dirname
   = `atomId`. Corrige 1.7 / 1.8.
6. **Ne pas atterrir le working tree registry** tant que les tests 08fc043
   et le contrat « pool stays canonical » n’ont pas été soit honorés, soit
   explicitement remplacés (un commit, une thèse).

## 4. Ce qui est remarquablement bien

- **08fc043 (HEAD commis)** : reproduction réelle, suffixe sur le raw name
  pour ne pas boucler sur `Molecule5-2` → `molecule52`, test de non-régression
  *et* de non-sur-réservation (`Minesweeper-WebGL` passe). C’est le patron
  que le flip T4 n’a pas suivi.
- **Display-layer T4 sur les listes** : `atoma_skills_list`, onglet Skills
  (`l1Name` = clé, `l1Label` = nom), `ledger tail`, curriculum re-key
  explicite pour les hints LLM. Le diagnostic « un UUID coûte des tokens
  et n’est pas retapable » est le bon.
- **T10 partiel mais honnête là où il l’est** : `providerEnv` ne peut pas
  relâcher `ATOMA_REQUIRE_ISOLATION` ; `claude-cli` *en base* est refusé
  dès qu’un snapshot est fourni ; plus de `delete process.env[ANTHROPIC_API_KEY]`
  sticky. Doctor ne revendique plus un profil OAuth non prouvé (2190dfb).
- **Fan-out** : le prompt « one phase per orthogonal GROUP » + L2
  `concat` n>1 → `Promise.all` est la seule spelling que le schéma permet
  (un mode d’aggregation par plan). Mesuré, documenté, pas un deuxième
  champ `parallelGroup`.
- **Viz GPU** : pointer-light `autoGarbageCollect = false` (e1050c1),
  poll live sans rebuild de scène (eea8345), wheel fail-closed sur
  `scrollMax`, `prefersReducedMotion()` unique, label cache qui
  `removeFromParent` avant destroy, `viz:dev` dans le même process group
  (807d195). Les incidents nommés de la revue du 14 §F / batch 8 sont
  fermés.
- **Backup + MCP borné** : snapshot SQLite ONLINE, dest hors dépôt,
  `atoma_run_trace` paginé, goal plafonné, lease stale visible, caveat
  UNTRUSTED sur runStatus.
- **Reset 48f2990** : plutôt qu’une N-ième migration crash-convergente,
  ils ont coupé. Coûte les CSV de mesure (exception AGENTS.md du 18/08,
  assumée) ; évite de servir deux schémas.

## 5. Zones inspectées — pas de finding nouveau

| Zone | Verdict à HEAD |
|---|---|
| Branch squat 08fc043 (code **commis**) | Fermé. Voir le bandeau working tree. |
| Readers de migration / `SCHEMA_VERSION` | Absents. |
| `fork` / rollback / patch : `atomId` stable, trust reset | OK (`atom-identity.test.ts`). |
| Direct dispatch attribution (8f195ff) | Owner ns vs `producedBy.name` exécuteur, testé. |
| Host lifecycle snapshot (learn/promote/direct) | Sticky-off inter-runs séquentiels fermé. |
| Codex L1 si le pin est dans `process.env` | Refusé au launch + doctor. |
| Isolation : `providerEnv` ne peut pas la couper | Prouvé. `opts.requireIsolation: false` *peut* — API hôte documentée, pas un bypass tenant. |
| Backup dest / WAL | Dest obligatoire, refuse le repo, snapshot ONLINE. |
| Timeline newest-first / bookends / rails / `rowOffset` | Cohérent avec les tests `viz-gpu-views`. |
| Pixi GC hors pointer-light | Filtres carte reconstruits chaque render. |

## 6. Risques résiduels (non findings)

- **`mergeInto` / dedupe** : supprime la ligne atom, laisse
  `skills/<loser-atom-id>/` orphelin. Pas de consolidation.
- **OAuth / CLI / Codex** : sans clé/bearer *explicites* dans le snapshot,
  le SDK et les subprocess restent collés à l’identité machine. T10
  complet = clés dans le snapshot + refus des pins CLI.
- **L3 `aggregation: concat` explicite** : seule l’*omission* est forcée
  en `sequential`. Un modèle qui parallélise un pipeline couplé n’a pas
  de garde mécanique post-plan (le prompt grouping est la mitigation).
- **`outputs` non filés entre phases** : seul `previousStepSummary` l’est.
  Les gates skills/promotion ne voient que la phase courante.
- **Budget phase vs run** : toujours ouvert
  (`docs/incidents/parallel-fanin-2026-08-16.md`).
- **Store pré-T4** : `CREATE TABLE IF NOT EXISTS` ne migrate pas ; crash
  sur `idx_atom_types_atom_id`. Aligné « schema is the schema », à
  documenter dans doctor.
- **`runTrace` errors** : tronqués, pas marqués UNTRUSTED par event
  (`readers.ts:536-539`).
- **Fan-out non déterministe** : L2 `decomposable` reste un appel Haiku
  (3/4 mesuré). Limite produit, pas un bug.

## 7. Trois priorités

1. **Fermer le delta nom↔id (1.1–1.5, 1.9)** — le CLI review a déjà le
   patron ; le recopier sur MCP review, `hostTools`, la trace viz, et un
   `resolveMoleculeRef`. Surface petite, tests absents, incident déjà payé
   deux fois (`getByName` sur un id vide le catalogue partagé ; review MCP
   le refait).
2. **Finir T10 ou le rétrograder** — `modelForTier(env)` + garde Codex +
   `assertTransportHonoursCredentials` sur tous les providers référencés,
   *ou* retirer le claim « DONE » de saas A6. Ne pas laisser un embedder
   croire que le snapshot route.
3. **Tranché le squat** — garder 08fc043 (pool canonique, LLM suffixé)
   *ou* commettre l’in-progress (LLM garde le nom, allocator saute) avec
   les tests réécrits. Pas les deux. Implémenter ou effacer
   `assertCurrentIdentity`.
