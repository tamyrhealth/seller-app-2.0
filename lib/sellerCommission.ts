export const SELLER_TARIFF_PLANS_LIST = 'admin_seller_tariff_plans_list';
export const SELLER_TARIFF_RATES_LIST = 'admin_seller_tariff_rates_list';
export const SELLER_TARIFF_RATE_SET = 'admin_seller_tariff_rate_set';
export const SELLER_TARIFF_ASSIGNMENTS_LIST = 'admin_seller_tariff_assignments_list';
export const SELLER_TARIFF_ASSIGN = 'admin_seller_tariff_assign';
export const SELLER_RATE_OVERRIDES_LIST = 'admin_seller_rate_overrides_list';
export const SELLER_RATE_OVERRIDE_SET = 'admin_seller_rate_override_set';
export const SELLER_MISSING_ACCRUALS_LIST = 'admin_seller_missing_accruals_list';
export const SELLER_ACCRUAL_RETRY_ITEM = 'admin_seller_accrual_retry_item';
export const SELLER_BALANCE = 'admin_seller_balance';
export const SELLER_BALANCES_LIST = 'admin_seller_balances_list';
export const SELLER_LEDGER_LIST = 'admin_seller_ledger_list';
export const SELLER_MY_BALANCE = 'seller_my_balance';
export const SELLER_MY_LEDGER = 'seller_my_ledger';
export const SELLER_CASH_PAYOUT = 'admin_seller_cash_payout';
export const SELLER_CASH_ADVANCE = 'admin_seller_cash_advance';

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

export function rpcItems<T>(payload: unknown): T[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? (items as T[]) : [];
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
