import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../client/data-api.js';
import type { VizPreviewSummary } from '../client/types.js';
import type { PreviewPlaneStatus } from './PreviewPlane.js';

const PREVIEW_HEARTBEAT_MS = 60_000;

function previewErrorMessage(error: unknown, t: (key: string) => string): string {
  return error instanceof Error && error.message ? error.message : t('preview.error.generic');
}

/** Credentials stay local to the visible session and are bound to their generation. */
export function usePreviewSession({ previewTarget, previewSummary, t }: {
  previewTarget: { projectId: string; projectRunId: string } | null;
  previewSummary: VizPreviewSummary | null;
  t: (key: string) => string;
}) {
  const queryClient = useQueryClient();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [claim, setClaim] = useState<{ url: string; generation: number } | null>(null);
  const previewUrl = previewSummary?.state === 'ready' && claim?.generation === previewSummary.generation
    ? claim.url : null;
  const requestSequence = useRef(0);
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
  const requestPreview = useCallback(
    async (mode: 'open' | 'restart' | 'claim'): Promise<void> => {
      if (!previewTarget) return;
      const { projectId, projectRunId } = previewTarget;
      const sequence = ++requestSequence.current;
      setClaim(null);
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
          mode === 'claim'
            ? await api.openPreview(projectId, projectRunId, { generation: previewSummary?.generation })
            : mode === 'open'
            ? await api.openPreview(projectId, projectRunId, { inFlight: true })
            : await api.restartPreview(projectId, projectRunId, { inFlight: true });
        if (sequence !== requestSequence.current) return;
        await queryClient.cancelQueries({ queryKey: ['viz', 'preview', projectId, projectRunId] });
        if (sequence !== requestSequence.current) return;
        queryClient.setQueryData(['viz', 'preview', projectId, projectRunId], answered.summary);
        setClaim(answered.url ? { url: answered.url, generation: answered.summary.generation } : null);
        setPreviewStatus('idle');
        // A 202 means another caller is building this generation. Nothing to
        // do but let `usePreviewStatus` poll, which it already does while the
        // state is `starting`.
      } catch (error) {
        if (sequence !== requestSequence.current) return;
        setPreviewStatus('error');
        setPreviewError(previewErrorMessage(error, t));
      } finally {
        await queryClient.invalidateQueries({
          queryKey: ['viz', 'preview', projectId, projectRunId],
        });
      }
    },
    [previewTarget, previewSummary?.generation, queryClient, t]
  );

  const reloadPreview = useCallback(() => {
    setPreviewReloadNonce((nonce) => nonce + 1);
  }, []);

  const closePreview = useCallback(() => {
    requestSequence.current += 1;
    setPreviewOpen(false);
    // The URL is dropped with the plane. Its claim is spent anyway, and a
    // credential kept past the surface that used it is a credential waiting
    // to be found.
    setClaim(null);
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
  }, [closePreview, previewTarget, queryClient, t]);

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

  // A generation someone ELSE was building or restarted has become ready, and this browser
  // holds no claim for it: `open` answered 202 because another caller was
  // already starting it, so there was no URL to hand over. Without this the
  // plane sits on its placeholder for a preview that is running and reachable.
  // Joining names a generation and never takes a new snapshot.
  // ONE ask, and it cannot loop: a success sets the URL and a failure sets the
  // error status, and both falsify the guard.
  useEffect(() => {
    if (!previewOpen || previewUrl || previewStatus !== 'idle') return;
    if (previewSummary?.state !== 'ready') return;
    void requestPreview('claim');
  }, [previewOpen, previewStatus, previewSummary?.state, previewUrl, requestPreview]);

  // A preview that stopped underneath the plane — idle expiry, a restart
  // elsewhere, an operator stop — takes its frame down with it rather than
  // leaving a dead iframe that still looks like the app.
  useEffect(() => {
    if (!previewOpen) return;
    if (previewSummary && previewSummary.state !== 'ready' && previewSummary.state !== 'starting') {
      setClaim(null);
    }
  }, [previewOpen, previewSummary]);

  useEffect(() => () => { requestSequence.current += 1; }, [previewTarget?.projectId, previewTarget?.projectRunId]);

  return { previewOpen, previewUrl, previewStatus, previewError, previewReloadNonce,
    requestPreview, closePreview, stopPreview, reloadPreview };
}
