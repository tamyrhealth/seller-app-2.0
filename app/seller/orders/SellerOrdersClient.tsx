'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';
import { useTranslation } from '@/lib/i18n';
import { useEnsureActiveDevice } from '@/lib/useEnsureActiveDevice';
import { logAction } from '@/lib/actionLog';

type OrderItemRow = {
  id?: string;
  qty: number;
  price: number;
  line_sum?: number;
  is_gift?: boolean;
  product_name_snapshot?: string;
  product: { name: string } | null;
};

type OrderRow = {
  id: string;
  created_at: string;
  payment_type?: string | null;
  total_sum: number;
  status: string;
  is_preorder?: boolean;
  preorder_status?: string;
  is_debt?: boolean;
  debt_status?: string;
  debt_payment_method?: string | null;
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

export default function SellerOrdersClient() {
  const { profile, authReady, signOut } = useAuth();
  const { t } = useTranslation();
  const ensureActive = useEnsureActiveDevice();
  const router = useRouter();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'day' | 'week' | 'month'>('day');
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [detailOpen, setDetailOpen] = useState(false);
  const [orderDetail, setOrderDetail] = useState<OrderRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [cancelLoading, setCancelLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelectedId(params.get('id'));
    const syncFromUrl = () => {
      const p = new URLSearchParams(window.location.search);
      setSelectedId(p.get('id'));
    };
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  function getFromDate(t: 'day' | 'week' | 'month') {
    const now = new Date();
    const from = new Date(now);
    if (t === 'day') from.setHours(0, 0, 0, 0);
    if (t === 'week') from.setDate(from.getDate() - 7);
    if (t === 'month') from.setMonth(from.getMonth() - 1);
    return from.toISOString();
  }

  function isPreorderColumnError(err: { message?: string } | null): boolean {
    const msg = String(err?.message ?? '');
    return msg.includes('is_preorder') || msg.includes('does not exist');
  }

  async function loadOrders() {
    if (!profile?.id) return;
    setLoading(true);
    setError(null);
    try {
      const fromIso = getFromDate(tab);
      const { data, error: e } = await supabase
        .from('orders')
        .select('id, created_at, payment_type, total_sum, status, is_preorder, is_debt, debt_status, debt_payment_method')
        .eq('seller_id', profile.id)
        .gte('created_at', fromIso)
        .order('created_at', { ascending: false });

      if (e) {
        if (isSessionError(e)) {
          signOut(t('auth.sessionExpired'));
          return;
        }
        if (isPreorderColumnError(e)) {
          const { data: fallbackData, error: fallbackErr } = await supabase
            .from('orders')
            .select('id, created_at, payment_type, total_sum, status')
            .eq('seller_id', profile.id)
            .gte('created_at', fromIso)
            .order('created_at', { ascending: false });
          if (fallbackErr) {
            setError(fallbackErr.message);
            setOrders([]);
          } else {
            setOrders((fallbackData as OrderRow[]) ?? []);
          }
        } else {
          setError(e.message);
          setOrders([]);
        }
        return;
      }
      setOrders((data as OrderRow[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orders.loadError'));
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
          id, created_at, payment_type, total_sum, status, is_preorder, preorder_status, is_debt, debt_status, debt_payment_method,
          order_items:order_items ( qty, price, line_sum, is_gift, product_name_snapshot, product:products ( name ) )
        `
        )
        .eq('id', id)
        .maybeSingle();

      if (e) {
        if (isSessionError(e)) {
          signOut(t('auth.sessionExpired'));
          return;
        }
        if (isPreorderColumnError(e)) {
          const { data: fallbackData, error: fallbackErr } = await supabase
            .from('orders')
            .select(
              `
              id, created_at, payment_type, total_sum, status,
              order_items:order_items ( qty, price, line_sum, is_gift, product_name_snapshot, product:products ( name ) )
            `
            )
            .eq('id', id)
            .maybeSingle();
          if (fallbackErr) {
            setError(fallbackErr.message);
            setOrderDetail(null);
          } else {
            setOrderDetail(((fallbackData as unknown) as OrderRow) ?? null);
          }
        } else {
          setError(e.message);
          setOrderDetail(null);
        }
        return;
      }
      setOrderDetail(((data as unknown) as OrderRow) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orders.loadError'));
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
    setSelectedId(id);
    router.push(`/seller/orders?id=${id}`);
  }

  function closeDetail() {
    setSelectedId(null);
    router.push('/seller/orders');
  }

  async function handleCancel(orderId: string) {
    if (!(await ensureActive())) return;
    setCancelLoading(true);
    setError(null);
    try {
      const { error: e } = await supabase.rpc('cancel_order', { p_order_id: orderId });
      if (e) {
        if (isSessionError(e)) {
          signOut(t('auth.sessionExpired'));
          return;
        }
        setError(e.message);
        return;
      }
      void logAction(supabase, {
        user_id: profile?.id ?? null,
        user_name: profile?.display_name ?? null,
        user_role: profile?.role ?? 'seller',
        action: 'order_cancel',
        entity_type: 'order',
        entity_id: orderId,
      });
      await loadOrders();
      await loadOrderDetail(orderId);
    } finally {
      setCancelLoading(false);
    }
  }

  const items = orderDetail?.order_items ?? [];

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <div className="p-3 sm:p-4 w-full max-w-full min-w-0">
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <Link href="/seller" className="text-blue-600 font-medium text-sm">
              {t('common.back')}
            </Link>
          </div>

          <h1 className="text-lg sm:text-2xl font-bold mb-3 sm:mb-4 text-gray-900">{t('orders.title')}</h1>

          <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-3 sm:mb-4">
            <button
              onClick={() => setTab('day')}
              className={`min-h-[44px] px-3 py-2 rounded-lg text-sm ${tab === 'day' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              {t('orders.today')}
            </button>
            <button
              onClick={() => setTab('week')}
              className={`min-h-[44px] px-3 py-2 rounded-lg text-sm ${tab === 'week' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              {t('orders.week')}
            </button>
            <button
              onClick={() => setTab('month')}
              className={`min-h-[44px] px-3 py-2 rounded-lg text-sm ${tab === 'month' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              {t('orders.month')}
            </button>
          </div>

          {error && <div className="mb-3 text-red-600 text-sm">{error}</div>}

          {loading ? (
            <div className="text-sm text-gray-900">{t('common.loading')}</div>
          ) : !profile ? (
            <div className="text-sm text-gray-900">{t('common.noProfile')}</div>
          ) : orders.length === 0 ? (
            <div className="text-sm text-gray-600">{t('orders.noData')}</div>
          ) : (
            <div className="space-y-2">
              {orders.map((o) => (
                <div
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openOrder(o.id)}
                  onKeyDown={(e) => e.key === 'Enter' && openOrder(o.id)}
                  className="border border-gray-200 rounded-xl p-3 sm:p-4 bg-white cursor-pointer w-full max-w-full min-w-0"
                >
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs sm:text-sm text-gray-600">{formatDate(o.created_at)}</div>
                      <div className="text-xs sm:text-sm text-gray-600">
                        {o.debt_status === 'paid' && (o.payment_type === 'debt' || !o.payment_type) ? o.debt_payment_method ?? '—' : o.payment_type ?? '—'}
                      </div>
                      <div className="text-xs sm:text-sm text-gray-700 mt-1">{t('orders.orderOnAmount')} {formatMoney(o.total_sum ?? 0)} ₸</div>
                      {o.status === 'canceled' && (
                        <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                          {t('orders.canceled')}
                        </span>
                      )}
                      {o.is_preorder === true && o.payment_type !== 'debt' && !o.is_debt && (
                        <span className="inline-block mt-1 ml-1 text-xs text-gray-500">{t('orders.preorderBadge')}</span>
                      )}
                      {(o.is_debt === true || o.payment_type === 'debt') && (
                        <span className="inline-block mt-1 ml-1 text-xs text-orange-600">
                          {o.debt_status === 'paid' ? t('orders.debtBadgePaid') : t('orders.debtBadge')}
                        </span>
                      )}
                    </div>
                    <div className="font-bold text-green-700 whitespace-nowrap text-sm sm:text-base shrink-0">{formatMoney(o.total_sum ?? 0)} ₸</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {detailOpen && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-3 sm:p-4 z-50" onClick={closeDetail}>
              <div className="bg-white rounded-2xl p-4 sm:p-6 w-full max-w-lg max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
                {detailLoading ? (
                  <div className="text-sm">{t('orders.detailLoading')}</div>
                ) : !orderDetail ? (
                  <div className="text-red-600 text-sm">{t('orders.loadFailed')}</div>
                ) : (
                  <>
                    <div className="text-base sm:text-xl font-bold mb-3 sm:mb-4 text-gray-900">{t('common.order')} {formatDate(orderDetail.created_at)}</div>
                    {orderDetail.status === 'canceled' && (
                      <div className="mb-2">
                        <span className="inline-block px-2 py-1 text-xs sm:text-sm font-medium bg-red-100 text-red-700 rounded">
                          {t('orders.canceled')}
                        </span>
                      </div>
                    )}
                    {orderDetail.is_preorder === true && !orderDetail.is_debt && orderDetail.payment_type !== 'debt' && (
                      <div className="mb-2">
                        <span className="inline-block px-2 py-1 text-xs sm:text-sm font-bold bg-amber-100 text-amber-800 rounded">
                          {orderDetail.preorder_status === 'fulfilled' ? t('orders.preorderFulfilled') : t('orders.preorder')}
                        </span>
                      </div>
                    )}
                    {(orderDetail.is_debt === true || orderDetail.payment_type === 'debt') && (
                      <div className="mb-2">
                        <span className="inline-block px-2 py-1 text-xs sm:text-sm font-bold bg-orange-100 text-orange-800 rounded">
                          {orderDetail.debt_status === 'paid' ? t('orders.debtPaid') : t('orders.debt')}
                        </span>
                      </div>
                    )}
                    <div className="mb-2 text-sm text-gray-900">{t('common.amountLabel')}: {formatMoney(orderDetail.total_sum ?? 0)} ₸</div>
                    <div className="mb-4 text-sm text-gray-900">
                      {t('common.payment')}:{' '}
                      {orderDetail.debt_status === 'paid' && (orderDetail.payment_type === 'debt' || !orderDetail.payment_type)
                        ? orderDetail.debt_payment_method ?? '—'
                        : orderDetail.payment_type ?? '—'}
                    </div>
                    <div className="space-y-2 mb-4">
                      {items.length > 0 ? (
                        items.map((it, idx) => (
                          <div key={idx} className="text-xs sm:text-sm text-gray-900">
                            {it.product?.name ?? it.product_name_snapshot ?? t('common.product')} × {it.qty}
                            {it.is_gift ? ` ${t('common.gift')}` : ` = ${formatMoney((it.line_sum ?? (it.price ?? 0) * (it.qty ?? 0)))} ₸`}
                          </div>
                        ))
                      ) : (
                        <div className="text-gray-600 text-xs sm:text-sm">{t('common.noItems')}</div>
                      )}
                    </div>
                    {orderDetail.status !== 'canceled' && (
                      <button
                        onClick={() => handleCancel(orderDetail.id)}
                        disabled={cancelLoading}
                        className="w-full py-3 rounded-lg bg-red-600 text-white font-bold disabled:opacity-60 min-h-[48px] text-sm"
                      >
                        {cancelLoading ? t('common.canceling') : t('common.cancelOrder')}
                      </button>
                    )}
                  </>
                )}
                <button onClick={closeDetail} className="w-full py-3 rounded-lg bg-gray-200 mt-2 min-h-[48px] text-sm">
                  {t('common.close')}
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
