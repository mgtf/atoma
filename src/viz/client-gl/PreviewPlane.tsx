import { useEffect, useRef } from 'react';
import type { VizPreviewSummary } from '../client/types.js';

/**
 * THE PREVIEW PLANE — where a member watches the app a run produced.
 *
 * It is a full-screen DOM plane, not an overlay panel, and that distinction
 * decides three things at once:
 *
 * 1. IT OWNS THE SCREEN. The scene behind it is hidden and made `inert`, so
 *    there is no z-order question to lose: nothing of the product is
 *    underneath competing for the pointer light or for the hover bubble. That
 *    is why this is the one DOM surface allowed to paint its own frame
 *    without joining the grandfathered CSS-skin list in
 *    tests/viz-overlay-stack.test.ts — it is not over the canvas, it
 *    REPLACES it.
 * 2. THE CHROME IS OURS, ALWAYS. Identity, the untrusted-app warning and
 *    every control sit OUTSIDE the iframe, in this document. Generated
 *    content cannot cover them, cannot restyle them and cannot read them.
 * 3. THE IFRAME MOUNTS ONLY WHEN READY. A frame pointed at a starting
 *    generation would render the gateway's 404 and cache it as the member's
 *    first impression of their own result.
 *
 * The URL is a CREDENTIAL: it carries a one-time claim in its fragment. It
 * arrives as a prop, is handed straight to the iframe, and is never stored,
 * never logged and never put in the address bar. `key` on the iframe is the
 * generation, so a restart replaces the element rather than navigating it —
 * a new origin deserves a new frame, not a reused one carrying the old
 * origin's session history.
 */

export type PreviewPlaneStatus = 'idle' | 'opening' | 'error';

export function PreviewPlane({
  open,
  summary,
  url,
  reloadNonce,
  projectName,
  goal,
  status,
  errorMessage,
  t,
  locale,
  onClose,
  onReload,
  onRestart,
  onStop,
}: {
  open: boolean;
  summary: VizPreviewSummary | null;
  /** Non-null only while an unspent claim is in hand. Never persisted. */
  url: string | null;
  /** Bumped by Reload. See `frameSrc` for why a reload changes the URL. */
  reloadNonce: number;
  projectName: string;
  goal: string;
  status: PreviewPlaneStatus;
  errorMessage: string | null;
  t: (key: string, vars?: Record<string, unknown>) => string;
  locale: string;
  onClose: () => void;
  onReload: () => void;
  onRestart: () => void;
  onStop: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Focus lands on the toolbar's first control on entry. Restoring it on exit
  // is the CALLER's job, not this component's: the control that opened the
  // plane is a GL hit target mirrored in the semantic bridge, and only the
  // caller knows which one it was.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  // Escape leaves. A member whose focus is inside the iframe is inside
  // another origin and this listener never sees their keys — which is exactly
  // why Back is a real button in our chrome and not only a shortcut.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const state = summary?.state ?? 'stopped';
  const ready = state === 'ready' && url !== null;
  const identity = t('preview.identity', { project: projectName, goal });
  const statusLine =
    status === 'error' && errorMessage
      ? errorMessage
      : status === 'opening' || state === 'starting'
        ? t('preview.status.starting')
        : state === 'ready'
          ? t('preview.status.ready')
          : state === 'stopping'
            ? t('preview.status.stopping')
            : state === 'failed'
              ? t('preview.status.failed')
              : t('preview.status.stopped');
  // A snapshot of a run still in flight is NOT the result, and the surface
  // says so with the moment it was taken. A surface that cannot say "state at
  // 14:32" lets a member read a half-built app as the finished one.
  const provenance =
    summary?.source === 'in-flight'
      ? t('preview.snapshot.inFlight', {
          time: formatSnapshotTime(summary.snapshotAt, locale),
        })
      : t('preview.snapshot.delivered');

  return (
    <section
      className="gpu-preview-plane"
      role="dialog"
      aria-modal="true"
      aria-label={t('preview.region')}
    >
      <header className="gpu-preview-chrome">
        <div className="gpu-preview-identity">
          <strong>{t('preview.title')}</strong>
          <span title={identity}>{identity}</span>
        </div>
        <div className="gpu-preview-actions">
          <button type="button" ref={closeRef} onClick={onClose}>
            {t('preview.back')}
          </button>
          <button type="button" onClick={onReload} disabled={!ready}>
            {t('preview.reload')}
          </button>
          <button type="button" onClick={onRestart} disabled={status === 'opening'}>
            {t('preview.restart')}
          </button>
          {/* NO "open in a new tab" here, and it is not an omission.
              The grant cookie is `Partitioned`, so it is keyed to the
              visualizer as the embedding site; a TOP-LEVEL tab on the preview
              origin is a different partition and would arrive with no grant
              at all — the member would get the gateway's one generic 404 on
              their own preview. Making it work means minting a second claim
              for a top-level context, which is a decision about what a claim
              binds, not a button. Recorded in src/preview/AGENTS.md. */}
          <button type="button" onClick={onStop} disabled={state === 'stopped'}>
            {t('preview.stop')}
          </button>
        </div>
      </header>
      <p className="gpu-preview-warning">{t('preview.untrusted')}</p>
      <div className="gpu-preview-status" aria-live="polite" aria-atomic="true">
        <span>{statusLine}</span>
        <span className="gpu-preview-provenance">{provenance}</span>
      </div>
      <div className="gpu-preview-stage">
        {ready ? (
          <iframe
            // The generation AND the reload nonce: a restart is a new origin
            // and deserves a new element rather than a navigation carrying the
            // old one's history, and a reload must remount rather than reuse.
            key={`${summary?.generation ?? 0}:${reloadNonce}`}
            className="gpu-preview-frame"
            src={frameSrc(url, reloadNonce)}
            title={t('preview.frameTitle', { project: projectName, goal })}
            // The gateway sets the real policy on the response; this is the
            // second, independent bound the parent document controls. Neither
            // is the other's backup — a member is protected when BOTH hold.
            //
            // `allow-same-origin` IS granted, and it is not a weakening: the
            // preview already sits on its own registrable domain carrying no
            // Atoma cookie, which is the isolation. Withholding it would put
            // the app in an OPAQUE origin, where the gateway's own
            // `default-src 'self'` matches nothing and every separate script
            // or stylesheet the deliverable loads is blocked — the feature
            // would not work for any app built from more than one file.
            // `allow-popups` is deliberately absent: generated code opening
            // windows over the member's browser is not review evidence.
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            allow=""
          />
        ) : (
          <p className="gpu-preview-placeholder">{statusLine}</p>
        )}
      </div>
    </section>
  );
}

/**
 * What the frame actually navigates to.
 *
 * THE FIRST LOAD USES THE CLAIM. It travels in the fragment, the gateway's
 * bootstrap page reads it there, exchanges it for a grant cookie and replaces
 * the URL. The claim is ONE-TIME, so it is spent from that moment.
 *
 * EVERY RELOAD AFTER THAT USES THE ORIGIN ROOT. Re-navigating to the spent
 * claim would land on "this preview link has already been used" — a reload
 * button that breaks the thing it reloads. The grant cookie is what carries
 * the second visit, which is exactly what a grant is for.
 */
function frameSrc(url: string | null, reloadNonce: number): string | undefined {
  if (!url) return undefined;
  if (reloadNonce === 0) return url;
  try {
    return new URL(url).origin + '/';
  } catch {
    return url;
  }
}

/**
 * The snapshot moment, in the viewer's own locale.
 *
 * Falls back to the raw value rather than to nothing: a member told "state at
 * 2026-09-02T14:32:11Z" is still told when, while an empty string would let a
 * mid-run snapshot pass for the finished result.
 */
function formatSnapshotTime(snapshotAt: string | null, locale: string): string {
  if (!snapshotAt) return '';
  const at = new Date(snapshotAt);
  if (Number.isNaN(at.getTime())) return snapshotAt;
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(at);
  } catch {
    return at.toISOString();
  }
}
