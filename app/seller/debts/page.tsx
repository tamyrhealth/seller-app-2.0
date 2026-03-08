'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';
import { useTranslation } from '@/lib/i18n';
import { useEnsureActiveDevice } from '@/lib/useEnsureActiveDevice';
import { logAction } from '@/lib/actionLog';
import type { Order } from '@/lib/types';
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

type DebtStatusFilter = 'active' | 'paid' | '';

export default function SellerDebtsPage() {
  const { profile, authReady, signOut } = useAuth();
  const { t } = useTranslation();
  const ensureActive = useEnsureActiveDevice();
  const [orders, setOrders] = useState<Order[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [filterStatus, setFilterStatus] = useState<DebtStatusFilter>(''); // по умолчанию показываем все долги
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

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
      // Основная загрузка: все заказы продавца, фильтрация долгов на клиенте
      const { data: allRows, error: err } = await supabase
        .from('orders')
        .select('id, created_at, total_sum, city_id, status, is_debt, payment_type, debt_status, debt_paid_at, debt_customer_phone')
        .eq('seller_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancelled) return;
      if (err) {
        if (isSessionError(err)) {
          signOut(t('auth.sessionExpired'));
          return;
        }
        setError(err.message);
        setOrders([]);
        setLoading(false);
        return;
      }
      const list = (allRows || []) as Order[];
      // Долг = (is_debt = true OR payment_type = 'debt') И НЕ отменён
      const debts = list.filter(
        (o) =>
          (o.is_debt === true || (o as Order & { payment_type?: string }).payment_type === 'debt') &&
          (o as Order & { status?: string }).status !== 'canceled'
      );
      // По фильтру: Активные / Все / Погашенные
      // активные = debt_status='active' или debt_paid_at is null
      // закрытые = debt_status='paid' или debt_paid_at not null
      let filtered = debts;
      if (filterStatus === 'active') {
        filtered = debts.filter(
          (o) =>
            (o.debt_status === 'active' || o.debt_status == null) &&
            !o.debt_paid_at
        );
      } else if (filterStatus === 'paid') {
        filtered = debts.filter(
          (o) => o.debt_status === 'paid' || (o.debt_paid_at != null && o.debt_paid_at !== '')
        );
      }
      setOrders(filtered);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [authReady, profile?.id, filterStatus, signOut]);

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

  async function handleMarkPaid(orderId: string) {
    if (!profile?.id) return;
    if (!(await ensureActive())) return;
    setPayingId(orderId);
    setError(null);

    const { data: freshOrder, error: fetchErr } = await supabase
      .from('orders')
      .select('id, is_debt, payment_type, status, debt_customer_phone, debt_status, debt_paid_at')
      .eq('id', orderId)
      .single();

    if (fetchErr || !freshOrder) {
      setPayingId(null);
      setError(fetchErr?.message ?? 'Заказ не найден');
      return;
    }

    const order = freshOrder as Order & { payment_type?: string; status?: string };
    if (order.status === 'canceled') {
      setPayingId(null);
      setError('Заказ отменён, закрыть долг нельзя');
      return;
    }

    // Попробуем достать телефон из разных возможных полей
    let phone =
      (order.debt_customer_phone as string | null | undefined) ??
      ((order as any).customer_phone as string | null | undefined) ??
      ((order as any).customer_phone_number as string | null | undefined) ??
      null;
    phone = phone ? phone.toString().trim() : '';

    if (!phone) {
      // Если телефона нет — спросим у пользователя
      const entered = window.prompt(
        'Телефон не найден в долге. Введите телефон клиента, чтобы закрыть долг:',
        ''
      );
      if (!entered || !entered.trim()) {
        setPayingId(null);
        setError('Телефон не указан, долг не закрыт');
        return;
      }
      phone = entered.trim();
      const { error: phoneErr } = await supabase
        .from('orders')
        .update({
          debt_customer_phone: phone,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);
      if (phoneErr) {
        setPayingId(null);
        setError(phoneErr.message);
        return;
      }
    }

    const method = (paymentMethod && paymentMethod.trim() ? paymentMethod.trim() : 'cash') as string;
    const normalizedMethod = method === 'cash' || method === 'kaspi' ? method : 'cash';

    // Перед RPC: страховка — для старых записей (payment_type='debt', is_debt=false) ставим is_debt=true
    if ((order as Order & { payment_type?: string }).payment_type === 'debt' && order.is_debt !== true) {
      const { error: fixErr } = await supabase
        .from('orders')
        .update({ is_debt: true, updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .eq('payment_type', 'debt');
      if (fixErr) {
        setPayingId(null);
        setError(fixErr.message);
        return;
      }
    } else if (order.is_debt !== true) {
      // Дополнительно: если всё ещё не долг — проставить is_debt, debt_status, телефон
      const { error: fixErr } = await supabase
        .from('orders')
        .update({
          is_debt: true,
          debt_status: order.debt_status && order.debt_status !== 'paid' ? order.debt_status : 'active',
          debt_customer_phone: phone,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);
      if (fixErr) {
        setPayingId(null);
        setError(fixErr.message);
        return;
      }
    }

    const { error: rpcError } = await supabase.rpc('mark_debt_paid', {
      p_order_id: orderId,
      p_payment_method: normalizedMethod,
    });

    if (rpcError) {
      // Fallback: прямой update, если RPC падает (например "Order is not a debt" для старых записей)
      if (rpcError.message?.includes('Order is not a debt')) {
        const { error: updErr } = await supabase
          .from('orders')
          .update({
            debt_status: 'paid',
            debt_paid_at: new Date().toISOString(),
            debt_payment_method: normalizedMethod,
            payment_type: normalizedMethod,
            updated_at: new Date().toISOString(),
          })
          .eq('id', orderId);
        setPayingId(null);
        if (updErr) {
          setError(updErr.message);
          return;
        }
      } else {
        setPayingId(null);
        setError(rpcError.message);
        return;
      }
    } else {
      setPayingId(null);
      // RPC не обновляет payment_type — дополнительный update
      await supabase
        .from('orders')
        .update({
          payment_type: normalizedMethod,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);
    }

    void logAction(supabase, {
      user_id: profile?.id ?? null,
      user_name: profile?.display_name ?? null,
      user_role: profile?.role ?? 'seller',
      action: 'debt_pay',
      entity_type: 'order',
      entity_id: orderId,
      details: { payment_method: normalizedMethod },
    });
    setOrders((prev) =>
      prev.map((o) =>
        o.id === orderId
          ? {
              ...o,
              debt_status: 'paid' as const,
              debt_paid_at: new Date().toISOString(),
              payment_type: normalizedMethod,
              debt_customer_phone: phone,
            }
          : o
      )
    );
    if (orderDetail?.id === orderId) {
      setOrderDetail((d) =>
        d
          ? {
              ...d,
              debt_status: 'paid',
              debt_paid_at: new Date().toISOString(),
              payment_type: normalizedMethod,
              debt_customer_phone: phone,
            }
          : null
      );
    }
    setPaymentMethod('');
  }

  const cityMap = new Map(cities.map((c) => [c.id, c.name]));

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <div className="p-3 sm:p-4 w-full max-w-full min-w-0">
          <div className="flex items-center gap-2 mb-4">
            <Link href="/seller" className="text-blue-600 font-medium">
              {t('common.back')}
            </Link>
          </div>
          <h1 className="text-lg sm:text-2xl font-bold mb-3 sm:mb-4 text-gray-900">{t('debts.title')}</h1>

          <div className="flex flex-wrap gap-2 mb-4">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus((e.target.value || '') as DebtStatusFilter)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
            >
              <option value="">{t('common.all')}</option>
              <option value="active">{t('debts.active')}</option>
              <option value="paid">{t('debts.paid')}</option>
            </select>
          </div>

          {error && <p className="mb-3 text-red-600">{error}</p>}

          {loading ? (
            <p className="text-sm text-gray-900">{t('common.loading')}</p>
          ) : (
            <>
              <div className="hidden md:block border border-gray-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-2 text-left">{t('common.date')}</th>
                      <th className="p-2 text-left">{t('common.client')}</th>
                      <th className="p-2 text-right">{t('common.amount')}</th>
                      <th className="p-2 text-left">{t('common.status')}</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id} className="border-t">
                        <td className="p-2">{formatDate(o.created_at)}</td>
                        <td className="p-2">{o.debt_customer_phone || '—'}</td>
                        <td className="p-2 text-right">{formatMoney(Number(o.total_sum))} ₸</td>
                        <td className="p-2">
                          {((o.debt_status ?? '') === 'active' ||
                            (o.debt_status == null && (o.is_debt || o.payment_type === 'debt'))) && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 rounded">
                              {t('debts.status.active')}
                            </span>
                          )}
                          {(o.debt_status ?? '') === 'paid' && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded">
                              {t('debts.status.paid')}
                            </span>
                          )}
                          {(o.debt_status ?? '') === 'written_off' && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 rounded">
                              {t('debts.status.written_off')}
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
                      <div className="text-sm font-medium">{o.debt_customer_phone || '—'}</div>
                      <div className="text-sm font-bold">{formatMoney(Number(o.total_sum))} ₸</div>
                    </div>
                    <div className="mt-1">
                      {((o.debt_status ?? '') === 'active' ||
                        (o.debt_status == null && (o.is_debt || o.payment_type === 'debt'))) && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 rounded">
                          {t('debts.status.active')}
                        </span>
                      )}
                      {(o.debt_status ?? '') === 'paid' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded">
                          {t('debts.status.paid')}
                        </span>
                      )}
                      {(o.debt_status ?? '') === 'written_off' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 rounded">
                          {t('debts.status.written_off')}
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
            <p className="mt-4 text-gray-500">{t('debts.none')}</p>
          )}

          <button
            type="button"
            onClick={async () => {
              if (!profile?.id) return;
              const { data, error } = await supabase
                .from('orders')
                .select('id, created_at, total_sum, payment_type, is_debt, debt_status, debt_customer_phone')
                .eq('seller_id', profile.id)
                .order('created_at', { ascending: false })
                .limit(20);
              console.log('Долги: сырые данные (последние 20 заказов продавца)', { rows: data, error });
            }}
            className="mt-2 text-sm text-gray-500 underline"
          >
            Показать сырые данные в консоль
          </button>

          {orderDetail && (
            <div
              className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
              onClick={() => setSelectedId(null)}
            >
              <div
                className="bg-white rounded-xl p-4 sm:p-6 max-w-md w-full max-h-[85vh] overflow-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="font-bold mb-2 text-sm sm:text-base">{t('debts.modalTitle')} {orderDetail.id.slice(0, 8)}</h2>
                <div className="mb-2">
                  {(orderDetail as Order & { status?: string }).status === 'canceled' ? (
                    <span className="inline-block px-2 py-1 text-xs sm:text-sm font-bold bg-red-100 text-red-800 rounded">
                      {t('orders.canceled')}
                    </span>
                  ) : (
                    <span className="inline-block px-2 py-1 text-xs sm:text-sm font-bold bg-orange-100 text-orange-800 rounded">
                      {(orderDetail.debt_status ?? '') === 'paid' ? t('debts.debtPaid') : t('debts.debt')}
                    </span>
                  )}
                </div>
                <p className="text-sm">{t('common.date')}: {formatDate(orderDetail.created_at)}</p>
                <p className="text-sm">{t('common.city')}: {cityMap.get(orderDetail.city_id)}</p>
                <p className="text-sm">{t('common.client')}: {orderDetail.debt_customer_phone || '—'}</p>
                <p className="text-sm">{t('common.amountLabel')}: {formatMoney(orderDetail.total_sum)} ₸</p>
                {orderDetail.debt_paid_at && (
                  <p className="text-sm">{t('debts.paidAt')}: {formatDate(orderDetail.debt_paid_at)}</p>
                )}
                <div className="mt-2 space-y-1">
                  {orderDetail.order_items?.map((item) => (
                    <div key={item.id} className="text-sm">
                      {item.product_name_snapshot} × {item.qty}
                      {item.is_gift ? ` ${t('common.gift')}` : ` = ${formatMoney(item.line_sum ?? 0)} ₸`}
                    </div>
                  ))}
                </div>
                {((orderDetail.debt_status ?? '') !== 'paid' &&
                  (orderDetail.is_debt || orderDetail.payment_type === 'debt') &&
                  (orderDetail as Order & { status?: string }).status !== 'canceled') && (
                  <>
                    <div className="mt-3">
                      <label className="block text-sm font-medium mb-1">{t('debts.payMethodLabel')}</label>
                      <select
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg min-h-[44px]"
                      >
                        <option value="cash">{t('common.cash')}</option>
                        <option value="kaspi">{t('common.kaspi')}</option>
                      </select>
                    </div>
                    <button
                      onClick={() => handleMarkPaid(orderDetail.id)}
                      disabled={payingId === orderDetail.id}
                      className="mt-4 w-full py-2.5 bg-green-600 text-white rounded-lg disabled:opacity-50 min-h-[44px] text-sm"
                    >
                      {payingId === orderDetail.id ? t('debts.payProcessing') : t('debts.payButton')}
                    </button>
                  </>
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
