import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './data-api.js';
import { isIndexEntryLive, isRunLive, projectRunUpdate } from './run-utils.js';
import type { RunIndexEntry, VizRun } from './types.js';

export function useRunsIndex(active: boolean) {
  const [runs, setRuns] = useState<RunIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.runs();
      setRuns(next);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => {
      void api.runs().then((next) => {
        setRuns((current) => {
          const topChanged = next[0]?.id !== current[0]?.id;
          const countChanged = next.length !== current.length;
          const anyLive = next.some((entry) => isIndexEntryLive(entry));
          return topChanged || countChanged || anyLive ? next : current;
        });
      }).catch(setError);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  return { runs, loading, error, refresh };
}

export function useRunTrace(runId: string | null, active: boolean) {
  const [run, setRun] = useState<VizRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const runRef = useRef<VizRun | null>(null);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const refresh = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const next = await api.run(runId);
      setRun(projectRunUpdate(null, next));
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setRun(null);
    setError(null);
    if (active && runId) void refresh();
  }, [active, refresh, runId]);

  useEffect(() => {
    if (!active || !runId) return;
    const timer = window.setInterval(() => {
      const current = runRef.current;
      if (!current) return;
      if (!isRunLive(current)) {
        window.clearInterval(timer);
        return;
      }
      void api.run(runId, current.events.length)
        .then((delta) => {
          setRun((value) => projectRunUpdate(value, delta));
          setError(null);
        })
        .catch(setError);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, runId]);

  return { run, loading, error, refresh };
}
