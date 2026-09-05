import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { projectSlugFromName } from '../../contracts/projects.js';
import { isLocale } from '../../contracts/locales.js';
import { applyDocumentLocale, translate } from '../client/i18n-catalog.js';
import { loginBounceParams, providerLoginHref } from '../client/session-guard.js';
import { isIndexEntryLive } from '../client/run-utils.js';
import {
  dismissPushPrompt,
  enableWebPush,
  pushPromptStorage,
  shouldEnsureAdminSubscription,
  shouldOfferPushPrompt,
} from '../client/push.js';
import {
  emptyRenderMetrics,
  type GpuRenderMetrics,
} from './renderer/metrics.js';
import { AtomaCursor } from './AtomaCursor.js';
import { AuthControls } from './AuthControls.js';
import { useAuthController } from './session-controller.js';
import { GpuDomBridge } from './DomBridge.js';
import { McpAccess } from './McpAccessPanel.js';
import { OrgModelsForm } from './OrgModelsForm.js';
import { EntryVeilLayer } from './EntryVeilLayer.js';
import { PreviewPlane, type PreviewPlaneStatus } from './PreviewPlane.js';
import { useEntryFade } from './entry-fade.js';
import { GpuSurface } from './GpuSurface.js';
import { SceneCameraPlane } from './SceneCameraPlane.js';
import { SceneTuningPanel } from './SceneTuningPanel.js';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../client/data-api.js';
import {
  useAccountModels,
  useAdminEventsPages,
  useNotificationsPages,
  useAdminLedger,
  useAdminSentinel,
  useAdminOrganisations,
  useBurnin,
  useOrganisation,
  useGithubInstallations,
  usePreviewStatus,
  useProfiles,
  useProjectRuns,
  useProjects,
  useRegistries,
  useRegistry,
  useRunTrace,
  useRunsIndex,
  useSkillDetail,
  useSkillLists,
  useSkillNamespaces,
} from './queries.js';
import {
  isRoutableView,
  nextRunFilters,
  previewTargetForRun,
  projectSelectionAfterActivate,
  projectSelectionAfterProjects,
  useGpuStore,
  visibleViews,
  type DocsThemeKey,
} from './store.js';
import type { VizAdminInvitation } from '../client/types.js';
import { openGitHubRepository } from './repository-link.js';

const RELEASE_VERSION = __ATOMA_RELEASE_VERSION__;

declare global {
  interface Window {
    __ATOMA_VIZ_TEST__?: {
      view: string;
      cameraMode: string;
      renderer: GpuRenderMetrics;
      selectedRunId: string | null;
      dispatch: (id: string) => void;
    };
  }
}

/**
 * How often the plane tells the host it is still being watched.
 *
 * It must be comfortably shorter than the SHORTER of the two clocks it feeds:
 * the instance's idle TTL (15 minutes by default) and the browser's grant on
 * the preview origin (5 minutes, fixed). One minute leaves room for a beat to
 * be lost without the member losing the preview.
 */
const PREVIEW_HEARTBEAT_MS = 60_000;

/**
 * One bounded sentence for a refused preview.
 *
 * The server's own message is preferred when it has one — it names the actual
 * reason, and every one of them is already bounded by `PreviewHttpService`.
 * The three fallbacks exist for a transport failure that produced no message
 * at all.
 */
function previewErrorMessage(error: unknown, t: (key: string) => string): string {
  const message = error instanceof Error ? error.message : '';
  if (message) return message;
  return t('preview.error.generic');
}

function errorMessage(errors: unknown[], t: (key: string) => string) {
  const found = errors.find(Boolean);
  if (found instanceof Error) return found.message;
  if (typeof found === 'string') return found;
  if (typeof found === 'number' || typeof found === 'boolean') return String(found);
  return found ? t('app.queryError') : null;
}

export function GpuApp() {
  const locale = useGpuStore((snapshot) => snapshot.locale);
  const entered = useGpuStore((snapshot) => snapshot.entered);
  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);
  const t = useCallback(
    (key: string, vars?: Record<string, unknown>) => translate(locale, key, vars),
    [locale]
  );
  return (
    <AuthControls active={entered} t={t}>
      <GpuAppContent t={t} />
    </AuthControls>
  );
}

function GpuAppContent({
  t,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const state = useGpuStore();
  const queryClient = useQueryClient();
  const {
    snapshot: authSnapshot,
    gate: authGate,
    providers: authProviders,
    activate: activateAuth,
  } = useAuthController();
  // The arrival gate doubles as the login when the server says the gate is
  // on and this browser holds no session. Every data query stays dark until
  // the gate is KNOWN ('off' or 'authenticated'): firing /api/* while whoami
  // is still in flight earned a 401 whose handler reloads '/', which re-ran
  // the race — an infinite reload loop the first gated screenshot caught.
  const gateBlocked = authGate === 'unauthenticated';
  const apiReady = authGate === 'off' || authGate === 'authenticated';
  // Bounce parameters from the server's auth flow, read once per page load:
  // ?authNotice=<code> names a login failure to display, ?invite=<token>
  // must ride every provider link so the invitation admits the account the
  // visitor signs in with. Parsing and href building are the unit-tested
  // helpers in session-guard.ts.
  const loginParams = useMemo(() => loginBounceParams(window.location.search), []);
  const loginHref = useCallback(
    (providerId: string) => providerLoginHref(providerId, loginParams.invite),
    [loginParams.invite]
  );
  const [pendingLoginProvider, setPendingLoginProvider] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [cameraRevision, setCameraRevision] = useState(0);
  const cameraSettled = useCallback(
    () => setCameraRevision((revision) => revision + 1),
    []
  );
  const metrics = useRef<GpuRenderMetrics>(emptyRenderMetrics());
  const { phase: entryPhase, begin: beginEnter } = useEntryFade();

  // Operator surfaces are admin-only behind the gate: the server 403s them
  // for ordinary members, and a 403'd query would poison the global data
  // error exactly the way the ungated /api/projects 404 once did. Ungated
  // (auth null) keeps the classic developer path.
  const operatorSurfaces =
    apiReady && (authSnapshot === null || authSnapshot.viewer.platformAdmin);
  const isPlatformAdmin = authSnapshot?.viewer.platformAdmin === true;
  const runsQuery = useRunsIndex(state.view === 'runs' && apiReady);
  const runQuery = useRunTrace(state.selectedRunId, state.view === 'runs' && apiReady);
  const registriesQuery = useRegistries(state.view === 'registry' && operatorSurfaces);
  const registryQuery = useRegistry(
    state.selectedRegistryId,
    state.view === 'registry' && operatorSurfaces
  );
  const namespacesQuery = useSkillNamespaces(state.view === 'skills' && operatorSurfaces);
  const namespaceNames = useMemo(
    () => (namespacesQuery.data ?? []).map((item) => item.l1Name),
    [namespacesQuery.data]
  );
  const skillLists = useSkillLists(namespaceNames, state.view === 'skills' && operatorSurfaces);
  const selectedRunEvent = useMemo(
    () => runQuery.data?.events.find((event) => event.id === state.selectedEventId) ?? null,
    [runQuery.data, state.selectedEventId]
  );
  const runSkillNs = selectedRunEvent?.l1AtomId ?? selectedRunEvent?.l1Name;
  const runSkillSelection =
    state.view === 'runs' &&
    selectedRunEvent?.kind === 'skill' &&
    runSkillNs &&
    selectedRunEvent.skillId
      ? { l1Name: runSkillNs, id: selectedRunEvent.skillId }
      : null;
  const skillSelection = state.view === 'skills' ? state.selectedSkill : runSkillSelection;
  const skillDetailQuery = useSkillDetail(skillSelection, Boolean(skillSelection) && operatorSurfaces);
  const burninQuery = useBurnin(state.view === 'burnin' && operatorSurfaces);
  // The family guidance renders inside the project run form, so it is fetched
  // with the Projects view. It is supplementary copy, never gating: it is
  // deliberately absent from `loading` below, so a slow /api/profiles cannot
  // hide the project list behind a spinner.
  const profilesQuery = useProfiles(state.view === 'projects' && apiReady);
  // Project routes exist only behind the auth gate; an ungated server 404s
  // them. Left enabled, those 404s poisoned the GLOBAL `data.error` below and
  // the runs view then rendered an error banner instead of its list — the
  // wheel handler fails closed on scrollMax, so scrolling died with it.
  const authed = authSnapshot !== null;
  // Enabled on Runs too, and not for the Runs list: it is the ONLY way to
  // resolve the project a selected run belongs to, and the preview is keyed by
  // (project, project run) while this view is keyed by trace id. Gated on the
  // Projects view alone, a member who RELOADED the page while watching their
  // run had no project list in cache and therefore no preview control — the
  // one moment the control matters most.
  const projectsQuery = useProjects(
    (state.view === 'projects' || state.view === 'runs') && authed
  );
  const githubInstallationsQuery = useGithubInstallations(state.view === 'projects' && authed);
  // Resolved on EVERY view, not only Projects. A member reaches a run's detail
  // by clicking it in its project, and the preview below is keyed by (project,
  // project run) while the Runs view is keyed by trace id — so the project run
  // list has to survive that navigation. Gating this on the view emptied the
  // query key the moment the viewer left, taking the only link between the two
  // identities with it.
  const selectedProject =
    projectsQuery.data?.find((project) => project.projectId === state.selectedProjectId) ?? null;
  const projectRunsQuery = useProjectRuns(
    selectedProject?.projectId ?? null,
    (state.view === 'projects' || state.view === 'runs') && !!selectedProject
  );
  const projectRuns = useMemo<Record<string, import('../client/types.js').VizProjectRun[]>>(
    () =>
      selectedProject && projectRunsQuery.data
        ? { [selectedProject.projectId]: projectRunsQuery.data }
        : {},
    [projectRunsQuery.data, selectedProject]
  );

  // The project run behind the selected trace. A run reached from anywhere
  // else — the runs index, a burn-in row, a deep link — has no project run to
  // preview, and the control below stays absent rather than guessing one.
  const previewTarget = useMemo(
    () => previewTargetForRun(projectRunsQuery.data ?? [], state.selectedRunId, runsQuery.data ?? []),
    [projectRunsQuery.data, runsQuery.data, state.selectedRunId]
  );
  // READS ONLY. A GET allocates nothing server-side, which is what makes it
  // safe to poll from a tab a viewer left open on a run.
  const previewQuery = usePreviewStatus(
    previewTarget?.projectId ?? null,
    previewTarget?.projectRunId ?? null,
    state.view === 'runs' && authed && !!previewTarget
  );
  // THE RUN'S STATUS IS WHAT MAKES A PREVIEW POSSIBLE, so a change to it must
  // re-ask. Nothing else will: `usePreviewStatus` stops polling once the state
  // is `stopped`, which is exactly what a run nobody has previewed reads as,
  // and `refetchOnWindowFocus` is off. So a run watched from `queued` never
  // learned it had gone `running`, and the control the member is waiting for
  // never appeared — the in-flight case, silently unreachable.
  //
  // It matters at the other end too. The run row flips to `delivered` BEFORE
  // the coordinator writes the descriptor, so a summary read in that window
  // says `available` from the in-flight branch and then sticks: the surface
  // would keep offering a snapshot of a run that has finished.
  const previewRunStatus =
    (projectRunsQuery.data ?? []).find(
      (run) => run.projectRunId === previewTarget?.projectRunId
    )?.status ?? null;
  useEffect(() => {
    if (!previewTarget || !previewRunStatus) return;
    void queryClient.invalidateQueries({
      queryKey: ['viz', 'preview', previewTarget.projectId, previewTarget.projectRunId],
    });
  }, [previewRunStatus, previewTarget, queryClient]);

  const login = useMemo(
    () =>
      gateBlocked
        ? {
            providers: authProviders,
            notice: loginParams.notice,
            pendingProvider: pendingLoginProvider,
          }
        : null,
    [authProviders, gateBlocked, loginParams.notice, pendingLoginProvider]
  );

  useEffect(() => {
    if (!pendingLoginProvider) return;
    const href = loginHref(pendingLoginProvider);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        window.location.assign(href);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [loginHref, pendingLoginProvider]);

  // For MEMBERS the permission ask lives in the FIRST RUN, not at login: the
  // moment a viewer's run is actually alive is when "hear about it even
  // offline" has visible value, and it is one-shot per browser. PLATFORM
  // ADMINS must end up subscribed — push routes target them for a curated set
  // of instance-wide platform events with or without a run — so they are
  // asked at login, and their "not now" only holds for the session
  // (`pushPromptStorage` picks the store).
  // Enabling or denying ends the offer for everyone: `shouldOfferPushPrompt`
  // re-checks the browser permission and the stored dismissal every time.
  const [pushPrompt, setPushPrompt] = useState<'hidden' | 'offer' | 'busy' | 'error'>('hidden');
  const hasLiveRun = useMemo(() => {
    const projectRunLive = Object.values(projectRuns).some((runs) =>
      runs.some((run) => run.status === 'queued' || run.status === 'running')
    );
    return projectRunLive || (runsQuery.data ?? []).some((entry) => isIndexEntryLive(entry));
  }, [projectRuns, runsQuery.data]);
  useEffect(() => {
    if (pushPrompt !== 'hidden') return;
    if (
      shouldOfferPushPrompt({
        authenticated: authed,
        hasLiveRun,
        platformAdmin: isPlatformAdmin,
      })
    ) {
      setPushPrompt('offer');
    }
  }, [authed, hasLiveRun, isPlatformAdmin, pushPrompt]);
  const enablePush = useCallback(async () => {
    setPushPrompt('busy');
    const outcome = await enableWebPush();
    if (outcome === 'error') {
      setPushPrompt('error');
      return;
    }
    // enabled, denied and unsupported all end the conversation for good.
    dismissPushPrompt(pushPromptStorage(isPlatformAdmin));
    setPushPrompt('hidden');
  }, [isPlatformAdmin]);
  const dismissPush = useCallback(() => {
    dismissPushPrompt(pushPromptStorage(isPlatformAdmin));
    setPushPrompt('hidden');
  }, [isPlatformAdmin]);
  // A permission already granted shows NO prompt (`permission !== 'default'`
  // ends the offer), so an admin who said yes once is silently re-subscribed
  // instead: enableWebPush reuses the browser subscription and re-saves it,
  // repairing a pruned server row without any UI or gesture. Once per mount —
  // the outcome cannot change within a page load.
  const ensuredAdminPush = useRef(false);
  useEffect(() => {
    if (ensuredAdminPush.current) return;
    if (!shouldEnsureAdminSubscription({ authenticated: authed, platformAdmin: isPlatformAdmin })) {
      return;
    }
    ensuredAdminPush.current = true;
    void enableWebPush();
  }, [authed, isPlatformAdmin]);

  // Settings is account-scoped: it exists exactly where a principal does.
  const organisationQuery = useOrganisation(state.view === 'settings' && authed);
  const accountModelsQuery = useAccountModels(state.view === 'settings' && authed);
  const [accountError, setAccountError] = useState<string | null>(null);
  const renameAccount = useCallback(
    async (displayName: string) => {
      setAccountError(null);
      try {
        await api.renameAccount(displayName);
        // whoami owns the display name and the source flag, and AuthControls
        // reads it once per page load — a reload is the honest refresh here.
        window.location.reload();
      } catch (error) {
        setAccountError(error instanceof Error ? error.message : t('settings.actionFailed'));
      }
    },
    [t]
  );

  // Seed the rename field with the name it is about to replace, once: an empty
  // box beside "Save" reads as "your name is blank".
  useEffect(() => {
    if (state.view !== 'settings' || !authSnapshot) return;
    if (state.search.displayName.length > 0) return;
    state.setSearch('displayName', authSnapshot.viewer.displayName);
  }, [authSnapshot, state]);

  const adminOrganisationsQuery = useAdminOrganisations(
    state.view === 'admin' && isPlatformAdmin
  );
  // The journal, the ledger tail and the sentinel read ride the same
  // admin-only gate as the organisation list: the server 403s them for anyone
  // else, and a poisoned query would take the whole view's error banner with
  // it. Each is enabled on ITS OWN view now — the three used to load together
  // because they shared one tab, which meant opening Admin fetched three
  // things to show one.
  const adminEventsQuery = useAdminEventsPages(state.view === 'journal' && isPlatformAdmin, {
    severity: state.journalSeverity,
    family: state.journalFamily,
  });
  const adminLedgerQuery = useAdminLedger(state.view === 'ledger' && isPlatformAdmin);
  const adminSentinelQuery = useAdminSentinel(state.view === 'sentinel' && isPlatformAdmin);
  // ONE way to ask for the next page, so the wheel gesture and the button
  // cannot diverge. React Query makes a second call while one is in flight a
  // no-op, and `hasNextPage` false makes it a no-op too — which is what lets
  // the wheel announce the bottom on every tick without consequence.
  const loadOlderEvents = useCallback(() => {
    if (!adminEventsQuery.hasNextPage || adminEventsQuery.isFetchingNextPage) return;
    void adminEventsQuery.fetchNextPage();
  }, [adminEventsQuery]);
  // The tray fetches only while it is open — the bell carries no unread badge,
  // so a closed menu has nothing to keep warm. Same one-loader rule as the
  // journal: the wheel gesture and the foot button share this callback.
  const notificationsQuery = useNotificationsPages(
    state.notificationsMenuOpen && authed,
    state.locale
  );
  const loadOlderNotifications = useCallback(() => {
    if (!notificationsQuery.hasNextPage || notificationsQuery.isFetchingNextPage) return;
    void notificationsQuery.fetchNextPage();
  }, [notificationsQuery]);
  const [adminInvitation, setAdminInvitation] = useState<VizAdminInvitation | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const mintInvitation = useCallback(async (orgId: string, role: string) => {
    setAdminError(null);
    try {
      const invitation = await api.createAdminInvitation({ orgId, role });
      setAdminInvitation(invitation);
      try {
        // Best effort: the URL also stays visible in the admin view for
        // manual transcription when the clipboard is unavailable.
        await navigator.clipboard.writeText(invitation.url);
      } catch {
        // Display fallback covers it.
      }
      await queryClient.invalidateQueries({ queryKey: ['viz', 'admin', 'organisations'] });
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : t('admin.actionFailed'));
    }
  }, [queryClient, t]);

  // A viewer whose nav does not include the current view (role changed,
  // admin revoked, stale state) lands back on projects instead of a dead tab.
  // ROUTABLE, not visible: Settings has no tab by design and would otherwise
  // be bounced away on the render right after it opened.
  useEffect(() => {
    if (!isRoutableView(state.view, authSnapshot)) state.setView('projects');
  }, [authSnapshot, state]);

  // A very fast Continue click while whoami was still in flight could enter
  // the app before the gate resolved to 'unauthenticated'. Send that visitor
  // back to the arrival gate — it is the login.
  useEffect(() => {
    if (gateBlocked && state.entered) useGpuStore.setState({ entered: false });
  }, [gateBlocked, state.entered]);

  useEffect(() => {
    const runs = runsQuery.data ?? [];
    if (!state.selectedRunId && runs[0]) state.selectRun(runs[0].id);
  }, [runsQuery.data, state]);

  useEffect(() => {
    const registries = registriesQuery.data ?? [];
    if (!state.selectedRegistryId && registries[0]) {
      state.selectRegistry(registries.find((item) => item.exists)?.id ?? registries[0].id);
    }
  }, [registriesQuery.data, state]);

  useEffect(() => {
    const types = registryQuery.data?.types ?? [];
    if (!state.selectedRegistryAtom && types[0]) state.selectRegistryAtom(types[0].name);
  }, [registryQuery.data, state]);

  useEffect(() => {
    if (state.selectedSkill) return;
    const firstNamespace = namespaceNames[0];
    const firstSkill = firstNamespace ? skillLists.byNamespace[firstNamespace]?.[0] : undefined;
    if (firstNamespace && firstSkill) {
      state.selectSkill({ l1Name: firstNamespace, id: firstSkill.id });
    }
  }, [namespaceNames, skillLists.byNamespace, state]);

  // NO auto-select of the first project. The form the Projects view carries is
  // the create form until a project is selected, so auto-selecting one made
  // creating a project unreachable for anyone who already had one — and it
  // would have re-selected on the render right after a deselect, so the toggle
  // in `activate` could never land either. Only the REPAIR remains: a
  // selection whose project is gone falls back to the first that exists.
  useEffect(() => {
    const projects = projectsQuery.data ?? [];
    if (state.view !== 'projects') return;
    const nextSelection = projectSelectionAfterProjects(
      state.selectedProjectId,
      projects.map((project) => project.projectId)
    );
    if (nextSelection !== state.selectedProjectId) state.selectProject(nextSelection);
  }, [projectsQuery.data, state]);

  useEffect(() => {
    const installations = githubInstallationsQuery.data ?? [];
    const active = installations.filter((installation) => installation.status === 'active');
    if (state.view !== 'projects') return;
    if (!state.selectedGithubInstallationId && active[0]) {
      state.selectGithubInstallation(active[0].installationId);
    }
  }, [githubInstallationsQuery.data, state]);

  const createProject = useCallback(async (): Promise<void> => {
    if (projectBusy) return;
    const name = useGpuStore.getState().search.projectName.trim();
    const repository = useGpuStore.getState().search.projectRepository.trim();
    const installationId = useGpuStore.getState().selectedGithubInstallationId;
    const installation = githubInstallationsQuery.data?.find(
      (candidate) => candidate.installationId === installationId
    );
    const slug = projectSlugFromName(name);
    if (!name || !slug || !installation) {
      setProjectError(t('projects.actionFailed'));
      return;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      const created = await api.createProject({
        name,
        slug,
        repositoryTarget: {
          installationId: installation.installationId,
          owner: installation.accountLogin,
          name: repository || slug,
          // The operator's choice, from the form's own select. The default it
          // starts at lives in ONE place, `DEFAULT_REPOSITORY_VISIBILITY`.
          visibility: useGpuStore.getState().projectVisibility,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'projects'] });
      useGpuStore.getState().selectProject(created.projectId);
    } catch (error) {
      // The server's own message, like startProjectRun already does. A bare
      // catch here discarded the one sentence that explains a refusal — and a
      // visibility a GitHub organisation forbids is refused with a reason.
      setProjectError(error instanceof Error ? error.message : t('projects.actionFailed'));
    } finally {
      setProjectBusy(false);
    }
  }, [githubInstallationsQuery.data, projectBusy, queryClient, t]);

  // THE PREVIEW SESSION, and it lives HERE rather than in the store on
  // purpose: `previewUrl` carries a one-time claim in its fragment, so it is a
  // credential — never the store (which a devtools reader can dump), never a
  // query cache, never a log line. Nothing on the canvas reads any of it, so
  // there is no shared transition for the store to own either.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewPlaneStatus>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Bumped by Reload. It is what makes the frame remount, and it also tells
  // the plane the claim in `previewUrl` has been spent — see `frameSrc`.
  const [previewReloadNonce, setPreviewReloadNonce] = useState(0);
  // Where focus was when the plane took the screen. A keyboard member arrived
  // from the mirrored Preview button in the semantic bridge and must land back
  // on it; one who clicked the canvas had focus on the body, and restoring
  // that is a no-op rather than a jump.
  const previewOpener = useRef<HTMLElement | null>(null);
  const previewSummary = previewQuery.data ?? null;
  const previewProject = previewTarget
    ? projectsQuery.data?.find((project) => project.projectId === previewTarget.projectId) ?? null
    : null;
  const previewGoal =
    (projectRunsQuery.data ?? []).find(
      (run) => run.projectRunId === previewTarget?.projectRunId
    )?.goal ?? '';

  const requestPreview = useCallback(
    async (mode: 'open' | 'restart'): Promise<void> => {
      if (!previewTarget) return;
      const { projectId, projectRunId } = previewTarget;
      setPreviewStatus('opening');
      setPreviewError(null);
      previewOpener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // The plane opens BEFORE the answer, showing "starting" — a member who
      // clicked deserves the surface they asked for immediately, and the
      // container start is measured in seconds.
      setPreviewOpen(true);
      // Back to zero: the answer below carries a FRESH claim, and the frame
      // must use it rather than the origin root a previous reload left behind.
      setPreviewReloadNonce(0);
      try {
        // `inFlight` is a REQUEST, never an assertion: a run that has
        // delivered gets its delivered preview back and the flag is ignored.
        // The client is not the one that decides which of the two this is.
        const answered =
          mode === 'open'
            ? await api.openPreview(projectId, projectRunId, { inFlight: true })
            : await api.restartPreview(projectId, projectRunId, { inFlight: true });
        setPreviewUrl(answered.url ?? null);
        setPreviewStatus('idle');
        // A 202 means another caller is building this generation. Nothing to
        // do but let `usePreviewStatus` poll, which it already does while the
        // state is `starting`.
      } catch (error) {
        setPreviewStatus('error');
        setPreviewError(previewErrorMessage(error, t));
      } finally {
        await queryClient.invalidateQueries({
          queryKey: ['viz', 'preview', projectId, projectRunId],
        });
      }
    },
    [previewTarget, queryClient, t]
  );

  const reloadPreview = useCallback(() => {
    setPreviewReloadNonce((nonce) => nonce + 1);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    // The URL is dropped with the plane. Its claim is spent anyway, and a
    // credential kept past the surface that used it is a credential waiting
    // to be found.
    setPreviewUrl(null);
    setPreviewStatus('idle');
    setPreviewError(null);
    const opener = previewOpener.current;
    previewOpener.current = null;
    // After the plane unmounts, or the focus call lands on an element React is
    // about to remove.
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
  }, []);

  const stopPreview = useCallback(async (): Promise<void> => {
    if (!previewTarget) return;
    const { projectId, projectRunId } = previewTarget;
    // The plane goes with it. Stopping IS "I am done looking", and leaving it
    // up would also race the claim effect below: the status poll lags the
    // stop, so a plane still open against a summary that still says `ready`
    // would immediately ask for a new claim on the preview just stopped.
    closePreview();
    try {
      await api.stopPreview(projectId, projectRunId);
    } catch (error) {
      setPreviewStatus('error');
      setPreviewError(previewErrorMessage(error, t));
    } finally {
      await queryClient.invalidateQueries({
        queryKey: ['viz', 'preview', projectId, projectRunId],
      });
    }
  }, [previewTarget, queryClient, t]);

  // THE HEARTBEAT — the only thing that keeps a preview alive, and it beats
  // only while the plane is actually up. That is the D6 contract made
  // mechanical: the generated app's own traffic never reaches this, so an
  // abandoned tab full of polling code cannot keep its own container running.
  // The interval sits well inside BOTH clocks it feeds: the container's idle
  // TTL and the browser's grant, the shorter of which is five minutes.
  useEffect(() => {
    if (!previewOpen || !previewTarget) return;
    const generation = previewSummary?.generation ?? 0;
    if (previewSummary?.state !== 'ready' || generation <= 0) return;
    const { projectId, projectRunId } = previewTarget;
    let cancelled = false;
    const beat = () => {
      void api.previewHeartbeat(projectId, projectRunId, generation).catch(() => {
        // A failed beat is not worth a banner: the next status poll says what
        // happened, and the container stops on its own if none arrive.
      });
    };
    const timer = window.setInterval(() => {
      if (!cancelled) beat();
    }, PREVIEW_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [previewOpen, previewSummary?.generation, previewSummary?.state, previewTarget]);

  // A generation someone ELSE was building has become ready, and this browser
  // holds no claim for it: `open` answered 202 because another caller was
  // already starting it, so there was no URL to hand over. Without this the
  // plane sits on its placeholder for a preview that is running and reachable.
  // ONE ask, and it cannot loop: a success sets the URL and a failure sets the
  // error status, and both falsify the guard.
  useEffect(() => {
    if (!previewOpen || previewUrl || previewStatus !== 'idle') return;
    if (previewSummary?.state !== 'ready') return;
    void requestPreview('open');
  }, [previewOpen, previewStatus, previewSummary?.state, previewUrl, requestPreview]);

  // A preview that stopped underneath the plane — idle expiry, a restart
  // elsewhere, an operator stop — takes its frame down with it rather than
  // leaving a dead iframe that still looks like the app.
  useEffect(() => {
    if (!previewOpen) return;
    if (previewSummary && previewSummary.state !== 'ready' && previewSummary.state !== 'starting') {
      setPreviewUrl(null);
    }
  }, [previewOpen, previewSummary]);

  const startProjectRun = useCallback(async (): Promise<void> => {
    if (projectBusy) return;
    const projectId = useGpuStore.getState().selectedProjectId;
    const goal = useGpuStore.getState().search.projectPrompt.trim();
    if (!projectId) {
      setProjectError(t('projects.actionFailed'));
      return;
    }
    if (!goal) {
      setProjectError(t('projects.promptRequired'));
      return;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      await api.startProjectRun(projectId, {
        idempotencyKey: crypto.randomUUID(),
        goal,
      });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'project', projectId, 'runs'] });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'projects'] });
      await queryClient.invalidateQueries({ queryKey: ['viz', 'runs'] });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : t('projects.actionFailed'));
    } finally {
      setProjectBusy(false);
    }
  }, [projectBusy, queryClient, t]);

  const activate = useCallback((id: string) => {
    const store = useGpuStore.getState();
    // The menu's own open/closed state is UI, not identity, so it is handled
    // here rather than delegated to the auth controller.
    if (id === 'account.menu.toggle') {
      store.toggleAccountMenu();
      return;
    }
    if (id === 'account.menu.close') {
      store.closeAccountMenu();
      return;
    }
    if (id === 'notifications.menu.toggle') {
      store.toggleNotificationsMenu();
      return;
    }
    if (id === 'notifications.menu.close') {
      store.closeNotificationsMenu();
      return;
    }
    if (id === 'notifications.more') {
      loadOlderNotifications();
      return;
    }
    // A tray row's destination — `setView` is a navigation, so it also closes
    // the menu the click came from (viewChange owns that rule).
    if (id.startsWith('notifications.go.run.')) {
      store.selectRun(id.slice('notifications.go.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('notifications.go.project.')) {
      store.selectProject(id.slice('notifications.go.project.'.length));
      store.setView('projects');
      return;
    }
    if (id.startsWith('notifications.go.view.')) {
      const view = id.slice('notifications.go.view.'.length) as typeof store.view;
      // The resolver already scoped targets to the viewer, but a stale row or
      // a revoked role must land nowhere rather than on a bounced tab.
      if (isRoutableView(view, authSnapshot)) store.setView(view);
      return;
    }
    if (id === 'account.settings') {
      store.setView('settings');
      return;
    }
    if (id.startsWith('auth.')) {
      activateAuth(id);
      return;
    }
    if (id === 'welcome.continue') {
      beginEnter();
      return;
    }
    if (id === 'brand.crystal') {
      store.activateCrystal();
      return;
    }
    if (id.startsWith('nav.')) {
      const nextView = id.slice(4) as typeof store.view;
      // With the duplicate selected-project row removed, re-clicking Projects
      // is the route back to the organisation list and creation form.
      if (nextView === 'projects' && store.view === 'projects' && store.selectedProjectId) {
        store.selectProject(null);
      }
      store.activateView(nextView);
      return;
    }
    if (id === 'tuning.toggle') {
      store.toggleTuningPanel();
      return;
    }
    if (id === 'locale.menu.toggle') {
      store.toggleLocaleMenu();
      return;
    }
    if (id === 'locale.menu.close') {
      store.closeLocaleMenu();
      return;
    }
    if (id.startsWith('locale.select.')) {
      const locale = id.slice('locale.select.'.length);
      if (isLocale(locale)) store.setLocale(locale);
      return;
    }
    if (id.startsWith('run.select.')) {
      store.selectRun(id.slice('run.select.'.length));
      store.setFocusedInput(null);
      return;
    }
    if (id.startsWith('event.')) {
      store.selectEvent(id.slice('event.'.length));
      return;
    }
    if (id.startsWith('atom.')) {
      store.selectAtom(id.slice('atom.'.length));
      return;
    }
    if (id.startsWith('run.filter.kind.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'kind', id.slice('run.filter.kind.'.length))
      );
      return;
    }
    if (id.startsWith('run.filter.role.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'role', id.slice('run.filter.role.'.length))
      );
      return;
    }
    if (id.startsWith('run.filter.branch.')) {
      store.setRunFilters(
        nextRunFilters(store.runFilters, 'branchId', id.slice('run.filter.branch.'.length))
      );
      return;
    }
    if (id === 'branch.heading.toggle') {
      store.toggleBranchHeading();
      return;
    }
    if (id === 'run.summary.toggle') {
      store.toggleRunSummary();
      return;
    }
    // The preview controls, drawn as siblings of the summary card so the
    // full-card toggle above cannot swallow them.
    if (id === 'run.preview.open') {
      // `failed` reopens as a RESTART, not an open: a generation that could
      // not start is not one to retry into, and the state machine already
      // says a new attempt is a new generation.
      void requestPreview(previewQuery.data?.state === 'failed' ? 'restart' : 'open');
      return;
    }
    if (id === 'run.preview.stop') {
      void stopPreview();
      return;
    }
    // The id carries what the viewer SAW, because with no stored preference
    // the view resolved the open state from the selected project's run count
    // and only it knows what it drew.
    if (id.startsWith('projects.guidance.toggle.')) {
      store.toggleProjectGuidance(id.endsWith('.open'));
      return;
    }
    if (id.startsWith('project.select.')) {
      // Toggle: re-clicking the selected project deselects it, which is how a
      // viewer who already has projects gets the create form back. No extra
      // control for it — the row is the control.
      const projectId = id.slice('project.select.'.length);
      store.selectProject(projectSelectionAfterActivate(store.selectedProjectId, projectId));
      return;
    }
    if (id.startsWith('project.repository.')) {
      const projectId = id.slice('project.repository.'.length);
      const project = projectsQuery.data?.find((candidate) => candidate.projectId === projectId);
      openGitHubRepository(project?.repositoryUrl);
      return;
    }
    if (id.startsWith('project.run.')) {
      store.selectRun(id.slice('project.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('registry.select.')) {
      store.selectRegistry(id.slice('registry.select.'.length));
      return;
    }
    if (id.startsWith('registry.atom.')) {
      store.selectRegistryAtom(id.slice('registry.atom.'.length));
      return;
    }
    if (id.startsWith('skill.open.') || id.startsWith('skill.select.')) {
      const marker = id.startsWith('skill.open.') ? 'skill.open.' : 'skill.select.';
      const [l1Name, skillId] = id.slice(marker.length).split('::');
      if (l1Name && skillId) {
        store.selectSkill({ l1Name, id: skillId });
        store.setView('skills');
      }
      return;
    }
    if (id.startsWith('burnin.family.')) {
      store.setBurninFilter('family', id.slice('burnin.family.'.length));
      return;
    }
    if (id.startsWith('burnin.outcome.')) {
      store.setBurninFilter('outcome', id.slice('burnin.outcome.'.length));
      return;
    }
    if (id.startsWith('burnin.preset.')) {
      store.setBurninFilter('preset', id.slice('burnin.preset.'.length));
      return;
    }
    if (id === 'burnin.page.prev') {
      store.setBurninPage(Math.max(1, store.burninPage - 1));
      return;
    }
    if (id === 'burnin.page.next') {
      store.setBurninPage(store.burninPage + 1);
      return;
    }
    if (id.startsWith('burnin.trace.')) {
      store.selectRun(id.slice('burnin.trace.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('docs.theme.')) {
      store.selectDocsTheme(id.slice('docs.theme.'.length) as DocsThemeKey);
      return;
    }
    if (id.startsWith('projects.example.')) {
      const index = Number(id.slice('projects.example.'.length));
      const example = profilesQuery.data?.profiles[0]?.examples[index];
      if (example) store.setSearch('projectPrompt', example);
      return;
    }
    if (id.startsWith('login.provider.')) {
      if (pendingLoginProvider) return;
      setPendingLoginProvider(id.slice('login.provider.'.length));
      return;
    }
    if (id.startsWith('journal.severity.')) {
      store.setJournalFilter('severity', id.slice('journal.severity.'.length));
      return;
    }
    if (id.startsWith('journal.family.')) {
      store.setJournalFilter('family', id.slice('journal.family.'.length));
      return;
    }
    // The gesture and the button, one handler. `scroll.end.<view>` is the
    // renderer saying a downward wheel had nowhere left to go.
    if (id === 'journal.more' || id === 'scroll.end.journal') {
      loadOlderEvents();
      return;
    }
    if (id.startsWith('scroll.end.')) return;
    if (id.startsWith('sentinel.run.')) {
      store.selectRun(id.slice('sentinel.run.'.length));
      store.setView('runs');
      return;
    }
    if (id.startsWith('admin.invite.')) {
      const rest = id.slice('admin.invite.'.length);
      const separator = rest.indexOf('.');
      const role = rest.slice(0, separator);
      const orgId = rest.slice(separator + 1);
      if (role && orgId) void mintInvitation(orgId, role);
      return;
    }
  }, [
    activateAuth,
    authSnapshot,
    beginEnter,
    loadOlderEvents,
    loadOlderNotifications,
    mintInvitation,
    pendingLoginProvider,
    previewQuery.data?.state,
    profilesQuery.data,
    projectsQuery.data,
    requestPreview,
    stopPreview,
  ]);

  const loading =
    (state.view === 'projects' && (projectsQuery.isLoading || githubInstallationsQuery.isLoading)) ||
    (state.view === 'runs' && (runsQuery.isLoading || runQuery.isLoading)) ||
    (state.view === 'registry' && (registriesQuery.isLoading || registryQuery.isLoading)) ||
    (state.view === 'skills' && namespacesQuery.isLoading) ||
    (state.view === 'burnin' && burninQuery.isLoading) ||
    (state.view === 'admin' && adminOrganisationsQuery.isLoading) ||
    // The FIRST page only. A later page loads under a foot-of-list notice
    // inside the view; swapping the whole screen for "loading" while the
    // viewer reads row 300 would throw their place away.
    (state.view === 'journal' && adminEventsQuery.isLoading) ||
    (state.view === 'ledger' && adminLedgerQuery.isLoading) ||
    (state.view === 'sentinel' && adminSentinelQuery.isLoading) ||
    (state.view === 'settings' && (organisationQuery.isLoading || accountModelsQuery.isLoading));
  const error = errorMessage([
    runsQuery.error,
    runQuery.error,
    registriesQuery.error,
    registryQuery.error,
    namespacesQuery.error,
    ...skillLists.results.map((result) => result.error),
    skillDetailQuery.error,
    burninQuery.error,
    profilesQuery.error,
    projectsQuery.error,
    githubInstallationsQuery.error,
    projectRunsQuery.error,
    adminOrganisationsQuery.error,
    organisationQuery.error,
    accountModelsQuery.error,
    adminEventsQuery.error,
    adminLedgerQuery.error,
    adminSentinelQuery.error,
  ], t);
  const data = useMemo(() => ({
    auth: authSnapshot,
    runs: runsQuery.data ?? [],
    run: runQuery.data ?? null,
    registries: registriesQuery.data ?? [],
    registry: registryQuery.data ?? null,
    skillNamespaces: namespacesQuery.data ?? [],
    skillsByNamespace: skillLists.byNamespace,
    skillDetail: skillDetailQuery.data ?? null,
    burnin: burninQuery.data ?? null,
    profiles: profilesQuery.data?.profiles ?? [],
    projects: projectsQuery.data ?? [],
    projectRuns,
    githubInstallations: githubInstallationsQuery.data ?? [],
    adminOrganisations: adminOrganisationsQuery.data ?? [],
    adminEvents: adminEventsQuery.data?.pages.flatMap((page) => page.events) ?? [],
    adminEventsHasMore: adminEventsQuery.hasNextPage === true,
    adminEventsLoading: adminEventsQuery.isFetchingNextPage === true,
    notifications:
      notificationsQuery.data?.pages.flatMap((page) => page.notifications) ?? [],
    notificationsHasMore: notificationsQuery.hasNextPage === true,
    notificationsLoading:
      notificationsQuery.isLoading || notificationsQuery.isFetchingNextPage,
    // Kept OUT of the global `error` above: a failed tray read renders inside
    // the open menu instead of replacing the view behind it with a banner.
    notificationsError: notificationsQuery.isError,
    adminLedger: adminLedgerQuery.data?.events ?? [],
    adminSentinel: adminSentinelQuery.data ?? null,
    adminInvitation,
    adminError,
    organisation: organisationQuery.data ?? null,
    accountModels: accountModelsQuery.data ?? null,
    accountError,
    preview: previewQuery.data ?? null,
    login,
    loading,
    error,
  }), [
    accountError,
    accountModelsQuery.data,
    previewQuery.data,
    adminError,
    adminInvitation,
    adminOrganisationsQuery.data,
    adminEventsQuery.data,
    adminEventsQuery.hasNextPage,
    adminEventsQuery.isFetchingNextPage,
    notificationsQuery.data,
    notificationsQuery.hasNextPage,
    notificationsQuery.isFetchingNextPage,
    notificationsQuery.isLoading,
    notificationsQuery.isError,
    adminLedgerQuery.data,
    adminSentinelQuery.data,
    authSnapshot,
    organisationQuery.data,
    login,
    burninQuery.data,
    error,
    githubInstallationsQuery.data,
    loading,
    namespacesQuery.data,
    profilesQuery.data,
    projectRuns,
    projectsQuery.data,
    registriesQuery.data,
    registryQuery.data,
    runQuery.data,
    runsQuery.data,
    skillDetailQuery.data,
    skillLists.byNamespace,
  ]);

  const updateMetrics = useCallback((next: GpuRenderMetrics) => {
    metrics.current = next;
    if (import.meta.env.DEV && window.__ATOMA_VIZ_TEST__) {
      window.__ATOMA_VIZ_TEST__.renderer = next;
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__ATOMA_VIZ_TEST__ = {
      view: state.view,
      cameraMode: state.sceneCameraMode,
      renderer: metrics.current,
      selectedRunId: state.selectedRunId,
      dispatch: activate,
    };
    return () => {
      delete window.__ATOMA_VIZ_TEST__;
    };
  }, [activate, state.sceneCameraMode, state.selectedRunId, state.view]);

  return (
    <main className="gpu-app" data-entered={state.entered ? 'true' : 'false'}>
      {/* The product tree goes INERT behind an open preview, not merely
          hidden: `inert` takes the whole subtree out of focus order, hit
          testing and the accessibility tree in one attribute, so a tab press
          cannot land on a GL control the member cannot see, and a screen
          reader is not read two surfaces at once. `aria-hidden` alone would
          have done only the last of the three. */}
      <div className="gpu-scene-host" inert={previewOpen}>
      <SceneCameraPlane mode={state.sceneCameraMode} onSettled={cameraSettled}>
        <GpuSurface
          data={data}
          releaseVersion={RELEASE_VERSION}
          t={t}
          onActivate={activate}
          onMetrics={updateMetrics}
          cameraRevision={cameraRevision}
        />
        <GpuDomBridge
          authSnapshot={authSnapshot}
          runs={runsQuery.data ?? []}
          releaseVersion={RELEASE_VERSION}
          views={visibleViews(authSnapshot)}
          loginLinks={
            login
              ? login.providers.map((provider) => ({
                  id: provider.id,
                  label: provider.label,
                  href: loginHref(provider.id),
                }))
              : null
          }
          pendingLoginProvider={pendingLoginProvider}
          onLoginStart={setPendingLoginProvider}
          t={t}
          onSelectRun={state.selectRun}
          onEnter={beginEnter}
          githubInstallations={githubInstallationsQuery.data ?? []}
          projects={projectsQuery.data ?? []}
          onCreateProject={() => { void createProject(); }}
          onStartRun={() => { void startProjectRun(); }}
          projectBusy={projectBusy}
          projectError={projectError}
          pushPrompt={pushPrompt}
          onEnablePush={() => { void enablePush(); }}
          onDismissPush={dismissPush}
          onRenameAccount={(displayName) => { void renameAccount(displayName); }}
          accountError={accountError}
          preview={previewSummary}
          onActivate={activate}
          orgModelsForm={
            state.view === 'settings' &&
            authSnapshot !== null &&
            authSnapshot.viewer.activeOrganisation !== null ? (
              <>
              <McpAccess t={t} locale={state.locale} onError={setAccountError} />
              <OrgModelsForm
                t={t}
                locale={state.locale}
                enabled={true}
                canManageOrg={
                  authSnapshot.viewer.platformAdmin ||
                  authSnapshot.viewer.role === 'org:owner' ||
                  authSnapshot.viewer.role === 'org:admin'
                }
                platformAdmin={authSnapshot.viewer.platformAdmin}
                organisation={organisationQuery.data ?? null}
                overlaysInert={
                  state.accountMenuOpen || state.localeMenuOpen || state.notificationsMenuOpen
                }
                onError={setAccountError}
              />
              </>
            ) : null
          }
        />
        <SceneTuningPanel />
      </SceneCameraPlane>
      </div>
      <PreviewPlane
        open={previewOpen}
        summary={previewSummary}
        url={previewUrl}
        projectName={previewProject?.name ?? ''}
        goal={previewGoal}
        reloadNonce={previewReloadNonce}
        status={previewStatus}
        errorMessage={previewError}
        t={t}
        locale={state.locale}
        onClose={closePreview}
        onReload={reloadPreview}
        onRestart={() => { void requestPreview('restart'); }}
        onStop={() => { void stopPreview(); }}
      />
      <AtomaCursor />
      <EntryVeilLayer phase={entryPhase} />
    </main>
  );
}
