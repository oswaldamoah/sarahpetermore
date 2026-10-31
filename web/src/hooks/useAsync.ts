import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, isTransient } from '@/lib/format';

/** Load data, exposing loading / error / reload. Re-runs when deps change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true); setError(null);
    try {
      let d: T;
      // Quietly retry dropped connections a couple of times before showing anything to the user.
      for (let attempt = 0; ; attempt++) {
        try { d = await fn(); break; }
        catch (e) { if (attempt >= 2 || !isTransient(e) || n !== seq.current) throw e; await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); }
      }
      if (n === seq.current) setData(d);
    }
    catch (e) { if (n === seq.current) setError(errorText(e)); }
    finally { if (n === seq.current) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void run(); }, [run]);
  return { data, error, loading, reload: run, setData };
}

/** Throw on Data API errors so useAsync / try-catch can handle them. */
export async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}
