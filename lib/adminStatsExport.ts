import * as XLSX from 'xlsx';
import type { AdminStatsResult, PeriodSpec } from '@/lib/adminStats';
import { formatQtyByUnit } from '@/lib/adminStats';

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Neutralize CSV/Excel formula injection in text cells (=, +, -, @, tab, CR). */
function excelText(value: string | number | null | undefined): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

function row(cells: Array<string | number | null | undefined>): Array<string | number> {
  return cells.map((c) => (c === null || c === undefined || c === '' ? excelText(c ?? '') : typeof c === 'number' ? c : excelText(c)));
}

export function downloadAdminStatsExcel(
  stats: AdminStatsResult,
  period: PeriodSpec,
  filterLabels: { seller: string; city: string; product: string }
) {
  const wb = XLSX.utils.book_new();

  const summary = [
    row(['Статистика и финансы']),
    row(['Период', `${period.fromYmd} — ${period.toYmd}`]),
    row(['Продавец', filterLabels.seller]),
    row(['Город', filterLabels.city]),
    row(['Товар', filterLabels.product]),
    [],
    row(['Показатель', 'Значение']),
    row(['Признанная выручка, ₸', money(stats.revenue)]),
    row(['Признанных заказов', stats.orderCount]),
    row(['Средний чек, ₸', money(stats.averageCheck)]),
    row(['Проданные товары', formatQtyByUnit(stats.qtyByUnit)]),
    row(['Непогашенные долги, ₸', money(stats.unpaidDebtAmount)]),
    row(['Заказов с непогашенным долгом', stats.unpaidDebtOrders]),
    row(['Выручка по фильтру товара (не весь заказ)', stats.productFilterActive ? 'да' : 'нет']),
    row(['Заказов с расхождением line_sum и total_sum', stats.lineDiscrepancyCount]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Общие показатели');

  const sellers = [
    row(['Продавец', 'Выручка, ₸', 'Заказов', 'Количество товаров', 'Доля, %']),
    ...stats.sellers.map((s) =>
      row([s.name, money(s.revenue), s.orderCount, formatQtyByUnit(s.qtyByUnit), Math.round(s.sharePct * 10) / 10])
    ),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sellers), 'Продажи продавцов');

  const productsSheet = [
    row(['Товар', 'Количество', 'Единица', 'Выручка, ₸']),
    ...stats.products.map((p) => row([p.name, p.qty, p.unit, money(p.revenue)])),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(productsSheet), 'Продажи товаров');

  const daily = [
    row(['Дата', 'Выручка, ₸', 'Заказов']),
    ...stats.daily.map((d) => row([d.date, money(d.revenue), d.orders])),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daily), 'Динамика по дням');

  const filename = `stats_${period.fromYmd}_${period.toYmd}.xlsx`;
  XLSX.writeFile(wb, filename);
}