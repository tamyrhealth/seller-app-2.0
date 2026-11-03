import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getOrCreateInventoryOperationId,
  markInventoryOperationConfirmed,
  runInventoryOperationOnce,
  transferCancelFingerprint,
  transferCreateFingerprint,
  transferReceiveFingerprint,
} from '../lib/inventoryOperation';
import { mapTransferRpcError, transferStatusLabel } from '../lib/stockTransfer';

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
  items: Array<{ product: string; sent: number; received: number | null }>;
  cancelCount: number;
  receiveCount: number;
  ops: Map<string, { kind: string; payload: string; result: string }>;
};

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
    items: lines.map((l) => ({ product: l.product, sent: l.qty, received: null })),
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
      if (tr.status === 'received' || tr.status === 'received_with_variance') return tr.status;
      let variance = false;
      for (const item of tr.items) {
        const qty = got.find((g) => g.product === item.product)?.qty ?? 0;
        if (qty > item.sent) throw new Error('Received qty exceeds sent qty');
        if (qty !== item.sent) variance = true;
        item.received = qty;
        if (qty > 0) add(tr.to, item.product, qty);
      }
      tr.receiveCount += 1;
      tr.status = variance ? 'received_with_variance' : 'received';
      return tr.status;
    })
  );
}

async function cancelTransfer(tr: Transfer, opId: string, reason: string): Promise<string> {
  const payload = reason;
  return withTransferLock(tr.id, () =>
    applyOp(tr, opId, 'cancel', payload, () => {
      if (tr.status === 'received' || tr.status === 'received_with_variance') {
        throw new Error('Received transfer cannot be cancelled');
      }
      if (tr.status === 'cancelled') return 'cancelled';
      for (const item of tr.items) add(tr.from, item.product, item.sent);
      tr.cancelCount += 1;
      tr.status = 'cancelled';
      return 'cancelled';
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
  const partialTr = await createTransfer('T2', 'op-c2', 'A', 'B', [{ product: 'powder', qty: 50 }], '');
  const partial = await receiveTransfer(partialTr, 'op-r2', [{ product: 'powder', qty: 48 }]);
  if (partial !== 'received_with_variance') fail('partial receive status');
  if (get('B', 'powder') !== 148) fail('partial receive credits only received qty');
  if (get('A', 'powder') !== 0) fail('variance must not return to origin');

  add('A', 'powder', 20);
  const cancelTr = await createTransfer('T3', 'op-c3', 'A', 'B', [{ product: 'powder', qty: 20 }], '');
  await cancelTransfer(cancelTr, 'op-x3', 'mistake');
  if (get('A', 'powder') !== 20) fail('cancel must restore origin once');
  await cancelTransfer(cancelTr, 'op-x3', 'mistake');
  await cancelTransfer(cancelTr, 'op-x3b', 'other');
  if (cancelTr.cancelCount !== 1) fail('repeat cancel must not restore twice');
  if (get('A', 'powder') !== 20) fail('repeat cancel stock');

  const race = await createTransfer('T4', 'op-c4', 'A', 'B', [{ product: 'powder', qty: 10 }], '');
  if (get('A', 'powder') !== 10) fail('race setup origin');
  const raceRecv = receiveTransfer(race, 'op-r4', [{ product: 'powder', qty: 10 }]);
  const raceCancel = cancelTransfer(race, 'op-x4', 'race');
  const settled = await Promise.allSettled([raceRecv, raceCancel]);
  const fulfilled = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<string>[];
  const rejected = settled.filter((s) => s.status === 'rejected');
  if (fulfilled.length !== 1 || rejected.length !== 1) {
    fail('local lock: exactly one of concurrent receive/cancel should succeed');
  }
  if (race.status === 'received') {
    if (get('B', 'powder') !== 158) fail('race receive destination');
    if (get('A', 'powder') !== 10) fail('race receive must not restore origin');
  } else if (race.status === 'cancelled') {
    if (get('A', 'powder') !== 20) fail('race cancel restore');
    if (get('B', 'powder') !== 148) fail('race cancel must not credit dest');
  } else {
    fail(`unexpected race status ${race.status}`);
  }

  if (transferCancelFingerprint('t', 'a') === transferCancelFingerprint('t', 'b')) {
    fail('cancel reason must change fingerprint');
  }

  console.log('OK');
  console.log(
    'NOTE: concurrent receive/cancel here uses an in-process lock. It is not a check against a real Postgres database.'
  );
})().catch((err) => fail(err instanceof Error ? err.message : String(err)));
