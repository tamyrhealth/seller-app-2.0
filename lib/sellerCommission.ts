export const SELLER_TARIFF_PLANS_LIST = 'admin_seller_tariff_plans_list';
export const SELLER_TARIFF_RATES_LIST = 'admin_seller_tariff_rates_list';
export const SELLER_TARIFF_RATE_SET = 'admin_seller_tariff_rate_set';
export const SELLER_TARIFF_ASSIGNMENTS_LIST = 'admin_seller_tariff_assignments_list';
export const SELLER_TARIFF_ASSIGN = 'admin_seller_tariff_assign';
export const SELLER_RATE_OVERRIDES_LIST = 'admin_seller_rate_overrides_list';
export const SELLER_RATE_OVERRIDE_SET = 'admin_seller_rate_override_set';
export const SELLER_MISSING_ACCRUALS_LIST = 'admin_seller_missing_accruals_list';
export const SELLER_UNACCRUED_ITEMS_LIST = 'admin_seller_unaccrued_items_list';
export const SELLER_ACCRUAL_CONSISTENCY = 'admin_seller_accrual_consistency_summary';
export const SELLER_ACCRUAL_RETRY_ITEM = 'admin_seller_accrual_retry_item';
export const SELLER_BALANCE = 'admin_seller_balance';
export const SELLER_BALANCES_LIST = 'admin_seller_balances_list';
export const SELLER_LEDGER_LIST = 'admin_seller_ledger_list';
export const SELLER_MY_BALANCE = 'seller_my_balance';
export const SELLER_MY_LEDGER = 'seller_my_ledger';
export const SELLER_CASH_PAYOUT = 'admin_seller_cash_payout';
export const SELLER_CASH_ADVANCE = 'admin_seller_cash_advance';
export const SELLER_GOODS_ISSUE = 'admin_seller_goods_issue';
export const SELLER_GOODS_ADVANCE = 'admin_seller_goods_advance';
export const SELLER_GOODS_RETURN = 'admin_seller_goods_return';
export const SELLER_GOODS_ISSUES_LIST = 'admin_seller_goods_issues_list';
export const SELLER_MY_GOODS_ISSUES = 'seller_my_goods_issues';

export type TariffPlan = {
  id: string;
  code: 'A' | 'B' | string;
  name: string;
  is_active: boolean;
};

export type TariffRateRow = {
  id: string;
  plan_id: string;
  product_id: string;
  amount_kzt: number;
  effective_from: string;
  effective_to: string | null;
};

export type TariffAssignmentRow = {
  id: string;
  seller_id: string;
  plan_id: string;
  effective_from: string;
  effective_to: string | null;
};

export type RateOverrideRow = {
  id: string;
  seller_id: string;
  product_id: string;
  amount_kzt: number;
  effective_from: string;
  effective_to: string | null;
};

export type SellerBalanceRow = {
  seller_id: string;
  display_name?: string | null;
  is_active?: boolean;
  accrued: number;
  reversed: number;
  paid: number;
  advances: number;
  goods: number;
  adjustments: number;
  balance: number;
};

export type SellerGoodsIssueItem = {
  id?: string;
  product_id: string;
  product_name?: string | null;
  qty: number;
  unit_credit_amount: number;
  line_credit_amount: number;
  cost_price_snapshot: number | null;
  line_cost_amount?: number | null;
};

export type SellerGoodsIssue = {
  id: string;
  issue_number: string;
  operation_id: string;
  seller_id: string;
  seller_name?: string | null;
  city_id: string;
  city_name?: string | null;
  credit_amount: number;
  cost_total: number;
  issue_kind: 'settlement' | 'advance' | string;
  ledger_id: string | null;
  reversed_at: string | null;
  reversal_of: string | null;
  actor_id: string | null;
  comment: string | null;
  created_at: string;
  status: 'issued' | 'returned' | 'return' | string;
  items: SellerGoodsIssueItem[];
};

export type UnaccruedCommissionItem = {
  order_item_id: string;
  order_id: string;
  order_number: string | null;
  seller_id: string;
  seller_name: string | null;
  product_id: string;
  product_name: string | null;
  qty: number;
  sale_at: string | null;
  reason: 'hook_skip' | 'no_tariff_at_sale' | string;
  retryable: boolean;
  status: string;
};

export type AccrualConsistencySummary = {
  eligibleSaleLines: number;
  accrued: number;
  missingRate: number;
  reversed: number;
  unaccruedHookSkip: number;
  unaccruedNoTariff: number;
  unaccruedBackdated: number;
  gifts: number;
  pendingPreorders: number;
  canceledWithoutAccrual: number;
};

export type SellerLedgerEntry = {
  id: string;
  seller_id: string;
  operation_id: string;
  entry_type: string;
  amount: number;
  order_id: string | null;
  order_item_id: string | null;
  product_id: string | null;
  qty: number | null;
  comment: string | null;
  accrued_at: string;
  created_at: string;
  actor_id: string | null;
};

export type ParsedTariffAmount =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: number };

export function parseTariffAmount(raw: string): ParsedTariffAmount {
  const text = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!text) return { kind: 'empty' };
  if (!/^\d+(\.\d+)?$/.test(text)) return { kind: 'invalid' };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return { kind: 'invalid' };
  return { kind: 'value', value: Number(value.toFixed(2)) };
}

export function openRate(rows: TariffRateRow[], productId: string): TariffRateRow | null {
  return rows.find((row) => row.product_id === productId && row.effective_to == null) ?? null;
}

export function openAssignment(rows: TariffAssignmentRow[]): TariffAssignmentRow | null {
  return rows.find((row) => row.effective_to == null) ?? null;
}

export function formatTariffAmount(value: number | null | undefined, unset: string) {
  if (value == null) return unset;
  return `${new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 2 }).format(value)} ₸`;
}

export function asUnaccruedItems(payload: unknown): UnaccruedCommissionItem[] {
  return rpcItems<Record<string, unknown>>(payload)
    .map((row) => {
      if (typeof row.order_item_id !== 'string' || !row.order_item_id) return null;
      if (typeof row.order_id !== 'string' || !row.order_id) return null;
      if (typeof row.seller_id !== 'string' || !row.seller_id) return null;
      const qty = asFiniteNumber(row.qty);
      return {
        order_item_id: row.order_item_id,
        order_id: row.order_id,
        order_number: typeof row.order_number === 'string' ? row.order_number : null,
        seller_id: row.seller_id,
        seller_name: typeof row.seller_name === 'string' ? row.seller_name : null,
        product_id: typeof row.product_id === 'string' ? row.product_id : '',
        product_name: typeof row.product_name === 'string' ? row.product_name : null,
        qty,
        sale_at: typeof row.sale_at === 'string' ? row.sale_at : null,
        reason: typeof row.reason === 'string' ? row.reason : 'hook_skip',
        retryable: row.retryable === true,
        status: typeof row.status === 'string' ? row.status : 'unaccrued',
      } satisfies UnaccruedCommissionItem;
    })
    .filter((row): row is UnaccruedCommissionItem => row != null);
}

export function asAccrualConsistency(payload: unknown): AccrualConsistencySummary | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  return {
    eligibleSaleLines: asFiniteNumber(row.eligible_sale_lines),
    accrued: asFiniteNumber(row.accrued),
    missingRate: asFiniteNumber(row.missing_rate),
    reversed: asFiniteNumber(row.reversed),
    unaccruedHookSkip: asFiniteNumber(row.unaccrued_hook_skip),
    unaccruedNoTariff: asFiniteNumber(row.unaccrued_no_tariff),
    unaccruedBackdated: asFiniteNumber(row.unaccrued_backdated),
    gifts: asFiniteNumber(row.gifts),
    pendingPreorders: asFiniteNumber(row.pending_preorders),
    canceledWithoutAccrual: asFiniteNumber(row.canceled_without_accrual),
  };
}

export function rpcItems<T>(payload: unknown): T[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? (items as T[]) : [];
}

export function asSellerGoodsIssue(payload: unknown): SellerGoodsIssue | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) return null;
  if (typeof row.seller_id !== 'string' || !row.seller_id) return null;
  return {
    id: row.id,
    issue_number: typeof row.issue_number === 'string' ? row.issue_number : '',
    operation_id: typeof row.operation_id === 'string' ? row.operation_id : '',
    seller_id: row.seller_id,
    seller_name: typeof row.seller_name === 'string' ? row.seller_name : null,
    city_id: typeof row.city_id === 'string' ? row.city_id : '',
    city_name: typeof row.city_name === 'string' ? row.city_name : null,
    credit_amount: asFiniteNumber(row.credit_amount),
    cost_total: asFiniteNumber(row.cost_total),
    issue_kind: typeof row.issue_kind === 'string' ? row.issue_kind : 'settlement',
    ledger_id: typeof row.ledger_id === 'string' ? row.ledger_id : null,
    reversed_at: typeof row.reversed_at === 'string' ? row.reversed_at : null,
    reversal_of: typeof row.reversal_of === 'string' ? row.reversal_of : null,
    actor_id: typeof row.actor_id === 'string' ? row.actor_id : null,
    comment: typeof row.comment === 'string' ? row.comment : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    status: typeof row.status === 'string' ? row.status : 'issued',
    items: parseGoodsItems(row.items),
  };
}

function parseGoodsItems(raw: unknown): SellerGoodsIssueItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SellerGoodsIssueItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const line = item as Record<string, unknown>;
    if (typeof line.product_id !== 'string' || !line.product_id) continue;
    const parsed: SellerGoodsIssueItem = {
      product_id: line.product_id,
      product_name: typeof line.product_name === 'string' ? line.product_name : null,
      qty: asFiniteNumber(line.qty),
      unit_credit_amount: asFiniteNumber(line.unit_credit_amount),
      line_credit_amount: asFiniteNumber(line.line_credit_amount),
      cost_price_snapshot:
        line.cost_price_snapshot == null ? null : asFiniteNumber(line.cost_price_snapshot),
      line_cost_amount: line.line_cost_amount == null ? null : asFiniteNumber(line.line_cost_amount),
    };
    if (typeof line.id === 'string') parsed.id = line.id;
    items.push(parsed);
  }
  return items;
}

export function parseQty(raw: string): ParsedTariffAmount {
  const parsed = parseTariffAmount(raw);
  if (parsed.kind === 'value' && parsed.value <= 0) return { kind: 'invalid' };
  return parsed;
}

export function parseCashAmount(raw: string): ParsedTariffAmount {
  const parsed = parseTariffAmount(raw);
  if (parsed.kind === 'value' && parsed.value <= 0) return { kind: 'invalid' };
  return parsed;
}

function asFiniteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function asSellerBalance(payload: unknown): SellerBalanceRow | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.seller_id !== 'string' || !row.seller_id) return null;
  return {
    seller_id: row.seller_id,
    display_name: typeof row.display_name === 'string' ? row.display_name : null,
    is_active: row.is_active == null ? undefined : Boolean(row.is_active),
    accrued: asFiniteNumber(row.accrued),
    reversed: asFiniteNumber(row.reversed),
    paid: asFiniteNumber(row.paid),
    advances: asFiniteNumber(row.advances),
    goods: asFiniteNumber(row.goods),
    adjustments: asFiniteNumber(row.adjustments),
    balance: asFiniteNumber(row.balance),
  };
}

export function emptySellerBalance(sellerId: string): SellerBalanceRow {
  return {
    seller_id: sellerId,
    accrued: 0,
    reversed: 0,
    paid: 0,
    advances: 0,
    goods: 0,
    adjustments: 0,
    balance: 0,
  };
}

/** YYYY-MM-DD → timestamptz at 00:00 Asia/Almaty for cash RPCs. */
export function cashOperationTimestamp(ymd: string): string {
  return `${ymd}T00:00:00+05:00`;
}

/** Inclusive end of YYYY-MM-DD in Asia/Almaty for ledger_list p_to. */
export function cashHistoryToTimestamp(ymd: string): string {
  return `${ymd}T23:59:59.999+05:00`;
}
