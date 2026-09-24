# Revue critique — fenêtre 2026-08-27 → 2026-09-24 (343 commits)

Date : 2026-09-24.
Référence examinée : `923bbabb7ed01b2dc82f0dbe41018808c3dfed28`.
Fenêtre : `01ed50c..923bbab`, 343 commits, 990 fichiers, +148 466 / −12 451.

**Statut après correction : les cinq findings sont fermés dans le worktree.**
Les changements et leur vérification sont consignés en section 7 ; les
sections précédentes conservent le constat initial.

La précédente revue générale est celle du **27 août**, et non celle du
18 août encore visible dans l'arbre. Elle a été consignée par `2892ac2`,
complétée par `f1c937d`, puis retirée avec celle du 20 août par `4766f8a`.
Lecture de référence : `git show f1c937d:docs/code-review-2026-08-27.md`.
Ses findings déclarés fermés ne sont pas réouverts ici par simple ressemblance.
Les revues A1 et platform-skill-offer sont des revues de conception distinctes.

Méthode : parcours de l'historique et des surfaces modifiées, lecture ciblée
des chemins actuels et de leurs contrats, confrontation aux tests, puis
reproductions locales des cinq findings ci-dessous. Il s'agit d'une revue
orientée risques, **pas d'une lecture exhaustive des 990 fichiers**. L'accent
porte sur les frontières nouvelles : run → acceptation → résultat persistant,
MCP → tâche longue, projet → preview, corps de skill → compteurs partagés.
Les changements visuels sont couverts par les contrôles de compilation et
les tests existants, sans inspection interactive du rendu.

Convention : **✓ = lu dans le code à cette référence ; reproduit = expérience
locale décrite dans l'[annexe de preuves](incidents/code-review-2026-09-24-evidence.md)**.
Les lignes mentionnées sont celles de `923bbab`. Aucun correctif produit
n'était appliqué lors de ce constat ; les corrections ultérieures sont consignées
dans la section 7. L'[index des revues](code-reviews.md) conserve les bases historiques.

## Vue d'ensemble

La fenêtre transforme nettement le périmètre du produit : profils personnels
et délégation de l'abonnement hôte, sélecteurs de modèles unifiés, MCP HTTP
avec OAuth et tâches, previews isolées, import GitHub, recherche documentaire,
launcher séparé, catalogue partagé, compteurs skills dans SQLite, rétention,
superviseur post-mortem et runs partiels reprenables.

Plusieurs décisions ferment réellement des classes de défauts antérieures :
les compteurs ne sont plus un read/modify/write de sidecar, l'identité du
payeur est explicitement résolue, les artefacts publiés proviennent de
l'inventaire du workspace, et un résultat refusé peut conserver ses travaux.

Les défauts confirmés sont surtout des **contrats corrects localement mais
incompatibles entre couches**. Le dispatch sait sauver du travail après un
abort, mais son appelant refuse le signal ; le run dure une heure, sa tâche
MCP vingt-cinq minutes ; une session attend une réponse, son balayeur la
considère inactive ; une preview est indisponible, sa génération permet
encore d'obtenir un claim.

**Bilan : deux findings HIGH et trois MEDIUM, tous reproduits localement.**
Les tests ne couvrent pas les compositions et les durées qui les déclenchent.

## 1. Bugs confirmés, par gravité

### 1.1 ✓ HIGH — Le résultat sauvé après expiration du délai est rejeté par `runDepthTask`

**Sites :** `src/run/depth.ts:127-131,153-155` ;
`src/atoms/dispatch.ts:103-111,144-150` ; `src/run/runner.ts:1082-1095`.
**Changements concernés :** `3bf5687`, puis landing dans `a4b2a97` ; les
remédiations `cd23a05` / `e0afcf9` ne ferment pas cette composition.

Le dispatch séquentiel conserve les phases déjà acceptées si une phase
suivante échoue avec `ctx.signal.aborted`. Le dispatch parallèle a la même
intention. Ils retournent les résultats et les phases inachevées, puis
`markLanded` construit un `Result.unfinishedPhases`.

Mais, dès le retour de `handle`, `runDepthTask` appelle
`attemptCtx.signal.throwIfAborted()`. Dans le cas précis que le landing veut
sauver, le signal est forcément déjà aborté. Le `catch` relance ensuite
`ctx.signal.throwIfAborted()`. L'acceptation racine n'est même pas atteinte,
et le runner n'atteint pas sa conversion `isLanded(result) → partial`.

**Reproduit :** une première phase réussit ; la seconde aborte le signal et
rejette. Le vrai dispatch retourne un résultat portant
`unfinishedPhases: ["interrupted"]`, puis le vrai `runDepthTask` rejette avec
`deadline`. Aucun modèle n'intervient.

**Conséquence :** le travail reste physiquement présent, mais cette voie peut
encore finir en échec, donc être exclue du seed du prochain run. Le cas
préventif où l'on renonce à ouvrir une phase *avant* l'abort peut fonctionner ;
cela n'établit pas le cas d'une phase interrompue en cours.

**Fermeture proposée :** expliciter le passage d'un résultat partiel déjà
récupéré vers une finalisation bornée, distincte du budget d'exécution.
Préserver la différence entre délai, annulation opérateur et annulation de
branche pour deepening. Ne pas seulement supprimer le premier throw : les
lectures et le verdict racine peuvent eux aussi rencontrer le signal expiré.

**Régression utile :** traverser dispatch réel → agrégation → profondeur →
issue du runner avec un signal effectivement aborté, en séquentiel et en
parallèle ; vérifier `partial`, les raisons conservées et l'absence de
publication. Le test de landing de `tests/depth-routing.test.ts:323` fournit
un résultat déjà partiel avec un contexte non aborté : il teste un autre cas.

### 1.2 ✓ HIGH — Les plafonds MCP peuvent être dépassés pendant des initialisations concurrentes

**Site :** `src/mcp/http.ts:169-199`.
**Introduction du plafond :** `30c7da9`.

Les deux limites lisent uniquement `sessions`. Or le host construit le
`McpServer` et le transport avant de lire complètement le corps HTTP, et
n'ajoute la session qu'au callback `onsessioninitialized`. Il ne réserve
aucune place pour une initialisation en cours.

Plusieurs POST dont les corps arrivent lentement passent donc tous avec la
même taille observée. Lorsque les corps finissent d'arriver, chaque callback
insère sa session sans nouveau contrôle. Ce n'est pas seulement une fenêtre
entre deux instructions synchrones : le réseau peut la maintenir ouverte.

**Reproduit sur HTTP réel avec le SDK installé :** limites globale et par
caller fixées à 1 ; trois requêtes du même caller envoient d'abord dix
caractères du JSON, puis leur suite. Avant la suite, trois serveurs sont
construits et `health().sessions` vaut 0. Après : trois HTTP 200,
`sessions: 3`, `evicted: 0`, `overflowed: 0`.

**Conséquence :** les plafonds ne bornent ni le nombre de serveurs en cours
d'initialisation, ni celui des sessions finales dans ce scénario. Sur un
serveur gated, il faut un caller authentifié ; cela ne constitue pas une
preuve d'accès anonyme. En revanche, la borne mémoire annoncée à partir du
nombre de sessions n'est pas garantie par ce code.

**Fermeture proposée :** réserver la capacité, globale et par caller, avant
l'allocation et avant tout await ; transférer la réservation à la session
ou la libérer sur refus, corps invalide, déconnexion et erreur. Conserver
le choix existant d'évincer les sessions du même caller plutôt que celles
d'un autre.

**Régression utile :** initialisations concurrentes à corps fragmentés, pas
uniquement une boucle d'initialisations entièrement attendues une par une.

### 1.3 ✓ MEDIUM — Une tâche MCP projet expire après 25 minutes, avant son run

**Site :** `src/mcp/tasks.ts:280-283` ; constantes dans
`src/mcp/run.ts:63` et `src/projects/coordinator.ts:888-910`.
**Introduction :** tâches dans `a4606e5` ; l'écart s'élargit avec `a4b2a97`.

`projectRunTaskHandler` calcule son TTL avec le défaut des runs **opérateur** :
15 minutes + 10 minutes de grâce. Le coordinateur projet accepte 60 minutes
par défaut, jusqu'à 120 minutes configurées, plus une préparation séparée
plafonnée à 10 minutes.

Le `InMemoryTaskStore` installé programme la suppression dès `createTask`,
quel que soit le statut. Lire la tâche ne repousse pas cette suppression,
et un changement de statut vers `working` ne réarme pas le timer.

**Reproduit :** le handler réel crée un TTL de 1 500 000 ms. L'exécution du
callback d'expiration créé par le SDK supprime la tâche alors que le service
projet rapporte toujours `running`. Budget projet par défaut : 3 600 000 ms.

**Conséquence :** `tasks/get`, `tasks/result` et `tasks/cancel` perdent cette
tâche pendant un run encore valide. Le watcher continue de consulter le
projet, puis tente une écriture de résultat sur une tâche absente ;
`quietly` avale l'erreur. Le run reste accessible par ses API propres, mais
le contrat de suivi MCP de la tâche est rompu.

**Fermeture proposée :** faire découler la durée de vie de la tâche du
budget effectif du coordinateur, avec préparation et finalisation, ou
conserver la tâche active jusqu'au terminal puis appliquer la grâce.
Ne pas remplacer 15 par 60 en dur : les runs de 120 minutes resteraient cassés.

**Régression utile :** horloge contrôlée au-delà de 25 minutes, run toujours
actif, puis fin et lecture du résultat. Inclure un budget projet personnalisé.

### 1.4 ✓ MEDIUM — Le balayeur ferme une session MCP ayant encore un appel en cours

**Sites :** `src/mcp/http.ts:160-161,245-248`.
**Contrats qui se croisent :** sessions HTTP dans `2b5ae4d`, appels longs
compatibles sans task augmentation dans `a4606e5`.

`lastSeenMs` est mis à jour à l'entrée d'une requête, puis reste inchangé
pendant `transport.handleRequest`. Le balayeur ne regarde ni requête en cours,
ni attente de résultat : après trente minutes, il ferme transport et serveur.

Un client qui utilise la compatibilité `taskSupport: 'optional'` peut
légitimement laisser son unique `tools/call` attendre le résultat sur SSE.
Les logs serveur ne sont pas de nouvelles requêtes et ne mettent pas à jour
`lastSeenMs`. Un `tasks/result` bloquant présente le même conflit de durée.

**Reproduit :** un outil MCP réel reste en attente sur une promesse ;
l'horloge du host avance de 31 minutes ; le balayeur de production supprime
la session. La réponse HTTP 200 se termine avec un corps vide, avant que
l'outil n'ait rendu son résultat.

**Conséquence :** la réponse finale et le replay associé sont perdus alors
que le travail sous-jacent peut continuer. C'est indépendant du TTL du finding
1.3 : corriger la tâche à 60 minutes ne protège pas sa session.

**Fermeture proposée :** distinguer une session inactive d'un appel encore
attendu, tout en gardant une borne aux appels et sans faire d'un GET SSE
abandonné une raison de survie illimitée. Les deux horloges doivent être
testées ensemble avec les variantes task et compatibilité synchrone.

### 1.5 ✓ MEDIUM — Un claim de génération contourne l'indisponibilité d'un run partiel

**Sites :** `src/preview/httpService.ts:121-128` ;
`src/preview/manager.ts:150-157,455-486` ;
`src/projects/coordinator.ts:1456-1463`.
**Contrat devenu incompatible :** voie `generation` déjà présente, refus
explicite de preview pour `partial` dans `e0afcf9`.

Lors d'un open avec `generation`, le service appelle directement
`manager.claim`. Cette méthode vérifie l'état `ready` et la génération de
l'instance, mais ne connaît pas le statut du run. Une génération capturée
pendant le run peut rester prête lorsqu'il devient `partial`.

Le coordinateur ne crée pas de descripteur de preview pour ce résultat,
conformément au choix explicite « un résultat refusé n'est pas offert en
preview ». Cela ne ferme pourtant pas la voie de claim d'une instance
existante. Le hook de fin du serveur journalise le résultat sans arrêter
cette génération.

**Reproduit avec service, manager et registre de claims réels :** lecteurs de
store simulant un run `partial`, sans descripteur, avec une instance
`ready` / `in-flight`. GET status annonce `availability: unavailable` ;
POST open avec `generation: 1` retourne 200, `availability: available` et
un claim que le registre accepte effectivement.

La seconde incohérence vient du résumé retourné par le manager : sans
`runInFlight` explicite, il déduit encore l'éligibilité de la source historique
de l'instance. Ce finding concerne le cycle de vie au sein du même projet ;
les contrôles d'organisation, de rôle et d'appartenance au projet restent
présents. Aucune fuite inter-organisation n'est démontrée.

**Fermeture proposée :** appliquer le contrat du statut courant aussi à la
jonction par génération et aux claims encore renouvelables. Définir le sort
d'une preview déjà ouverte lorsque le run devient partiel, au lieu de
supposer que l'absence de descripteur retire les capacités existantes.

**Régression utile :** ouvrir une vraie génération pendant `running`, terminer
le run en `partial`, puis essayer status, open avec génération et heartbeat.
Les tests terminaux existants couvrent surtout une instance déjà arrêtée.

## 2. Incohérences et limites de conception

### A. Plusieurs horloges gouvernent le même travail sans contrat de composition

Budget de préparation, budget de run, plancher de landing, signal d'abort,
watchdog, TTL de tâche et inactivité de session ont chacun leur justification.
Les findings 1.1, 1.3 et 1.4 montrent que leur composition n'est pas définie
jusqu'au résultat final observable par le client.

La priorité n'est pas de rallonger tous les délais. Elle est de définir les
phases « exécuter », « finaliser du travail acquis » et « conserver le reçu »,
avec les responsabilités de cancellation et les bornes de chacune. Un test
intégrant les horloges vaut davantage que trois tests supplémentaires qui
valident séparément leurs constantes.

### B. `partial` est une propriété de tout le parcours, pas seulement une nouvelle valeur d'enum

Le champ traverse correctement de nombreux lecteurs : stats, trace,
`isLanded`, raisons, outcome MCP projet, statut SQLite et refus de publication.
Mais l'arrivée d'une nouvelle issue exige aussi d'examiner les capacités déjà
ouvertes : génération de preview, claim et timers MCP. Le finding 1.5 est
précisément une capacité ancienne qui survit à un nouveau statut.

L'amélioration à rendement élevé est une matrice de parcours observables :
comment une issue se persiste, se reprend, se publie, s'affiche et se suit par
MCP. Cette matrice doit guider des tests de comportement, sans introduire
une deuxième définition des statuts à côté des schémas existants.

### C. Le « partiel reprenable » a une exception GitHub explicite mais peu visible

`src/projects/coordinator.ts:1359-1376` remplace le seed précédent par un
snapshot de la branche par défaut pour les projets importés. Le corpus de
recherche reste préparé depuis `seedRun`, tandis que les raisons du landing
ne voyagent pas si les bytes précédents ne sont pas le seed effectif.

Ce comportement est **documenté et intentionnel** dans
`src/projects/AGENTS.md` : il ne doit pas être présenté comme un sixième bug.
Il laisse toutefois un cas produit non résolu : un run partiel ne publie pas,
et le run suivant d'un projet importé ne reprend pas ses modifications locales.
La promesse générale de reprise, notamment « partial — resumable » dans les
notifications, demande donc une qualification selon l'origine du projet.

Amélioration proposée : rendre explicite à l'utilisateur quelle base sera
reprise. Si la reprise des modifications partielles sur un dépôt importé est
voulue, concevoir sa relation au nouveau HEAD et à la divergence GitHub avant
d'implémenter un simple changement de seed. Ne pas écraser silencieusement les
modifications externes pour tenir une promesse de reprise.

### D. Les preuves de revue sont moins découvrables que les décisions qu'elles expliquent

Les revues générales des 20 et 27 août ont disparu de l'arbre, alors que
l'historique cite encore leurs fermetures. Se fier aux seuls fichiers actuels
ferait reprendre la fenêtre au 18 août et relire 239 commits supplémentaires.

Amélioration modeste : garder un index des revues avec date, intervalle et
référence Git, même lorsqu'un document est retiré. Ne pas réinjecter toutes
les revues dans `AGENTS.md` : cela annulerait le bénéfice de sa restructuration.

## 3. Refactorings suggérés, par rendement

1. **Raccorder la finalisation au landing existant.** Résoudre 1.1 et ajouter
   une preuve traversant la frontière qui échoue. Aucune nouvelle heuristique
   de validation de contenu n'est nécessaire.
2. **Réserver les sessions avant allocation.** Résoudre 1.2 dans le host qui
   possède déjà les limites, sans faire porter cette responsabilité au SDK
   ou à chaque tool.
3. **Faire suivre au MCP le cycle de vie effectif des runs.** Traiter 1.3 et
   1.4 ensemble, mais tester séparément expiration de tâche, appel bloquant,
   déconnexion et annulation.
4. **Unifier l'éligibilité preview entre ouvrir et rejoindre.** La décision
   sur le statut du run appartient au service qui peut lire ce statut ; le
   manager continue de posséder l'instance et la génération.
5. **Poursuivre l'extraction de services par domaine, sans réécriture globale.**
   À cette référence : `src/viz/server.ts` compte 4 490 lignes,
   `src/atoms/L2Atom.ts` 2 301, `src/auth/store.ts` 2 141 et le coordinateur
   projet 1 625. Ces tailles ne démontrent pas un bug ; elles rendent les
   frontières de responsabilité plus coûteuses à vérifier. La séparation
   service/adapter déjà employée par preview reste une bonne direction.

## 4. Ce qui tient bien dans cette fenêtre

- **Une identité de modèle et de payeur explicite.** Le sélecteur complet,
  la résolution compte → organisation → hôte, les gardes de subscription et
  le reçu des payeurs sont plus cohérents que le transport de base implicite
  relevé dans les revues précédentes. Les autorités sont interrogées au
  lancement ; un pin stocké n'est pas traité comme une permission.
- **Le déplacement des compteurs skills vers le store.** `03e340a` traite la
  concurrence réelle de plusieurs écrivains au lieu d'ajouter une nouvelle
  protection de sidecar. La frontière corps disque / ligne SQLite est
  explicitement discutée ; une simple transaction SQL ne prétend pas rendre
  les deux supports atomiques. Pas de nouveau défaut confirmé sur cette
  partie dans la lecture ciblée effectuée.
- **Des résultats partiels typés et des raisons composables.**
  `isLanded` / `landingReasons` évitent que runner, client et analyste
  reconstruisent chacun le sens de `partial` à partir de prose. Le défaut
  1.1 est un raccord d'exécution, pas un argument pour abandonner ce modèle.
- **La recherche documentaire a une autorité propre au run.** Les reçus
  lient organisation, projet, principal, source et génération ; les readers
  réinterrogent l'état courant. Les tests traitent révocation et corpus d'un
  autre projet. Le partage volontaire du catalogue et de la confiance reste
  une décision distincte de l'isolation des corpus : il n'est pas requalifié
  en régression ici.
- **Le launcher et la publication conservent des identités contrôlées.**
  Le service valide les handles avant de construire les opérations moteur ;
  les workspaces ont un journal de réservation. Le publisher capture une base
  GitHub précise et refuse d'assimiler une publication ratée à une perte du
  résultat livré. Lecture et tests locaux ne remplacent pas une nouvelle
  preuve d'isolation sur le runtime de production.

## 5. Vérification exécutée

Environnement : macOS local, Node `v24.20.0` de `.nvmrc`, dépendances présentes,
worktree initialement propre. Aucun burn-in observé avant le lancement des
contrôles. Aucun run facturé ni modification de store de production.

- **`npm run check` : ROUGE au passage complet.** `docs:check`, les deux
  tsconfigs et lint passent. Tests : **4 339 verts, 3 rouges, 7 skipped**,
  sur 344 fichiers de tests (340 passent, 3 échouent, 1 entièrement skipped).
- Échecs observés : `llm-codex-cli` sur le timeout de 5 secondes du fixture
  transport ; `project-retrieval-runner` et `retrieval-haystack-campaign` sur
  l'attente de 3 secondes de création du fichier PID de warmup.
- **Relance ciblée des trois fichiers avec `--maxWorkers=1` : 79/79 verts.**
  Cela est compatible avec une sensibilité à la contention de sous-processus,
  sans prouver à lui seul toute la cause. La suite complète n'a pas été
  relancée en série ; elle n'est donc pas déclarée verte rétrospectivement.
- **`npm run build` : VERT.** Le build signale de gros chunks, dont le chunk
  principal d'environ 1,79 Mo minifié / 502 Ko gzip. C'est une piste de mesure
  du chargement, pas une preuve de régression de rendu ni une urgence établie.
- **Cinq reproductions ciblées : défauts observés**, avec les bornes de
  chaque fixture et les sorties conservées dans l'annexe.
- **Non exécutés :** réinstallation `npm ci`, `release:check`, smoke navigateur
  et nouveaux exercices d'isolation Docker/gVisor. Les 7 skips concernent
  mender-isolation (2), preview-isolation (2) et project-retrieval-haystack (3).
  Cette revue n'est pas une attestation de release ou de déploiement.

Commandes de vérification, après sélection du Node épinglé :

```bash
npm run check
npx vitest run tests/llm-codex-cli.test.ts tests/project-retrieval-runner.test.ts tests/retrieval-haystack-campaign.test.ts --maxWorkers=1
npm run build
```

## 6. Priorités et statut

**P1 :** préserver effectivement le résultat après deadline (1.1), puis fermer
l'admission MCP concurrente (1.2). Le premier conditionne la récupération du
travail ; le second conditionne la borne de ressources du host.

**P2 :** aligner la tâche et la session sur le run qu'elles représentent
(1.3–1.4), puis fermer l'écart d'éligibilité des claims preview (1.5).

**Suite de tests :** conserver le premier passage rouge dans le dossier de
revue. Examiner le parallélisme et les délais des fixtures de sous-processus
avant d'augmenter aveuglément les timeouts de production.

Statut du constat initial : findings ouverts, correctifs non appliqués. La
revue initiale ajoutait seulement le rapport et ses preuves reproductibles. Les
arbitrages déjà documentés restent distingués des défauts confirmés ; aucune
nouvelle gate de contenu n'est conçue ou ajoutée pendant la revue.


## 7. Corrections du 24 septembre

À la demande du propriétaire, les cinq findings ont été corrigés dans le
worktree suivant la revue. Le constat et les sorties rouges de la section 5
restent des preuves de l'état antérieur, pas des résultats réécrits.

### Correctifs et preuves de comportement

- **1.1 — landing et acceptation racine.** Un résultat portant des phases
  inachevées passe à une finalisation bornée, même après le `TimeoutError`
  d'exécution. Synthèse et acceptation partagent la borne absolue deadline
  + 45 secondes, à l'intérieur de la grâce watchdog de 60 secondes. La
  cancellation explicite et le deepening restent des interruptions. Un
  verdict qui n'achève pas sa finalisation laisse un résultat partiel refusé,
  jamais une livraison. `depth-routing` traverse les dispatchs séquentiel et
  parallèle avec un signal aborté, vérifie l'annulation explicite et un
  validateur qui ignore l'abort. `depth-runner` traverse le vrai runner,
  les atoms, les outils, la trace et l'épilogue avec les seuls LLM simulés.
- **1.2 — capacité réservée.** Le host réserve une place globale et une place
  caller avant toute allocation et tout await. L'initialisation la transfère
  à la session ; corps invalide, déconnexion, exception et fermeture la
  libèrent. Les corps incomplets ont 30 secondes. Le plafond caller évince
  toujours ses propres sessions ; si toutes ses places sont encore en
  initialisation, il reçoit 503. `mcp-http-lifetimes` vérifie sur HTTP réel
  les corps fragmentés, les deux plafonds et la libération des réservations.
- **1.3 — budget réel.** `ProjectService.runTaskBudgetMs` expose le budget du
  coordinateur : préparation + délai configuré + hard backstop du child.
  La tâche ajoute sa grâce de conservation. Le watcher s'arrête aussi si la
  tâche est annulée ou absente. Les tests MCP avancent l'horloge de 131 minutes
  avant le terminal et lisent encore le résultat ; le coordinateur vérifie
  la dérivation avec ses budgets configurés.
- **1.4 — appels actifs.** Un POST reste actif jusqu'à la fin de sa réponse
  ou la fermeture de la connexion, et réarme ensuite l'inactivité. Un GET
  SSE seul ne maintient pas la session. Un plafond HTTP configurable de
  trois heures borne un POST bloqué ; il couvre le budget projet maximal
  avec préparation et finalisation. Les tests attendent un vrai outil au-delà
  des 30 minutes, reçoivent sa réponse, puis vérifient l'expiration inactive,
  ainsi que le GET abandonné et l'appel qui ne répond jamais.
- **1.5 — preview.** Ouvrir, rejoindre une génération et renouveler un accès
  passent par la même éligibilité du run. Le service de domaine retire les
  snapshots et leurs claims au terminal ; le serveur ne fait que lui passer
  l'événement. Une ouverture recontrôle le statut après ses awaits. Tests :
  running → partial/failed/cancelled, ancien grant révoqué, join et heartbeat
  refusés, et fin du run pendant la création du snapshot.

### Parcours des issues et améliorations connexes

- **Delivered :** trace et workspace persistés ; MCP completed ; publication
  et preview admissibles selon les autres contrôles habituels.
- **Partial :** trace, raisons et fichiers conservés ; MCP completed avec
  statut partial ; publication et preview refusées ; ancienne génération
  in-flight retirée. Le seed reprend le workspace pour un projet créé dans
  Atoma ; un projet importé reprend sa branche GitHub par défaut.
- **Failed/cancelled :** statut et coûts conservés ; pas de publication ni de
  preview ; le watcher MCP termine en failed lorsqu'il constate ce terminal.
  `tasks/cancel` conserve son propre statut cancelled et annule le run.
- Cette couverture complète les tests existants de landing, persistance,
  publication, seed et lecture des raisons ; les schémas de production
  restent la seule définition des statuts.
- **Origine de la reprise (2.C) :** l'aide du formulaire indique la base du
  prochain run selon son origine ; les notifications disent simplement
  « partial »/« partiel ». Le seed GitHub intentionnel reste inchangé.
- **Découvrabilité (2.D) :** nouvel [index des revues](code-reviews.md), lié
  depuis le README, avec fenêtres, révisions et commandes de lecture des
  documents retirés.
- **Extraction (3.5) :** la réconciliation des previews terminales reste dans
  le service preview ; aucune règle de statut n'est ajoutée au serveur HTTP.
- **Contention des tests (5) :** Vitest est limité à quatre workers. Plusieurs
  fichiers lancent chacun leurs propres Node/Python : un worker par CPU
  surchargeait les fixtures. Les délais de transport et de warmup restent
  inchangés. Le premier passage rouge demeure ci-dessus.
- **Gros chunk (5) :** le warning reste une mesure de build, pas un défaut
  confirmé. Aucune découpe arbitraire ni hausse du seuil d'avertissement ; le
  contrôle navigateur vérifie le parcours après les changements de copie.
- **Préconditions du smoke navigateur :** le scénario mobile ferme l'offre
  de notifications via son bouton avant de tester le canvas ; le scénario
  compte attend que le point de clic atteigne le canvas interactif, après
  disparition du snapshot de transition. Les assertions comportementales et
  les délais maximaux restent inchangés.

### Vérification des correctifs

Installation par `npm ci`, puis `npm run release:check` : contrôle des docs,
deux configurations TypeScript, lint, **4 363 tests réussis et 7 ignorés**
(344 fichiers réussis, un ignoré), audit sans vulnérabilité, build et smokes
compilés MCP/auth/CLI réussis. Les trois fixtures intermittentes du constat
initial passent dans la suite complète avec la concurrence bornée.

Le contrôle navigateur complet `npm run viz:smoke` réussit sur la version
finale, après correction des deux préconditions ci-dessus. Build et OAuth
navigateur réussis ; bras GPU entièrement réussi : WebGPU et fallback WebGL, navigation, défilement,
projets GitHub, mobile, compte et remise à zéro de l'annonce simulée. Aucun
envoi réel d'annonce ni appel de traduction payant.

Un passage intermédiaire de la suite finale a signalé 12 dérives de signature
pour `projects.actionsHint.ready` : le raccourcissement de la copie avait
retiré `{{name}}`. Le paramètre et son interpolation ont été rétablis dans
la source anglaise ; aucun catalogue traduit n'a été réécrit à la main.

`git diff --check` est propre. Aucun déploiement ni appel modèle payant ne
fait partie de cette correction ; les changements restent locaux.
