import { useGpuStore, type ViewName } from './store.js';

const NAV_KEY = 'atoma.viz.update-navigation';
const ATTEMPT_KEY = 'atoma.viz.update-attempt';
const RETRY_MS = 5 * 60_000;

/** Build identity comes from content-hashed assets, not the package version. */
export function pageBuild(doc: Document): string | null {
  const modules = [...doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map((node) => node.getAttribute('src') ?? '');
  if (modules.length !== 1 || !/^\/assets\/index-[\w-]+\.js$/.test(modules[0]!)) return null;
  const styles = [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')]
    .map((node) => node.getAttribute('href') ?? '')
    .filter((href) => href.startsWith('/assets/'));
  return JSON.stringify([...modules, ...styles.sort()]);
}

/** No field content or credentials are persisted for an automatic update. */
export function saveUpdateNavigation(scope: string): void {
  const state = useGpuStore.getState();
  sessionStorage.setItem(NAV_KEY, JSON.stringify({
    scope, at: Date.now(), view: state.view, selectedProjectId: state.selectedProjectId,
    selectedRunId: state.selectedRunId, sceneCameraMode: state.sceneCameraMode,
    selectedGithubInstallationId: state.selectedGithubInstallationId, projectVisibility: state.projectVisibility,
  }));
}

export function restoreUpdateNavigation(scope: string, views: readonly ViewName[]): void {
  try {
    const raw = sessionStorage.getItem(NAV_KEY);
    sessionStorage.removeItem(NAV_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    if (saved['scope'] !== scope || typeof saved['at'] !== 'number' ||
      Date.now() - saved['at'] > RETRY_MS || Date.now() < saved['at'] ||
      !views.includes(saved['view'] as ViewName)) return;
    const id = (value: unknown): string | null => typeof value === 'string' && value.length <= 200 ? value : null;
    useGpuStore.setState({
      view: saved['view'] as ViewName,
      selectedProjectId: id(saved['selectedProjectId']),
      selectedRunId: id(saved['selectedRunId']),
      selectedGithubInstallationId: id(saved['selectedGithubInstallationId']),
      projectVisibility: saved['projectVisibility'] === 'public' ? 'public' : 'private',
      sceneCameraMode: saved['sceneCameraMode'] === 'focus' ? 'focus' : 'overview',
    });
  } catch { /* Unavailable or invalid tab storage is never a reason to lose the page. */ }
}

/** Conservative protection for DOM inputs, including autofill and focused selects. */
export function hasEditableWork(doc: Document): boolean {
  // An open preview may contain its own unsaved state on another origin.
  if (doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return true;
  if (doc.activeElement?.matches('input, textarea, select, [contenteditable="true"], iframe')) return true;
  return [...doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
    .some((field) => !['button', 'submit', 'reset', 'hidden', 'checkbox', 'radio', 'range'].includes(field.type) && field.value !== '') ||
    [...doc.querySelectorAll<HTMLElement>('[contenteditable="true"]')].some((field) => !!field.textContent);
}

export interface AutoUpdateOptions {
  canReload(): boolean;
  beforeReload(): void;
  reload?: () => void;
  pollMs?: number;
}

/** Network-only checks; no reload after offline, auth, or failed deployment responses. */
export function startAutoUpdate(options: AutoUpdateOptions): { check(): Promise<void>; stop(): void } {
  const current = pageBuild(document);
  let stopped = false;
  let checking = false;
  let reloading = false;
  let lastInteraction = Date.now();
  const abort = new AbortController();
  const interaction = (): void => { lastInteraction = Date.now(); };
  const events = ['pointerdown', 'keydown', 'input', 'change', 'compositionstart', 'compositionend'] as const;
  for (const name of events) document.addEventListener(name, interaction, true);

  async function check(): Promise<void> {
    if (!current || stopped || checking || reloading || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const response = await fetch('/', {
        cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
      const html = await response.text();
      if (html.length > 1_000_000) return;
      const next = pageBuild(new DOMParser().parseFromString(html, 'text/html'));
      if (!next || next === current || stopped || document.visibilityState !== 'visible' ||
        Date.now() - lastInteraction < 5_000 || hasEditableWork(document) || !options.canReload()) return;
      // If a proxy serves old HTML after a reload, do not trap the user in a loop.
      const prior = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) ?? 'null') as { target?: string; at?: number } | null;
      if (prior?.target === next && typeof prior.at === 'number' && Date.now() - prior.at < RETRY_MS) return;
      options.beforeReload();
      sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ target: next, at: Date.now() }));
      reloading = true;
      (options.reload ?? (() => window.location.reload()))();
    } catch { /* Offline, shutdown, storage denied or a bad response: keep this page. */ }
    finally { checking = false; }
  }
  const wake = (): void => { void check(); };
  const timer = window.setInterval(wake, options.pollMs ?? 60_000);
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  return {
    check,
    stop() {
      stopped = true;
      abort.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      for (const name of events) document.removeEventListener(name, interaction, true);
    },
  };
}
