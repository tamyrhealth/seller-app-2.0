'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { buildAdminAbc, type AbcCatalogFilter, type AbcMode, type AbcProductRow } from '@/lib/adminAbc';
import {
  abcCogsHintKey,
  formatAbcKpi,
  formatAbcPct,
  paretoPoints,
  resolveAbcRange,
  sortAbcRows,
  visibleAbcTableRows,
  type AbcPeriodMode,
  type AbcSortKey,
} from '@/lib/adminAbcView';
import { FINANCE_COSTS_RPC, type FinanceOrder } from '@/lib/adminFinance';
import {
  collectFinanceOrderItemIds,
  FINANCE_ITEM_SNAPSHOTS_RPC,
  loadOrderItemCostSnapshots,
} from '@/lib/adminFinanceSnapshots';
import { getTodayLocalISO } from '@/lib/datetime';
import { fetchRecognizedWindow } from '@/lib/fetchAdminStatsOrders';
import { runExclusive } from '@/lib/exclusiveAsync';
import { useTranslation } from '@/lib/i18n';
import type { ProductCostRow } from '@/lib/productCost';
import { supabase } from '@/lib/supabaseClient';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
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

function AbcSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
        ))}
      </div>
      <div className="h-56 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
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

function classBadge(row: AbcProductRow, t: (key: string) => string) {
  if (row.abcClass === 'A') return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">A</span>;
  if (row.abcClass === 'B') return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">B</span>;
  if (row.abcClass === 'C') return <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">C</span>;
  if (row.rankTag === 'loss') return <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">{t('abc.loss')}</span>;
  if (row.rankTag === 'zero_profit') return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{t('abc.zeroProfit')}</span>;
  if (row.rankTag === 'zero_revenue') return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{t('abc.zeroRevenue')}</span>;
  if (row.rankTag === 'no_cost') return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">{t('abc.noCost')}</span>;
  return <span className="text-xs text-slate-400">—</span>;
}

export default function AdminAbcPage() {
  const { t } = useTranslation();
  const today = getTodayLocalISO('Asia/Almaty');
  const [period, setPeriod] = useState<AbcPeriodMode>('thisMonth');
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [cityId, setCityId] = useState<string | 'all'>('all');
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [catalogFilter, setCatalogFilter] = useState<AbcCatalogFilter>('all');
  const [mode, setMode] = useState<AbcMode>('revenue');
  const [sort, setSort] = useState<AbcSortKey>('share');
  const [orders, setOrders] = useState<FinanceOrder[]>([]);
  const [complete, setComplete] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [costs, setCosts] = useState<ProductCostRow[] | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [itemSnapshots, setItemSnapshots] = useState<Map<string, number | null>>(new Map());
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Map<string, { isActive: boolean }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const years = useMemo(() => {
    const y = Number(today.slice(0, 4));
    return [y - 2, y - 1, y];
  }, [today]);

  const spec = useMemo(
    () =>
      resolveAbcRange({
        mode: period,
        year,
        month: Number(today.slice(5, 7)),
        customFrom,
        customTo,
        todayYmd: today,
      }),
    [period, year, customFrom, customTo, today]
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

  const periodKey = spec ? `${spec.fromYmd}:${spec.toYmd}` : 'invalid';

  useEffect(() => {
    if (!spec) {
      setLoading(false);
      setError('invalid-range');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [rev, costRes, productRes] = await Promise.all([
          runExclusive(`admin-abc-orders:${periodKey}`, () => fetchRecognizedWindow(spec.range)),
          supabase.rpc(FINANCE_COSTS_RPC),
          supabase.from('products').select('id, is_active'),
        ]);
        if (cancelled) return;
        if (rev.error) {
          setError(rev.error);
          setLoading(false);
          return;
        }
        setTruncated(rev.truncated);
        setComplete(!rev.truncated);
        const loadedOrders = rev.orders as FinanceOrder[];
        setOrders(loadedOrders);
        if (costRes.error) {
          setCosts(null);
          setCostError(costRes.error.message || 'cost');
        } else {
          setCosts((costRes.data || []) as ProductCostRow[]);
          setCostError(null);
        }
        const snap = await loadOrderItemCostSnapshots(collectFinanceOrderItemIds(loadedOrders), (ids) =>
          supabase.rpc(FINANCE_ITEM_SNAPSHOTS_RPC, { p_ids: ids })
        );
        if (cancelled) return;
        setItemSnapshots(snap.map);
        setSnapshotError(snap.error);
        if (!productRes.error) {
          setCatalog(
            new Map(
              (productRes.data || []).map((row: { id: string; is_active: boolean | null }) => [
                row.id,
                { isActive: row.is_active !== false },
              ])
            )
          );
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'network');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [periodKey, refreshKey, spec]);

  const report = useMemo(() => {
    if (!spec) return null;
    return buildAdminAbc({
      orders,
      costs: costs || [],
      range: spec.range,
      fromYmd: spec.fromYmd,
      toYmd: spec.toYmd,
      cityId,
      catalog,
      catalogFilter,
      mode,
      complete,
      itemSnapshots,
      itemSnapshotsUnavailable: Boolean(snapshotError),
    });
  }, [spec, orders, costs, cityId, catalog, catalogFilter, mode, complete, itemSnapshots, snapshotError]);

  const tableRows = useMemo(() => {
    if (!report) return [];
    return sortAbcRows(visibleAbcTableRows(report), sort);
  }, [report, sort]);

  const chartRows = useMemo(() => (report ? paretoPoints(visibleAbcTableRows(report)) : []), [report]);
  const kpiOk = Boolean(report?.complete) && !truncated;
  const classOk = kpiOk && (mode === 'revenue' || Boolean(report?.profitAbcAvailable));

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-slate-50">
        <NavAdmin />
        <main className="mx-auto max-w-6xl space-y-4 p-4 pb-16">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t('abc.title')}</h1>
            <p className="mt-1 text-sm text-slate-500">{t('abc.subtitle')}</p>
          </div>

          <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${period === 'thisMonth' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setPeriod('thisMonth')}
            >
              {t('customers.thisMonth')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${period === 'lastMonth' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setPeriod('lastMonth')}
            >
              {t('customers.lastMonth')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${period === 'year' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setPeriod('year')}
            >
              {t('customers.year')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm ${period === 'custom' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
              onClick={() => setPeriod('custom')}
            >
              {t('finance.customPeriod')}
            </button>
            {period === 'year' ? (
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
            {period === 'custom' ? (
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
              {t('abc.catalog')}
              <select
                className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                value={catalogFilter}
                onChange={(e) => setCatalogFilter(e.target.value as AbcCatalogFilter)}
              >
                <option value="all">{t('abc.catalogAll')}</option>
                <option value="active">{t('abc.catalogActive')}</option>
                <option value="archived">{t('abc.catalogArchived')}</option>
              </select>
            </label>
          </div>

          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{t('abc.loadError')}</div>
          ) : loading || !report ? (
            <AbcSkeleton />
          ) : (
            <>
              {truncated ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t('abc.truncated')}</div>
              ) : null}
              {costError || report.profitAbcBlockedReason === 'missing_cost' ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  {costError ? t('abc.costError') : t('abc.missingCost')}
                </div>
              ) : null}
              {snapshotError ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  {t('finance.snapshotsUnavailable')}
                </div>
              ) : null}
              {report.cogsQuality === 'mixed' ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  {t('finance.cogsMixed')}
                </div>
              ) : null}
              {mode === 'profit' && report.profitAbcBlockedReason === 'non_positive_total' ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t('abc.nonPositive')}</div>
              ) : null}
              {report.excludedDisplayCount > 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-500">
                  {t('abc.excluded')}: {report.excludedDisplayCount}
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <KpiCard
                  label={t('abc.revenue')}
                  value={kpiOk ? `${formatAbcKpi(report.revenue, true)} ₸` : '—'}
                  hint={t('abc.notNet')}
                  tone="blue"
                />
                <KpiCard
                  label={t('abc.gross')}
                  value={kpiOk && report.estimatedGrossProfit != null ? `${formatMoney(report.estimatedGrossProfit)} ₸` : '—'}
                  hint={t(abcCogsHintKey(report))}
                  tone="green"
                />
                <KpiCard label={t('abc.classA')} value={classOk ? String(report.countA) : '—'} tone="indigo" />
                <KpiCard label={t('abc.classB')} value={classOk ? String(report.countB) : '—'} tone="amber" />
                <KpiCard label={t('abc.classC')} value={classOk ? String(report.countC) : '—'} tone="slate" />
                <KpiCard
                  label={t('abc.incomplete')}
                  value={kpiOk ? String(report.missingCostProductCount) : '—'}
                  hint={t('finance.missingProducts')}
                  tone="rose"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'revenue' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
                  onClick={() => setMode('revenue')}
                >
                  {t('abc.modeRevenue')}
                </button>
                <button
                  type="button"
                  className={`rounded-lg px-3 py-1.5 text-sm ${mode === 'profit' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
                  onClick={() => setMode('profit')}
                >
                  {t('abc.modeProfit')}
                </button>
              </div>

              <Section title={t('abc.pareto')} hint={t(abcCogsHintKey(report))}>
                {chartRows.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    {report.rows.length === 0 ? t('abc.empty') : t('abc.paretoUnavailable')}
                  </p>
                ) : (
                  <div className="h-64 w-full min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartRows}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="name" hide={chartRows.length > 12} tick={{ fontSize: 11 }} interval={0} />
                        <YAxis yAxisId="share" tick={{ fontSize: 11 }} />
                        <YAxis yAxisId="cum" orientation="right" domain={[0, 100]} tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Bar yAxisId="share" dataKey="sharePct" fill="#94a3b8" name={t('abc.share')} />
                        <Line yAxisId="cum" type="monotone" dataKey="cumPct" stroke="#0f172a" name={t('abc.cumShare')} dot={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Section>

              <Section title={t('abc.table')}>
                <div className="mb-3 flex flex-wrap gap-2">
                  {(
                    [
                      ['share', 'abc.sortShare'],
                      ['revenue', 'abc.sortRevenue'],
                      ['profit', 'abc.sortProfit'],
                      ['qty', 'abc.sortQty'],
                      ['name', 'abc.sortName'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`rounded-lg px-3 py-1.5 text-sm ${sort === key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
                      onClick={() => setSort(key)}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
                {tableRows.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('abc.empty')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="whitespace-nowrap px-2 py-2">{t('common.product')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.sold')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.gift')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.revenue')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.cogs')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.gross')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.share')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.cumShare')}</th>
                          <th className="whitespace-nowrap px-2 py-2">{t('abc.class')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tableRows.map((row) => (
                          <tr key={row.productId} className="border-t border-slate-100">
                            <td className="min-w-[9rem] max-w-[16rem] px-2 py-2 font-medium text-slate-900">
                              {row.name}
                              {row.isActive === false ? (
                                <span className="ml-2 text-xs font-normal text-slate-400">{t('abc.catalogArchived')}</span>
                              ) : null}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 tabular-nums">{row.qtySold}</td>
                            <td className="whitespace-nowrap px-2 py-2 tabular-nums">{row.qtyGift}</td>
                            <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatMoney(row.revenue)}</td>
                            <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                              {row.costMissing ? '—' : formatMoney(row.cogsKnown)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                              {row.estimatedGrossProfit == null ? '—' : formatMoney(row.estimatedGrossProfit)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatAbcPct(row.share, classOk)}</td>
                            <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatAbcPct(row.cumShare, classOk)}</td>
                            <td className="whitespace-nowrap px-2 py-2">{classBadge(row, t)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            </>
          )}
        </main>
      </div>
    </Protected>
  );
}
