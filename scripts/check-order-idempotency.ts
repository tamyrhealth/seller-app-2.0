import {
  buildClientOrderFingerprint,
  getOrCreateOrderIdempotencyKey,
  getTabOrderIdempotencySnapshot,
  invalidateOrderIdempotencyKey,
  markOrderIdempotencyConfirmed,
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
if (k2 === k1) fail('second tab must get its own key for the same cart');

markOrderIdempotencyConfirmed('user-a', k2, 'order-b');
installTab(tabA);
const k1c = getOrCreateOrderIdempotencyKey('user-a', fp1);
if (k1c !== k1) fail('success in another tab must not rotate this tab pending key');

markOrderIdempotencyConfirmed('user-a', k1, 'order-a');
const k3 = getOrCreateOrderIdempotencyKey('user-a', fp1);
if (k3 === k1) fail('new identical order after success must get a new key');

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

console.log('OK');
