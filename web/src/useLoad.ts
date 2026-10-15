import { type DependencyList, useEffect, useState } from "react";

export interface Load<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/** Runs an async loader per dependency change; ignores results from stale runs. `enabled=false` idles. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList, enabled = true): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, error: null, loading: enabled });
  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: Error) => live && setState({ data: null, error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
  return state;
}
