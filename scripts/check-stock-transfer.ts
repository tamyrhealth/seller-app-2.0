import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getOrCreateInventoryOperationId,
  markInventoryOperationConfirmed,
  runInventoryOperationOnce,
  transferCancelFingerprint,
  transferCreateFingerprint,
  transferReceiveFingerprint,
  transferWriteOffFingerprint,
} from '../lib/inventoryOperation';
import { mapTransferRpcError, transferRemaining, transferStatusLabel } from '../lib/stockTransfer';

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
const session = makeStorage();
const win = { localStorage: local, sessionStorage: session };
(globalThis as { localStorage?: Storage; sessionStorage?: Storage; window?: typeof win }).localStorage = local;
(globalThis as { sessionStorage?: Storage }).sessionStorage = session;
(globalThis as { window?: typeof win }).window = win;

const sql = readFileSync(join(process.cwd(), 'supabase', 'run_stock_transfers.sql'), 'utf8');
for (const needle of [
  'create_stock_transfer',
  'receive_stock_transfer',
  'cancel_stock_transfer',
  'client_operations',
  'FOR UPDATE',
  'Insufficient stock',
  'different payload',
  'transfer_out',
  'transfer_in',
  'transfer_cancel',
  'received_with_variance',
  'Only admin',
  'pg_advisory_xact_lock',
  'format_transfer_number',
  'stock_transfer_items_product_id_fkey',
  'stock_transfer_items_transfer_id_fkey',
  'REVOKE ALL ON FUNCTION public.stock_transfers_assign_number',
  'REVOKE ALL ON FUNCTION public.stock_transfer_fingerprint',
  'REVOKE ALL ON FUNCTION public.format_transfer_number',
]) {
  if (!sql.includes(needle)) fail(`SQL must contain ${needle}`);
}
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration must be one BEGIN/COMMIT transaction');
{
  const verify = readFileSync(join(process.cwd(), 'supabase', 'prod', 'post_apply_verify_block4.sql'), 'utf8').replace(/--[^\n]*/g, '');
  if (/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i.test(verify)) {
    fail('post_apply_verify_block4.sql must be SELECT-only');
  }
  if (!verify.includes('policyname')) fail('verify must use pg_policies.policyname');
}
const sqlPartial = readFileSync(
  join(process.cwd(), 'supabase', 'run_stock_transfer_partial_receive.sql'),
  'utf8'
);
for (const needle of [
  'write_off_stock_transfer_shortage',
  'qty_lost',
  'qty_returned',
  'stock_transfer_remaining',
  'Received qty exceeds remaining in transit',
  'Shortage reason is required',
  'v_inc',
]) {
  if (!sqlPartial.includes(needle)) fail(`partial SQL must contain ${needle}`);
}
if (/WHERE\s+transfer_number\s+IN\s*\(\s*'T000001'/i.test(sqlPartial)) {
  fail('partial SQL must not rewrite T000001 rows');
}
if (transferRemaining(50, 0, 0, 0) !== 50) fail('remaining of unreceived must stay in transit');
if (transferRemaining(50, 0, 0, 0) === 0) fail('unreceived must not be treated as lost');
if (/UPDATE\s+public\.cities\s+SET\s+is_active/i.test(sql)) fail('must not change cities.is_active');
if (/DELETE\s+FROM\s+public\.(cities|inventory|orders|products)/i.test(sql)) {
  fail('must not delete existing business rows');
}

if (transferStatusLabel('in_transit') !== 'В пути') fail('in_transit label');
if (transferStatusLabel('received_with_variance') !== 'Получено с расхождением') fail('variance label');
if (!mapTransferRpcError('Insufficient stock').includes('Недостаточно')) fail('shortage mapping');

const items = [
  { product_id: 'p2', qty: 1.5 },
  { product_id: 'p1', qty: 2 },
];
const fpCreate = transferCreateFingerprint('a', 'b', items, '  note  ');
const fpCreateSame = transferCreateFingerprint(
  'a',
  'b',
  [
    { product_id: 'p1', qty: 2.0 },
    { product_id: 'p2', qty: 1.5 },
  ],
  'note'
);
if (fpCreate !== fpCreateSame) fail('create fingerprint must normalize order, qty and comment');
if (fpCreate === transferCreateFingerprint('a', 'b', items, 'other')) fail('comment must change fingerprint');

const id1 = getOrCreateInventoryOperationId('transfer_create', fpCreate);
const id1b = getOrCreateInventoryOperationId('transfer_create', fpCreate);
if (id1 !== id1b) fail('pending create retry must reuse operation id');
markInventoryOperationConfirmed(id1);
const id2 = getOrCreateInventoryOperationId('transfer_create', fpCreate);
if (id2 === id1) fail('second create after success must get a new operation id');

type StockKey = string;
function key(city: string, product: string): StockKey {
  return `${city}:${product}`;
}

type Transfer = {
  id: string;
  status: 'in_transit' | 'received' | 'received_with_variance' | 'cancelled';
  from: string;
  to: string;
  items: Array<{ product: string; sent: number; received: number; lost: number; returned: number }>;
  cancelCount: number;
  receiveCount: number;
  ops: Map<string, { kind: string; payload: string; result: string }>;
};

function remainOf(item: Transfer['items'][number]) {
  return transferRemaining(item.sent, item.received, item.lost, item.returned);
}

function closeStatus(tr: Transfer) {
  const remain = tr.items.reduce((s, i) => s + remainOf(i), 0);
  const lost = tr.items.reduce((s, i) => s + i.lost, 0);
  const received = tr.items.reduce((s, i) => s + i.received, 0);
  if (remain > 0) return 'in_transit' as const;
  if (received === 0 && lost === 0) return 'cancelled' as const;
  if (lost > 0) return 'received_with_variance' as const;
  return 'received' as const;
}

const stock = new Map<StockKey, number>([
  [key('A', 'powder'), 100],
  [key('A', 'kg'), 10.5],
  [key('B', 'powder'), 0],
  [key('B', 'kg'), 0],
]);

function get(city: string, product: string) {
  return stock.get(key(city, product)) ?? 0;
}
function add(city: string, product: string, delta: number) {
  const next = Number((get(city, product) + delta).toFixed(3));
  if (next < 0) throw new Error('Insufficient stock');
  stock.set(key(city, product), next);
}

const transferLocks = new Map<string, Promise<void>>();
async function withTransferLock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = transferLocks.get(id) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prev.then(() => gate);
  transferLocks.set(
    id,
    queued.catch(() => undefined).then(() => undefined)
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function applyOp(tr: Transfer, opId: string, kind: string, payload: string, run: () => string): string {
  const existing = tr.ops.get(opId);
  if (existing) {
    if (existing.payload !== payload) throw new Error('Idempotency key reused with a different payload');
    return existing.result;
  }
  const result = run();
  tr.ops.set(opId, { kind, payload, result });
  return result;
}

async function createTransfer(
  id: string,
  opId: string,
  from: string,
  to: string,
  lines: Array<{ product: string; qty: number }>,
  comment: string
): Promise<Transfer> {
  if (from === to) throw new Error('Source and destination cities must differ');
  const payload = JSON.stringify({ from, to, lines, comment });
  const tr: Transfer = {
    id,
    status: 'in_transit',
    from,
    to,
    items: lines.map((l) => ({ product: l.product, sent: l.qty, received: 0, lost: 0, returned: 0 })),
    cancelCount: 0,
    receiveCount: 0,
    ops: new Map(),
  };
  applyOp(tr, opId, 'create', payload, () => {
    for (const line of lines) add(from, line.product, -line.qty);
    return 'in_transit';
  });
  return tr;
}

async function receiveTransfer(
  tr: Transfer,
  opId: string,
  got: Array<{ product: string; qty: number }>
): Promise<string> {
  const payload = JSON.stringify(got);
  return withTransferLock(tr.id, () =>
    applyOp(tr, opId, 'receive', payload, () => {
      if (tr.status === 'cancelled') throw new Error('Transfer is cancelled');
      const remainingTotal = tr.items.reduce((s, i) => s + remainOf(i), 0);
      if (remainingTotal <= 0) return tr.status;
      for (const item of tr.items) {
        const qty = got.find((g) => g.product === item.product)?.qty ?? 0;
        if (!qty) continue;
        const remain = remainOf(item);
        let inc = qty;
        if (qty > remain) inc = Number((qty - item.received).toFixed(3));
        if (inc < 0) throw new Error('Invalid qty');
        if (inc > remain) throw new Error('Received qty exceeds remaining in transit');
        if (!inc) continue;
        item.received += inc;
        add(tr.to, item.product, inc);
      }
      tr.receiveCount += 1;
      tr.status = closeStatus(tr);
      return tr.status;
    })
  );
}

async function cancelTransfer(tr: Transfer, opId: string, reason: string): Promise<string> {
  const payload = reason;
  return withTransferLock(tr.id, () =>
    applyOp(tr, opId, 'cancel', payload, () => {
      const remainingTotal = tr.items.reduce((s, i) => s + remainOf(i), 0);
      if (tr.status === 'cancelled') return 'cancelled';
      if (remainingTotal <= 0) throw new Error('Received transfer cannot be cancelled');
      for (const item of tr.items) {
        const remain = remainOf(item);
        if (remain <= 0) continue;
        add(tr.from, item.product, remain);
        item.returned += remain;
      }
      tr.cancelCount += 1;
      tr.status = closeStatus(tr);
      return tr.status;
    })
  );
}

void (async () => {
  let n = 0;
  const fp = transferCreateFingerprint('A', 'B', [{ product_id: 'p', qty: 3.125 }], '');
  const job = () =>
    runInventoryOperationOnce('transfer_create', fp, async (operationId) => {
      n += 1;
      await new Promise((r) => setTimeout(r, 20));
      return operationId;
    });
  const [a, b, c] = await Promise.all([job(), job(), job()]);
  if (n !== 1) fail(`overlapping create must execute once, got ${n}`);
  if (a !== b || b !== c) fail('overlapping create must share operation id');

  try {
    await runInventoryOperationOnce(
      'transfer_receive',
      transferReceiveFingerprint('t1', [{ product_id: 'p', qty_received: 1 }]),
      async () => {
        throw new Error('network timeout');
      }
    );
    fail('timeout must throw');
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'network timeout') fail('unexpected timeout error');
  }
  const timeoutFp = transferReceiveFingerprint('t1', [{ product_id: 'p', qty_received: 1 }]);
  const afterTimeout = getOrCreateInventoryOperationId('transfer_receive', timeoutFp);
  const persisted = local.getItem('seller-app:inventory-op:v1');
  const tabId = session.getItem('seller-app:inventory-op-tab');
  const session2 = makeStorage();
  if (tabId) session2.setItem('seller-app:inventory-op-tab', tabId);
  (globalThis as { sessionStorage?: Storage }).sessionStorage = session2;
  (globalThis as { window?: { localStorage: Storage; sessionStorage: Storage } }).window = {
    localStorage: local,
    sessionStorage: session2,
  };
  if (persisted) local.setItem('seller-app:inventory-op:v1', persisted);
  const afterReload = getOrCreateInventoryOperationId('transfer_receive', timeoutFp);
  if (afterReload !== afterTimeout) fail('reload after timeout must keep pending receive operation id');

  const multi = await createTransfer(
    'T1',
    'op-create-1',
    'A',
    'B',
    [
      { product: 'powder', qty: 100 },
      { product: 'kg', qty: 1.25 },
    ],
    ''
  );
  if (get('A', 'powder') !== 0) fail('create must deduct origin powder');
  if (get('B', 'powder') !== 0) fail('create must not credit destination');
  if (get('A', 'kg') !== 9.25) fail('create must deduct fractional kg');

  try {
    await createTransfer('T-short', 'op-short', 'A', 'B', [{ product: 'powder', qty: 1 }], '');
    fail('shortage must throw');
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'Insufficient stock') fail('expected shortage');
  }

  const full = await receiveTransfer(multi, 'op-recv-1', [
    { product: 'powder', qty: 100 },
    { product: 'kg', qty: 1.25 },
  ]);
  if (full !== 'received') fail('full receive status');
  if (get('B', 'powder') !== 100) fail('full receive must credit destination');
  await receiveTransfer(multi, 'op-recv-1', [
    { product: 'powder', qty: 100 },
    { product: 'kg', qty: 1.25 },
  ]);
  if (get('B', 'powder') !== 100) fail('same operation receive must not credit twice');
  await receiveTransfer(multi, 'op-recv-2', [
    { product: 'powder', qty: 100 },
    { product: 'kg', qty: 1.25 },
  ]);
  if (multi.receiveCount !== 1) fail('second receive operation must not apply stock again');
  try {
    await cancelTransfer(multi, 'op-cancel-late', 'late');
    fail('received cancel must throw');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('cannot be cancelled')) fail('expected cancel guard');
  }

  add('A', 'powder', 50);
  add('A', 'tea', 25);
  const destPowderBeforeLike = get('B', 'powder');
  const likeT1 = await createTransfer(
    'T-like-1',
    'op-c-like',
    'A',
    'B',
    [
      { product: 'tea', qty: 25 },
      { product: 'powder', qty: 50 },
    ],
    ''
  );
  const firstLeg = await receiveTransfer(likeT1, 'op-r-like-1', [{ product: 'tea', qty: 25 }]);
  if (firstLeg !== 'in_transit') fail('partial receive must stay in transit');
  if (get('B', 'tea') !== 25) fail('tea must arrive at destination');
  if (get('B', 'powder') !== destPowderBeforeLike) fail('unreceived powder must not credit destination');
  if (get('A', 'powder') !== 0) fail('unreceived powder must not return to origin');
  if (remainOf(likeT1.items.find((i) => i.product === 'powder')!) !== 50) {
    fail('unreceived powder must remain in transit');
  }
  const secondLeg = await receiveTransfer(likeT1, 'op-r-like-2', [
    { product: 'tea', qty: 25 },
    { product: 'powder', qty: 50 },
  ]);
  if (secondLeg !== 'received') fail('second receive must close as received');
  if (get('B', 'tea') !== 25) fail('already received tea must not credit twice');
  if (get('B', 'powder') !== destPowderBeforeLike + 50) fail('second receive must credit only new qty');

  add('A', 'tea', 25);
  add('A', 'powder', 50);
  const originTea = get('A', 'tea');
  const destTea = get('B', 'tea');
  const destPowder = get('B', 'powder');
  const cancelPartial = await createTransfer(
    'T-cancel-partial',
    'op-c-cp',
    'A',
    'B',
    [
      { product: 'tea', qty: 25 },
      { product: 'powder', qty: 50 },
    ],
    ''
  );
  await receiveTransfer(cancelPartial, 'op-r-cp', [{ product: 'tea', qty: 25 }]);
  const afterCancelPartial = await cancelTransfer(cancelPartial, 'op-x-cp', 'return rest');
  if (afterCancelPartial !== 'received') fail('return remaining after partial must close as received');
  if (get('B', 'tea') !== destTea + 25) fail('cancel remaining must keep dest tea');
  if (get('A', 'tea') !== originTea - 25) fail('cancel remaining must not restore received tea');
  if (get('A', 'powder') !== 50) fail('cancel remaining must restore only in-transit powder');
  if (get('B', 'powder') !== destPowder) fail('cancel remaining must not credit dest powder');

  add('A', 'powder', 50);
  const destBeforePartial = get('B', 'powder');
  const originBeforePartial = get('A', 'powder');
  const partialTr = await createTransfer('T2', 'op-c2', 'A', 'B', [{ product: 'powder', qty: 50 }], '');
  const partial = await receiveTransfer(partialTr, 'op-r2', [{ product: 'powder', qty: 48 }]);
  if (partial !== 'in_transit') fail('partial receive must not auto-close as lost');
  if (get('B', 'powder') !== destBeforePartial + 48) fail('partial receive credits only received qty');
  if (get('A', 'powder') !== originBeforePartial - 50) fail('partial remainder must not return to origin');
  await receiveTransfer(partialTr, 'op-r2b', [{ product: 'powder', qty: 2 }]);
  if (partialTr.status !== 'received') fail('remainder receive must fully close');

  add('A', 'powder', 20);
  const destBeforeLoss = get('B', 'powder');
  const originBeforeLoss = get('A', 'powder');
  const lossTr = await createTransfer('T-loss', 'op-c-loss', 'A', 'B', [{ product: 'powder', qty: 20 }], '');
  await receiveTransfer(lossTr, 'op-r-loss', [{ product: 'powder', qty: 18 }]);
  const woFp = transferWriteOffFingerprint(
    lossTr.id,
    [{ product_id: 'powder', qty: 2 }],
    'broken bag'
  );
  if (woFp === transferWriteOffFingerprint(lossTr.id, [{ product_id: 'powder', qty: 2 }], 'other')) {
    fail('write-off reason must change fingerprint');
  }
  applyOp(lossTr, 'op-wo', 'shortage', '2:broken bag', () => {
    const item = lossTr.items[0];
    item.lost += 2;
    lossTr.status = closeStatus(lossTr);
    return lossTr.status;
  });
  if (lossTr.status !== 'received_with_variance') fail('explicit shortage must close with variance');
  if (get('A', 'powder') !== originBeforeLoss - 20) fail('shortage must not restore origin');
  if (get('B', 'powder') !== destBeforeLoss + 18) fail('shortage must not credit destination');

  add('A', 'powder', 20);
  const originBeforeCancel = get('A', 'powder');
  const cancelTr = await createTransfer('T3', 'op-c3', 'A', 'B', [{ product: 'powder', qty: 20 }], '');
  await cancelTransfer(cancelTr, 'op-x3', 'mistake');
  if (get('A', 'powder') !== originBeforeCancel) fail('cancel must restore origin once');
  await cancelTransfer(cancelTr, 'op-x3', 'mistake');
  await cancelTransfer(cancelTr, 'op-x3b', 'other');
  if (cancelTr.cancelCount !== 1) fail('repeat cancel must not restore twice');
  if (get('A', 'powder') !== originBeforeCancel) fail('repeat cancel stock');

  const destBeforeRace = get('B', 'powder');
  const originBeforeRace = get('A', 'powder');
  const race = await createTransfer('T4', 'op-c4', 'A', 'B', [{ product: 'powder', qty: 10 }], '');
  if (get('A', 'powder') !== originBeforeRace - 10) fail('race setup origin');
  const raceRecv = receiveTransfer(race, 'op-r4', [{ product: 'powder', qty: 10 }]);
  const raceCancel = cancelTransfer(race, 'op-x4', 'race');
  const settled = await Promise.allSettled([raceRecv, raceCancel]);
  const fulfilled = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<string>[];
  const rejected = settled.filter((s) => s.status === 'rejected');
  if (fulfilled.length !== 1 || rejected.length !== 1) {
    fail('local lock: exactly one of concurrent receive/cancel should succeed');
  }
  if (race.status === 'received') {
    if (get('B', 'powder') !== destBeforeRace + 10) fail('race receive destination');
    if (get('A', 'powder') !== originBeforeRace - 10) fail('race receive must not restore origin');
  } else if (race.status === 'cancelled') {
    if (get('A', 'powder') !== originBeforeRace) fail('race cancel restore');
    if (get('B', 'powder') !== destBeforeRace) fail('race cancel must not credit dest');
  } else {
    fail(`unexpected race status ${race.status}`);
  }

  const legacy = await createTransfer('T-legacy', 'op-c-leg', 'A', 'B', [{ product: 'powder', qty: 5 }], '');
  await receiveTransfer(legacy, 'op-r-leg-a', [{ product: 'powder', qty: 0 }]);
  legacy.status = 'received_with_variance';
  legacy.items[0].received = 0;
  if (remainOf(legacy.items[0]) !== 5) fail('legacy variance with qty_lost 0 still has remaining');
  await receiveTransfer(legacy, 'op-r-leg-b', [{ product: 'powder', qty: 5 }]);
  if (String(legacy.status) !== 'received') fail('legacy remaining must be receivable without auto restock');

  if (transferCancelFingerprint('t', 'a') === transferCancelFingerprint('t', 'b')) {
    fail('cancel reason must change fingerprint');
  }

  console.log('OK');
  console.log(
    'NOTE: concurrent receive/cancel here uses an in-process lock. It is not a check against a real Postgres database.'
  );
})().catch((err) => fail(err instanceof Error ? err.message : String(err)));
