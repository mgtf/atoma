import { init as initChart, use as useChart } from 'echarts/core';
import { ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

useChart([
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/* ==========================================================================
 * i18n — minimal core, i18next-COMPATIBLE surface.
 *
 * The visualizer is now Vite-bundled, but this deliberately tiny core remains
 * sufficient for two local catalogs and avoids adding runtime framework
 * machinery. Its SURFACE matches i18next: `t('a.b.c', { count: 3 })`, `{{var}}`
 * interpolation, `_plural` key suffix, dotted namespaces. Swapping in the
 * real library later is a drop-in — the catalogs and every call site stay
 * exactly as they are.
 *
 * Adding a locale: drop a catalog next to `fr` and it appears in the picker.
 * English is the SOURCE and the default: a French browser still gets English
 * unless the user opts in (persisted in localStorage, or `?lang=fr`).
 * A missing key renders the key itself — loud on purpose, so a gap is
 * visible in development instead of silently blanking a label.
 * ====================================================================== */
const I18N_CATALOGS = {
  en: {
    'lang.name': 'English',
    'nav.runs': 'Runs',
    'nav.registry': 'Registry',
    'nav.skills': 'Skills',
    'nav.burnin': 'Burn-in',
    'ev.reasoning': 'Reasoning / diagnostic',
    'ev.trustFastPath': 'Trust fast-path',
    'ev.whyHere': 'Why is this here?',
    'ev.systemPrompt': 'System prompt',
    'ev.llmCall': 'LLM call',
    'ev.stopReason': 'Stop reason',
    'ev.mergeInstruction': 'Merge instruction',
    'ev.expectedOutput': 'Expected output',
    'ev.registryMutation': 'Registry mutation',
    'burnin.lastRun': 'last run:',
    'registry.currentVersion': 'Current version',
    'common.toggle': '▸ show / hide',
    'common.toggleRawJson': '▸ show / hide raw JSON',
    'common.tools': 'Tools',
    'common.reason': 'Reason',
    'common.current': 'current',
    'common.link': 'Link',
    'registry.atom': 'Atom',
    'skill.title': 'Skill',
    'skill.namespace': 'L1 namespace',
    'skill.kind': 'Kind',
    'skill.description': 'Description',
    'skill.whenToUse': 'When to use',
    'skill.counters': 'Counters',
    'skill.body': 'Body',
    'skill.body.recipe': 'Body — markdown recipe',
    'common.empty': '(empty)',
    'skill.share.title': 'Cross-organisation review',
    'skill.share.blocked': '✗ Blocked — a reviewer would reject this as it stands',
    'skill.share.review-required': '○ Nothing mechanical found — a human must still read it',
    'skill.share.not-shareable': '· Local only — coupled to this deployment, not a portable recipe',
    'nav.launch': 'Launch',
    'pane.selectLaunch': 'Pick a family to see how to phrase its goal.',
    'launch.family': 'Task family',
    'launch.goal': 'Goal',
    'launch.goal.placeholder': 'Describe one runnable artefact and the behaviour it must have…',
    'launch.examples': 'Examples (click to fill)',
    'launch.help': 'How to phrase a good goal',
    'launch.command': 'Command to run',
    'launch.copy': 'Copy',
    'launch.copied': 'Copied',
    'launch.empty': 'Type a goal to get the command.',
    'nav.refresh': 'Refresh',
    'nav.refresh.title': 'Reload the list',
    'nav.selectRun': 'Select a run',
    'nav.selectRegistry': 'Select a registry',
    'nav.filterAtoms': 'Filter atoms…',
    'nav.filterSkills': 'Filter skills…',
    'nav.language': 'Language',

    'common.loading': 'Loading…',
    'common.none': '— none —',
    'common.networkError': 'Network error.',
    'common.duration': 'duration {{value}}',
    'common.emptyDash': '—',

    'pane.selectEvent': 'Select an event on the left to see its detail.',
    'pane.selectAtom': 'Select an atom on the left to see its detail.',
    'pane.selectSkill': 'Select a skill on the left to see its detail.',
    'pane.selectBurnin': 'Click a table row to open that run\'s trace.',

    'runs.none': 'No run recorded',
    'runs.notFound': 'Run not found.',
    'runs.picker': 'Runs (newest → oldest)',
    'runs.flag.cancelled': '✕ cancelled',
    'runs.flag.live': '● LIVE',
    'runs.flag.abandoned': '⚠ abandoned',
    'runs.flag.fallback': '⚠ fallback',
    'runs.calls': '{{count}} calls',

    'summary.duration': 'Duration',
    'summary.llmCalls': 'LLM calls',
    'summary.tokens': 'Tokens (in/out)',
    'summary.cacheHit': 'Cache hit',
    'summary.cost': 'Cost',
    'summary.fallback': 'Fallback',
    'summary.yes': 'yes',
    'summary.no': 'no',
    'summary.freePhases': '⚡ $0.00 phases',
    'summary.freePhases.value': '{{count}} (deterministic dispatch)',
    'summary.cachedRouting': '⚡ Cached routing',
    'summary.cachedRouting.value': '{{count}} decision(s) with no LLM call',
    'summary.abandoned': '⚠ Abandoned run',
    'summary.abandoned.value': 'no activity for >12 min, no endedAt',
    'summary.lifecycle': 'Lifecycle',
    'summary.lifecycle.learned': '📖 {{count}} skill(s) learned',
    'summary.lifecycle.promoted': '⚡ {{count}} compilation(s)',
    'summary.lifecycle.demoted': '🛡️ {{count}} demotion(s)',
    'summary.lifecycle.revised': '✏️ {{count}} revision(s)',
    'summary.lifecycle.recovery': '⟳ {{count}} mid-run recovery(ies)',
    'summary.guards': 'Guardrails',
    'summary.guards.quarantined': '⛔ {{count}} skill(s) quarantined',
    'summary.guards.withheld': '⊘ {{count}} credit(s) withheld',
    'summary.degraded': '⚠ Degraded run — the supervision loop escalated and the parent took over through its fallback. The deliverable is not a true success of the protocol.',
    'summary.live': '● LIVE — the run is still going, this view refreshes every {{seconds}} s.',
    'summary.error': 'Error: {{message}}',

    'result.title': 'Result',
    'result.groundTruth': 'ground truth',
    'result.byPhase': 'phase breakdown ({{count}} phases)',
    'result.byPhase.one': 'phase breakdown (1 phase)',
    'result.phase': 'PHASE {{n}} · {{atom}}',

    'lanes.l3': 'L3 · cells',
    'lanes.l2': 'L2 · molecules',
    'lanes.l1': 'L1 · elements',
    'lanes.legend.new': 'created/branched during this run',
    'lanes.legend.patched': 'patched during this run',
    'lanes.legend.existing': 'pre-existing (reused)',
    'lanes.legend.hint': '— click an atom to see its full prompt',

    'filters.all': 'All',
    'filters.llm': 'LLM',
    'filters.tools': 'Tools',
    'filters.trust': 'Trust',
    'filters.skills': 'Skills',
    'filters.cache': 'Cache',
    'filters.registry': 'Registry',
    'filters.allRoles': 'All roles',
    'filters.allBranches': 'all branches',
    'filters.branch': 'branch {{id}}',
    'filters.fanoutBranch': 'fan-out branch {{id}}',
    'filters.noMatch': 'No event matches the filter.',

    'now.title': 'Right now',
    'now.elapsed': '⏱ {{seconds}}s',
    'now.tooLong': ' — unusually long?',
    'now.doing.plan': '{{actor}} is deciding how to break the task down.',
    'now.doing.execute': '{{actor}} is doing the work — writing files, running commands, checking the result.',
    'now.doing.prefilter': '{{actor}} is picking which existing child should handle this.',
    'now.doing.validatePlan': '{{actor}} is checking {{child}}\'s plan before any work starts.',
    'now.doing.validateResult': '{{actor}} is checking what {{child}} produced.',
    'now.doing.fallback': '{{actor}} took over and is doing the work itself (fallback).',
    'now.doing.skill': 'A skill recipe is being distilled, compiled or revised (supervisor-tier call).',
    'now.doing.unknown': '{{actor}} has a call in flight.',
    'now.activity': '{{count}} tool calls so far · last: {{tool}} ({{ago}}s ago)',
    'now.activity.one': '1 tool call so far · last: {{tool}} ({{ago}}s ago)',
    'now.activity.none': 'no tool call yet — waiting on the model.',

    'marker.start': '▶ Run start',
    'marker.end': '■ Run end',
    'marker.degraded': '⚠ Run end — degraded (delivered via fallback)',
    'marker.cancelled': '✕ Run cancelled (user interrupt)',
    'marker.error': '✕ Run end — error',
    'marker.abandoned': '⚠ Run abandoned',
    'marker.abandoned.hint': 'no activity since the last trace — no end recorded',

    'event.interrupted': '✕ interrupted — never completed',
    'event.error': 'error',
    'event.trust.fastPath': 'fast-path (no LLM call)',
    'event.cache.label': '⚡ cache',
    'event.cache.free': '0 calls · $0.00',
    'event.cache.skipped': 'call avoided',
    'event.prefilter.cheapTier': 'cheap tier by design',
    'event.skill.direct': '⚡ direct',
    'event.skill.recovery': '⟳ recovery',
    'event.skill.quarantine': '⛔ quarantine',
    'event.skill.creditWithheld': '⊘ credit withheld',
    'event.skill.zeroLlm': '0 LLM calls · $0.00',
    'event.skill.triggeredMidRun': 'triggered mid-run',
    'event.skill.score': ' · score {{score}}',

    'outcome.reuse': '→ reuses {{target}}',
    'outcome.confidence': '(confidence {{level}})',
    'outcome.escalate': '↑ escalate',
    'outcome.approved': '✓ approved',
    'outcome.rejected': '✕ rejected',
    'outcome.scope': 'scope {{scope}}',
    'outcome.recipeIgnored': 'recipe ignored → credit withheld',
    'outcome.recipeIgnored.title': 'The validator observed that the run did not follow the injected skill: its counters stay put.',
    'outcome.recipeFollowed': 'recipe followed',
    'outcome.recipeFollowed.title': 'The injected skill did drive the run — its counters are credited.',

    'detail.cache.title': 'Routing decision served from cache',
    'detail.cache.avoidedModel': 'model avoided: {{model}}',
    'detail.cache.decision': 'Decision',
    'detail.cache.reasoning': 'Reasoning (of the original decision)',
    'detail.cache.explain': 'The prefilter runs at temperature 0 with a constant prompt: for identical inputs (task × catalog × exclusions × model) the decision is a pure function, so it is replayed from disk. Zero tokens, zero latency — and under claude-cli, zero subprocess.',
    'detail.prompts': 'Prompts & response',
    'detail.noResponse': '(no response — call errored)',
    'detail.by': 'by {{name}}',

    'skillOp.match': 'Skill match (Haiku skill-prefilter)',
    'skillOp.inject': 'Skill body injected into the L1 prompt',
    'skillOp.learn': 'Skill auto-distilled (Sonnet)',
    'skillOp.update': 'Skill body revised after failure (Sonnet)',
    'skillOp.success': 'Success counter incremented',
    'skillOp.failure': 'Failure counter incremented',
    'skillOp.promote': 'Skill promoted llm → script (Sonnet compile)',
    'skillOp.demote': 'Skill demoted script → llm (fallback restored)',
    'skillOp.direct': 'Script executed via deterministic dispatch (0 LLM calls)',
    'skillOp.quarantine': 'Skill QUARANTINED by the static scan',
    'skillOp.creditWithheld': 'Counters NOT changed (recipe not followed)',

    'registry.none': 'No registry configured',
    'registry.noneFound': 'No SQLite database found. Start the server with `--db path/to/atoma.db`.',
    'registry.missingFile': 'File missing — no data to show',
    'registry.createdAt': 'Created at',
    'registry.createdBy': 'Created by',
    'registry.updatedAt': 'Updated at',
    'registry.updatedBy': 'Updated by',
    'registry.model': 'Model',
    'registry.successFailure': 'Successes / failures',
    'registry.attachedSkills': 'Attached skills',
    'registry.noSkillsForAtom': '— no skill recorded for this atom —',
    'registry.openSkill': '→ open the full skill',
    'registry.versionHistory': 'Version history ({{count}} archived)',
    'registry.origin.created': 'created during this run',
    'registry.origin.branched': 'branched during this run',
    'registry.origin.patched': 'patched during this run',
    'registry.origin.existing': 'pre-existing (reused as-is)',
    'registry.origin.noSnapshot': 'referenced without snapshot',
    'registry.noAtomMatch': '— no atom matches —',
    'registry.legendHint': '— click an atom to see its full prompt + version history',

    'skills.none': 'No skill recorded. Set ATOMA_SKILLS_DIR or run with ATOMA_SKILL_LEARN=1.',
    'skills.noneYet': 'No skill — the next run with auto-distillation will create one.',
    'skills.subtitle': 'Recipes persisted under each L1 — Haiku match, injection at plan time, trust counters.',
    'skills.legendHint': '— click a skill to see its full body',
    'skills.totalSuccess': 'Total successes',
    'skills.totalFailure': 'Total failures',
    'skills.endpointUnavailable': 'Skills endpoint unavailable.',
    'skills.historyInRun': 'History in this run ({{count}})',

    'burnin.runsAxis': 'runs (chronological order = experience) →',
    'burnin.delivered': '{{count}} delivered · ',
    'burnin.compileErrors': 'compile error×{{count}}',
    'burnin.refusals': 'refusal×{{count}}',
    'burnin.unavailable': 'Burn-in API unavailable.',
    'burnin.empty': 'No measurements — run <code>npm run burnin</code> (expected CSV: {{path}})',
    'burnin.family': 'Family',
    'burnin.outcome': 'Outcome',
    'burnin.timeRange': 'Time range',
    'burnin.all': 'All',
    'burnin.deliveredOnly': 'Delivered',
    'burnin.failedOnly': 'Failed / error',
    'burnin.allTime': 'All time',
    'burnin.last24h': 'Last 24 hours',
    'burnin.last7d': 'Last 7 days',
    'burnin.last30d': 'Last 30 days',
    'burnin.resetZoom': 'Reset time zoom',
    'burnin.selected': '{{count}} run(s) in the selected range',
    'burnin.runsSelected': 'Runs selected',
    'burnin.deliveryRate': 'Delivery rate',
    'burnin.medianCost': 'Median cost',
    'burnin.p90Duration': 'P90 duration',
    'burnin.familyBreakdown': 'Families in selection',
    'burnin.rowsTitle': 'Runs (newest → oldest)',
    'burnin.page': 'Page {{current}} / {{total}}',
    'burnin.previous': 'Previous',
    'burnin.next': 'Next',
    'burnin.metric.models': 'LLM calls by model tier: Opus / Sonnet / Haiku / other routed providers.',
    'burnin.metric.deterministic': 'Zero-LLM deterministic script phases completed successfully.',
    'burnin.metric.learned': 'Task-level skills learned after an approved novel run.',
    'burnin.metric.recovery': 'Event-driven recovery skills learned after a recovered rejection.',
    'burnin.metric.promotions': 'LLM recipes compiled into script candidates.',
    'burnin.metric.refusals': 'Compiler decisions that the recipe is not safely scriptable.',
    'burnin.metric.compileErrors': 'Compiler transport errors or timeouts before a decision.',
    'burnin.metric.demotions': 'Script skills demoted back to LLM recipes after deterministic failures.',
    'burnin.metric.fallbacks': 'Deterministic dispatch contract failures that fell back to the validated LLM loop.',
  },
  fr: {
    'lang.name': 'Français',
    'nav.runs': 'Runs',
    'nav.registry': 'Registre',
    'nav.skills': 'Skills',
    'nav.burnin': 'Burn-in',
    'ev.reasoning': 'Raisonnement / diagnostic',
    'ev.trustFastPath': 'Voie rapide de confiance',
    'ev.whyHere': 'Pourquoi est-ce là ?',
    'ev.systemPrompt': 'Prompt système',
    'ev.llmCall': 'Appel LLM',
    'ev.stopReason': 'Raison d\'arrêt',
    'ev.mergeInstruction': 'Instruction de fusion',
    'ev.expectedOutput': 'Sortie attendue',
    'ev.registryMutation': 'Mutation du registre',
    'burnin.lastRun': 'dernier run :',
    'registry.currentVersion': 'Version actuelle',
    'common.toggle': '▸ afficher / masquer',
    'common.toggleRawJson': '▸ afficher / masquer le JSON brut',
    'common.tools': 'Outils',
    'common.reason': 'Raison',
    'common.current': 'actuel',
    'common.link': 'Lien',
    'registry.atom': 'Atome',
    'skill.title': 'Skill',
    'skill.namespace': 'Espace L1',
    'skill.kind': 'Genre',
    'skill.description': 'Description',
    'skill.whenToUse': 'Quand l\'utiliser',
    'skill.counters': 'Compteurs',
    'skill.body': 'Corps',
    'skill.body.recipe': 'Corps — recette markdown',
    'common.empty': '(vide)',
    'skill.share.title': 'Revue inter-organisations',
    'skill.share.blocked': '✗ Bloqué — un relecteur le refuserait en l\'état',
    'skill.share.review-required': '○ Rien de mécanique détecté — un humain doit quand même le lire',
    'skill.share.not-shareable': '· Local uniquement — couplé à ce déploiement, pas une recette portable',
    'nav.launch': 'Lancer',
    'pane.selectLaunch': 'Choisis une famille pour voir comment formuler son objectif.',
    'launch.family': 'Famille de tâche',
    'launch.goal': 'Objectif',
    'launch.goal.placeholder': 'Décris un artefact exécutable et le comportement attendu…',
    'launch.examples': 'Exemples (clic pour remplir)',
    'launch.help': 'Comment formuler un bon objectif',
    'launch.command': 'Commande à lancer',
    'launch.copy': 'Copier',
    'launch.copied': 'Copié',
    'launch.empty': 'Saisis un objectif pour obtenir la commande.',
    'launch.help.build': 'Décris UN artefact exécutable et le comportement attendu. Précise sa forme — une page index.html unique, un serveur HTTP Node, ou un script CLI / fichier de config / document — puis le comportement concret et les contraintes fermes (taille de grille, routes et codes de statut, arguments et codes de sortie). Reste petit et autonome : le workspace démarre vide, donc tout ce dont le run a besoin doit pouvoir être créé par lui. Ne nomme NI outils, NI phases, NI étapes de vérification — le planificateur les déduit de la nature de l\'artefact, et les expliciter est une cause mesurée de phases gaspillées. La vérification est automatique et suit la forme : une page est chargée dans un navigateur headless, un serveur reçoit de vraies requêtes, une CLI est réellement invoquée.',
    'nav.refresh': 'Rafraîchir',
    'nav.refresh.title': 'Recharger la liste',
    'nav.selectRun': 'Sélectionner un run',
    'nav.selectRegistry': 'Sélectionner un registre',
    'nav.filterAtoms': 'Filtrer les atomes…',
    'nav.filterSkills': 'Filtrer les skills…',
    'nav.language': 'Langue',

    'common.loading': 'Chargement…',
    'common.none': '— aucun —',
    'common.networkError': 'Erreur réseau.',
    'common.duration': 'durée {{value}}',
    'common.emptyDash': '—',

    'pane.selectEvent': 'Sélectionne un évènement à gauche pour en voir le détail.',
    'pane.selectAtom': 'Sélectionne un atome à gauche pour en voir le détail.',
    'pane.selectSkill': 'Sélectionne une skill à gauche pour en voir le détail.',
    'pane.selectBurnin': 'Clique une ligne du tableau pour ouvrir la trace du run correspondant.',

    'runs.none': 'Aucun run enregistré',
    'runs.notFound': 'Run introuvable.',
    'runs.picker': 'Runs (récent → ancien)',
    'runs.flag.cancelled': '✕ annulé',
    'runs.flag.live': '● LIVE',
    'runs.flag.abandoned': '⚠ abandonné',
    'runs.flag.fallback': '⚠ fallback',
    'runs.calls': '{{count}} appels',

    'summary.duration': 'Durée',
    'summary.llmCalls': 'Appels LLM',
    'summary.tokens': 'Tokens (in/out)',
    'summary.cacheHit': 'Cache hit',
    'summary.cost': 'Coût',
    'summary.fallback': 'Fallback',
    'summary.yes': 'oui',
    'summary.no': 'non',
    'summary.freePhases': '⚡ Phases $0.00',
    'summary.freePhases.value': '{{count}} (dispatch déterministe)',
    'summary.cachedRouting': '⚡ Routage caché',
    'summary.cachedRouting.value': '{{count}} décision(s) sans appel LLM',
    'summary.abandoned': '⚠ Run abandonné',
    'summary.abandoned.value': 'aucune activité depuis >12 min, sans endedAt',
    'summary.lifecycle': 'Cycle de vie',
    'summary.lifecycle.learned': '📖 {{count}} skill(s) appris',
    'summary.lifecycle.promoted': '⚡ {{count}} compilation(s)',
    'summary.lifecycle.demoted': '🛡️ {{count}} démotion(s)',
    'summary.lifecycle.revised': '✏️ {{count}} révision(s)',
    'summary.lifecycle.recovery': '⟳ {{count}} récupération(s) mid-run',
    'summary.guards': 'Garde-fous',
    'summary.guards.quarantined': '⛔ {{count}} skill(s) en quarantaine',
    'summary.guards.withheld': '⊘ {{count}} crédit(s) retenu(s)',
    'summary.degraded': '⚠ Run dégradé — la boucle de supervision a escaladé et le parent a pris la main via son fallback. Le livrable n\'est pas un vrai succès du protocole.',
    'summary.live': '● LIVE — le run est encore en cours, cette vue se rafraîchit toutes les {{seconds}} s.',
    'summary.error': 'Erreur : {{message}}',

    'result.title': 'Résultat',
    'result.groundTruth': 'ground truth',
    'result.byPhase': 'détail par phase ({{count}} phases)',
    'result.byPhase.one': 'détail par phase (1 phase)',
    'result.phase': 'PHASE {{n}} · {{atom}}',

    'lanes.l3': 'L3 · cellules',
    'lanes.l2': 'L2 · molécules',
    'lanes.l1': 'L1 · éléments',
    'lanes.legend.new': 'créé/branché pendant ce run',
    'lanes.legend.patched': 'patché pendant ce run',
    'lanes.legend.existing': 'préexistant (réutilisé)',
    'lanes.legend.hint': '— clique sur un atome pour voir son prompt complet',

    'filters.all': 'Tous',
    'filters.llm': 'LLM',
    'filters.tools': 'Tools',
    'filters.trust': 'Trust',
    'filters.skills': 'Skills',
    'filters.cache': 'Cache',
    'filters.registry': 'Registry',
    'filters.allRoles': 'Tous rôles',
    'filters.allBranches': 'toutes branches',
    'filters.branch': 'branche {{id}}',
    'filters.fanoutBranch': 'branche de fan-out {{id}}',
    'filters.noMatch': 'Aucun évènement ne correspond au filtre.',

    'now.title': 'En ce moment',
    'now.elapsed': '⏱ {{seconds}}s',
    'now.tooLong': ' — anormalement long ?',
    'now.doing.plan': '{{actor}} décide comment découper la tâche.',
    'now.doing.execute': '{{actor}} fait le travail — écrit des fichiers, lance des commandes, vérifie le résultat.',
    'now.doing.prefilter': '{{actor}} choisit quel enfant existant doit s\'en charger.',
    'now.doing.validatePlan': '{{actor}} contrôle le plan de {{child}} avant tout travail.',
    'now.doing.validateResult': '{{actor}} contrôle ce que {{child}} a produit.',
    'now.doing.fallback': '{{actor}} a repris la main et fait le travail lui-même (fallback).',
    'now.doing.skill': 'Une recette de skill est en cours de distillation, compilation ou révision (appel de niveau superviseur).',
    'now.doing.unknown': '{{actor}} a un appel en vol.',
    'now.activity': '{{count}} appels outil jusqu\'ici · dernier : {{tool}} (il y a {{ago}}s)',
    'now.activity.one': '1 appel outil jusqu\'ici · dernier : {{tool}} (il y a {{ago}}s)',
    'now.activity.none': 'aucun appel outil encore — en attente du modèle.',

    'marker.start': '▶ Début du run',
    'marker.end': '■ Fin du run',
    'marker.degraded': '⚠ Fin du run — dégradé (livré via fallback)',
    'marker.cancelled': '✕ Run annulé (interruption utilisateur)',
    'marker.error': '✕ Fin du run — erreur',
    'marker.abandoned': '⚠ Run abandonné',
    'marker.abandoned.hint': 'aucune activité depuis la dernière trace — pas de fin enregistrée',

    'event.interrupted': '✕ interrompu — jamais terminé',
    'event.error': 'erreur',
    'event.trust.fastPath': 'fast-path (aucun appel LLM)',
    'event.cache.label': '⚡ cache',
    'event.cache.free': '0 appel · $0.00',
    'event.cache.skipped': 'appel évité',
    'event.prefilter.cheapTier': 'tier bon marché, par conception',
    'event.skill.direct': '⚡ direct',
    'event.skill.recovery': '⟳ recovery',
    'event.skill.quarantine': '⛔ quarantaine',
    'event.skill.creditWithheld': '⊘ crédit retenu',
    'event.skill.zeroLlm': '0 appel LLM · $0.00',
    'event.skill.triggeredMidRun': 'déclenchée mid-run',
    'event.skill.score': ' · score {{score}}',

    'outcome.reuse': '→ réutilise {{target}}',
    'outcome.confidence': '(confiance {{level}})',
    'outcome.escalate': '↑ escalade',
    'outcome.approved': '✓ approuvé',
    'outcome.rejected': '✕ rejeté',
    'outcome.scope': 'scope {{scope}}',
    'outcome.recipeIgnored': 'recette ignorée → crédit retenu',
    'outcome.recipeIgnored.title': 'Le validateur a observé que le run n\'a pas suivi la skill injectée : ses compteurs ne bougent pas.',
    'outcome.recipeFollowed': 'recette suivie',
    'outcome.recipeFollowed.title': 'La skill injectée a bien piloté le run — ses compteurs sont crédités.',

    'detail.cache.title': 'Décision de routage servie par le cache',
    'detail.cache.avoidedModel': 'modèle évité : {{model}}',
    'detail.cache.decision': 'Décision',
    'detail.cache.reasoning': 'Raisonnement (de la décision d\'origine)',
    'detail.cache.explain': 'Le prefilter tourne à température 0 avec un prompt constant : pour des entrées identiques (tâche × catalogue × exclusions × modèle) la décision est une fonction pure, donc rejouée depuis le disque. Zéro token, zéro latence — et sous claude-cli, zéro sous-processus.',
    'detail.prompts': 'Prompts & réponse',
    'detail.noResponse': '(aucune réponse — appel en erreur)',
    'detail.by': 'par {{name}}',

    'skillOp.match': 'Skill match (skill-prefilter Haiku)',
    'skillOp.inject': 'Skill body injecté dans le prompt L1',
    'skillOp.learn': 'Skill auto-distillée (Sonnet)',
    'skillOp.update': 'Skill body révisé après échec (Sonnet)',
    'skillOp.success': 'Compteur succès incrémenté',
    'skillOp.failure': 'Compteur échec incrémenté',
    'skillOp.promote': 'Skill promue llm → script (compile Sonnet)',
    'skillOp.demote': 'Skill rétrogradée script → llm (fallback restauré)',
    'skillOp.direct': 'Script exécuté en dispatch déterministe (0 appel LLM)',
    'skillOp.quarantine': 'Skill mise en QUARANTAINE par le scan statique',
    'skillOp.creditWithheld': 'Compteurs NON modifiés (recette non suivie)',

    'registry.none': 'Aucun registre configuré',
    'registry.noneFound': 'Aucune base SQLite trouvée. Lance le serveur avec `--db path/to/atoma.db`.',
    'registry.missingFile': 'Fichier absent — aucune donnée à afficher',
    'registry.createdAt': 'Créé le',
    'registry.createdBy': 'Créé par',
    'registry.updatedAt': 'Mis à jour',
    'registry.updatedBy': 'Modifié par',
    'registry.model': 'Modèle',
    'registry.successFailure': 'Succès / échecs',
    'registry.attachedSkills': 'Skills attachées',
    'registry.noSkillsForAtom': '— aucune skill enregistrée pour cet atome —',
    'registry.openSkill': '→ ouvrir la skill complète',
    'registry.versionHistory': 'Historique des versions ({{count}} archivée(s))',
    'registry.origin.created': 'créé pendant ce run',
    'registry.origin.branched': 'branché pendant ce run',
    'registry.origin.patched': 'patché pendant ce run',
    'registry.origin.existing': 'préexistant (réutilisé tel quel)',
    'registry.origin.noSnapshot': 'référencé sans snapshot',
    'registry.noAtomMatch': '— aucun atome ne correspond —',
    'registry.legendHint': '— clique sur un atome pour voir son prompt complet + l\'historique des versions',

    'skills.none': 'Aucune skill enregistrée. Définis ATOMA_SKILLS_DIR ou lance un run avec ATOMA_SKILL_LEARN=1.',
    'skills.noneYet': 'Aucune skill — la prochaine run avec auto-distillation en créera.',
    'skills.subtitle': 'Recettes persistées sous chaque L1 — match Haiku, injection au plan, compteurs de confiance.',
    'skills.legendHint': '— clique sur une skill pour voir son corps complet',
    'skills.totalSuccess': 'Total succès',
    'skills.totalFailure': 'Total échecs',
    'skills.endpointUnavailable': 'Endpoint skills indisponible.',
    'skills.historyInRun': 'Historique dans ce run ({{count}})',

    'burnin.runsAxis': 'runs (ordre chronologique = expérience) →',
    'burnin.delivered': '{{count}} livrés · ',
    'burnin.compileErrors': 'erreur compilation×{{count}}',
    'burnin.refusals': 'refus compilation×{{count}}',
    'burnin.unavailable': 'API burn-in injoignable.',
    'burnin.empty': 'Aucune mesure — lance <code>npm run burnin</code> (CSV attendu : {{path}})',
    'burnin.family': 'Famille',
    'burnin.outcome': 'Résultat',
    'burnin.timeRange': 'Période',
    'burnin.all': 'Tout',
    'burnin.deliveredOnly': 'Livré',
    'burnin.failedOnly': 'Échec / erreur',
    'burnin.allTime': 'Toute la période',
    'burnin.last24h': 'Dernières 24 heures',
    'burnin.last7d': '7 derniers jours',
    'burnin.last30d': '30 derniers jours',
    'burnin.resetZoom': 'Réinitialiser le zoom temporel',
    'burnin.selected': '{{count}} run(s) dans la plage sélectionnée',
    'burnin.runsSelected': 'Runs sélectionnés',
    'burnin.deliveryRate': 'Taux de livraison',
    'burnin.medianCost': 'Coût médian',
    'burnin.p90Duration': 'Durée P90',
    'burnin.familyBreakdown': 'Familles de la sélection',
    'burnin.rowsTitle': 'Runs (récent → ancien)',
    'burnin.page': 'Page {{current}} / {{total}}',
    'burnin.previous': 'Précédent',
    'burnin.next': 'Suivant',
    'burnin.metric.models': 'Appels LLM par niveau de modèle : Opus / Sonnet / Haiku / autres providers routés.',
    'burnin.metric.deterministic': 'Phases de script déterministes sans appel LLM terminées avec succès.',
    'burnin.metric.learned': 'Skills de tâche apprises après un run inédit approuvé.',
    'burnin.metric.recovery': 'Skills de récupération apprises après un rejet corrigé.',
    'burnin.metric.promotions': 'Recettes LLM compilées en candidates script.',
    'burnin.metric.refusals': 'Décisions du compilateur indiquant que la recette ne peut pas devenir un script sûr.',
    'burnin.metric.compileErrors': 'Erreurs ou timeouts du transport avant une décision du compilateur.',
    'burnin.metric.demotions': 'Scripts rétrogradés en recettes LLM après des échecs déterministes.',
    'burnin.metric.fallbacks': 'Échecs du contrat de dispatch déterministe ayant basculé vers la boucle LLM validée.',
  },
};

const I18N_FALLBACK = 'en';
const LOCALE_STORAGE_KEY = 'atoma.viz.lang';

function detectLocale() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && I18N_CATALOGS[q]) return q;
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved && I18N_CATALOGS[saved]) return saved;
  } catch {}
  // NOT navigator.language on purpose: English is the product's source
  // language, so a French browser still gets English until the user opts in.
  return I18N_FALLBACK;
}

let LOCALE = detectLocale();

/**
 * Translate. i18next-compatible: dotted key, `{{var}}` interpolation, and
 * a `count` of 1 prefers the `<key>.one` variant when the catalog has one.
 * An unknown key renders as the key — a loud, greppable gap.
 */
function t(key, vars) {
  let entry;
  if (vars && vars.count === 1 && I18N_CATALOGS[LOCALE][key + '.one'] !== undefined) {
    entry = I18N_CATALOGS[LOCALE][key + '.one'];
  } else {
    entry = I18N_CATALOGS[LOCALE][key];
    if (entry === undefined) entry = I18N_CATALOGS[I18N_FALLBACK][key];
  }
  if (entry === undefined) return key;
  if (!vars) return entry;
  return entry.replace(/\{\{(\w+)\}\}/g, (m, name) =>
    vars[name] !== undefined ? String(vars[name]) : m
  );
}

function setLocale(code) {
  if (!I18N_CATALOGS[code]) return;
  LOCALE = code;
  try { localStorage.setItem(LOCALE_STORAGE_KEY, code); } catch {}
  location.reload(); // simplest correct repaint: every view re-reads t()
}

/**
 * Fill the STATIC chrome from the catalog — `data-i18n` for text,
 * `data-i18n-title` / `data-i18n-placeholder` for those attributes. Same
 * convention as i18next's DOM helpers, so the markup survives a swap.
 */
function applyStaticI18n(root) {
  const scope = root ?? document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.documentElement.lang = LOCALE;
}

/** Populate the language picker; hidden when a single locale is shipped. */
function initLangPicker() {
  const sel = document.getElementById('langSelect');
  if (!sel) return;
  const codes = Object.keys(I18N_CATALOGS);
  if (codes.length < 2) { sel.style.display = 'none'; return; }
  sel.innerHTML = '';
  for (const code of codes) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = I18N_CATALOGS[code]['lang.name'] ?? code;
    if (code === LOCALE) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => setLocale(sel.value);
}

const state = {
  view: 'runs', // 'runs' | 'registry'
  runs: [],
  currentRun: null,
  /** atoms seen in the current run, keyed by name — latest snapshot wins. */
  atomsByName: new Map(),
  selectedEventId: null,
  selectedAtomName: null,
  /**
   * eventId → rendered card node, the key to INCREMENTAL rendering: a
   * poll tick reuses these nodes and builds only genuinely-new ids, so
   * the DOM stops churning and new steps can animate in. Invalidated by
   * an explicit `renderEvents({ rebuild: true })` (run switch, filter
   * change) — the only moments the visible set changes for a reason
   * other than "a step just happened".
   */
  renderedCards: new Map(),
  /** Sticky "Prompts & réponse" tab index — survives event switches and re-renders. */
  detailTabIndex: 1,
  filters: { kind: 'all', role: 'all', branchId: 'all' },
  // Registry view state
  registries: [],
  currentRegistry: null, // { registry, types: [...] }
  selectedRegistryAtom: null,
  registryFilter: '',
  // Skills view state
  skillNamespaces: [], // [{ l1Name, count }]
  skillsByL1: {},      // l1Name -> [SkillSummary]
  selectedSkill: null, // { l1Name, id }
  skillsFilter: '',
  // Burn-in analytics: filters are independent from the chart's temporary
  // dataZoom window; page resets whenever either selection changes.
  burninRows: [],
  burninFilters: {
    family: 'all',
    outcome: 'all',
    preset: 'all',
    zoomStart: null,
    zoomEnd: null,
    page: 1,
    pageSize: 50,
  },
  // Live polling state. When a run is in-flight (endedAt undefined),
  // we poll /api/runs/<id> every 1s and re-render as new events arrive.
  // We also poll /api/runs (the index) every 2s to detect freshly-
  // started runs that appeared after the page was loaded.
  livePollHandle: null,
  indexPollHandle: null,
};

const LIVE_POLL_MS = 1000;
const INDEX_POLL_MS = 2000;

const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, children = []) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    if (typeof c === 'string') el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
};
const fmtMs = (ms) => ms == null ? '—' : ms > 1000 ? (ms/1000).toFixed(2) + 's' : ms + 'ms';
const fmtCost = (c) => c == null ? '—' : '$' + c.toFixed(4);
const fmtTime = (ts) => {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function tierBadge(tier) {
  if (!tier) return h('span', { class: 'tier', html: '?' });
  return h('span', { class: 'tier t' + tier, html: 'L' + tier });
}

function atomRef(ref) {
  if (!ref) return h('span', { class: 'meta', html: '?' });
  const span = h('span', {}, [tierBadge(ref.tier), ' ', h('span', { class: 'name' }, ref.name ?? '?')]);
  return span;
}

function runSelectLabel(r) {
  // `cancelled` wins over `hasError` because user-cancellation is a
  // deliberate action, not a fault — we set both flags on the index
  // entry but the UI label should reflect the user's intent.
  const flags = r.cancelled
    ? '  ' + t('runs.flag.cancelled')
    : r.hasError
      ? '  ✖'
      : isIndexEntryLive(r)
        ? '  ' + t('runs.flag.live')
        : r.inFlight
          ? '  ' + t('runs.flag.abandoned')
          : r.degraded
            ? '  ' + t('runs.flag.fallback')
            : '';
  return `${r.label}  —  ${r.startedAt.slice(0, 19).replace('T', ' ')}  (${r.calls ?? 0} calls, ${fmtCost(r.costUsd ?? 0)})${flags}`;
}

function populateRunSelect(runs, keepSelection) {
  const sel = $('runSelect');
  sel.innerHTML = '';
  if (runs.length === 0) {
    sel.appendChild(h('option', {}, t('runs.none')));
    return;
  }
  for (const r of runs) sel.appendChild(h('option', { value: r.id }, runSelectLabel(r)));
  if (keepSelection && runs.some((r) => r.id === keepSelection)) sel.value = keepSelection;
}

async function loadIndex() {
  const r = await fetch('/api/runs');
  state.runs = await r.json();
  if (state.runs.length === 0) {
    populateRunSelect(state.runs);
    renderSummary(null);
    return;
  }
  populateRunSelect(state.runs);
  selectRun(state.runs[0].id);
  scheduleIndexPoll();
}

/**
 * Poll /api/runs every INDEX_POLL_MS so freshly-started runs appear in
 * the top of the dropdown without a manual refresh. If the dropdown was
 * on the newest run, stay on it (auto-advance to the fresh live run).
 */
function scheduleIndexPoll() {
  if (state.indexPollHandle) clearTimeout(state.indexPollHandle);
  state.indexPollHandle = setTimeout(async () => {
    state.indexPollHandle = null;
    if (state.view !== 'runs') {
      scheduleIndexPoll();
      return;
    }
    try {
      const r = await fetch('/api/runs');
      if (!r.ok) {
        scheduleIndexPoll();
        return;
      }
      const fresh = await r.json();
      const topChanged = (fresh[0]?.id ?? null) !== (state.runs[0]?.id ?? null);
      // Only a GENUINELY live entry justifies re-rendering the list every
      // tick. A run that died without its closing stamp keeps `inFlight`
      // forever, and reading it raw kept the index re-polling for hours.
      const anyInflight = fresh.some((r) => isIndexEntryLive(r));
      const newCount = fresh.length !== state.runs.length;
      state.runs = fresh;
      if (topChanged || newCount || anyInflight) {
        const currentId = state.currentRun?.id ?? null;
        populateRunSelect(fresh, currentId);
        // Auto-advance to the fresh top run if the user hadn't drilled
        // into a specific run OR the previous selection was the
        // former top (i.e. they were following the latest).
        if (topChanged && (!currentId || !fresh.some((r) => r.id === currentId))) {
          selectRun(fresh[0].id);
        }
      }
    } catch {}
    scheduleIndexPoll();
  }, INDEX_POLL_MS);
}

async function selectRun(id) {
  $('runSelect').value = id;
  $('eventsList').innerHTML = '<div class="loader">' + t('common.loading') + '</div>';
  $('rightPane').innerHTML = '<div class="empty">' + t('pane.selectEvent') + '</div>';
  const r = await fetch('/api/runs/' + encodeURIComponent(id));
  if (!r.ok) {
    $('eventsList').innerHTML = '<div class="empty">' + t('runs.notFound') + '</div>';
    return;
  }
  state.currentRun = await r.json();
  state.selectedEventId = null;
  state.selectedAtomName = null;
  state.atomsByName = buildAtomMap(state.currentRun);
  renderSummary(state.currentRun);
  renderLanes(state.currentRun);
  renderFilters();
  // A different run: nothing in the card cache is valid — rebuild.
  renderEvents({ rebuild: true });
  // Kick off live polling if the run is in-flight (no endedAt yet).
  scheduleLivePoll(id);
}

/**
 * Poll the selected run every LIVE_POLL_MS while it's in-flight. When
 * new events appear we rebuild the derived maps and re-render the left
 * pane. The right pane (event detail) is preserved if the previously
 * selected event still exists in the new event list.
 */
function scheduleLivePoll(runId) {
  if (state.livePollHandle) clearTimeout(state.livePollHandle);
  // Not in-flight → nothing to poll.
  if (!state.currentRun || state.currentRun.endedAt || isAbandoned(state.currentRun)) return;
  state.livePollHandle = setTimeout(async () => {
    state.livePollHandle = null;
    // User navigated away / picked another run — stop.
    if (!state.currentRun || state.currentRun.id !== runId) return;
    try {
      // DELTA FETCH: ask only for events past the ones we already hold.
      // The server answers with the run header + the tail slice, so a
      // long live run stops re-shipping its whole payload every second.
      const have = state.currentRun.events.length;
      const r = await fetch('/api/runs/' + encodeURIComponent(runId) + '?after=' + have);
      if (!r.ok) {
        scheduleLivePoll(runId);
        return;
      }
      const payload = await r.json();
      // Splice the delta back into a complete run object. `eventsFrom`
      // is where the server's slice starts: equal to `have` on the normal
      // path, 0 when the server decided we must resync (shrunken trace).
      const from = typeof payload.eventsFrom === 'number' ? payload.eventsFrom : 0;
      const fresh = {
        ...payload,
        events: from === 0
          ? payload.events
          : state.currentRun.events.slice(0, from).concat(payload.events),
      };
      delete fresh.eventsFrom;
      delete fresh.eventsTotal;
      const changed =
        fresh.events.length !== state.currentRun.events.length ||
        (fresh.endedAt && !state.currentRun.endedAt);
      if (changed) {
        const prevSelectedId = state.selectedEventId;
        const hadDetailBefore = prevSelectedId
          ? state.currentRun.events.some((e) => e.id === prevSelectedId)
          : false;
        // Events render NEWEST FIRST, so fresh cards INSERT AT THE TOP.
        // renderEvents() reconciles incrementally (only genuinely new ids
        // touch the DOM), so at scrollTop 0 — following the live run — the
        // new card simply unfolds in place. Deeper in the list, compensate
        // by the inserted height so the card being read doesn't drift.
        const leftPane = $('leftPane');
        const leftScroll = leftPane ? leftPane.scrollTop : 0;
        const heightBefore = leftPane ? leftPane.scrollHeight : 0;
        state.currentRun = fresh;
        state.atomsByName = buildAtomMap(fresh);
        renderSummary(fresh);
        renderLanes(fresh);
        renderFilters();
        renderEvents();
        if (leftPane) {
          leftPane.scrollTop =
            leftScroll > 0 ? leftScroll + (leftPane.scrollHeight - heightBefore) : 0;
        }
        // Right pane: recorded events are IMMUTABLE, so if the selected
        // event was already rendered, leave the pane completely alone —
        // re-rendering it every poll tick reset the active tab (e.g. the
        // user reading "Response" got bounced back) and the scroll. Only
        // render when the selection is materialising for the first time
        // (it was selected while still absent from the fetched snapshot).
        if (prevSelectedId) {
          const stillThere = fresh.events.find((e) => e.id === prevSelectedId);
          if (stillThere) {
            state.selectedEventId = prevSelectedId;
            if (!hadDetailBefore) renderDetail(stillThere);
          }
        }
      }
    } catch {}
    // Even with no new events, the in-flight elapsed must tick: a long
    // LLM call produces zero events while it runs — that silence is
    // precisely what the banner exists to make visible.
    refreshNowBanner();
    // Continue polling until endedAt arrives. Once it does, the next
    // tick won't schedule a new timer (early return at top).
    scheduleLivePoll(runId);
  }, LIVE_POLL_MS);
}

function refreshNowBanner() {
  const run = state.currentRun;
  if (!run) return;
  const completedIds = new Set(run.events.filter((e) => e.kind === 'llm').map((e) => e.id));
  renderNowBanner(run, completedIds, isRunLive(run));
}

/**
 * Merge every atom type the run touched into a single map, keyed by name.
 * Sources, in increasing precedence (later overrides earlier):
 *   1. `run.initialTypes` — snapshot captured at `beginRun` (pre-existing types).
 *   2. Registry events with snapshots (create / patch / branch) — each bumps
 *      the version and refreshes counters.
 * Every entry also carries the list of registry events it saw during the run
 * so the detail pane can render a mini version-history timeline.
 */
function buildAtomMap(run) {
  const map = new Map();
  const put = (snap, origin) => {
    const prev = map.get(snap.name);
    if (!prev) {
      map.set(snap.name, { snapshot: snap, origin, events: [] });
      return;
    }
    if (snap.version >= prev.snapshot.version) {
      // Preserve the strongest origin we've ever seen: created > branched > patched > existing.
      const strength = { existing: 0, patched: 1, branched: 2, created: 3 };
      const best = (strength[origin] ?? 0) >= (strength[prev.origin] ?? 0) ? origin : prev.origin;
      map.set(snap.name, { snapshot: snap, origin: best, events: prev.events });
    }
  };
  for (const s of (run.initialTypes ?? [])) put(s, 'existing');
  for (const ev of run.events) {
    if (ev.kind !== 'registry' || !ev.snapshot) continue;
    const origin = ev.op === 'create' ? 'created' : ev.op === 'branch' ? 'branched' : 'patched';
    put(ev.snapshot, origin);
    const entry = map.get(ev.snapshot.name);
    if (entry) entry.events.push(ev);
  }
  // Attach success/failure counter bumps to the owning atom's history too.
  for (const ev of run.events) {
    if (ev.kind !== 'registry') continue;
    if (ev.op !== 'recordSuccess' && ev.op !== 'recordFailure') continue;
    const entry = map.get(ev.name);
    if (entry) entry.events.push(ev);
  }
  return map;
}

function renderSummary(run) {
  const el = $('runSummary');
  if (!run) { el.innerHTML = ''; return; }
  const tot = run.totals ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  el.innerHTML = '';
  const directCount = (run.events ?? []).filter(
    (e) => e.kind === 'skill' && e.op === 'direct'
  ).length;
  const grid = h('div', { class: 'grid' }, [
    statCard(t('summary.duration'), fmtMs(run.durationMs)),
    statCard(t('summary.llmCalls'), String(tot.calls)),
    statCard(t('summary.tokens'), (tot.inputTokens ?? 0) + ' / ' + (tot.outputTokens ?? 0)),
    statCard(t('summary.cacheHit'), String(tot.cacheReadInputTokens ?? 0)),
    statCard(t('summary.cost'), fmtCost(tot.costUsd)),
    statCard(t('summary.fallback'), run.result?.producedBy?.viaFallback ? t('summary.yes') : t('summary.no')),
  ]);
  if (directCount > 0) {
    const card = statCard(t('summary.freePhases'), t('summary.freePhases.value', { count: directCount }));
    card.style.borderLeft = '3px solid #ffd700';
    grid.appendChild(card);
  }
  // The OTHER zero-cost path: routing decisions replayed from the
  // prefilter cache. Counting them here answers "why did this run make
  // fewer Haiku calls than the last one?" without opening the timeline.
  const cacheHits = (run.events ?? []).filter((e) => e.kind === 'cache').length;
  if (cacheHits > 0) {
    const card = statCard(t('summary.cachedRouting'), t('summary.cachedRouting.value', { count: cacheHits }));
    card.style.borderLeft = '3px solid #22d3ee';
    grid.appendChild(card);
  }
  // Skill LIFECYCLE digest — what this run changed about the system itself,
  // which is invisible in per-event noise: learned recipes, compilations,
  // demotions, and dispatches that fell back to the LLM loop.
  if (isAbandoned(run)) {
    const card = statCard(t('summary.abandoned'), t('summary.abandoned.value'));
    card.style.borderLeft = '3px solid var(--err)';
    grid.appendChild(card);
  }
  const skillEvents = (run.events ?? []).filter((e) => e.kind === 'skill');
  const tally = {
    learn: skillEvents.filter((e) => e.op === 'learn').length,
    promote: skillEvents.filter((e) => e.op === 'promote').length,
    demote: skillEvents.filter((e) => e.op === 'demote').length,
    update: skillEvents.filter((e) => e.op === 'update').length,
    recovery: skillEvents.filter(
      (e) => e.op === 'inject' && /^event-trigger/.test(e.reasoning ?? '')
    ).length,
  };
  if (tally.learn || tally.promote || tally.demote || tally.update || tally.recovery) {
    const bits = [];
    if (tally.learn) bits.push(t('summary.lifecycle.learned', { count: tally.learn }));
    if (tally.promote) bits.push(t('summary.lifecycle.promoted', { count: tally.promote }));
    if (tally.demote) bits.push(t('summary.lifecycle.demoted', { count: tally.demote }));
    if (tally.update) bits.push(t('summary.lifecycle.revised', { count: tally.update }));
    if (tally.recovery) bits.push(t('summary.lifecycle.recovery', { count: tally.recovery }));
    const card = statCard(t('summary.lifecycle'), bits.join(' · '));
    card.style.borderLeft = '3px solid #f0abfc';
    grid.appendChild(card);
  }
  // Guard decisions — the two mechanisms whose whole job is to NOT do
  // something. Their absence from the timeline used to make a blocked
  // skill indistinguishable from a skill that never matched.
  const quarantined = skillEvents.filter((e) => e.op === 'quarantine').length;
  const withheld = skillEvents.filter((e) => e.op === 'credit-withheld').length;
  if (quarantined || withheld) {
    const bits = [];
    if (quarantined) bits.push(t('summary.guards.quarantined', { count: quarantined }));
    if (withheld) bits.push(t('summary.guards.withheld', { count: withheld }));
    const card = statCard(t('summary.guards'), bits.join(' · '));
    card.style.borderLeft = '3px solid #fbbf24';
    grid.appendChild(card);
  }
  const models = (tot.perModel ?? []).map((m) =>
    h('span', { class: 'chip muted' }, `${m.model.replace(/^claude-/, '')}  ·  ${m.calls}×  ·  ${fmtCost(m.costUsd)}`)
  );
  const degradedBanner = run.degraded
    ? h('div', {
        class: 'err-badge',
        style: 'margin-top:8px; background: #3b2a10; border-color: #7a5a1e; color: #fbbf24;',
      }, t('summary.degraded'))
    : null;
  const isLive = isRunLive(run);
  const liveBanner = isLive
    ? h('div', {
        class: 'err-badge',
        style: 'margin-top:8px; background: #0f2a18; border-color: #1e7a3a; color: #4ade80;',
      }, t('summary.live', { seconds: LIVE_POLL_MS / 1000 }))
    : null;
  el.appendChild(h('div', { class: 'summary' }, [
    h('h2', {}, (isLive ? '● ' : '') + run.label),
    h('div', { class: 'task' }, run.task?.description ?? ''),
    grid,
    models.length ? h('div', { class: 'filters', style: 'margin-top:10px;' }, models) : null,
    liveBanner,
    run.result ? renderResultBlock(run.result.summary ?? '') : null,
    degradedBanner,
    run.error ? h('div', { class: 'err-badge', style: 'margin-top:8px;' }, t('summary.error', { message: run.error })) : null,
  ]));
}

/**
 * Render the run's result summary as structure instead of a wall.
 *
 * A sequential run's summary is built by concatenation: the final phase's
 * deliverable, then `Trace:` followed by every phase joined with ` | `,
 * and each phase may embed a verbatim `== GROUND TRUTH ==` evidence dump
 * (probe stdout/stderr/exit codes, file listings). Rendered as one
 * paragraph that is unreadable exactly when it matters most — after a
 * multi-phase build. We split it back apart: the deliverable leads, the
 * per-phase trace collapses behind a toggle, and evidence renders
 * monospace so aligned probe output stays aligned.
 *
 * Purely presentational and defensive: any shape it cannot parse falls
 * through to the original text.
 */
function renderResultBlock(summary) {
  const text = String(summary ?? '').trim();
  const wrap = h('div', { class: 'result' });
  wrap.appendChild(h('h3', {}, t('result.title')));
  if (!text) {
    wrap.appendChild(h('div', { class: 'meta' }, t('common.emptyDash')));
    return wrap;
  }
  // Head = the deliverable statement; the rest is the per-phase trace.
  const traceSplit = text.split(/\s*(?:\.\s*)?\bTrace\s*:\s*/);
  const head = traceSplit[0] ?? text;
  const traceRest = traceSplit.length > 1 ? traceSplit.slice(1).join(' Trace: ') : '';

  for (const node of renderEvidenceSplit(head, 'final')) wrap.appendChild(node);

  if (!traceRest) return wrap;
  // ` | phase #N (Atom): …` — split on the separator that PRECEDES a
  // phase marker so a literal pipe inside a summary can't split a phase.
  const phases = traceRest.split(/\s*\|\s*(?=phase\s*#\d+)/);
  const body = h('div', { style: 'display:none;' });
  for (const chunk of phases) {
    const m = chunk.match(/^phase\s*#(\d+)\s*\(([^)]*)\)\s*:\s*([\s\S]*)$/);
    const card = h('div', { class: 'phase' });
    if (m) {
      card.appendChild(h('div', { class: 'phase-head' }, t('result.phase', { n: m[1], atom: m[2] })));
      for (const node of renderEvidenceSplit(m[3], 'phase')) card.appendChild(node);
    } else {
      for (const node of renderEvidenceSplit(chunk, 'phase')) card.appendChild(node);
    }
    body.appendChild(card);
  }
  const label = t('result.byPhase', { count: phases.length });
  const toggle = h('span', { class: 'toggle' }, '▸ ' + label);
  toggle.onclick = () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    toggle.textContent = (open ? '▸ ' : '▾ ') + label;
  };
  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

/**
 * Split a chunk on `== GROUND TRUTH ==` markers, returning prose nodes
 * and monospace evidence nodes. The evidence is the child's verbatim
 * observation (probe stdout, byte sizes, exit codes) — the one part of a
 * summary where alignment and line breaks carry meaning.
 */
function renderEvidenceSplit(chunk, kind) {
  const out = [];
  const parts = String(chunk ?? '').split(/==\s*GROUND\s*TRUTH\s*==/i);
  const lead = (parts.shift() ?? '').trim();
  if (lead) {
    out.push(h('div', { class: kind === 'final' ? 'final' : 'prose' }, lead));
  }
  for (const ev of parts) {
    const body = ev.trim();
    if (!body) continue;
    out.push(h('div', { class: 'evidence-label' }, t('result.groundTruth')));
    out.push(h('div', { class: 'evidence' }, softBreakEvidence(body)));
  }
  return out;
}

/**
 * Evidence dumps arrive as ONE line — the child writes "Probe 1: … exit
 * Code: 0 Probe 2: …" and the enumeration is invisible. Break before the
 * markers children actually use so each probe / file gets its own line.
 * Conservative on purpose: a marker that never appears changes nothing,
 * and the text itself is never altered, only wrapped.
 */
function softBreakEvidence(text) {
  return text
    // "Probe 2:", "probe: GET /health" — one per line.
    .replace(/\s+(?=[Pp]robe\s*\d*\s*:)/g, '\n')
    // Bulleted file lists: " - bin/longest.js (584 bytes)".
    .replace(/\s+-\s+(?=[\w./])/g, '\n  - ')
    // Section labels children emit inside the block.
    .replace(/\s+(?=(?:Files created|Files created\/updated|Validation results|schema\/state)\s*:)/g, '\n')
    // Numbered checks: " 2. Success case (…)".
    .replace(/\s+(?=\d+\.\s+[A-Z])/g, '\n')
    .trim();
}

function statCard(k, v) {
  return h('div', { class: 'stat' }, [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]);
}

function renderLanes(run) {
  const wrap = $('lanesWrap');
  wrap.innerHTML = '';
  const byTier = { 1: [], 2: [], 3: [] };
  for (const [name, entry] of state.atomsByName.entries()) {
    byTier[entry.snapshot.tier].push({ name, entry });
  }
  // Include atoms that only appeared as actor/child refs on LLM events without
  // a full snapshot — render a placeholder so the lane doesn't hide them.
  for (const ev of run.events) {
    if (ev.kind !== 'llm' && ev.kind !== 'trust') continue;
    for (const ref of [ev.actor, ev.child]) {
      if (!ref?.tier || !ref?.name) continue;
      if (state.atomsByName.has(ref.name)) continue;
      if (byTier[ref.tier].some((x) => x.name === ref.name)) continue;
      byTier[ref.tier].push({ name: ref.name, entry: null });
    }
  }
  for (const tier of [1, 2, 3]) {
    byTier[tier].sort((a, b) => (a.entry?.snapshot.ordinal ?? 9999) - (b.entry?.snapshot.ordinal ?? 9999));
  }
  const lane = (tier, title) => {
    const items = byTier[tier];
    const chips = items.map(({ name, entry }) => {
      const origin = entry?.origin ?? 'unknown';
      const cls = 'chip atom ' + (
        origin === 'created' || origin === 'branched' ? 'new'
        : origin === 'patched' ? 'patched'
        : ''
      ) + (state.selectedAtomName === name ? ' selected' : '');
      const title = entry
        ? `${origin} · v${entry.snapshot.version} · ✓${entry.snapshot.successes}/✗${entry.snapshot.failures}`
        : t('registry.origin.noSnapshot');
      const children = [name];
      if (entry) children.push(h('span', { class: 'v' }, 'v' + entry.snapshot.version));
      const attrs = { class: cls.trim(), title };
      if (entry) attrs.onclick = () => selectAtom(name);
      else attrs.style = 'cursor: default; opacity: 0.7;';
      return h('span', attrs, children);
    });
    return h('div', { class: 'lane l' + tier }, [
      h('h4', {}, title + ` (${items.length})`),
      h('div', {}, items.length ? chips : h('span', { class: 'meta' }, t('common.none'))),
    ]);
  };
  wrap.appendChild(h('div', { class: 'lanes' }, [
    lane(3, t('lanes.l3')),
    lane(2, t('lanes.l2')),
    lane(1, t('lanes.l1')),
  ]));
  wrap.appendChild(h('div', { class: 'origin-legend' }, [
    h('span', {}, [h('span', { class: 'dot new' }), t('lanes.legend.new')]),
    h('span', {}, [h('span', { class: 'dot patched' }), t('lanes.legend.patched')]),
    h('span', {}, [h('span', { class: 'dot existing' }), t('lanes.legend.existing')]),
    h('span', { class: 'meta' }, t('lanes.legend.hint')),
  ]));
}

function selectAtom(name) {
  const entry = state.atomsByName.get(name);
  if (!entry) return;
  state.selectedAtomName = name;
  state.selectedEventId = null;
  renderLanes(state.currentRun);
  renderEvents();
  renderAtomDetail(entry);
}

function renderFilters() {
  const el = $('filters');
  el.innerHTML = '';
  const kinds = [
    ['all', t('filters.all')],
    ['llm', t('filters.llm')],
    ['tool', t('filters.tools')],
    ['trust', t('filters.trust')],
    ['skill', t('filters.skills')],
    ['cache', t('filters.cache')],
    ['registry', t('filters.registry')],
  ];
  for (const [k, lbl] of kinds) {
    el.appendChild(h('span', {
      class: 'chip' + (state.filters.kind === k ? ' active' : ''),
      onclick: () => { state.filters.kind = k; renderFilters(); renderEvents({ rebuild: true }); },
    }, lbl));
  }
  const sep = h('span', { class: 'chip muted', style: 'pointer-events: none; background: transparent; border: none;' }, '·');
  el.appendChild(sep);
  const roles = [
    ['all', t('filters.allRoles')],
    ['plan', 'plan'],
    ['execute', 'execute'],
    ['validate-plan', 'validate plan'],
    ['validate-result', 'validate result'],
    ['prefilter', 'prefilter'],
    ['skill', 'skill'],
    ['fallback-plan', 'fallback plan'],
    ['fallback-execute', 'fallback execute'],
  ];
  for (const [k, lbl] of roles) {
    el.appendChild(h('span', {
      class: 'chip' + (state.filters.role === k ? ' active' : ''),
      onclick: () => { state.filters.role = k; renderFilters(); renderEvents({ rebuild: true }); },
    }, lbl));
  }
  // Fan-out branch filter — derive the set of branchIds observed in
  // the current run. Appears only when there IS fan-out going on
  // (otherwise the chip is just noise).
  const run = state.currentRun;
  if (run) {
    const branchIds = [...new Set(
      run.events
        .map((e) => e.branchId)
        .filter((b) => typeof b === 'string' && b.length > 0)
    )];
    if (branchIds.length > 0) {
      el.appendChild(h('span', { class: 'chip muted', style: 'pointer-events: none; background: transparent; border: none;' }, '·'));
      el.appendChild(h('span', {
        class: 'chip' + (state.filters.branchId === 'all' || !state.filters.branchId ? ' active' : ''),
        onclick: () => { state.filters.branchId = 'all'; renderFilters(); renderEvents({ rebuild: true }); },
      }, t('filters.allBranches')));
      for (const b of branchIds) {
        el.appendChild(h('span', {
          class: 'chip' + (state.filters.branchId === b ? ' active' : ''),
          onclick: () => { state.filters.branchId = b; renderFilters(); renderEvents({ rebuild: true }); },
          title: t('filters.branch', { id: b }),
        }, '⑂' + b.slice(0, 6)));
      }
    }
  }
}

/**
 * Render the events list, INCREMENTALLY when possible.
 *
 * The list used to be torn down (`innerHTML = ''`) and rebuilt on every
 * 1s poll tick. That churned the whole DOM to learn about one new card,
 * made entry animations impossible (every card was "new" each tick), and
 * forced scroll gymnastics. Now we reconcile: cards are keyed by event
 * id, existing nodes are MOVED rather than recreated, and only genuinely
 * new ids are built — and animated. A filter change or a run switch
 * bumps `renderGeneration`, which forces a clean rebuild (the keys are
 * still valid but the visible SET changed for a user-driven reason, and
 * animating that would be noise).
 */
function renderEvents(opts) {
  const el = $('eventsList');
  const run = state.currentRun;
  if (!run) { el.innerHTML = ''; return; }
  const rebuild = !!(opts && opts.rebuild);
  if (rebuild) {
    el.innerHTML = '';
    state.renderedCards = new Map();
  }
  if (!state.renderedCards) state.renderedCards = new Map();
  // Pair llm-start markers with their completions: a start whose
  // llmEventId already exists as a completed 'llm' event is superseded
  // and hidden. Unpaired starts are either IN FLIGHT (live run — shown
  // in the "en ce moment" banner) or INTERRUPTED (ended run — shown
  // inline, the signature of a killed subprocess / network blip).
  const completedIds = new Set(run.events.filter((e) => e.kind === 'llm').map((e) => e.id));
  const isLive = isRunLive(run);
  renderNowBanner(run, completedIds, isLive);
  const filtered = run.events.filter((e) => {
    if (e.kind === 'llm-start') {
      if (completedIds.has(e.llmEventId)) return false; // superseded
      if (isLive) return false; // rendered in the banner instead
      // ended run + unpaired → keep: interrupted call, worth seeing.
    }
    const kindForFilter = e.kind === 'llm-start' ? 'llm' : e.kind;
    if (state.filters.kind !== 'all' && kindForFilter !== state.filters.kind) return false;
    if ((e.kind === 'llm' || e.kind === 'llm-start') && state.filters.role !== 'all' && e.role !== state.filters.role) return false;
    if (state.filters.branchId && state.filters.branchId !== 'all' && e.branchId !== state.filters.branchId) return false;
    return true;
  });
  // NEWEST FIRST. The list used to append chronologically, so every
  // completed step landed at the BOTTOM and following a live run meant
  // scrolling after each step. Reversed, the flow reads top-down as
  // "now → just finished → older", and the viewport never moves: the
  // in-flight banner sits directly above this list, immediately followed
  // by the most recently completed step.
  const ordered = filtered.slice().reverse();

  // Desired child sequence, keyed for reconciliation. Run-boundary markers
  // are purely informational, synthesised from the run metadata — no
  // recorded event backs them, so they show on every run ever persisted
  // and ignore the filters. The END marker leads, the START marker closes.
  const desired = [];
  const endMarker = renderRunEndMarker(run, isLive);
  if (endMarker) desired.push({ key: 'marker:end', node: endMarker, fresh: true });
  if (ordered.length === 0) {
    desired.push({
      key: 'empty',
      node: h('div', { class: 'empty' }, t('filters.noMatch')),
      fresh: true,
    });
  }
  for (const ev of ordered) {
    const cached = state.renderedCards.get(ev.id);
    // A rendered card is reused as-is EXCEPT for its selected state, which
    // is view state rather than event data (recorded events are immutable).
    if (cached) {
      const shouldSelect = state.selectedEventId === ev.id;
      cached.classList.toggle('selected', shouldSelect);
      desired.push({ key: ev.id, node: cached, fresh: false });
    } else {
      desired.push({ key: ev.id, node: renderEventCard(ev), fresh: true });
    }
  }
  desired.push({ key: 'marker:start', node: renderRunStartMarker(run), fresh: true });

  // Reconcile in one pass: walk the desired sequence against the live
  // children, inserting/moving only where they diverge. Nodes reused from
  // the cache keep their identity — no flicker, no lost hover, and the
  // browser animates genuinely-new cards unfolding into place.
  let cursor = el.firstChild;
  for (const item of desired) {
    if (cursor === item.node) {
      cursor = cursor.nextSibling;
      continue;
    }
    // Animate only cards arriving into an ALREADY-POPULATED list (a live
    // step landing). A first paint or a rebuild would otherwise fire one
    // animation per card — 200 cards, 200 animations, for nothing.
    const shouldAnimate =
      item.fresh && !rebuild && el.childNodes.length > 0 && item.key !== 'marker:start';
    el.insertBefore(item.node, cursor);
    if (shouldAnimate) animateStepEntry(item.node);
  }
  // Drop whatever trails the desired sequence (filtered-out cards, the
  // stale end marker of a run that just went live→ended, the empty state).
  while (cursor) {
    const next = cursor.nextSibling;
    el.removeChild(cursor);
    cursor = next;
  }
  // Refresh the id→node cache from what actually survived this pass.
  const nextCache = new Map();
  for (const item of desired) {
    if (item.key !== 'marker:end' && item.key !== 'marker:start' && item.key !== 'empty') {
      nextCache.set(item.key, item.node);
    }
  }
  state.renderedCards = nextCache;
}

/**
 * Entry animation for a step landing on a live run: the card unfolds from
 * zero height while fading in from slightly above, so everything below it
 * is pushed down smoothly instead of jumping.
 *
 * Uses the Web Animations API on the card's MEASURED height rather than a
 * CSS keyframe on max-height: a keyframe needs a fixed upper bound, which
 * either clips tall cards or (when set generously) makes short ones reach
 * full size in the first fraction of the animation — the push then looks
 * abrupt, exactly what this is meant to avoid. Measuring gives every card
 * the same perceived motion whatever its content.
 */
const STEP_ENTER_MS = 420;

function animateStepEntry(node) {
  if (typeof node.animate !== 'function') return; // ancient browser: no-op
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = node.offsetHeight;
  if (!target) return;
  const style = window.getComputedStyle(node);
  const marginBottom = style.marginBottom;
  const prevOverflow = node.style.overflow;
  node.style.overflow = 'hidden';
  const anim = node.animate(
    [
      { height: '0px', opacity: 0, transform: 'translateY(-8px)', marginBottom: '0px' },
      { height: target + 'px', opacity: 1, transform: 'translateY(0)', marginBottom },
    ],
    { duration: STEP_ENTER_MS, easing: 'cubic-bezier(0.22, 0.9, 0.35, 1)' }
  );
  // Restore the natural box once done — the animation must leave NO
  // inline geometry behind, or a card that later grows (selection border,
  // wrapped chips on resize) would stay clipped at its arrival height.
  const restore = () => { node.style.overflow = prevOverflow; };
  anim.addEventListener('finish', restore, { once: true });
  anim.addEventListener('cancel', restore, { once: true });
}

/**
 * Best-effort JSON extraction from a recorded LLM response — the same
 * tolerance the runtime parsers apply (fenced block, prose wrapper),
 * minus the repair machinery: a card that cannot read the payload just
 * shows no chip, which is the correct degradation for decoration.
 */
function peekJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced && fenced[1]) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch {}
  }
  return null;
}

function outcomeChip(text, color, title) {
  return h('span', {
    class: 'meta',
    style: 'font-weight:600; color:' + color + ';',
    ...(title ? { title } : {}),
  }, text);
}

/**
 * Decision/verdict chips derived from an LLM event's recorded response.
 * Purely presentational — no chip is ever the source of truth, the
 * detail pane still shows the raw payload.
 */
function outcomeChips(ev) {
  const chips = [];
  const payload = peekJson(ev.response);
  if (!payload) return chips;

  if (ev.role === 'prefilter') {
    // Routing decision: reuse <target> (the happy path that skips the
    // expensive plan call) vs escalate. The confidence rides along —
    // a "low" reuse is rewritten to escalate upstream, so seeing the
    // label explains why an apparently-matching catalog still escalated.
    if (payload.kind === 'reuse' && typeof payload.target === 'string') {
      chips.push(outcomeChip(t('outcome.reuse', { target: payload.target }), 'var(--ok)', payload.reasoning || ''));
      if (payload.confidence && payload.confidence !== 'high') {
        chips.push(outcomeChip(t('outcome.confidence', { level: payload.confidence }), '#fbbf24'));
      }
    } else if (payload.kind === 'escalate') {
      chips.push(outcomeChip(t('outcome.escalate'), '#fbbf24', payload.reasoning || ''));
    }
    return chips;
  }

  if (ev.role === 'validate-plan' || ev.role === 'validate-result') {
    if (payload.approved === true) {
      chips.push(outcomeChip(t('outcome.approved'), 'var(--ok)', payload.reasoning || ''));
    } else if (payload.approved === false) {
      chips.push(outcomeChip(t('outcome.rejected'), 'var(--err)', payload.reasoning || ''));
      if (typeof payload.scope === 'string') {
        chips.push(outcomeChip(t('outcome.scope', { scope: payload.scope }), 'var(--muted)'));
      }
    }
    // ADHERENCE (usage-conditioned skill credit): the validator reports
    // whether the run actually followed the injected recipe. `false` is
    // what withholds the skill's counter bump, so it belongs on the card
    // — otherwise the only visible trace is a counter that didn't move.
    if (payload.activeSkillFollowed === false) {
      chips.push(outcomeChip(t('outcome.recipeIgnored'), '#fbbf24', t('outcome.recipeIgnored.title')));
    } else if (payload.activeSkillFollowed === true) {
      chips.push(outcomeChip(t('outcome.recipeFollowed'), 'var(--muted)', t('outcome.recipeFollowed.title')));
    }
  }
  return chips;
}

function runMarkerCard(accentColor, cells) {
  return h('div', { class: 'run-marker', style: 'border-left: 3px solid ' + accentColor + ';' }, [
    h('div', { class: 'row' }, cells),
  ]);
}

function renderRunStartMarker(run) {
  return runMarkerCard('var(--accent)', [
    h('span', { class: 'when' }, fmtTime(Date.parse(run.startedAt))),
    h('span', {}, t('marker.start')),
    run.task?.description
      ? h('span', { class: 'meta' },
          run.task.description.length > 120
            ? run.task.description.slice(0, 117) + '…'
            : run.task.description)
      : null,
  ]);
}

/**
 * End-of-run marker, status-aware: cancelled and errors read red,
 * fallback-degraded and abandoned read amber, a clean finish reads green.
 * A LIVE run gets none — the "En ce moment" banner owns its top edge.
 */
function renderRunEndMarker(run, isLive) {
  if (isLive) return null;
  if (!run.endedAt) {
    if (!isAbandoned(run)) return null;
    const evs = run.events ?? [];
    const last = evs.length ? Math.max(...evs.map((e) => e.ts ?? 0)) : Date.parse(run.startedAt);
    return runMarkerCard('var(--err)', [
      h('span', { class: 'when' }, fmtTime(last)),
      h('span', {}, t('marker.abandoned')),
      h('span', { class: 'meta' }, t('marker.abandoned.hint')),
    ]);
  }
  const when = h('span', { class: 'when' }, fmtTime(Date.parse(run.endedAt)));
  const dur = h('span', { class: 'meta' }, t('common.duration', { value: fmtMs(run.durationMs) }));
  if (run.cancelled) {
    return runMarkerCard('var(--err)', [when, h('span', {}, t('marker.cancelled')), dur]);
  }
  if (run.error) {
    return runMarkerCard('var(--err)', [when, h('span', {}, t('marker.error')), dur,
      h('span', { class: 'meta' }, String(run.error).slice(0, 120))]);
  }
  if (run.degraded) {
    return runMarkerCard('#fbbf24', [when, h('span', {}, t('marker.degraded')), dur]);
  }
  return runMarkerCard('var(--ok)', [when, h('span', {}, t('marker.end')), dur]);
}

/**
 * "EN CE MOMENT" — the in-flight calls of a live run, with a ticking
 * elapsed. Data source: unpaired llm-start events. The 1s live poll
 * re-renders this, so the elapsed advances without its own timer.
 */
/**
 * A run with no `endedAt` is only LIVE if something still happens. A crash,
 * a hard kill or a network blip that took the process down leaves the trace
 * without its closing stamp forever — and the UI used to poll such a run
 * eternally while showing a "happening now" banner for a call that died
 * hours ago (observed: a run hung by an aborted claude-cli subprocess).
 * Verdict is time-based on the LAST recorded event: no activity for
 * ABANDONED_AFTER_MS means abandoned.
 */
// 12 min, not 5. Measured on a live claude-cli batch: an L1 execute call
// sat silent for over 5 minutes while legitimately working (subprocess
// spawn per turn, adaptive thinking, a long tool loop emits no trace
// event until it returns), so the 5-minute rule labelled a HEALTHY run
// "abandoned" and stopped polling it. The threshold must exceed the
// longest plausible single call — the per-call transport deadline is
// 10 min, so anything past 12 is genuinely dead, not slow.
const ABANDONED_AFTER_MS = 12 * 60 * 1000;

function isAbandoned(run) {
  if (run.endedAt) return false;
  const evs = run.events ?? [];
  if (evs.length === 0) return Date.now() - Date.parse(run.startedAt) > ABANDONED_AFTER_MS;
  const last = Math.max(...evs.map((e) => e.ts ?? 0));
  return Date.now() - last > ABANDONED_AFTER_MS;
}

/**
 * THE single live predicate. Every "is this run happening now?" decision
 * must come through here.
 *
 * It used to be open-coded, and the copies disagreed: polling and the
 * events pane subtracted abandoned runs, the header badge and the "right
 * now" banner did not. A run wedged on 2026-08-08 then rendered "⚠ Run
 * abandoned" in its events and a green "● LIVE — polling every 1s" in its
 * header at the same time, the badge advertising a poll that had already
 * stopped. A UI that contradicts itself about its own behaviour is worse
 * than one that is merely wrong.
 */
function isRunLive(run) {
  return !run.endedAt && !isAbandoned(run);
}

/**
 * Same verdict from an INDEX entry, which carries no events. Falls back to
 * `startedAt` for entries written before `lastEventAt` existed — matching
 * `isAbandoned`'s own fallback for an event-less run.
 */
function isIndexEntryLive(entry) {
  if (entry.endedAt || !entry.inFlight) return false;
  const last = entry.lastEventAt ?? Date.parse(entry.startedAt);
  return Date.now() - last <= ABANDONED_AFTER_MS;
}

function renderNowBanner(run, completedIds, isLive) {
  const host = $('nowBanner');
  if (!host) return;
  host.innerHTML = '';
  if (!isLive) return;
  const inFlight = run.events.filter(
    (e) => e.kind === 'llm-start' && !completedIds.has(e.llmEventId)
  );
  if (inFlight.length === 0) return;
  const wrap = h('div', { class: 'section', style: 'border-left: 3px solid var(--accent); margin-bottom: 8px;' });
  wrap.appendChild(h('h3', {}, [
    h('span', { class: 'live-dot' }, '●'),
    h('span', {}, ' ' + t('now.title')),
  ]));
  for (const s of inFlight) {
    const secs = Math.max(0, Math.round((Date.now() - s.ts) / 1000));
    const row = [
      h('span', { class: 'role ' + s.role }, labelRole(s.role)),
    ];
    if (s.actor) row.push(atomRef(s.actor));
    if (s.child) {
      row.push(h('span', { class: 'arrow' }, '→'));
      row.push(atomRef(s.child));
    }
    row.push(h('span', { class: 'meta' }, s.model));
    row.push(h('span', { class: 'meta', style: secs > 120 ? 'color: var(--err); font-weight: 600;' : '' },
      t('now.elapsed', { seconds: secs }) + (secs > 120 ? t('now.tooLong') : '')));
    if (s.branchId) row.push(branchChip(s.branchId));
    // WHAT it is doing, not just which slot is busy. A bare role chip
    // ("EXECUTE") told you a call was open and nothing else — on a
    // multi-minute L1 tool loop that reads as "frozen". Two additions:
    // a plain sentence for the role, and the LIVE tool activity of THIS
    // call (tool events carry the llmEventId of the loop that spawned
    // them, so the correlation is exact rather than chronological).
    const cell = [
      h('div', { class: 'row' }, row),
      h('div', { class: 'now-what' }, describeInFlight(s)),
    ];
    const activity = inFlightToolActivity(run, s);
    if (activity) cell.push(h('div', { class: 'now-activity' }, activity));
    wrap.appendChild(h('div', { class: 'event', style: 'cursor: default;' }, cell));
  }
  host.appendChild(wrap);
}

/** One plain sentence naming the work behind the role chip. */
function describeInFlight(s) {
  const actor = s.actor?.name ?? '?';
  const child = s.child?.name;
  switch (s.role) {
    case 'plan':
      return t('now.doing.plan', { actor });
    case 'execute':
      return t('now.doing.execute', { actor });
    case 'prefilter':
      return t('now.doing.prefilter', { actor });
    case 'validate-plan':
      return t('now.doing.validatePlan', { actor, child: child ?? '?' });
    case 'validate-result':
      return t('now.doing.validateResult', { actor, child: child ?? '?' });
    case 'skill':
      // No actor: these calls carry no atom preamble (they are the
      // lifecycle engine's own Sonnet slots), so the line names the
      // ACTIVITY instead of showing a meaningless '?'.
      return t('now.doing.skill', {});
    case 'fallback-plan':
    case 'fallback-execute':
      return t('now.doing.fallback', { actor });
    default:
      return t('now.doing.unknown', { actor });
  }
}

/**
 * Live tool activity INSIDE the in-flight call. `VizToolEvent.llmEventId`
 * points at the loop that spawned it, so this is the exact set — not a
 * chronological guess that would mix in a sibling branch's tools.
 */
function inFlightToolActivity(run, s) {
  const tools = run.events.filter((e) => e.kind === 'tool' && e.llmEventId === s.llmEventId);
  if (tools.length === 0) return t('now.activity.none');
  const last = tools[tools.length - 1];
  const ago = Math.max(0, Math.round((Date.now() - last.ts) / 1000));
  const arg = toolArgSummary(last.name, last.args);
  return t('now.activity', {
    count: tools.length,
    tool: last.name + (arg ? ' ' + arg : ''),
    ago,
  });
}

/** The one argument that identifies what a tool call touched. */
function toolArgSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (k) => (typeof args[k] === 'string' ? args[k] : '');
  let v =
    pick('path') || pick('file') || pick('url') || pick('entry') || pick('command') || '';
  if (name === 'run_shell' && Array.isArray(args.args) && args.args.length) {
    v = (v + ' ' + args.args.filter((a) => typeof a === 'string').join(' ')).trim();
  }
  if (!v) return '';
  return v.length > 48 ? '…' + v.slice(-47) : v;
}

function branchChip(branchId) {
  // Show only the first 6 chars of the uuid — enough to disambiguate
  // a handful of parallel branches without cluttering the timeline.
  return h('span', {
    class: 'branch-chip',
    title: t('filters.fanoutBranch', { id: branchId }),
  }, '⑂' + branchId.slice(0, 6));
}

function renderEventCard(ev) {
  const selected = state.selectedEventId === ev.id ? ' selected' : '';
  if (ev.kind === 'llm-start') {
    // Only reachable for an ENDED run with an unpaired start: the call
    // left the process and never came back — killed subprocess, network
    // blip, or the run deadline. Making this visible post-mortem is the
    // point; it used to look like the run "did nothing" for minutes.
    const row = [
      h('span', { class: 'when' }, fmtTime(ev.ts)),
      h('span', { class: 'role ' + ev.role }, labelRole(ev.role)),
      h('span', { class: 'meta', style: 'color: var(--err); font-weight: 600;' }, t('event.interrupted')),
    ];
    if (ev.actor) row.splice(2, 0, atomRef(ev.actor));
    row.push(h('span', { class: 'meta' }, ev.model));
    if (ev.branchId) row.push(branchChip(ev.branchId));
    return h('div', { class: 'event interrupted' }, [h('div', { class: 'row' }, row)]);
  }
  if (ev.kind === 'llm') {
    const row = [
      h('span', { class: 'when' }, fmtTime(ev.ts)),
      h('span', { class: 'role ' + ev.role }, labelRole(ev.role)),
    ];
    if (ev.actor) row.push(atomRef(ev.actor));
    if (ev.child) {
      row.push(h('span', { class: 'arrow' }, '→'));
      row.push(atomRef(ev.child));
    }
    if (ev.subject) row.push(h('span', { class: 'meta' }, '[' + ev.subject + ']'));
    // OUTCOME AT A GLANCE. A prefilter card used to show model + tokens
    // but not the DECISION, and a validator card not the VERDICT — the
    // two things you actually scan a timeline for. Both are read from the
    // recorded response, so every already-archived run gains them too.
    for (const chip of outcomeChips(ev)) row.push(chip);
    if (ev.branchId) row.push(branchChip(ev.branchId));
    if (ev.error) row.push(h('span', { class: 'err-badge' }, t('event.error')));

    // Line 1 = WHAT happened (role, atoms, decision). Line 2 = what it
    // COST (model, price, tokens, timing). They used to share one flex
    // row with a spacer pushing the cost right: as soon as the decision
    // chip made the row overflow, the price alone wrapped to the next
    // line and the card looked broken. Two deliberate lines never do.
    // WHY THE MODEL CAN LOOK "WRONG" FOR THE TIER, and why it is not.
    // The atom badge says which ATOM made the call; the model says which
    // MODEL served it. For a prefilter these deliberately disagree: an L2
    // atom routes on the L1-tier model (modelForTier(1), cost.ts), because
    // "prefilter first, reason second" is the whole cost discipline — Sonnet
    // is only engaged if the cheap scan declines. Reported live as confusing,
    // and it was the display, not the routing: the card now says so.
    const cheapScan =
      ev.role === 'prefilter' && /haiku/i.test(ev.model || '')
        ? t('event.prefilter.cheapTier')
        : null;
    const meta = [
      shortModel(ev.model),
      cheapScan,
      fmtCost(ev.costUsd),
      `in: ${ev.usage.inputTokens}`,
      `out: ${ev.usage.outputTokens}`,
      ev.usage.cacheReadInputTokens ? `cache: ${ev.usage.cacheReadInputTokens}` : null,
      `${fmtMs(ev.durationMs)}`,
      ev.stopReason ? `stop: ${ev.stopReason}` : null,
    ].filter(Boolean).join('  ·  ');

    return h('div', {
      class: 'event' + selected,
      onclick: () => { state.selectedEventId = ev.id; renderEvents(); renderDetail(ev); },
    }, [
      h('div', { class: 'row' }, row),
      h('div', { class: 'meta cost-line' }, meta),
    ]);
  }
  if (ev.kind === 'tool') {
    const trow = [
      h('span', { class: 'when' }, fmtTime(ev.ts)),
      h('span', { class: 'role tool' }, 'tool'),
    ];
    if (ev.actor) trow.push(atomRef(ev.actor));
    trow.push(h('span', { class: 'name' }, ev.name));
    // WHICH file / url / command. A row reading only "read_file" forces a
    // click to learn anything, and a run makes dozens of them — the argument
    // is what makes the timeline scannable. Same extractor as the live
    // "right now" banner, so the two can never disagree.
    const targ = toolArgSummary(ev.name, ev.args);
    if (targ) trow.push(h('span', { class: 'tool-arg' }, targ));
    if (ev.branchId) trow.push(branchChip(ev.branchId));
    trow.push(h('span', { class: 'spacer', style: 'flex:1;' }));
    if (ev.error) trow.push(h('span', { class: 'err-badge' }, 'error'));
    trow.push(h('span', { class: 'meta' }, fmtMs(ev.durationMs)));
    return h('div', {
      class: 'event' + selected,
      onclick: () => { state.selectedEventId = ev.id; renderEvents(); renderDetail(ev); },
    }, [h('div', { class: 'row' }, trow)]);
  }
  if (ev.kind === 'trust') {
    const trow = [
      h('span', { class: 'when' }, fmtTime(ev.ts)),
      h('span', { class: 'role trust' }, 'trust'),
    ];
    if (ev.actor) trow.push(atomRef(ev.actor));
    if (ev.child) {
      trow.push(h('span', { class: 'arrow' }, '→'));
      trow.push(atomRef(ev.child));
    }
    trow.push(h('span', { class: 'meta' }, '[' + ev.subject + ']'));
    if (ev.branchId) trow.push(branchChip(ev.branchId));
    trow.push(h('span', { class: 'spacer', style: 'flex:1;' }));
    trow.push(h('span', { class: 'meta' }, '✓' + ev.successes + '/✗' + ev.failures));
    return h('div', {
      class: 'event' + selected,
      onclick: () => { state.selectedEventId = ev.id; renderEvents(); renderDetail(ev); },
    }, [
      h('div', { class: 'row' }, trow),
      h('div', { class: 'meta', style: 'margin-top:4px;' }, t('event.trust.fastPath')),
    ]);
  }
  if (ev.kind === 'cache') {
    // The routing decision that cost NOTHING: replayed from the on-disk
    // prefilter cache instead of asked of the model. Styled like the
    // ⚡ direct dispatch (the other zero-cost path) but in cyan, so a
    // glance down the timeline separates "free because cached" from
    // "free because compiled".
    const crow = [
      h('span', { class: 'when' }, fmtTime(ev.ts)),
      h('span', { class: 'role cache' }, t('event.cache.label')),
    ];
    if (ev.actor) crow.push(atomRef(ev.actor));
    crow.push(h('span', { class: 'meta' }, 'prefilter'));
    crow.push(h('span', {
      style: 'font-weight:600; color:' + (/^reuse/.test(ev.outcome) ? 'var(--ok)' : '#fbbf24') + ';',
    }, /^reuse /.test(ev.outcome) ? t('outcome.reuse', { target: ev.outcome.slice(6) }) : t('outcome.escalate')));
    if (ev.branchId) crow.push(branchChip(ev.branchId));
    crow.push(h('span', { style: 'color:#67e8f9; font-weight:700;' }, t('event.cache.free')));
    return h('div', {
      class: 'event' + selected,
      style: 'border-left: 3px solid #22d3ee; background: rgba(34, 211, 238, 0.06);',
      onclick: () => { state.selectedEventId = ev.id; renderEvents(); renderDetail(ev); },
    }, [
      h('div', { class: 'row' }, crow),
      // Same two-line shape as a real call card: line 2 carries the cost
      // facts — here, the model whose call was SKIPPED.
      h('div', { class: 'meta cost-line' },
        shortModel(ev.model) + '  ·  ' + t('event.cache.skipped')
        + (ev.reasoning ? '  ·  ' + ev.reasoning : '')),
    ]);
  }
  if (ev.kind === 'skill') {
    // The zero-token moment deserves to LOOK like one: a trusted compiled
    // skill executing with no LLM at all used to render as a barely
    // visible one-liner — the most important event in the system was the
    // least visible ("je ne vois pas le run à $0 dans la viz").
    const isDirect = ev.op === 'direct';
    // An EVENT-DRIVEN recovery injection is a different mechanism from a
    // task-recipe injection: matched mid-run on a failure signature by the
    // zero-LLM matcher, not by the task prefilter. Same op, so the
    // provenance is read from the reasoning the injector wrote.
    const isEventRecovery = ev.op === 'inject' && /^event-trigger/.test(ev.reasoning ?? '');
    const isBlocked = ev.op === 'quarantine' || ev.op === 'credit-withheld';
    const label = isDirect
      ? t('event.skill.direct')
      : isEventRecovery
        ? t('event.skill.recovery')
        : ev.op === 'quarantine'
          ? t('event.skill.quarantine')
          : ev.op === 'credit-withheld'
            ? t('event.skill.creditWithheld')
            : ev.op;
    const srow = [
      h('span', { class: 'when' }, fmtTime(ev.ts)),
      h('span', { class: 'role ' + ev.op }, label),
    ];
    if (ev.actor) srow.push(atomRef(ev.actor));
    srow.push(h('span', { class: 'arrow' }, '·'));
    srow.push(h('span', { class: 'name' }, ev.l1Name + '/' + ev.skillId));
    if (isDirect) {
      srow.push(h('span', {
        style: 'color: #ffd700; font-weight: 700;',
      }, t('event.skill.zeroLlm')));
    }
    if (isEventRecovery) {
      // Surface the containment score the mechanical matcher computed —
      // it is what decided this injection, and a low-ish one on a
      // questionable match is the first thing to look at.
      const m = (ev.reasoning ?? '').match(/^event-trigger \(([\d.]+)\)/);
      srow.push(h('span', { class: 'meta', style: 'color:#7dd3fc; font-weight:600;' },
        t('event.skill.triggeredMidRun') + (m ? t('event.skill.score', { score: m[1] }) : '')));
    }
    if (ev.branchId) srow.push(branchChip(ev.branchId));
    const accent = isDirect
      ? 'border-left: 3px solid #ffd700; background: rgba(255, 215, 0, 0.06);'
      : ev.op === 'quarantine'
        ? 'border-left: 3px solid var(--err); background: rgba(248, 113, 113, 0.06);'
        : ev.op === 'credit-withheld'
          ? 'border-left: 3px solid #fbbf24;'
          : isEventRecovery
            ? 'border-left: 3px solid #7dd3fc;'
            : '';
    return h('div', {
      class: 'event' + selected,
      style: accent,
      onclick: () => { state.selectedEventId = ev.id; renderEvents(); renderDetail(ev); },
    }, [
      h('div', { class: 'row' }, srow),
      ev.reasoning
        ? h('div', {
            class: 'meta',
            style: 'margin-top:4px;' + (isBlocked ? ' color: #fbbf24;' : ''),
          }, ev.reasoning)
        : null,
    ]);
  }
  // registry
  const row = [
    h('span', { class: 'when' }, fmtTime(ev.ts)),
    h('span', { class: 'role ' + ev.op }, ev.op),
  ];
  if (ev.tier) row.push(tierBadge(ev.tier));
  row.push(h('span', { class: 'name' }, ev.name));
  if (ev.from) {
    row.push(h('span', { class: 'arrow' }, '←'));
    row.push(h('span', { class: 'meta' }, 'from ' + ev.from));
  }
  if (ev.version != null) row.push(h('span', { class: 'meta' }, 'v' + ev.version));
  if (ev.by) row.push(h('span', { class: 'meta' }, 'by ' + ev.by));
  return h('div', {
    class: 'event' + selected,
    onclick: () => { state.selectedEventId = ev.id; renderEvents(); renderDetail(ev); },
  }, [h('div', { class: 'row' }, row)]);
}

function labelRole(r) {
  return {
    'plan': 'plan',
    'execute': 'execute',
    'validate-plan': 'validate plan',
    'validate-result': 'validate result',
    'prefilter': 'prefilter',
    'skill': 'skill',
    'fallback-plan': 'fallback plan',
    'fallback-execute': 'fallback exec',
    'unknown': 'unknown',
  }[r] ?? r;
}
function shortModel(m) {
  return (m || '').replace(/^claude-/, '');
}

function renderDetail(ev) {
  const el = $('rightPane');
  el.innerHTML = '';
  state.selectedAtomName = null;
  renderLanes(state.currentRun);
  if (ev.kind === 'llm') {
    renderLlmDetail(el, ev);
  } else if (ev.kind === 'tool') {
    renderToolDetail(el, ev);
  } else if (ev.kind === 'trust') {
    renderTrustDetail(el, ev);
  } else if (ev.kind === 'skill') {
    renderSkillEventDetail(el, ev);
  } else if (ev.kind === 'cache') {
    renderCacheDetail(el, ev);
  } else {
    renderRegistryDetail(el, ev);
  }
}

function renderCacheDetail(el, ev) {
  el.appendChild(h('h2', {}, t('detail.cache.title')));
  el.appendChild(h('div', { class: 'meta', style: 'margin-bottom:8px;' },
    [ev.actor ? t('detail.by', { name: ev.actor.name }) : null, t('detail.cache.avoidedModel', { model: ev.model })]
      .filter(Boolean).join('  ·  ')));
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, t('detail.cache.decision')),
    h('div', { style: 'font-weight:600;' }, ev.outcome),
    h('h3', { style: 'margin-top:10px;' }, t('detail.cache.reasoning')),
    h('div', { style: 'white-space:pre-wrap;' }, ev.reasoning || '—'),
  ]));
  el.appendChild(h('div', { class: 'section', style: 'margin-top:8px;' }, [
    h('div', { class: 'meta' }, t('detail.cache.explain')),
  ]));
}

function renderSkillEventDetail(el, ev) {
  const opLabel = {
    match: t('skillOp.match'),
    inject: t('skillOp.inject'),
    learn: t('skillOp.learn'),
    update: t('skillOp.update'),
    success: t('skillOp.success'),
    failure: t('skillOp.failure'),
    promote: t('skillOp.promote'),
    demote: t('skillOp.demote'),
    direct: t('skillOp.direct'),
    quarantine: t('skillOp.quarantine'),
    'credit-withheld': t('skillOp.creditWithheld'),
  }[ev.op] ?? ev.op;
  el.appendChild(h('h2', {}, opLabel));
  const sub = [];
  if (ev.actor) sub.push(t('detail.by', { name: ev.actor.name ?? '?' }));
  sub.push(ev.l1Name + ' / ' + ev.skillId);
  el.appendChild(h('div', { class: 'meta', style: 'margin-bottom:8px;' }, sub.join('  ·  ')));
  if (ev.reasoning) {
    el.appendChild(h('div', { class: 'section' }, [
      h('h3', {}, t('ev.reasoning')),
      h('pre', {}, ev.reasoning),
    ]));
  }
  // Convenience: jump straight to the skill's full content in the Skills tab.
  const open = h('span', {
    class: 'chip',
    style: 'cursor:pointer;',
    onclick: () => {
      switchView('skills');
      // Defer until skills are loaded.
      setTimeout(() => selectSkill(ev.l1Name, ev.skillId), 0);
    },
  }, t('registry.openSkill'));
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, t('common.link')),
    open,
  ]));
}

function renderTrustDetail(el, ev) {
  el.appendChild(h('h2', {}, t('ev.trustFastPath') + ' — ' + ev.subject));
  const sub = [];
  if (ev.actor) sub.push('by ' + (ev.actor.name ?? '?'));
  if (ev.child) sub.push('→ ' + (ev.child.name ?? '?'));
  sub.push('✓' + ev.successes + '/✗' + ev.failures);
  el.appendChild(h('div', { class: 'meta', style: 'margin-bottom:8px;' }, sub.join('  ·  ')));
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, 'Reasoning'),
    h('pre', {}, ev.reasoning || '(no reasoning)'),
  ]));
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, t('ev.whyHere')),
    h('pre', {},
      'The child type has enough clean successes to bypass the validator\n' +
      'LLM call. The supervisor returned a synthetic approval immediately\n' +
      'instead of paying for a full verdict round-trip. This is the\n' +
      'trust-fast-path optimisation from src/atoms/cost.ts — no LLM call\n' +
      'fires, no tokens are billed. The event appears here so the timeline\n' +
      'still accounts for the supervision decision.'),
  ]));
}

function renderToolDetail(el, ev) {
  el.appendChild(h('h2', {}, ev.name));
  const sub = [];
  if (ev.actor) sub.push('by ' + (ev.actor.name ?? '?'));
  if (ev.error) sub.push('ERROR');
  sub.push(fmtMs(ev.durationMs));
  el.appendChild(h('div', { class: 'meta', style: 'margin-bottom:8px;' }, sub.join('  ·  ')));
  el.appendChild(h('h3', { style: 'margin-top:12px;' }, 'args'));
  el.appendChild(h('pre', {}, JSON.stringify(ev.args ?? {}, null, 2)));
  if (ev.error) {
    el.appendChild(h('h3', { style: 'margin-top:12px;' }, 'error'));
    el.appendChild(h('pre', {}, ev.error));
  } else {
    el.appendChild(h('h3', { style: 'margin-top:12px;' }, 'result'));
    const rendered = typeof ev.result === 'string'
      ? ev.result
      : JSON.stringify(ev.result, null, 2);
    el.appendChild(h('pre', {}, rendered ?? '(empty)'));
  }
}

function renderAtomDetail(entry) {
  const el = $('rightPane');
  el.innerHTML = '';
  const s = entry.snapshot;
  const originLabel = {
    created: t('registry.origin.created'),
    branched: t('registry.origin.branched'),
    patched: t('registry.origin.patched'),
    existing: t('registry.origin.existing'),
  }[entry.origin] ?? entry.origin;

  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, `${t('registry.atom')} — ${s.name}`),
    h('div', { class: 'kv' }, [
      h('div', { class: 'k' }, 'Tier'), h('div', { class: 'v' }, [tierBadge(s.tier), ' ', h('span', { class: 'meta' }, `#${s.ordinal}`)]),
      h('div', { class: 'k' }, 'Version'), h('div', { class: 'v' }, 'v' + s.version),
      h('div', { class: 'k' }, 'Origine'), h('div', { class: 'v' }, originLabel),
      h('div', { class: 'k' }, t('registry.createdBy')), h('div', { class: 'v' }, `${s.createdBy}  ·  ${s.createdAt}`),
      h('div', { class: 'k' }, t('registry.successFailure')), h('div', { class: 'v' }, `✓ ${s.successes}  ·  ✗ ${s.failures}`),
      h('div', { class: 'k' }, 'Params'), h('div', { class: 'v' }, JSON.stringify(s.params)),
      h('div', { class: 'k' }, t('common.tools')), h('div', { class: 'v' },
        (s.tools && s.tools.length)
          ? h('div', { class: 'tools-list' }, s.tools.map((t) => h('span', { class: 'chip muted' }, t)))
          : h('span', { class: 'meta' }, t('common.none'))),
    ]),
  ]));

  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, 'Description'),
    h('pre', {}, s.description || t('common.empty')),
  ]));

  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, t('ev.systemPrompt')),
    h('pre', {}, s.systemPrompt || t('common.empty')),
  ]));

  if (entry.events && entry.events.length > 0) {
    const rows = entry.events
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .map((ev) => {
        const row = [
          h('span', { class: 'when' }, fmtTime(ev.ts)),
          h('span', { class: 'role ' + ev.op }, ev.op),
        ];
        if (ev.version != null) row.push(h('span', { class: 'meta' }, 'v' + ev.version));
        if (ev.from) row.push(h('span', { class: 'meta' }, '← ' + ev.from));
        if (ev.by) row.push(h('span', { class: 'meta' }, 'by ' + ev.by));
        if (ev.reason) row.push(h('span', { class: 'meta' }, ev.reason));
        const wrap = h('div', { class: 'row', style: 'cursor:pointer;' }, row);
        wrap.addEventListener('click', () => {
          state.selectedEventId = ev.id;
          state.selectedAtomName = null;
          renderLanes(state.currentRun);
          renderEvents();
          renderDetail(ev);
        });
        return wrap;
      });
    el.appendChild(h('div', { class: 'section' }, [
      h('h3', {}, t('skills.historyInRun', { count: entry.events.length })),
      h('div', { class: 'history-list' }, rows),
    ]));
  }
}

function renderLlmDetail(el, ev) {
  const header = h('div', { class: 'section' }, [
    h('h3', {}, t('ev.llmCall') + ' — ' + labelRole(ev.role)),
    h('div', { class: 'kv' }, [
      ...(ev.actor ? [h('div', { class: 'k' }, 'Acteur'), h('div', { class: 'v' }, [atomRef(ev.actor)])] : []),
      ...(ev.child ? [h('div', { class: 'k' }, 'Enfant'), h('div', { class: 'v' }, [atomRef(ev.child)])] : []),
      ...(ev.subject ? [h('div', { class: 'k' }, 'Sujet'), h('div', { class: 'v' }, ev.subject)] : []),
      h('div', { class: 'k' }, t('registry.model')), h('div', { class: 'v' }, ev.model),
      h('div', { class: 'k' }, t('summary.duration')), h('div', { class: 'v' }, fmtMs(ev.durationMs)),
      h('div', { class: 'k' }, 'Tokens'), h('div', { class: 'v' },
        `in=${ev.usage.inputTokens}  out=${ev.usage.outputTokens}  cacheRead=${ev.usage.cacheReadInputTokens}  cacheCreate=${ev.usage.cacheCreationInputTokens}`),
      h('div', { class: 'k' }, t('summary.cost')), h('div', { class: 'v' }, fmtCost(ev.costUsd)),
      h('div', { class: 'k' }, t('ev.stopReason')), h('div', { class: 'v' }, ev.stopReason ?? '—'),
      ...(ev.error ? [h('div', { class: 'k' }, t('event.error')), h('div', { class: 'v' }, ev.error)] : []),
    ]),
  ]);
  el.appendChild(header);

  // Tabs: System prompt, User content, Response
  const tabs = h('div', { class: 'tabs' });
  const body = h('div');
  const entries = [
    [t('ev.systemPrompt'), ev.systemPrompt, 'raw'],
    ['User content', ev.userContent, 'raw'],
    ['Response', ev.response || (ev.error ? t('detail.noResponse') : ''), 'response'],
  ];
  const renderTab = (txt, kind) => {
    body.innerHTML = '';
    if (kind === 'response') {
      // Try the strategy+plan structured render first; fall back to
      // pretty-printed JSON; fall back to raw text. The walls-of-JSON
      // we used to render here are ~unreadable for plan/prefilter calls.
      const node = renderStructuredResponse(txt);
      body.appendChild(node);
      return;
    }
    body.appendChild(h('pre', {}, txt || t('common.empty')));
  };
  // Sticky tab: remember which tab the user reads (e.g. "Response") so
  // opening another event — or any future re-render — lands on the same
  // one instead of bouncing back to the default.
  const initial = Math.min(state.detailTabIndex ?? 1, entries.length - 1);
  entries.forEach(([lbl, txt, kind], i) => {
    const tab = h('div', { class: 'tab' + (i === initial ? ' active' : '') }, lbl);
    tab.addEventListener('click', () => {
      [...tabs.children].forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.detailTabIndex = i;
      renderTab(txt, kind);
    });
    tabs.appendChild(tab);
  });
  renderTab(entries[initial][1], entries[initial][2]);
  el.appendChild(h('div', { class: 'section' }, [h('h3', {}, t('detail.prompts')), tabs, body]));
}

/**
 * Try to make sense of an LLM response body. Three rendering paths:
 *   1. strategy+plan pair (a JSON array of two objects whose first carries
 *      a `strategy` field and whose second carries `subtasks`) — render
 *      structured sections so a human can scan it without parsing JSON
 *      in their head. This is the main case for L2/L3 plan calls.
 *   2. any other JSON — pretty-print with 2-space indent and word-wrap.
 *   3. non-JSON / parse error — raw text inside <pre>.
 * Returns a single element to insert into the body.
 */
function renderStructuredResponse(txt) {
  if (!txt || !txt.trim()) return h('pre', {}, t('common.empty'));
  const parsed = tryParseJson(txt);
  if (parsed === undefined) return h('pre', {}, txt);
  // Strategy + plan pair detection.
  if (Array.isArray(parsed) && parsed.length === 2
    && parsed[0] && typeof parsed[0] === 'object' && 'strategy' in parsed[0]
    && parsed[1] && typeof parsed[1] === 'object' && Array.isArray(parsed[1].subtasks)
  ) {
    return renderStrategyPlanPair(parsed[0], parsed[1], txt);
  }
  // Anything else parseable: prettify.
  const wrap = h('div');
  wrap.appendChild(h('pre', {}, JSON.stringify(parsed, null, 2)));
  return wrap;
}

function tryParseJson(txt) {
  try { return JSON.parse(txt); } catch {}
  // Tolerate fenced JSON ```json ... ```
  const fence = txt.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  // Tolerate leading/trailing prose around a balanced JSON value.
  const start = txt.search(/{|\[/);
  if (start >= 0) {
    try { return JSON.parse(txt.slice(start)); } catch {}
  }
  return undefined;
}

function renderStrategyPlanPair(strategy, plan, _raw) {
  const wrap = h('div', { class: 'plan-card' });

  // Strategy block.
  const stratKv = h('div', { class: 'kv' }, [
    h('div', { class: 'k' }, 'Strategy'), h('div', { class: 'v' }, strategy.strategy || '—'),
    ...(strategy.target ? [h('div', { class: 'k' }, 'Target'), h('div', { class: 'v' }, strategy.target)] : []),
    h('div', { class: 'k' }, 'Reasoning'), h('div', { class: 'v', style: 'white-space:pre-wrap;' }, strategy.reasoning || '—'),
  ]);
  wrap.appendChild(h('div', { class: 'section', style: 'margin-top:8px;' }, [
    h('h3', {}, 'Strategy'),
    stratKv,
    ...(strategy.seed ? [
      h('h3', { style: 'margin-top:10px;' }, 'Seed'),
      h('pre', {}, JSON.stringify(strategy.seed, null, 2)),
    ] : []),
  ]));

  // Plan block.
  const aggMode = plan.aggregation && plan.aggregation.mode ? plan.aggregation.mode : 'concat';
  const planKv = h('div', { class: 'kv' }, [
    h('div', { class: 'k' }, 'Reasoning'), h('div', { class: 'v', style: 'white-space:pre-wrap;' }, plan.reasoning || '—'),
    h('div', { class: 'k' }, 'Aggregation'), h('div', { class: 'v' },
      h('span', {
        class: 'chip',
        title: aggMode === 'sequential'
          ? 'phases run one-at-a-time on a shared workspace'
          : aggMode === 'llm-synthesize'
            ? 'parallel — supervisor merges sub-results via LLM'
            : 'parallel — outputs concatenated mechanically',
      }, aggMode)
    ),
    ...(plan.aggregation && plan.aggregation.instruction
      ? [h('div', { class: 'k' }, t('ev.mergeInstruction')), h('div', { class: 'v', style: 'white-space:pre-wrap;' }, plan.aggregation.instruction)]
      : []),
    h('div', { class: 'k' }, t('ev.expectedOutput')), h('div', { class: 'v', style: 'white-space:pre-wrap;' }, plan.expectedOutput || '—'),
  ]);

  // Subtasks list — the part that was unreadable as raw JSON.
  const subtasks = plan.subtasks || [];
  const orderHint = aggMode === 'sequential' ? 'sequential phases' : 'parallel subtasks';
  const subtaskCards = subtasks.map((s, i) => {
    const head = h('div', { class: 'row', style: 'gap:6px;' }, [
      h('span', { class: 'role ' + (aggMode === 'sequential' ? 'inject' : 'plan') },
        aggMode === 'sequential' ? `phase #${i + 1}` : `#${i + 1}`),
      ...(s.preferredChild ? [h('span', { class: 'name' }, '➜ ' + s.preferredChild)] : []),
    ]);
    const desc = h('div', { style: 'white-space:pre-wrap; margin-top:4px;' }, s.description || '');
    const inputs = s.inputs && Object.keys(s.inputs).length > 0
      ? h('div', { class: 'meta', style: 'margin-top:4px; white-space:pre-wrap;' },
          'inputs: ' + JSON.stringify(s.inputs))
      : null;
    return h('div', { class: 'section', style: 'margin:6px 0; padding:8px;' }, [head, desc, inputs]);
  });

  wrap.appendChild(h('div', { class: 'section', style: 'margin-top:8px;' }, [
    h('h3', {}, `Plan — ${subtasks.length} ${orderHint}`),
    planKv,
    ...(subtasks.length > 0
      ? [h('h3', { style: 'margin-top:10px;' }, 'Subtasks'), ...subtaskCards]
      : []),
  ]));

  // Raw JSON fallback toggle for the curious / debugging.
  const rawWrap = h('div', { style: 'display:none; margin-top:8px;' }, [
    h('pre', {}, JSON.stringify([strategy, plan], null, 2)),
  ]);
  const toggle = h('div', {
    class: 'meta',
    style: 'cursor:pointer; margin-top:6px;',
    onclick: () => {
      rawWrap.style.display = rawWrap.style.display === 'none' ? '' : 'none';
    },
  }, t('common.toggleRawJson'));
  wrap.appendChild(toggle);
  wrap.appendChild(rawWrap);

  return wrap;
}

function renderRegistryDetail(el, ev) {
  const head = h('div', { class: 'section' }, [
    h('h3', {}, t('ev.registryMutation') + ' — ' + ev.op),
    h('div', { class: 'kv' }, [
      h('div', { class: 'k' }, 'Nom'), h('div', { class: 'v' }, ev.name),
      ...(ev.tier ? [h('div', { class: 'k' }, 'Tier'), h('div', { class: 'v' }, [tierBadge(ev.tier)])] : []),
      ...(ev.from ? [h('div', { class: 'k' }, 'Origine'), h('div', { class: 'v' }, ev.from)] : []),
      ...(ev.by ? [h('div', { class: 'k' }, 'Par'), h('div', { class: 'v' }, ev.by)] : []),
      ...(ev.version != null ? [h('div', { class: 'k' }, 'Version'), h('div', { class: 'v' }, 'v' + ev.version)] : []),
      ...(ev.reason ? [h('div', { class: 'k' }, t('common.reason')), h('div', { class: 'v' }, ev.reason)] : []),
    ]),
  ]);
  el.appendChild(head);
  if (ev.modifications) {
    el.appendChild(h('div', { class: 'section' }, [
      h('h3', {}, 'Modifications'),
      h('pre', {}, JSON.stringify(ev.modifications, null, 2)),
    ]));
  }
  if (ev.snapshot) {
    el.appendChild(h('div', { class: 'section' }, [
      h('h3', {}, 'Snapshot'),
      h('div', { class: 'kv' }, [
        h('div', { class: 'k' }, 'Description'), h('div', { class: 'v' }, ev.snapshot.description),
        h('div', { class: 'k' }, 'Params'), h('div', { class: 'v' }, JSON.stringify(ev.snapshot.params)),
        h('div', { class: 'k' }, t('registry.successFailure')), h('div', { class: 'v' }, `${ev.snapshot.successes} / ${ev.snapshot.failures}`),
        h('div', { class: 'k' }, t('registry.createdAt')), h('div', { class: 'v' }, ev.snapshot.createdAt),
      ]),
      h('h3', { style: 'margin-top:12px;' }, t('ev.systemPrompt')),
      h('pre', {}, ev.snapshot.systemPrompt),
    ]));
  }
}

$('runSelect').addEventListener('change', (e) => selectRun(e.target.value));
$('registrySelect').addEventListener('change', (e) => selectRegistry(e.target.value));
$('registrySearch').addEventListener('input', (e) => {
  state.registryFilter = e.target.value.toLowerCase();
  renderRegistryLanes();
});
$('skillsSearch').addEventListener('input', (e) => {
  state.skillsFilter = e.target.value.toLowerCase();
  renderSkillsLanes();
});
$('refreshBtn').addEventListener('click', () => {
  // Explicit per-view dispatch. The unguarded `else loadSkills()` this
  // replaces meant Refresh reloaded the SKILLS list while the Burn-in tab
  // was open — silent, because it repopulated a pane the user was not
  // looking at. A new tab inherited the same bug by default.
  if (state.view === 'runs') loadIndex();
  else if (state.view === 'registry') loadRegistries();
  else if (state.view === 'burnin') loadBurnin();
  else if (state.view === 'launch') { launchState.profiles = []; loadLaunch(); }
  else loadSkills();
});

for (const btn of $('viewSwitch').querySelectorAll('button')) {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
}

function switchView(v) {
  if (state.view === v) return;
  state.view = v;
  for (const btn of $('viewSwitch').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.view === v);
  }
  const isRuns = v === 'runs';
  const isReg = v === 'registry';
  const isSkills = v === 'skills';
  const isBurnin = v === 'burnin';
  const isLaunch = v === 'launch';
  $('runsView').style.display = isRuns ? '' : 'none';
  $('registryView').style.display = isReg ? '' : 'none';
  $('skillsView').style.display = isSkills ? '' : 'none';
  $('burninView').style.display = isBurnin ? '' : 'none';
  $('launchView').style.display = isLaunch ? '' : 'none';
  $('runSelect').style.display = isRuns ? '' : 'none';
  $('registrySelect').style.display = isReg ? '' : 'none';
  $('registrySearch').style.display = isReg ? '' : 'none';
  $('skillsSearch').style.display = isSkills ? '' : 'none';
  const singlePane = isBurnin || isLaunch;
  document.querySelector('.layout').classList.toggle('single-pane', singlePane);
  $('rightPane').style.display = singlePane ? 'none' : '';
  const emptyMsg = isRuns
    ? t('pane.selectEvent')
    : isReg
      ? t('pane.selectAtom')
      : isBurnin
        ? t('pane.selectBurnin')
        : isLaunch
          ? t('pane.selectLaunch')
          : t('pane.selectSkill');
  if (!singlePane) $('rightPane').innerHTML = '<div class="empty">' + emptyMsg + '</div>';
  if (isReg && state.registries.length === 0) loadRegistries();
  if (isSkills && state.skillNamespaces.length === 0) loadSkills();
  if (isBurnin) loadBurnin();
  if (isLaunch) loadLaunch();
}

// ── Launch view ──────────────────────────────────────────────────────────
// Pick a task family, read how to phrase a goal for it, and get the exact
// command to run. It does NOT start anything, and that is a deliberate
// design decision rather than an unfinished one: a run can call BACK into
// this server (fetch_url has no URL allowlist by design, and run_shell's
// allowlist is documented as "STEERING, not a boundary"), so a launch token
// served over HTTP would be readable by the very code it exists to gate.
// The server therefore stays a pure observer — no writeFileSync, no
// child_process, SQLite readonly.
let launchState = { profiles: [], selected: null };

async function loadLaunch() {
  const host = $('launchForm');
  if (launchState.profiles.length > 0) { renderLaunch(); return; }
  host.textContent = '';
  host.appendChild(h('div', { class: 'empty' }, t('common.loading')));
  try {
    const r = await fetch('/api/profiles');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    launchState.profiles = data.profiles ?? [];
    launchState.selected = launchState.profiles[0]?.id ?? null;
    renderLaunch();
  } catch (err) {
    host.textContent = '';
    host.appendChild(h('div', { class: 'empty' }, t('common.networkError') + ' — ' + err.message));
  }
}

function currentLaunchProfile() {
  return launchState.profiles.find((p) => p.id === launchState.selected) ?? null;
}

function launchCommand(profile, goal) {
  if (!profile) return '';
  const g = (goal ?? '').trim();
  if (!g) return '';
  // Display only — this is text to paste into a shell, never an argv we
  // build. Double quotes inside the goal are escaped so the pasted line
  // stays one argument.
  return 'npm run ' + profile.npmScript + ' -- "' + g.replace(/"/g, '\\"') + '"';
}

function renderLaunch() {
  const host = $('launchForm');
  host.textContent = '';
  const profile = currentLaunchProfile();
  if (!profile) {
    host.appendChild(h('div', { class: 'empty' }, t('common.none')));
    return;
  }

  const select = h('select', { id: 'launchFamily' },
    launchState.profiles.map((p) =>
      h('option', p.id === launchState.selected ? { value: p.id, selected: 'selected' } : { value: p.id }, p.label)
    )
  );
  select.addEventListener('change', () => {
    launchState.selected = select.value;
    renderLaunch();
  });

  // Prefer a translated help text when the catalog carries one for this
  // family; t() returns the key itself when missing, which is the signal to
  // fall back to the profile's own English string from the server.
  const helpKey = 'launch.help.' + profile.id;
  const translated = t(helpKey);
  const helpText = translated === helpKey ? profile.help : translated;

  const textarea = h('textarea', {
    id: 'launchGoal',
    rows: '5',
    placeholder: t('launch.goal.placeholder'),
    style: 'width:100%; box-sizing:border-box; font:inherit; padding:8px; resize:vertical;',
  });

  const cmdBox = h('code', {
    id: 'launchCmd',
    style: 'display:block; white-space:pre-wrap; word-break:break-all; padding:8px; opacity:0.85;',
  }, t('launch.empty'));

  const copyBtn = h('button', { id: 'launchCopy', disabled: 'disabled' }, t('launch.copy'));
  copyBtn.addEventListener('click', () => {
    const cmd = launchCommand(profile, textarea.value);
    if (!cmd) return;
    navigator.clipboard?.writeText(cmd);
    copyBtn.textContent = t('launch.copied');
    setTimeout(() => { copyBtn.textContent = t('launch.copy'); }, 1200);
  });

  const sync = () => {
    const cmd = launchCommand(profile, textarea.value);
    cmdBox.textContent = cmd || t('launch.empty');
    if (cmd) copyBtn.removeAttribute('disabled');
    else copyBtn.setAttribute('disabled', 'disabled');
  };
  textarea.addEventListener('input', sync);

  const examples = h('div', { class: 'section' }, [
    h('div', { class: 'meta' }, t('launch.examples')),
    ...profile.examples.map((ex) => {
      const item = h('div', {
        class: 'meta',
        style: 'cursor:pointer; padding:4px 0; text-decoration:underline dotted;',
      }, ex);
      item.addEventListener('click', () => { textarea.value = ex; sync(); });
      return item;
    }),
  ]);

  host.appendChild(h('div', { class: 'section' }, [
    h('div', { class: 'meta' }, t('launch.family')),
    select,
  ]));
  host.appendChild(h('div', { class: 'section' }, [
    h('div', { class: 'meta' }, t('launch.help')),
    h('p', { style: 'margin:6px 0 0; line-height:1.5;' }, helpText),
  ]));
  host.appendChild(h('div', { class: 'section' }, [
    h('div', { class: 'meta' }, t('launch.goal')),
    textarea,
  ]));
  host.appendChild(examples);
  host.appendChild(h('div', { class: 'section' }, [
    h('div', { class: 'meta' }, t('launch.command')),
    cmdBox,
    copyBtn,
  ]));
  sync();
}

// ── Burn-in view ─────────────────────────────────────────────────────────
// The cost-decay curve, rendered from burnin/results.csv via /api/burnin.
// Left pane: per-family stat cards, an SVG scatter of cost per run in batch
// order (the x axis IS experience), and the row table — clicking a row jumps
// to that run's full trace in the Runs view.

const FAMILY_COLORS = { cli: '#34d399', web: '#60a5fa', http: '#c084fc', app: '#6ea8ff', files: '#f59e0b' };
let burninChartInstance = null;
let burninZoomFrame = null;

function burninTimestamp(row, index = 0) {
  const parsed = Date.parse(row.ts);
  return Number.isFinite(parsed) ? parsed : index;
}

function quantile(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function burninBaseRows() {
  const filters = state.burninFilters;
  let rows = state.burninRows.filter((row) =>
    (filters.family === 'all' || row.family === filters.family) &&
    (filters.outcome === 'all' ||
      (filters.outcome === 'delivered' ? row.outcome === 'delivered' : row.outcome !== 'delivered'))
  );
  if (filters.preset !== 'all' && rows.length > 0) {
    const maxTime = Math.max(...rows.map((row, index) => burninTimestamp(row, index)));
    const days = Number(filters.preset);
    const threshold = maxTime - days * 24 * 60 * 60 * 1000;
    rows = rows.filter((row, index) => burninTimestamp(row, index) >= threshold);
  }
  return rows;
}

function burninSelectedRows() {
  const { zoomStart, zoomEnd } = state.burninFilters;
  return burninBaseRows().filter((row, index) => {
    const ts = burninTimestamp(row, index);
    return (zoomStart == null || ts >= zoomStart) && (zoomEnd == null || ts <= zoomEnd);
  });
}

function burninControl(label, value, choices, onChange) {
  const select = h('select', {});
  for (const [choiceValue, choiceLabel] of choices) {
    select.appendChild(h('option', { value: choiceValue }, choiceLabel));
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return h('div', { class: 'burnin-control' }, [h('label', {}, label), select]);
}

function clearBurninZoom() {
  state.burninFilters.zoomStart = null;
  state.burninFilters.zoomEnd = null;
  state.burninFilters.page = 1;
}

function renderBurninToolbar() {
  const host = $('burninToolbar');
  host.innerHTML = '';
  const families = [...new Set(state.burninRows.map((row) => row.family))].sort();
  const filters = state.burninFilters;
  const update = (key, value) => {
    filters[key] = value;
    clearBurninZoom();
    refreshBurninView({ chart: true });
  };
  const reset = h('button', { type: 'button' }, t('burnin.resetZoom'));
  reset.addEventListener('click', () => {
    clearBurninZoom();
    burninChartInstance?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    refreshBurninView({ chart: false });
  });
  host.appendChild(h('div', { class: 'burnin-toolbar' }, [
    burninControl(
      t('burnin.family'),
      filters.family,
      [['all', t('burnin.all')], ...families.map((family) => [family, family])],
      (value) => update('family', value)
    ),
    burninControl(
      t('burnin.outcome'),
      filters.outcome,
      [
        ['all', t('burnin.all')],
        ['delivered', t('burnin.deliveredOnly')],
        ['failed', t('burnin.failedOnly')],
      ],
      (value) => update('outcome', value)
    ),
    burninControl(
      t('burnin.timeRange'),
      filters.preset,
      [
        ['all', t('burnin.allTime')],
        ['1', t('burnin.last24h')],
        ['7', t('burnin.last7d')],
        ['30', t('burnin.last30d')],
      ],
      (value) => update('preset', value)
    ),
    reset,
    h('span', { class: 'burnin-selection' }, t('burnin.selected', { count: burninSelectedRows().length })),
  ]));
}

async function loadBurnin() {
  $('burninSummary').innerHTML = `<div class="loader">${t('common.loading')}</div>`;
  let payload;
  try {
    const response = await fetch('/api/burnin');
    payload = await response.json();
  } catch {
    $('burninSummary').innerHTML = '<div class="empty">' + t('burnin.unavailable') + '</div>';
    return;
  }
  const rows = payload.rows || [];
  state.burninRows = rows;
  clearBurninZoom();
  if (rows.length === 0) {
    $('burninToolbar').innerHTML = '';
    $('burninSummary').innerHTML =
      '<div class="empty">' + t('burnin.empty', { path: escapeHtml(payload.csvPath) }) + '</div>';
    $('burninChart').innerHTML = '';
    $('burninRows').innerHTML = '';
    $('burninPager').innerHTML = '';
    return;
  }
  refreshBurninView({ chart: true });
}

function burninStat(label, value) {
  return h('div', { class: 'burnin-stat' }, [
    h('span', { class: 'meta' }, label),
    h('span', { class: 'value' }, value),
  ]);
}

function renderBurninSummary(rows) {
  const host = $('burninSummary');
  host.innerHTML = '';
  if (rows.length === 0) {
    host.appendChild(h('div', { class: 'empty' }, t('burnin.selected', { count: 0 })));
    return;
  }
  const delivered = rows.filter((row) => row.outcome === 'delivered').length;
  const costs = rows.map((row) => row.costUsd).filter((value) => value != null);
  const durations = rows.map((row) => row.durationS).filter((value) => value != null);
  host.appendChild(h('div', { class: 'burnin-overview' }, [
    burninStat(t('burnin.runsSelected'), String(rows.length)),
    burninStat(t('burnin.deliveryRate'), Math.round((delivered / rows.length) * 100) + '%'),
    burninStat(
      t('burnin.medianCost'),
      costs.length ? '$' + quantile(costs, 0.5).toFixed(3) : '—'
    ),
    burninStat(
      t('burnin.p90Duration'),
      durations.length ? quantile(durations, 0.9) + 's' : '—'
    ),
  ]));

  const byFamily = new Map();
  for (const row of rows) {
    const family = byFamily.get(row.family) || {
      total: 0,
      delivered: 0,
      costs: [],
      refusals: 0,
      compileErrors: 0,
    };
    family.total++;
    if (row.outcome === 'delivered') family.delivered++;
    if (row.costUsd != null) family.costs.push(row.costUsd);
    family.refusals += row.refusals || 0;
    family.compileErrors += row.compileErrors || 0;
    byFamily.set(row.family, family);
  }
  const strip = h('div', { class: 'burnin-family-strip' }, [
    h('span', { class: 'meta' }, t('burnin.familyBreakdown')),
  ]);
  for (const [name, family] of [...byFamily.entries()].sort()) {
    const median = family.costs.length ? '$' + quantile(family.costs, 0.5).toFixed(3) : '—';
    const lifecycle =
      (family.refusals ? ' · ⛔' + family.refusals : '') +
      (family.compileErrors ? ' · ⚠' + family.compileErrors : '');
    strip.appendChild(h('span', {
      class: 'chip burnin-family-chip',
      style: 'border-left-color:' + (FAMILY_COLORS[name] || 'var(--accent)'),
      title:
        t('burnin.refusals', { count: family.refusals }) + ' · ' +
        t('burnin.compileErrors', { count: family.compileErrors }),
    }, name + ' · ' + family.delivered + '/' + family.total + ' · ' + median + lifecycle));
  }
  host.appendChild(strip);
}

function renderBurninChart(rows) {
  const host = $('burninChart');
  burninChartInstance?.dispose();
  burninChartInstance = null;
  host.innerHTML = '';
  const plotted = rows.filter((row) => row.costUsd != null);
  if (plotted.length === 0) return;

  const chartHost = h('div', { class: 'section burnin-chart' });
  host.appendChild(chartHost);
  burninChartInstance = initChart(chartHost, null, { renderer: 'canvas' });
  const families = [...new Set(plotted.map((row) => row.family))].sort();
  const series = families.map((family) => ({
    name: family,
    type: 'scatter',
    large: plotted.length > 2000,
    largeThreshold: 2000,
    progressive: 3000,
    symbolSize: 7,
    itemStyle: { color: FAMILY_COLORS[family] || '#f59e0b' },
    data: plotted
      .filter((row) => row.family === family)
      .map((row, index) => ({
        value: [burninTimestamp(row, index), row.costUsd],
        row,
        symbol: row.outcome === 'delivered' ? 'circle' : 'emptyCircle',
        symbolSize: row.outcome === 'delivered' ? 7 : 10,
      })),
  }));
  burninChartInstance.setOption({
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: '#8a96ae', fontFamily: 'system-ui, sans-serif' },
    legend: { top: 4, textStyle: { color: '#8a96ae' } },
    grid: { left: 58, right: 24, top: 42, bottom: 72 },
    toolbox: {
      right: 16,
      top: 4,
      iconStyle: { borderColor: '#8a96ae' },
      feature: { dataZoom: { yAxisIndex: 'none' }, restore: {} },
    },
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        const row = params.data.row;
        return '<strong>' + escapeHtml(row.taskId) + '</strong><br>' +
          escapeHtml(new Date(burninTimestamp(row)).toLocaleString(LOCALE)) + '<br>' +
          escapeHtml(row.family) + ' · ' + escapeHtml(row.outcome) + '<br>' +
          '$' + escapeHtml(row.costUsd) + ' · ' + escapeHtml(row.durationS ?? '?') + 's · ' +
          escapeHtml(row.llmCalls ?? '?') + ' LLM';
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#1f2a3d' } },
      axisLabel: {
        color: '#8a96ae',
        formatter: (value) =>
          new Intl.DateTimeFormat(LOCALE, {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(value)),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: 'USD',
      min: 0,
      axisLabel: { color: '#8a96ae', formatter: (value) => '$' + Number(value).toFixed(2) },
      splitLine: { lineStyle: { color: '#1f2a3d' } },
    },
    dataZoom: [
      { type: 'inside', filterMode: 'filter', throttle: 80 },
      {
        type: 'slider',
        filterMode: 'filter',
        height: 24,
        bottom: 20,
        borderColor: '#1f2a3d',
        backgroundColor: '#0f1523',
        fillerColor: 'rgba(110,168,255,.18)',
        dataBackground: { lineStyle: { color: '#6ea8ff' }, areaStyle: { color: '#1a2335' } },
        textStyle: { color: '#8a96ae' },
      },
    ],
    series,
  });
  burninChartInstance.on('datazoom', (event) => {
    cancelAnimationFrame(burninZoomFrame);
    burninZoomFrame = requestAnimationFrame(() => {
      const zoom = event.batch?.[0] || event;
      const start = Number(zoom.start ?? 0);
      const end = Number(zoom.end ?? 100);
      const times = plotted.map((row, index) => burninTimestamp(row, index)).sort((a, b) => a - b);
      if (start <= 0 && end >= 100) {
        state.burninFilters.zoomStart = null;
        state.burninFilters.zoomEnd = null;
      } else {
        state.burninFilters.zoomStart = times[Math.floor((start / 100) * (times.length - 1))];
        state.burninFilters.zoomEnd = times[Math.ceil((end / 100) * (times.length - 1))];
      }
      state.burninFilters.page = 1;
      refreshBurninView({ chart: false });
    });
  });
}

function metricBadge(text, tooltip) {
  return h('span', {
    class: 'metric-badge',
    tabindex: '0',
    'aria-label': tooltip,
    'data-tooltip': tooltip,
  }, text);
}

function burninMetricBadges(row) {
  const badges = [];
  if (row.llmCalls || row.otherCalls) {
    badges.push(metricBadge(
      'O' + row.opusCalls + '/S' + row.sonnetCalls + '/H' + row.haikuCalls + (row.otherCalls ? '/+' + row.otherCalls : ''),
      t('burnin.metric.models')
    ));
  }
  const add = (count, symbol, key) => {
    if (count) badges.push(metricBadge(symbol + count, t(key)));
  };
  add(row.deterministicPhases, '⚡', 'burnin.metric.deterministic');
  add(row.learnedSkills, '📖+', 'burnin.metric.learned');
  add(row.learnedEventSkills, '⟳+', 'burnin.metric.recovery');
  add(row.promotions, '⚙️', 'burnin.metric.promotions');
  add(row.refusals, '⛔', 'burnin.metric.refusals');
  add(row.compileErrors, '⚠', 'burnin.metric.compileErrors');
  add(row.demotions, '🛡️', 'burnin.metric.demotions');
  add(row.dispatchFallbacks, '↩', 'burnin.metric.fallbacks');
  return badges;
}

function renderBurninRows(rows) {
  const host = $('burninRows');
  host.innerHTML = '';
  const filters = state.burninFilters;
  const totalPages = Math.max(1, Math.ceil(rows.length / filters.pageSize));
  filters.page = Math.min(filters.page, totalPages);
  const start = (filters.page - 1) * filters.pageSize;
  const pageRows = rows.slice().reverse().slice(start, start + filters.pageSize);
  const list = h('div', {});
  for (const row of pageRows) {
    const color = FAMILY_COLORS[row.family] || 'var(--accent)';
    const line = h('div', {
      class: 'event burnin-event',
      style: 'cursor:' + (row.trace ? 'pointer' : 'default') + '; border-left: 3px solid ' + color + ';',
      onclick: () => {
        if (!row.trace) return;
        const id = row.trace.replace(/\.json$/, '');
        switchView('runs');
        loadIndex().then(() => {
          if (state.runs.some((candidate) => candidate.id === id)) {
            $('runSelect').value = id;
            selectRun(id);
          }
        });
      },
    }, [h('div', { class: 'row' }, [
      h('span', { style: 'color: var(--' + (row.outcome === 'delivered' ? 'ok' : 'err') + ');' }, row.outcome === 'delivered' ? '✓' : '✗'),
      h('strong', { class: 'run-main' }, row.taskId),
      h('span', { class: 'muted', style: 'font-size:11px;' },
        row.ts.slice(0, 16).replace('T', ' ') + ' · $' + (row.costUsd != null ? row.costUsd.toFixed(3) : '?') +
        ' · ' + (row.durationS != null ? row.durationS + 's' : '?') +
        (row.provider ? ' · ' + row.provider : '')),
      h('span', { class: 'burnin-metrics' }, burninMetricBadges(row)),
    ])]);
    list.appendChild(line);
  }
  host.appendChild(h('div', { class: 'section' }, [h('h3', {}, t('burnin.rowsTitle')), list]));
  renderBurninPager(rows.length, totalPages);
}

function renderBurninPager(totalRows, totalPages) {
  const host = $('burninPager');
  host.innerHTML = '';
  if (totalRows === 0) return;
  const previous = h('button', { type: 'button' }, t('burnin.previous'));
  const next = h('button', { type: 'button' }, t('burnin.next'));
  previous.disabled = state.burninFilters.page <= 1;
  next.disabled = state.burninFilters.page >= totalPages;
  previous.addEventListener('click', () => {
    state.burninFilters.page--;
    renderBurninRows(burninSelectedRows());
  });
  next.addEventListener('click', () => {
    state.burninFilters.page++;
    renderBurninRows(burninSelectedRows());
  });
  host.appendChild(h('div', { class: 'burnin-pager' }, [
    previous,
    h('span', { class: 'meta' }, t('burnin.page', { current: state.burninFilters.page, total: totalPages })),
    next,
  ]));
}

function refreshBurninView({ chart }) {
  renderBurninToolbar();
  const selected = burninSelectedRows();
  renderBurninSummary(selected);
  if (chart) renderBurninChart(burninBaseRows());
  renderBurninRows(selected);
}

window.addEventListener('resize', () => burninChartInstance?.resize());

async function loadSkills() {
  $('skillsLanes').innerHTML = `<div class="loader">${t('common.loading')}</div>`;
  $('skillsSummary').innerHTML = '';
  let r;
  try {
    r = await fetch('/api/skills');
  } catch {
    $('skillsLanes').innerHTML = '<div class="empty">' + t('common.networkError') + '</div>';
    return;
  }
  if (!r.ok) {
    $('skillsLanes').innerHTML = '<div class="empty">' + t('skills.endpointUnavailable') + '</div>';
    return;
  }
  state.skillNamespaces = await r.json();
  state.skillsByL1 = {};
  // Load each namespace in parallel — skill catalogs are small (≤ a few
  // dozen entries per L1), so a fan-out fetch keeps the first paint
  // snappy without burdening the server.
  await Promise.all(state.skillNamespaces.map(async (ns) => {
    try {
      const sr = await fetch('/api/skills/' + encodeURIComponent(ns.l1Name));
      if (sr.ok) state.skillsByL1[ns.l1Name] = await sr.json();
    } catch {
      // Leave the namespace blank — UI shows "(échec de chargement)".
    }
  }));
  renderSkillsSummary();
  renderSkillsLanes();
}

function renderSkillsSummary() {
  const el = $('skillsSummary');
  el.innerHTML = '';
  const total = state.skillNamespaces.reduce((n, ns) => n + ns.count, 0);
  let totalSucc = 0;
  let totalFail = 0;
  for (const arr of Object.values(state.skillsByL1)) {
    for (const s of arr) {
      totalSucc += s.successes ?? 0;
      totalFail += s.failures ?? 0;
    }
  }
  const grid = h('div', { class: 'grid' }, [
    statCard('Namespaces L1', String(state.skillNamespaces.length)),
    statCard('Skills · total', String(total)),
    statCard(t('skills.totalSuccess'), String(totalSucc)),
    statCard(t('skills.totalFailure'), String(totalFail)),
  ]);
  el.appendChild(h('div', { class: 'summary' }, [
    h('h2', {}, 'Skills'),
    h('div', { class: 'task', style: 'font-family: ui-monospace, Menlo, monospace; font-size: 11px;' },
      t('skills.subtitle')),
    grid,
    state.skillNamespaces.length === 0
      ? h('div', { class: 'meta', style: 'margin-top:8px;' }, t('skills.none'))
      : null,
  ]));
}

function renderSkillsLanes() {
  const el = $('skillsLanes');
  el.innerHTML = '';
  if (state.skillNamespaces.length === 0) {
    el.appendChild(h('div', { class: 'empty' }, t('skills.noneYet')));
    return;
  }
  const q = state.skillsFilter.trim();
  const lanes = h('div', { class: 'lanes' });
  for (const ns of state.skillNamespaces) {
    const skills = state.skillsByL1[ns.l1Name] ?? [];
    const matching = skills.filter((s) =>
      !q ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.whenToUse.toLowerCase().includes(q)
    );
    if (q && matching.length === 0) continue;
    const chips = matching.map((s) => {
      const sel = state.selectedSkill
        && state.selectedSkill.l1Name === ns.l1Name
        && state.selectedSkill.id === s.id;
      const cls = 'chip atom' + (sel ? ' selected' : '');
      const counter = (s.successes + s.failures > 0)
        ? ` · ✓${s.successes}/✗${s.failures}`
        : '';
      const langBadge = s.language ? ' · ' + s.language : '';
      const title = `${s.description}\n${s.whenToUse}\nkind=${s.kind}${langBadge}${counter}`;
      return h('span', {
        class: cls,
        title,
        onclick: () => selectSkill(ns.l1Name, s.id),
      }, [
        s.id,
        h('span', { class: 'v' }, s.kind === 'script' ? (s.language ?? 'script') : 'llm'),
      ]);
    });
    lanes.appendChild(h('div', { class: 'lane l1' }, [
      h('h4', {}, `${ns.l1Name}  (${matching.length}${q && matching.length !== ns.count ? '/' + ns.count : ''})`),
      h('div', {}, matching.length ? chips : h('span', { class: 'meta' }, t('common.none'))),
    ]));
  }
  el.appendChild(lanes);
  el.appendChild(h('div', { class: 'origin-legend', style: 'margin-top:8px;' }, [
    h('span', { class: 'meta' }, t('skills.legendHint')),
  ]));
}

async function selectSkill(l1Name, id) {
  state.selectedSkill = { l1Name, id };
  // If we're on another tab, switch first so the user actually sees the detail.
  if (state.view !== 'skills') switchView('skills');
  renderSkillsLanes();
  $('rightPane').innerHTML = `<div class="loader">${t('common.loading')}</div>`;
  let r;
  try {
    r = await fetch('/api/skills/' + encodeURIComponent(l1Name) + '/' + encodeURIComponent(id));
  } catch {
    $('rightPane').innerHTML = '<div class="empty">' + t('common.networkError') + '</div>';
    return;
  }
  if (!r.ok) {
    $('rightPane').innerHTML = '<div class="empty">Skill introuvable.</div>';
    return;
  }
  const skill = await r.json();
  renderSkillDetail(skill, l1Name);
}

function renderSkillDetail(s, l1Name) {
  const el = $('rightPane');
  el.innerHTML = '';
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, `${t('skill.title')} — ${s.id}`),
    h('div', { class: 'kv' }, [
      h('div', { class: 'k' }, t('skill.namespace')), h('div', { class: 'v' }, l1Name),
      h('div', { class: 'k' }, t('skill.kind')), h('div', { class: 'v' }, s.kind + (s.language ? ` · ${s.language}` : '')),
      h('div', { class: 'k' }, t('skill.description')), h('div', { class: 'v' }, s.description),
      h('div', { class: 'k' }, t('skill.whenToUse')), h('div', { class: 'v' }, s.whenToUse),
      h('div', { class: 'k' }, t('skill.counters')), h('div', { class: 'v' }, `✓ ${s.successes}  ·  ✗ ${s.failures}`),
      h('div', { class: 'k' }, t('registry.updatedAt')), h('div', { class: 'v' }, s.updatedAt),
    ]),
  ]));
  if (s.shareability) el.appendChild(renderShareability(s.shareability));
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, s.kind === 'script' ? `${t('skill.body')} — ${s.language} script` : t('skill.body.recipe')),
    h('pre', {}, s.body || t('common.empty')),
  ]));
}

/**
 * The cross-organisation review verdict, shown where a human actually reads
 * a skill. Deliberately states what a REVIEWER still has to do: a clean
 * result means their time will not be wasted, never that the body is
 * approved (docs/saas-architecture.md §4.2 — both kinds need human eyes).
 */
function renderShareability(a) {
  const tone =
    a.verdict === 'blocked' ? '#ef4444' : a.verdict === 'not-shareable' ? '#94a3b8' : '#4ade80';
  const rows = [
    h('h3', {}, t('skill.share.title')),
    h('div', { style: `font-weight:600; color:${tone};` }, t('skill.share.' + a.verdict)),
  ];
  for (const b of a.blockers) {
    rows.push(h('div', { class: 'err-badge', style: 'margin-top:6px;' }, `${b.code} — ${b.detail}`));
  }
  for (const w of a.warnings) {
    rows.push(h('div', { class: 'meta', style: 'margin-top:6px;' }, `⚠ ${w.code} — ${w.detail}`));
  }
  if (a.verdict === 'review-required') {
    rows.push(h('div', { class: 'meta', style: 'margin-top:8px;' }, a.humanMustCheck));
  }
  return h('div', { class: 'section' }, rows);
}

async function loadRegistries() {
  const r = await fetch('/api/registries');
  state.registries = await r.json();
  const sel = $('registrySelect');
  sel.innerHTML = '';
  if (state.registries.length === 0) {
    sel.appendChild(h('option', {}, t('registry.none')));
    $('registrySummary').innerHTML = '';
    $('registryLanes').innerHTML = '<div class="empty">' + t('registry.noneFound') + '</div>';
    return;
  }
  for (const reg of state.registries) {
    const label = `${reg.label}  —  ${reg.counts.total} atomes` + (reg.exists ? '' : '  (absente)');
    sel.appendChild(h('option', { value: reg.id }, label));
  }
  // Prefer the first registry that actually exists on disk.
  const first = state.registries.find((r) => r.exists) ?? state.registries[0];
  selectRegistry(first.id);
}

async function selectRegistry(id) {
  $('registrySelect').value = id;
  $('registryLanes').innerHTML = `<div class="loader">${t('common.loading')}</div>`;
  $('rightPane').innerHTML = '<div class="empty">' + t('pane.selectAtom') + '</div>';
  const r = await fetch('/api/registry/' + encodeURIComponent(id));
  if (!r.ok) {
    $('registryLanes').innerHTML = '<div class="empty">Registre introuvable.</div>';
    return;
  }
  state.currentRegistry = await r.json();
  state.selectedRegistryAtom = null;
  renderRegistrySummary();
  renderRegistryLanes();
}

function renderRegistrySummary() {
  const el = $('registrySummary');
  el.innerHTML = '';
  const reg = state.currentRegistry;
  if (!reg) return;
  const { registry, types } = reg;
  const totalSuccess = types.reduce((n, ty) => n + (ty.successes ?? 0), 0);
  const totalFailure = types.reduce((n, ty) => n + (ty.failures ?? 0), 0);
  const grid = h('div', { class: 'grid' }, [
    statCard(t('lanes.l1'), String(registry.counts[1] ?? 0)),
    statCard(t('lanes.l2'), String(registry.counts[2] ?? 0)),
    statCard('L3 · cellules', String(registry.counts[3] ?? 0)),
    statCard(t('skills.totalSuccess'), String(totalSuccess)),
    statCard(t('skills.totalFailure'), String(totalFailure)),
  ]);
  el.appendChild(h('div', { class: 'summary' }, [
    h('h2', {}, `Registry — ${registry.label}`),
    h('div', { class: 'task', style: 'font-family: ui-monospace, Menlo, monospace; font-size: 11px;' }, registry.path),
    grid,
    !registry.exists ? h('div', { class: 'err-badge', style: 'margin-top:8px;' }, t('registry.missingFile')) : null,
  ]));
}

function renderRegistryLanes() {
  const el = $('registryLanes');
  el.innerHTML = '';
  if (!state.currentRegistry) return;
  const types = state.currentRegistry.types;
  const q = state.registryFilter.trim();
  const match = (ty) =>
    !q ||
    ty.name.toLowerCase().includes(q) ||
    ty.description.toLowerCase().includes(q) ||
    ty.systemPrompt.toLowerCase().includes(q);
  const byTier = { 1: [], 2: [], 3: [] };
  for (const ty of types) if (match(ty)) byTier[ty.tier].push(ty);

  const lane = (tier, title) => {
    const items = byTier[tier];
    const chips = items.map((ty) => {
      const cls = 'chip atom' + (state.selectedRegistryAtom === ty.name ? ' selected' : '');
      const ratio = ty.successes + ty.failures > 0
        ? ` · ✓${ty.successes}/✗${ty.failures}`
        : '';
      const title = `v${ty.version}${ratio}`;
      return h('span', {
        class: cls,
        title,
        onclick: () => selectRegistryAtom(ty.name),
      }, [ty.name, h('span', { class: 'v' }, 'v' + ty.version)]);
    });
    return h('div', { class: 'lane l' + tier }, [
      h('h4', {}, title + ` (${items.length})`),
      h('div', {}, items.length ? chips : h('span', { class: 'meta' }, q ? t('registry.noAtomMatch') : t('common.none'))),
    ]);
  };
  el.appendChild(h('div', { class: 'lanes' }, [
    lane(3, t('lanes.l3')),
    lane(2, t('lanes.l2')),
    lane(1, t('lanes.l1')),
  ]));
  el.appendChild(h('div', { class: 'origin-legend' }, [
    h('span', { class: 'meta' }, t('registry.legendHint')),
  ]));
}

function selectRegistryAtom(name) {
  if (!state.currentRegistry) return;
  const type = state.currentRegistry.types.find((x) => x.name === name);
  if (!type) return;
  state.selectedRegistryAtom = name;
  renderRegistryLanes();
  renderRegistryAtomDetail(type);
}

function renderRegistryAtomDetail(type) {
  const el = $('rightPane');
  el.innerHTML = '';
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, `${t('registry.atom')} — ${type.name}`),
    h('div', { class: 'kv' }, [
      h('div', { class: 'k' }, 'Tier'), h('div', { class: 'v' }, [tierBadge(type.tier), ' ', h('span', { class: 'meta' }, `#${type.ordinal}`)]),
      h('div', { class: 'k' }, t('registry.currentVersion')), h('div', { class: 'v' }, 'v' + type.version),
      h('div', { class: 'k' }, t('registry.createdBy')), h('div', { class: 'v' }, `${type.createdBy}  ·  ${type.createdAt}`),
      h('div', { class: 'k' }, t('registry.successFailure')), h('div', { class: 'v' }, `✓ ${type.successes}  ·  ✗ ${type.failures}`),
      h('div', { class: 'k' }, 'Params'), h('div', { class: 'v' }, JSON.stringify(type.params)),
      h('div', { class: 'k' }, t('common.tools')), h('div', { class: 'v' },
        (type.tools && type.tools.length)
          ? h('div', { class: 'tools-list' }, type.tools.map((n) => h('span', { class: 'chip muted' }, n)))
          : h('span', { class: 'meta' }, t('common.none'))),
    ]),
  ]));
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, 'Description'),
    h('pre', {}, type.description || t('common.empty')),
  ]));
  el.appendChild(h('div', { class: 'section' }, [
    h('h3', {}, `System prompt (v${type.version} · ${t('common.current')})`),
    h('pre', {}, type.systemPrompt || t('common.empty')),
  ]));

  if (type.history && type.history.length > 0) {
    const section = h('div', { class: 'section' }, [
      h('h3', {}, t('registry.versionHistory', { count: type.history.length })),
    ]);
    // Render each archived version as a collapsible block (newest first).
    const entries = type.history.slice().sort((a, b) => b.version - a.version);
    for (const h_ of entries) {
      const body = h('div', { style: 'display:none; margin-top:8px;' }, [
        h('div', { class: 'kv' }, [
          h('div', { class: 'k' }, t('registry.updatedBy')), h('div', { class: 'v' }, `${h_.modifiedBy}  ·  ${h_.modifiedAt}`),
          h('div', { class: 'k' }, t('common.reason')), h('div', { class: 'v' }, h_.reason ?? '—'),
          h('div', { class: 'k' }, 'Params'), h('div', { class: 'v' }, JSON.stringify(h_.params)),
          h('div', { class: 'k' }, t('common.tools')), h('div', { class: 'v' },
            (h_.tools && h_.tools.length)
              ? h('div', { class: 'tools-list' }, h_.tools.map((n) => h('span', { class: 'chip muted' }, n)))
              : h('span', { class: 'meta' }, t('common.none'))),
        ]),
        h('h3', { style: 'margin-top:10px;' }, t('ev.systemPrompt')),
        h('pre', {}, h_.systemPrompt || t('common.empty')),
      ]);
      const header = h('div', {
        class: 'row',
        style: 'cursor:pointer; padding:6px 0; border-top:1px solid var(--border);',
      }, [
        h('span', { class: 'role patch' }, 'v' + h_.version),
        h('span', { class: 'meta' }, h_.modifiedAt),
        h('span', { class: 'meta' }, h_.reason ?? '—'),
        h('span', { class: 'meta', style: 'margin-left:auto;' }, t('common.toggle')),
      ]);
      header.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? '' : 'none';
      });
      section.appendChild(header);
      section.appendChild(body);
    }
    el.appendChild(section);
  }

  // L1-only: surface the persisted skills attached to this atom-type.
  // Mirrors the Skills tab UI but inline, so users can jump from a
  // registry deep-dive straight to the recipes that augment this L1.
  if (type.tier === 1) {
    const skillsSection = h('div', { class: 'section' }, [
      h('h3', {}, t('registry.attachedSkills')),
      h('div', { class: 'meta', style: 'margin-bottom:6px;' }, t('common.loading')),
    ]);
    el.appendChild(skillsSection);
    fetchAndRenderL1Skills(type.name, skillsSection);
  }
}

async function fetchAndRenderL1Skills(l1Name, section) {
  let r;
  try {
    r = await fetch('/api/skills/' + encodeURIComponent(l1Name));
  } catch {
    section.innerHTML = '';
    section.appendChild(h('h3', {}, t('registry.attachedSkills')));
    section.appendChild(h('div', { class: 'meta' }, t('common.networkError')));
    return;
  }
  // 400/500 -> show error, but a 404 means "no skills for this L1".
  if (!r.ok) {
    section.innerHTML = '';
    section.appendChild(h('h3', {}, t('registry.attachedSkills')));
    section.appendChild(h('div', { class: 'meta' }, t('common.none')));
    return;
  }
  const skills = await r.json();
  section.innerHTML = '';
  section.appendChild(h('h3', {}, t('registry.attachedSkills') + ` (${skills.length})`));
  if (skills.length === 0) {
    section.appendChild(h('div', { class: 'meta' }, t('registry.noSkillsForAtom')));
    return;
  }
  // Cache so the Skills tab doesn't have to refetch when the user
  // jumps over via "Voir dans l'onglet Skills".
  state.skillsByL1[l1Name] = skills;
  for (const s of skills) {
    const counter = (s.successes + s.failures > 0)
      ? ` · ✓${s.successes}/✗${s.failures}`
      : '';
    const langBadge = s.language ? ' · ' + s.language : '';
    const head = h('div', { class: 'row', style: 'cursor:pointer; padding:6px 0; border-top:1px solid var(--border); align-items:center;' }, [
      h('span', { class: 'role ' + (s.kind === 'script' ? 'inject' : 'match') }, s.kind === 'script' ? (s.language ?? 'script') : 'llm'),
      h('span', { class: 'name' }, s.id),
      h('span', { class: 'meta' }, s.description),
      h('span', { class: 'meta', style: 'margin-left:auto;' }, counter || '—'),
      h('span', { class: 'meta', title: 'kind=' + s.kind + langBadge }, '↗'),
    ]);
    head.addEventListener('click', () => {
      switchView('skills');
      setTimeout(() => selectSkill(l1Name, s.id), 0);
    });
    section.appendChild(head);
  }
}

// i18n first: the static chrome (nav, placeholders, empty panes) must be
// translated before the first data render paints over it.
applyStaticI18n();
initLangPicker();
loadIndex();
