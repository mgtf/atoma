# Revue critique — fenêtre 2026-08-18 → 2026-08-20 (69 commits)

Date : 2026-08-20.
Méthode : lecture de `c517b8e..HEAD` (69 commits, 199 fichiers, +28 111 / −2 218),
quatre passes parallèles (auth/orgs/GitHub publish `4459dc0` ; série shader du
brand mark ; citation de contexte trace LLM `2b6a14b` + cœur ; release v0.1.4
`5c53074`), puis re-vérification manuelle de chaque finding haut dans le code à
HEAD `4459dc0`. Les findings de
[`docs/code-review-2026-08-18.md`](code-review-2026-08-18.md) ne sont pas
re-litigés. Convention : **✓ = lu dans le code actuel**. Les numéros de ligne
référencent HEAD `4459dc0`.

## Vue d'ensemble

Aucun bug critique de sécurité : le socle auth/OAuth/webhook est soigné
(PKCE S256 partout, states à usage unique liés au cookie de transaction,
sessions/invitations hashées SHA-256, HMAC webhook `timingSafeEqual` + dédup
transactionnelle, tokens AES-256-GCM avec AAD, lecture d'artefacts anti-TOCTOU
`O_NOFOLLOW` + contrôle inode, exclusion `.env`/workflows de la publication).
Les vrais problèmes sont un leak GPU non borné sur le backend produit, des
trous de cycle de vie côté publication GitHub, et une divergence
doctor/production sur `.env`.

## 1. Haute sévérité

### 1.1 ✓ Leak VRAM non borné : ressources du brand mark jamais détruites

`attachAtomaMark` crée 2 `RenderTexture` backdrop
(`src/viz/client-gl/renderer/atoma-mark.ts:448-451`), 2 textures env, 1
`Shader.from(...)` (compilation GLSL + WGSL) et 3 `Geometry`. Or
`renderScene` détruit et reconstruit la scène à **chaque** render
(`gpu-renderer.ts:743`) — tick de molette, hover, poll 1-2 s d'un run live —
et `Mesh.destroy()` de Pixi 8.19 ne fait que nuller `_geometry`/`_shader`
sans les détruire ; les `RenderTexture` ne sont pas des enfants du tout.
Le GC WebGPU étant désactivé par invariant (`renderer.gc.enabled = false`),
rien ne réclame jamais ces ressources : la VRAM croît sans borne. Invisible
pour tous les smokes (pas des display objects, `objectCount` plat ;
`viz:smoke:gc` cible le défaut bind-group, pas les leaks).
Correctif : `destroy()` retourné par `attachAtomaMark` et câblé au teardown,
ou sous-arbre retenu façon far field (motif existant, `gpu-renderer.ts:736-741`).

### 1.2 ✓ `doctor` et `auth` compilés chargent le `.env` du cwd

`applyCheckoutDotenv()` est appelé dans `main()` de doctor
(`src/cli/doctor.ts:712`) et la garde d'entrée d'auth matche
`auth\.(ts|js)$` (`src/cli/auth.ts:219-222`) : les entrypoints **compilés**
(le contrat de release) chargent `.env` alors qu'AGENTS.md, README et
CHANGELOG — écrits dans cette fenêtre — réservent ce comportement aux
lanceurs source. Scénario : env injecté par systemd + `.env` résiduel avec
`ATOMA_VIZ_AUTH=1` → `doctor` dit « auth gate active » pendant que
`viz:serve` (qui ne charge pas `.env`, correctement) démarre **sans gate**.
`tests/load-dotenv.test.ts` épinglait les call sites par grep et consacrait
l'ambiguïté. Corollaire : le `cleanEnv()` de `auth-release-smoke.mjs` était
partiellement défait par ce rechargement (clés supprimées re-remplies depuis
le `.env` développeur).

### 1.3 ✓ HEAD échoue `viz:smoke` (donc `release:check`) : les 404 projets empoisonnent l'état global du client

Découvert en vérifiant 1.1 : `npm run viz:smoke` échoue à `4459dc0` **avant
toute modification** (vérifié par stash). Deux symptômes, une cause :
`4459dc0` ajoute la vue Projects au parcours du smoke non-gated, mais les
routes `/api/projects` et `/api/github/installations` n'existent que derrière
la gate → 404 (diagnostics non vides), et surtout `GpuApp` agrège les erreurs
de TOUTES les queries dans un `data.error` global (`GpuApp.tsx:412-424`) —
la vue Runs rend alors la bannière d'erreur au lieu de sa liste, le wheel
fail-closed sur `scrollMax` ne produit plus aucun rebuild
(`scrollStats renders:0, missed:24`). `release:check` n'a donc pas pu passer
sur ce commit tel quel.

## 2. Sévérité moyenne

### 2.1 ✓ Publication GitHub : pas de récupération après crash, pas de retry

Trois volets liés :

- **Crash = état bloqué à jamais.** Les seules transitions sortantes de
  `running`/`publishing` sont en mémoire (`src/projects/coordinator.ts:394-498`,
  `publisher.ts:270-288`). Si le process viz meurt mi-run ou mi-publication,
  la ligne SQLite reste figée : aucune réconciliation au boot (le lease MCP,
  lui, sait réaper les PGID orphelins). Pire, `publish` court-circuite sur
  `status === 'publishing'` (`publisher.ts:157-161`) : un crash
  mi-publication bloquerait définitivement même un futur retry.
- **Le retry n'existe pas.** `publisher.publish` n'a qu'un appelant, inline
  dans `finish()`. GitHub indisponible à cet instant → publication `failed`
  pour toujours ; la machinerie idempotente (« a retry never creates a second
  repo », reprise 422→lookup, repo vide repeuplable) est du code mort en
  pratique. Le run reste `delivered` (correct) mais le livrable n'atteint
  jamais GitHub.
- **Visibilité non vérifiée sur le chemin 422.** `ensureRepository`
  (`publisher.ts:97-114`) publie dans un dépôt homonyme préexistant sans
  comparer `existing.private` à `repositoryTarget.visibility` : des artefacts
  destinés à un dépôt `private` peuvent atterrir dans un dépôt **public**.

### 2.2 ✓ Fuite inter-organisations : registre, skills, burn-in globaux derrière la gate

Avec `ATOMA_VIZ_AUTH=1`, `/api/registries`, `/api/registry/:id`,
`/api/skills/*` et `/api/burnin` (`src/viz/server.ts:1656-1727`) n'exigent
qu'une session valide, sans scoping org — alors que les runs projets écrivent
dans **le même** store produit (`coordinator.ts:140` fixe `ATOMA_DB_PATH`).
Un `org:viewer` de l'org B lit les atomes créés par l'org A (noms parfois
thématiques par design via `overrideName`, prompts système complets,
historique) et les corps de skills. Les traces sont isolées par org ; le
registre qu'elles mutent ne l'est pas. À minima documenter, idéalement
scoper ou masquer ces routes en mode gated multi-org.

### 2.3 ✓ Bit exécutable des artefacts capturé puis perdu

`src/projects/artifacts.ts:293` enregistre `100755` dans le manifeste et le
re-vérifie à l'upload, mais `src/github/client.ts:677` code en dur
`mode: '100644'` dans `createTree` ; `publisher.ts:247-253` ne transmet que
`{path, content}`. Un script déclaré exécutable est publié non exécutable.

### 2.4 ✓ Replan L3 : `pendingStrategy` désynchronisable du plan servi

`L3Atom.plan()` assigne `this.pendingStrategy` **avant**
`planSchema.parse(pair[1])` (`src/atoms/L3Atom.ts:614-615`). Si le replan
coaché d'`acceptL3RootPlan` renvoie une stratégie valide + un plan malformé,
le catch fail-open ressert le plan **original** mais `execute()` consomme la
stratégie **du replan** (plan pensé pour `reuse` dispatché sous `create` avec
un seed étranger). Le test collision ne couvre que l'échec du `complete()`
entier, pas la fenêtre de parse partiel. Correctif : parser le plan d'abord,
n'assigner qu'après.

### 2.5 ✓ `recordRootPlan` documenté « observer-only » mais peut tuer le run

`runner.ts:682` câble `recordRootPlan` sur `persistDeclaredArtifactManifest`
sans try/catch ; l'appel `L3Atom.ts:288` est nu. Le schéma manifeste borne
les chemins à 1 024 caractères et 1 000 entrées — valeurs rédigées par le
modèle, non bornées côté `planSchema`. Un output déclaré hors borne (ou un
disque plein) fait exploser le run **après** l'appel stratégie Opus payé.
Contraste : `recordingLlm.ts` protège chaque enregistrement
(« Observability must never break the call itself »).

## 3. Basse sévérité

### 3.1 Viz

- ✓ L'erreur d'un appel LLM échoué est écrasée sur la carte timeline quand
  l'appel portait des blocs de contexte (`renderer/copy.ts:220-226` : la
  branche llm-context ne garde pas `!event.error`, contrairement à la branche
  tool). Aggravant préexistant : le détail calcule
  `raw = event.response ?? event.error` et le recorder écrit `response: ''`
  sur erreur — `''` masque l'erreur.
- ✓ Le chunk lazy restauré par `ffe6180` n'a aucun garde de régression : rien
  n'épingle que le chunk d'entrée exclut le renderer. La régression a déjà eu
  lieu une fois.
- ✓ La gate d'arrivée fait 3 renders complets par frame (backdrop + env sur
  le stage entier + stage), y compris en reduced motion sur image figée.
- ✓ `crystalClip` de `scripts/viz-mark-turn.mjs:53-73` a dérivé du layout
  welcome vivant (`views/welcome.ts:74-99`) ; coïncide au viewport 1280×800
  seulement. Outillage de capture uniquement.

### 3.2 Auth / serveur

- ✓ DoS de login trivial : `MAX_ACTIVE_OAUTH_STATES = 500` global, un état
  par `GET /auth/login`, rate limit 20/min/IP → ~25 IP saturent les états
  (TTL 10 min) et tout login rend 429.
- ✓ `completeLogin` : `if (!consumeInvitation()) return null` — better-sqlite3
  **committe** sur `return` (seul `throw` rollback). Chemin aujourd'hui
  inatteignable (relecture `consumed_at IS NULL` dans la même transaction
  `immediate`), mine dormante : remplacer par un `throw`.
- ✓ `cancelProjectRun` (`service.ts:206-216`) ne lie pas le run au projet du
  chemin REST (annulable via n'importe quel projet de la même org) ; la
  réponse HTTP dit `running` après une annulation acceptée.
- ✓ `/auth/github/connect` et `/authorize` : GET à effet de bord sans
  contrôle d'Origin (incohérent avec `/auth/logout` et `/activate`).
- ✓ `appConfigPresent` (`server.ts:321-328`) et `checkGitHubApp` (doctor)
  omettent `ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY_ID` et `ATOMA_GITHUB_API_URL` :
  définis seuls, silencieusement ignorés au lieu du refus « config
  demi-présente » promis.
- ✓ `github_webhook_deliveries` jamais purgé ; `github_connect_states`
  nettoyé seulement lors d'un `createConnectState`.
- ✓ Jeton d'invitation en query string (historique navigateur/proxys) —
  assumé « treat as a password ». `AUTH.resolve` exécuté 3-4× par requête.
- ✓ `projectSchema.repositoryId: githubInstallationIdSchema` — réutilisation
  d'un schéma mal nommé, cosmétique mais piégeux.

### 3.3 Cœur

- ✓ `deadlineAt` calculé ~200 lignes après `AbortSignal.timeout`
  (`runner.ts:445` vs `:658`) : le setup (archivage, store, conteneur,
  `resolveLatestOpus`) creuse l'écart que l'incident 2026-08-16 voulait
  fermer. Sans danger (le signal aborte), mais inexact.
- ✓ Les quatre `SkillLifecycle.complete()` (`lifecycle.ts:474, 619, 737,
  998`) passent le prompt foldé sans `context` ni `actor` : seule famille où
  la promesse de citation de `llmTrace.ts` diverge.
- ✓ Le bras baseline garde `BASELINE_MAX_TOOL_ITERATIONS` non capé par
  `ctx.deadlineAt` (`baseline.ts:126-135`) : asymétrie de budget à corriger
  avant la prochaine campagne mesurée.
- ✓ `ATOMA_RUN_ID` / `ATOMA_ARTIFACT_MANIFEST_PATH` lus ambiants à chaque
  `startTask` sans snapshot : deux `startTask` même process hériteraient du
  même run id.
- ✓ `normalizeDeclaredOutput` neutralise les chemins évadés (`../x` → null) :
  deux phases parallèles déclarant `../shared.txt` ne déclenchent pas de
  collision. Le sandbox bloque l'écriture, dégât nul — pour mémoire.

### 3.4 Release / docs

- ✓ README expédié : « Copy `.env.example` to `.env` » — fichier absent de
  l'archive (`release.yml` ne le copie pas), et le flux `.env` suppose les
  lanceurs source (tsx + `src/`, absents de l'archive).
- ✓ AGENTS.md « Release contract » en retard sur `package.json:22` : omet
  `auth-release-smoke.mjs` et le smoke `auth -- --help`. Sous-déclare.

## 4. Vérifié conforme (pas de finding)

- **Invariants auth AGENTS.md** : join sur `(provider, subject)` seul, jamais
  l'email ; redirections via `ATOMA_VIZ_PUBLIC_ORIGIN` validé au boot, jamais
  le Host ; pas de `.env` dans `src/viz/server.ts` ; repo créé seulement
  après manifeste livré validé ; `/api/runs` gated sans mélange avec le
  corpus opérateur, chemins issus de la DB (pas de traversal).
- **Un seul store produit** : tables auth/projects/github dans le store
  primaire via `openStoreHandle(storeDbPath(), DDL)` ; `runLock` reste
  l'exception documentée.
- **Coût** : `estimateCostUsd` unique ; `servedModel ?? req.model` ;
  `partialUsage` lu sur erreur. Pins/snapshot : `applyTierPins` delete les
  pins absents ; codex-L1 lu après ; `assertTransportHonoursCredentials`
  étendu aux pins de tier, les trois cas testés.
- **Trace contexte (`2b6a14b`)** : schéma purement additif, vieilles traces
  lisibles (`role` absent → `'unknown'`, lecteurs défensifs), dédup par id de
  bloc correcte, pas de re-fold côté transport.
- **Shader final** : toutes les divisions gardées, pas de source de NaN ;
  parité WGSL/GLSL vérifiée terme à terme ; pin GLSL ES 3 correctement scopé
  aux deux programmes à dérivées ; les 2 reverts n'ont laissé aucun code
  mort ; restes R3F entièrement supprimés.
- **Invariants viz** : un seul contexte Pixi ; `prefersReducedMotion()`
  consulté partout ; pins GC/uniform-buffer intacts ; pas d'état GPU dans les
  hot paths React ; i18n EN/FR complet (les deux oublis fermés par `43de6c9`).
- **Release** : archive sans stores/skills/traces/secrets ; checksums dans le
  répertoire de release ; garde tag/version ; doctor quota-free (readonly,
  pre-T4 = fail dur) ; `CHILD_ENV_ALLOWLIST` sans clés auth ; env de run
  projet allowlist-construit (refus des pins cross-provider) ;
  `auth-release-smoke` conduit un vrai login PKCE contre le serveur compilé.
- **T4/skills** : `namespaceOf` → atomId sur le chemin vivant ;
  `dropNamespace` câblé à `remove` et `dedupe` ; MCP 13 outils inchangés,
  caveats in-band épinglés ; `previousStepOutputs` = phase précédente seule,
  testé ; `acceptL3RootPlan` conforme (une passe coachée, throw fail-open,
  pas de coercition `concat`).

## Statut

> **2026-08-20 (soir)** : consigné le jour de la revue, points critiques
> corrigés dans la foulée (`npm run check` 204 fichiers / 2185 tests vert,
> `npm run viz:smoke` vert WebGPU + WebGL) :
>
> - **1.1 fermé** — `attachAtomaMark` retourne un `AtomaMarkHandle`
>   (`retained`/`resume`/`destroy`) ; le renderer retient UN crystal façon far
>   field (`GpuRenderer.retainAtomaMark`, clé = paramètres d'attache), le
>   détruit proprement sur changement de clé et au `destroy()` du renderer ;
>   `MarkShell.destroy()` libère shader, géométries et les 11 buffers une
>   seule fois (les programmes GLSL/WGSL restent cache-partagés par source).
>   Les vues passent par `ctx.retainAtomaMark` (pin dans
>   `viz-launch-profiles.test.ts`, comportement dans `viz-gpu-views.test.ts`).
> - **1.2 fermé** — `applyCheckoutDotenvForSourceEntry` ne charge `.env` que
>   si l'entrypoint est un `.ts` (tsx) ; doctor/auth compilés voient
>   exactement l'env injecté, comme `viz:serve`. Corrige de fait le
>   `cleanEnv()` du smoke auth. Tests dans `load-dotenv.test.ts`.
> - **1.3 fermé** — les queries projets/installations ne s'arment que si le
>   viewer est authentifié (`GpuApp`), la vue Projects non-gated affiche
>   `projects.gateOff` (EN/FR) au lieu de coacher un flux connect qui 404.
>   `viz:smoke` repasse : 24 rebuilds de scroll, 0 manqués, six vues.
> - **2.1 fermé** — `ProjectStore.reconcileInterrupted` (runs
>   `queued`/`running` → `failed`, publications `publishing` → `failed`, via
>   les transitions CAS normales), exposé par le coordinator (refus si des
>   runs sont actifs en mémoire) et appelé au boot du serveur avec un log
>   opérateur. Le chemin 422 d'`ensureRepository` refuse un dépôt homonyme de
>   visibilité différente. Et la surface de retry existe :
>   `POST /api/projects/:id/runs/:runId/publish` (org:member+, same-origin)
>   re-conduit la publication d'un run `delivered` via
>   `coordinator.retryPublication` — la ligne de publication reste la
>   frontière d'idempotence (un seul dépôt, `published` inchangé,
>   `publishing` concurrent laissé tranquille), le manifeste est re-validé
>   octet par octet, et le run est lié au projet du chemin REST.
> - **2.2 fermé (par divulgation)** — le scoping réel exigerait des lignes de
>   registre attribuées aux orgs (projet de schéma, pas un garde de route).
>   La limite est désormais énoncée dans AGENTS.md et le README : derrière la
>   gate, seules les traces sont isolées ; registre/skills/burn-in restent
>   instance-globaux et lisibles par tout membre invité de toute org.
> - **2.3 fermé** — le mode du manifeste voyage jusqu'à l'entrée d'arbre :
>   `GitHubInitialFile.mode` → `publishInitialCommit` → `createTree`
>   (défaut `100644`, autre valeur refusée) ; le publisher transmet
>   `file.mode`.
> - **2.4 fermé** — `L3Atom.plan()` ne committe `pendingStrategy` qu'une fois
>   le plan routé entièrement validé ; un replan coaché qui parse sa
>   stratégie mais pas son plan laisse la paire d'origine intacte (test dans
>   `l3-root-plan-collision.test.ts`).
> - **2.5 fermé** — `persistDeclaredArtifactManifest` borne les `outputs`
>   rédigés par le modèle aux limites du schéma (les entrées valides
>   survivent), et le câblage `recordRootPlan` attrape et logge les échecs
>   d'écriture — observer-only en pratique, pas seulement en commentaire.
>
> Les findings de la section 3 restent ouverts.
