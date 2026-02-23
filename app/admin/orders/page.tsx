'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { supabase } from '@/lib/supabaseClient';
import type { Order } from '@/lib/types';
import type { City } from '@/lib/types';
import type { Profile } from '@/lib/types';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

function formatDate(s: string) {
  return new Date(s).toLocaleString('ru-KZ', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [filterCity, setFilterCity] = useState('');
  const [filterSeller, setFilterSeller] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterDate, setFilterDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from('cities').select('*').then(({ data }) => setCities(data || []));
    supabase.from('profiles').select('*').eq('role', 'seller').then(({ data }) => setProfiles(data || []));
  }, []);

  useEffect(() => {
    async function load() {
      let q = supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false });

      if (filterDate) {
        q = q
          .gte('created_at', `${filterDate}T00:00:00`)
          .lt('created_at', `${filterDate}T23:59:59.999`);
      }
      if (filterCity) q = q.eq('city_id', filterCity);
      if (filterSeller) q = q.eq('seller_id', filterSeller);
      if (filterStatus) q = q.eq('status', filterStatus);

      const { data } = await q;
      setOrders(data || []);
      setLoading(false);
    }

    load();
  }, [filterDate, filterCity, filterSeller, filterStatus]);

  useEffect(() => {
    if (!selectedId) {
      setOrderDetail(null);
      return;
    }
    supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('id', selectedId)
      .single()
      .then(({ data }) => setOrderDetail(data as Order | null));
  }, [selectedId]);

  async function handleCancel(orderId: string) {
    const { error } = await supabase.rpc('cancel_order', { p_order_id: orderId });
    if (error) {
      alert(error.message);
      return;
    }
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: 'canceled' } : o)));
    if (orderDetail?.id === orderId) setOrderDetail({ ...orderDetail, status: 'canceled' });
    setSelectedId(null);
  }

  const cityMap = new Map(cities.map((c) => [c.id, c.name]));
  const sellerMap = new Map(profiles.map((p) => [p.id, p.display_name || p.id]));

  return (
    <Protected role="admin">
      <div className="min-h-screen">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-4">Заказы</h1>

          <div className="flex flex-wrap gap-2 mb-4">
            <input
              type="date"
              value={filterDate}
              onChange={(e) => setFilterDate(e.target.value)}
              className="px-3 py-2 border rounded-lg"
            />
            <select
              value={filterCity}
              onChange={(e) => setFilterCity(e.target.value)}
              className="px-3 py-2 border rounded-lg"
            >
              <option value="">Все города</option>
              {cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={filterSeller}
              onChange={(e) => setFilterSeller(e.target.value)}
              className="px-3 py-2 border rounded-lg"
            >
              <option value="">Все продавцы</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name || p.id}
                </option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-2 border rounded-lg"
            >
              <option value="">Все статусы</option>
              <option value="confirmed">Подтверждён</option>
              <option value="canceled">Отменён</option>
            </select>
          </div>

          {loading ? (
            <p>Загрузка...</p>
          ) : (
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 text-left">Дата</th>
                    <th className="p-2 text-left">Город</th>
                    <th className="p-2 text-left">Продавец</th>
                    <th className="p-2 text-right">Сумма</th>
                    <th className="p-2 text-left">Статус</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-t">
                      <td className="p-2">{formatDate(o.created_at)}</td>
                      <td className="p-2">{cityMap.get(o.city_id) || o.city_id}</td>
                      <td className="p-2">{sellerMap.get(o.seller_id) || o.seller_id}</td>
                      <td className="p-2 text-right">{formatMoney(o.total_sum)} ₸</td>
                      <td className="p-2">
                        {o.status === 'canceled' ? (
                          <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                            Отменён
                          </span>
                        ) : (
                          <span>Подтверждён</span>
                        )}
                      </td>
                      <td className="p-2">
                        <button
                          onClick={() => setSelectedId(o.id)}
                          className="text-blue-600"
                        >
                          Детали
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {orderDetail && (
            <div
              className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
              onClick={() => setSelectedId(null)}
            >
              <div
                className="bg-white rounded-xl p-6 max-w-md w-full max-h-[80vh] overflow-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="font-bold mb-2">Заказ {orderDetail.id.slice(0, 8)}</h2>
                {orderDetail.status === 'canceled' && (
                  <span className="inline-block mb-2 px-2 py-1 text-sm font-medium bg-red-100 text-red-700 rounded">
                    Отменён
                  </span>
                )}
                <p>Дата: {formatDate(orderDetail.created_at)}</p>
                <p>Город: {cityMap.get(orderDetail.city_id)}</p>
                <p>Продавец: {sellerMap.get(orderDetail.seller_id)}</p>
                <p>Сумма: {formatMoney(orderDetail.total_sum)} ₸</p>
                <p>Оплата: {orderDetail.payment_type || '-'}</p>
                {orderDetail.comment && <p>Комментарий: {orderDetail.comment}</p>}
                <div className="mt-2 space-y-1">
                  {orderDetail.order_items?.map((item) => (
                    <div key={item.id} className="text-sm">
                      {item.product_name_snapshot} × {item.qty} = {formatMoney(item.line_sum)} ₸
                    </div>
                  ))}
                </div>
                {orderDetail.status === 'confirmed' && (
                  <button
                    onClick={() => handleCancel(orderDetail.id)}
                    className="mt-4 w-full py-2 bg-red-600 text-white rounded-lg"
                  >
                    Отменить заказ
                  </button>
                )}
                <button
                  onClick={() => setSelectedId(null)}
                  className="mt-2 w-full py-2 bg-gray-300 rounded-lg"
                >
                  Закрыть
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Protected>
  );
}
