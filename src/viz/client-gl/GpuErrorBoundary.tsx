import { Component, type ErrorInfo, type ReactNode } from 'react';

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
    return (
      <main className="gpu-crash" role="alert">
        <strong>GPU renderer stopped</strong>
        <pre>{this.state.error.message}</pre>
        <button onClick={() => window.location.reload()}>Reload visualizer</button>
      </main>
    );
  }
}
