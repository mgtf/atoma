export function registerAtomaServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((registration) => registration.update())
    .catch(() => {
      // PWA support is progressive enhancement; the visualizer remains usable.
    });
}
