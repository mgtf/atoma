/**
 * WHERE THE SERVICE WORKER IS ALLOWED TO EXIST.
 * =============================================
 *
 * Production always. Dev only behind `ATOMA_VIZ_SW_DEV=1`, which
 * `vite.config.ts` compiles into `__ATOMA_SW_DEV__`.
 *
 * The default stays OFF because this worker is not scoped to a build: it
 * calls `skipWaiting()` and `clients.claim()`, and its scope is the ORIGIN —
 * `127.0.0.1:5173` — not this project. A registration left behind by a dev
 * session outlives the dev server and would control whatever else is served
 * on that port next. So the guard is symmetric: when registration is not
 * allowed we do not merely skip it, we REMOVE what an earlier opt-in session
 * left, which is what makes the flag safe to turn back off.
 */

/**
 * Vite inlines a define at build and exposes it as a global in dev (verified
 * against `__ATOMA_RELEASE_VERSION__`, which this file's neighbour reads the
 * same way). Neither happens under vitest or plain `tsc`, hence the `typeof`.
 */
function devOptIn(): boolean {
  return typeof __ATOMA_SW_DEV__ !== 'undefined' && __ATOMA_SW_DEV__;
}

/**
 * The ONE answer to "will a service worker be there?", shared with the push
 * prompt — an enable button that cannot finish is worse than no button, so
 * the two must never disagree about it.
 */
export function serviceWorkerRegistrationAllowed(
  env: { readonly prod?: boolean; readonly devOptIn?: boolean } = {}
): boolean {
  return (env.prod ?? import.meta.env.PROD) || (env.devOptIn ?? devOptIn());
}

/** Our own worker, not whatever else may share this dev origin. */
function isAtomaWorker(registration: ServiceWorkerRegistration): boolean {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) return false;
  try {
    return new URL(worker.scriptURL).pathname === '/sw.js';
  } catch {
    return false;
  }
}

async function removeAtomaServiceWorker(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.filter(isAtomaWorker).map((r) => r.unregister()));
  } catch {
    // Nothing registered, or an origin that forbids the query. Either way
    // there is nothing this cleanup can or must do.
  }
  try {
    const keys = await caches.keys();
    // Only our namespace: the shell cache the worker itself writes.
    await Promise.all(
      keys.filter((key) => key.startsWith('atoma-viz-')).map((key) => caches.delete(key))
    );
  } catch {
    // Cache Storage is unavailable in some contexts; an orphaned cache with
    // no worker to read it is inert.
  }
}

export function registerAtomaServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!serviceWorkerRegistrationAllowed()) {
    void removeAtomaServiceWorker();
    return;
  }
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((registration) => registration.update())
    .catch(() => {
      // PWA support is progressive enhancement; the visualizer remains usable.
    });
}
