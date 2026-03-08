'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import { supabase } from '@/lib/supabaseClient';
import { fulfillPreorder } from '@/lib/fulfillPreorder';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';
import { useTranslation } from '@/lib/i18n';
import { useEnsureActiveDevice } from '@/lib/useEnsureActiveDevice';
import { logAction } from '@/lib/actionLog';
import type { Order, PreorderStatus } from '@/lib/types';
import type { City } from '@/lib/types';

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

export default function SellerPreordersPage() {
  const { profile, authReady, signOut } = useAuth();
  const { t } = useTranslation();
  const ensureActive = useEnsureActiveDevice();
  const [orders, setOrders] = useState<Order[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [filterPreorderStatus, setFilterPreorderStatus] = useState<PreorderStatus | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [fulfillingId, setFulfillingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preorderColumnsMissing, setPreorderColumnsMissing] = useState(false);

  function isPreorderColumnError(err: { message?: string } | null): boolean {
    const msg = String(err?.message ?? '');
    return msg.includes('is_preorder') || msg.includes('does not exist');
  }

  useEffect(() => {
    supabase.from('cities').select('*').then(({ data }) => setCities(data || []));
  }, []);

  useEffect(() => {
    if (!authReady || !profile?.id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      let q = supabase
        .from('orders')
        .select('*')
        .eq('seller_id', profile.id)
        .eq('is_preorder', true)
        .neq('status', 'canceled')
        .order('created_at', { ascending: false });
      if (filterPreorderStatus) q = q.eq('preorder_status', filterPreorderStatus);
      const { data, err } = await q;
      if (cancelled) return;
      if (err) {
        if (isSessionError(err)) {
          signOut(t('auth.sessionExpired'));
          return;
        }
        if (isPreorderColumnError(err)) {
          setPreorderColumnsMissing(true);
          setOrders([]);
          setError(null);
        } else {
          setError(err.message);
          setOrders([]);
        }
      } else {
        setPreorderColumnsMissing(false);
        setOrders((data as Order[]) || []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [authReady, profile?.id, filterPreorderStatus, signOut]);

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

  async function handleFulfill(orderId: string) {
    if (!profile?.id) return;
    if (!(await ensureActive())) return;
    setFulfillingId(orderId);
    setError(null);
    const { error: rpcError } = await supabase.rpc('fulfill_preorder', { p_order_id: orderId });
    if (rpcError) {
      if (rpcError.message?.includes('Could not find the function') || rpcError.message?.includes('not find')) {
        const result = await fulfillPreorder(supabase, orderId, profile.id);
        setFulfillingId(null);
        if (result.success) {
          void logAction(supabase, {
            user_id: profile?.id ?? null,
            user_name: profile?.display_name ?? null,
            user_role: profile?.role ?? 'seller',
            action: 'preorder_fulfill',
            entity_type: 'order',
            entity_id: orderId,
          });
          const now = new Date().toISOString();
          setOrders((prev) =>
            prev.map((o) =>
              o.id === orderId ? { ...o, preorder_status: 'fulfilled' as const, fulfilled_at: now } : o
            )
          );
          if (orderDetail?.id === orderId)
            setOrderDetail((d) => (d ? { ...d, preorder_status: 'fulfilled', fulfilled_at: now } : null));
          alert('Выдано');
          return;
        }
        setError(result.error ?? 'Недостаточно остатков на складе');
        return;
      }
      setFulfillingId(null);
      setError(rpcError.message?.includes('Insufficient') ? 'Недостаточно остатков на складе' : rpcError.message);
      return;
    }
    setFulfillingId(null);
    const now = new Date().toISOString();
    void logAction(supabase, {
      user_id: profile?.id ?? null,
      user_name: profile?.display_name ?? null,
      user_role: profile?.role ?? 'seller',
      action: 'preorder_fulfill',
      entity_type: 'order',
      entity_id: orderId,
    });
    setOrders((prev) =>
      prev.map((o) =>
        o.id === orderId ? { ...o, preorder_status: 'fulfilled' as const, fulfilled_at: now } : o
      )
    );
    if (orderDetail?.id === orderId)
      setOrderDetail((d) => (d ? { ...d, preorder_status: 'fulfilled', fulfilled_at: now } : null));
    alert('Выдано');
  }

  const cityMap = new Map(cities.map((c) => [c.id, c.name]));

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <div className="p-3 sm:p-4 w-full max-w-full min-w-0">
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <Link href="/seller" className="text-blue-600 font-medium text-sm">
              {t('common.back')}
            </Link>
          </div>
          <h1 className="text-lg sm:text-2xl font-bold mb-3 sm:mb-4 text-gray-900">{t('preorders.title')}</h1>

          <div className="flex flex-wrap gap-2 mb-4">
            <select
              value={filterPreorderStatus}
              onChange={(e) => setFilterPreorderStatus((e.target.value || '') as PreorderStatus | '')}
              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
            >
              <option value="">{t('common.all')}</option>
              <option value="pending">{t('preorders.status.pending')}</option>
              <option value="fulfilled">{t('preorders.status.fulfilled')}</option>
              <option value="cancelled">{t('preorders.status.cancelled')}</option>
            </select>
          </div>

          {error && <p className="mb-3 text-red-600">{error}</p>}
          {preorderColumnsMissing && (
            <p className="mb-3 text-amber-700 bg-amber-50 px-3 py-2 rounded text-sm">
              {t('preorders.dbMissing')}
            </p>
          )}

          {loading ? (
            <p className="text-sm text-gray-900">{t('common.loading')}</p>
          ) : (
            <>
              <div className="hidden md:block border border-gray-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-2 text-left">{t('common.date')}</th>
                      <th className="p-2 text-left">{t('common.city')}</th>
                      <th className="p-2 text-right">{t('common.amount')}</th>
                      <th className="p-2 text-left">{t('common.pickupDate')}</th>
                      <th className="p-2 text-left">{t('common.status')}</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id} className="border-t">
                        <td className="p-2">{formatDate(o.created_at)}</td>
                        <td className="p-2">{cityMap.get(o.city_id) || o.city_id}</td>
                        <td className="p-2 text-right">{formatMoney(Number(o.total_sum))} ₸</td>
                        <td className="p-2">
                          {o.pickup_date ? new Date(o.pickup_date).toLocaleDateString('ru-KZ') : '—'}
                        </td>
                        <td className="p-2">
                          {(o.preorder_status ?? '') === 'pending' && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded">
                              {t('preorders.status.pending')}
                            </span>
                          )}
                          {(o.preorder_status ?? '') === 'fulfilled' && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded">
                              {t('preorders.status.fulfilled')}
                            </span>
                          )}
                          {(o.preorder_status ?? '') === 'cancelled' && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                              {t('preorders.status.cancelled')}
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          <button onClick={() => setSelectedId(o.id)} className="text-blue-600">
                            {t('common.details')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden space-y-2">
                {orders.map((o) => (
                  <div key={o.id} className="border rounded-lg p-3 bg-white">
                    <div className="text-xs text-gray-500 mb-1">{formatDate(o.created_at)}</div>
                    <div className="flex justify-between items-center mb-1">
                      <div className="text-sm font-medium">
                        {cityMap.get(o.city_id) || o.city_id}
                      </div>
                      <div className="text-sm font-bold">{formatMoney(Number(o.total_sum))} ₸</div>
                    </div>
                    <div className="text-xs text-gray-600">
                      {t('common.pickupDate')}:&nbsp;
                      {o.pickup_date ? new Date(o.pickup_date).toLocaleDateString('ru-KZ') : '—'}
                    </div>
                    <div className="mt-1">
                      {(o.preorder_status ?? '') === 'pending' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded">
                          {t('preorders.status.pending')}
                        </span>
                      )}
                      {(o.preorder_status ?? '') === 'fulfilled' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded">
                          {t('preorders.status.fulfilled')}
                        </span>
                      )}
                      {(o.preorder_status ?? '') === 'cancelled' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                          {t('preorders.status.cancelled')}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex justify-end">
                      <button
                        onClick={() => setSelectedId(o.id)}
                        className="text-blue-600 text-sm font-medium"
                      >
                        {t('common.details')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {orders.length === 0 && !loading && (
            <p className="mt-4 text-gray-500">{t('preorders.none')}</p>
          )}

          {orderDetail && (
            <div
              className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
              onClick={() => setSelectedId(null)}
            >
              <div
                className="bg-white rounded-xl p-4 sm:p-6 max-w-md w-full max-h-[85vh] overflow-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="font-bold mb-2 text-sm sm:text-base">{t('preorders.modalTitle')} {orderDetail.id.slice(0, 8)}</h2>
                <div className="mb-2">
                  <span className="inline-block px-2 py-1 text-xs sm:text-sm font-bold bg-amber-100 text-amber-800 rounded">
                    {(orderDetail.preorder_status ?? '') === 'fulfilled' ? t('orders.preorderFulfilled') : t('orders.preorder')}
                  </span>
                </div>
                <p className="text-sm">{t('common.date')}: {formatDate(orderDetail.created_at)}</p>
                <p className="text-sm">{t('common.city')}: {cityMap.get(orderDetail.city_id)}</p>
                <p className="text-sm">{t('common.amountLabel')}: {formatMoney(orderDetail.total_sum)} ₸</p>
                <p className="text-sm">{t('preorders.planPickup')}: {orderDetail.pickup_date ? new Date(orderDetail.pickup_date).toLocaleDateString('ru-KZ') : '—'}</p>
                {orderDetail.fulfilled_at && <p className="text-sm">{t('preorders.issuedAt')}: {formatDate(orderDetail.fulfilled_at)}</p>}
                <div className="mt-2 space-y-1">
                  {orderDetail.order_items?.map((item) => (
                    <div key={item.id} className="text-sm">
                      {item.product_name_snapshot} × {item.qty}
                      {item.is_gift ? ` ${t('common.gift')}` : ` = ${formatMoney(item.line_sum ?? 0)} ₸`}
                    </div>
                  ))}
                </div>
                {(orderDetail.preorder_status ?? '') === 'pending' && (
                  <button
                    onClick={() => handleFulfill(orderDetail.id)}
                    disabled={fulfillingId === orderDetail.id}
                    className="mt-4 w-full py-2.5 bg-green-600 text-white rounded-lg disabled:opacity-50 min-h-[44px] text-sm"
                  >
                    {fulfillingId === orderDetail.id ? t('preorders.processing') : t('preorders.clientReceived')}
                  </button>
                )}
                <button
                  onClick={() => setSelectedId(null)}
                  className="mt-2 w-full py-2.5 bg-gray-300 rounded-lg min-h-[44px] text-sm"
                >
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
