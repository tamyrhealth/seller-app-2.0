import type { MutableRefObject } from 'react';

/**
 * Resume/background reload of the same query must keep the current tree.
 * Replacing a tall page with a skeleton collapses window scroll to 0.
 */
export function isSilentPageReload(scopeKey: string, paintedScopeRef: MutableRefObject<string | null>): boolean {
  return paintedScopeRef.current === scopeKey;
}

export function markPageQueryPainted(scopeKey: string, paintedScopeRef: MutableRefObject<string | null>): void {
  paintedScopeRef.current = scopeKey;
}
