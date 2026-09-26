# Revue critique — fenêtre 2026-09-24 → 2026-09-25 (31 commits)

Date : 2026-09-25.
Référence examinée : `149f1416d78bee852f02d8f80dd105f34416dba7` (HEAD local ;
`origin/main` est à `b5e4dc3`, déployé en production le 2026-09-25 à 17:52 UTC ;
le seul commit non poussé, `149f141`, ne touche que le README).
Fenêtre : `923bbab..149f141`, 31 commits (dont six commits de traduction du bot
et un merge), 139 fichiers, +7 863 / −653 ; hors catalogues traduits, 66
fichiers source, +2 767 / −415.

La précédente revue générale est celle du
[24 septembre](code-review-2026-09-24.md), qui examinait `923bbab`. Ses cinq
findings ont été corrigés dans `159ab36` ; cette revue vérifie ces fermetures
(section 6) avant d'examiner le reste de la fenêtre.

Méthode : lecture intégrale du diff source hors catalogues traduits, puis sept
relectures indépendantes par domaine (fermetures du 24/09 ; checklist et
critères approuvés ; héritage du seed et preuves d'exécution ; reruns,
destinations et réparation GitHub ; lecteurs MCP, pins et événements skills ;
viz, `validate_html` et analyste ; vérité de la documentation). Chaque piste
retenue ici a été vérifiée par l'auteur de la revue, par lecture des sites et,
lorsque c'est indiqué, par une reproduction qu'il a rejouée. Les pistes non
confirmées ne figurent pas dans ce rapport. C'est une revue orientée risques de la totalité de la fenêtre, pas
une attestation de release.

Convention : **✓ = lu dans le code à cette référence ; reproduit = expérience
locale rejouée, décrite dans l'[annexe de preuves](incidents/code-review-2026-09-25-evidence.md)**.
Les lignes mentionnées sont celles de `149f141`. Aucun correctif n'est appliqué
par cette revue.

## Vue d'ensemble

La fenêtre est courte mais dense : la fermeture des findings du 24 septembre,
puis quatre fonctionnalités — critères d'acceptation approuvés avant le
lancement et checklist rédigée, héritage du seed et ré-ensemencement à
l'approfondissement, reruns de comparaison sur d'autres modèles, diagnostics
MCP complets et paginés — et plusieurs correctifs ciblés (réparation de
publication GitHub, pins de tiers enregistrés, propriétaire et exécutant des
événements skills, viewport de `validate_html`, refus de quota de l'analyste,
guidage des runs incomplets).

Les nouvelles fonctionnalités sont conservatrices dans leur principe : lignes
immuables par trigger, digests re-vérifiés à chaque passage, schémas stricts
aux portes, refus explicites plutôt que réparations silencieuses. Les défauts
confirmés relèvent pourtant de la même classe que ceux du 24 septembre : **des
contrats corrects localement mais incompatibles entre couches**. Un schéma de
requête sert aussi à relire une ligne persistée (1.1). Le journal
d'attestation ne distingue plus le travailleur du superviseur (1.4). Un fait
que l'outil rapporte n'atteint pas le contrat de preuve (1.6). La grammaire
humaine affaiblit silencieusement ce que la personne a écrit (1.5).

La fermeture `159ab36` tient pour trois findings sur cinq. Les deux autres ne
sont fermés que pour le scénario exact reproduit le 24 septembre, pas pour la
classe : « travail acquis » y est réduit à « résultat landed », et « appel en
cours » à « POST encore connecté » (1.2, 1.3).

**Bilan : un finding HIGH et six MEDIUM, tous reproduits ; quatorze LOW ;
deux inexactitudes documentaires MEDIUM et dix LOW.** Le HIGH est déjà en
production et latent : il se déclenche au premier retrait d'un modèle du
catalogue, qui est une opération de maintenance ordinaire.

## 1. Bugs confirmés, par gravité

### 1.1 ✓ HIGH — Un modèle retiré du catalogue rend illisible toute ligne de rerun qui le nomme, et avec elle le projet

**Sites :** `src/contracts/projects.ts:365` ; `src/contracts/tierModels.ts:79-87` ;
`src/core/providerCatalog.ts:257-262,288-294` ; `src/projects/store.ts:571,757-763`.
**Introduction :** `4899e4f`.

`projectRunSchema.modelOverrides` réutilise `runTierModelsSchema`, le schéma de
la *requête* de rerun. Son raffinement `isAccountTierSelection` exige, pour un
sélecteur `api:`, que le modèle figure dans le `LLM_PROVIDER_CATALOG` courant,
et pour un `sub:`, dans la liste de la famille d'abonnement. Or `runFromRow`
relit chaque ligne `project_runs` avec `projectRunSchema`. La valeur est donc
validée contre le catalogue **à chaque lecture**, pas seulement à l'admission.

Le code pose lui-même la règle inverse : « Persistence validates spelling, not a
time-varying account entitlement » (`providerCatalog.ts:291`), et les pins de
compte l'appliquent (`src/auth/store.ts:1726-1746` : « a retired model id must
degrade to the default, never break the account page or a run launch »). La
ligne ne peut pas non plus être réparée par le produit : le trigger
`project_runs_rerun_immutable` interdit toute mise à jour de
`model_overrides_json`.

**Reproduit** avec les vrais coordinateur, store, service et plan de rétention ;
seul le retrait du modèle du catalogue est simulé à l'exécution. Après le
retrait :

- `getProjectRun` et `listProjectRuns` lèvent une `ZodError` ; GET
  `/api/projects/:id/runs` et MCP `atoma_project_runs` répondent donc en erreur ;
- `previousSeedRun` lève, et **chaque run ordinaire suivant du projet** est
  enregistré `failed` avec le texte Zod comme erreur ;
- `retentionPlan` lève dès qu'un run du projet devient candidat : la rétention
  hors ligne s'arrête pour toutes les organisations.

**Conséquence :** un membre ordinaire crée un rerun ; l'opérateur retire plus
tard un modèle obsolète du catalogue (ou de `CHATGPT_SUBSCRIPTION_MODELS`, qui
alimente `api:openai` et `sub:openai`). Le projet devient inutilisable, sans
réparation possible autrement qu'en SQL avec suppression du trigger. Le code
est en production depuis `4899e4f`.

**Fermeture proposée :** relire et persister avec un schéma d'orthographe seule
(un sélecteur bien formé) ; garder le contrôle de catalogue et d'autorité sur
le schéma de requête et au lancement, comme pour les pins de compte. Avant le
prochain retrait de modèle, vérifier en production si des lignes
`model_overrides_json` existent déjà.

**Régression utile :** créer un rerun, retirer son modèle du catalogue, puis
lister les runs, lancer un run ordinaire du projet et exécuter
`retentionPlan`. `tests/project-rerun.test.ts` n'emploie que des modèles
encore au catalogue.

### 1.2 ✓ MEDIUM — Le travail fini est encore perdu à la deadline hors de la branche `landed` (1.1 du 24/09, fermeture partielle)

**Sites :** `src/run/depth.ts:177-205,220,230-232` ; `src/run/runner.ts:1203-1250` ;
`src/atoms/L2Atom.ts:1864-1870` ; `src/atoms/L3Atom.ts:1093-1099`.
**Changements concernés :** `159ab36` (finalisation bornée réservée aux résultats
landed), `705987f` (plancher vide du profil build, donc un appel de validation
à chaque acceptation racine).

La fermeture a donné au résultat *landed* une finalisation bornée (deadline
+ 45 s). Tout le reste demeure sur l'horloge d'exécution :

```ts
const landed = Boolean(result.unfinishedPhases?.length);
if (!landed || !timedOut) attemptCtx.signal.throwIfAborted();
const acceptanceCtx = landed ? { ...attemptCtx, signal: AbortSignal.any([landingSignal(ctx.deadlineAt), …]) } : attemptCtx;
…
if (!landed || !acceptanceCtx.signal.aborted) throw error;  // puis ctx.signal.throwIfAborted() → TimeoutError
```

- **(a) Résultat complet.** Toutes les phases ont réussi ; si la deadline tombe
  pendant les gates, la sonde ou l'appel de validation racine, `runDepthTask`
  rejette et le runner enregistre `failed`. Dans la reproduction, le verdict
  approuvait.
- **(b) Passe de remédiation coupée.** Une remédiation s'ouvre dès qu'il reste
  plus de 60 s (`outOfPhaseBudget`, plancher d'une *phase*, pas d'une passe).
  Si la deadline coupe cette passe avant sa première phase acceptée, le
  dispatch rejette (`dispatch.ts:103-109`). Le premier résultat, complet et
  refusé, est perdu alors qu'il aurait dû atterrir en `partial`.
- **(c) Synthèse `llm-synthesize`.** Sur des sous-résultats complets, la synthèse
  reste sur `ctx.signal`. Sur des sous-résultats landed, elle n'a que la fenêtre
  partagée de 45 s, n'est pas bornée par `withinSignal` et n'a pas de repli :
  son échec fait rejeter `execute`, et le run échoue.

**Reproduit** (cas a et b) : même minutage, un résultat landed est conservé en
refus partiel, un résultat complet est rejeté. Un résultat complet refusé avec
**90 s** restantes finit `failed` ; le même avec **50 s** restantes atterrit en
`partial`. Plus de temps donne un pire résultat. Le cas (c) est ✓ lu.

**Conséquence :** comme pour le 1.1 initial, les fichiers restent sur disque,
mais le run est `failed` : `previousSeedRun` l'ignore, rien n'est publié, et la
tâche MCP échoue. Cela contredit `src/run/AGENTS.md:104-117` (« a refusal is
handed BACK ONCE … and LANDS on the second — it does not fail ») et le README
(« Finished work is never thrown away »).

**Fermeture proposée :** définir une seule fois la phase « finaliser du travail
acquis », quelle que soit la cause de l'expiration. Même borne absolue, même
`markRefused` à l'expiration (un travail non vérifié n'est jamais livré), pour
un résultat complet, un résultat refusé dont la remédiation est coupée, et une
synthèse (repli sur la concaténation plutôt qu'un rejet). C'est la section 2.A
du 24 septembre, à traiter en une seule conception revue, conformément à la
règle de refroidissement.

**Régression utile :** deadline pendant l'acceptation d'un résultat complet ;
remédiation coupée avant sa première phase ; synthèse landed qui expire. Les
tests de `depth-routing` ne rendent que des résultats landed, et ceux de
`depth-runner` coupent pendant une phase.

### 1.3 ✓ MEDIUM — Deux chemins d'éviction ignorent encore un appel MCP en cours (1.4 du 24/09, fermeture partielle)

**Sites :** `src/mcp/http.ts:163-179,261-269,278-289` ; contrats
`src/mcp/AGENTS.md:63-64,181-187` et `src/mcp/eventStore.ts:1-16`.
**Changement concerné :** `159ab36`.

La fermeture n'épingle une session que pendant un **POST encore connecté**. Deux
situations légitimes y échappent :

- **(a) Reprise après coupure.** Le contrat du dépôt promet qu'« a client cut
  mid-call reconnects with `Last-Event-ID` and receives the frames it missed,
  the response included ». À la coupure, le POST émet `close` et quitte
  `activePosts`. La reprise arrive en GET, que l'hôte traite comme un flux
  autonome qui n'épingle rien. Trente minutes plus tard, le balayeur supprime
  la session : le flux rejoué se termine vide, une seconde reprise reçoit
  404, et le magasin de tâches de la session disparaît avec elle.
- **(b) Plafond par caller.** `reclaim` évince la session du caller dont
  `lastSeenMs` est le plus ancien. Or `lastSeenMs` n'est mis à jour qu'au
  début et à la fin d'une requête : la session qui porte un appel long est
  justement la plus « ancienne ». Sur l'hôte loopback non gated, tous les
  clients locaux partagent la clé `operator` (`src/mcp/identity.ts:44`), donc
  un seul plafond de 8.

**Reproduit sur HTTP réel avec le SDK installé :**
- (a) appel suspendu, flux POST coupé après son événement d'amorçage, reprise
  par GET ; après 31 minutes, `sessions=0`, flux rejoué vide, puis 404 ;
- (b) plafond fixé à 2 ; la troisième initialisation du même caller évince la
  session occupée, dont l'appel reçoit `data: ` vide, tandis que la session
  inactive répond encore 200.

**Conséquence :** un `atoma_run_start` synchrone d'une heure perd sa réponse
après une coupure Wi-Fi ou une mise en veille, ou dès que le même caller ouvre
d'autres sessions. Le run continue, mais le client ne reçoit jamais son
résultat.

**Fermeture proposée :** un seul prédicat « appel en cours », partagé par le
balayeur et par `reclaim`. Un GET dont le `Last-Event-ID` correspond au flux
d'une requête (`getStreamIdForEventId`) compte comme la requête elle-même. Une
session qui porte un appel n'est jamais la victime de `reclaim` ; si toutes
les places du caller portent des appels, il reçoit 503, comme pour les
réservations. Le plafond de 3 h reste la borne.

### 1.4 ✓ MEDIUM — Les sondes des superviseurs sont attestées comme preuves de l'enfant et évincent ses observations

**Sites :** `src/core/attestation.ts:88` ; `src/contracts/attestation.ts:176` ;
`src/atoms/L1Atom.ts:482-488` ; `src/atoms/verdict.ts:770-783` ; appels de
sonde qui passent par le même exécuteur : `src/atoms/groundTruth.ts:228,259,299,332,756,788`
et `src/atoms/resultGates.ts:119` ; `src/core/supervisor.ts:323-326`.
**Introduction :** `705987f`.

Depuis `705987f`, l'exécuteur d'attestation enregistre `fetch_url`, `run_shell`,
`read_file` et `start_node_server`, plus seulement `validate_html`. Mais la
sonde de vérité terrain et les gates du superviseur L2 exécutent leurs lectures
**à travers le même `ctx.tools` de branche** que l'enfant. Chacune est donc
attestée sous la branche et la tentative de l'enfant, puis rendue au
validateur suivant comme `read_file (attempt=1, branch=<enfant>) …`. Rien n'y
signale le superviseur, et le prompt ajoute : « Do not demand a repeated probe
merely because the child summary omitted evidence present here ».

Le budget est un seul suffixe de 24 000 caractères. Avant ce commit, les huit
dernières lignes navigateur étaient toujours montrées. Désormais, les lectures
du superviseur (jusqu'à six fichiers revendiqués par validation, plus le
manifeste et les gates) poussent hors du prompt l'observation navigateur de
l'enfant.

**Reproduit** par le vrai chemin L2 (`handleDirect` → `forkBranch` →
`superviseLoop` → L1 → `validateResult`), LLM simulé ; l'enfant ne fait lui-même
aucune lecture :
- après deux rejets, 12 des 15 lignes de preuve sont des lectures du
  superviseur ;
- après trois rejets, 13 des 16 le sont, « 6 earlier observations omitted »,
  et la ligne `validate_html … FILTERED=8` de l'enfant a disparu.

**Conséquence :** le signal « smoke qui pilote son propre état, zéro
interaction exécutée », cas du 22 août, disparaît justement quand une phase
est rejetée plusieurs fois. Les lectures du superviseur se présentent comme
des preuves apportées par l'enfant. L'acceptation racine est désormais
toujours un appel de validation (plancher vide) ; elle ne voit que les
derniers 24 000 caractères de preuves concaténés sur toutes les phases, et les
lignes navigateur des premières phases UI y sont couramment évincées. Les
mêmes sondes alimentent la couverture de la checklist (2.4).

**Fermeture proposée :** attester avec l'acteur (travailleur ou superviseur), ne
rendre au validateur que les actions du travailleur, et budgéter par type
d'observation au lieu d'un suffixe unique. `proof-attestation` appelle L1 et
`llmVerdict` directement, sans `forkBranch` ni sonde L2 intercalée : il teste
un autre cas.

### 1.5 ✓ MEDIUM — La grammaire des critères approuvés affaiblit un statut d'erreur en « tout 2xx », qui se lit ensuite OBSERVED

**Sites :** `src/contracts/acceptanceChecklist.ts:113,128-160,218,256-259` ;
`src/viz/client-gl/GpuApp.tsx:639-653`.
**Introduction :** `a772b3e`.

`LINE_METHOD` ne capture le statut que s'il suit **immédiatement** le chemin.
`POST /api/notes returns 400 for invalid input`, `GET /api/notes/:id — 404 for an
unknown id`, `GET /api/notes/:id (404)` et même `GET /api/notes/:id → 404`, la
notation que l'hôte affiche lui-même (`describeCheck`), sont acceptés sans
erreur. Ils deviennent des checks sans statut, c'est-à-dire « tout 2xx ». La
console ne montre que les erreurs d'analyse, jamais la lecture retenue.

**Reproduit :** avec les seules observations du chemin nominal (POST → 201,
GET → 200), l'acceptateur lit, sous l'en-tête « approved by the user … no model
wrote them » :

```text
- [OBSERVED] c1 returns 400 for invalid input (POST /api/notes → 2xx)
- [OBSERVED] c2 404 for an unknown id (GET /api/notes/:id → 2xx)
```

L'événement d'acceptation de la timeline les compte parmi les checks HTTP
observés (`src/viz/client-gl/renderer/copy.ts:253-262`). C'est exactement la classe
que l'incident du jour note pour les items rédigés (« an item naming error
statuses must never read covered on a 2xx »,
`docs/incidents/checklist-first-runs-2026-09-25.md:134-136`), reproduite ici
sans aucun modèle, sur une liste que la personne croit stricte.

**Fermeture proposée :** refuser une ligne HTTP dont le texte contient un statut
non capturé, ou le capturer quel que soit le séparateur. Afficher avant le
lancement la lecture de chaque ligne, telle que le planificateur la recevra.
La grammaire documentée reste la référence ; il s'agit de ne plus affaiblir
silencieusement une saisie naturelle.

### 1.6 ✓ MEDIUM — Le viewport de `validate_html` n'atteint pas les preuves lues par les validateurs

**Sites :** `src/contracts/attestation.ts:68-83,232-268,271-291` ;
`src/tools/builtin.ts:2062,2092` ; `src/atoms/L1Atom.ts:488` ; sondes du
superviseur toujours à 800 × 600 : `src/atoms/groundTruth.ts:259,332`.
**Introduction :** `07d80a4`.

Le commit donne à l'appelant le choix de la largeur et rapporte ce fait dans le
résultat brut. Mais `browserObservationSchema` n'a pas de champ viewport,
`parseBrowserObservation` ne le copie pas, et `renderObservation`, « the one-line
rendering the supervisor shows a validator », ne l'affiche pas.

**Reproduit :** la ligne de preuve d'un appel à 320 px et celle d'un appel à
800 px sont identiques octet pour octet.

**Conséquence :** un L1 qui valide à 800 px et écrit « pas de débordement à
320/375/768 » reste impossible à réfuter pour le L2 et pour l'acceptation
racine. C'est la seconde moitié de l'incident que le commit cite (`0e89e0ce` :
« the L2 verdict and the root acceptance both claimed mobile widths the trace
never contained »). Le README annonce pourtant des vérifications « laid out at
the viewport widths the goal asks for ».

L'incident du jour renvoie explicitement cette question des verdicts à la
passe de conception (`docs/incidents/checklist-first-runs-2026-09-25.md:102-106,139-140`) ;
ce finding ne la tranche pas. Il constate que la donnée sans laquelle cette
conception est impossible n'atteint pas les attestations : `07d80a4` rapporte
la taille à l'appelant, mais pas au seul journal qu'un validateur, ou une
future règle mécanique, puisse lire.

**Fermeture proposée :** porter le viewport dans l'observation attestée, dans sa
ligne rendue et dans l'identité web du manifeste, au sein de la passe de
conception déjà prévue, avec 1.4, dans le même contrat de preuve.

### 1.7 ✓ MEDIUM (hors fenêtre) — Un approfondissement ferme définitivement la recherche documentaire du projet

**Sites :** `src/run/runner.ts:847,932,939,1127` ; `src/run/toolBackend.ts:52` ;
`src/tools/projectRetrieval.ts:150` ; `src/projects/retrievalHaystackLaunch.ts:23-27`.
**Introduction :** antérieure à la fenêtre (`3bf5687`, en production depuis
`2102979`), relevée en relisant le redémarrage que `10f866f` modifie.

Le redémarrage d'approfondissement appelle `backend.drain()`. Celui-ci ferme la
liaison de recherche du projet (`retrieval.close()` → `service.dispose()`), ce
qui arme le verrou `closed = true` du lanceur Haystack. `makeBackend` réenveloppe
ensuite le nouveau backend avec **la même** liaison, et `prepareRetrieval`,
mémoïsé, ne se rejoue pas.

**Reproduit** avec les vrais `withProjectRetrievalBackend` et `localToolBackend` :
`search_project_docs` répond `ok` à la première tentative et `denied` après le
redémarrage.

**Conséquence :** la tentative profonde d'un run de projet travaille sans les
documents du projet, alors que `10f866f` avait précisément pour objet qu'un run
approfondi garde ce dont il hérite. Aucun test ne traverse un drain avec une
recherche active.

## 2. Défauts mineurs (LOW)

Tous sont confirmés ; « reproduit » renvoie à l'annexe (section 8), « ✓ lu » à
une lecture des sites cités.

| # | Défaut | Sites | Commit | Statut |
|---|---|---|---|---|
| 2.1 | Un rerun rédige sa propre checklist quand celle de l'original est irrécupérable : trace supprimée par la rétention (premier run d'un projet), origine antérieure aux checklists, rédaction vide ou échouée. Contredit la décision 3 et la table des refus de `docs/comparison-reruns-2026-09-25.md` (« unreadable while a draft is needed → 409 »). `origin.bytesExpiredAt` n'est jamais consulté. | `src/projects/rerun.ts:37-51,97-118` ; `src/run/runner.ts:899-912` | `4899e4f` | reproduit |
| 2.2 | Des chemins absolus de l'hôte atteignent tout rôle de l'organisation. `atoma_run_trace section=log` (niveau viewer) sert le journal brut du runner (`workspace seeded from …`, `workspace: …`, `skills root: …`, argv npm avec `--seed`). `publication.error` est désormais servi aux viewers et peut contenir « workspace does not exist: <chemin absolu> ». Contredit `commonsForTier` (« any tier below platform gets the basename ») et la projection publique « no host filesystem paths ». | `src/mcp/tools.ts:343` ; `src/mcp/readers.ts:562-567` ; `src/projects/service.ts:115` ; `src/projects/artifacts.ts:212-219,477-508` | `baba214`, `399546f` | reproduit |
| 2.3 | Une liste acceptée par le schéma de l'API peut dépasser la limite de transport de 16 384 octets (champs longs échappés en JSON) ; le refus n'arrive qu'après le passage à `running`, l'écriture du registre des payeurs et la préparation. | `src/contracts/acceptanceChecklist.ts:23-39,96` ; `src/run/acceptanceSpec.ts:30-47` ; `src/projects/coordinator.ts:1436-1438` | `a772b3e` | reproduit |
| 2.4 | La couverture de la checklist compte les regards des superviseurs : la sonde racine de la passe précédente (même `attempt` pendant la remédiation) et les sondes L2 portant `servedBy`. Contredit « the root must not cover a behaviour by looking ». | `src/atoms/rootAcceptance.ts:19-30` ; `src/atoms/groundTruth.ts:228` ; `src/run/depth.ts:153,190,228` | `75d0150`, `705987f` | reproduit |
| 2.5 | Le détecteur d'oscillation de `validate_html` ignore le viewport : un balayage 768 ✓ / 375 ✗ / 320 ✗ fait refuser l'appel suivant à 1024 comme « smoke non-deterministic » avant toute évaluation. Ces refus omettent aussi le viewport, contrairement à « ALWAYS reports the size it used ». | `src/tools/builtin.ts:1855-1882,2706-2737` | `07d80a4` | reproduit |
| 2.6 | L'analyste résident, l'hôte de production, ignore le nouveau `quota-refused` : le run est retiré de la file, compté en échec, sans pause. Chaque run en file consomme une session refusée et tient brièvement le bail machine. Le correctif ne couvre que la CLI et `runAnalystLoop`. Sur le sélecteur de production `sub:openai`, aucune détection n'a lieu (`!codex`). | `src/supervisor/resident.ts:132-142` ; `src/supervisor/analyst.ts:364` | `a4a2c40` | reproduit |
| 2.7 | Le guidage d'un run incomplet promet une continuation pour un rerun partiel (« run this project again to finish it »), alors que le run suivant ne l'ensemence jamais. Même promesse sur la carte d'un run partiel plus ancien. Le client viz ignore `rerunOf`. | `src/viz/client-gl/partial-run.ts:64` ; `renderer/views/runs.ts:1405-1428` ; `renderer/views/projects.ts:171-172` | `ab46c36` × `4899e4f` | reproduit |
| 2.8 | La dérivation des trajectoires traite `direct` comme une injection, alors qu'aucune exécution LLM ne la consomme. `820025b` étend cette erreur aux scripts donneurs : exécutions mal attribuées et exécution rejetée créditée. Deux émetteurs omettent encore l'exécutant (inject d'event skill sur une branche, `demote` de `noteDirectFailure`). Effet observationnel : références de `trajectory-drift` du sentinel et digest de l'analyste. | `src/contracts/trajectory.ts:319-333` ; `src/skills/lifecycle.ts:1453-1482,1552-1560` ; `src/atoms/L2Atom.ts:1302-1310` | `820025b` (base `2e968076`) | reproduit |
| 2.9 | Le filtre du seed retire une entrée shell de harnais dont le stdout porte le port lié, alors que le contrat de lecture rejoue ces entrées sur le code de sortie seul ; un vérificateur compilé perd son ancrage de rejeu. Réparer l'entrée (retirer `stdout`) la garderait. | `src/contracts/probeManifest.ts:522,587,641-649,791-793` | `10f866f` | reproduit |
| 2.10 | `record_probe`, l'outil des preuves shell, n'est pas attesté, alors que les `run_shell` de travail le sont : les validateurs voient les commandes annexes et pas les invocations de preuve. | `src/contracts/attestation.ts:176` | `705987f` | reproduit |
| 2.11 | Le plafond de 3 h supprime toute la session (tâches et résultats compris). Il n'est « configurable » que par option de constructeur : la production ne le fixe pas et aucune variable n'existe. Il est inférieur aux budgets qu'acceptent des outils plateforme (`timeoutMs` opérateur sans maximum, `maxWallMs` de campagne jusqu'à 12 h). | `src/mcp/http.ts:83,280-284` ; `src/viz/server.ts:1293-1310` ; `src/contracts/retrievalCampaign.ts:52` | `159ab36` | ✓ lu |
| 2.12 | `run.finished` attend désormais l'arrêt de la preview en vol : jusqu'à ~120 s d'appels au launcher, en série, avant le journal, la notification push, `resources/updated` et le déclenchement de l'analyste. | `src/viz/server.ts:875-892` | `159ab36` | ✓ lu |
| 2.13 | L'affichage des pins de tiers n'a été ajouté qu'au client MUI gelé (« FROZEN… add nothing »). L'interface produit `client-gl` ne montre ni `tierModels` ni `servedModels`. | `src/viz/client/features/RunsView.tsx:250-270` | `7374572` | ✓ lu |
| 2.14 | Mineurs : `--once` annonce un run restant de moins que la réalité (le run refusé lui-même) ; `page.setViewport` s'exécute avant le `try/finally` qui ferme la page. | `src/cli/analyst.ts:204` ; `src/tools/builtin.ts:1767-1768` | `a4a2c40`, `07d80a4` | ✓ lu |

## 3. Documentation et contrats écrits

Les contrôles `docs:check` passent. Ils ne couvrent cependant ni la prose du
README au-delà de quelques faits dérivés, ni les documents de conception. Les
écarts suivants sont confirmés contre le code :

- **D1 (MEDIUM) — le README annonce un conteneur par défaut.** « Workers build …
  in a container with no network unless egress is explicitly allowed »
  (`README.md:172-173`). En réalité, le backend est local par défaut
  (`src/run/backendMode.ts:19-32`) ; seuls les runs de projet forcent
  `--container` (`src/projects/coordinator.ts:1397`). La commande que le README
  propose, `npm run run:build`, exécute donc les commandes shell écrites par le
  modèle sur l'hôte. `README.md:239-240` dit l'inverse de la ligne 172. Un
  opérateur peut croire confinées des commandes qui ne le sont pas.
- **D2 (MEDIUM) — « Finished work is never thrown away », « The project's next
  run starts from that workspace »** (`README.md:75,108-115`). C'est faux pour un
  projet importé de GitHub : son seed est un instantané de la branche par
  défaut, et les raisons du landing ne voyagent pas. La console et
  `src/projects/AGENTS.md` le disent. En mode pull request, le livrable reste
  sur `atoma/run-<id>` jusqu'à la fusion. C'est faux aussi pour un dispatch
  sans phase acceptée (`dispatch.ts:51-53`) et dans les cas du finding 1.2.
- **D3 (LOW)** — « Any delivered or incomplete project run can be rerun »
  (`README.md:127-128`) : les projets importés sont refusés, les origines au seed
  non enregistré ou expiré aussi, et la console n'offre aucun contrôle (API et
  MCP seulement). « In use on atoma.run » (`README.md:236-237`) n'est étayé par
  aucun artefact pour une fonctionnalité livrée le jour même.
- **D4 (LOW)** — le paragraphe des mesures historiques dit « Twelve controlled
  rounds compared atoma with a single frontier agent » : le round 11 n'a pas de
  bras atoma, et les bras témoins sont Sonnet ou Haiku dans les rounds 9, 10
  et 12. La réécriture a retiré la conclusion défavorable (« cheaper direct
  models matched or outperformed it on the tested maintenance tasks ») et les
  liens vers ROUND11/ROUND12.
- **D5 (LOW)** — une règle, deux maisons : `src/run/AGENTS.md:105-106` (« records
  `partial`, seeds the next run ») n'a pas reçu la réserve des projets importés
  que `159ab36` a ajoutée à `src/projects/AGENTS.md:342-343`.
- **D6 (LOW)** — `src/contracts/AGENTS.md:133-142` annonce « FIVE dispositions »
  au-delà de `MAX_TRACE_BYTES`, « stated here once » : les lecteurs de détail MCP
  en ajoutent une sixième (`src/mcp/readers.ts:565,595`), et d'autres plus
  anciennes ne sont pas listées.
- **D7 (LOW)** — `docs/acceptance-checklist-2026-09-25.md:66-67,91-93` présente
  encore la liste approuvée et immuable comme un travail futur ; elle existe
  depuis `a772b3e`.
- **D8 (LOW)** — `docs/code-reviews.md` : la fenêtre `4459dc0..01ed50c` compte
  169 commits et non 57 ; `027ae42..08fc043` en compte 104 et non 105
  (`git rev-list --count`). Corrigé dans l'index par cette revue, qui y ajoute
  sa propre entrée.
- **D9 (LOW)** — le « configurable 3h hard ceiling » (`src/mcp/AGENTS.md:63-64` et
  section 7 de la revue du 24/09) n'est pas configurable en production (2.11).
- **D10 (LOW)** — trois commentaires affirment encore qu'un run partiel est
  proposé en preview (`src/projects/store.ts:1843`,
  `src/contracts/projects.ts:179-181`, `src/projects/coordinator.ts:1543`) ; le
  service le refuse depuis `159ab36`.
- **D11 (LOW)** — le README renvoie au CHANGELOG « for what changed », qui
  s'arrête à la v0.4.0 du 17 septembre : ni critères, ni runs partiels, ni reruns.
- **D12 (LOW)** — « Recipes are compiled into scripts only when a run continues
  existing work » décrit le défaut : `ATOMA_SKILL_PROMOTE` et
  `--no-promote-skills` le changent (`src/run/runner.ts:327-338`).

Vérifié exact, entre autres : 39 outils `atoma_*` (identique au README et au
`AGENTS.md` racine), douze critères au plus, grammaire unique pour la console,
la CLI et le MCP, liste stockée dans la transaction de réservation, rerun hors
de la lignée du projet, pins enregistrés au lancement, commandes du README
présentes dans `package.json`. Aucun lien cassé dans le README ni dans les 23
documents de la fenêtre.

## 4. Incohérences et limites de conception

### A. « Finaliser du travail acquis » n'est toujours pas un contrat

La section 2.A du 24 septembre demandait de distinguer « exécuter », « finaliser
du travail acquis » et « conserver le reçu ». La fermeture a traité le cas
reproduit, le résultat landed. Les findings 1.2 et 1.3 sont la même omission
vue de deux côtés : le travail acquis ne se réduit pas à `unfinishedPhases`, et
un appel en cours ne se réduit pas à un POST connecté. Une définition
exprimée une fois pour toutes (qu'est-ce qui est acquis, qu'est-ce qui est en
cours) ferait tomber les variantes ensemble, là où des cas ajoutés un à un
les laisseraient ressurgir.

### B. Un schéma de requête n'est pas un schéma de stockage

Les données persistées qui nomment un élément d'un catalogue variable (modèles,
abonnements) doivent être relues sur leur orthographe, et l'autorité
redemandée au lancement. Le code le dit dans un commentaire et l'applique aux
pins de compte, mais rien ne l'impose structurellement. Le finding 1.1 en est
la conséquence directe. Une règle dans `src/contracts/AGENTS.md`, et un test
qui relit chaque ligne persistée après un catalogue modifié, rendraient la
régression visible.

### C. Le journal d'attestation a perdu la notion d'acteur

« Observation de l'hôte » signifiait « ce que l'outil a réellement renvoyé au
travailleur ». En attestant tout ce qui passe par l'exécuteur de branche, le
journal mélange désormais le travail de l'enfant et les regards de ses
superviseurs. D'où 1.4 (contamination et éviction), 2.4 (couverture par
regard) et en partie 2.10. Le viewport (1.6) montre le problème symétrique :
un fait de l'outil qui n'atteint pas l'observation. Ces quatre points relèvent
d'un seul contrat de preuve ; conformément à la règle de refroidissement, ils
devraient être conçus ensemble et livrés en un commit revu.

### D. La couverture « par statut » et les critères qui nomment une erreur

Une vérification HTTP sans statut vaut « tout 2xx ». Pour les listes rédigées
par le modèle, l'incident du jour l'a noté et différé ; la grammaire humaine
la reproduit sans modèle (1.5). Une même passe de conception peut couvrir les
deux sources, sans heuristique nouvelle de contenu : refuser ou capturer, puis
montrer la lecture retenue.

### E. Visibilité des payeurs pour tous les rôles

`7374572` sert à tout rôle de l'organisation le type de payeur par tier (par
exemple `host-subscription`), alors que la docstring de `getRunPayers`
(`src/projects/store.ts:1734-1738`) qualifie encore cette visibilité de
« open product decision ». Ce n'est pas un défaut : c'est une décision à acter
par le propriétaire, ou à retirer.

### F. La promesse de comparaison dépend d'une trace volatile

Un rerun ne compare deux runs sous le même critère que si la liste de
l'origine est récupérable. Or une liste rédigée ne vit que dans la trace, qui
expire après 90 jours. Enregistrer la liste rédigée (ou son absence) dans
`project_run_acceptance` à la fin du run rendrait 2.1 impossible, sans avoir à
lire la trace.

## 5. Ce qui tient bien dans cette fenêtre

- **Trois fermetures solides.** L'admission MCP réserve la place globale et la
  place du caller avant toute allocation ; tous les chemins de sortie libèrent
  une seule fois (corps invalide, première requête autre qu'`initialize`,
  abandon, minuterie de 30 s, `buildServer` qui lève, `close()` pendant
  l'initialisation). Le TTL des tâches projet découle du budget effectif du
  coordinateur, reruns compris. Ouvrir, rejoindre et renouveler une preview
  partagent la même éligibilité, et la fin du run retire les instantanés.
- **L'autorité des reruns.** Il faut au moins `org:member` aux deux portes. Un
  run d'un autre projet ou d'une autre organisation donne le même 404 qu'un
  identifiant inconnu : pas d'oracle. Les modèles du run sont relus sur la
  ligne réservée et résolus au lancement : `sub:` exige la délégation (échec
  fermé), `own:` ne prend que le profil du demandeur, et un `api:` sans
  identifiant est refusé plutôt que de retomber sur un autre niveau. Le
  demandeur de l'origine n'est jamais consulté. Un rerun ne sème, ne publie ni
  ne retient rien.
- **Les critères approuvés.** Schéma strict à chaque porte ; stockage dans la
  transaction de réservation ; trigger d'immuabilité ; digest intégré à
  l'idempotence et revérifié par l'enfant ; refus hors routage en profondeur.
  Une observation HTTP ne peut pas être forgée par du contenu : `servedBy` est
  calculé par `fetch_url` après vérification noyau de la possession du port,
  sans redirection, et la couverture reste limitée à la tentative. La
  rédaction coûte un appel au tier le moins cher, borné, et n'empêche jamais
  le run de partir.
- **Les lecteurs MCP de détail.** Bornes zod sur les paramètres, pagination
  cohérente sur une trace qui grandit (append-only), `snapshot` qui détecte un
  détail modifié entre deux pages. La portée est l'organisation, ou un admin
  plateforme audité. Le catalogue reste compatible : 39 outils, `offset` et
  `limit` conservés.
- **La réparation GitHub.** Le HMAC est vérifié avant toute analyse du webhook.
  Le déplacement d'un projet est un compare-and-set sur l'ancienne
  installation, et ne change jamais d'organisation. Les candidats viennent de
  la même organisation et du même compte ; une installation suspendue n'est
  jamais contournée ; les erreurs ne contiennent ni jeton ni corps de réponse.
- **L'héritage du seed.** `probeEntryProblems` est une extraction pure. Les
  octets sont conservés quand rien n'est retiré. Le ré-ensemencement ne lit
  que le seed résolu au lancement, jamais la tentative abandonnée (archivée
  d'abord). La liste approuvée et les raisons du landing précédent survivent
  à l'approfondissement.
- **Des correctifs qui ferment de vrais défauts.** La troncature de l'épilogue
  supprime un `throw` réel : une raison de landing de plus de 2 000 caractères
  faisait enregistrer `failed`. La validation du viewport refuse au lieu de
  corriger. Le contrat i18n est respecté : les seules modifications humaines
  des catalogues traduits sont les blanchiments du hook husky.

## 6. Fermetures des findings du 24 septembre

| # | Verdict | Justification |
|---|---|---|
| 1.1 landing après deadline | **partiel** | Le chemin landed est corrigé et testé. Restent le résultat complet, la remédiation coupée et la synthèse (finding 1.2). |
| 1.2 plafonds MCP concurrents | **fermé** | Réservation avant allocation et libération unique sur chaque sortie, vérifiées sur HTTP réel. Réserve : `health().initializing` n'est lu nulle part en production, et un 503 par caller incrémente `overflowed`, documenté comme le seul plafond hôte. |
| 1.3 TTL de tâche projet | **fermé** | Préparation (10 min) + délai configuré + 180 s + 60 s, puis la grâce ; même budget pour les reruns et les critères approuvés. Le watcher s'arrête sur tâche absente, annulée ou terminale. |
| 1.4 session avec appel en cours | **partiel** | Un POST connecté est protégé. Restent la reprise par `Last-Event-ID` et l'éviction par plafond (finding 1.3), et les limites du plafond de 3 h (2.11). |
| 1.5 claim de preview après `partial` | **fermé** | Éligibilité commune, instantanés retirés au terminal, génération arrêtée non ressuscitable. Réserve : les runs lancés par `npm run projects -- run` s'exécutent hors du serveur viz et n'atteignent pas son hook ; leurs grants expirent en 5 minutes. |

## 7. Vérification exécutée

Environnement : clone neuf de `149f141` dans WSL2 Debian (`~/dev/atoma-audit-0925`),
Node `v24.20.0` de `.nvmrc`, npm 11.19.0 ; reproductions sur l'hôte Windows
avec le même Node. Aucun burn-in ni run en cours. Aucun appel modèle payant,
aucun conteneur, aucun store utilisateur modifié. Seul accès réseau : `npm ci`,
`npm audit` et la lecture du statut CI par `gh`.

- **`npm ci` : VERT**, 0 vulnérabilité. npm 11.19 signale quatre paquets dont
  les scripts d'installation ne sont pas couverts par `allowScripts`
  (`better-sqlite3`, `esbuild`, `puppeteer`, `tesseract.js`). L'installation
  fonctionne ici (`better-sqlite3` se charge, build et suite passent), mais ce
  réglage est à fixer avant qu'une version de npm n'applique cette politique.
- **Premier passage de `npm run release:check` : ROUGE**, arrêté à `npm run check`.
  `docs:check`, les deux configurations TypeScript et lint passent. Tests :
  **4 447 verts, 9 rouges, 10 ignorés** (350 fichiers : 345 verts, 4 rouges,
  1 ignoré). Ce passage s'est déroulé pendant que les sept relectures
  exécutaient leurs reproductions sur la même machine (« import 642 s »).
- Les neuf échecs sont des délais de démarrage de processus enfants `tsx` :
  `viz-burnin-api` attend 10 s le serveur, `tool-backend-selection` 15 s un
  `spawnSync`, `retrieval-treatment` et `retrieval-benchmark` 15 et 45 s. En
  isolation, `retrieval-benchmark` passe (61/61) et `retrieval-treatment` ne
  garde que son premier test (cache froid). Le serveur viz, démarré à la main
  comme le fait le test, écoute en 2,8 à 3,2 s une fois la machine calme. La
  CI GitHub est verte sur ces fichiers pour `b5e4dc3`.
- **Second passage complet de `npm run release:check`, machine au repos : VERT**
  (rc=0, 7 minutes). `docs:check`, typecheck et lint passent. Tests : **4 456
  verts, 10 ignorés** (349 fichiers verts, 1 ignoré). `npm audit` : 0
  vulnérabilité. Build, smoke MCP compilé (« 25 operator tools, 7 prompts »),
  smoke auth de bout en bout et smokes d'aide des CLI réussis. Le premier
  passage rouge reste consigné ci-dessus ; il n'est pas réécrit.
- **CI GitHub :** `b5e4dc3` vert puis déployé. `ab46c36` était rouge sur
  « Mender credential isolation », corrigé par `6ef9fb2`.
- **Reproductions :** huit scripts rejoués depuis un environnement vierge, et
  les reproductions LOW des relecteurs rejouées par l'auteur ; sorties dans
  l'annexe.
- **Non exécutés :** smoke navigateur, isolation Docker et gVisor, exercices de
  production.

La suite verte ne contredit aucun finding : aucun test n'exerce les
compositions en cause, comme l'indique chaque section.

## 8. Priorités et statut

**P1 :** 1.1 avant tout retrait de modèle du catalogue, avec vérification en
production des lignes de rerun existantes. Puis 1.2 et 1.3, la part non fermée
des P1 et P2 du 24 septembre, à traiter comme une seule définition du travail
acquis et de l'appel en cours.

**P2 :** le contrat de preuve (1.4, 1.6, 2.4, 2.10), conçu une fois et livré en
un commit revu ; la grammaire des critères (1.5) ; la recherche documentaire
après approfondissement (1.7) ; D1, parce qu'il concerne l'isolation.

**P3 :** les autres LOW et la documentation. Les décisions de la section 4.E
(visibilité des payeurs) et 4.F (persistance des listes rédigées) appartiennent
au propriétaire.

Statut : findings ouverts, aucun correctif de code appliqué. Cette revue
ajoute seulement ce rapport, son annexe de preuves et son entrée dans
l'[index des revues](code-reviews.md), dont elle corrige deux comptes de
commits (D8). Les arbitrages déjà documentés restent distingués des défauts ;
aucune nouvelle gate de contenu n'est conçue ici.

## 9. Corrections du 26 septembre

À la demande du propriétaire, les findings ont été corrigés sur la branche
`fix/review-2026-09-25`, conçus ensemble et livrés en commits revus, chacun
avec un test qui traverse le chemin de production en cause. Les sections
précédentes conservent le constat initial.

| Finding | Correction | Commit |
|---|---|---|
| 1.1 | Ligne de rerun relue par orthographe (`storedRunTierModelsSchema`) ; l'offre du modèle est demandée au lancement, qui refuse. | `654c404` |
| 1.2 | Tout travail en main se finalise jusqu'à deadline + 45 s (`finalizationSignal`) ; une remédiation coupée atterrit sur le premier refus ; une synthèse interrompue garde ses sous-résultats (`synthesizeOrKeep`). | `c9d12c7` |
| 1.3 | Un GET qui reprend le flux d'une requête épingle comme le POST ; `reclaim` n'évince jamais une session occupée (503 sinon). | `18a01cc` |
| 1.4, 2.4, 2.10 | Les sondes des superviseurs passent par `baseExecutorOf` ; budget par type (8 lignes navigateur toujours) ; `record_probe` attesté. | `62d17af` |
| 1.5, 2.3 | Statut lu après le chemin sous `404`, `→ 404`, `(404)` ; une ligne HTTP qui nomme un statut ailleurs est refusée ; taille encodée bornée à la porte. | `4e3174a` |
| 1.6, 2.5, 2.14 | Viewport dans l'observation attestée et sa ligne ; clé du détecteur d'oscillation par taille de mise en page ; page fermée si `setViewport` échoue. | `62d17af` |
| 1.7 | Le `drain` d'approfondissement ne détruit plus le service de recherche du run. | `a90c329` |
| 2.1 | Origine dont la liste rédigée est irrécupérable : refus 409 ; origine jugée sans liste : rerun sans liste (`ATOMA_ACCEPTANCE_SOURCE=none`). | `654c404` |
| 2.2 | Journal du runner rédigé sous le tier platform ; message d'inventaire sans chemin. | `289a70f` |
| 2.6, 2.14 | L'analyste résident garde le run en file et fait une pause sur refus de quota ; compte `--once` corrigé. | `3a696fe` |
| 2.7 | L'index des runs et les lignes de projet portent `rerunOf` ; un rerun partiel ne promet pas de continuation. | `2ecf33f` |
| 2.8 | Un `direct` et son `success` ne créditent aucune exécution ; les deux émetteurs nomment l'exécutant. | `b92bf1c` |
| 2.9 | Entrée de harnais réparée (stdout omis), non supprimée, à l'héritage du seed. | `112fbff` |
| 2.11 | Le plafond ferme l'appel bloqué seul ; `ATOMA_MCP_MAX_REQUEST_MS`. | `18a01cc` |
| 2.12 | `run.finished` journalisé avant le retrait de la preview. | `00d8937` |
| 2.13 | La carte de run dépliée du client GL affiche les pins par tier. | `d945421` |
| D1–D11 | README, `AGENTS.md`, document de checklist, commentaires, CHANGELOG. | `3cdc6f9`, `7896595` |

Une revue adverse de ces corrections, avant mise en production, a trouvé un
défaut majeur et six mineurs, corrigés dans la même branche :

| Constat | Correction | Commit |
|---|---|---|
| Grammaire (majeur) : `GET /x 404.`, `:id→404`, `:id(404)` perdaient leur statut ; `201 — et 400 si…` n'en vérifiait qu'un. | Ces formes sont lues ; une ligne qui nomme un second statut est refusée ; nombres, ports et versions ignorés. | `94aec19` |
| Un GET reprenant un appel déjà répondu épinglait sa session jusqu'au plafond. | Épinglage seulement tant que la réponse est due, depuis le début de l'appel d'origine. | `6137036` |
| Rédaction : disposition du launcher manquée, remplacement sans frontière, erreurs de run et de publication non rédigées. | Un module (`src/projects/hostPaths.ts`) pour le lecteur MCP et le service projets. | `1a3770d` |
| Sans deadline, le `TimeoutError` d'un appelant laissait l'acceptation sans borne ; raison fausse d'une synthèse abandonnée. | `TimeoutError` = deadline seulement avec `deadlineAt` ; raison réelle, journalisée. | `5492edf` |
| Carte Runs : un partiel supplanté promettait la continuation ; libellés CHANGELOG, analyste et rerun. | Copie `run.partial.next.superseded`, sans contrôle ; formulations. | `c252885` |

Reste ouvert : **D12** (compilation des recettes), dont le comportement est
modifié en parallèle par un autre chantier. Les décisions
4.E (visibilité des payeurs) et 4.F (persistance des listes rédigées)
appartiennent toujours au propriétaire ; 2.1 est fermé sans 4.F, par refus.
