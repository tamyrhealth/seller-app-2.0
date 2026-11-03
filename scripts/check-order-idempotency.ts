import { runExclusive } from '../lib/exclusiveAsync';
import {
  buildClientOrderFingerprint,
  getOrCreateOrderIdempotencyKey,
  getTabOrderIdempotencySnapshot,
  invalidateOrderIdempotencyKey,
  markOrderIdempotencyConfirmed,
  releaseConfirmedOrderAttempt,
  runConfirmOrderOnce,
} from '../lib/orderIdempotency';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function makeStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem(k) {
      return store[k] ?? null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
    clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
    key() {
      return null;
    },
    get length() {
      return Object.keys(store).length;
    },
  };
}

const local = makeStorage();

function installTab(session: Storage) {
  const win = { localStorage: local, sessionStorage: session };
  (globalThis as { localStorage?: Storage; sessionStorage?: Storage; window?: typeof win }).localStorage = local;
  (globalThis as { sessionStorage?: Storage }).sessionStorage = session;
  (globalThis as { window?: typeof win }).window = win;
}

const base = {
  actorUserId: 'user-a',
  sellerId: 's1',
  cityId: 'c1',
  isPreorder: false,
  isDebt: false,
  paymentType: 'cash' as string | null,
  comment: 'hello',
  pickupDate: null as string | null,
  debtCustomerPhone: null as string | null,
  debtCustomerName: null as string | null,
  debtDueAt: null as string | null,
  debtNote: null as string | null,
  items: [
    { product_id: 'b', qty: 1.5, price: '100' },
    { product_id: 'a', qty: 2, price: '10' },
  ],
};

const fp1 = buildClientOrderFingerprint(base);
const fp2 = buildClientOrderFingerprint({
  ...base,
  items: [...base.items].reverse(),
});
if (fp1 !== fp2) fail('fingerprint must ignore item order');

const fpComment = buildClientOrderFingerprint({ ...base, comment: 'other' });
if (fp1 === fpComment) fail('comment must be part of fingerprint');

const fpDebt = buildClientOrderFingerprint({
  ...base,
  isDebt: true,
  paymentType: 'debt',
  comment: null,
  debtCustomerPhone: '77001112233',
  debtCustomerName: 'A',
  debtDueAt: '2026-11-10',
  debtNote: 'n',
});
if (fp1 === fpDebt) fail('debt fingerprint must differ');

const fpDebtPhone = buildClientOrderFingerprint({
  ...base,
  isDebt: true,
  paymentType: 'debt',
  comment: null,
  debtCustomerPhone: '77000000000',
  debtCustomerName: 'A',
  debtDueAt: '2026-11-10',
  debtNote: 'n',
});
if (fpDebt === fpDebtPhone) fail('debt phone must be part of fingerprint');

const fpActor = buildClientOrderFingerprint({ ...base, actorUserId: 'user-b' });
if (fp1 === fpActor) fail('actor must be part of fingerprint');

const tabA = makeStorage();
const tabB = makeStorage();
installTab(tabA);
const k1 = getOrCreateOrderIdempotencyKey('user-a', fp1);
const k1b = getOrCreateOrderIdempotencyKey('user-a', fp1);
if (k1 !== k1b) fail('pending retry in same tab must reuse key');

installTab(tabB);
const k2 = getOrCreateOrderIdempotencyKey('user-a', fp1);
if (k2 !== k1) fail('second tab must reuse shared pending key for the same in-flight cart');

markOrderIdempotencyConfirmed('user-a', k2, 'order-shared');
installTab(tabA);
const k1c = getOrCreateOrderIdempotencyKey('user-a', fp1);
if (k1c !== k1) fail('pending tab must keep key after other tab confirms the same operation');

markOrderIdempotencyConfirmed('user-a', k1, 'order-shared');
const kConfirmed = getOrCreateOrderIdempotencyKey('user-a', fp1);
if (kConfirmed !== k1) fail('confirmed success must not rotate key until release');

releaseConfirmedOrderAttempt('user-a');
const k3 = getOrCreateOrderIdempotencyKey('user-a', fp1);
if (k3 === k1) fail('new identical order after release must get a new key');

const kUserB = getOrCreateOrderIdempotencyKey('user-b', fp1);
if (kUserB === k3) fail('another user in same tab must not reuse previous user key');

invalidateOrderIdempotencyKey('user-b', kUserB);
const kUserB2 = getOrCreateOrderIdempotencyKey('user-b', fp1);
if (kUserB2 === kUserB) fail('invalidated key must not be reused');

const snap = getTabOrderIdempotencySnapshot();
if (!snap || snap.key !== kUserB2 || snap.status !== 'pending') fail('snapshot must restore pending op after writes');

function totalQtyByProductId(items: { product_id: string; qty: number }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.product_id, (totals.get(item.product_id) ?? 0) + Number(item.qty));
  }
  return totals;
}

const dupLines = [
  { product_id: 'sku-a', qty: 5, price: '100' },
  { product_id: 'sku-a', qty: 5, price: '0' },
];
if (totalQtyByProductId(dupLines).get('sku-a') !== 10) {
  fail('duplicate product_id lines must be summed before stock check');
}
if ((totalQtyByProductId(dupLines).get('sku-a') ?? 0) <= 8) {
  fail('stock 8 must be insufficient for two lines of 5');
}

const fpDupLines = buildClientOrderFingerprint({ ...base, items: dupLines });
const fpMergedLine = buildClientOrderFingerprint({
  ...base,
  items: [{ product_id: 'sku-a', qty: 10, price: '100' }],
});
if (fpDupLines === fpMergedLine) {
  fail('two order lines must not collapse into one fingerprint');
}

void (async () => {
  let executeCount = 0;
  const slowConfirm = () =>
    runConfirmOrderOnce('user-race', fp1, async () => {
      executeCount += 1;
      await new Promise((r) => setTimeout(r, 30));
      return 'order-race';
    });
  const [r1, r2, r3] = await Promise.all([slowConfirm(), slowConfirm(), slowConfirm()]);
  if (executeCount !== 1) fail(`overlapping confirm must execute once, got ${executeCount}`);
  if (r1 !== 'order-race' || r2 !== r1 || r3 !== r1) fail('overlapping confirm must return the same order id');

  const afterSuccess = await runConfirmOrderOnce('user-race', fp1, async () => {
    executeCount += 1;
    return 'order-should-not-create';
  });
  if (afterSuccess !== 'order-race') fail('retry after success without release must return existing order');
  if (executeCount !== 1) fail('retry after success must not call confirm_order again');

  releaseConfirmedOrderAttempt('user-race');
  const fresh = await runConfirmOrderOnce('user-race', fp1, async () => 'order-fresh');
  if (fresh !== 'order-fresh') fail('after release a new confirm must be a new operation');

  const timeoutUser = 'user-timeout';
  const timeoutKeyBefore = getOrCreateOrderIdempotencyKey(timeoutUser, fp1);
  try {
    await runConfirmOrderOnce(timeoutUser, fp1, async () => {
      throw new Error('network timeout');
    });
    fail('timeout execute must throw');
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'network timeout') fail('unexpected timeout error');
  }
  const timeoutSnap = getTabOrderIdempotencySnapshot();
  if (!timeoutSnap || timeoutSnap.key !== timeoutKeyBefore || timeoutSnap.status !== 'pending') {
    fail('timeout must keep pending idempotency key');
  }
  const timeoutRetryKey = getOrCreateOrderIdempotencyKey(timeoutUser, fp1);
  if (timeoutRetryKey !== timeoutKeyBefore) fail('retry after timeout must reuse the same key');

  const persisted = local.getItem('seller-app:order-idempotency:v3');
  const tabId = tabA.getItem('seller-app:order-idempotency-tab');
  const reloadedSession = makeStorage();
  if (tabId) reloadedSession.setItem('seller-app:order-idempotency-tab', tabId);
  installTab(reloadedSession);
  if (persisted) local.setItem('seller-app:order-idempotency:v3', persisted);
  const afterReload = getOrCreateOrderIdempotencyKey(timeoutUser, fp1);
  if (afterReload !== timeoutKeyBefore) fail('reload must restore pending idempotency key');

  const timeoutOrder = await runConfirmOrderOnce(timeoutUser, fp1, async (key) => {
    if (key !== timeoutKeyBefore) fail('reload retry must send the original key');
    return 'order-after-timeout';
  });
  if (timeoutOrder !== 'order-after-timeout') fail('retry after timeout must confirm once');
  releaseConfirmedOrderAttempt(timeoutUser);
  const secondIntent = getOrCreateOrderIdempotencyKey(timeoutUser, fp1);
  if (secondIntent === timeoutKeyBefore) fail('new intentional order after confirmed completion must get a new key');

  let exclusiveCount = 0;
  const exclusiveJob = () =>
    runExclusive('restock:demo', async () => {
      exclusiveCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      return 'ok';
    });
  await Promise.all([exclusiveJob(), exclusiveJob(), exclusiveJob()]);
  if (exclusiveCount !== 1) fail(`exclusive restock must run once, got ${exclusiveCount}`);

  console.log('OK');
})().catch((err) => fail(err instanceof Error ? err.message : String(err)));
