# Prévisualiser un run en vol — décision et contrat

> Décision de conception · Atoma · 2 septembre 2026
>
> Statut : **décidée et implémentée**. Elle complète le
> [design result preview du 28 août](result-preview-design-2026-08-28.md), dont
> le §18 rejetait le preview d'un run en vol, et réalise le palier C de la
> [direction du 31 août](live-preview-direction-2026-08-31.md).

## 1. Ce que le rejet visait vraiment

Le design v1 écarte « Live preview of a run in flight » avec une raison en six
mots : *races L1 on the same workspace and ports*. En la déroulant, ce sont
**deux** objections distinctes, et une seule survit.

**Les ports — objection caduque.** Elle vise la réutilisation du serveur du run
de build. Nous ne le réutilisons pas : le preview démarre son **propre**
conteneur, sur son **propre** réseau interne, où l'application écoute le port
8080 que le profil lui impose. Le `start_node_server` de L1 lie un port dans le
sandbox du run, invisible d'ici. Il n'y a pas de ressource partagée à disputer.

**Le workspace — objection réelle, mais mal nommée.** Nous ne « courons pas
après » L1 : nous ne faisons que **lire**, et nous copions. Le risque est la
copie **déchirée** — un fichier à moitié écrit, un `package.json` sans la
dépendance qu'il déclare, un `index.html` référençant un script qui n'existe
pas encore.

## 2. Le renversement qui débloque tout

La copie déchirée n'est pas un défaut à éliminer : c'est **la nature de ce
qu'on regarde**. Un membre qui demande à voir un run en vol demande à voir du
travail inachevé.

Et le contrat de readiness du v1 filtre déjà l'essentiel :

1. le classifieur ne trouve pas d'entrée exécutable → `not-runnable`, rien ne
   démarre ;
2. l'application ne démarre pas → `server-exited`, tout est démonté ;
3. elle démarre mais n'émet pas son marqueur → `readiness-timeout` ;
4. elle répond au marqueur mais pas à la sonde → `server-exited`.

Ce qui passe ces quatre filtres est une application qui **démarre et répond**.
Qu'elle soit incomplète est exactement l'information demandée.

Le preview en vol est donc **le preview d'un instantané pris à un moment,
étiqueté par ce moment**. Rien de plus, et surtout rien qui prétende être
davantage.

## 3. Le contrat

| Règle | Pourquoi |
|---|---|
| Le workspace du run n'est **jamais** touché : lecture seule, copie filtrée, `lstat` + `O_NOFOLLOW`. | C'est le livrable en cours de construction et la graine du run suivant. |
| Chaque ouverture prend un **nouvel** instantané et donc une **nouvelle génération** — donc une nouvelle origine, de nouveaux claims, les anciens révoqués. | Un membre qui rouvre veut l'état actuel, pas celui d'il y a dix minutes. Et c'est ce qui empêche un service worker d'une génération de contrôler la suivante. |
| La classification porte sur **la copie**, jamais sur le workspace vivant. | Des octets stables. Classifier une cible qui bouge, c'est décrire un état qui n'a peut-être jamais existé. |
| Aucune ligne de **descripteur** n'est écrite. | Un descripteur est immuable et décrit ce que la **livraison** a observé. Un instantané est un moment ; le graver en ferait un mensonge sur le run. |
| L'instance porte `snapshot_at` et `source`. | Une surface qui ne peut pas dire « état à 14:32 » laisse le membre croire qu'il voit le présent. |
| Le run doit être `running`. | À la livraison, le preview du livré prend le relais — il a un descripteur, lui. |
| Les mêmes quotas, les mêmes bornes d'inactivité, la même révocation. | Un preview en vol est un preview. Rien ici n'est un chemin parallèle. |

## 4. Ce qui a été écarté

- **Un point de quiescence coopératif** — le run signalerait une frontière de
  phase et l'hôte copierait là. Cela met de la logique de preview dans le
  chemin d'exécution, et le flush de trace étant asynchrone et throttlé, le
  signal arrive **après** que la phase suivante a commencé : la garantie serait
  décorative.
- **Un instantané de système de fichiers** (overlayfs, btrfs, ZFS). Atomique et
  correct, mais c'est une dépendance de déploiement pour un gain qui, d'après
  §2, n'est pas celui qu'on croit.
- **Faire copier le run lui-même.** Coût par checkpoint payé par le tenant, et
  une seconde définition de la politique de copie.

## 5. Ce que cela ne donne pas

Ce n'est pas du rechargement à chaud. Lovable montre l'app se construire parce
que sa cible d'écriture **est** un serveur de développement vivant ; ici la
livraison de L1 est un sandbox détruit en fin de run, et le contrat de nettoyage
de `ToolSandbox` l'exige. La granularité est l'échelon d'ouverture, pas le
HMR — et c'est le compromis compatible avec les invariants, tel que la revue du
31 août l'avait déjà posé.

Repères : [`src/preview/AGENTS.md`](../src/preview/AGENTS.md),
[`src/preview/manager.ts`](../src/preview/manager.ts).
