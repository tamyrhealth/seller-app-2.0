'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from '@/lib/i18n';
import { displayOrderNumber, parseOrderNumberQuery } from '@/lib/orderNumber';
import { isCanceledStatus, orderStatusI18nKey } from '@/lib/orderStatus';
import type { City, Order, Profile } from '@/lib/types';

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

const LIST_SELECT =
  'id, order_number, created_at, total_sum, status, payment_type, city_id, seller_id, is_preorder, preorder_status, is_debt, debt_status, pickup_date';

const DETAIL_SELECT = `${LIST_SELECT}, comment, fulfilled_at, debt_due_at, debt_paid_at, debt_customer_name, debt_customer_phone, debt_note, order_items(id, product_name_snapshot, qty, price, line_sum, is_gift)`;

export default function OrderBrowse() {
  const { t } = useTranslation();
  const [orders, setOrders] = useState<Order[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [sellers, setSellers] = useState<Profile[]>([]);
  const [filterCity, setFilterCity] = useState('');
  const [filterSeller, setFilterSeller] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [numberSearch, setNumberSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const cityMap = useMemo(() => new Map(cities.map((c) => [c.id, c.name])), [cities]);
  const sellerMap = useMemo(
    () => new Map(sellers.map((p) => [p.id, p.display_name || p.id.slice(0, 8)])),
    [sellers]
  );

  useEffect(() => {
    supabase.from('cities').select('id, name, is_active').order('name').then(({ data }) => setCities(data || []));
    supabase
      .from('profiles')
      .select('id, display_name, role, city_id')
      .eq('role', 'seller')
      .then(({ data }) => setSellers((data || []) as Profile[]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      let q = supabase.from('orders').select(LIST_SELECT).order('created_at', { ascending: false }).limit(400);
      if (filterCity) q = q.eq('city_id', filterCity);
      if (filterSeller) q = q.eq('seller_id', filterSeller);
      if (filterStatus) q = q.eq('status', filterStatus);
      const parsed = parseOrderNumberQuery(numberSearch);
      if (parsed) q = q.eq('order_number', parsed);
      else if (numberSearch.trim()) q = q.ilike('order_number', `%${numberSearch.trim()}%`);
      const { data, error: err } = await q;
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setOrders([]);
      } else {
        setError('');
        setOrders((data || []) as Order[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [filterCity, filterSeller, filterStatus, numberSearch]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    supabase
      .from('orders')
      .select(DETAIL_SELECT)
      .eq('id', selectedId)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setDetail((data as Order) || null);
      });
  }, [selectedId]);

  return (
    <div>
      <div className="grid gap-2 mb-4 md:grid-cols-4">
        <input
          value={numberSearch}
          onChange={(e) => setNumberSearch(e.target.value)}
          placeholder={`${t('common.search')} N000001`}
          className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
        />
        <select
          value={filterCity}
          onChange={(e) => setFilterCity(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
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
          className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
        >
          <option value="">{t('admin.allSellers')}</option>
          {sellers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.display_name || s.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
        >
          <option value="">{t('admin.allStatuses')}</option>
          <option value="confirmed">{t('orders.status.confirmed')}</option>
          <option value="canceled">{t('orders.status.canceled')}</option>
        </select>
      </div>
      {error && <p className="text-red-700 text-sm mb-2">{error}</p>}
      {loading ? (
        <p className="text-gray-900">{t('common.loading')}</p>
      ) : orders.length === 0 ? (
        <p className="text-gray-600">{t('orders.noData')}</p>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-x-auto w-full">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-gray-100 text-gray-900">
              <tr>
                <th className="p-2 text-left whitespace-nowrap">{t('admin.orderNumber')}</th>
                <th className="p-2 text-left whitespace-nowrap">{t('admin.date')}</th>
                <th className="p-2 text-left whitespace-nowrap">{t('admin.city')}</th>
                <th className="p-2 text-left whitespace-nowrap">{t('admin.seller')}</th>
                <th className="p-2 text-right whitespace-nowrap">{t('admin.amount')}</th>
                <th className="p-2 text-left">{t('common.status')}</th>
                <th className="p-2 text-left" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-gray-200">
                  <td className="p-2 whitespace-nowrap font-medium text-gray-900">{displayOrderNumber(o)}</td>
                  <td className="p-2 whitespace-nowrap text-gray-900">{formatDate(o.created_at)}</td>
                  <td className="p-2 whitespace-nowrap text-gray-900">{cityMap.get(o.city_id) || '—'}</td>
                  <td className="p-2 whitespace-nowrap text-gray-900">{sellerMap.get(o.seller_id) || '—'}</td>
                  <td className="p-2 text-right whitespace-nowrap text-gray-900">{formatMoney(o.total_sum)} ₸</td>
                  <td className="p-2">
                    <span
                      className={`px-2 py-0.5 text-xs font-medium rounded ${
                        isCanceledStatus(o.status) ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-800'
                      }`}
                    >
                      {t(orderStatusI18nKey(o.status))}
                    </span>
                    {o.is_preorder ? (
                      <span className="ml-1 text-xs text-gray-500">{t('admin.preorderBadgeShort')}</span>
                    ) : null}
                    {o.is_debt ? (
                      <span className="ml-1 text-xs text-orange-600">{t('admin.debtBadgeShort')}</span>
                    ) : null}
                  </td>
                  <td className="p-2">
                    <button type="button" onClick={() => setSelectedId(o.id)} className="text-blue-600 hover:underline">
                      {t('admin.details')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50" onClick={() => setSelectedId(null)}>
          <div
            className="bg-white rounded-xl p-6 max-w-md w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-bold mb-2 text-gray-900">
              {t('admin.orderId')} {displayOrderNumber(detail)}
            </h2>
            <p className="mb-2">
              <span
                className={`px-2 py-0.5 text-xs font-medium rounded ${
                  isCanceledStatus(detail.status) ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-800'
                }`}
              >
                {t(orderStatusI18nKey(detail.status))}
              </span>
              {detail.is_preorder === true && (
                <span className="ml-2 text-sm text-gray-700">
                  {detail.preorder_status === 'fulfilled' ? t('admin.preorderIssued') : t('orders.preorder')}
                </span>
              )}
              {detail.is_debt && (
                <span className="ml-2 text-sm text-orange-700">
                  {detail.debt_status === 'paid' ? t('admin.debtFull') : t('admin.debtActive')}
                </span>
              )}
            </p>
            <p className="text-gray-900">
              {t('admin.date')}: {formatDate(detail.created_at)}
            </p>
            <p className="text-gray-900">
              {t('admin.city')}: {cityMap.get(detail.city_id) || '—'}
            </p>
            <p className="text-gray-900">
              {t('admin.seller')}: {sellerMap.get(detail.seller_id) || '—'}
            </p>
            <p className="text-gray-900">
              {t('admin.amount')}: {formatMoney(detail.total_sum)} ₸
            </p>
            <p className="text-gray-900">
              {t('common.payment')}: {formatPaymentType(detail.payment_type)}
            </p>
            {detail.pickup_date && (
              <p className="text-gray-900">
                {t('admin.planPickup')}: {new Date(detail.pickup_date).toLocaleDateString('ru-KZ')}
              </p>
            )}
            {detail.fulfilled_at && (
              <p className="text-gray-900">
                {t('admin.issued')}: {formatDate(detail.fulfilled_at)}
              </p>
            )}
            {detail.is_debt && (
              <>
                <p className="text-gray-900">
                  {t('common.client')}: {[detail.debt_customer_name, detail.debt_customer_phone].filter(Boolean).join(' · ') || '—'}
                </p>
                <p className="text-gray-900">
                  {t('admin.debtDue')}: {detail.debt_due_at ? new Date(detail.debt_due_at).toLocaleDateString('ru-KZ') : '—'}
                </p>
                {detail.debt_paid_at && (
                  <p className="text-gray-900">
                    {t('admin.paidAt')}: {formatDate(detail.debt_paid_at)}
                  </p>
                )}
                {detail.debt_note && (
                  <p className="text-sm text-gray-600">
                    {t('admin.note')}: {detail.debt_note}
                  </p>
                )}
              </>
            )}
            {detail.comment && (
              <p className="text-gray-900">
                {t('admin.comment')}: {detail.comment}
              </p>
            )}
            <div className="mt-3 space-y-1 text-gray-900">
              {detail.order_items?.map((item) => (
                <div key={item.id} className="text-sm">
                  {item.product_name_snapshot} × {item.qty}
                  {item.is_gift ? ` ${t('common.gift')}` : ` · ${formatMoney(item.price)} ₸ = ${formatMoney(item.line_sum ?? 0)} ₸`}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="mt-4 w-full py-2 bg-gray-300 rounded-lg hover:bg-gray-400"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
