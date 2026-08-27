# Revue critique — fenêtre 2026-08-20 → 2026-08-27 (57 commits)

Date : 2026-08-27.
Méthode : lecture de `4459dc0..01ed50c` (57 commits, 372 fichiers, +63 873 /
−4 796), quatre passes parallèles (chaîne i18n `9a25ce4`→`cde6135` ; BYO
provider keys et defaults par tier `e05c7b8` ; chaîne viz/GPU caméra, rails,
timeline cards, overlays ; projets/GitHub/CLI/CI), puis re-vérification
manuelle des findings hauts et moyens dans le code à HEAD `01ed50c`, et
exécution de la suite (`docs:check`, typecheck, lint, tests) dans
l'environnement de revue. Les findings de
[`docs/code-review-2026-08-20.md`](code-review-2026-08-20.md) ne sont pas
re-litigés — leurs fermetures sont consignées dans le Statut de ce document.
Convention : **✓ = lu dans le code actuel**. Les numéros de ligne référencent
HEAD `01ed50c`.

## Vue d'ensemble

La fenêtre livre trois chantiers lourds — l'i18n complète du client (i18next,
12 catalogues, traduction automatisée en CI), les clés provider BYO par
organisation avec defaults de modèle par tier, et une refonte viz (caméra
perspective, timeline cards texturées, overlays DOM veilés) — plus la suite
des fermetures de la revue précédente. Le socle sécurité des nouveautés est
bon : chiffrement des clés org AES-256-GCM avec AAD liant (org, provider,
keyId), jamais de relecture en clair par l'API, rôles et same-origin corrects,
sortie du traducteur LLM incapable d'inventer des clés ou d'échapper du JSON.

Le problème dominant est ailleurs : **HEAD est rouge sur `npm run check`**,
pour deux causes indépendantes introduites par le même commit (`01ed50c`),
donc `npm run build` et `release:check` sont impossibles tels quels. Le reste
se répartit entre des trous de contrat sur le chemin BYO (le « BYO-only »
annoncé n'existe pas, la porte subscription forwarde quand même les clés org),
une lecture de trace HTTP toujours non bornée malgré le commit qui annonçait
fermer la dernière, et deux filets manquants dans le pipeline i18n.

## 1. Haute sévérité

### 1.1 ✓ HEAD ne compile pas : TS2322 dans `gpu-renderer.ts`, introduit par le commit HEAD

`npx tsc -p tsconfig.json --noEmit` échoue à `01ed50c` :
`src/viz/client-gl/gpu-renderer.ts:1643` passe `account: focusRail?.profile`
à `overlayMenuClip`, or `FocusRailChromeLayout.profile` est
`FocusRailRect | null` (`renderer/views/sidebar.ts:61`) et le champ attendu
est `AccountMenuAnchor | undefined` (`renderer/overlay-menu-clip.ts:36`) :
`null` n'est pas assignable. L'appel deux lignes plus haut fait déjà la
conversion correcte (`drawAccountMenu(..., focusRail?.profile ?? undefined)`,
`gpu-renderer.ts:1633`). Conséquence : `npm run typecheck`, `npm run build`
et donc `release:check` sont rouges — le commit a été poussé sans check.
Correctif d'une ligne : `?? undefined` au site de l'appel.

### 1.2 ✓ `docs:check` rouge : `src/viz/AGENTS.md` dépasse son budget

`node scripts/check-agent-docs.mjs` échoue à HEAD : `src/viz/AGENTS.md` est à
502 lignes (comptage du script, séparateur `\n`) pour un budget de 500. Le
fichier était à 499 lignes après `e05c7b8` et passe à 501 avec `01ed50c` —
même commit fautif que 1.1. `npm run check` échoue donc avant même d'atteindre
le typecheck. Le budget existe précisément pour forcer la taille du fichier à
rester un choix ; la fermeture est soit une coupe de deux lignes, soit un
déplacement d'une règle vers l'archive datée.

## 2. Sévérité moyenne

### 2.1 ✓ BYO : un déploiement « BYO-only » ne peut pas exister

Sur le chemin non-subscription, `projectRunEnvironment` exige « exactly one
of ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN » **dans `hostEnv`**
(`src/projects/coordinator.ts:313-322`) avant même de regarder
`input.orgProviderKeys` — alors que le commentaire de
`providerCredentialAvailable` (`coordinator.ts:213-216`) promet que la clé
anthropic de l'org satisfait le sélecteur même sans clé hôte. Cette branche
est inatteignable : un opérateur qui ne configure aucune clé hôte voit chaque
run refusé (`ProjectRunConfigurationError`) pendant que la clé BYO chiffrée
dort dans le store. Le contrat annoncé par `e05c7b8` n'est tenu que si la
plateforme apporte déjà sa propre clé.

### 2.2 ✓ BYO : les clés org sont injectées aussi dans les runs subscription

`injectOrgProviderKeys` s'exécute inconditionnellement
(`coordinator.ts:382`), y compris dans la branche `subscriptionRequested`
dont le commentaire (`:333-335`) et `src/projects/AGENTS.md` posent « NO
credential is forwarded ». Un run `ATOMA_LLM=claude-cli` dans une org qui a
stocké une clé anthropic porte `ANTHROPIC_API_KEY` (celle de l'org) dans
l'env enfant : tout tier épinglé `anthropic:*`/`zai:*` facture la clé org
pendant que le journal enregistre `run.host_subscription` — l'audit ment sur
qui paye. Atténuation vérifiée : `src/core/llmClaudeCli.ts:229` retire
`ANTHROPIC_API_KEY` de l'env du sous-processus `claude`, donc le transport de
base n'est pas détourné ; le mélange de facturation par les pins tierisés,
lui, est réel et non journalisé. Fix au même endroit que 2.1 : borner
l'injection à la branche non-subscription, ou journaliser l'usage de clés org
dans un run subscription.

### 2.3 ✓ BYO : un sélecteur `ollama:*` passe sans aucune vérification

`providerCredentialAvailable` retourne `true` pour ollama
(`coordinator.ts:218-221`) alors que le docstring de `tierModels`
(`:263-271`) promet qu'« a pin without its key is dropped before it can reach
the router and detonate mid-run ». `OLLAMA_BASE_URL` n'est ni dans
`FORWARDED_HOST_ENV` (`:150-169`) ni injecté : un org-admin qui épingle
`ollama:qwen3:8b` en L1 obtient un run qui dépense L2/L3 anthropic puis
détone au premier appel L1 contre `localhost:11434` — et même un hôte AVEC
Ollama sur une URL non standard n'est pas transmis à l'enfant. Minimum :
forwarder `OLLAMA_BASE_URL`, et refuser l'écriture d'un pin ollama quand le
déploiement n'en a pas.

### 2.4 ✓ Une lecture de trace non bornée subsiste — `6a931e3` n'a pas fermé la dernière

`/api/runs/:id` fait `readFileSync(file)` sans plafond
(`src/viz/server.ts:2873`) et le mode delta (`?after=`) fait `JSON.parse` du
document ENTIER à chaque poll (~1/s par client live, `server.ts:2889`). Une
trace n'a pas de cap dans le pipeline (mesuré 1,48 Mo en croissance sur un
run réel) : un run tenant long matérialise un document arbitrairement gros
dans le processus serveur, chaque seconde, multiplié par les onglets.
`summarizeTraceFile` est, lui, borné à 32 Mio fail-soft
(`src/viz/runIndex.ts:48`) — le fix cohérent est le même stat-check avant
lecture sur la route détail.

### 2.5 ✓ L'unicité repo↔projet (`2e6723e`) est sensible à la casse ; GitHub ne l'est pas

`githubOwnerSchema`/`githubRepositoryNameSchema`
(`src/contracts/projects.ts:72-86`) acceptent la casse mixte sans
normalisation ; l'index `projects_org_repository_target_idx`
(`src/projects/store.ts:495-497`) et les pré-checks de création comparent en
BINARY. Deux projets `acme/Site` et `acme/site` sont donc créés tous les
deux, et la collision que le commit voulait déplacer au moment de la création
revient où elle était : après le run et la dépense, en
`GitHubDivergenceError` permanente au premier publish du second. Le code sait
pourtant que GitHub est case-insensitive (`src/github/client.ts:425` compare
en `toLowerCase()`). Normaliser à la création, ou indexer sur `lower(...)`.

### 2.6 ✓ i18n : le commit CI atterrit sur main même quand `check` échoue, et certaines corruptions ne s'auto-réparent jamais

« Verify locale health » et « Commit translated locale files » portent tous
deux `if: always()` (`.github/workflows/ci.yml:84-99`) : un `check` rouge
n'empêche pas le commit — en contradiction avec le commentaire du job
(`ci.yml:41-42`). Le scénario qui rend ce trou permanent : `translate`
accepte `value.length > 0` (`scripts/i18n.mjs:543`) là où `check` exige
`value.trim()` non vide (`i18n.mjs:171`). Une traduction « espace seul » est
écrite, commitée malgré le rouge, puis n'est jamais réparée : ni
`missingKeys` (`i18n.mjs:459-464`) ni `fix-drift` (`i18n.mjs:200`) ne la
voient. Job i18n rouge en permanence jusqu'à réparation manuelle. Le
`if: always()` du commit est un choix post-incident épinglé
(`tests/i18n-pipeline.test.ts:189`) ; c'est l'alignement des deux gardes
(`trim()` côté translate) qui manque.

### 2.7 ✓ i18n : aucun filet serveur pour le drift sémantique

Le seul mécanisme qui blanchit une cible dont la source EN a changé de sens
sans changer de placeholders est `invalidate-staged` dans le pre-commit
husky (`.husky/pre-commit:3`) — or `scripts/husky-install.mjs:12-20` saute
l'installation quand `CI === 'true'` (cas réaliste des sessions d'agent
distantes), et `--no-verify` ou l'éditeur web GitHub le contournent. Le job
CI ne rejoue rien d'équivalent : `fix-drift` ne détecte que le drift de
placeholders et les orphelins. Une édition d'`en.json` hors hook laisse les
douze traductions périmées affichées indéfiniment. Fermeture : rejouer
l'invalidation en CI par diff d'`en.json` entre `HEAD^` et `HEAD`
(fetch-depth 2 le permet déjà).

### 2.8 ✓ Le pre-commit embarque des hunks non stagés dans le commit

`.husky/pre-commit:12-18` : `eslint --fix` s'exécute sur le contenu du
worktree, puis `git add $FILES` stage le fichier ENTIER. Pour un fichier
partiellement stagé (`git add -p`), les hunks volontairement non stagés sont
silencieusement inclus — contrairement au commentaire du hook (« re-stage
exactly what was already staged ») et à la règle racine « Preserve unrelated
dirty-worktree changes ». Même classe, moindre gravité :
`runInvalidateStaged` (`scripts/i18n.mjs:655-657`) écrit les catalogues dans
le worktree puis les stage entiers.

### 2.9 ✓ `adae87e` : le fallback prose crédite encore la livraison sur le chemin hard-reap

L'ordre de `src/cli/burnin.ts:108-118` est
`runnerFailed > completed > harnessReaped` : un goal contenant `✓ build
finished` (echo verbatim possible, `projectGoalSchema` permet les newlines)
dans un run qui pend et se fait hard-reap donne `completed` gagnant sur
`--- hard timeout ---` → `delivered` crédité à `costUsd: 0`. Les runs projet
sont protégés en aval par `verifiedTrace`
(`src/projects/coordinator.ts:900-915`) ; burn-in et benchmark — qui écrivent
les CSV de mesure — restent forgeables. Le reçu stdin conçu le 2026-08-23 est
enregistré non construit ; d'ici là c'est une dette de MESURE à noter dans le
protocole benchmark, pas un bug de livraison.

### 2.10 ✓ La fenêtre Scene Tuning échappe au mécanisme veil/inert/clip des menus (`4ab40b4`/`01ed50c` incomplets)

Le mécanisme couvre les overlays de `DomBridge` (`overlaysInert`,
`DomBridge.tsx:122`) et `OrgModelsForm` (`GpuApp.tsx:859`) — mais
`SceneTuningPanel` (`GpuApp.tsx:865`, DOM `position: fixed; z-index: 8`,
`styles.css:430-432`) ne reçoit ni `inert`, ni `.gpu-overlays-veiled`, ni le
trou `--gpu-chrome-menu-*`. Sa position par défaut est le coin haut-droit
(`SceneTuningPanel.tsx:29-35`), exactement là où s'ancre le menu compte Pixi
(`renderer/views/account-menu.ts:65-90`) : menu peint dessous et incliquable
sous la fenêtre, sliders actifs au-dessus — précisément le mode d'échec que
ces deux commits fermaient.

## 3. Sévérité basse

- **3.1 ✓ BYO — toutes les clés org configurées sont injectées dans chaque
  run**, référencées ou non (`coordinator.ts:233-247`, contredit son propre
  docstring `:266-268`) ; exposition bornée par `CHILD_ENV_ALLOWLIST`
  (`src/tools/sandbox.ts:16`), mais la surface mémoire/`/proc` du runner est
  plus large que nécessaire.
- **3.2 ✓ BYO — l'env enfant peut porter à la fois `ANTHROPIC_AUTH_TOKEN`
  (hôte) et `ANTHROPIC_API_KEY` (org)** (`coordinator.ts:339` puis `:382`) ;
  le SDK tranche pour la clé API (`src/run/auth.ts:67-77`) — résultat correct
  mais non testé ni documenté.
- **3.3 ✓ BYO — aucun test ne prouve le 403 des écritures pour un membre
  non-admin** : la garde existe (`src/viz/server.ts:2121-2126`) mais le seul
  parcours process-level s'exécute en org:owner
  (`tests/viz-auth-gate.test.ts:671-706`) ; c'est la surface la plus sensible
  de la fenêtre.
- **3.4 ✓ BYO — la forme passphrase de la clé maîtresse est un SHA-256 sans
  étirement** (`src/core/secretCrypto.ts:219-237`) : une passphrase
  dictionnairisable protège toutes les clés de toutes les orgs contre une
  fuite du fichier SQLite. Compromis argumenté dans le code ; à dire dans
  `.env.example`.
- **3.5 ✓ Course inter-processus sur `createProject`** : pré-checks SELECT
  puis INSERT (`src/projects/store.ts:529-554`) — deux processus (viz + CLI)
  peuvent produire un 500 opaque au lieu d'un 409 ; l'index tient, pas de
  corruption. Et sur un store porteur d'un doublon préexistant, l'index n'est
  jamais créé (`store.ts:493-504`) : enforcement alors purement applicatif
  (loggué, assumé).
- **3.6 ✓ Plus aucune preuve behaviourale du bundle client en CI** : depuis
  `03de3f7`, la seule garde automatique de la frontière `dist/viz/client` est
  un scan source. Acquis du 2026-08-24 non re-litigé ; un job manuel
  `workflow_dispatch` best-effort serait un filet gratuit.
- **3.7 ✓ Le proxy Vite matche par préfixe** (`vite.config.ts:39-41`) : rien
  de mécanique n'empêche un prochain module racine `api-*.ts` de reproduire
  le 404 que `cae2bfa` a corrigé par renommage. Un test de dix lignes
  (fichiers racine vs préfixes proxiés) suffirait.
- **3.8 ✓ `notificationclick` focus une fenêtre existante sans naviguer vers
  `payload.url`** (`src/viz/public/sw.js:143-161`) : une notification « run
  terminé » cliquée n'amène pas au run quand l'app est déjà ouverte. UX.
- **3.9 ✓ `listOperatorRunIndex` parse `runs/index.json` sans borne**
  (`src/viz/server.ts:1000`) — incohérence de discipline sur le chemin
  opérateur, plus que risque réel.
- **3.10 ✓ i18n — la boucle de retry du push CI ne sait pas sortir d'un
  rebase en conflit** (`ci.yml:100-112`, pas de `git rebase --abort`) : les
  tentatives 2 et 3 échouent mécaniquement, les traductions payées du run
  sont re-dépensées au suivant.
- **3.11 ✓ i18n — le retry « clé rejetée » est sauté quand tout le batch est
  rejeté, y compris un batch de 1** (`scripts/i18n.mjs:556` :
  `< slice.length`), en contradiction avec la doc du fichier (`:31-32`) et
  `src/viz/AGENTS.md`. Conséquence bornée : la clé reste blanche et repart au
  run suivant.
- **3.12 ✓ i18n — angles morts dormants du contrôle de placeholders** : la
  regex (`i18n.mjs:136`) ignore `{{count, number}}` et `$t(...)` — aucune
  valeur EN n'en use à HEAD (754 clés scannées), mais la première introduite
  passerait sous le radar. Et le doc de tête de `check` (`i18n.mjs:14-15`)
  décrit un comportement (clé manquante = problème) que le code ne fait pas.
- **3.13 ✓ Titre d'onglet non localisé** :
  `src/viz/client/index.html:5` (`Atoma — run visualizer`), aucune écriture
  de `document.title` — de la copie produit hors catalogue dans un client
  déclaré entièrement catalogue.
- **3.14 ✓ viz — les rAF de fin de transition ne sont pas gardés contre
  `destroy()`** (`gpu-renderer.ts:1623-1625`, `:3850-3854` : garde
  d'identité `this.snapshot === snapshot` que `destroy()` ne casse pas) :
  fenêtre ≤ 1 frame au démontage/HMR où `renderScene` court sur une
  `Application` détruite. Correctif trivial : `this.snapshot = null` dans
  `destroy()`.
- **3.15 ✓ viz — `AtomaCursor.tsx` viole la frontière fast-refresh** que
  `0d268a7`/`aee4790`/`5e1b0ec` posent (`AtomaCursor.tsx:13` ré-exporte des
  constantes à côté du composant). Préexistant à la fenêtre ; le seul
  consommateur du ré-export est un test qui peut importer
  `pointer-cursor.ts` directement.

## 4. Suite exécutée (environnement de revue, HEAD `01ed50c`)

- `docs:check` : ROUGE (finding 1.2). `typecheck` : ROUGE sur
  `tsconfig.json` (finding 1.1). `lint` : vert.
- Tests : 2 800 verts / 1 rouge / 8 skipped (2 809). L'unique rouge —
  `tests/sandbox-security.test.ts` #7c (reap des petits-enfants
  backgroundés) — échoue à l'identique sur `4459dc0` rejoué dans un worktree
  du même conteneur : artefact de la sémantique de reaping de cet
  environnement d'exécution distant, PAS un fait de la fenêtre. À contrôler
  sur une machine de référence avant release.

## 5. Vérifié sain (sélection, tout ✓ à HEAD)

- **Clés org au repos** : AES-256-GCM, IV 12 o aléatoires, enveloppe
  versionnée à parse strict, implémentation mutualisée avec les tokens GitHub
  (`src/core/secretCrypto.ts:96-160`) ; AAD `atoma:llm-provider-key:v1:…`
  liant (org, provider, keyId) (`src/auth/secretEncryption.ts:66-85`), copie
  cross-org → `null` (testé) ; domaines AAD GitHub↔provider disjoints.
- **Jamais de relecture en clair** : l'API ne sert que
  `{provider, configuredAt}` (`src/auth/store.ts:1610-1620`,
  `server.ts:2129-2137`) ; événements journal `{provider}` seul ; l'échec de
  déchiffrement logge un message générique et le run retombe sans la clé.
- **Écritures BYO** : rôles (lecture ≥ org:viewer, écriture ≥ org:admin,
  `server.ts:2121-2126`), same-origin, corps bornés, 503 explicite sans
  `ATOMA_SECRET_ENCRYPTION_KEY` ; catalogue fermé de sélecteurs
  (`src/core/providerCatalog.ts:144-155`), `claude-cli`/`codex` instockables,
  dégradation en `null` d'un choix retiré ; précédence account > org > host
  testée ; `DEFAULT_PRICES` couvre les familles du catalogue, tags ollama à
  0 $ documentés (`src/core/metrics.ts:43-58`) ; le CLI résout les mêmes
  résolveurs que le serveur (`src/cli/projects.ts:322-336`).
- **i18n** : la sortie modèle ne peut ni inventer de clés ni toucher d'autres
  fichiers (`git add src/viz/client/locales` seul) ; anti-boucle CI double
  (`[skip ci]` + push `GITHUB_TOKEN`) ; clé API jamais loguée ; codex local
  isolé (`--ephemeral … -s read-only`, kill du process group à 10 min) ;
  `escapeValue: false` sain — zéro sink HTML dans `client/` et `client-gl/` ;
  pluriels deux-formes gardés par `pluralKey in catalogs.en` ; l'isolation
  des échecs de locale promise par `286cf2c`/`63bca8a` est TENUE (`ur.json` à
  120/754 clés en est la preuve vivante) ; aucune chaîne UI en dur hors le
  `<title>` (3.13).
- **viz/GPU** : cycle de vie des timeline cards complet (buffers épinglés,
  détachement avant teardown, `destroy()` câblé, closures gardées par
  génération — `renderer/timeline-card-material.ts`) ; caméra perspective
  sans ressource GPU, toutes divisions gardées, rAF/observers nettoyés ;
  transitions de rail sous `prefersReducedMotion()`, tickers purgés, textures
  ping-pong versées dans `ownedTextures` ; revert `7b4baea` sans code mort ;
  parité WGSL/GLSL du champ caustique par source TS unique déroulée dans les
  deux dialectes ; overlays DOM corrects hors Scene Tuning (2.10) ;
  `renderer.gc.enabled = false` et le contexte Pixi unique intacts.
- **Projets/GitHub/CLI** : `1db6028` ne touche que
  `.cursor/environment.json` (environnement Cursor, PAS un postinstall npm —
  le contrat de release est intact) ; budget de run refusé hors 60–7200 s,
  réglable par l'opérateur seul, aucun `timeoutMs` sur les routes HTTP ;
  announcements gated 401/403 + same-origin + corps bornés, `translate.ts`
  fail-closed ; id de run validé `^[A-Za-z0-9_.:-]+$` (pas de traversal) ;
  bornes de publication 30 Mio/fichier vs 50 Mio total avec test de
  dominance ; trailer de commit anti-forge (goal indenté, testé
  `interpret-trailers`) ; web push sans zombies (404/410 prunés), clés VAPID
  générées jamais en dur, payload traité non fiable ; `c256e57` est un outil
  local sans route serveur.

## Statut

Consigné le jour de la revue. Aucun correctif appliqué dans ce commit — la
branche porte le document seul. Ordre de fermeture suggéré : 1.1 + 1.2
(deux lignes, débloquent `check`/`release:check`), puis 2.1 + 2.2 (même
fonction, `projectRunEnvironment`), 2.4 (stat-check 32 Mio), 2.6 (aligner
`trim()`), 2.5 (normalisation de casse), 2.10 (brancher Scene Tuning sur
`overlaysInert`), le reste au fil de l'eau. Conformément à la règle
COOLING-OFF, les mécanismes nouveaux éventuels (reçu stdin de 2.9, rejeu
d'invalidation en CI de 2.7) se conçoivent hors session, contre l'ensemble
des incidents.
