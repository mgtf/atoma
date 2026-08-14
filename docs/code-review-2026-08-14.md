# Revue critique externe — fenêtre 2026-08-04 → 2026-08-14 (296 commits)

Date : 2026-08-14.
Méthode : 8 relecteurs spécialisés (supervision core, skills, tools/sandbox/container,
MCP, providers, viz, runner/harness/release, processus) ont lu le code actuel et
l'historique git de la fenêtre ; les bugs les plus graves ont ensuite été re-vérifiés
manuellement par lecture directe du code à HEAD (a56ee0c + working tree).
Convention : **✓ = vérifié manuellement dans le code actuel** ; les findings sans ✓
viennent des relecteurs, sont précis (file:line) mais n'ont pas été re-tracés à la main.

Ce document est un instantané : les numéros de ligne référencent l'état du 2026-08-14.

## Vue d'ensemble de la fenêtre

~33 « live iterations » de durcissement du pipeline de validation (le 12/08 surtout :
64 commits, session continue d'~18h finissant à 3h du matin), le serveur MCP stdio,
l'isolation conteneur + egress, les providers Codex/Z.ai avec routage par tier, les
benchmarks rounds 2-8, la consolidation du store, la release v0.1.0→0.1.3, et trois
réécritures complètes du visualiseur (DOM→MUI→full-GPU, les deux dernières le même
après-midi du 13/08).

> **Statut 2026-08-14 (après-midi)** : la priorité n°1 (§5) est appliquée — les
> correctifs 1.1, 1.3, 1.4, 1.9 et 1.6 sont dans le working tree avec leurs tests
> de régression (`tests/branch-ctx-propagation.test.ts`, `tests/run-pgid-guard.test.ts`,
> cas `./`-spelling dans `tests/tools.test.ts`, cas release-throw dans
> `tests/mcp-server.test.ts`, describe `ensureBurninCsvHeader` dans
> `tests/burnin.test.ts`). Le CSV compare est réparé (17 champs partout, arm=atoma)
> et les DEUX writers refusent désormais un en-tête étranger. Suite complète :
> 1433 passed / 8 skipped, typecheck + lint verts.

> **Statut 2026-08-14 (soir)** : le refactoring 3.7 est appliqué. Les règles
> actives tiennent désormais dans un `AGENTS.md` de ~500 lignes ; les 5 452
> lignes antérieures sont préservées sous `docs/incidents/` et chargées seulement
> à la demande. `npm run docs:check`, intégré au check et à l'archive de release,
> borne la taille, vérifie l'import Claude unique et refuse les liens cassés.

## 1. Bugs confirmés (par gravité)

### 1.1 ✓ HIGH — La gate anti-fabrication est inerte en production
`src/core/branchCtx.ts:60`. `forkBranch` reconstruit le `RunContext` par énumération
de champs et **omet `requireObservedToolAction`**. Le runner ne le pose que sur le ctx
racine (`src/run/runner.ts:353`), mais `validateResult` le lit depuis un double fork
(L3 fork à `L3Atom.ts:649`, L2 re-fork à `L2Atom.ts:1071`). La gate de la 5e itération
(« zéro action outillée observée → rejet mécanique avant trust ») ne se déclenche donc
jamais sur un vrai run — un L1 faible peut à nouveau fabriquer un livrable narratif et
passer le fast-path de confiance. Les tests passent parce qu'ils construisent le ctx à
la main sans fork. Même cause probable pour `dispatchedScriptSignatures` et
`mechanicalPlanRejections`, documentés « run-scoped » (`types.ts:398-418`) mais en
réalité branch-scoped : le mémo anti-redispatch ne traverse pas deux phases L3.

### 1.2 ✓ HIGH — Le bloc `== LITERAL CONTRACTS ==` fuit dans 6 gates sur 7
`src/atoms/prompts.ts:216`. `stripLiteralContractBlock` n'a **qu'un seul consommateur**
(`L2Atom.ts:368`, le correctif de l'itération 32 pour le routage). Toutes les autres
gates qui sniffent la description — `checkRequiredCommandManifest`,
`checkRecordedJsonShape`, `checkRequiredPortableHttpDocs`, `webStylingEvidenceMissing`,
et surtout `subtaskMutatesFiles`/`scriptCanServeSubtask` dans le dispatch des skills
(`lifecycle.ts:1099, 1166-1174`) — scannent la description **brute**, bloc inclus.
Conséquences : une phase de build hérite des exigences de harnais de la phase 2
(rejet mécanique identique à chaque retry → cascade 3-rejets→escalade), et une phase
de re-vérification read-only se classe « mutante » à cause d'une phrase du but global
— ce qui re-casse silencieusement le gain de dispatch déterministe de la 7e itération.

### 1.3 ✓ HIGH — `./.atoma-probes.json` contourne le merge et le refus d'édition
`src/tools/builtin.ts:72` et `:200`. Les deux protections comparent le chemin **brut**
au littéral `'.atoma-probes.json'`, alors que `sandbox.resolve()` normalise pour
l'écriture réelle. Un `write_file({path:'./.atoma-probes.json'})` — préfixe que les
modèles ajoutent couramment — saute le merge et écrase le manifeste des phases
précédentes : exactement la perte de données inter-phases que le merge structurel de
l'itération 33 devait empêcher. Même contournement pour le refus d'`edit_file`.

### 1.4 ✓ HIGH — `child_pgid` non borné = primitive de kill massif
`src/mcp/runLock.ts:180` + `src/cli/burnin.ts:336`. `processExists` (owner) garde
`pid <= 0`, mais la récupération de bail appelle
`runProcessGroupExists`/`terminateRunProcessGroup` avec le `child_pgid` lu de
`~/.atoma/mcp-run-lock.db` **sans aucune borne**. Un pgid de 1 (corruption, ou écrit
par le run lui-même — le modèle de menace du projet dit « l'adversaire est le run »,
et les chemins absolus atteignent `~/.atoma`) donne `process.kill(-1, SIGTERM)` puis
SIGKILL : tous les processus de l'utilisateur. Fix d'une ligne (`pgid > 1`). S'ajoute
la réutilisation de PID/PGID après reboot (aucune comparaison avec l'uptime ni
`acquiredAt`) : kill d'un groupe innocent ou faux-occupé permanent.

### 1.5 ✓ HIGH — La garde anti-`_meta.json` déchiré ne couvre que `bump()`
`src/skills/registry.ts`. `readMetaChecked` n'est appelé qu'en un point (ligne ~655) ;
`markMatched`, `markDirectFailure`, `markPromotionRefused`, `merge` et `save` lisent
via `readMeta` (catch → `{successes:0, failures:0}`) **et réécrivent ce défaut**.
`markMatched` écrivant à chaque match de prefilter — avant tout bump — un sidecar
déchiré d'un skill à 16✓ est ressuscité en 0/0 valide avant que la garde de d547729
ne le voie. Fix structurel : écritures atomiques (tmp+rename) + un unique
`mutateMeta()` routé sur `readMetaChecked`.

### 1.6 ✓ HIGH — L'artefact de mesure à HEAD est corrompu
`burnin/results-compare-opus.csv` : l'en-tête déclare 17 colonnes avec `arm` en
position 2 ; les trois lignes de données ont 22 champs au format burn-in standard avec
un `task_id` dans le slot `arm`. Tout parseur par en-tête lit des colonnes décalées et
la distinction des bras est irrécupérable. Cause : l'en-tête vient de
`burnin/compare-frontier.ts`, les lignes du writer standard de burnin. À noter aussi :
`envFor('treatment')` ne pinne ni `ATOMA_DB_PATH` ni `ATOMA_SKILLS_DIR` — l'expérience
overnight mute le store de production (peut-être voulu « mature store », mais un run
wedgé y laisse des compteurs fantômes — la classe d'incident viz:demo).

### 1.7 ✓ HIGH — `ATOMA_BASELINE`/`ATOMA_SEED` exportés polluent silencieusement la courbe
`src/run/runner.ts:75-76` lit ces variables d'env ; burnin spawn avec
`{...process.env}` (`burnin.ts:434`). Un `export ATOMA_BASELINE=1` oublié après une
session benchmark transforme chaque run burn-in en run contrôle sans tiering, et le
CSV n'a pas de colonne `arm` — rien ne le signale.

### 1.8 ✓ HIGH — Le driver benchmark écrase `RESULT.md` à chaque round
`src/cli/benchmark.ts:361` : `writeFileSync` inconditionnel, alors que le protocole
déclare les résultats immuables par round. Déjà arrivé (deux commits de restauration,
dont 53a55cd) — les données ont été réparées deux fois, le mécanisme zéro fois.

### 1.9 ✓ MEDIUM — `finishRun` peut bloquer le slot MCP pour toujours
`src/mcp/run.ts:238`. `record.lease.release()` (DELETE SQLite qui peut throw)
s'exécute avant `inFlight = null`, sans try/catch, dans un `void driven.then(...)` :
un throw laisse le slot occupé à vie et crashe le serveur par unhandledRejection.

### 1.10 ✓ MEDIUM — Le fallback sampling-400 ne couvre que l'itération 0
`src/core/llm.ts:145`. `samplingOk` est `const` et le retry est gardé par
`iter === 0` : un modèle absent de la deny-list qui rejette `temperature` survit au
round 0 puis meurt au round 2 de chaque boucle d'outils — le commentaire du code
promet l'inverse.

### 1.11 ✓ MEDIUM — Garde serveur de `record_probe` contournable
`src/tools/builtin.ts:2528` : ne couvre que `node <fichier.js>` exactement
(`argv.length === 1`). `node server.js --port 3000` ou `python3 app.py` passent →
30s de blocage, serveur sain tué, `exitCode:1` persisté.

### 1.12 ✓ LOW — Fuite de listeners abort dans claude-cli
`src/core/llmClaudeCli.ts:171` : `addEventListener('abort', {once:true})` jamais
retiré (le `finally` ne fait que `clearTimeout`), un par appel LLM sur le signal du
run entier ; masqué par le `setMaxListeners(0)` du runner. Le transport Codex écrit
la même semaine le fait correctement (add + remove dans le finally).

### 1.13 Signalés par les relecteurs, non re-vérifiés manuellement
- **viz server crash** : `decodeURIComponent` non gardé (`/api/runs/%`) tue le
  processus (`src/viz/server.ts:596`) — grave car « l'adversaire est le run ».
- **Colonne `escalations` du CSV** : `/escalat/gi` sur tout le log compte les
  `prefilter ➜ escalate` de routine et la prose des verdicts (`burnin.ts:136`) —
  les chiffres cités dans AGENTS.md conflatent routage et échec.
- **Coût calculé sur le pin, pas le modèle servi** : `codex:claude-opus-5` facturé
  prix Claude pour des tokens GPT-5.6-sol (`metrics.ts:74` + `resolveCodexModel`) ;
  `ATOMA_CODEX_MODEL` réécrit tous les slugs sans bannière.
- **Tokens partiels sur erreur** : conservés seulement dans le client Anthropic
  (e15d810) ; Ollama et claude-cli les perdent, et `RecordingLlmClient` écrit $0 là
  où `MetricsLlmClient` écrit le partiel — trace et CSV se contredisent.
- **Refus structurel Codex L1 tardif** : les prefilters/validateurs (sans tools)
  passent, la première exécution L1 détonne en plein run ; le check existe dans
  doctor mais pas dans `runTask`.
- **GPU viz** : scroll non borné/non masqué sur Registry/Skills
  (`gpu-renderer.ts:993`), panneaux de détail multi-Ko sans masque ni scroll,
  chaînes anglaises en dur contournant l'i18n (`eventDecision`),
  `prefers-reduced-motion` honoré par 1 système d'animation sur 8.
- **`webStylingEvidenceMissing`** fige le vocabulaire d'un widget
  (`streak-3/afterIncrement`, `L2Atom.ts:234`) alors que son détecteur frère dans
  builtin.ts a été étendu (`goalReached/after4`) — dérive un-concept-deux-définitions ;
  trigger `\bclass\b` qui matche « implement a Counter class ».
- **`routeCrossBucketVerification`** : redirige par égalité de nom vers le PREMIER L2
  web et force `aggregation: sequential` même sur un plan `concat`/`llm-synthesize`
  explicite (`L3Atom.ts:167-174`).
- **Egress proxy** : écoute sur 0.0.0.0 avec une patte sur le bridge partagé —
  joignable au-delà de son run ; pas de bornes ressources ; le cleanup synchrone
  hard-exit n'a pas le retry de suppression réseau du chemin async (8e bug de
  lifecycle du même motif).
- **Vocabulaire mutation incomplet** : `modify/change/remove/rename/extend` absents
  de `MUTATING_ACTION_SOURCE` (`scriptTargets.ts:84`) alors que la liste de négation
  voisine contient `modify` ; « don't » strippé par un vocabulaire de négation et pas
  par l'autre dans le même fichier.
- **Anti-redispatch crédite avant de jeter** : `runScriptSkillDirect` bump le succès
  et émet les événements avant que le mémo du caller ne rejette la sortie
  (`lifecycle.ts:1286` / `L2Atom.ts:983`) — successes non gagnés à chaque cycle de
  rejet de contenu.
- **Compile prompt** : « install via npm at runtime » contredit son propre bloc
  NETWORK POLICY — `spawnSync('npm', ['install', …])` est invisible au scan
  (child_process délibérément non flaggé) et échoue sous `--network none`.
- **`scriptArgv` (abi.ts) est mort** : les deux chemins de dispatch écrivent l'argv
  à la main — la dérive que le module existe pour empêcher.

## 2. Erreurs de conception

**A. La pile de gates est un moteur de règles sans propriétaire, avec deux
philosophies contradictoires.** L'ancienne génération (ground truth, quoted spans,
manifest health) applique « une heuristique ne fait jamais échouer un run à elle
seule » (contradiction → verdict LLM). Les gates du 12/08 rejettent directement,
avant trust, sans LLM et sans protection one-shot — tout faux positif se répète à
l'identique et déclenche la cascade 3-rejets→escalade (la leçon `types.ts:404-418`
du côté plan n'a pas été héritée). `L2Atom.ts` est repassé de ~1 590 à 2 369 lignes
en une semaine ; le record affiche toujours « ~1 590 ».

**B. L'intention de sortie voyage en prose puis est récupérée par regex — alors que
le système contrôle les deux bouts du canal.** Le prompt de plan exige déjà de nommer
les chemins de sortie exacts ; `scriptTargets.ts` les ré-extrait avec une grammaire
anglaise cultivée incident par incident (6 familles de regex, 3 vocabulaires de
négation qui divergent déjà entre fonctions adjacentes). Chaque paraphrase inédite
coûte un run live + un post-mortem, au seul point du pipeline sans validateur en
dessous. Un champ structuré `outputs?: string[]` dans `subtaskSpecSchema` rend la
grammaire un fallback héritage.

**C. Whack-a-mole sous fatigue.** Le contrat smoke inversé deux fois en 24h
(« tout booléen false est une assertion » falsifié 86 minutes plus tard) ; ~12
commits pour converger vers le contrat final qu'une passe de design du type
hybrid-skills aurait plausiblement atteint en 2-3 itérations ; le classificateur de
mutation corrigé 3 fois en un après-midi ; ≥10 chaînes fix-of-fix (~13 % de la
fenêtre). La règle POST-RUN ERROR CLOSURE court-circuite structurellement la règle de
refroidissement two-consecutive-batch. La revue adversariale pré-construction n'est
appliquée qu'aux idées **rejetées** — les mécanismes acceptés croissent par accrétion
n=1. Le framework accumule les littéraux spécifiques-à-la-tâche que ses propres
règles interdisent aux skills (`afterFour`, `goalReached`, `streak-3` dans le code du
harnais).

**D. Chemin compilation/zero-token : ~17 % des commits contre la propre conclusion du
record.** « Stop spending rounds on it » est écrit depuis le 11/08 (plafond
~0,03 $/run, dispatches 10-cassés/1/1/0 sur les rounds 5-8) — 8+ commits
post-conclusion continuent d'affiner. Non chiffré dans le record : chaque fix de body
reset 0/0 (quatre resets dans la fenêtre, dont un 24✓) et l'intervalle de correction
est plus court que la re-maturation (3✓) — l'état trusted est structurellement
transitoire, duty cycle du dispatch ≈ 0 par construction. Promotion toujours ON par
défaut pour toutes les familles.

**E. Outils génériques couplés au domaine.** `write_file` merge structurellement un
nom de fichier précis ; il existe trois implémentations de merge du manifeste aux
sémantiques divergentes (`builtin.ts:82`, `:2344`, `:2373` — corruption gérée
différemment dans les trois), en contradiction avec la règle une-définition de
`src/contracts/`. Le merge est append-only : le chemin de réparation que le message
d'`edit_file` recommande (« réécrivez le document entier ») ne fonctionne pas.
Coût concret au bord conteneur : l'image worker embarque `dist/contracts` + zod
uniquement parce que les outils fichiers traînent le contrat dans leur graphe.

**F. Viz : trois réécritures en dix jours, deux clients maintenus, et le rendu GPU a
perdu ce que le client MUI avait gagné.** Le renderer détruit et reconstruit toute la
scène Pixi à chaque notification Zustand (subscription sans sélecteur) — chaque tick
de molette, chaque frappe, chaque poll 1s — et une identité instable
(`useSkillLists`) le fait deux fois par scroll. Le gain audité « −96 % de churn,
rendu incrémental par id » a survécu sur le fil, pas dans le rendu. ~100 assertions
de test greppent le source (`let x = 160`, noms de méthodes privées) : elles
punissent le refactoring dont le fichier de 4 300 lignes a besoin, tout en laissant
passer les vraies régressions (le grep de clamp passe alors que 4 vues sur 5 ne sont
pas clampées). Accessibilité quasi nulle (canvas aria-hidden, pas de sélection de
texte — dans un outil dont le métier est de lire des prompts) ; `hitTargets` existe
déjà et pourrait alimenter le DOM bridge (~100 lignes). Pendant ce temps, la classe
d'échec réelle (wedging silencieux ; 2 lignes `error` dans le batch overnight du
14/08) ne recevait aucun commit.

**G. Bus factor 1 avec les preuves non versionnées.** Les ~40 traces citées
nommément comme justification des gates du 12/08, le store de trust et les bodies de
skills vivent non versionnés sur une machine (classe déjà payée : 19 traces du round
2 détruites). AGENTS.md à 5 406 lignes (~90k tokens) est chargé dans chaque session
d'agent — la moitié d'une fenêtre de contexte — et ses métadonnées rotent en 48h
(« ~4500 lines », « four rounds » au-dessus d'un record à huit rounds). 103 des 297
commits (35 %) maintiennent le record plutôt que le produit.

## 3. Refactorings suggérés (par ordre de rendement)

1. **`resultGates.ts` déclaratif** : chaque gate = `{id, trigger, check, disposition:
   'reject-once'|'requires-review'|'reject', vocabulary}`, préprocessing partagé
   appliqué une fois (strip du bloc contrats — corrige 1.2 en gros ; fenêtre de
   négation commune ; une seule lecture manifeste/README au lieu de trois par cycle),
   one-shot par défaut. Un nouvel incident ajoute une ligne, pas une philosophie.
2. **Rétrograder les gates déclenchées par la prose en `requiresReview` → verdict
   LLM** (l'architecture `checkGroundTruth` existe et override déjà le trust). Les
   préfixes durs (`NON_JSON`, `INTERNAL VALIDATION FAILED`) restent des rejets directs.
3. **`outputs: string[]` structuré dans le schéma de plan** ; grammaire lexicale en
   fallback. Côté compilateur : champ `writes: string[]` déclaré à la compilation,
   cross-checké une fois à la promotion — remplace ~150 lignes d'analyse statique.
4. **Un seul merge de manifeste** dans `src/contracts/probeManifest.ts` ; normaliser
   le chemin avant le test d'égalité ; écritures `_meta.json` atomiques (tmp+rename)
   via un unique `mutateMeta()` sur `readMetaChecked`.
5. **`runTask` retourne un handle** `{result: Promise, shutdown()}` ; park-forever et
   `process.exit` remontent dans le shell CLI. Le serveur MCP a déjà payé le prix
   complet de ce défaut ; le prochain intégrateur le repaiera.
6. **Épilogue machine `ATOMA_RUN_STATS {json}`** émis par le runner, préféré par
   `parseRunLog` — retire la classe `/escalat/gi`, la fragilité stdout-as-API et le
   risque d'abort de batch sur texte modèle. La leçon record_probe (« le markdown
   modèle n'est pas une interface parsable ») appliquée à la propre sortie du runner.
7. **✓ Scinder AGENTS.md** : invariants + commandes + pointeurs (~1 500 lignes) /
   `docs/incidents/` append-only, avec test de parité map↔sections. Récupère ~60k
   tokens par session.
8. **Geler un des deux clients viz**, décomposer `gpu-renderer.ts` (shaders / widgets
   / vues sur un petit contexte, `ScrollPane` partagé), remplacer les greps de source
   par des tests de comportement sur un ctx enregistreur.
9. Divers une-définition : `makeBaseClient()` partagé runner/curriculum ;
   `capabilities()` sur `LlmClient` (supportsTools, effortPolicy, servedModel) —
   fait converger trois findings providers ; `parseCliArgs` avec déclaration des
   flags booléens pour supprimer le fork `parseRunnerArgs`.

## 4. Ce qui est remarquablement bien

Culture de mesure exceptionnelle : benchmarks pré-enregistrés avec conditions de
falsification, réfutations de ses propres designs le jour même (hybrid-skills),
rétractations conservées, tests d'incidents vérifiés « échouent sans le fix ».
L'isolation conteneur/egress est argumentée et prouvée aux deux polarités ; le claim
stdout du MCP avant le graphe d'imports est soigné ; `record_probe` (la machine
écrit, le modèle choisit) est la bonne division du travail ; la série des huit rounds
qui dégrade honnêtement son propre headline (4,69× → 2,05×) est rare.

## 5. Trois priorités pour les 10 prochains jours

1. **Corriger les bugs à une ligne d'abord** : forkBranch (1.1), borne pgid (1.4),
   normalisation du chemin manifeste (1.3), garde sur `release()` (1.9),
   réparer/quarantiner le CSV compare (1.6). Rendement maximal, risque nul.
2. **Protocole de refroidissement** : plus de gate mécanique nouvelle en session
   live ; grouper les incidents d'une session, dessiner le contrat une fois contre
   tous, un commit. Appliquer la revue adversariale pré-construction aux mécanismes
   acceptés, pas seulement aux idées rejetées.
3. **Mettre les preuves à l'abri** : sync nocturne hors machine de `atoma.db` +
   `skills/` + `runs/` + archives ; geler le chemin compilation (promotion OFF hors
   familles maintenance) ; rediriger l'effort vers le wedging silencieux.
