export type AuthSessionDecision = 'allowed' | 'denied' | 'unknown';

export type AuthJwtClaims = {
  sub?: string;
  role?: string;
  session_id?: string;
};

export type LiveAuthSession = {
  id: string;
  userId: string;
  createdAt: string;
  notAfter: string | null;
};

function isExpired(session: LiveAuthSession, nowMs: number): boolean {
  if (!session.notAfter) return false;
  const t = Date.parse(session.notAfter);
  if (Number.isNaN(t)) return true;
  return t <= nowMs;
}

function createdAtMs(session: LiveAuthSession): number {
  const t = Date.parse(session.createdAt);
  return Number.isNaN(t) ? NaN : t;
}

export function jwtSessionId(claims: AuthJwtClaims | null | undefined): string | null {
  const sid = claims?.session_id?.trim();
  return sid ? sid : null;
}

/**
 * Server-side session gate. Never trusts a browser-supplied device_id.
 *
 * claim: first login, same session (two tabs), or a strictly newer live GoTrue
 * session. An older JWT cannot take over. Dead stored sessions can be replaced.
 * mutate: fail-closed. UNKNOWN and DENIED both block the RPC.
 * service_role is allowed for internal Next routes; clients cannot mint it.
 */
export function interpretAuthSessionGuard(input: {
  mode: 'claim' | 'mutate';
  userId: string | null | undefined;
  jwtRole?: string | null;
  jwtSessionId: string | null | undefined;
  storedSessionId: string | null | undefined;
  liveSession: LiveAuthSession | null | undefined;
  storedLiveSession?: LiveAuthSession | null;
  liveLookupError?: boolean;
  nowMs?: number;
}): AuthSessionDecision {
  if (input.jwtRole === 'service_role') return 'allowed';
  if (!input.userId) return 'denied';
  if (input.liveLookupError) return 'unknown';

  const jwtSid = input.jwtSessionId?.trim() || '';
  if (!jwtSid) {
    return input.mode === 'claim' ? 'unknown' : 'denied';
  }

  const nowMs = input.nowMs ?? Date.now();
  const live = input.liveSession;
  if (!live) return 'denied';
  if (live.id !== jwtSid) return 'denied';
  if (live.userId !== input.userId) return 'denied';
  if (isExpired(live, nowMs)) return 'denied';

  const stored = input.storedSessionId?.trim() || '';

  if (input.mode === 'claim') {
    if (!stored || stored === jwtSid) return 'allowed';
    const storedLive = input.storedLiveSession;
    if (!storedLive || storedLive.id !== stored || isExpired(storedLive, nowMs)) {
      return 'allowed';
    }
    const jwtCreated = createdAtMs(live);
    const storedCreated = createdAtMs(storedLive);
    if (Number.isNaN(jwtCreated) || Number.isNaN(storedCreated)) return 'denied';
    if (jwtCreated > storedCreated) return 'allowed';
    return 'denied';
  }

  if (!stored) return 'denied';
  if (stored !== jwtSid) return 'denied';
  return 'allowed';
}

export function mutationAllowed(decision: AuthSessionDecision): boolean {
  return decision === 'allowed';
}

export function isMissingAuthSessionRpc(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  const blob = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  return /pgrst202|could not find the function|function .* does not exist|schema cache/.test(blob);
}

export function isNetworkAuthSessionError(error: { message?: string; name?: string; status?: number } | null | undefined): boolean {
  if (!error) return false;
  const msg = `${error.name || ''} ${error.message || ''}`.toLowerCase();
  return /failed to fetch|network|timeout|offline|abort/.test(msg);
}

export function mapAuthSessionRpcResult(input: {
  kind: 'claim' | 'check';
  data: unknown;
  error: { message?: string; code?: string; name?: string; status?: number } | null;
}): AuthSessionDecision {
  if (input.error) {
    if (isNetworkAuthSessionError(input.error)) return 'unknown';
    if (isMissingAuthSessionRpc(input.error)) {
      return input.kind === 'check' ? 'allowed' : 'unknown';
    }
    if (/active session required|not authenticated/i.test(input.error.message || '')) return 'denied';
    return 'unknown';
  }
  if (input.data === 'allowed' || input.data === 'denied' || input.data === 'unknown') return input.data;
  return 'unknown';
}
