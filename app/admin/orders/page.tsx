'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabaseClient';
import { fulfillPreorder } from '@/lib/fulfillPreorder';
import {
  getAccountingDate,
  getRecognizedAt,
  isConfirmedInRange,
  buildLocalDayRange,
  buildRange,
  parseDateStr,
} from '@/lib/accounting';
import { getTodayLocalISO } from '@/lib/datetime';
import type { Order, PreorderStatus } from '@/lib/types';
import type { City } from '@/lib/types';
import type { Profile } from '@/lib/types';
import { logAction } from '@/lib/actionLog';
import { useTranslation } from '@/lib/i18n';
import { useEnsureActiveDevice } from '@/lib/useEnsureActiveDevice';

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

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Наличные',
  kaspi: 'Kaspi QR',
  card: 'Карта',
  transfer: 'Перевод',
  debt: 'В долг',
};

function formatPaymentType(pt: string | null | undefined): string {
  if (!pt) return '—';
  return PAYMENT_LABELS[pt] ?? pt;
}

function firstDayOfMonthISO() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

export default function AdminOrdersPage() {
  const { profile } = useAuth();
  const { t } = useTranslation();
  const ensureActive = useEnsureActiveDevice();
  const [orders, setOrders] = useState<Order[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [filterCity, setFilterCity] = useState('');
  const [filterSeller, setFilterSeller] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [startDate, setStartDate] = useState(firstDayOfMonthISO);
  const [endDate, setEndDate] = useState(() => getTodayLocalISO('Asia/Almaty'));
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewMode, setViewMode] = useState<'all' | 'preorders' | 'debts'>('all');
  const [filterPreorderStatus, setFilterPreorderStatus] = useState<PreorderStatus | ''>('');
  const [filterDebtStatus, setFilterDebtStatus] = useState<string>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [fulfillingId, setFulfillingId] = useState<string | null>(null);
  const [payingDebtId, setPayingDebtId] = useState<string | null>(null);
  const [debtPaymentMethod, setDebtPaymentMethod] = useState<string>('');
  const [preorderColumnsMissing, setPreorderColumnsMissing] = useState(false);
  const [periodRevenue, setPeriodRevenue] = useState<number>(0);

  function isPreorderColumnError(err: { message?: string } | null): boolean {
    const msg = String(err?.message ?? '');
    return msg.includes('is_preorder') || msg.includes('preorder_status') || msg.includes('does not exist');
  }
  function isDebtColumnError(err: { message?: string } | null): boolean {
    const msg = String(err?.message ?? '');
    return msg.includes('is_debt') || msg.includes('debt_status') || msg.includes('does not exist');
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      console.log('SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
    }
  }, []);

  useEffect(() => {
    supabase.from('cities').select('*').then(({ data }) => setCities(data || []));
    supabase.from('profiles').select('*').eq('role', 'seller').then(({ data }) => setProfiles(data || []));
  }, []);

  const fromParts = parseDateStr(startDate);
  const toParts = parseDateStr(endDate);
  const dateRangeInvalid =
    !fromParts || !toParts || new Date(fromParts.y, fromParts.m - 1, fromParts.d) > new Date(toParts.y, toParts.m - 1, toParts.d);

  useEffect(() => {
    const range = buildRange(startDate, endDate);
    if (!range || dateRangeInvalid) {
      setPeriodRevenue(0);
      return;
    }
    const fromISO = range.from.toISOString();
    const toNextISO = range.toNext.toISOString();
    if (process.env.NODE_ENV !== 'production') {
      console.log('[admin/orders] period: fromStr=', startDate, 'toStr=', endDate, 'range.from=', fromISO, 'range.toNext=', toNextISO);
    }
    (async () => {
      const baseSelect = 'id, created_at, total_sum, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, debt_payment_method';
      const addFilters = (q: any) => {
        let r = q.select(baseSelect);
        if (filterCity?.trim()) r = r.eq('city_id', filterCity);
        if (filterSeller?.trim()) r = r.eq('seller_id', filterSeller);
        return r;
      };
      const [createdRes, fulfilledRes, debtPaidRes] = await Promise.all([
        addFilters(supabase.from('orders')).gte('created_at', fromISO).lt('created_at', toNextISO),
        addFilters(supabase.from('orders')).gte('fulfilled_at', fromISO).lt('fulfilled_at', toNextISO),
        addFilters(supabase.from('orders')).gte('debt_paid_at', fromISO).lt('debt_paid_at', toNextISO),
      ]);
      const seen = new Set<string>();
      const allRows: Order[] = [];
      for (const row of [...(createdRes.data || []), ...(fulfilledRes.data || []), ...(debtPaidRes.data || [])]) {
        const o = row as Order;
        if (!seen.has(o.id)) {
          seen.add(o.id);
          allRows.push(o);
        }
      }
      const confirmedOrders = allRows.filter((o) => isConfirmedInRange(o, range));
      const confirmedSum = confirmedOrders.reduce((s, o) => s + Number(o.total_sum ?? 0), 0);

      if (process.env.NODE_ENV !== 'production' && allRows.length > 0) {
        const recognized = allRows.filter((o) => getRecognizedAt(o) != null);
        const activeDebts = allRows.filter((o) => (o.is_debt || o.payment_type === 'debt') && o.debt_status === 'active');
        const paidDebts = allRows.filter((o) => (o.is_debt || o.payment_type === 'debt') && o.debt_status === 'paid');
        const fulfilledPreorders = allRows.filter((o) => o.is_preorder && o.preorder_status === 'fulfilled');
        console.log('[admin/orders] period sum:', {
          totalRows: allRows.length,
          recognizedRows: recognized.length,
          sumRecognized: confirmedSum,
          activeDebtCount: activeDebts.length,
          paidDebtCount: paidDebts.length,
          fulfilledPreorderCount: fulfilledPreorders.length,
        });
      }
      setPeriodRevenue(confirmedSum);
    })();
  }, [startDate, endDate, dateRangeInvalid, filterCity, filterSeller, refreshKey]);

  useEffect(() => {
    if (dateRangeInvalid || !fromParts || !toParts) {
      setOrders([]);
      setLoading(false);
      return;
    }

    async function load() {
      setLoading(true);
      const fp = fromParts!;
      const tp = toParts!;
      const from = new Date(fp.y, fp.m - 1, fp.d, 0, 0, 0, 0);
      const toNext = new Date(tp.y, tp.m - 1, tp.d, 0, 0, 0, 0);
      toNext.setDate(toNext.getDate() + 1);
      const fromISO = from.toISOString();
      const toNextISO = toNext.toISOString();

      const applyFilters = (q: any) => {
        if (filterCity?.trim()) q = q.eq('city_id', filterCity);
        if (filterSeller?.trim()) q = q.eq('seller_id', filterSeller);
        if (filterStatus?.trim()) q = q.eq('status', filterStatus);
        return q;
      };

      if (viewMode === 'all') {
        const q = applyFilters(supabase.from('orders').select('*'))
          .gte('created_at', fromISO)
          .lt('created_at', toNextISO);
        const { data } = await q;
        const allRows = ((data || []) as Order[]).sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setOrders(allRows);
        setPreorderColumnsMissing(false);
      } else if (viewMode === 'preorders') {
        let q = supabase
          .from('orders')
          .select('*')
          .eq('is_preorder', true)
          .gte('created_at', fromISO)
          .lt('created_at', toNextISO);
        q = applyFilters(q);
        if (filterPreorderStatus?.trim()) q = q.eq('preorder_status', filterPreorderStatus);
        const { data, error: queryError } = await q;
        if (queryError && isPreorderColumnError(queryError)) {
          setPreorderColumnsMissing(true);
          setOrders([]);
        } else {
          const list = ((data || []) as Order[]).sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
          setPreorderColumnsMissing(false);
          setOrders(list);
        }
      } else if (viewMode === 'debts') {
        let q = supabase
          .from('orders')
          .select('*')
          .or('is_debt.eq.true,payment_type.eq.debt')
          .gte('created_at', fromISO)
          .lt('created_at', toNextISO);
        q = applyFilters(q);
        if (filterDebtStatus?.trim() === 'active') {
          q = q.neq('status', 'canceled').eq('debt_status', 'active');
        } else if (filterDebtStatus?.trim() === 'cancelled') {
          q = q.eq('status', 'canceled');
        } else if (filterDebtStatus?.trim()) {
          q = q.eq('debt_status', filterDebtStatus);
        }
        const { data } = await q;
        const list = ((data || []) as Order[]).sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setOrders(list);
      }

      setLoading(false);
    }

    load();
  }, [startDate, endDate, dateRangeInvalid, filterCity, filterSeller, filterStatus, viewMode, filterPreorderStatus, filterDebtStatus, refreshKey]);

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

  async function handleCancel(orderId: string, reason?: string | null) {
    if (!(await ensureActive())) return;
    const { error } = await supabase.rpc('admin_cancel_order', {
      p_order_id: orderId,
      p_reason: reason ?? null,
    });
    if (error) {
      alert(error.message);
      return;
    }
    void logAction(supabase, {
      user_id: profile?.id ?? null,
      user_name: profile?.display_name ?? null,
      user_role: profile?.role ?? 'admin',
      action: 'order_cancel',
      entity_type: 'order',
      entity_id: orderId,
      details: { admin: true },
    });
    setOrders((prev) =>
      prev.map((o) =>
        o.id === orderId
          ? {
              ...o,
              status: 'canceled' as const,
              preorder_status: o.is_preorder ? ('cancelled' as PreorderStatus) : o.preorder_status,
              fulfilled_at: o.is_preorder ? null : o.fulfilled_at,
              debt_paid_at: o.is_debt ? null : o.debt_paid_at,
            }
          : o
      )
    );
    if (orderDetail?.id === orderId) {
      setOrderDetail((d) =>
        d
          ? {
              ...d,
              status: 'canceled',
              preorder_status: d.is_preorder ? 'cancelled' : d.preorder_status,
              fulfilled_at: d.is_preorder ? null : d.fulfilled_at,
              debt_paid_at: d.is_debt ? null : d.debt_paid_at,
            }
          : null
      );
    }
    setSelectedId(null);
    setRefreshKey((k) => k + 1);
  }

  async function handleMarkDebtPaid(orderId: string) {
    if (!(await ensureActive())) return;
    setPayingDebtId(orderId);
    const method = (debtPaymentMethod?.trim() === 'kaspi' ? 'kaspi' : 'cash') as 'cash' | 'kaspi';
    const { error } = await supabase.rpc('mark_debt_paid', { p_order_id: orderId, p_payment_method: method });
    setPayingDebtId(null);
    setDebtPaymentMethod('');
    if (error) {
      alert(error.message);
      return;
    }
    void logAction(supabase, {
      user_id: profile?.id ?? null,
      user_name: profile?.display_name ?? null,
      user_role: profile?.role ?? 'admin',
      action: 'debt_pay',
      entity_type: 'order',
      entity_id: orderId,
      details: { admin: true, payment_method: method },
    });
    setOrders((prev) =>
      prev.map((o) =>
        o.id === orderId
          ? { ...o, debt_status: 'paid' as const, debt_paid_at: new Date().toISOString(), payment_type: method }
          : o
      )
    );
    if (orderDetail?.id === orderId) {
      setOrderDetail((d) =>
        d ? { ...d, debt_status: 'paid', debt_paid_at: new Date().toISOString(), payment_type: method } : null
      );
    }
  }

  async function handleFulfillPreorder(orderId: string) {
    if (!(await ensureActive())) return;
    setFulfillingId(orderId);
    const { error } = await supabase.rpc('fulfill_preorder', { p_order_id: orderId });
    if (error) {
      if (error.message?.includes('Could not find the function') || error.message?.includes('not find')) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.id) {
          const result = await fulfillPreorder(supabase, orderId, user.id);
          setFulfillingId(null);
          if (result.success) {
            void logAction(supabase, {
              user_id: user?.id ?? null,
              user_name: profile?.display_name ?? null,
              user_role: profile?.role ?? 'admin',
              action: 'preorder_fulfill',
              entity_type: 'order',
              entity_id: orderId,
              details: { admin: true },
            });
            const now = new Date().toISOString();
            setOrders((prev) =>
              prev.map((o) => (o.id === orderId ? { ...o, preorder_status: 'fulfilled' as const, fulfilled_at: now } : o))
            );
            if (orderDetail?.id === orderId)
              setOrderDetail((d) => (d ? { ...d, preorder_status: 'fulfilled', fulfilled_at: now } : null));
            alert('Выдано');
            return;
          }
          alert(result.error ?? 'Недостаточно остатков на складе');
          return;
        }
      }
      setFulfillingId(null);
      alert(error.message?.includes('Insufficient') ? 'Недостаточно остатков на складе' : error.message);
      return;
    }
    setFulfillingId(null);
    void logAction(supabase, {
      user_id: profile?.id ?? null,
      user_name: profile?.display_name ?? null,
      user_role: profile?.role ?? 'admin',
      action: 'preorder_fulfill',
      entity_type: 'order',
      entity_id: orderId,
      details: { admin: true },
    });
    const now = new Date().toISOString();
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, preorder_status: 'fulfilled' as const, fulfilled_at: now } : o))
    );
    if (orderDetail?.id === orderId)
      setOrderDetail((d) => (d ? { ...d, preorder_status: 'fulfilled', fulfilled_at: now } : null));
    alert('Выдано');
  }

  const cityMap = new Map(cities.map((c) => [c.id, c.name]));
  const sellerMap = new Map(profiles.map((p) => [p.id, p.display_name || p.id]));

  const orderStatusConfirmed = (o: Order) => String(o?.status ?? '').toLowerCase() === 'confirmed';
  const orderStatusCanceled = (o: Order) => /cancel(l?)ed/i.test(String(o?.status ?? ''));
  const confirmedTotal = periodRevenue;

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-4 text-gray-900">{t('admin.orders')}</h1>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex rounded-lg border border-gray-300 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode('all')}
                className={`px-3 py-2 text-sm font-medium ${viewMode === 'all' ? 'bg-gray-200 text-gray-900' : 'bg-white text-gray-900'}`}
              >
                {t('admin.allOrders')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode('preorders');
                  setFilterPreorderStatus('pending');
                }}
                className={`px-3 py-2 text-sm font-medium ${viewMode === 'preorders' ? 'bg-gray-200 text-gray-900' : 'bg-white text-gray-900'}`}
              >
                {t('admin.preorders')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode('debts');
                  setFilterDebtStatus('active');
                }}
                className={`px-3 py-2 text-sm font-medium ${viewMode === 'debts' ? 'bg-gray-200 text-gray-900' : 'bg-white text-gray-900'}`}
              >
                {t('admin.debts')}
              </button>
            </div>
            <label className="flex items-center gap-1">
              <span className="text-sm text-gray-600">{t('admin.fromDate')}</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-sm text-gray-600">{t('admin.toDate')}</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
              />
            </label>
            <select
              value={filterCity}
              onChange={(e) => setFilterCity(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
            >
              <option value="">{t('admin.allCities')}</option>
              {cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={filterSeller}
              onChange={(e) => setFilterSeller(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
            >
              <option value="">{t('admin.allSellers')}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name || p.id}
                </option>
              ))}
            </select>
            {viewMode === 'all' && (
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
              >
                <option value="">{t('admin.allStatuses')}</option>
                <option value="confirmed">{t('admin.confirmed')}</option>
                <option value="canceled">{t('admin.cancelled')}</option>
              </select>
            )}
            {viewMode === 'preorders' && (
              <select
                value={filterPreorderStatus}
                onChange={(e) => setFilterPreorderStatus(e.target.value as PreorderStatus | '')}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
              >
                <option value="">{t('common.all')}</option>
                <option value="pending">{t('admin.pendingPickup')}</option>
                <option value="fulfilled">{t('admin.fulfilled')}</option>
                <option value="cancelled">{t('admin.preorderCancelled')}</option>
              </select>
            )}
            {viewMode === 'debts' && (
              <select
                value={filterDebtStatus}
                onChange={(e) => setFilterDebtStatus(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-900 bg-white"
              >
                <option value="">{t('common.all')}</option>
                <option value="active">{t('admin.active')}</option>
                <option value="paid">{t('admin.paid')}</option>
                <option value="written_off">{t('admin.writtenOff')}</option>
                <option value="cancelled">{t('admin.debtsCancelled')}</option>
              </select>
            )}
          </div>

          {dateRangeInvalid && (
            <p className="mb-3 text-red-600 font-medium">
              {t('admin.dateRangeInvalid')}
            </p>
          )}

          {preorderColumnsMissing && (
            <p className="mb-3 text-amber-700 bg-amber-50 px-3 py-2 rounded border border-amber-200">
              {t('admin.preorderColumnsMissing')}
            </p>
          )}

          {!loading && !dateRangeInvalid && (
            <p className="mb-3 font-semibold text-gray-900">
              {t('admin.periodConfirmed')} {formatMoney(confirmedTotal)} ₸
            </p>
          )}

          {!loading && orders.length > 0 && (
            <button
              type="button"
              onClick={() => {
                console.log('[admin/orders] Показать сырые данные:', orders.map((o: Order) => ({
                  id: o.id?.slice(0, 8),
                  is_preorder: (o as Order & { is_preorder?: boolean }).is_preorder,
                  preorder_status: (o as Order & { preorder_status?: string }).preorder_status,
                  pickup_date: (o as Order & { pickup_date?: string }).pickup_date,
                })));
              }}
              className="mb-2 text-xs text-gray-500 underline hover:text-gray-700"
            >
              {t('admin.showRawData')}
            </button>
          )}

          <button
            type="button"
            onClick={async () => {
              const { data, error } = await supabase
                .from('orders')
                .select('id, created_at, status, is_preorder, preorder_status, fulfilled_at, total_sum, city_id, seller_id')
                .order('created_at', { ascending: false })
                .limit(20);
              console.log('Диагностика — последние 20 заказов:', { id: true, created_at: true, status: true, is_preorder: true, preorder_status: true, fulfilled_at: true, total_sum: true, city_id: true, seller_id: true });
              console.log('Диагностика — данные:', data);
              console.log('Ошибка запроса:', error);
              if (data) alert('В консоли: последние 20 заказов (id, created_at, status, is_preorder, preorder_status, fulfilled_at, total_sum, city_id, seller_id).');
            }}
            className="mb-2 ml-2 text-xs text-gray-500 underline hover:text-gray-700"
          >
            {t('admin.diagnostic')}
          </button>

          {loading ? (
            <p className="text-gray-900">{t('common.loading')}</p>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-x-auto w-full">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-gray-100 text-gray-900">
                  <tr>
                    <th className="p-2 text-left whitespace-nowrap">{t('admin.date')}</th>
                    <th className="p-2 text-left whitespace-nowrap">{t('admin.city')}</th>
                    <th className="p-2 text-left whitespace-nowrap">{t('admin.seller')}</th>
                    <th className="p-2 text-right whitespace-nowrap">{t('admin.amount')}</th>
                    <th className="p-2 text-left whitespace-nowrap">{t('common.payment')}</th>
                    {viewMode === 'preorders' && (
                      <>
                        <th className="p-2 text-left">{t('admin.pickupDate')}</th>
                        <th className="p-2 text-left">{t('admin.preorderStatus')}</th>
                      </>
                    )}
                    {viewMode === 'debts' && (
                      <>
                        <th className="p-2 text-left">{t('common.client')}</th>
                        <th className="p-2 text-left">{t('admin.return')}</th>
                        <th className="p-2 text-left">{t('admin.debtStatus')}</th>
                      </>
                    )}
                    <th className="p-2 text-left">{t('common.status')}</th>
                    <th className="p-2 text-left">{viewMode === 'preorders' || viewMode === 'debts' ? t('admin.actions') : ''}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-t border-gray-200">
                      <td className="p-2 whitespace-nowrap text-gray-900">{formatDate(String(getAccountingDate(o) ?? o.created_at))}</td>
                      <td className="p-2 whitespace-nowrap text-gray-900">{cityMap.get(o.city_id) || o.city_id}</td>
                      <td className="p-2 whitespace-nowrap text-gray-900">{sellerMap.get(o.seller_id) || o.seller_id}</td>
                      <td className="p-2 text-right whitespace-nowrap text-gray-900">{formatMoney(o.total_sum)} ₸</td>
                      <td className="p-2 whitespace-nowrap text-gray-900">{formatPaymentType(o.payment_type)}</td>
                      {viewMode === 'preorders' && (
                        <>
                          <td className="p-2 text-gray-900">{o.pickup_date ? new Date(o.pickup_date).toLocaleDateString('ru-KZ') : '—'}</td>
                          <td className="p-2">
                            {o.preorder_status === 'pending' && (
                              <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded">{t('admin.pendingShort')}</span>
                            )}
                            {o.preorder_status === 'fulfilled' && (
                              <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded">{t('admin.fulfilledShort')}</span>
                            )}
                            {o.preorder_status === 'cancelled' && (
                              <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">{t('admin.cancelledShort')}</span>
                            )}
                          </td>
                        </>
                      )}
                      {viewMode === 'debts' && (
                        <>
                          <td className="p-2 text-gray-900">{[o.debt_customer_name, o.debt_customer_phone].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="p-2 text-gray-900">{o.debt_due_at ? new Date(o.debt_due_at).toLocaleDateString('ru-KZ') : '—'}</td>
                          <td className="p-2">
                            {o.debt_status === 'active' && (
                              <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 rounded">{t('admin.activeShort')}</span>
                            )}
                            {o.debt_status === 'paid' && (
                              <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded">{t('admin.paidShort')}</span>
                            )}
                            {o.debt_status === 'written_off' && (
                              <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 rounded">{t('admin.writtenOffShort')}</span>
                            )}
                          </td>
                        </>
                      )}
                      <td className="p-2">
                        {orderStatusCanceled(o) ? (
                          <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                            {t('admin.cancelledShort')}
                          </span>
                        ) : (
                          <span className="text-gray-900">{t('admin.confirmedShort')}</span>
                        )}
                        {((o as Order & { preorder_status?: string }).preorder_status ?? '').toLowerCase() === 'fulfilled' && (
                          <span className="ml-1 text-xs text-gray-500">{t('admin.preorderBadgeShort')}</span>
                        )}
                        {o.is_debt && (
                          <span className="ml-1 text-xs text-orange-600">
                            {o.debt_status === 'paid' ? t('admin.debtBadgePaidShort') : t('admin.debtBadgeShort')}
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        <button
                          onClick={() => setSelectedId(o.id)}
                          className="text-blue-600 hover:underline"
                        >
                          {t('admin.details')}
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
              className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50"
              onClick={() => setSelectedId(null)}
            >
              <div
                className="bg-white rounded-xl p-6 max-w-md w-full max-h-[80vh] overflow-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="font-bold mb-2 text-gray-900">{t('admin.orderId')} {orderDetail.id.slice(0, 8)}</h2>
                {orderDetail && orderStatusCanceled(orderDetail) && (
                  <span className="inline-block mb-2 px-2 py-1 text-sm font-medium bg-red-100 text-red-700 rounded">
                    {t('admin.cancelledShort')}
                  </span>
                )}
                {orderDetail.is_preorder === true && (
                  <>
                    <span className="inline-block mb-2 px-2 py-1 text-sm font-bold bg-amber-100 text-amber-800 rounded mr-1">
                      {orderDetail.preorder_status === 'fulfilled' ? t('admin.preorderIssued') : t('orders.preorder')}
                    </span>
                    {orderDetail.preorder_status !== 'fulfilled' && (
                      <span className="inline-block mb-2 px-2 py-1 text-sm font-medium bg-sky-100 text-sky-700 rounded mr-1">
                        {orderDetail.preorder_status === 'pending' ? t('admin.pendingPickup') : t('admin.cancelledShort')}
                      </span>
                    )}
                  </>
                )}
                {orderDetail.is_debt && (
                  <span className="inline-block mb-2 px-2 py-1 text-sm font-bold bg-orange-100 text-orange-800 rounded mr-1">
                    {orderDetail.debt_status === 'paid' ? t('admin.debtFull') : t('admin.debtActive')}
                  </span>
                )}
                <p className="text-gray-900">{t('admin.date')}: {formatDate(orderDetail.created_at)}</p>
                <p className="text-gray-900">{t('admin.city')}: {cityMap.get(orderDetail.city_id)}</p>
                <p className="text-gray-900">{t('admin.seller')}: {sellerMap.get(orderDetail.seller_id)}</p>
                <p className="text-gray-900">{t('admin.amount')}: {formatMoney(orderDetail.total_sum)} ₸</p>
                <p className="text-gray-900">{t('common.payment')}: {formatPaymentType(orderDetail.payment_type)}</p>
                {orderDetail.pickup_date && (
                  <p className="text-gray-900">{t('admin.planPickup')}: {new Date(orderDetail.pickup_date).toLocaleDateString('ru-KZ')}</p>
                )}
                {orderDetail.fulfilled_at && (
                  <p className="text-gray-900">{t('admin.issued')}: {formatDate(orderDetail.fulfilled_at)}</p>
                )}
                {orderDetail.is_debt && (
                  <>
                    <p className="text-gray-900">{t('common.client')}: {[orderDetail.debt_customer_name, orderDetail.debt_customer_phone].filter(Boolean).join(' · ') || '—'}</p>
                    <p className="text-gray-900">{t('admin.debtDue')}: {orderDetail.debt_due_at ? new Date(orderDetail.debt_due_at).toLocaleDateString('ru-KZ') : '—'}</p>
                    {orderDetail.debt_paid_at && <p className="text-gray-900">{t('admin.paidAt')}: {formatDate(orderDetail.debt_paid_at)}</p>}
                    {orderDetail.debt_note && <p className="text-sm text-gray-600">{t('admin.note')}: {orderDetail.debt_note}</p>}
                  </>
                )}
                {orderDetail.comment && <p className="text-gray-900">{t('admin.comment')}: {orderDetail.comment}</p>}
                <div className="mt-2 space-y-1 text-gray-900">
                  {orderDetail.order_items?.map((item) => (
                    <div key={item.id} className="text-sm">
                      {item.product_name_snapshot} × {item.qty}
                      {item.is_gift ? ` ${t('common.gift')}` : ` = ${formatMoney(item.line_sum ?? 0)} ₸`}
                    </div>
                  ))}
                </div>
                {orderDetail && orderDetail.is_preorder === true && orderStatusConfirmed(orderDetail) && (orderDetail.preorder_status ?? '').toLowerCase() === 'pending' && (
                  <button
                    onClick={() => handleFulfillPreorder(orderDetail.id)}
                    disabled={fulfillingId === orderDetail.id}
                    className="mt-4 w-full py-2 bg-green-600 text-white rounded-lg disabled:opacity-50"
                  >
                    {fulfillingId === orderDetail.id ? t('admin.processing') : t('admin.clientReceived')}
                  </button>
                )}
                {orderDetail?.is_debt && orderDetail?.debt_status === 'active' && (
                  <>
                    <div className="mt-3">
                      <label className="block text-sm font-medium mb-1 text-gray-900">{t('admin.paymentMethodOnClose')}</label>
                      <select
                        value={debtPaymentMethod}
                        onChange={(e) => setDebtPaymentMethod(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
                      >
                        <option value="">—</option>
                        <option value="cash">Наличные</option>
                        <option value="kaspi">Kaspi</option>
                        <option value="transfer">Перевод</option>
                      </select>
                    </div>
                    <button
                      onClick={() => handleMarkDebtPaid(orderDetail.id)}
                      disabled={payingDebtId === orderDetail.id}
                      className="mt-4 w-full py-2 bg-green-600 text-white rounded-lg disabled:opacity-50"
                    >
                      {payingDebtId === orderDetail.id ? t('admin.processing') : t('admin.paidShort')}
                    </button>
                  </>
                )}
                {orderDetail && !orderStatusCanceled(orderDetail) && (
                  <button
                    onClick={() => handleCancel(orderDetail.id)}
                    className="mt-4 w-full py-2 bg-red-600 text-white rounded-lg"
                  >
                    {t('admin.cancelOrder')}
                  </button>
                )}
                <button
                  onClick={() => setSelectedId(null)}
                  className="mt-2 w-full py-2 bg-gray-300 rounded-lg hover:bg-gray-400"
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Protected>
  );
}
