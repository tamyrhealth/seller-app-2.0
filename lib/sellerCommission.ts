export const SELLER_TARIFF_PLANS_LIST = 'admin_seller_tariff_plans_list';
export const SELLER_TARIFF_RATES_LIST = 'admin_seller_tariff_rates_list';
export const SELLER_TARIFF_RATE_SET = 'admin_seller_tariff_rate_set';
export const SELLER_TARIFF_ASSIGNMENTS_LIST = 'admin_seller_tariff_assignments_list';
export const SELLER_TARIFF_ASSIGN = 'admin_seller_tariff_assign';
export const SELLER_RATE_OVERRIDES_LIST = 'admin_seller_rate_overrides_list';
export const SELLER_RATE_OVERRIDE_SET = 'admin_seller_rate_override_set';
export const SELLER_MISSING_ACCRUALS_LIST = 'admin_seller_missing_accruals_list';
export const SELLER_ACCRUAL_RETRY_ITEM = 'admin_seller_accrual_retry_item';

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
