import { matchesSearchQuery, runSearchText } from '../client/search.js';
import type { RunIndexEntry, VizGitHubInstallation } from '../client/types.js';
import { useGpuStore, type ViewName } from './store.js';

const DEFAULT_VIEWS: ViewName[] = ['projects', 'runs', 'registry', 'skills', 'burnin', 'launch'];

export function DomBridge({
  runs,
  releaseVersion,
  views = DEFAULT_VIEWS,
  loginLinks = null,
  t,
  onSelectRun,
  onCopy,
  onEnter,
  githubInstallations = [],
  onCreateProject,
  onStartRun,
  projectBusy = false,
  projectError = null,
  selectedProjectName = null,
}: {
  runs: RunIndexEntry[];
  releaseVersion: string;
  /** Nav tabs for this viewer — computed once by `visibleViews`, shared with the GL header. */
  views?: ViewName[];
  /** Non-null when the arrival gate is a login: real anchors, one per provider. */
  loginLinks?: { id: string; label: string; href: string }[] | null;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onSelectRun: (id: string) => void;
  onCopy: () => void;
  onEnter?: () => void;
  githubInstallations?: VizGitHubInstallation[];
  onCreateProject?: () => void;
  onStartRun?: () => void;
  projectBusy?: boolean;
  projectError?: string | null;
  selectedProjectName?: string | null;
}) {
  const view = useGpuStore((state) => state.view);
  const entered = useGpuStore((state) => state.entered);
  const locale = useGpuStore((state) => state.locale);
  const selectedRunId = useGpuStore((state) => state.selectedRunId);
  const focusedInput = useGpuStore((state) => state.focusedInput);
  const runPickerActiveIndex = useGpuStore((state) => state.runPickerActiveIndex);
  const search = useGpuStore((state) => state.search);
  const setView = useGpuStore((state) => state.setView);
  const enter = useGpuStore((state) => state.enter);
  const refresh = useGpuStore((state) => state.refresh);
  const setLocale = useGpuStore((state) => state.setLocale);
  const setSearch = useGpuStore((state) => state.setSearch);
  const setFocusedInput = useGpuStore((state) => state.setFocusedInput);
  const setRunPickerActiveIndex = useGpuStore((state) => state.setRunPickerActiveIndex);
  const setRunPickerScrollY = useGpuStore((state) => state.setRunPickerScrollY);
  const selectedGithubInstallationId = useGpuStore((state) => state.selectedGithubInstallationId);
  const selectGithubInstallation = useGpuStore((state) => state.selectGithubInstallation);
  const activeGithubInstallations = githubInstallations.filter(
    (installation) => installation.status === 'active'
  );
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const runValue = focusedInput === 'run' ? search.run : selectedRun?.label ?? '';
  const filteredRuns = runs.filter((run) =>
    matchesSearchQuery(runSearchText(run), search.run)
  );

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
        aria-label="Atoma GPU visualizer"
      >
        <nav role="tablist" aria-label="Views">
          {views.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={view === name}
              onClick={() => setView(name)}
            >
              {t(`nav.${name}`)}
            </button>
          ))}
        </nav>
        <button onClick={refresh}>{t('nav.refresh')}</button>
        <button onClick={() => setLocale(locale === 'en' ? 'fr' : 'en')}>
          {locale === 'en' ? 'Français' : 'English'}
        </button>
        <div data-viz-live aria-live="polite" aria-atomic="true">
          {t(`nav.${view}`)}
          {selectedRun ? ` — ${selectedRun.label}` : ''}
        </div>
      </div>

      {view === 'runs' ? (
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
      {view === 'registry' ? (
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
      {view === 'skills' ? (
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
      {view === 'launch' ? (
        <>
          <textarea
            className="gpu-dom-input gpu-launch-input"
            aria-label={t('launch.goal')}
            value={search.launch}
            placeholder={t('launch.goal.placeholder')}
            onFocus={() => setFocusedInput('launch')}
            onBlur={() => setFocusedInput(null)}
            onChange={(event) => setSearch('launch', event.target.value)}
          />
          <button className="gpu-copy-bridge" onClick={onCopy}>
            {t('launch.copy')}
          </button>
        </>
      ) : null}
      {view === 'projects' ? (
        <form
          className={`gpu-project-form${selectedProjectName ? ' gpu-project-form--run' : ''}`}
          onSubmit={(event) => event.preventDefault()}
        >
          <input
            className="gpu-dom-input gpu-project-name"
            aria-label={t('projects.name')}
            value={search.projectName}
            placeholder={t('projects.name')}
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
          <select
            className="gpu-dom-input gpu-project-install"
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
          {selectedProjectName ? (
            <textarea
              className="gpu-dom-input gpu-project-prompt"
              aria-label={t('projects.prompt')}
              value={search.projectPrompt}
              placeholder={t('projects.promptPlaceholder')}
              onFocus={() => setFocusedInput('projectPrompt')}
              onBlur={() => setFocusedInput(null)}
              onChange={(event) => setSearch('projectPrompt', event.target.value)}
            />
          ) : null}
          <div className="gpu-project-actions">
            {activeGithubInstallations.length === 0 ? (
              <a href="/auth/github/connect">{t('projects.connectGithub')}</a>
            ) : null}
            <button type="button" disabled={projectBusy} onClick={() => onCreateProject?.()}>
              {t('projects.create')}
            </button>
            {selectedProjectName ? (
              <button type="button" disabled={projectBusy} onClick={() => onStartRun?.()}>
                {t('projects.startRunOn', { name: selectedProjectName })}
              </button>
            ) : null}
            {projectError ? <span role="alert">{projectError}</span> : null}
          </div>
          <p className="gpu-project-hint">
            {selectedProjectName
              ? t('projects.actionsHint.ready', { name: selectedProjectName })
              : t('projects.actionsHint.new')}
          </p>
        </form>
      ) : null}
    </>
  );
}
