const inflight = new Map<string, Promise<unknown>>();

/**
 * Concurrent callers with the same key share one execution.
 * A new call is allowed only after the previous promise settles.
 */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const started = fn().finally(() => {
    if (inflight.get(key) === started) inflight.delete(key);
  });
  inflight.set(key, started);
  return started;
}

export function hasExclusiveInflight(key: string): boolean {
  return inflight.has(key);
}

/** Stable id for a new user-initiated mutation. Persist until that attempt finishes. */
export function newClientOperationId(): string {
  return crypto.randomUUID();
}
