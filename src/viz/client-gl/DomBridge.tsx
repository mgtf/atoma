import { matchesSearchQuery, runSearchText } from '../client/search.js';
import {
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  type Locale,
} from '../../contracts/locales.js';
import type { RunIndexEntry, VizGitHubInstallation, VizProject } from '../client/types.js';
import type { ComponentProps, ReactNode } from 'react';
import type { AuthUiSnapshot } from './AuthControls.js';
import { DOC_PAGES, DOC_THEMES, type DocsThemeKey } from './docs-content.js';
import {
  projectSelectionAfterActivate,
  useGpuStore,
  type ViewName,
} from './store.js';
import { AnnouncementForm } from './AnnouncementForm.js';

const DEFAULT_VIEWS: ViewName[] = ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs'];

function AccessibleDocs({
  selected,
  onSelect,
  t,
}: {
  selected: DocsThemeKey;
  onSelect: (theme: DocsThemeKey) => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const page = DOC_PAGES[selected];
  const titleId = `docs-user-title-${selected}`;
  return (
    <div className="gpu-docs-guide">
      <nav className="gpu-docs-topic-nav" aria-label={t('docs.user.topics')}>
        {DOC_THEMES.map((theme) => (
          <button
            key={theme.key}
            type="button"
            aria-current={theme.key === selected ? 'page' : undefined}
            aria-pressed={theme.key === selected}
            onClick={() => onSelect(theme.key)}
          >
            {t(theme.navKey)}
          </button>
        ))}
      </nav>
      <article className="gpu-docs-article" aria-labelledby={titleId}>
        <p className="gpu-docs-eyebrow">{t(page.eyebrowKey)}</p>
        <h1 id={titleId}>{t(page.titleKey)}</h1>
        <p>{t(page.ledeKey)}</p>
        {page.sections.map((section) => {
          const List = section.flow ? 'ol' : 'ul';
          return (
            <section key={section.titleKey}>
              <h2>{t(section.titleKey)}</h2>
              {section.introKey ? <p>{t(section.introKey)}</p> : null}
              <List>
                {section.cards.map((card) => (
                  <li key={card.titleKey}>
                    {card.tagKey ? <span>{t(card.tagKey)}</span> : null}
                    <h3>{t(card.titleKey)}</h3>
                    <p>{t(card.bodyKey)}</p>
                  </li>
                ))}
              </List>
            </section>
          );
        })}
      </article>
    </div>
  );
}

export function DomBridge({
  runs,
  releaseVersion,
  views = DEFAULT_VIEWS,
  loginLinks = null,
  pendingLoginProvider = null,
  onLoginStart,
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
  orgModelsForm = null,
  domOverlaysVeiled = false,
}: {
  runs: RunIndexEntry[];
  releaseVersion: string;
  /** Nav tabs for this viewer — computed once by `visibleViews`, shared with the GL rail. */
  views?: ViewName[];
  /** Non-null when the arrival gate is a login: real anchors, one per provider. */
  loginLinks?: { id: string; label: string; href: string }[] | null;
  /** Provider whose OAuth redirect is in flight — that anchor shows a spinner. */
  pendingLoginProvider?: string | null;
  onLoginStart?: (providerId: string) => void;
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
  /** Settings: the org defaults + provider keys form, for org admins. */
  orgModelsForm?: ReactNode;
  /** Shared veil state applied to every DOM overlay (see overlaysInert below). */
  domOverlaysVeiled?: boolean;
}) {
  const view = useGpuStore((state) => state.view);
  const sceneCameraMode = useGpuStore((state) => state.sceneCameraMode);
  const entered = useGpuStore((state) => state.entered);
  const locale = useGpuStore((state) => state.locale);
  const selectedRunId = useGpuStore((state) => state.selectedRunId);
  const selectedProjectId = useGpuStore((state) => state.selectedProjectId);
  const selectedDocsTheme = useGpuStore((state) => state.selectedDocsTheme);
  const accountMenuOpen = useGpuStore((state) => state.accountMenuOpen);
  const localeMenuOpen = useGpuStore((state) => state.localeMenuOpen);
  const notificationsMenuOpen = useGpuStore((state) => state.notificationsMenuOpen);
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
  const selectDocsTheme = useGpuStore((state) => state.selectDocsTheme);
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
  // above the canvas. Forms stay mounted (store-backed values stay on screen),
  // `inert` takes them out of click/focus/a11y, and `.gpu-overlays-veiled`
  // dims them and clips the menu rectangle so fields cannot paint through it.
  const overlaysInert = accountMenuOpen || localeMenuOpen || notificationsMenuOpen;

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
          loginLinks.map((link) => {
            const pending = pendingLoginProvider === link.id;
            const name = t('welcome.signInWith', { label: link.label });
            return (
              <a
                key={link.id}
                href={link.href}
                aria-busy={pending}
                aria-disabled={pendingLoginProvider !== null}
                aria-label={
                  pending ? t('welcome.signInBusy', { label: link.label }) : name
                }
                onClick={(event) => {
                  if (!onLoginStart) return;
                  event.preventDefault();
                  if (pendingLoginProvider) return;
                  onLoginStart(link.id);
                }}
              >
                {pending ? <span className="gpu-login-spinner" aria-hidden="true" /> : name}
              </a>
            );
          })
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
        <label>
          {t('nav.language')}
          <select
            aria-label={t('nav.language')}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            {SUPPORTED_LOCALES.map((code) => (
              <option key={code} value={code}>{LOCALE_NAMES[code]}</option>
            ))}
          </select>
        </label>
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
        {view === 'docs' ? (
          <AccessibleDocs
            selected={selectedDocsTheme}
            onSelect={selectDocsTheme}
            t={t}
          />
        ) : null}
      </div>

      {view === 'runs' ? (
        <input
          className={`gpu-dom-input gpu-run-input${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          aria-label={t('runs.search', { count: runs.length })}
          value={runValue}
          placeholder={t('runs.search', { count: runs.length })}
          inert={overlaysInert}
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
      {view === 'registry' ? (
        <input
          className={`gpu-dom-input gpu-view-search${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          aria-label={t('nav.filterAtoms')}
          value={search.registry}
          placeholder={t('nav.filterAtoms')}
          inert={overlaysInert}
          onFocus={() => setFocusedInput('registry')}
          onBlur={() => setFocusedInput(null)}
          onChange={(event) => setSearch('registry', event.target.value)}
        />
      ) : null}
      {view === 'skills' ? (
        <input
          className={`gpu-dom-input gpu-view-search${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          aria-label={t('nav.filterSkills')}
          value={search.skills}
          placeholder={t('nav.filterSkills')}
          inert={overlaysInert}
          onFocus={() => setFocusedInput('skills')}
          onBlur={() => setFocusedInput(null)}
          onChange={(event) => setSearch('skills', event.target.value)}
        />
      ) : null}
      {projectActionsEnabled && view === 'projects' ? (
        <form
          className={`gpu-panel-skin gpu-project-form${overlaysInert ? ' gpu-overlays-veiled' : ''}${selectedProjectName ? ' gpu-project-form--run' : ''}`}
          inert={overlaysInert}
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
      {view === 'settings' ? (
        <form
          className={`gpu-panel-skin gpu-settings-form${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          inert={overlaysInert}
          onSubmit={(event) => {
            event.preventDefault();
            const next = search.displayName.trim();
            if (next) onRenameAccount?.(next);
          }}
        >
          <label className="gpu-settings-username" htmlFor="settings-display-name">
            {t('settings.username')}
          </label>
          <input
            id="settings-display-name"
            className="gpu-dom-input gpu-settings-name"
            aria-label={t('settings.username')}
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
      {view === 'settings' && orgModelsForm ? (
        <div data-veiled={domOverlaysVeiled ? 'true' : undefined}>{orgModelsForm}</div>
      ) : null}
      {view === 'announce' && announcementsEnabled ? (
        <AnnouncementForm t={t} locale={locale} resetSignal={announcementResetSignal} inert={overlaysInert} />
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
