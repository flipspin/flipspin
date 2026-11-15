/** Keep unavailable providers separate from transient failures: enabling one requires Settings.
 * Abort on unmount or target change so fast navigation cannot publish stale results. */
import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

export type BrowseLoadOptions = { refresh?: boolean; signal?: AbortSignal };

export function useBrowseResource<T>(loader: (options: BrowseLoadOptions) => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (refresh = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const result = await loader({ refresh, signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      } catch (e) {
        if ((e instanceof Error && e.name === "AbortError") || controller.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      }
    },
    // `loader` is rebuilt by the caller whenever its target changes; `deps` is
    // the caller's own identity for that target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );

  useEffect(() => {
    run(false);
    return () => abortRef.current?.abort();
  }, [run]);

  return { data, error, loading, reload: run };
}
