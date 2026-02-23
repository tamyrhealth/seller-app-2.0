'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';

type OrderItemRow = {
  qty: number;
  price: number;
  product: { name: string } | null;
};

type OrderRow = {
  id: string;
  created_at: string;
  payment_type: string;
  total_sum: number;
  status: string;
  order_items?: OrderItemRow[] | null;
};

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SellerOrdersPage() {
  const { profile, authReady, signOut } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get('id');

  const [tab, setTab] = useState<'day' | 'week' | 'month'>('day');
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [detailOpen, setDetailOpen] = useState(false);
  const [orderDetail, setOrderDetail] = useState<OrderRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [cancelLoading, setCancelLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function getFromDate(t: 'day' | 'week' | 'month') {
    const now = new Date();
    const from = new Date(now);
    if (t === 'day') from.setHours(0, 0, 0, 0);
    if (t === 'week') from.setDate(from.getDate() - 7);
    if (t === 'month') from.setMonth(from.getMonth() - 1);
    return from.toISOString();
  }

  async function loadOrders() {
    if (!profile?.id) return;
    setLoading(true);
    setError(null);
    try {
      const fromIso = getFromDate(tab);
      const { data, error: e } = await supabase
        .from('orders')
        .select('id, created_at, payment_type, total_sum, status')
        .eq('seller_id', profile.id)
        .gte('created_at', fromIso)
        .order('created_at', { ascending: false });

      if (e) {
        if (isSessionError(e)) {
          signOut('Сессия истекла');
          return;
        }
        setError(e.message);
        setOrders([]);
        return;
      }
      setOrders((data as OrderRow[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadOrderDetail(id: string) {
    setDetailLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase
        .from('orders')
        .select(
          `
          id, created_at, payment_type, total_sum, status,
          order_items:order_items ( qty, price, product:products ( name ) )
        `
        )
        .eq('id', id)
        .maybeSingle();

      if (e) {
        if (isSessionError(e)) {
          signOut('Сессия истекла');
          return;
        }
        setError(e.message);
        setOrderDetail(null);
        return;
      }
      setOrderDetail(((data as unknown) as OrderRow) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setOrderDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!authReady || !profile?.id) {
      setLoading(false);
      return;
    }
    loadOrders();
  }, [authReady, profile?.id, tab]);

  useEffect(() => {
    if (!selectedId) {
      setDetailOpen(false);
      setOrderDetail(null);
      return;
    }
    setDetailOpen(true);
    loadOrderDetail(selectedId);
  }, [selectedId]);

  function openOrder(id: string) {
    router.push(`/seller/orders?id=${id}`);
  }

  function closeDetail() {
    router.push('/seller/orders');
  }

  async function handleCancel(orderId: string) {
    setCancelLoading(true);
    setError(null);
    try {
      const { error: e } = await supabase.rpc('cancel_order', { p_order_id: orderId });
      if (e) {
        if (isSessionError(e)) {
          signOut('Сессия истекла');
          return;
        }
        setError(e.message);
        return;
      }
      await loadOrders();
      await loadOrderDetail(orderId);
    } finally {
      setCancelLoading(false);
    }
  }

  const items = orderDetail?.order_items ?? [];

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Link href="/seller" className="text-blue-600 font-medium">
              ← Назад
            </Link>
          </div>

          <h1 className="text-2xl font-bold mb-4">Мои заказы</h1>

          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setTab('day')}
              className={`px-4 py-2 rounded-lg ${tab === 'day' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              Сегодня
            </button>
            <button
              onClick={() => setTab('week')}
              className={`px-4 py-2 rounded-lg ${tab === 'week' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              Неделя
            </button>
            <button
              onClick={() => setTab('month')}
              className={`px-4 py-2 rounded-lg ${tab === 'month' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              Месяц
            </button>
          </div>

          {error && <div className="mb-3 text-red-600">{error}</div>}

          {loading ? (
            <div>Загрузка...</div>
          ) : !profile ? (
            <div>Нет профиля. Перезайди в аккаунт.</div>
          ) : orders.length === 0 ? (
            <div>Нет заказов за выбранный период</div>
          ) : (
            <div className="space-y-2">
              {orders.map((o) => (
                <div
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openOrder(o.id)}
                  onKeyDown={(e) => e.key === 'Enter' && openOrder(o.id)}
                  className="border rounded-xl p-4 bg-white cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm text-gray-600">{formatDate(o.created_at)}</div>
                      <div className="text-sm text-gray-500">{o.payment_type}</div>
                      <div className="text-sm text-gray-700 mt-1">заказ на сумму {formatMoney(o.total_sum ?? 0)} ₸</div>
                      {o.status === 'canceled' && (
                        <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                          Отменён
                        </span>
                      )}
                    </div>
                    <div className="font-bold text-green-700 whitespace-nowrap">{formatMoney(o.total_sum ?? 0)} ₸</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {detailOpen && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4" onClick={closeDetail}>
              <div className="bg-white rounded-2xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
                {detailLoading ? (
                  <div>Загрузка состава заказа...</div>
                ) : !orderDetail ? (
                  <div className="text-red-600">Не удалось загрузить заказ</div>
                ) : (
                  <>
                    <div className="text-xl font-bold mb-4">Заказ {formatDate(orderDetail.created_at)}</div>
                    {orderDetail.status === 'canceled' && (
                      <div className="mb-2">
                        <span className="inline-block px-2 py-1 text-sm font-medium bg-red-100 text-red-700 rounded">
                          Отменён
                        </span>
                      </div>
                    )}
                    <div className="mb-2">Сумма: {formatMoney(orderDetail.total_sum ?? 0)} ₸</div>
                    <div className="mb-4">Оплата: {orderDetail.payment_type}</div>
                    <div className="space-y-2 mb-4">
                      {items.length > 0 ? (
                        items.map((it, idx) => (
                          <div key={idx} className="text-sm">
                            {it.product?.name ?? 'Товар'} × {it.qty} = {formatMoney((it.price ?? 0) * (it.qty ?? 0))} ₸
                          </div>
                        ))
                      ) : (
                        <div className="text-gray-500 text-sm">Нет позиций в составе</div>
                      )}
                    </div>
                    {orderDetail.status !== 'canceled' && (
                      <button
                        onClick={() => handleCancel(orderDetail.id)}
                        disabled={cancelLoading}
                        className="w-full py-3 rounded-lg bg-red-600 text-white font-bold disabled:opacity-60"
                      >
                        {cancelLoading ? 'Отмена...' : 'Отменить заказ'}
                      </button>
                    )}
                  </>
                )}
                <button onClick={closeDetail} className="w-full py-3 rounded-lg bg-gray-200 mt-2">
                  Закрыть
                </button>
              </div>
            </div>
          )}
        </div>
        <NavSeller />
      </div>
    </Protected>
  );
}
