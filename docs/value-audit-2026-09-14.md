# Audit de valeur — couverture et diagnostic local, 2026-09-14

Statut : diagnostic du corpus local accessible, incomplet pour la plateforme.
Code examiné : `25457edf02cc999106be79835e52c36220bdb2f4`.
Révision de l'audit après relecture des argv, logs et événements d'outils.
Aucun run payant, changement du runner ou lancement de l'analyste.
Le [contrat d'acceptation proposé](acceptance-contract-2026-09-14.md)
accompagne ce diagnostic ; il n'est pas implémenté.

## 1. Périmètre et exclusions

Deux CSV suivis dans Git sont exploitables :

| Source | Lignes | SHA-256 |
|---|---:|---|
| [21 août](../burnin/results-2026-08-21.csv) | 28 | `dd12f6340c914d4e049a9722039fb9dd99192576aff2091bc1d688fcc127e474` |
| [22 août, phase redundancy A3](../burnin/results-phase-redundancy-a3-2026-08-22.csv) | 6 | `96285606c4d2c26f13edbb6db44c4c917564b161326d33a00bd4c00eb3390553` |

Ils restent deux cohortes distinctes. Les répétitions de tâches, changements
de code et états d'apprentissage interdisent d'en déduire un gain causal entre
les dates. Le [record du burn-in](incidents/burn-in-2026-08-21.md)
identifie les 28 runs du premier CSV comme des constructions depuis zéro et
les trois runs de maintenance seedés comme **absents du CSV**. Ces trois runs
ne sont pas reconstruits à partir des seuls chiffres narratifs.

Inventaire local complémentaire, sans exploration des workspaces applicatifs :

- Windows : la base du checkout, ouverte en lecture seule avec son WAL,
  contient une seule ligne projet livrée, correspondant à une démonstration.
  Les 19 traces JSON retrouvées sous `~/.atoma/orgs` et
  `~/.atoma/projects` portent le libellé du générateur
  [preview-demo](../scripts/preview-demo.mjs). Elles sont exclues.
- WSL Debian : quatre traces de runs projet du 2 septembre et leurs logs
  ont été retrouvés sous `/home/mgf/.atoma/orgs/*/projects/*/runs/*`.
  Les 21 autres traces portant le libellé de démonstration sont exclues,
  ainsi que le run opérateur du 31 août explicitement intitulé « mocked ».
  Les index JSON ne sont pas des runs.
- La base `/home/mgf/dev/atoma/atoma.db`, ouverte en lecture seule,
  contient zéro ligne `project_runs` (requête via Python `sqlite3`, URI
  `mode=ro`, sans dépendre du Node du shell WSL). Aucune des deux bases consultées ne
  permet donc de confirmer la finalisation projet des quatre traces WSL.
- Aucun verdict n'a été trouvé dans le dossier `supervisor/` du checkout.
  Cela ne prouve pas leur absence sur un autre hôte ou dans un répertoire
  configuré différemment. Le corpus récent du serveur et celui du Mac ne
  font pas partie de cet audit. Les chemins de production sont documentés
  en section 5 ; c'est l'accès administrateur et l'export qui restent à obtenir.

Les fixtures de vérification du checkout temporaire WSL du 14 septembre sont
exclues. Les présentes données ne mesurent pas le nouveau défaut short-first.

## 2. Couverture avant indicateurs

| Indicateur | Couverture constatée | Limite / condition de calcul |
|---|---|---|
| Issue historique du runner | 28/28 et 6/6 lignes CSV ; 4/4 épilogues WSL | Ne prouve pas la finalisation ni la publication projet |
| Issue finale des projets réels | 0/4 lignes projet retrouvées pour WSL | Besoin du store de l'hôte ayant finalisé ces runs |
| Coût estimé et durée | 28/28, 6/6 ; 4/4 traces WSL | Valeur enregistrée, pas facture ; zéro enregistré ne prouve pas une consommation fournisseur nulle |
| Nature fresh / seeded | 28/28 fresh selon le record ; 4/4 lancements WSL observables : 2 fresh, 2 seeded | Les argv complets et les messages de copie établissent le seed WSL, malgré son absence des épilogues |
| Taux de deepening des tentatives courtes | Non calculable dans ces cohortes | Champ absent et cohortes antérieures au routage ; ne pas convertir l'absence en zéro |
| Défauts parmi les livraisons | Aucun verdict rapproché | Absence de verdict ≠ absence de défaut ; un finding `defect` concerne Atoma, pas nécessairement le livrable |
| Conformité aux critères utilisateur | Aucune mesure structurée retrouvée | Un statut `delivered` ou une interaction DOM ne démontre pas la fonctionnalité demandée |
| Dispatch déterministe | Compteur présent sur 34/34 lignes CSV et 4/4 épilogues | Tous à zéro dans ce corpus ; les trois maintenances seedées manquent au CSV |
| Restauration après sinistre | Non mesurée | Aucun backup restauré pendant cet audit ; pas de RPO/RTO démontré |

Le [schéma des stats](../src/contracts/runStats.ts) ne persiste ni le seed,
ni la révision du code, ni le mode demandé. Son défaut `deepenings = 0`
sert la compatibilité de lecture : ce n'est pas une observation historique.
Cela ne dispense pas de lire les métadonnées de lancement présentes dans les
logs. Ici, l'argv affiché par npm avant le travail modèle et la ligne hôte
`workspace seeded from` concordent pour les deux runs seedés. On n'utilise pas
une occurrence de `--seed` citée dans une réponse du modèle comme preuve.

Pour reconstruire le seed d'un projet, conserver trois niveaux : **observé**,
**inféré**, **inconnu**. Le
[coordinateur](../src/projects/coordinator.ts) sélectionne un run livré dont
le workspace existe encore ; il peut sauter une livraison. Pour les projets
importés, `prepareRun` remplace cette source par un snapshot GitHub. L'ordre
des livraisons seul ne prouve donc pas l'origine effective. La parenté du
contexte de retrieval n'est pas davantage une preuve du seed filesystem.

## 3. Chiffres effectivement calculables

| Cohorte | Livraisons annoncées | Coût total estimé, USD | Médiane par run, USD | Coût des non-livraisons, USD | Durée cumulée |
|---|---:|---:|---:|---:|---:|
| 21 août, CSV | 27/28 (96,43 %) | 10,0581 | 0,30035 | 0,8084 (8,04 %) | 8 155 s |
| 22 août, CSV A3 | 6/6 | 1,5317 | 0,2364 | 0 enregistré | 1 107 s |

Dans le premier CSV : CLI 8/8, HTTP 8/8, web 11/12. Le run non livré
`web-countdown` dure 902 s. Un seul échec observé ne permet pas de décider
qu'un checkpoint intermédiaire aurait récupéré cette dépense. Les reprises
réussies restent de nouveaux runs et ne changent pas rétroactivement son issue.

Les quatre épilogues WSL donnent le relevé séparé suivant. Les identifiants
sont abrégés uniquement pour la lecture ; les dates sont toutes le 2 septembre.

| Run | Issue du runner | Coût épilogue, USD | Appels | Durée trace |
|---|---|---:|---:|---:|
| `dee609e4` | delivered | 0,5370 | 20 | 368,299 s |
| `f0cbfef2` | failed | 0,7153 | 27 | 900,595 s |
| `65d5621f` | delivered | 0,2450 | 15 | 197,306 s |
| `07db0e67` | failed | 0 enregistré | 2 | 9,499 s |

### Origine observée, causes et erreurs récupérées

| Run | Origine au lancement | Observation et preuve locale |
|---|---|---|
| `dee609e4` | Fresh : argv complet sans seed, workspace nettoyé | API bookmarks ; 8 événements d'outils en erreur sur 62, dont 4/4 `write_file` avec `EACCES`, 3 démarrages Node avec module introuvable et 1 refus de `whoami` ; épilogue livré |
| `f0cbfef2` | Seed depuis `dee609e4` | `run.log:3,10` : argv et copie de 2 entrées ; ligne 97 : `TIMEOUT after 900s — budget exhausted` ; 24 appels Haiku/27, 4 skills apprises, échec |
| `65d5621f` | Seed depuis `dee609e4` | `run.log:3,10` : même seed et copie de 2 entrées ; lignes 98,105,112 : `validate_html: ok=true, consoleErrors=0, failedRequests=0` ; livré |
| `07db0e67` | Fresh : argv complet sans seed, workspace nettoyé | `run.log:26` : refus fournisseur « You've hit your individual spend limit », remonté comme erreur `parseTwoJson` ; 2 appels comptés, zéro token et coût enregistré nul |

Il y a donc **deux runs seedés, dont un livré et un expiré**. Le premier
demande une landing page, un CSS séparé et une page about ; le second demande
un seul `index.html` avec CSS inline. Ils partent de la même API, mais leurs
périmètres diffèrent. « Seedé » décrit une origine filesystem, pas à lui seul
une sous-famille homogène de maintenance. Ce n'est pas une comparaison contrôlée
ni une mesure du parcours court, absent de cette génération (`atoma@0.1.4`
dans les logs, révision exacte non établie).

Les deux non-livraisons à coût positif de ce corpus sont des expirations à
900 s : `web-countdown` du 21 août (cause documentée dans le record historique)
et `f0cbfef2` (log directement consulté). La troisième est un refus de limite
de dépense du fournisseur. Distinguer la cause du refus du symptôme parseur
évite de classer ce dernier comme un problème de JSON produit par le modèle.
Le refus explique le zéro comptabilisé ; il ne fournit pas une facture externe.
Cette limite de compte est indépendante du lease : sérialiser les runs ne
garantit pas qu'il reste du quota.

Ces observations placent l'épuisement du budget et les boucles de réparation
avant toute conclusion sur la nécessité de checkpoints. Elles ne prouvent ni
qu'un budget plus long aurait réussi, ni quelle dépense aurait été récupérable.
Le code actuel fixe le défaut projet à **1 800 s**, avec un override hôte
`ATOMA_PROJECT_TIMEOUT_MS`. À la révision de code examinée, le contrat projets
conservait une ancienne mention de 15 minutes à côté du défaut de 30 minutes :
la constante `DEFAULT_PROJECT_RUN_TIMEOUT_MS` du coordinateur tranche.
La mention normative est corrigée avec cette revue documentaire. Cette évolution et
l'ancien problème de propagation du timeout sont des confondants de version.

Les 8 erreurs d'outils du run livré établissent une friction récupérée, pas un
défaut fonctionnel final. Leur coût isolé n'est pas mesuré. Le contrat
d'acceptation établira la conformité finale ; les événements d'outils restent
nécessaires pour mesurer le travail perdu avant cette conformité.

Le [dossier de reproduction du premier `write_file`](incidents/worker-first-write-2026-09-14.md)
retrouve une correction déjà commitée le 2 septembre (`5d697fd`) : création
du dossier de montage côté hôte avant Docker. Son message mentionne un `chown`
opérateur pendant le run historique ; la livraison ne prouve donc pas une
récupération autonome. Sur l'image actuelle, première écriture et redirection
shell réussissent dans quatre cas (absent/vide, disque Linux/montage Windows),
sans changement de permissions. Aucun nouveau garde-fou n'est introduit.

Empreintes SHA-256 des `run.log` relus :

| Run | SHA-256 du log |
|---|---|
| `dee609e4` | `c484d12dccb6581df57db87e2077cb97af5d6788b3381e73da155dfc35aaa31f` |
| `f0cbfef2` | `e96d6519eeca5d7fd8aa14b1742a780486474dad126f85d22c14e9d2b3923326` |
| `65d5621f` | `c448fec4d1d7ad417a6da02f022739f3118acdae429edcdeda7a23cc04356219` |
| `07db0e67` | `8e5c79db953bad0878c08ff65bcbd5623a87087cd903c9004724855a90f16cdc` |

Total des épilogues : 1,4973 USD estimé et 64 appels. Les deux épilogues
`delivered` sur quatre ne constituent **pas** un taux de livraison projet.
Les totaux de traces, plus précis, sont respectivement 0,5369542,
0,7152676, 0,2449851 et 0 USD ; ne pas mélanger ces précisions dans une somme.
Aucun montant n'est présenté comme une facture : les CSV utilisent
`claude-cli`, et les épilogues WSL n'ont pas `subscriptionCostUsd`.

Empreintes SHA-256 des traces WSL consultées, pour rapprochement avec un export :

| Run complet | SHA-256 |
|---|---|
| `dee609e4-4c81-4866-9170-eed46318ef2c` | `5fbabea3ebf4562782a2b0246b06cbb474e661385705ece9c7fd05fa045979e0` |
| `f0cbfef2-55e4-404d-87a6-d45d5d7aad5b` | `d650f06741d2d2180564cc9ec82a35832190f066f980e93cf055c7f71fdc94e9` |
| `65d5621f-33dc-47be-8441-2bb236fa91c6` | `aed3bfb21e05f60627adec831e94b16770af71d5b938ec7f33d8e8480c91b7a7` |
| `07db0e67-5852-4411-8da2-6b813b839181` | `f740b8627bcd5548507dc21caca39bfb6b6a0ebf83dab0fc7e9ad9c9ddfd7875` |

Ces traces restent locales, hors Git : leurs chiffres sont un relevé daté,
pas un benchmark public reproductible depuis le dépôt seul.

## 4. Méthode de reproduction et dénominateurs

Pour chaque CSV, lire toutes les lignes avec `Import-Csv` ou `csv.DictReader`,
vérifier l'unicité de `trace`, puis sommer les coûts avec un type décimal.
Livraisons = nombre de lignes `outcome == delivered` / nombre total de lignes.
Coût des non-livraisons = somme des coûts `outcome != delivered` ; sa part
utilise la somme des coûts connus de toute la même cohorte. La médiane est la
moyenne des deux valeurs centrales pour ces effectifs pairs. Les durées sont
les `duration_s` enregistrées, pas la durée écoulée entre les premiers et
derniers lancements. Afficher le nombre de coûts manquants si le corpus évolue.

Pour un export projet, joindre par identifiant les lignes finalisées, les
épilogues, les traces et les verdicts sans dupliquer un run. Garder séparées
l'issue runner, l'issue projet et l'issue publication. Les lecteurs doivent
conserver les dispositions absent, invalide, trop volumineux et inaccessible.
Un épilogue dans un log reste distinct d'une observation de transport fiable.

Le futur taux de deepening aura pour dénominateur les runs **observés comme
démarrant court**, subdivisés par famille et origine, pas tous les runs.
Le coût de la tentative abandonnée et celui du deep complet s'additionnent
sous le même deadline. Le signe du gain net reste inconnu.

Le taux de findings `defect` parmi les livraisons utilisera seulement les
livraisons dotées d'un verdict valide, avec sa couverture explicitement
affichée. Il sera nommé « défauts d'Atoma signalés par l'analyste » ; une
mesure des défauts du livrable demande une preuve fonctionnelle indépendante.

## 5. Décisions et suite bornée

1. Collecter le corpus récent via l'accès administrateur de l'opérateur,
   puis rapprocher le snapshot SQLite, les traces, logs, verdicts et bases Git
   capturées. Les [chemins de déploiement](automatic-deployment.md) sont explicites :
   store `/home/atoma/state/atoma.db`, runs opérateur `/home/atoma/state/runs`,
   projets `/home/atoma/state/projects` (`ATOMA_PROJECTS_ROOT`), donc runs projet
   sous `orgs/<org>/projects/<project>/runs/<run>` de cette racine. Le
   [guide superviseur](supervisor-codex-production.md) fixe les verdicts sous
   `/home/atoma/state/supervisor`. Vérifier les overrides effectifs sur l'hôte.
   La clé CI est limitée à la commande forcée de déploiement ; elle n'est pas
   un accès shell de collecte.

   Sur l'hôte, `npm run backup -- --dest <off-machine mount>` utilise déjà
   l'API de backup SQLite, puis archive skills, runs opérateur et archives.
   Toutefois [son implémentation](../src/cli/backup.ts) ne collecte automatiquement
   **ni `ATOMA_PROJECTS_ROOT` ni `ATOMA_SUPERVISOR_DIR`**. Compléter l'export avec
   ces corpus, un inventaire et des empreintes ; ne pas qualifier le backup
   standard de snapshot complet des projets. L'API SQLite assure sa cohérence
   interne, pas l'atomicité avec les tar de répertoires. L'opérateur doit borner
   la collecte aux runs terminés et empêcher les mutations concurrentes pendant
   la capture (runs, publication, analyste, nettoyage), sans modifier le lease
   pour contourner un travail vivant. Vérifier les entrées `captured`/`skipped`
   du manifeste. Exclure secrets et données applicatives inutiles à l'audit.
   Aucune collecte distante ni restauration sur le store vivant exécutée ici.
2. Examiner le contrat d'acceptation ci-joint contre les défauts documentés,
   puis choisir les premières capacités de probe réellement exécutables.
   Aucun nouveau gate ni changement du runner n'est livré ici.
3. L'extension short-first aux seeds reste une décision distincte : remise en
   place du seed au deepening, coût cumulé et crédit des phases déjà apprises
   doivent être explicités. Le dispatch compilé des projets reste désactivé.
4. « Repartir de N » désignera, si retenu, un **nouveau run seedé depuis N**.
   La [publication actuelle](../src/projects/AGENTS.md) ajoute et met à jour
   sur l'arbre parent, sans supprimer les fichiers absents. Les fichiers
   ajoutés après N peuvent donc rester publiés. Un vrai retour à l'état N
   dépend d'un contrat de suppression et de sa mise en œuvre ; ce n'est pas
   une simple action d'interface, ni la republication d'un ancien run.
5. La sauvegarde/restauration doit être exercée sur une cible isolée avant
   d'annoncer un délai de récupération. L'absence de mesure est conservée.

**La plateforme admet un seul run simultané sur l'hôte, toutes organisations
confondues, via le lease partagé.** Toute promesse multi-utilisateurs doit
énoncer cette limite ; plusieurs comptes ne signifient pas plusieurs runs
parallèles. Cet audit ne crée ni queue produit ni capacité supplémentaire.
