export type ShortageLine = {
  product_id: string;
  qty: number;
  unit_cost: number | null;
};

export function parseShortageItems(details: Record<string, unknown> | null | undefined): ShortageLine[] {
  const raw = details?.items;
  if (!Array.isArray(raw)) return [];
  const lines: ShortageLine[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const productId = String(rec.product_id ?? '');
    const qty = Number(rec.qty ?? rec.qty_lost ?? 0);
    if (!productId || !(qty > 0)) continue;
    const costRaw = rec.unit_cost;
    const unit_cost =
      costRaw === null || costRaw === undefined || costRaw === ''
        ? null
        : Number(costRaw);
    lines.push({
      product_id: productId,
      qty,
      unit_cost: unit_cost == null || Number.isNaN(unit_cost) ? null : unit_cost,
    });
  }
  return lines;
}

export function shortageLineTotal(line: ShortageLine): number | null {
  if (line.unit_cost == null) return null;
  return Number((line.qty * line.unit_cost).toFixed(2));
}

export function sumKnownLossValue(lines: ShortageLine[]): { total: number; unknownQty: boolean } {
  let total = 0;
  let unknownQty = false;
  for (const line of lines) {
    const lineTotal = shortageLineTotal(line);
    if (lineTotal == null) unknownQty = true;
    else total += lineTotal;
  }
  return { total: Number(total.toFixed(2)), unknownQty };
}

export const UNIT_LABELS: Record<string, string> = {
  pcs: 'шт',
  g: 'г',
  kg: 'кг',
  ml: 'мл',
  l: 'л',
};

export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return '';
  return UNIT_LABELS[unit] ?? unit;
}

export type LossReportRow = {
  eventId: string;
  createdAt: string;
  transferId: string;
  transferNumber: string;
  fromCityId: string;
  toCityId: string;
  productId: string;
  productName: string;
  unit: string;
  qty: number;
  unitCost: number | null;
  totalCost: number | null;
  reason: string;
  actorId: string | null;
  actorName: string;
};

export function expandShortageEvent(opts: {
  eventId: string;
  createdAt: string;
  transferId: string;
  transferNumber: string;
  fromCityId: string;
  toCityId: string;
  actorId: string | null;
  actorName: string;
  details: Record<string, unknown> | null | undefined;
  productName: (id: string) => string;
  productUnit: (id: string) => string;
}): LossReportRow[] {
  const reason =
    opts.details && typeof opts.details.reason === 'string' ? opts.details.reason : '';
  return parseShortageItems(opts.details).map((line) => ({
    eventId: opts.eventId,
    createdAt: opts.createdAt,
    transferId: opts.transferId,
    transferNumber: opts.transferNumber,
    fromCityId: opts.fromCityId,
    toCityId: opts.toCityId,
    productId: line.product_id,
    productName: opts.productName(line.product_id),
    unit: opts.productUnit(line.product_id),
    qty: line.qty,
    unitCost: line.unit_cost,
    totalCost: shortageLineTotal(line),
    reason,
    actorId: opts.actorId,
    actorName: opts.actorName,
  }));
}

export function eventYmdAlmaty(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
}

export function filterLossRows(
  rows: LossReportRow[],
  opts: { fromYmd?: string; toYmd?: string; cityId?: string; productId?: string }
): LossReportRow[] {
  return rows.filter((row) => {
    const ymd = eventYmdAlmaty(row.createdAt);
    if (opts.fromYmd && ymd < opts.fromYmd) return false;
    if (opts.toYmd && ymd > opts.toYmd) return false;
    if (opts.cityId && row.fromCityId !== opts.cityId && row.toCityId !== opts.cityId) return false;
    if (opts.productId && row.productId !== opts.productId) return false;
    return true;
  });
}

export function lossKpis(rows: LossReportRow[]): {
  knownValue: number;
  unknownLineCount: number;
  qtyByUnit: Array<{ unit: string; qty: number }>;
  transferCount: number;
} {
  let knownValue = 0;
  let unknownLineCount = 0;
  const qtyMap = new Map<string, number>();
  const transfers = new Set<string>();
  for (const row of rows) {
    transfers.add(row.transferId);
    qtyMap.set(row.unit || 'pcs', Number(((qtyMap.get(row.unit || 'pcs') || 0) + row.qty).toFixed(3)));
    if (row.totalCost == null) unknownLineCount += 1;
    else knownValue += row.totalCost;
  }
  return {
    knownValue: Number(knownValue.toFixed(2)),
    unknownLineCount,
    qtyByUnit: [...qtyMap.entries()]
      .map(([unit, qty]) => ({ unit, qty }))
      .sort((a, b) => a.unit.localeCompare(b.unit)),
    transferCount: transfers.size,
  };
}
