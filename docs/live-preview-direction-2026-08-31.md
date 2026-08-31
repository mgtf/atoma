# Présenter l'application en cours de développement — étude Lovable et trajectoire Atoma

> Revue interne · Atoma · 31 août 2026
>
> Statut : **direction produit adoptée le 31 août 2026 ; design non normatif.**
> L'utilisateur d'Atoma doit voir l'application produite, pas seulement la
> trace — c'est le chemin retenu. Rien ici n'est implémenté. Le
> [design result-preview consolidé](result-preview-design-2026-08-28.md) reste
> la première marche, inchangée, et la
> [forme de déploiement](deployment-docker-launcher-2026-08-28.md) reste le
> socle. Les règles normatives restent dans les `AGENTS.md` jusqu'à ce qu'une
> implémentation atterrisse.

Ce dossier complète la
[revue d'architecture du 26 août](lovable-lessons-atoma-2026-08-26.md), qui
couvrait migration, orchestration et boucles d'apprentissage. Il couvre la
**présentation** : ce que l'utilisateur de Lovable voit pendant que l'agent
construit, et comment Atoma adopte ce chemin sans céder ses invariants.
Sources consultées le 31 août 2026 : documentation officielle et articles
d'ingénierie Lovable (liens en fin de dossier). Les chiffres cités sont
auto-déclarés par Lovable ou rapportés par des tiers, sans échantillon ni
période publiés.

## 1. Ce que fait Lovable

### L'atelier en deux volets

L'éditeur est un espace unique : chat à gauche, **preview vivant à droite**.
Le preview n'est ni une capture ni un rendu final : c'est l'application
réelle, interactive, qui se met à jour pendant que l'agent construit.
L'utilisateur regarde les changements apparaître et clique dans son app comme
un utilisateur final. Preview et app publiée partagent backend et données ;
le preview joue le rôle de staging.

### Le preview vivant et son infrastructure

Le point structurel : **Lovable montre l'app pendant la construction, pas
après**. C'est possible parce que la cible d'écriture de l'agent *est* le
serveur de développement : chaque projet a un dev server Vite persistant dans
le cloud (Lovable déclare plus de 4 000 instances fly.io, un environnement
Node isolé par projet avec la copie complète de l'app). L'agent pousse des
diffs dans ce sandbox ; le HMR de Vite rafraîchit l'iframe sans rechargement.
La boucle perçue est « je demande → je vois », en secondes.

Gestion des ressources : un environnement inactif se met en pause et le
preview affiche « Still building? » avec un bouton « Keep building ». Le live
preview est désactivable par projet (l'utilisateur ne voit alors que la
dernière version complétée).

### La barre de contrôle du preview

- **Device toggle** desktop / tablette / mobile.
- **Sélecteur de pages** : page courante, liste cherchable, saisie directe
  d'un chemin ; le survol montre les cartes de partage réseaux sociaux/SEO.
- **Refresh** ; Shift+refresh **redémarre l'environnement** de preview — la
  réponse standard aux problèmes de chargement.
- **Ouvrir dans un onglet** (authentifié) ; pour un externe, des **preview
  links** partageables — expiration 7 jours en Free/Pro, mot de passe et
  expiration configurable en Business/Enterprise.

### Le toolbar d'édition depuis le preview

Un toolbar flottant permanent sur le preview offre quatre modes : sélection
d'éléments (pointer un composant, décrire le changement en langage naturel,
multi-sélection), édition de texte inline (gratuite jusqu'à 100/jour),
annotation dessinée (formes reconnues, screenshot annoté envoyé à l'agent) et
commentaires épinglés (threads envoyables à l'agent).

Techniquement (article « How we built Visual Edits ») :

- un plugin Vite custom **tague chaque composant JSX généré d'un ID stable**
  à la compilation — le mapping bidirectionnel DOM ↔ source en découle :
  cliquer un élément retrouve le JSX exact qui l'a rendu ;
- le code du projet est synchronisé dans le navigateur comme **AST vivant**
  (Babel/SWC) ; les modifications sont des mutations d'AST, jamais des regex ;
- un **générateur Tailwind côté client** applique les changements de style de
  façon optimiste, avant toute sauvegarde ;
- à la persistance : AST → code propre → diff minimal → push vers le sandbox
  → HMR. Une édition visuelle ne coûte aucun appel LLM.

### Le chat pendant la construction

- Des **cartes d'activité** affichent l'étape en cours et **les fichiers en
  cours de modification** ; cliquer ouvre une **Details view** à deux
  onglets — *Timeline* (chaque étape et appel d'outil) et *Changes* (les
  diffs résultants).
- Toute modification est présentée en **diffs de fichiers + résumés**,
  revisables avant de continuer.
- L'utilisateur peut continuer à écrire : les messages sont repris « au
  prochain point d'arrêt naturel » sans perdre le travail accompli. Boutons
  **Stop** (arrêt immédiat) et **Undo** (retour à l'état précédent) ; les
  crédits consommés sont visibles en cours d'exécution.

### Erreurs et versions

- Quand le preview détecte une erreur, un bouton **« Try to fix »** apparaît,
  gratuit : il scanne les logs et tente une correction (des tiers rapportent
  ~60 % de résolution des cas simples ; chiffre non vérifiable). Un preview
  blanc est le symptôme type d'une erreur d'app.
- **Versioning 2.0** : chaque édition est une version automatique (aucun
  bouton save), historique groupé par date, **bookmarks**, restauration non
  destructive pour le chat (un restore crée une nouvelle carte), et on peut
  sauter au moment de conversation qui a produit une version.

### L'incident diff viewer

Quand Sonnet 3.7 a permis 15+ fichiers modifiés d'un coup, l'initialisation
séquentielle des instances CodeMirror (20–50 ms chacune, avec reflows forcés)
gelait le navigateur 500–1 500 ms. Correctif : **time slicing** — deux
fichiers rendus par lot, 50 ms d'écart, placeholders pour le reste. Déjà en
P1 dans le radar du 26 août ; devient directement pertinent au palier A
ci-dessous.

| Mesure auto-déclarée ou rapportée | Valeur |
|---|---:|
| Instances fly.io servant les projets | > 4 000 |
| Init d'une instance CodeMirror | 20–50 ms |
| Gel du diff viewer avant correctif | 500–1 500 ms |
| Correctif : fichiers par lot / pause | 2 / 50 ms |
| Éditions de texte inline gratuites | 100 / jour |
| Expiration des preview links Free/Pro | 7 jours |

## 2. La décision et la trajectoire en trois paliers

Principe adopté : **le produit d'un run se regarde, il ne se lit pas.** La
trace reste l'évidence d'ingénierie ; l'application vivante devient la
présentation par défaut du résultat, puis du travail en cours. La trajectoire
respecte l'ordre des dépendances déjà arbitrées.

### Palier B d'abord : le result preview v1, inchangé

Le [design consolidé du 28 août](result-preview-design-2026-08-28.md) est la
fondation et ne bouge pas : preview du run **délivré**, launcher unique
détenteur de l'API Docker, copie matérialisée filtrée, runsc, domaine
d'origine séparé, claim one-time, heartbeat de l'interface, quotas. Tout le
reste de ce dossier réutilise cette machinerie ; rien ne la précède.

### Palier A : la progression devient une projection produit

Le pendant Atoma des cartes d'activité de Lovable existe déjà en substance :
la trace live, la sentinelle et la comptabilité de coût par run. Ce qui
manque est une **projection orientée produit** dans le visualiseur :

- « fichiers touchés » en direct, projeté depuis les faits host-owned (les
  arguments des appels d'outils L1 observés par le runtime — jamais depuis la
  prose du modèle) ;
- un résumé borné par phase du protocole (plan → validate → execute →
  validate), avec les diffs bornés au moment de la livraison de phase ;
- le coût du run visible pendant l'exécution (le ledger le porte déjà).

Leçon d'implémentation à importer telle quelle : le rendu des diffs
volumineux se fait par lots avec cession de la main (time slicing), jamais en
une passe bloquante. Hors périmètre à ce palier : les messages utilisateur en
cours de run — un run projet reçoit un objectif, pas une conversation
(différence produit déjà actée dans la revue du 26 août).

### Palier C : le preview du run en vol, par générations de checkpoint

Le rejet du 28 août (« Live preview of a run in flight — races L1 on the same
workspace and ports ») visait le **partage du workspace vivant**, pas la
visibilité en cours de run. La transposition honnête du « je regarde l'app se
construire » de Lovable est la **génération par checkpoint** :

- à des frontières de phase choisies par le superviseur, l'hôte matérialise
  un **snapshot filtré** du workspace de build (la machinerie
  `materializePreviewWorkspace` du design v1 est le point de réutilisation) ;
- chaque snapshot devient une **génération de preview** ordinaire sur le
  substrat v1 : son propre conteneur, sa propre origine, ses propres claims —
  le run n'est jamais rasé, aucun port ni fichier n'est partagé avec L1 ;
- l'interface présente la génération courante avec son horodatage de
  checkpoint (« état à la fin de la phase N »), et la remplace quand la
  suivante est prête — la liveness est perçue par échelons, pas par HMR.

Ce palier exige d'abord le **contrat de snapshot de workspace** différé au
§21 du design v1 (périmètre, coût, rétention, caps — le workspace de build
opérateur reste hors périmètre tant que ce contrat n'existe pas). Il rouvre
aussi les quotas : un preview en vol ajoute de la charge pendant le run ;
les caps v1 (§11) sont à re-mesurer avant d'admettre plusieurs générations
simultanées.

Ce qu'on n'obtient pas et qu'on n'imite pas : le HMR seconde-par-seconde.
Il exigerait que l'agent écrive dans un serveur en marche — exactement ce que
le contrat de nettoyage de `ToolSandbox` et l'isolation interdisent. Les
échelons de checkpoint sont le compromis compatible avec les invariants.

### Candidats d'extension, chacun derrière sa propre revue

- **Liens de preview partageables à expiration** (forme Business de
  Lovable : expiration + mot de passe). Le v1 les rejette sciemment ; s'ils
  reviennent, c'est comme extension du contrat de claims, pas comme
  affaiblissement.
- **Commentaires épinglés sur le preview → objectif du run suivant.** La
  seule forme d'« édition depuis le preview » compatible avec Atoma : aucune
  mutation du workspace délivré ; le commentaire structuré (élément visé,
  texte, capture) devient une entrée attestée du prochain run, qui part déjà
  de `previousDeliveredWorkspace`.
- **Présentation de l'historique des runs comme versions** : vue groupée par
  date, bookmarks, « repartir du run N » comme analogue du restore — non
  destructif par construction, le corpus de runs étant déjà versionné.
- **Analogue de « Try to fix »** : une action bornée « relancer avec
  l'évidence d'échec » nourrie par les faits host-owned (erreurs d'outil,
  verdicts, probes), jamais par les logs bruts de l'app dans le navigateur
  (frontière d'observabilité v1, §16). À instruire avec le dossier
  `frictionClaim` de la revue du 26 août, pas avant.

## 3. Les invariants qui ne bougent pas

- Le preview **ne mute jamais** le workspace délivré ni le workspace de build ;
  il sert des copies matérialisées, filtrées, jetables.
- Le launcher reste le seul détenteur de l'API Docker ; runsc requis en
  production ; egress default-deny approuvé par un admin d'organisation.
- La vérification reste read-only ; l'entrée d'exécution vient des faits
  observés par l'hôte, jamais de la prose du modèle, et aucun `run_shell`
  n'est rejoué.
- Les outils restent à L1 ; le preview n'est pas un run (pas de lease MCP,
  pas de registry/skills/ledger).
- Le trafic de l'app ne compte jamais comme activité (D6) : un code abandonné
  ne se maintient pas en vie, en vol comme délivré.
- Un canvas GPU unique ; le fallback MUI reste gelé ; copie produit dans
  `en.json` seulement.

## 4. Ce qu'on n'importe pas

- **Le dev server persistant toujours chaud par projet** : c'est le poste de
  coût structurel de Lovable ; Atoma garde l'éphémère à la demande avec
  idle/hard TTL (la pause « Still building? » de Lovable converge d'ailleurs
  avec le heartbeat D6).
- **Le toolbar d'édition visuelle complet** : il suppose tagging JSX à la
  compilation, AST côté client et push vers un serveur en marche — une chaîne
  entière que les invariants refusent, et Atoma ne garantit pas que le
  délivrable soit du React/Tailwind.
- **« Try to fix » branché sur les logs bruts** dans le navigateur (§16).
- **L'URL de preview réutilisable** comme défaut (claim one-time d'abord).
- Le model roulette et les autres exclusions déjà actées le 26 août.

## 5. Ordre proposé

1. Livrer le result preview v1 tel que consolidé (P0 launcher → P5 ops).
2. Palier A : projection « fichiers touchés » + résumés de phase + coût live
   dans le visualiseur ; rendu des diffs par time slicing ; mesurer avant
   d'élargir.
3. Écrire le contrat de snapshot de workspace (revue dédiée : périmètre,
   caps, rétention, coût mesuré par checkpoint sur des runs réels).
4. Palier C : générations de checkpoint sur le substrat v1, derrière un flag,
   quotas re-mesurés ; critère d'arrêt explicite si le coût de snapshot ou la
   pression disque dégrade les runs.
5. Ensuite seulement, instruire les candidats d'extension, un par un.

## Sources

- [Preview and test your app — docs Lovable](https://docs.lovable.dev/features/projects/preview)
- [Edit from the preview — docs Lovable](https://docs.lovable.dev/features/design)
- [Build mode — docs Lovable](https://docs.lovable.dev/features/agent-mode)
- [How we built the Visual Edits feature — blog Lovable](https://lovable.dev/blog/visual-edits)
- [Anthropic Sonnet 3.7 broke our diff viewer — blog Lovable](https://lovable.dev/blog/anthropic-sonnet-3-7-lovable-diff-viewer)
- [Introducing Versioning 2.0 — blog Lovable](https://lovable.dev/blog/versioning-with-lovable-two-point-zero)
- [Version history — docs Lovable](https://docs.lovable.dev/features/projects/history)
- [Error loops & bug fixes — FAQ Lovable](https://lovable.dev/faq/ai-agent/errors)
- [Architecture of AI app builders — beam.cloud (tiers)](https://www.beam.cloud/blog/agentic-apps)
