import { readFileSync } from 'fs';
import { join } from 'path';
import { interpretActiveDeviceQuery } from '../lib/deviceAccess';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

if (interpretActiveDeviceQuery({ userId: 'u', deviceId: 'd1', rowDeviceId: 'd1', error: null }) !== 'allowed') {
  fail('matching device must be allowed');
}
if (interpretActiveDeviceQuery({ userId: 'u', deviceId: 'd1', rowDeviceId: 'd2', error: null }) !== 'denied') {
  fail('other device must be denied');
}
if (interpretActiveDeviceQuery({ userId: 'u', deviceId: 'd1', rowDeviceId: null, error: null }) !== 'allowed') {
  fail('first connection without a row must be allowed');
}
if (
  interpretActiveDeviceQuery({
    userId: 'u',
    deviceId: 'd1',
    rowDeviceId: 'd1',
    error: { message: 'Failed to fetch' },
  }) !== 'unknown'
) {
  fail('network error must be unknown, not allowed');
}
if (
  interpretActiveDeviceQuery({
    userId: 'u',
    deviceId: 'd1',
    rowDeviceId: 'd2',
    error: { message: 'timeout', status: 503 },
  }) !== 'unknown'
) {
  fail('timeout must be unknown even if a stale row is present');
}
if (
  interpretActiveDeviceQuery({
    userId: 'u',
    deviceId: 'd1',
    rowDeviceId: null,
    error: { message: 'JWT expired', status: 401 },
  }) !== 'unknown'
) {
  fail('jwt error must be unknown, not sign-out via device layer');
}
if (interpretActiveDeviceQuery({ userId: '', deviceId: 'd1', rowDeviceId: 'd1', error: null }) !== 'denied') {
  fail('missing user is denied');
}
if (interpretActiveDeviceQuery({ userId: 'u', deviceId: '', rowDeviceId: 'd1', error: null }) !== 'unknown') {
  fail('missing device id is unknown, not allowed');
}

const session = read('lib/activeSession.ts');
if (session.includes('при ошибке не блокируем')) fail('fail-open comment must be gone');
if (/if \(error \|\| !data\) return true/.test(session)) fail('fail-open return true must be gone');
if (!session.includes("return 'unknown'")) fail('unknown status');
if (!session.includes('interpretActiveDeviceQuery')) fail('pure interpreter');
const access = read('lib/deviceAccess.ts');
if (!access.includes("return 'unknown'")) fail('interpreter unknown');

const protectedUi = read('components/Protected.tsx');
if (protectedUi.includes('setDeviceOk(true)')) fail('must not coerce missing device id to allowed');
if (!protectedUi.includes("status === 'denied'")) fail('denied signs out');
if (!protectedUi.includes("status === 'unknown'")) fail('unknown branch');
if (!protectedUi.includes('auth.deviceCheckUnknown')) fail('unknown copy');
if (!protectedUi.includes('auth.deviceCheckRetry')) fail('retry button');
if (!protectedUi.includes("setDeviceAccess('pending')")) fail('retry must re-run check');
if (protectedUi.includes('signOut') && !protectedUi.includes("status === 'denied'")) {
  fail('signOut only on denied');
}
if (!protectedUi.includes('if (entered) return <>{children}</>')) fail('keep tree on profile flicker');
if (!protectedUi.includes("deviceAccess === 'allowed'")) fail('enter only when allowed');

const ensure = read('lib/useEnsureActiveDevice.ts');
if (!ensure.includes("status === 'denied'")) fail('ensure denied');
if (!ensure.includes("status === 'unknown'")) fail('ensure unknown');
if (!ensure.includes('auth.deviceCheckUnknown')) fail('ensure unknown alert');
if (/if \(!ok\) \{\s*signOut/.test(ensure)) fail('ensure must not signOut on any false');

const i18n = read('lib/i18n.tsx');
if (!i18n.includes("'auth.deviceCheckUnknown': 'Не удалось проверить устройство")) fail('i18n ru');
if (!i18n.includes("'auth.deviceCheckUnknown': 'Құрылғыны тексеру мүмкін болмады")) fail('i18n kz');
if (!i18n.includes("'auth.deviceCheckRetry': 'Повторить проверку'")) fail('retry ru');
if (!i18n.includes("'auth.deviceCheckRetry': 'Тексеруді қайталау'")) fail('retry kz');

const persist = read('scripts/check-ui-persist.ts');
if (!persist.includes("if (entered) return <>{children}</>")) fail('persist checker still expects entered');

console.log('active-device checks ok');
