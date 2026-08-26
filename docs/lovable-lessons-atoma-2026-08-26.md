# Ce qu’Atoma doit apprendre de Lovable

> Revue d’architecture interne · Atoma · 26 août 2026

Statut : **revue interne non normative**. Les décisions et contrats ci-dessous
sont des propositions, pas des fonctionnalités acceptées ou implémentées.

Ce dossier part de la migration web de Lovable, puis étudie les articles
susceptibles d’améliorer l’orchestration Molecule → Cell → Tissue, le choix
modèle → tâche et les boucles d’apprentissage.

### Synthèse de l’analyse migration

Conserver Vite + React/Pixi + Node. Investir d’abord dans l’attribution immuable
des runs, l’enveloppe mémoire/performance, le strangler du control plane et un
dogfooding avec voie de récupération indépendante.

| Mesure rapportée par Lovable | Valeur |
|---|---:|
| Code spécifique à Next restant à la fin | 3 % |
| Taux d’erreur pendant leur incident mémoire | 0,1 % → environ 50 % |
| Plugins de build custom dans leur très grande application | 17 |

Ces chiffres sont auto-déclarés. Le framework, l’hébergeur, le runtime et les
refactorings ont changé ensemble. Source :
[article de migration Lovable](https://lovable.dev/blog/how-we-migrated-lovable-dev-away-from-nextjs).

## 1. Décisions proposées

| Sujet | Atoma aujourd’hui | Décision | Priorité |
|---|---|---|---|
| Stack web | Vite compile un SPA React/Pixi ; <code>node:http</code> sert l’API et les assets. | Conserver la stack. Aucun besoin SSR/isomorphe n’est démontré. | Conserver |
| Frontière portable | Les contrats sont bien séparés, mais <code>viz/server.ts</code> compose désormais presque tout le control plane. | Amincir l’adaptateur HTTP et extraire les services par strangler, sans réécriture. | P0 |
| Rollout | Track A puis Track B est déjà documenté ; l’image worker reste mutable. | Affectation sticky au run entier, image par digest, N−1 conservé et attribution dans la trace. | P0 |
| Isolation | Le data plane L1 sait utiliser un conteneur avec egress default-deny. | Préserver l’isolation OS. Ne pas déplacer shell/Puppeteer dans un isolate V8. | Invariant |
| Performance | Le lazy chunk GPU est gardé mécaniquement ; pas encore d’enveloppe de ressources hosted. | Mesurer RSS/heap, cold start, p50/p90/p99, event-loop lag et coût OFF/ON des features. | P0 |
| Agents | <code>AGENTS.md</code>, skills et contrats sont forts ; une contradiction documentaire subsiste sur le coût conteneur. | Métriques déterministes vers zéro ; revue agentique advisory ; revue humaine des surfaces à risque. | P1 |
| Dogfooding | Les plans opérateur et tenant sont distingués, mais le parcours de dogfood n’est pas formalisé. | Même runner et mêmes contrats, avec déploiement/rollback et récupération hors du runtime testé. | P1 |

### Ce qui est déjà juste

- Vite reste un outil de build ; le serveur reste sans framework web.
- La frontière client/serveur et le lazy chunk GPU ont des gardes mécaniques.
- <code>src/contracts</code> porte les formes partagées ; runner et backends
  gardent leurs identités.
- Le Track A dédié est une étape utile et un strict sous-ensemble du Track B
  multi-tenant.

Repères dans le dépôt :
[configuration Vite](../vite.config.ts) et
[garde du bundle viz](../scripts/viz-build.mjs).

### Écarts concrets

- <code>viz/server.ts</code> se décrit encore comme « tiny read-only », mais
  porte auth, projets, GitHub, push, annonces, sentinel et routes mutantes.
- <code>atoma-worker:latest</code> ne donne ni artefact immuable ni rollback
  attribuable.
- La trace ne porte pas encore <code>releaseId</code>,
  <code>workerDigest</code>, backend et cohorte.
- Le chemin live réécrit le JSON entier puis le reparse à chaque delta : c’est
  le premier candidat à charger près de la limite avec plusieurs pollers.
- Le traducteur LLM est construit au premier usage, mais sa fermeture d’imports
  est statique : mesurer avant d’introduire du lazy loading.

Repères dans le dépôt :
[serveur viz](../src/viz/server.ts) et
[exécuteur du worker](../src/tools/containerExecutor.ts).

### Ce qu’il ne faut pas copier

Pas de migration TanStack/Cloudflare par mimétisme ; pas d’override public par
query string ; pas de dual-write naïf des stores ; pas de parse JSON par
requête sans profilage ; pas de juge LLM comme unique gate ; pas de suppression
de la revue humaine pour auth, isolation, trust, stockage, coûts ou contrats
MCP.

## 2. Architecture cible : unifier les contrats, pas les runtimes

Le serving statique, le control plane Node, MCP et le data plane conteneur ont
des contraintes différentes. Leur convergence doit se faire sur les contrats
et l’attribution, pas dans un framework isomorphe unique.

### Entrées et récupération

- **Navigateur** — assets Vite hashés via CDN ou même origine ; PWA et API
  <code>no-store</code> préservées.
- **CLI et MCP** — adaptateurs opérateur vers les mêmes services applicatifs et
  contrats.
- **Recovery externe** — déploiement, rollback, sauvegardes et accès
  break-glass hors d’Atoma.

### Adaptateurs minces

HTTP Node, CLI et MCP traduisent la requête, authentifient, autorisent et
appellent un service. Ils ne possèdent pas la logique de projet, de run ou de
publication.

### Cœur applicatif portable

Auth, organisations, projets, coordination de run, publication, journal et
notifications. Les dépendances sont dirigées vers des ports explicites,
seulement aux frontières réellement volatiles.

- **Persistance** — store relationnel ; migrations
  expand → backfill → verify → contract.
- **Artefacts** — journal live borné + curseur ; trace terminale scellée comme
  archive immuable.
- **Planification** — lease/queue et affectation sticky de tout le run à une
  release.
- **Observabilité** — erreurs, tails, mémoire, coûts et attribution runtime dans
  un même signal.

### Data plane L1 — conteneur par run

Worker immuable par digest, workspace seul monté, egress default-deny,
shell/Puppeteer autorisés uniquement dans cette frontière. Un run ne change
jamais de runner, backend, worker ou génération de contrat en cours
d’exécution.

### Métadonnée minimale de rollout

Persister avec chaque run :

- <code>releaseId</code> ;
- <code>workerDigest</code> ;
- <code>toolBackend</code> ;
- la génération de schéma/contrat ;
- <code>cohortAssignment</code>.

Sans cela, on peut revenir en arrière, mais pas expliquer précisément ce qui a
servi la requête.

## 3. Plan de migration

### P0 — rendre le rollout mesurable et réversible

1. Écrire deux ADR courts : protocole de migration/rollout et artefacts
   immuables/rollback.
2. Remplacer le concept de tag mutable par un digest de worker, conserver N−1
   et attribuer chaque run à son runtime exact.
3. Définir une affectation persistante par org/projet/run ; override réservé au
   harness ou à un admin signé.
4. Réaliser un drill N → N+1 → N avec un run en vol et des écritures, pas
   seulement un redéploiement à vide.

### P0 — établir l’enveloppe de ressources

1. Mesurer cold/warm RSS, heap initial/pic/retenu, event-loop lag, TTFB
   p50/p90/p99 et taux d’erreur.
2. Premier test : trace proche du plafond, plusieurs pollers index/delta,
   mesure RSS, CPU, p95 et lag de boucle.
3. Si l’amplification est confirmée, servir le live depuis un journal
   append-only/cursor et une projection d’index légère ; conserver le JSON
   terminal comme archive.
4. Faire un census OFF/ON des imports et features : auth, GitHub, push,
   sentinel, traducteur LLM, client GPU.
5. Mesurer bundle téléchargé, initialisation GPU, mémoire et startup du worker,
   cleanup et contention store/lease.
6. Écrire des stop conditions à partir du baseline. Une faible erreur
   inexpliquée est un arrêt de rollout, pas une dette.

### P1 — étrangler le serveur, parcours par parcours

1. Commencer par un seul groupe cohérent — par exemple
   Projects → Runs → publication — et extraire ses handlers vers des services
   testables.
2. Conserver <code>node:http</code> comme premier adaptateur ; aucun framework
   n’est requis pour créer la couture.
3. Piloter la migration par un compteur déterministe vers zéro ; petits lots ;
   règle mécanique d’import, revue agentique seulement advisory.
4. Pour les données persistées : un writer, compatibilité N/N−1 et migration
   expand/contract ; jamais deux stores écrits naïvement.

### P2 — dogfood puis canary

1. Créer un projet opérateur canonique utilisant le même runner, les mêmes
   workers et les mêmes contrats que les tenants.
2. Sortir les changements comme artefacts de la release suivante ; jamais
   d’auto-modification in-place de la génération courante.
3. Interne → instance dédiée → une cohorte d’organisations → 100 %, avec une
   seule dimension externe en montée à la fois.
4. Retirer l’ancien chemin seulement après zéro référence statique, zéro
   exécution observée et un soak défini.

### P3 — décider du runtime seulement si les données l’exigent

- Si Node + CDN + workers conteneurisés tient les objectifs, ne rien migrer.
- Sinon, comparer une seule dimension à la fois sur le même workload. Le
  control plane et le data plane peuvent évoluer séparément.

Repères dans le dépôt :
[trajectoire SaaS](saas-architecture.md) et
[backends d’outils](../src/run/toolBackend.ts).

### Critère de succès

Le runtime servi est attribuable, le rollback N−1 est testé avec écritures, la
marge mémoire et les tails sont visibles, et l’ancien chemin possède un critère
de suppression — avant toute décision de framework.

## 4. Radar orchestration LLM

La priorité est désormais d’améliorer le système trois tiers : quel modèle pour
quelle tâche, comment router, budgéter, coordonner, apprendre et valider.

### Ordre de lecture recommandé

1. Sélection modèle → tâche.
2. Routage multi-provider.
3. Coût et fan-out agentique.
4. Feedback de production.
5. Validation multi-agent.

L’infrastructure générale vient après.

### Caveat de sélection

Seuls les articles marqués « Déjà analysé » ont été ouverts. Pour tous les
autres, les thèmes et questions restent des hypothèses déduites uniquement des
titres, pas des conclusions.

### P0 — orchestration des LLM

À confronter directement à Molecule → Cell → Tissue, au sélecteur de modèles, à
<code>superviseLoop</code>, aux budgets et aux preuves de validation.

| Article | Cible Atoma | Thème ou angle supposé | Question à vérifier pour Atoma |
|---|---|---|---|
| [The model picker is a dead end](https://lovable.dev/blog/the-model-picker-is-a-dead-end) — **déjà analysé** | L2/L3 · modèle → tâche | Indépendance et sélection des modèles | Analyse disponible : faire évoluer le gradient fixe rang → modèle vers une politique mesurée par rôle et trajectoire. |
| [Routing Billions of Tokens per Minute](https://lovable.dev/blog/routing-billions-of-tokens-per-minute) | Core · routage provider | Routage LLM et passage à l’échelle | Quels contrats de routage et modes de dégradation pourraient renforcer le sélecteur multi-provider d’Atoma ? |
| [$85,000 in tokens later: What I learned from scaling agentic coding at Lovable](https://lovable.dev/blog/85000-in-tokens-later-scaling-agentic-coding-at-lovable) | Supervision · budget et fan-out | Coûts et orchestration agentique | Quelles pratiques de budget, parallélisme et revue résistent à une utilisation agentique intensive ? |
| [We Gave Our Agent a Vent Tool](https://lovable.dev/blog/we-gave-our-agent-a-vent-tool) — **déjà analysé** | Skills/Sentinel · feedback | Boucle de rétroaction agentique | Analyse disponible : capter un signal interne de friction sans lui donner le pouvoir de modifier le système. |
| [How we run swarms of AI hacking agents against ourselves in a game of capture the flag](https://lovable.dev/blog/how-we-run-swarms-of-ai-hacking-agents-against-ourselves) | Validation · preuve multi-agent | Sécurité et évaluation multi-agent | Comment organiser une preuve adversariale vérifiable et distinguer les vulnérabilités réelles du bruit ? |

### P1 — capacités qui soutiennent les agents

Permissions des outils, connecteurs, gouvernance et visualisation des sorties :
importants, mais au service du protocole d’orchestration.

| Article | Cible Atoma | Thème ou angle supposé | Question à vérifier pour Atoma |
|---|---|---|---|
| [How Lovable secures connected data in production apps](https://lovable.dev/blog/how-lovable-secures-connected-data) | L1/MCP · permissions et isolation | Données connectées et sécurité production | Quelle frontière credentials, permissions et isolation serait pertinente pour MCP et les futurs connecteurs ? |
| [How we made Lovable apps work with the rest of your stack](https://lovable.dev/blog/how-we-made-lovable-apps-work-with-the-rest-of-your-stack) | MCP/GitHub · connecteurs | Connecteurs et intégrations | Quel modèle de connecteurs et de contrats pourrait informer les frontières MCP, OAuth et GitHub ? |
| [How Lovable approaches governance, permissions, and security for non-technical teams](https://lovable.dev/blog/security-for-non-technical-teams) | Auth/Projects · politiques | Gouvernance et contrôle d’accès | Quels concepts sont transposables aux organisations, rôles et surfaces administratives d’Atoma ? |
| [Anthropic Sonnet 3.7 Broke our Diff Viewer](https://lovable.dev/blog/anthropic-sonnet-3-7-lovable-diff-viewer) | Viz · sorties volumineuses | Performance UI face aux sorties LLM | Quels garde-fous protègent une interface lorsque traces, diffs ou artefacts deviennent très volumineux ? |

### P2 — plateforme, déploiement et incidents

À conserver dans la file, sans les laisser détourner l’analyse du mécanisme
distinctif d’Atoma.

| Article | Cible Atoma | Thème ou angle supposé | Question à vérifier pour Atoma |
|---|---|---|---|
| [A Bug Hunt in Our Kubernetes Cluster](https://lovable.dev/blog/hunting-networking-bugs-in-kubernetes) | Workers · réseau conteneur | Infrastructure et diagnostic d’incident | Quelle méthode d’enquête serait réutilisable pour les workers, le réseau conteneur et les erreurs sporadiques ? |
| [How we migrated lovable.dev away from Next.js and turned it into another Lovable app](https://lovable.dev/blog/how-we-migrated-lovable-dev-away-from-nextjs) — **déjà analysé** | Viz/control plane · rollout | Migration et déploiement progressif | Déjà analysé : les trois premières sections traduisent les enseignements retenus pour Atoma. |
| [From Python to Go](https://lovable.dev/blog/from-python-to-go) | Control plane · runtime | Migration de runtime | Quels critères justifient réellement un changement de runtime plutôt qu’une optimisation ciblée ? |
| [Building apps using TanStack Start](https://lovable.dev/blog/building-apps-using-tanstack-start) | Viz/SaaS · architecture web | Architecture web et runtime | Quels choix SSR/runtime sont utiles à une future surface hébergée, sans présupposer leur adoption ? |
| [Lovable outages on Friday November 28](https://lovable.dev/blog/outage-nov-28) | Ops/Sentinel · récupération | Fiabilité et postmortem | Quel format de postmortem, de détection et de récupération serait utile aux opérations Atoma ? |
| [Incident Jan 2: Github outage](https://lovable.dev/blog/incident-github-outage) | GitHub · dépendance externe | Résilience d’une dépendance externe | Quels fallbacks, reprises et files d’attente faut-il prévoir autour du sous-système GitHub ? |

Source consultée le 26 août 2026 :
[index du blog Lovable](https://lovable.dev/blog).

Ont été exclus : levées de fonds, partenariats, annonces de modèles, lancements
produit, études clients, tutoriels génériques et sujets marketing.

## 5. Analyse 1 — « The model picker is a dead end »

*Orchestration LLM.*

Source :
[article Lovable](https://lovable.dev/blog/the-model-picker-is-a-dead-end).

Lovable ne remplace pas un menu par un modèle gagnant. Son idée est qu’un
control plane choisisse un profil complet — modèle, instructions, outils et
contexte — à partir du travail réel et de son évolution.

### Verdict pour Atoma

Atoma possède déjà le bon noyau : son système trois tiers est un control plane.
Son angle mort est le couplage presque fixe <code>rang → modèle</code>. Il faut
décorréler l’autorité Molecule/Cell/Tissue du choix du modèle, mais seulement
après avoir mesuré quand la topologie directe, supervisée ou décomposée gagne
réellement.

| Mesure déclarée par Lovable | Valeur |
|---|---:|
| Gain de vitesse dans un bake-off Lovable | 15 % |
| Réduction du nombre de tours | 40 % |
| Gain de score | +2–3 % |

Ces chiffres sont auto-déclarés : l’article ne donne ni modèles comparés, ni
corpus, ni taille d’échantillon, ni variance. Ils indiquent une direction, pas
une preuve transposable.

### Ce que l’article dit réellement

- **Le profil compte plus que le nom.** Un modèle doit être évalué avec les
  instructions, outils, descriptions d’outils, contexte et résumés qui lui
  conviennent.
- **Le control plane observe la trajectoire.** Intention, difficulté émergente,
  progrès et boucles déterminent quel modèle reçoit chaque partie du travail.
- **La récupération doit être causale.** Une panne provider, un mauvais
  contexte, un plan faible, un outil confus et un modèle inadapté demandent des
  réponses différentes.
- **Le produit fini est le benchmark.** Correction exécutable, coût total,
  durée, tours et récupération comptent davantage qu’une réponse isolée ou un
  leaderboard.

### Confrontation avec Atoma aujourd’hui

| Sujet | Atoma aujourd’hui | Lecture de l’article | Verdict |
|---|---|---|---|
| Picker utilisateur | Settings expose Haiku/Sonnet/Opus pour chaque tier, persiste le choix par principal et l’injecte dans ses runs. | L’utilisateur devrait exprimer une intention — Auto, Économique, Rapide, Qualité, Privé/local — pas choisir l’implémentation interne. | Écart direct |
| Unité de routage | L1=Haiku, L2=Sonnet, L3=Opus par défaut ; les pins valent pour tout le rang. | Choisir un profil selon le rôle, la tâche et la trajectoire, pas seulement le rang. | Écart P0 |
| Rôles couplés sur L1 | Le pin L1 sert à la fois l’exécution outillée, les prefilters et les validateurs. | Mesurer et router séparément classification, exécution et jugement ; éviter qu’un changement L1 modifie trois expériences à la fois. | Écart P0 |
| Prompts, outils, contexte | Ils sont adaptés par type d’atome, skill et capability bucket, mais pas versionnés par modèle. | La vraie unité candidate est modèle + adaptateur + outils + politique de contexte. | Partiel |
| Progression et boucles | <code>superviseLoop</code> suit plan/result, répétitions de raisons et marqueurs, puis branche ou fallback. | Ajouter une classe d’échec et des signaux de progression ; ne pas déduire automatiquement « modèle trop faible ». | Bonne couture |
| Provider vs modèle | <code>RoutingLlmClient</code> applique un prefix provider statique ; les transports font des retries bornés. | Séparer disponibilité provider et inadéquation de raisonnement ; changer uniquement la dimension en panne. | Écart P1 |
| Évaluation | Scorers exécutables, coût de trajectoire, traces par rôle et benchmarks préenregistrés. | C’est plus solide que les chiffres non documentés de l’article ; il manque surtout un corpus plus large par classe de tâche. | Force |
| Promotion d’un modèle | Sans pin L3, Atoma peut résoudre automatiquement le dernier Opus visible au démarrage. | Un modèle candidat doit gagner son trafic hors ligne puis entrer dans une <code>policyVersion</code> figée. | Risque P0 |
| Coût du changement | Le fallback transmet une trace bornée et les phases transmettent surtout <code>previousStepSummary</code> + outputs déclarés. | Avant tout switch, externaliser un handoff typé et compter cache perdu, contexte reconstruit et travail répété. | Écart P0 |
| Apprentissage du routage | Le trust est porté par le type d’atome, sans dimension modèle, rôle, classe de tâche ou version de profil. | Apprendre d’abord hors ligne sur le tuple tâche × rôle × profil ; ne pas polluer les compteurs de trust produit. | Écart P1 |

#### La couture technique existe déjà

<code>toLlmRequest</code> accepte déjà un override de modèle par appel, et
<code>LlmCompletionRequest</code> porte déjà le rôle. Une policy peut donc être
introduite au-dessus du client unique sans dupliquer les transports ni casser
la taxonomie.

### Le signal le plus important vient des propres benchmarks d’Atoma

Avant de choisir dynamiquement un modèle à chaque niveau, Atoma doit déterminer
si les trois niveaux sont nécessaires pour la tâche. Sur deux familles de
maintenance, la décomposition a ajouté du coût et parfois perdu la vérité
globale entre les phases.

#### Résultats historiques pertinents — correction et coût total

| Round et tâche | Agent direct | Atoma trois tiers | Lecture |
|---|---|---|---|
| R9 · maintenance | Sonnet 3/3 correct · moyenne $0.3012 | 6/6 correct · moyenne $0.3101 | Correction à parité ; aucun break-even mesuré sur six runs. |
| R10 · maintenance simple | Haiku 6/6 correct · moyenne $0.1032 | 6/7 correct · moyenne $0.2628 | Le gradient fixe coûte 2,55× et obtient un résultat inférieur. |
| R12 · maintenance plus couplée | Haiku 6/6 correct · moyenne $0.2495 | 5/7 correct · moyenne $0.4881 | Le contrôle direct garde le contexte ; deux handoffs Atoma sous-mettent à jour la documentation. |

Sources : rapports ROUND9, ROUND10 et ROUND12. Petits échantillons et même
famille générale ; les CSV bruts ont été archivés hors du dépôt lors du reset.
Ces résultats justifient une nouvelle expérience, pas une suppression immédiate
des tiers.

### Architecture cible : rang stable, policy de modèle séparée

- **Entrées de policy** — rôle d’appel, rang, capability bucket, outils,
  obligations de preuve, budget, état de trajectoire et classe d’échec.
- **<code>ExecutionProfile</code> versionné** — modèle exact, provider,
  adaptateur de prompt, politique de contexte, outils exposés, limites et
  paramètres.
- **Trajectoire sticky** — un profil reste stable pendant la sous-tâche ; au
  plus un switch causal à une frontière où l’état peut être reconstruit.

Les pins <code>ATOMA_MODEL_L1/L2/L3</code> restent les valeurs par défaut sûres,
les overrides opérateur et le mécanisme de reproductibilité. La policy ne
remplace pas la taxonomie : seul Molecule conserve les outils, Cell supervise
et Tissue décompose.

### Matrice de récupération causale

| Échec observé | Changer | Ne pas changer par réflexe |
|---|---|---|
| Surcharge ou timeout provider | Endpoint réellement équivalent, après retry borné | Modèle, prompt et plan |
| Contexte incomplet ou périmé | Capsule de contexte et faits attestés | Provider |
| Outil mal compris | Description, outils exposés ou coaching | Puissance du modèle en premier |
| Plan bloqué avec preuve de non-progrès | Replan ou profil alternatif au checkpoint | Modèle au milieu d’un tool loop |
| Capability mismatch | Nouveau profil pour une nouvelle tentative bornée | Cinq modèles en parallèle |
| Juge contredit le scorer mécanique | Calibrage du juge et inspection humaine | Artefact correct |

### Ordre d’expérimentation recommandé

1. Mesurer l’oracle direct / supervisé / décomposé sur un corpus scoré par
   famille de tâche.
2. Geler les modèles admis en production dans une <code>policyVersion</code> ;
   aucun « dernier Opus » automatique.
3. Comparer des profils complets hors ligne, rôle par rôle, une variable à la
   fois et plusieurs répétitions.
4. Renforcer le handoff avec objectif, contraintes ouvertes, digests,
   observations, erreurs, preuves et budget restant.
5. Tracer <code>selectionReason</code>, <code>adapterVersion</code>,
   <code>failureClass</code>, coût du switch et regret observé avant tout
   routage actif.
6. Commencer en shadow, puis canary sur une seule classe de tâche ; garder les
   pins comme kill switch.

Repères dans le dépôt :
[modèles](../src/core/models.ts),
[<code>superviseLoop</code>](../src/core/supervisor.ts),
[trace LLM](../src/viz/recordingLlm.ts) et
[Round 12](../benchmark/ROUND12.md).

### Ce qu’il ne faut pas importer de Lovable

Pas de model roulette, pas de bandit en ligne sans volume, pas de score lexical
de complexité, pas de switch au milieu d’un tool loop, pas de modèle qui
choisit puis juge sa propre sélection, pas de prompts entiers forkés par
modèle, et pas d’entraînement maison avant un contrat stable et un volume qui
justifie son coût.

## 6. Analyse 2 — « We Gave Our Agent a Vent Tool »

*Feedback de production et apprentissage.*

Source :
[article Lovable](https://lovable.dev/blog/we-gave-our-agent-a-vent-tool).

Lovable décrit deux boucles distinctes : réinjecter les solutions déjà
découvertes et faire remonter les limites que l’agent ne peut pas résoudre.
Pour Atoma, la seconde est intéressante précisément si elle reste un signal —
jamais une preuve ni un pouvoir d’auto-modification.

### Verdict pour Atoma

Ajouter, à terme, une <code>frictionClaim</code> interne, structurée, bornée et
reliée aux événements de trace. Ne pas ajouter un outil Slack libre. Le modèle
témoigne de son blocage ; le runtime atteste les faits ; l’analyse hors ligne
regroupe ; un humain autorise toute connaissance, tout correctif ou changement
produit.

| Mesure déclarée par Lovable | Valeur |
|---|---:|
| Stuck rate, première LSO | −5 % |
| Publish rate | +2 % |
| Vents jugés actionnables | environ 20 % |
| Faux positifs des auto-PR | environ 50 % |

Lovable ne publie ni taille d’échantillon, ni période, ni intervalles de
confiance, et ne précise pas si les variations sont absolues ou relatives. Le
billet mentionne aussi environ dix correctifs mergés par jour et une spirale de
43 vents.

### Les deux boucles décrites — à ne pas fusionner

| Boucle | Mécanisme Lovable | Atoma aujourd’hui | Écart utile |
|---|---|---|---|
| LSO · connaissance résolue | Détecter les blocages, clusteriser les trajectoires résolues, proposer description + connaissance, revue humaine, récupération puis dropout aléatoire. | Task skills et event-recovery skills apprennent, matchent, injectent, gagnent du crédit puis peuvent être compilés. | Mesurer la contribution causale de chaque skill, sa fraîcheur et sa portée par profil de modèle. |
| Vent · lacune non résolue | Le modèle principal envoie un rapport libre et sa trajectoire ; un debug agent trie, enquête et peut proposer une PR. | Sentinel observe mécaniquement en live ; le rapport de friction agrège les traces hors ligne. Aucun signal de première personne dédié. | Capter l’hypothèse de l’agent sans contourner les preuves, l’isolation ni la revue humaine. |

### Ce que l’article dit réellement

- **Un juge détecte le blocage.** Demandes répétées, plaintes et abandon sont
  jugés par LLM, sur un corpus annoté puis revalidé lors des changements de
  prompt ou de modèle.
- **La connaissance est curée.** Lovable refuse la réécriture automatique
  continue : elle produit du bruit. Les entrées sont proposées depuis des
  clusters puis revues par un humain.
- **L’injection reste étroite.** Classifier, selector et synthesizer choisissent
  un contexte ciblé ; aucun contexte n’est injecté sans correspondance.
- **La boucle reste humaine.** Toute entrée de connaissance et toute auto-PR
  sont revues. Lovable dit ne pas encore avoir les eval gates et rollouts
  statistiques pour la fermer.

### Atoma possède déjà les briques — mais pas la même couture

| Brique | Force actuelle | Limite révélée par l’article | Lecture |
|---|---|---|---|
| <code>superviseLoop</code> + result gates | Plan, validation, exécution et preuve restent dans un protocole unique ; les probes mécaniques peuvent contredire le modèle. | Le protocole ne conserve pas explicitement la classe de friction que l’acteur pense avoir rencontrée. | Point d’insertion |
| Détection du stuck | Un run projet reçoit aujourd’hui un objectif, pas une conversation utilisateur multi-tour avec plaintes et abandon. | Le juge conversationnel de Lovable n’est donc pas transposable tel quel ; il faudrait juger la trajectoire du run sur un corpus annoté. | Différence produit |
| Event-recovery skills | Une classe d’échec connue peut être injectée à coût LLM nul et créditée après récupération. | Les doublons sémantiques, la fraîcheur et l’effet causal par skill ne sont pas encore solidement résolus. | LSO partielle |
| Sentinel | Règles pures, bornées, dédupliquées, sans LLM et sans pouvoir ; une finding ne décide jamais seule. | Il rate les boucles dont la forme se répète tandis que les arguments et erreurs changent. | Complément, pas remplacement |
| Rapport de friction | Lecture hors ligne des traces, signatures cross-run, recency et distinction des pseudo-récurrences. | Il voit les échecs exécutés, pas la perception du contexte manquant ou d’une capacité non supportée. | Base de triage |
| Analyste post-run | Le prototype read-only sait classifier des défauts et mechanism candidates sans modifier le système. | Il reste hors produit, sans case management complet ni boucle autonome vers un correctif. | Triage expérimental |
| Journal plateforme | Vocabulaire fermé, sévérité et audience exhaustives ; push sans prose model-authored. | Un vent brut ne peut pas entrer dans <code>detail</code> sans violer le contrat de sécurité et de confidentialité. | Frontière à préserver |

### Un vent est un témoignage, pas une attestation

Le modèle peut repérer une permission absente ou une API incohérente avant un
détecteur mécanique ; il peut aussi rationaliser son propre mauvais plan. Son
rapport doit donc être conservé à côté des faits host-owned — erreurs d’outil,
escalations, absence de progrès, verdicts et probes — sans pouvoir déclarer
lui-même ces faits vrais.

### Architecture proposée : un canal interne en cinq séparations

1. **Candidat typé.** Molecule, Cell ou Tissue peut joindre un rapport optionnel
   à son résultat ; ce n’est pas un Element et aucun appel externe n’est exposé
   au modèle.
2. **Attestation host-owned.** Le runtime ajoute les ids d’événements,
   compteurs, verdicts, profil d’exécution et fingerprint ; le modèle ne peut
   pas les fabriquer.
3. **Trace, pas push.** Le rapport reste dans le corpus du run avec sa politique
   d’accès et de rétention. Le journal ne reçoit qu’une catégorie et des
   agrégats sûrs.
4. **Cluster hors ligne.** Déduplication, comparaison aux frictions et event
   skills, puis regroupement cross-run ; aucune mutation du run qui a signalé
   le problème.
5. **Disposition humaine.** Skill candidate, bug outil, incident plateforme ou
   capacité non supportée sont quatre files différentes, chacune avec ses
   propres gates.

### Contrat candidat — minimal et borné

> <code>FrictionClaim</code> est un design, pas une implémentation.

- <code>suspectedClass</code> :
  <code>knowledge_gap</code>, <code>tool_or_permission_gap</code>,
  <code>unsupported_capability</code>, <code>platform_incident</code> ou
  <code>unknown</code>.
- <code>actorRank · phase · impact · confidence · toolName?</code> : hypothèse
  structurée déclarée par l’acteur.
- <code>evidenceEventIds · attempts · lastVerdict · executionProfile</code> :
  champs ajoutés et vérifiés par l’hôte.
- <code>fingerprint · occurredAt · schemaVersion</code> : déduplication,
  attribution et évolution du contrat.
- <code>note?</code> : annexe strictement bornée, redacted et interne ; jamais
  copiée dans le journal ou une notification.

La taxonomie doit rester petite. Une catégorie inconnue vaut mieux qu’une
fausse précision ; les classes sont évaluées sur corpus annoté avant de devenir
des contrats de routage.

### Une disposition dépend des preuves, pas du rapport seul

| Évidence disponible | Disposition permise | Disposition interdite |
|---|---|---|
| Rapport seul | Conserver pour analyse et échantillonnage humain. | Modifier un skill, ouvrir une PR ou alerter un tenant. |
| Rapport + erreur/escalation/probe cohérente | Augmenter la priorité de triage ; rattacher la trajectoire complète. | Considérer la cause racine comme prouvée. |
| Même cluster sur plusieurs runs ou deux batches | Ouvrir une enquête et corréler version, modèle, outil et host. | Créer le jour même une heuristique Sentinel spécifique. |
| Récupération reproductible déjà observée | Proposer un event skill avec provenance et revue. | Compiler automatiquement la prose ou toute la trace. |
| Cause reproduite + patch + probes/tests | Proposer une PR dans un worktree/sandbox isolé, puis revue humaine. | Merge, rollout ou changement de trust autonome. |

### Renforcer la boucle Skills avec l’expérience LSO

| Ajout | Pourquoi | Garde-fou |
|---|---|---|
| Provenance vers trajectoire et preuve | Savoir quelle récupération réelle justifie chaque instruction. | Ne jamais apprendre une simple rationalisation ou une erreur d’environnement. |
| Portée modèle + adaptateur + runtime | Lovable observe que les frictions changent avec la famille et la date de cutoff du modèle. | Revalider lors d’un changement de profil ; ne pas contaminer le trust de l’atome. |
| Expiration et revue de fraîcheur | Leur première base a été polluée par des solutions devenues fausses. | Quarantaine avant suppression ; historique conservé et rollback possible. |
| Cluster sémantique avant proposition | Atoma a déjà mesuré des paires de skills quasi jumelles ; les réécritures fréquentes créent du bruit. | Le clustering propose, l’humain tranche ; pas de merge lexical automatique. |
| Holdout causal par entrée | Mesurer si le skill améliore réellement succès, coût ou boucles. | Jamais sur savoir de sécurité ; préenregistrer, borner et commencer hors ligne/shadow. |

### Les erreurs Lovable à ne pas reproduire

- **Spirale de 43 vents.** Un rapport maximum par fingerprint et par run,
  cooldown par acteur, quota global, déduplication host-owned et aucun
  mécanisme de rétractation conversationnelle.
- **Environ 50 % de fausses PR.** Le debug agent ne reçoit aucun privilège
  production. Patch isolé, tests et probes déterministes, revue humaine, canary
  puis rollback.
- **Connaissance périmée.** Version, provenance, dernière validation et statut
  de quarantaine. Une baisse de score ne supprime jamais silencieusement
  l’historique.
- **Rapport libre vers Slack.** Aucun code, secret, PII ou contenu client brut
  ne traverse le journal ou le push. Catégories et compteurs agrégés seulement.
- **Pic pris pour un incident.** Le volume de rapports est un signal secondaire
  à corréler avec erreurs, latence, versions et hosts ; il ne devient jamais la
  source de vérité live.
- **Infrastructure prématurée.** À l’échelle actuelle d’Atoma, commencer avec
  replay hors ligne et triage opérateur ; pas de
  classifier-selector-synthesizer online avant preuve de volume.

### Ordre d’expérimentation recommandé

1. Rejouer les traces existantes et annoter : friction actionnable, technique
   récupérable, environnement, faux signal ou capacité non supportée.
2. Mesurer ce que Sentinel, friction et event skills détectent déjà ; le
   nouveau signal doit prouver un gain marginal.
3. Définir le schéma dans <code>src/contracts</code>, trace-only et désactivé
   par défaut ; aucun Element, Slack, journal ou auto-PR.
4. Lancer en shadow avec limites par fingerprint/run et revue exhaustive ;
   mesurer précision, rappel, duplications, contenu sensible, coût et latence.
5. Ajouter le triage par disposition et une boucle de retour
   accepted/rejected ; garder le debug agent advisory et isolé.
6. Seulement ensuite tester la fraîcheur et le holdout de skills non critiques,
   avec rollout progressif et kill switch.

#### Critères d’arrêt

Arrêter ou revoir l’expérience si le signal ne trouve pas de classes ratées par
les lecteurs mécaniques, s’il divulgue du contenu sensible, s’il crée des
doublons/spirales, si le triage actionnable reste trop faible, ou si le succès
scoré ne s’améliore pas à coût total égal.

Repères dans le dépôt :
[règles Sentinel](../src/sentinel/rules.ts),
[rapport de friction](../src/viz/friction.ts),
[event skills](../src/skills/events.ts),
[cycle de vie des skills](../src/skills/lifecycle.ts) et
[incident sur l’angle mort de Sentinel](incidents/sentinel-blind-spot-2026-08-23.md).

### Décision recommandée aujourd’hui

Concevoir et mesurer le contrat, sans l’implémenter dans la foulée de cet
article. Le rapport Sentinel documente déjà un angle mort sur une seule
trajectoire et le contrat COOLING-OFF exige plusieurs runs sains et cassés
avant une nouvelle détection. Le premier livrable sûr est donc un corpus annoté
et un protocole d’expérience, pas une nouvelle règle live.
