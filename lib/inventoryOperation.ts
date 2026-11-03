const STORE_KEY = 'seller-app:inventory-op:v1';
const TAB_KEY = 'seller-app:inventory-op-tab';

export type InventoryOpKind =
  | 'restock'
  | 'adjust'
  | 'transfer_create'
  | 'transfer_receive'
  | 'transfer_cancel'
  | 'transfer_writeoff';

type Kind = InventoryOpKind;

type Op = {
  key: string;
  kind: Kind;
  fingerprint: string;
  status: 'pending' | 'confirmed';
};

type Store = {
  tabs: Record<string, Op>;
};

const inflight = new Map<string, Promise<unknown>>();

function storageOf(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function getTabId(): string {
  const session = storageOf('sessionStorage');
  const existing = session?.getItem(TAB_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  session?.setItem(TAB_KEY, id);
  return id;
}

function readStore(): Store {
  const local = storageOf('localStorage');
  if (!local) return { tabs: {} };
  try {
    const raw = local.getItem(STORE_KEY);
    if (!raw) return { tabs: {} };
    const parsed = JSON.parse(raw) as Store;
    if (!parsed?.tabs || typeof parsed.tabs !== 'object') return { tabs: {} };
    return parsed;
  } catch {
    return { tabs: {} };
  }
}

function writeStore(store: Store) {
  const local = storageOf('localStorage');
  if (!local) return;
  local.setItem(STORE_KEY, JSON.stringify(store));
}

function readOp(): Op | null {
  const op = readStore().tabs[getTabId()];
  if (!op?.key || !op.fingerprint || !op.kind) return null;
  return op;
}

function writeOp(op: Op) {
  const store = readStore();
  store.tabs[getTabId()] = op;
  writeStore(store);
}

export function inventoryRestockFingerprint(cityId: string, productId: string, qty: number): string {
  return JSON.stringify({ kind: 'restock', cityId, productId, qty: Number(qty.toFixed(3)) });
}

export function inventoryAdjustFingerprint(cityId: string, productId: string, newQty: number): string {
  return JSON.stringify({ kind: 'adjust', cityId, productId, qty: Number(newQty.toFixed(3)) });
}

function roundQty(qty: number): number {
  return Number(qty.toFixed(3));
}

export function transferCreateFingerprint(
  fromCityId: string,
  toCityId: string,
  items: Array<{ product_id: string; qty: number }>,
  comment: string
): string {
  const normalized = [...items]
    .map((i) => ({ product_id: i.product_id, qty: roundQty(i.qty) }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
  return JSON.stringify({
    kind: 'transfer_create',
    fromCityId,
    toCityId,
    items: normalized,
    comment: comment.trim(),
  });
}

export function transferReceiveFingerprint(
  transferId: string,
  items: Array<{ product_id: string; qty_received: number }>
): string {
  const normalized = [...items]
    .map((i) => ({ product_id: i.product_id, qty_received: roundQty(i.qty_received) }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
  return JSON.stringify({ kind: 'transfer_receive', transferId, items: normalized });
}

export function transferCancelFingerprint(transferId: string, reason: string): string {
  return JSON.stringify({ kind: 'transfer_cancel', transferId, reason: reason.trim() });
}

export function transferWriteOffFingerprint(
  transferId: string,
  items: Array<{ product_id: string; qty: number }>,
  reason: string
): string {
  const normalized = [...items]
    .map((i) => ({ product_id: i.product_id, qty: roundQty(i.qty) }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
  return JSON.stringify({
    kind: 'transfer_writeoff',
    transferId,
    items: normalized,
    reason: reason.trim(),
  });
}

export function getOrCreateInventoryOperationId(kind: Kind, fingerprint: string): string {
  const op = readOp();
  if (op && op.kind === kind && op.fingerprint === fingerprint && op.status === 'pending') {
    return op.key;
  }
  const key = crypto.randomUUID();
  writeOp({ key, kind, fingerprint, status: 'pending' });
  return key;
}

export function markInventoryOperationConfirmed(key: string) {
  const op = readOp();
  if (!op || op.key !== key) return;
  writeOp({ ...op, status: 'confirmed' });
}

export function runInventoryOperationOnce<T>(
  kind: Kind,
  fingerprint: string,
  execute: (operationId: string) => Promise<T>
): Promise<T> {
  const gate = `${kind}:${fingerprint}`;
  const existing = inflight.get(gate);
  if (existing) return existing as Promise<T>;

  const started = (async () => {
    const operationId = getOrCreateInventoryOperationId(kind, fingerprint);
    const result = await execute(operationId);
    markInventoryOperationConfirmed(operationId);
    return result;
  })().finally(() => {
    if (inflight.get(gate) === started) inflight.delete(gate);
  });

  inflight.set(gate, started);
  return started;
}
