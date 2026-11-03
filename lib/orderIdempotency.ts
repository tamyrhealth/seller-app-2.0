const STORE_KEY = 'seller-app:order-idempotency:v3';
const TAB_KEY = 'seller-app:order-idempotency-tab';
const LEGACY_KEYS = ['seller-app:order-idempotency', 'seller-app:order-idempotency:v2'];

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
  tabs: Record<string, Op>;
  sharedPending: Op | null;
};

const inflightByUser = new Map<string, Promise<string>>();

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

function emptyStore(): Store {
  return { tabs: {}, sharedPending: null };
}

function readStore(): Store {
  const local = storageOf('localStorage');
  for (const legacy of LEGACY_KEYS) {
    try {
      local?.removeItem(legacy);
    } catch {
      /* ignore */
    }
  }
  if (!local) return emptyStore();
  try {
    const raw = local.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return {
      tabs: parsed.tabs && typeof parsed.tabs === 'object' ? parsed.tabs : {},
      sharedPending: parsed.sharedPending ?? null,
    };
  } catch {
    return emptyStore();
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
  store.tabs[tabId] = op;
  if (op.status === 'pending') {
    store.sharedPending = op;
  } else if (store.sharedPending?.key === op.key) {
    store.sharedPending = op;
  }
  writeStore(store);
}

function readTabOp(): Op | null {
  const store = readStore();
  const op = store.tabs[getTabId()];
  if (!op?.key || !op.fingerprint || !op.userId) return null;
  return op;
}

export function getOrCreateOrderIdempotencyKey(userId: string, fingerprint: string): string {
  const tabOp = readTabOp();
  if (tabOp && tabOp.userId === userId) {
    if (tabOp.status === 'pending') return tabOp.key;
    if (tabOp.status === 'confirmed' && tabOp.fingerprint === fingerprint && tabOp.orderId) {
      return tabOp.key;
    }
  }

  const shared = readStore().sharedPending;
  if (
    shared?.userId === userId &&
    shared.status === 'pending' &&
    shared.fingerprint === fingerprint &&
    shared.key
  ) {
    writeTabOp(shared);
    return shared.key;
  }

  const key = crypto.randomUUID();
  writeTabOp({ key, fingerprint, userId, status: 'pending' });
  return key;
}

export function markOrderIdempotencyConfirmed(userId: string, key: string, orderId: string) {
  const op = readTabOp();
  if (!op || op.userId !== userId || op.key !== key) {
    writeTabOp({
      key,
      fingerprint: op?.fingerprint ?? '',
      userId,
      status: 'confirmed',
      orderId,
    });
    return;
  }
  writeTabOp({ ...op, status: 'confirmed', orderId });
}

export function invalidateOrderIdempotencyKey(userId: string, key: string) {
  const tabId = getTabId();
  const store = readStore();
  const op = store.tabs[tabId];
  if (op && op.userId === userId && op.key === key) {
    delete store.tabs[tabId];
  }
  if (store.sharedPending?.userId === userId && store.sharedPending.key === key) {
    store.sharedPending = null;
  }
  writeStore(store);
}

export function releaseConfirmedOrderAttempt(userId: string) {
  const tabId = getTabId();
  const store = readStore();
  const op = store.tabs[tabId];
  if (op && op.userId === userId && op.status === 'confirmed') {
    delete store.tabs[tabId];
  }
  if (store.sharedPending?.userId === userId && store.sharedPending.status === 'confirmed') {
    store.sharedPending = null;
  }
  writeStore(store);
}

export function getTabOrderIdempotencySnapshot(): Op | null {
  return readTabOp();
}

/**
 * One user-facing confirm = one promise and one key.
 * Overlapping clicks join the in-flight call.
 * After success, a same-fingerprint retry returns the existing order id
 * until releaseConfirmedOrderAttempt (empty cart / new attempt).
 */
export function runConfirmOrderOnce(
  userId: string,
  fingerprint: string,
  execute: (idempotencyKey: string) => Promise<string>
): Promise<string> {
  const existing = inflightByUser.get(userId);
  if (existing) return existing;

  const started = (async () => {
    const op = readTabOp();
    if (op?.userId === userId && op.status === 'confirmed' && op.orderId && op.fingerprint === fingerprint) {
      return op.orderId;
    }
    if (op?.userId === userId && op.status === 'confirmed' && op.fingerprint !== fingerprint) {
      releaseConfirmedOrderAttempt(userId);
    }
    const key = getOrCreateOrderIdempotencyKey(userId, fingerprint);
    const orderId = await execute(key);
    if (!orderId) {
      throw new Error('confirm_order returned empty id');
    }
    markOrderIdempotencyConfirmed(userId, key, orderId);
    return orderId;
  })().finally(() => {
    if (inflightByUser.get(userId) === started) inflightByUser.delete(userId);
  });

  inflightByUser.set(userId, started);
  return started;
}
