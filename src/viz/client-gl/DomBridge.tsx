import { matchesSearchQuery, runSearchText } from '../client/search.js';
import type { RunIndexEntry, VizGitHubInstallation, VizProject } from '../client/types.js';
import type { ComponentProps } from 'react';
import type { AuthUiSnapshot } from './AuthControls.js';
import {
  projectSelectionAfterActivate,
  useGpuStore,
  type ViewName,
} from './store.js';
import { AnnouncementForm } from './AnnouncementForm.js';

const DEFAULT_VIEWS: ViewName[] = ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs'];

export function DomBridge({
  runs,
  releaseVersion,
  views = DEFAULT_VIEWS,
  loginLinks = null,
  t,
  onSelectRun,
  onEnter,
  githubInstallations = [],
  projects = [],
  onCreateProject,
  onStartRun,
  projectBusy = false,
  projectError = null,
  projectActionsEnabled = true,
  pushPrompt = 'hidden',
  pushAdmin = false,
  onEnablePush,
  onDismissPush,
  onRenameAccount,
  accountError = null,
  announcementsEnabled = false,
}: {
  runs: RunIndexEntry[];
  releaseVersion: string;
  /** Nav tabs for this viewer — computed once by `visibleViews`, shared with the GL rail. */
  views?: ViewName[];
  /** Non-null when the arrival gate is a login: real anchors, one per provider. */
  loginLinks?: { id: string; label: string; href: string }[] | null;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onSelectRun: (id: string) => void;
  onEnter?: () => void;
  githubInstallations?: VizGitHubInstallation[];
  /** Minimal project index mirrored for keyboard and assistive navigation. */
  projects?: readonly Pick<VizProject, 'projectId' | 'name'>[];
  onCreateProject?: () => void;
  onStartRun?: () => void;
  projectBusy?: boolean;
  projectError?: string | null;
  /** Project mutations exist only behind the auth gate. */
  projectActionsEnabled?: boolean;
  /** Notification offer (first live run for members, login for platform
   *  admins); real DOM buttons because the browser permission request needs a
   *  user gesture on an actual element. */
  pushPrompt?: 'hidden' | 'offer' | 'busy' | 'error';
  /** Admins see the standing-duty copy — no run may be underway after login. */
  pushAdmin?: boolean;
  onEnablePush?: () => void;
  onDismissPush?: () => void;
  /** Settings: the display name is a real input, so its submit lives here. */
  onRenameAccount?: (displayName: string) => void;
  accountError?: string | null;
  /** Platform admins only: the broadcast composer lives on the admin view. */
  announcementsEnabled?: boolean;
}) {
  const view = useGpuStore((state) => state.view);
  const sceneCameraMode = useGpuStore((state) => state.sceneCameraMode);
  const entered = useGpuStore((state) => state.entered);
  const locale = useGpuStore((state) => state.locale);
  const selectedRunId = useGpuStore((state) => state.selectedRunId);
  const selectedProjectId = useGpuStore((state) => state.selectedProjectId);
  const accountMenuOpen = useGpuStore((state) => state.accountMenuOpen);
  const focusedInput = useGpuStore((state) => state.focusedInput);
  const runPickerActiveIndex = useGpuStore((state) => state.runPickerActiveIndex);
  const search = useGpuStore((state) => state.search);
  const activateView = useGpuStore((state) => state.activateView);
  const activateCrystal = useGpuStore((state) => state.activateCrystal);
  const enter = useGpuStore((state) => state.enter);
  const setLocale = useGpuStore((state) => state.setLocale);
  const setSearch = useGpuStore((state) => state.setSearch);
  const setFocusedInput = useGpuStore((state) => state.setFocusedInput);
  const setRunPickerActiveIndex = useGpuStore((state) => state.setRunPickerActiveIndex);
  const setRunPickerScrollY = useGpuStore((state) => state.setRunPickerScrollY);
  const selectedGithubInstallationId = useGpuStore((state) => state.selectedGithubInstallationId);
  const selectGithubInstallation = useGpuStore((state) => state.selectGithubInstallation);
  const projectVisibility = useGpuStore((state) => state.projectVisibility);
  const setProjectVisibility = useGpuStore((state) => state.setProjectVisibility);
  const selectProject = useGpuStore((state) => state.selectProject);
  const announcementResetSignal = useGpuStore((state) => state.announcementResetSignal);
  const activeGithubInstallations = githubInstallations.filter(
    (installation) => installation.status === 'active'
  );
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const selectedProjectName =
    projects.find((project) => project.projectId === selectedProjectId)?.name ?? null;
  const selectedProjectLabel = selectedProjectName && selectedProjectName.length > 48
    ? `${selectedProjectName.slice(0, 47)}…`
    : selectedProjectName;
  const runValue = focusedInput === 'run' ? search.run : selectedRun?.label ?? '';
  const filteredRuns = runs.filter((run) =>
    matchesSearchQuery(runSearchText(run), search.run)
  );
  // The account menu is Pixi chrome while text-entry controls are real DOM
  // above the canvas. Remove view overlays while the menu is open, otherwise
  // an input/form can intercept clicks on the menu that visibly sits over it.
  const viewOverlaysVisible = !accountMenuOpen;

  if (!entered) {
    return (
      <div
        className="gpu-a11y-bridge"
        role="application"
        aria-label="Atoma"
      >
        <span data-release-version={releaseVersion}>
          {t('welcome.version', { version: releaseVersion })}
        </span>
        {loginLinks ? (
          // The arrival gate is the login: real anchors so keyboard and
          // assistive tech reach the provider flow without the GL canvas.
          loginLinks.map((link) => (
            <a key={link.id} href={link.href}>
              {t('welcome.signInWith', { label: link.label })}
            </a>
          ))
        ) : (
          <button onClick={() => (onEnter ?? enter)()}>{t('welcome.continue')}</button>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className="gpu-a11y-bridge"
        role="application"
        aria-label={t('app.accessibleName')}
      >
        <button onClick={activateCrystal}>
          {t(sceneCameraMode === 'focus' ? 'nav.crystalExpand' : 'nav.crystalWelcome')}
        </button>
        <nav role="tablist" aria-label={t('nav.views')}>
          {views.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={view === name}
              onClick={() => activateView(name)}
            >
              {t(`nav.${name}`)}
            </button>
          ))}
        </nav>
        <button onClick={() => setLocale(locale === 'en' ? 'fr' : 'en')}>
          {t('lang.switch')}
        </button>
        <div data-viz-live aria-live="polite" aria-atomic="true">
          {t(`nav.${view}`)}
          {selectedRun ? ` — ${selectedRun.label}` : ''}
        </div>
        {projectActionsEnabled && view === 'projects' && projects.length > 0 ? (
          <section aria-label={t('nav.projects')}>
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                aria-pressed={project.projectId === selectedProjectId}
                onClick={() => {
                  selectProject(
                    projectSelectionAfterActivate(selectedProjectId, project.projectId)
                  );
                }}
              >
                {project.name}
              </button>
            ))}
          </section>
        ) : null}
      </div>

      {viewOverlaysVisible && view === 'runs' ? (
        <input
          className="gpu-dom-input gpu-run-input"
          aria-label={t('runs.search', { count: runs.length })}
          value={runValue}
          placeholder={t('runs.search', { count: runs.length })}
          onFocus={() => {
            setSearch('run', '');
            setFocusedInput('run');
            const selectedIndex = Math.max(
              0,
              runs.findIndex((run) => run.id === selectedRunId)
            );
            setRunPickerActiveIndex(selectedIndex);
            setRunPickerScrollY(Math.max(0, (selectedIndex - 4) * 43));
          }}
          onBlur={() => window.setTimeout(() => setFocusedInput(null), 240)}
          onChange={(event) => {
            setSearch('run', event.target.value);
            setRunPickerActiveIndex(0);
            setRunPickerScrollY(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setFocusedInput(null);
              event.currentTarget.blur();
            }
            let nextIndex = runPickerActiveIndex;
            if (event.key === 'ArrowDown') nextIndex++;
            else if (event.key === 'ArrowUp') nextIndex--;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = filteredRuns.length - 1;
            if (nextIndex !== runPickerActiveIndex) {
              event.preventDefault();
              nextIndex = Math.max(0, Math.min(filteredRuns.length - 1, nextIndex));
              setRunPickerActiveIndex(nextIndex);
              const rowTop = nextIndex * 43;
              const currentScroll = useGpuStore.getState().runPickerScrollY;
              if (rowTop < currentScroll) setRunPickerScrollY(rowTop);
              else if (rowTop + 43 > currentScroll + 387) {
                setRunPickerScrollY(rowTop + 43 - 387);
              }
            }
            const activeRun = filteredRuns[runPickerActiveIndex] ?? filteredRuns[0];
            if (event.key === 'Enter' && activeRun) {
              onSelectRun(activeRun.id);
              setFocusedInput(null);
              event.currentTarget.blur();
            }
          }}
        />
      ) : null}
      {viewOverlaysVisible && view === 'registry' ? (
        <input
          className="gpu-dom-input gpu-view-search"
          aria-label={t('nav.filterAtoms')}
          value={search.registry}
          placeholder={t('nav.filterAtoms')}
          onFocus={() => setFocusedInput('registry')}
          onBlur={() => setFocusedInput(null)}
          onChange={(event) => setSearch('registry', event.target.value)}
        />
      ) : null}
      {viewOverlaysVisible && view === 'skills' ? (
        <input
          className="gpu-dom-input gpu-view-search"
          aria-label={t('nav.filterSkills')}
          value={search.skills}
          placeholder={t('nav.filterSkills')}
          onFocus={() => setFocusedInput('skills')}
          onBlur={() => setFocusedInput(null)}
          onChange={(event) => setSearch('skills', event.target.value)}
        />
      ) : null}
      {viewOverlaysVisible && projectActionsEnabled && view === 'projects' ? (
        <form
          className={`gpu-panel-skin gpu-project-form${selectedProjectName ? ' gpu-project-form--run' : ''}`}
          onSubmit={(event) => event.preventDefault()}
        >
          {selectedProjectName ? (
            // ONE job at a time. A selected project means the next act is a
            // run on it, so the create fields step aside — they belong to a
            // project that does not exist yet. Clicking the selected row
            // again deselects and brings them back.
            <textarea
              className="gpu-dom-input gpu-project-prompt"
              aria-label={t('projects.prompt')}
              value={search.projectPrompt}
              placeholder={t('projects.promptPlaceholder')}
              onFocus={() => setFocusedInput('projectPrompt')}
              onBlur={() => setFocusedInput(null)}
              onChange={(event) => setSearch('projectPrompt', event.target.value)}
            />
          ) : (
            <>
              <input
                className="gpu-dom-input gpu-project-name"
                aria-label={t('projects.name')}
                value={search.projectName}
                placeholder={t('projects.name')}
                maxLength={120}
                onFocus={() => setFocusedInput('projectName')}
                onBlur={() => setFocusedInput(null)}
                onChange={(event) => setSearch('projectName', event.target.value)}
              />
              <input
                className="gpu-dom-input gpu-project-repo"
                aria-label={t('projects.repository')}
                value={search.projectRepository}
                placeholder={t('projects.repository')}
                onFocus={() => setFocusedInput('projectRepository')}
                onBlur={() => setFocusedInput(null)}
                onChange={(event) => setSearch('projectRepository', event.target.value)}
              />
              {/* WHERE the repository goes, and WHO can read it — one cell.
                  The pair shares the grid area the installation select owned
                  alone; a fourth column would have moved the form's height
                  contract and three grid area lists for two words of text. */}
              <div className="gpu-project-target">
                <select
                  className="gpu-dom-input gpu-dom-select gpu-project-install"
                  aria-label={t('projects.installation')}
                  value={selectedGithubInstallationId ?? ''}
                  onChange={(event) => selectGithubInstallation(event.target.value || null)}
                >
                  <option value="">{t('projects.installation')}</option>
                  {activeGithubInstallations.map((installation) => (
                    <option key={installation.installationId} value={installation.installationId}>
                      {installation.accountLogin} ({installation.targetType})
                    </option>
                  ))}
                </select>
                {/* Bare words in the options; the consequence and the finality
                    are in the hint below, because a word in a dropdown is not
                    a warning — and this choice cannot be taken back. */}
                <select
                  className="gpu-dom-input gpu-dom-select gpu-project-visibility"
                  aria-label={t('projects.visibility')}
                  value={projectVisibility}
                  onChange={(event) =>
                    setProjectVisibility(
                      event.target.value === 'public' ? 'public' : 'private'
                    )
                  }
                >
                  <option value="private">{t('projects.visibility.private')}</option>
                  <option value="public">{t('projects.visibility.public')}</option>
                </select>
              </div>
            </>
          )}
          <div className="gpu-project-actions">
            {/* Outside the mode switch on purpose: an organisation with no
                installation must be able to reach the connect flow even while
                a project from a revoked one is selected. */}
            {activeGithubInstallations.length === 0 ? (
              <a href="/auth/github/connect">{t('projects.connectGithub')}</a>
            ) : null}
            {selectedProjectLabel ? (
              <button
                type="button"
                disabled={projectBusy}
                title={selectedProjectName ?? undefined}
                onClick={() => onStartRun?.()}
              >
                {t('projects.startRunOn', { name: selectedProjectLabel })}
              </button>
            ) : (
              <button type="button" disabled={projectBusy} onClick={() => onCreateProject?.()}>
                {t('projects.create')}
              </button>
            )}
            {projectError ? <span role="alert">{projectError}</span> : null}
          </div>
          <p className="gpu-project-hint">
            {selectedProjectLabel
              ? t('projects.actionsHint.ready', { name: selectedProjectLabel })
              : `${t('projects.actionsHint.new')} ${t(
                  projectVisibility === 'public'
                    ? 'projects.visibility.publicHint'
                    : 'projects.visibility.privateHint'
                )}`}
          </p>
        </form>
      ) : null}
      {viewOverlaysVisible && view === 'settings' ? (
        <form
          className="gpu-panel-skin gpu-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            const next = search.displayName.trim();
            if (next) onRenameAccount?.(next);
          }}
        >
          <input
            className="gpu-dom-input gpu-settings-name"
            aria-label={t('settings.displayName')}
            value={search.displayName}
            placeholder={t('settings.displayName')}
            maxLength={120}
            onFocus={() => setFocusedInput('displayName')}
            onBlur={() => setFocusedInput(null)}
            onChange={(event) => setSearch('displayName', event.target.value)}
          />
          <div className="gpu-settings-actions">
            <button type="submit" disabled={search.displayName.trim().length === 0}>
              {t('settings.save')}
            </button>
            {accountError ? <span role="alert">{accountError}</span> : null}
          </div>
        </form>
      ) : null}
      {viewOverlaysVisible && view === 'announce' && announcementsEnabled ? (
        <AnnouncementForm t={t} locale={locale} resetSignal={announcementResetSignal} />
      ) : null}
      {pushPrompt !== 'hidden' ? (
        <div
          className="gpu-push-prompt"
          role="dialog"
          aria-label={t(pushAdmin ? 'push.admin.title' : 'push.title')}
        >
          <p>{t(pushAdmin ? 'push.admin.body' : 'push.body')}</p>
          {pushPrompt === 'error' ? <span role="alert">{t('push.error')}</span> : null}
          <div className="gpu-push-prompt-actions">
            <button
              type="button"
              disabled={pushPrompt === 'busy'}
              onClick={() => onEnablePush?.()}
            >
              {t('push.enable')}
            </button>
            <button
              type="button"
              disabled={pushPrompt === 'busy'}
              onClick={() => onDismissPush?.()}
            >
              {t('push.later')}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The production bridge boundary. Keeping auth-derived flags here makes the
 * wiring independently renderable: an ungated shell cannot accidentally
 * regain project mutations, and admin alert copy follows the actual viewer.
 */
export function GpuDomBridge({
  authSnapshot,
  ...props
}: Omit<
  ComponentProps<typeof DomBridge>,
  'projectActionsEnabled' | 'pushAdmin' | 'announcementsEnabled'
> & {
  authSnapshot: AuthUiSnapshot | null;
}) {
  return (
    <DomBridge
      {...props}
      projectActionsEnabled={authSnapshot !== null}
      pushAdmin={authSnapshot?.viewer.platformAdmin === true}
      // Derived HERE with the other auth flags rather than passed in: the
      // composer is operator power, and the server enforces the same
      // answer — a client that forgot the flag must not be the reason a
      // broadcast form appears for a member.
      announcementsEnabled={authSnapshot?.viewer.platformAdmin === true}
    />
  );
}
