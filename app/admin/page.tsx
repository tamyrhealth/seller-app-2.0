'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

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
  const [todayRevenue, setTodayRevenue] = useState(0);
  const [todayOrders, setTodayOrders] = useState(0);
  const [cityRevenues, setCityRevenues] = useState<CityRevenue[]>([]);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const today = new Date().toISOString().slice(0, 10);

      const { data: orders } = await supabase
        .from('orders')
        .select('total_sum, city_id')
        .eq('status', 'confirmed')
        .gte('created_at', `${today}T00:00:00`)
        .lt('created_at', `${today}T23:59:59.999`);

      const rev = (orders || []).reduce((acc, o) => acc + Number(o.total_sum), 0);
      setTodayRevenue(rev);
      setTodayOrders((orders || []).length);

      const cityIds = [...new Set((orders || []).map((o) => o.city_id))];
      const cityMap = new Map<string, { revenue: number; count: number }>();
      for (const o of orders || []) {
        const cur = cityMap.get(o.city_id) || { revenue: 0, count: 0 };
        cur.revenue += Number(o.total_sum);
        cur.count += 1;
        cityMap.set(o.city_id, cur);
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
  }, []);

  return (
    <Protected role="admin">
      <div className="min-h-screen">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-6">Дашборд</h1>

          {loading ? (
            <p>Загрузка...</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-blue-50 rounded-xl p-4">
                  <p className="text-sm text-gray-600">Выручка сегодня</p>
                  <p className="text-2xl font-bold">{formatMoney(todayRevenue)} ₸</p>
                </div>
                <div className="bg-green-50 rounded-xl p-4">
                  <p className="text-sm text-gray-600">Заказов сегодня</p>
                  <p className="text-2xl font-bold">{todayOrders}</p>
                </div>
              </div>

              <div className="mb-6">
                <h2 className="font-bold mb-2">Выручка по городам (сегодня)</h2>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left">Город</th>
                        <th className="p-2 text-right">Выручка</th>
                        <th className="p-2 text-right">Заказов</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cityRevenues.map((r) => (
                        <tr key={r.city_name} className="border-t">
                          <td className="p-2">{r.city_name}</td>
                          <td className="p-2 text-right">{formatMoney(r.revenue)} ₸</td>
                          <td className="p-2 text-right">{r.order_count}</td>
                        </tr>
                      ))}
                      {cityRevenues.length === 0 && (
                        <tr>
                          <td colSpan={3} className="p-2 text-gray-500">
                            Нет данных за сегодня
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mb-6">
                <h2 className="font-bold mb-2">Низкий остаток</h2>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left">Товар</th>
                        <th className="p-2 text-left">Город</th>
                        <th className="p-2 text-right">Остаток</th>
                        <th className="p-2 text-right">Порог</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lowStock.slice(0, 20).map((s, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-2">{s.product_name}</td>
                          <td className="p-2">{s.city_name}</td>
                          <td className="p-2 text-right text-red-600">{s.qty_on_hand}</td>
                          <td className="p-2 text-right">{s.low_stock_threshold}</td>
                        </tr>
                      ))}
                      {lowStock.length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-2 text-gray-500">
                            Нет товаров с низким остатком
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
