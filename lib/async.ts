/** Bound waits without allowing a late result to continue the caller's transaction flow. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms)); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The abort signal remains active while the caller reads the response body. No automatic retry. */
export const fetchWithTimeout: typeof fetch = (input, init) => {
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeout = AbortSignal.timeout(20_000);
  return fetch(input, { ...init, signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout });
};

/** Share concurrent reads only; settled results never become stale transaction-building inputs. */
export function singleFlight<K, V>() {
  const pending = new Map<K, Promise<V>>();
  return (key: K, run: () => Promise<V>): Promise<V> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const request = Promise.resolve().then(run).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
