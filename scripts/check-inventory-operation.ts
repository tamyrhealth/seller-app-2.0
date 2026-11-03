import {
  getOrCreateInventoryOperationId,
  inventoryAdjustFingerprint,
  inventoryRestockFingerprint,
  markInventoryOperationConfirmed,
  runInventoryOperationOnce,
} from '../lib/inventoryOperation';

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

const fpRestock = inventoryRestockFingerprint('city-1', 'prod-1', 5);
const fpRestockSame = inventoryRestockFingerprint('city-1', 'prod-1', 5.0);
if (fpRestock !== fpRestockSame) fail('restock fingerprint must normalize qty');
if (fpRestock === inventoryRestockFingerprint('city-1', 'prod-1', 6)) fail('qty must change fingerprint');
if (inventoryAdjustFingerprint('c', 'p', 0) === inventoryAdjustFingerprint('c', 'p', 1)) {
  fail('adjust fingerprint must include qty');
}

const id1 = getOrCreateInventoryOperationId('restock', fpRestock);
const id1b = getOrCreateInventoryOperationId('restock', fpRestock);
if (id1 !== id1b) fail('pending restock retry must reuse operation id');

markInventoryOperationConfirmed(id1);
const id2 = getOrCreateInventoryOperationId('restock', fpRestock);
if (id2 === id1) fail('intentional second restock after success must get a new operation id');

void (async () => {
  let n = 0;
  const fp = inventoryRestockFingerprint('city-2', 'prod-2', 3);
  const job = () =>
    runInventoryOperationOnce('restock', fp, async (operationId) => {
      n += 1;
      await new Promise((r) => setTimeout(r, 25));
      return operationId;
    });
  const [a, b, c] = await Promise.all([job(), job(), job()]);
  if (n !== 1) fail(`overlapping restock must execute once, got ${n}`);
  if (a !== b || b !== c) fail('overlapping restock must share operation id');

  try {
    await runInventoryOperationOnce('adjust', inventoryAdjustFingerprint('c', 'p', 2), async () => {
      throw new Error('network timeout');
    });
    fail('timeout must throw');
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'network timeout') fail('unexpected timeout error');
  }
  const timeoutFp = inventoryAdjustFingerprint('c', 'p', 2);
  const afterTimeout = getOrCreateInventoryOperationId('adjust', timeoutFp);
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
  const afterReload = getOrCreateInventoryOperationId('adjust', timeoutFp);
  if (afterReload !== afterTimeout) fail('reload after timeout must keep pending inventory operation id');

  console.log('OK');
})().catch((err) => fail(err instanceof Error ? err.message : String(err)));
