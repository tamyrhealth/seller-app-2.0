import {
  interpretAuthSessionGuard,
  jwtSessionId,
  mapAuthSessionRpcResult,
  mutationAllowed,
} from '../lib/authSessionGuard';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

const uid = 'user-1';
const sidA = 'sess-a';
const sidB = 'sess-b';
const older = '2026-01-01T00:00:00.000Z';
const newer = '2026-11-10T12:00:00.000Z';
const liveA = { id: sidA, userId: uid, createdAt: older, notAfter: null };
const liveB = { id: sidB, userId: uid, createdAt: newer, notAfter: null };
const now = Date.parse('2026-11-10T14:00:00.000Z');

if (jwtSessionId({ session_id: '  abc  ' }) !== 'abc') fail('trim session_id');
if (jwtSessionId({ sub: uid }) !== null) fail('missing session_id claim');
if (jwtSessionId(null) !== null) fail('null claims');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtRole: 'service_role',
  jwtSessionId: null,
  storedSessionId: sidA,
  liveSession: null,
}) !== 'allowed') fail('service_role bypass for internal routes');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: null,
  jwtSessionId: sidA,
  storedSessionId: sidA,
  liveSession: liveA,
}) !== 'denied') fail('no auth.uid is denied');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: sidA,
  liveSession: liveA,
  liveLookupError: true,
}) !== 'unknown') fail('auth.sessions lookup error is unknown, not allowed');

if (mutationAllowed('unknown')) fail('unknown must not allow mutations');
if (mutationAllowed('denied')) fail('denied must not allow mutations');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: null,
  storedSessionId: sidA,
  liveSession: liveA,
}) !== 'denied') fail('JWT without session_id must fail closed on mutate');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: null,
  storedSessionId: null,
  liveSession: liveA,
}) !== 'unknown') fail('claim without session_id is unknown, not first-login allowed');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: null,
  liveSession: liveA,
}) !== 'allowed') fail('first login claim is allowed');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: sidA,
  liveSession: liveA,
}) !== 'allowed') fail('two tabs of the same session may re-claim');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: sidB,
  liveSession: liveA,
  storedLiveSession: liveB,
}) !== 'denied') fail('older JWT must not take over a newer claimed session');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: sidB,
  storedSessionId: sidA,
  liveSession: liveB,
  storedLiveSession: liveA,
}) !== 'allowed') fail('newer login may take over');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: sidB,
  storedSessionId: sidA,
  liveSession: liveB,
  storedLiveSession: null,
}) !== 'allowed') fail('dead stored session may be replaced');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: null,
  liveSession: { id: sidA, userId: 'other', createdAt: older, notAfter: null },
}) !== 'denied') fail('cannot claim another user session');

if (interpretAuthSessionGuard({
  mode: 'claim',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: null,
  liveSession: null,
}) !== 'denied') fail('forged session_id not in auth.sessions');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: null,
  liveSession: liveA,
}) !== 'denied') fail('mutate before claim is denied (not first-login open)');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: sidA,
  liveSession: liveA,
}) !== 'allowed') fail('matching live session is allowed');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: sidB,
  liveSession: liveA,
}) !== 'denied') fail('old JWT after new device claim is denied immediately');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: sidB,
  storedSessionId: sidA,
  liveSession: liveB,
}) !== 'denied') fail('second browser JWT does not match stored session');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: sidA,
  liveSession: null,
}) !== 'denied') fail('revoked auth.sessions row blocks leftover access token');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: sidA,
  storedSessionId: sidA,
  liveSession: { id: sidA, userId: uid, createdAt: older, notAfter: '2026-11-10T13:00:00.000Z' },
  nowMs: now,
}) !== 'denied') fail('expired auth session is denied');

if (interpretAuthSessionGuard({
  mode: 'mutate',
  userId: uid,
  jwtSessionId: 'forged-from-browser',
  storedSessionId: 'forged-from-browser',
  liveSession: null,
}) !== 'denied') fail('browser-supplied device/session id is ignored without live row');

if (
  mapAuthSessionRpcResult({
    kind: 'check',
    data: null,
    error: { code: 'PGRST202', message: 'Could not find the function' },
  }) !== 'allowed'
) fail('missing check RPC must not block old/new client before phase 1');
if (
  mapAuthSessionRpcResult({
    kind: 'claim',
    data: null,
    error: { code: 'PGRST202', message: 'Could not find the function public.claim_active_auth_session' },
  }) !== 'unknown'
) fail('missing claim RPC is unknown, not denied');
if (
  mapAuthSessionRpcResult({
    kind: 'claim',
    data: null,
    error: { message: 'Failed to fetch' },
  }) !== 'unknown'
) fail('network claim is unknown');
if (
  mapAuthSessionRpcResult({
    kind: 'check',
    data: null,
    error: { message: 'timeout' },
  }) !== 'unknown'
) fail('network check is unknown, not allowed');
if (mapAuthSessionRpcResult({ kind: 'claim', data: 'allowed', error: null }) !== 'allowed') fail('claim data allowed');

console.log('auth-session guard prototype checks ok');
