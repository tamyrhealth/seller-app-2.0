'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';
import { getTodayLocalISO, getLocalDayRangeInTz } from '@/lib/datetime';
import {
  buildTodaySalesDashboard,
  type CityRevenue,
  type OrderRow,
  type ProductQty,
  type SellerTodayRow,
} from '@/lib/todaySalesDashboard';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

const UNIT_LABELS: Record<string, string> = {
  pcs: 'шт.',
  kg: 'кг',
  g: 'г',
  l: 'л',
  ml: 'мл',
};

function unitLabel(unit: string | null | undefined): string {
  if (!unit) return 'шт.';
  return UNIT_LABELS[unit] ?? unit;
}

function formatQty(qty: number, unit: string): string {
  const label = unitLabel(unit);
  if (unit === 'kg') {
    const s = Number(qty.toFixed(3)).toString();
    return `${s} ${label}`;
  }
  return `${qty} ${label}`;
}

export default function AdminPage() {
  const { t } = useTranslation();
  const deletedSellerLabel = t('admin.deletedSeller');
  const [todayRevenue, setTodayRevenue] = useState(0);
  const [todayOrders, setTodayOrders] = useState(0);
  const [cityRevenues, setCityRevenues] = useState<CityRevenue[]>([]);
  const [sellerRows, setSellerRows] = useState<SellerTodayRow[]>([]);
  const [productRows, setProductRows] = useState<ProductQty[]>([]);
  const [expandedSeller, setExpandedSeller] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const onVis = () => setRefreshKey((k) => k + 1);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    async function load() {
      const today = getTodayLocalISO('Asia/Almaty');
      const range = getLocalDayRangeInTz(today, 'Asia/Almaty');
      const fromISO = range.from.toISOString();
      const toNextISO = range.toNext.toISOString();
      const orderSelect =
        'id, seller_id, total_sum, city_id, created_at, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, order_items(product_id, qty, is_gift, product_name_snapshot, product:products(name, unit))';

      const [createdRes, fulfilledRes, debtPaidRes] = await Promise.all([
        supabase.from('orders').select(orderSelect).gte('created_at', fromISO).lt('created_at', toNextISO),
        supabase.from('orders').select(orderSelect).gte('fulfilled_at', fromISO).lt('fulfilled_at', toNextISO),
        supabase.from('orders').select(orderSelect).gte('debt_paid_at', fromISO).lt('debt_paid_at', toNextISO),
      ]);

      const seen = new Set<string>();
      const allRows: OrderRow[] = [];
      for (const row of [...(createdRes.data || []), ...(fulfilledRes.data || []), ...(debtPaidRes.data || [])] as OrderRow[]) {
        if (row.id && !seen.has(row.id)) {
          seen.add(row.id);
          allRows.push(row);
        } else if (!row.id) allRows.push(row);
      }

      const sellerIds = [...new Set(allRows.map((o) => o.seller_id).filter((id): id is string => !!id))];
      const nameMap = new Map<string, string>();
      if (sellerIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', sellerIds);
        for (const p of profiles || []) {
          nameMap.set(p.id, (p.display_name || '').trim());
        }
      }
      const { data: cities } = await supabase.from('cities').select('id, name');
      const cityNameMap = new Map((cities || []).map((c) => [c.id, c.name]));

      const dash = buildTodaySalesDashboard({
        orders: allRows,
        range,
        sellerNames: nameMap,
        cityNames: cityNameMap,
        deletedSellerLabel,
      });
      setTodayRevenue(dash.todayRevenue);
      setTodayOrders(dash.todayOrders);
      setCityRevenues(dash.cityRevenues);
      setSellerRows(dash.sellerRows);
      setProductRows(dash.productRows);
      setLoading(false);
    }

    load();
  }, [refreshKey, deletedSellerLabel]);

  const sellersTotal = sellerRows.reduce((s, r) => s + r.revenue, 0);

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-6 text-gray-900">{t('admin.dashboard')}</h1>

          {loading ? (
            <p className="text-gray-900">{t('common.loading')}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-blue-50 rounded-xl p-4">
                  <p className="text-sm text-gray-600">{t('admin.todayRevenue')}</p>
                  <p className="text-2xl font-bold text-gray-900">{formatMoney(todayRevenue)} ₸</p>
                </div>
                <div className="bg-green-50 rounded-xl p-4">
                  <p className="text-sm text-gray-600">{t('admin.todayOrders')}</p>
                  <p className="text-2xl font-bold text-gray-900">{todayOrders}</p>
                </div>
              </div>

              <div className="mb-6">
                <h2 className="font-bold mb-2 text-gray-900">{t('admin.cityRevenue')}</h2>
                <div className="border border-gray-200 rounded-lg overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left text-gray-900">{t('admin.city')}</th>
                        <th className="p-2 text-right text-gray-900">{t('admin.revenue')}</th>
                        <th className="p-2 text-right text-gray-900">{t('admin.ordersCount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cityRevenues.map((r) => (
                        <tr key={r.city_name} className="border-t border-gray-200">
                          <td className="p-2 text-gray-900">{r.city_name}</td>
                          <td className="p-2 text-right text-gray-900">{formatMoney(r.revenue)} ₸</td>
                          <td className="p-2 text-right text-gray-900">{r.order_count}</td>
                        </tr>
                      ))}
                      {cityRevenues.length === 0 && (
                        <tr>
                          <td colSpan={3} className="p-2 text-gray-600">
                            {t('admin.noDataToday')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                    <h2 className="font-bold text-sm text-gray-900">{t('admin.todaySellerSales')}</h2>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {sellerRows.length === 0 && (
                      <p className="p-3 text-sm text-gray-600">{t('admin.noDataToday')}</p>
                    )}
                    {sellerRows.map((s) => (
                      <div key={s.key}>
                        <button
                          type="button"
                          onClick={() => setExpandedSeller((cur) => (cur === s.key ? null : s.key))}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50"
                        >
                          <span className="text-sm font-medium text-gray-900 truncate">{s.name}</span>
                          <span className="text-sm tabular-nums text-gray-900 shrink-0">{formatMoney(s.revenue)} ₸</span>
                        </button>
                        {expandedSeller === s.key && (
                          <div className="px-3 pb-2 pl-4 space-y-1">
                            {s.products.length === 0 ? (
                              <p className="text-xs text-gray-500">{t('admin.noSoldItems')}</p>
                            ) : (
                              s.products.map((p) => (
                                <div key={p.key} className="flex justify-between gap-2 text-xs text-gray-700">
                                  <span className="truncate">{p.name}</span>
                                  <span className="shrink-0 tabular-nums">{formatQty(p.qty, p.unit)}</span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="px-3 py-2 border-t border-gray-200 bg-gray-50 flex justify-between text-sm font-semibold text-gray-900">
                    <span>{t('admin.todaySellersTotal')}</span>
                    <span className="tabular-nums">{formatMoney(sellersTotal)} ₸</span>
                  </div>
                </div>

                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                    <h2 className="font-bold text-sm text-gray-900">{t('admin.todaySoldProducts')}</h2>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {productRows.length === 0 && (
                      <p className="p-3 text-sm text-gray-600">{t('admin.noDataToday')}</p>
                    )}
                    {productRows.map((p) => (
                      <div key={p.key} className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="text-sm text-gray-900 truncate">{p.name}</span>
                        <span className="text-sm tabular-nums text-gray-900 shrink-0">{formatQty(p.qty, p.unit)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Protected>
  );
}