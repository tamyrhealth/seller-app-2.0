const STORE_KEY = 'seller-app:order-idempotency:v2';
const TAB_KEY = 'seller-app:order-idempotency-tab';
const LEGACY_KEY = 'seller-app:order-idempotency';

export type OrderIdempotencyItem = {
  product_id: string;
  qty: number;
  price: string;
  is_gift?: boolean;
};

export type OrderIdempotencyInput = {
  actorUserId: string;
  sellerId: string;
  cityId: string;
  isPreorder: boolean;
  isDebt: boolean;
  paymentType: string | null;
  comment: string | null;
  pickupDate: string | null;
  debtCustomerPhone: string | null;
  debtCustomerName: string | null;
  debtDueAt: string | null;
  debtNote: string | null;
  items: OrderIdempotencyItem[];
};

type Op = {
  key: string;
  fingerprint: string;
  userId: string;
  status: 'pending' | 'confirmed';
  orderId?: string;
};

type Store = {
  ops: Record<string, Op>;
};

function normText(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

export function buildClientOrderFingerprint(input: OrderIdempotencyInput): string {
  const items = [...input.items]
    .map((item) => ({
      product_id: item.product_id,
      qty: Number(Number(item.qty).toFixed(3)),
      price: String(item.price ?? ''),
      is_gift: item.is_gift === true,
    }))
    .sort(
      (a, b) =>
        a.product_id.localeCompare(b.product_id) ||
        Number(a.is_gift) - Number(b.is_gift) ||
        a.qty - b.qty ||
        a.price.localeCompare(b.price)
    );
  return JSON.stringify({
    actor_id: input.actorUserId,
    seller_id: input.sellerId,
    city_id: input.cityId,
    is_preorder: input.isPreorder,
    is_debt: input.isDebt,
    payment_type: input.paymentType ?? '',
    comment: normText(input.comment),
    pickup_date: input.isPreorder ? normText(input.pickupDate) : '',
    debt_customer_phone: input.isDebt ? normText(input.debtCustomerPhone) : '',
    debt_customer_name: input.isDebt ? normText(input.debtCustomerName) : '',
    debt_due_at: input.isDebt ? normText(input.debtDueAt) : '',
    debt_note: input.isDebt ? normText(input.debtNote) : '',
    items,
  });
}

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
  try {
    local?.removeItem(LEGACY_KEY);
  } catch {
    /* ignore quota / private mode */
  }
  if (!local) return { ops: {} };
  try {
    const raw = local.getItem(STORE_KEY);
    if (!raw) return { ops: {} };
    const parsed = JSON.parse(raw) as Store;
    if (!parsed?.ops || typeof parsed.ops !== 'object') return { ops: {} };
    return parsed;
  } catch {
    return { ops: {} };
  }
}

function writeStore(store: Store) {
  const local = storageOf('localStorage');
  if (!local) return;
  local.setItem(STORE_KEY, JSON.stringify(store));
}

function writeTabOp(op: Op) {
  const tabId = getTabId();
  const store = readStore();
  store.ops[tabId] = op;
  writeStore(store);
}

function readTabOp(): Op | null {
  const store = readStore();
  const op = store.ops[getTabId()];
  if (!op?.key || !op.fingerprint || !op.userId) return null;
  return op;
}

export function getOrCreateOrderIdempotencyKey(userId: string, fingerprint: string): string {
  const op = readTabOp();
  if (op && op.userId === userId && op.fingerprint === fingerprint && op.status === 'pending') {
    return op.key;
  }
  const key = crypto.randomUUID();
  writeTabOp({ key, fingerprint, userId, status: 'pending' });
  return key;
}

export function markOrderIdempotencyConfirmed(userId: string, key: string, orderId: string) {
  const op = readTabOp();
  if (!op || op.userId !== userId || op.key !== key) return;
  writeTabOp({ ...op, status: 'confirmed', orderId });
}

export function invalidateOrderIdempotencyKey(userId: string, key: string) {
  const tabId = getTabId();
  const store = readStore();
  const op = store.ops[tabId];
  if (!op || op.userId !== userId || op.key !== key) return;
  delete store.ops[tabId];
  writeStore(store);
}

export function getTabOrderIdempotencySnapshot(): Op | null {
  return readTabOp();
}
