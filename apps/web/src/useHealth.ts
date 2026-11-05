import { HealthResponse } from '@diet/shared';
import { useEffect, useState } from 'react';

export type HealthState =
  { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error'; message: string };

/** Fetches `/api/health` once on mount. A 503 still carries a valid body (database down). */
export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (res) => {
        const parsed = HealthResponse.safeParse(await res.json());
        if (!parsed.success) throw new Error(`Unexpected response (${res.status})`);
        setState({ kind: 'ok', health: parsed.data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  return state;
}
