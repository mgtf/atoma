import { Component, type ErrorInfo, type ReactNode } from 'react';
import { detectLocale, translate } from '../client/i18n-catalog.js';

export class GpuErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[viz:gpu] unrecoverable render error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const locale = detectLocale();
    return (
      <main className="gpu-crash" role="alert">
        <strong>{translate(locale, 'app.crash.title')}</strong>
        <pre>{this.state.error.message}</pre>
        <button onClick={() => window.location.reload()}>
          {translate(locale, 'app.crash.reload')}
        </button>
      </main>
    );
  }
}
