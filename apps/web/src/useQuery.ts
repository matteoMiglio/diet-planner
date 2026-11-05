import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

export type QueryState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'ok'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: ApiError };

/** Fetches `GET /api{path}` on mount; `reload` refetches and keeps showing the old data meanwhile. */
export function useQuery<T>(path: string): QueryState<T> & { reload: () => Promise<void> } {
  const [state, setState] = useState<QueryState<T>>({ status: 'loading' });

  const fetchState = useCallback(
    (): Promise<QueryState<T>> =>
      api.get<T>(path).then(
        (data) => ({ status: 'ok', data }),
        (err: unknown) => ({
          status: 'error',
          error: err instanceof ApiError ? err : new ApiError(0, 'error', String(err)),
        }),
      ),
    [path],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchState]);

  const reload = useCallback(async () => setState(await fetchState()), [fetchState]);
  return { ...state, reload };
}
