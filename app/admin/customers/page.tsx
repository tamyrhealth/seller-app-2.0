'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import TableScroll from '@/components/TableScroll';
import {
  buildAdminCustomers,
  filterCustomerRows,
  sortCustomerRows,
  type CustomerInactiveFilter,
  type CustomerProfile,
  type CustomerSortKey,
} from '@/lib/adminCustomers';
import { formatCustomerKpi, resolveCustomerRange, type CustomerPeriodMode } from '@/lib/adminCustomersView';
import { fetchAllCustomerOrders } from '@/lib/fetchAdminCustomerOrders';
import { formatInstantDmy, getTodayLocalISO } from '@/lib/datetime';
import { runExclusive } from '@/lib/exclusiveAsync';
import { isSilentPageReload, markPageQueryPainted } from '@/lib/pageViewport';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

function paymentCopy(
  row: { isCanceled: boolean; unpaidDebt: boolean; isDebt: boolean; paymentType: string | null },
  t: (key: string) => string
): string {
  if (row.isCanceled) return t('common.canceled');
  if (row.unpaidDebt || row.isDebt) return t('common.debt');
  const type = String(row.paymentType || '').toLowerCase();
  if (type === 'cash') return t('common.cash');
  if (type === 'kaspi') return t('common.kaspi');
  if (type === 'card') return t('common.card');
  if (type === 'transfer') return t('common.transfer');
  if (type === 'debt') return t('common.debt');
  return row.paymentType || '—';
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'blue' | 'green' | 'indigo' | 'amber' | 'rose' | 'slate';
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
    slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className={`inline-flex h-2.5 w-2.5 rounded-full ${tones[tone]}`} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function CustomersSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export default function AdminCustomersPage() {
  const { t } = useTranslation();
  const today = getTodayLocalISO('Asia/Almaty');
  const [mode, setMode] = useState<CustomerPeriodMode>('thisMonth');
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [cityId, setCityId] = useState<string | 'all'>('all');
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [nameQuery, setNameQuery] = useState('');
  const [phoneQuery, setPhoneQuery] = useState('');
  const [inactive, setInactive] = useState<CustomerInactiveFilter>('all');
  const [sort, setSort] = useState<CustomerSortKey>('revenue');
  const [orders, setOrders] = useState<Parameters<typeof buildAdminCustomers>[0]['orders']>([]);
  const [complete, setComplete] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const paintedScopeRef = useRef<string | null>(null);
  const [openPhone, setOpenPhone] = useState<string | null>(null);
  const years = useMemo(() => {
    const y = Number(today.slice(0, 4));
    return [y - 2, y - 1, y];
  }, [today]);

  const spec = useMemo(
    () =>
      resolveCustomerRange({
        mode,
        year,
        month: Number(today.slice(5, 7)),
        customFrom,
        customTo,
        todayYmd: today,
      }),
    [mode, year, customFrom, customTo, today]
  );

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    supabase
      .from('cities')
      .select('id, name')
      .order('name')
      .then(({ data, error: cityError }) => {
        if (!cityError) setCities(data || []);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isSilentPageReload('customers-orders', paintedScopeRef)) setLoading(true);
    setError(null);
    (async () => {
      const fetched = await runExclusive('admin-customers-orders', fetchAllCustomerOrders);
      if (cancelled) return;
      if (fetched.error) {
        setError(fetched.error);
        setLoading(false);
        return;
      }
      setOrders(fetched.orders);
      setComplete(fetched.complete);
      setLoaded(fetched.loaded);
      setTotal(fetched.total);
      setLoading(false);
      markPageQueryPainted('customers-orders', paintedScopeRef);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!openPhone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenPhone(null);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [openPhone]);

  const cityNames = useMemo(() => new Map(cities.map((c) => [c.id, c.name])), [cities]);

  const built = useMemo(() => {
    if (!spec) return null;
    return buildAdminCustomers({
      orders,
      range: spec.range,
      cityId,
      cityNames,
      complete,
      totalOrders: total,
    });
  }, [orders, spec, cityId, cityNames, complete, total]);

  const tableRows = useMemo(() => {
    if (!built) return [];
    return sortCustomerRows(
      filterCustomerRows(built.customers, { nameQuery, phoneQuery, inactive }),
      sort
    );
  }, [built, nameQuery, phoneQuery, inactive, sort]);

  const detail: CustomerProfile | null = built?.customers.find((c) => c.phone === openPhone) || null;
  const kpiOk = Boolean(built?.complete);

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-slate-50">
        <NavAdmin />
        <main className="mx-auto max-w-6xl space-y-4 p-4 pb-16">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t('customers.title')}</h1>
            <p className="mt-1 text-sm text-slate-500">{t('customers.subtitle')}</p>
          </div>

          <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'thisMonth' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setMode('thisMonth')}
            >
              {t('customers.thisMonth')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'lastMonth' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setMode('lastMonth')}
            >
              {t('customers.lastMonth')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'year' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setMode('year')}
            >
              {t('customers.year')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'custom' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setMode('custom')}
            >
              {t('finance.customPeriod')}
            </button>
            {mode === 'year' ? (
              <label className="text-sm text-slate-600">
                {t('finance.year')}
                <select
                  className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {mode === 'custom' ? (
              <>
                <label className="text-sm text-slate-600">
                  {t('admin.fromDate')}
                  <input
                    type="date"
                    className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </label>
                <label className="text-sm text-slate-600">
                  {t('admin.toDate')}
                  <input
                    type="date"
                    className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            <label className="text-sm text-slate-600">
              {t('common.city')}
              <select
                className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                value={cityId}
                onChange={(e) => setCityId(e.target.value === 'all' ? 'all' : e.target.value)}
              >
                <option value="all">{t('admin.allCities')}</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-600">
              {t('customers.searchName')}
              <input
                className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5"
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
              />
            </label>
            <label className="text-sm text-slate-600">
              {t('customers.searchPhone')}
              <input
                className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5"
                value={phoneQuery}
                onChange={(e) => setPhoneQuery(e.target.value)}
                inputMode="tel"
              />
            </label>
            <label className="text-sm text-slate-600">
              {t('customers.inactive')}
              <select
                className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                value={inactive}
                onChange={(e) => setInactive(e.target.value as CustomerInactiveFilter)}
              >
                <option value="all">{t('common.all')}</option>
                <option value="30">{t('customers.inactive30')}</option>
                <option value="60">{t('customers.inactive60')}</option>
                <option value="90">{t('customers.inactive90')}</option>
              </select>
            </label>
          </div>

          {loading ? (
            <CustomersSkeleton />
          ) : error ? (
            <div className="rounded-2xl border border-red-200 bg-white p-4 text-sm text-red-700 shadow-sm">
              {t('customers.loadError')}: {error}
            </div>
          ) : !spec ? (
            <div className="rounded-2xl border border-red-200 bg-white p-4 text-sm text-red-700 shadow-sm">
              {t('admin.dateRangeInvalid')}
            </div>
          ) : built ? (
            <div className="space-y-4">
              {!built.complete ? (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {t('customers.truncated')} {loaded}
                  {total != null ? ` / ${total}` : ''}. {t('customers.truncatedHint')}
                </p>
              ) : null}
              <p className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                {t('customers.identifiedShare')}: {built.identifiedOrders} {t('customers.withPhone')} ·{' '}
                {built.unidentifiedOrders} {t('customers.withoutPhone')} · {t('customers.coverage')}:{' '}
                {built.coveragePct == null ? '—' : `${built.coveragePct.toFixed(1)}%`}. {t('customers.notAllBuyers')}{' '}
                {t('customers.inactive')}: {formatCustomerKpi(built.inactive30, kpiOk)} /{' '}
                {formatCustomerKpi(built.inactive60, kpiOk)} / {formatCustomerKpi(built.inactive90, kpiOk)}.
              </p>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <KpiCard
                  label={t('customers.unique')}
                  value={formatCustomerKpi(built.uniqueCustomers, kpiOk)}
                  hint={t('customers.identifiedOnly')}
                  tone="blue"
                />
                <KpiCard
                  label={t('customers.new')}
                  value={formatCustomerKpi(built.newCustomers, kpiOk)}
                  hint={t('customers.newHint')}
                  tone="green"
                />
                <KpiCard
                  label={t('customers.repeat')}
                  value={formatCustomerKpi(built.repeatCustomers, kpiOk)}
                  hint={t('customers.repeatHint')}
                  tone="indigo"
                />
                <KpiCard
                  label={t('customers.revenue')}
                  value={formatCustomerKpi(built.periodIdentifiedRevenue, kpiOk, ' ₸')}
                  hint={t('customers.revenueHint')}
                  tone="amber"
                />
                <KpiCard
                  label={t('customers.avgCheck')}
                  value={formatCustomerKpi(built.averageCheck, kpiOk, ' ₸')}
                  tone="rose"
                />
                <KpiCard
                  label={t('customers.unpaidDebt')}
                  value={formatCustomerKpi(built.unpaidDebtAmount, kpiOk, ' ₸')}
                  hint={`${formatCustomerKpi(built.unpaidDebtOrders, kpiOk)} ${t('customers.orders')}`}
                  tone="slate"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Section title={t('customers.topRevenue')}>
                  {built.topByRevenue.length === 0 ? (
                    <p className="text-sm text-slate-500">{t('customers.empty')}</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {built.topByRevenue.map((row) => (
                        <li key={row.phone} className="flex items-center justify-between gap-3">
                          <span>
                            <span className="font-medium">{row.displayName}</span>
                            <span className="ml-2 text-slate-500">{row.phone}</span>
                          </span>
                          <span className="tabular-nums">{formatMoney(row.periodRevenue)} ₸</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={t('customers.topOrders')}>
                  {built.topByOrders.length === 0 ? (
                    <p className="text-sm text-slate-500">{t('customers.empty')}</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {built.topByOrders.map((row) => (
                        <li key={row.phone} className="flex items-center justify-between gap-3">
                          <span>
                            <span className="font-medium">{row.displayName}</span>
                            <span className="ml-2 text-slate-500">{row.phone}</span>
                          </span>
                          <span className="tabular-nums">{row.periodRecognizedCount}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </div>

              <Section title={t('customers.byCity')}>
                {built.byCity.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('customers.empty')}</p>
                ) : (
                  <TableScroll minWidth="48rem" stickyFirst>
                    <table className="w-full min-w-[480px] border-separate border-spacing-0 text-left text-sm">
                      <thead className="text-xs text-slate-500">
                        <tr>
                          <th className="whitespace-nowrap px-3 py-2 font-medium">{t('common.city')}</th>
                          <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('customers.unique')}</th>
                          <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('customers.colOrders')}</th>
                          <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('customers.colRevenue')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {built.byCity.map((row) => (
                          <tr key={row.cityId}>
                            <td className="px-3 py-2">{row.cityName}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.customers}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.periodOrders}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                              {formatMoney(row.periodRevenue)} ₸
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                )}
              </Section>

              <Section title={t('customers.table')} hint={t('customers.tableHint')}>
                <div className="mb-3 flex flex-wrap gap-2 text-sm">
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 ${sort === 'revenue' ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}
                    onClick={() => setSort('revenue')}
                  >
                    {t('customers.sortRevenue')}
                  </button>
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 ${sort === 'orders' ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}
                    onClick={() => setSort('orders')}
                  >
                    {t('customers.sortOrders')}
                  </button>
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 ${sort === 'last' ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}
                    onClick={() => setSort('last')}
                  >
                    {t('customers.sortLast')}
                  </button>
                </div>
                {tableRows.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('customers.empty')}</p>
                ) : (
                  <TableScroll minWidth="48rem" stickyFirst>
                    <table className="w-full min-w-[860px] border-separate border-spacing-0 text-left text-sm">
                      <thead className="text-xs text-slate-500">
                        <tr>
                          <th className="min-w-[9rem] whitespace-nowrap px-3 py-2 font-medium">{t('common.client')}</th>
                          <th className="min-w-[9.5rem] whitespace-nowrap px-3 py-2 font-medium">{t('customers.phone')}</th>
                          <th className="w-24 whitespace-nowrap px-3 py-2 text-right font-medium">{t('customers.colOrders')}</th>
                          <th className="w-32 whitespace-nowrap px-3 py-2 text-right font-medium">{t('customers.colRevenue')}</th>
                          <th className="w-36 whitespace-nowrap px-3 py-2 font-medium">{t('customers.lastPurchase')}</th>
                          <th className="min-w-[8rem] whitespace-nowrap px-3 py-2 font-medium">{t('common.city')}</th>
                          <th className="w-28 whitespace-nowrap px-3 py-2 text-right font-medium" />
                        </tr>
                      </thead>
                      <tbody>
                        {tableRows.map((row) => (
                          <tr key={row.phone} className="border-t border-slate-100">
                            <td className="px-3 py-2.5 font-medium text-slate-900">{row.displayName}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600">{row.phone}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                              {row.lifetimeRecognizedCount}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                              {formatMoney(row.periodRevenue)} ₸
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                              {formatInstantDmy(row.lastRecognizedAt)}
                            </td>
                            <td className="px-3 py-2.5 text-slate-600">{row.cities.map((c) => c.name).join(', ') || '—'}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right">
                              <button
                                type="button"
                                className="font-medium text-blue-700"
                                onClick={() => setOpenPhone(row.phone)}
                              >
                                {t('customers.history')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                )}
              </Section>

              {detail ? (
                <div className="fixed inset-0 z-50 flex items-end justify-center md:items-stretch md:justify-end">
                  <button
                    type="button"
                    className="absolute inset-0 bg-slate-900/40"
                    aria-label={t('customers.closeHistory')}
                    onClick={() => setOpenPhone(null)}
                  />
                  <aside
                    role="dialog"
                    aria-modal="true"
                    className="relative z-10 flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl md:h-full md:max-h-none md:rounded-none md:rounded-l-2xl"
                  >
                    <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold text-slate-900">
                          {t('customers.detail')}: {detail.displayName}
                        </h2>
                        <p className="mt-0.5 tabular-nums text-sm text-slate-500">{detail.phone}</p>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-600"
                        onClick={() => setOpenPhone(null)}
                      >
                        {t('common.close')}
                      </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 text-sm">
                      <div className="space-y-3">
                        <p>
                          {t('customers.names')}: {detail.names.join(', ') || '—'}
                        </p>
                        <p>
                          {t('common.city')}: {detail.cities.map((c) => c.name).join(', ') || '—'}
                        </p>
                        <p>
                          {t('customers.frequency')}:{' '}
                          {detail.avgDaysBetweenPurchases == null
                            ? '—'
                            : `${detail.avgDaysBetweenPurchases.toFixed(1)} ${t('customers.days')}`}
                        </p>
                        <p>
                          {t('customers.lastPurchase')}: {formatInstantDmy(detail.lastRecognizedAt)}
                        </p>
                        <p>
                          {t('customers.createdAt')}: {formatInstantDmy(detail.lastCreatedAt)}
                        </p>
                        {detail.unpaidDebtAmount > 0 ? (
                          <p>
                            {t('customers.unpaidDebt')}: {formatMoney(detail.unpaidDebtAmount)} ₸
                          </p>
                        ) : null}
                        <div>
                          <p className="mb-1 font-medium">{t('customers.favorites')}</p>
                          {detail.favoriteProducts.length === 0 ? (
                            <p className="text-slate-500">{t('customers.empty')}</p>
                          ) : (
                            <ul className="space-y-1">
                              {detail.favoriteProducts.slice(0, 8).map((p) => (
                                <li key={p.key} className="flex justify-between gap-3">
                                  <span>{p.name}</span>
                                  <span className="whitespace-nowrap tabular-nums">
                                    {p.qty} · {formatMoney(p.revenue)} ₸
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <TableScroll minWidth="48rem" stickyFirst>
                          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-left text-sm">
                            <thead className="text-xs text-slate-500">
                              <tr>
                                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('customers.createdAt')}</th>
                                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('customers.recognizedAt')}</th>
                                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('common.city')}</th>
                                <th className="whitespace-nowrap px-3 py-2 font-medium">{t('common.payment')}</th>
                                <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('common.amount')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.history.map((row) => (
                                <tr key={row.id} className="border-t border-slate-100">
                                  <td className="whitespace-nowrap px-3 py-2">{formatInstantDmy(row.createdAt)}</td>
                                  <td className="whitespace-nowrap px-3 py-2">{formatInstantDmy(row.recognizedAt)}</td>
                                  <td className="px-3 py-2">{row.cityName}</td>
                                  <td className="whitespace-nowrap px-3 py-2">{paymentCopy(row, t)}</td>
                                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                    {formatMoney(row.totalSum)} ₸
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </TableScroll>
                      </div>
                    </div>
                  </aside>
                </div>
              ) : null}
            </div>
          ) : null}
        </main>
      </div>
    </Protected>
  );
}
