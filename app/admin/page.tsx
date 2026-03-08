'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';
import { sumConfirmedInRange, isConfirmedInRange } from '@/lib/accounting';
import { getTodayLocalISO, getLocalDayRangeInTz } from '@/lib/datetime';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

interface CityRevenue {
  city_name: string;
  revenue: number;
  order_count: number;
}

interface LowStockItem {
  product_name: string;
  city_name: string;
  qty_on_hand: number;
  low_stock_threshold: number;
}

export default function AdminPage() {
  const { t } = useTranslation();
  const [todayRevenue, setTodayRevenue] = useState(0);
  const [todayOrders, setTodayOrders] = useState(0);
  const [cityRevenues, setCityRevenues] = useState<CityRevenue[]>([]);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

      const [createdRes, fulfilledRes, debtPaidRes] = await Promise.all([
        supabase
          .from('orders')
          .select('id, total_sum, city_id, created_at, status, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at')
          .gte('created_at', fromISO)
          .lt('created_at', toNextISO),
        supabase
          .from('orders')
          .select('id, total_sum, city_id, created_at, status, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at')
          .gte('fulfilled_at', fromISO)
          .lt('fulfilled_at', toNextISO),
        supabase
          .from('orders')
          .select('id, total_sum, city_id, created_at, status, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at')
          .gte('debt_paid_at', fromISO)
          .lt('debt_paid_at', toNextISO),
      ]);

      const seen = new Set<string>();
      const allRows: Array<{ id?: string; total_sum?: number; city_id?: string; created_at?: string; status?: string; is_preorder?: boolean; preorder_status?: string; fulfilled_at?: string; is_debt?: boolean; debt_status?: string; debt_paid_at?: string }> = [];
      for (const row of [...(createdRes.data || []), ...(fulfilledRes.data || []), ...(debtPaidRes.data || [])]) {
        const o = row as { id?: string };
        if (o.id && !seen.has(o.id)) {
          seen.add(o.id);
          allRows.push(row);
        } else if (!o.id) allRows.push(row);
      }

      const rev = sumConfirmedInRange(allRows, range);
      const count = allRows.filter((o) => isConfirmedInRange(o, range)).length;
      setTodayRevenue(rev);
      setTodayOrders(count);

      const cityMap = new Map<string, { revenue: number; count: number }>();
      for (const o of allRows) {
        if (!isConfirmedInRange(o, range)) continue;
        const cid = o.city_id ?? '';
        const cur = cityMap.get(cid) || { revenue: 0, count: 0 };
        cur.revenue += Number(o.total_sum ?? 0);
        cur.count += 1;
        cityMap.set(cid, cur);
      }
      const { data: cities } = await supabase.from('cities').select('id, name');
      const cityNameMap = new Map((cities || []).map((c) => [c.id, c.name]));

      setCityRevenues(
        Array.from(cityMap.entries()).map(([id, v]) => ({
          city_name: cityNameMap.get(id) ?? id,
          revenue: v.revenue,
          order_count: v.count,
        }))
      );

      const { data: invData } = await supabase
        .from('inventory')
        .select('city_id, product_id, qty_on_hand, low_stock_threshold, products(name), cities(name)');

      const low: LowStockItem[] = [];
      for (const i of invData || []) {
        const p = i.products as { name: string } | null;
        const c = i.cities as { name: string } | null;
        if (i.qty_on_hand <= i.low_stock_threshold) {
          low.push({
            product_name: p?.name ?? '',
            city_name: c?.name ?? '',
            qty_on_hand: i.qty_on_hand,
            low_stock_threshold: i.low_stock_threshold,
          });
        }
      }
      setLowStock(low);
      setLoading(false);
    }

    load();
  }, [refreshKey]);

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

              <div className="mb-6">
                <h2 className="font-bold mb-2 text-gray-900">{t('admin.lowStock')}</h2>
                <div className="border border-gray-200 rounded-lg overflow-x-auto">
                  <table className="w-full min-w-[480px] text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left text-gray-900">{t('admin.product')}</th>
                        <th className="p-2 text-left text-gray-900">{t('admin.city')}</th>
                        <th className="p-2 text-right text-gray-900">{t('admin.stock')}</th>
                        <th className="p-2 text-right text-gray-900">{t('admin.threshold')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lowStock.slice(0, 20).map((s, i) => (
                        <tr key={i} className="border-t border-gray-200">
                          <td className="p-2 text-gray-900">{s.product_name}</td>
                          <td className="p-2 text-gray-900">{s.city_name}</td>
                          <td className="p-2 text-right text-red-600">{s.qty_on_hand}</td>
                          <td className="p-2 text-right text-gray-900">{s.low_stock_threshold}</td>
                        </tr>
                      ))}
                      {lowStock.length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-2 text-gray-600">
                            {t('admin.noLowStock')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Protected>
  );
}
