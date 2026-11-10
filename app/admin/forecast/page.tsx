'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import TableScroll from '@/components/TableScroll';
import {
  buildAdminForecast,
  filterForecastRows,
  parseForecastParams,
  type ForecastCatalogProduct,
  type ForecastInventoryRow,
  type ForecastOrder,
  type ForecastTransfer,
  type ForecastWindow,
} from '@/lib/adminForecast';
import {
  fetchForecastOrders,
  forecastConfidenceLabel,
  forecastRateWindowLabel,
  formatForecastDate,
  formatForecastDays,
  formatForecastQty,
  formatForecastRate,
  physicalDemandRange90,
} from '@/lib/adminForecastView';
import { useAuth } from '@/lib/auth';
import { runExclusive } from '@/lib/exclusiveAsync';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';

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

function ForecastSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-white shadow-sm" />
    </div>
  );
}

export default function AdminForecastPage() {
  const { t } = useTranslation();
  const { profile, authReady } = useAuth();
  const isAdmin = profile?.role === 'admin' && profile.is_active !== false;
  const [leadDays, setLeadDays] = useState('');
  const [safetyDays, setSafetyDays] = useState('');
  const [targetDays, setTargetDays] = useState('');
  const [windowDays, setWindowDays] = useState<ForecastWindow>(30);
  const [cityId, setCityId] = useState<string | 'all'>('all');
  const [productId, setProductId] = useState<string | 'all'>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [catalog, setCatalog] = useState<ForecastCatalogProduct[]>([]);
  const [inventory, setInventory] = useState<ForecastInventoryRow[]>([]);
  const [transfers, setTransfers] = useState<ForecastTransfer[]>([]);
  const [orders, setOrders] = useState<ForecastOrder[]>([]);
  const [complete, setComplete] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!authReady || !isAdmin) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const spec = physicalDemandRange90();
    (async () => {
      try {
        const [ord, invRes, trRes, prodRes, cityRes] = await Promise.all([
          runExclusive('admin-forecast-orders', () => fetchForecastOrders(spec.range)),
          supabase.from('inventory').select('city_id, product_id, qty_on_hand'),
          supabase
            .from('stock_transfers')
            .select(
              'id, status, from_city_id, to_city_id, stock_transfer_items(product_id, qty_sent, qty_received, qty_lost, qty_returned)'
            ),
          supabase.from('products').select('id, name, unit, is_active'),
          supabase.from('cities').select('id, name').order('name'),
        ]);
        if (cancelled) return;
        if (ord.error) {
          setError(ord.error);
          setLoading(false);
          return;
        }
        if (invRes.error) {
          setError(invRes.error.message);
          setLoading(false);
          return;
        }
        if (trRes.error) {
          setError(trRes.error.message);
          setLoading(false);
          return;
        }
        if (prodRes.error) {
          setError(prodRes.error.message);
          setLoading(false);
          return;
        }
        if (cityRes.error) {
          setError(cityRes.error.message);
          setLoading(false);
          return;
        }
        setOrders(ord.orders);
        setTruncated(ord.truncated);
        setComplete(!ord.truncated);
        setInventory((invRes.data || []) as ForecastInventoryRow[]);
        setTransfers((trRes.data || []) as ForecastTransfer[]);
        setCatalog(
          (prodRes.data || []).map((p: { id: string; name: string; unit: string; is_active: boolean | null }) => ({
            id: p.id,
            name: p.name,
            unit: p.unit,
            isActive: p.is_active !== false,
          }))
        );
        setCities((cityRes.data || []) as { id: string; name: string }[]);
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
  }, [refreshKey, authReady, isAdmin]);

  const params = useMemo(
    () => parseForecastParams({ leadDays, safetyDays, targetDays }),
    [leadDays, safetyDays, targetDays]
  );

  const report = useMemo(
    () =>
      buildAdminForecast({
        orders,
        inventory,
        transfers,
        catalog,
        cities,
        window: windowDays,
        params,
        complete,
      }),
    [orders, inventory, transfers, catalog, cities, windowDays, params, complete]
  );

  const tableRows = useMemo(
    () => filterForecastRows(report.cityRows, { cityId, productId, problemsOnly }),
    [report.cityRows, cityId, productId, problemsOnly]
  );

  const transferRows = useMemo(
    () =>
      report.transfers.filter((row) => {
        if (cityId !== 'all' && row.fromCityId !== cityId && row.toCityId !== cityId) return false;
        if (productId !== 'all' && row.productId !== productId) return false;
        return true;
      }),
    [report.transfers, cityId, productId]
  );

  const recOk = report.recsAvailable && !truncated;
  const kpiOk = report.complete && !truncated;

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-slate-50">
        <NavAdmin />
        <main className="mx-auto max-w-6xl space-y-4 p-4 pb-16">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t('forecast.title')}</h1>
            <p className="mt-1 text-sm text-slate-500">{t('forecast.subtitle')}</p>
          </div>

          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{t('forecast.loadError')}</div>
          ) : loading ? (
            <ForecastSkeleton />
          ) : (
            <>
              {truncated ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t('forecast.truncated')}</div>
              ) : null}
              {report.recsBlockedReason === 'missing_params' ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">{t('forecast.needParams')}</div>
              ) : null}
              {report.recsBlockedReason === 'target_below_lead_safety' ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t('forecast.targetTooSmall')}</div>
              ) : null}
              {report.negativeStockCount > 0 ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{t('forecast.negativeStock')}</div>
              ) : null}

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <KpiCard
                  label={t('forecast.deficitKpi')}
                  value={kpiOk ? String(report.deficitProductCount) : '—'}
                  tone="rose"
                />
                <KpiCard
                  label={t('forecast.excessKpi')}
                  value={kpiOk ? String(report.excessProductCount) : '—'}
                  tone="amber"
                />
                <KpiCard
                  label={t('forecast.purchaseKpi')}
                  value={recOk ? String(report.purchaseProductCount) : '—'}
                  hint={t('forecast.companyWide')}
                  tone="blue"
                />
                <KpiCard
                  label={t('forecast.transferKpi')}
                  value={recOk ? String(report.transferCount) : '—'}
                  hint={t('forecast.transferHint')}
                  tone="indigo"
                />
              </div>

              <Section title={t('forecast.settings')} hint={t('forecast.settingsHint')}>
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                  <label className="text-sm text-slate-600">
                    {t('forecast.leadDays')}
                    <input
                      type="number"
                      min={0.1}
                      step="1"
                      className="ml-2 w-24 rounded-lg border border-slate-200 px-2 py-1.5"
                      value={leadDays}
                      onChange={(e) => setLeadDays(e.target.value)}
                      placeholder="—"
                    />
                  </label>
                  <label className="text-sm text-slate-600">
                    {t('forecast.safetyDays')}
                    <input
                      type="number"
                      min={0.1}
                      step="1"
                      className="ml-2 w-24 rounded-lg border border-slate-200 px-2 py-1.5"
                      value={safetyDays}
                      onChange={(e) => setSafetyDays(e.target.value)}
                      placeholder="—"
                    />
                  </label>
                  <label className="text-sm text-slate-600">
                    {t('forecast.targetDays')}
                    <input
                      type="number"
                      min={0.1}
                      step="1"
                      className="ml-2 w-24 rounded-lg border border-slate-200 px-2 py-1.5"
                      value={targetDays}
                      onChange={(e) => setTargetDays(e.target.value)}
                      placeholder="—"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {([7, 30, 90] as const).map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={`rounded-lg px-3 py-1.5 text-sm ${windowDays === w ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
                        onClick={() => setWindowDays(w)}
                      >
                        {w === 7 ? t('forecast.window7') : w === 90 ? t('forecast.window90') : t('forecast.window30')}
                      </button>
                    ))}
                  </div>
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
                    {t('common.product')}
                    <select
                      className="ml-2 max-w-[14rem] rounded-lg border border-slate-200 bg-white px-2 py-1.5"
                      value={productId}
                      onChange={(e) => setProductId(e.target.value === 'all' ? 'all' : e.target.value)}
                    >
                      <option value="all">{t('forecast.allProducts')}</option>
                      {catalog
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={problemsOnly}
                      onChange={(e) => setProblemsOnly(e.target.checked)}
                    />
                    {t('forecast.problemsOnly')}
                  </label>
                </div>
              </Section>

              <Section title={t('forecast.transfers')} hint={t('forecast.transferHint')}>
                {!recOk || transferRows.length === 0 ? (
                  <p className="text-sm text-slate-500">{recOk ? t('forecast.noTransfers') : t('forecast.recsHidden')}</p>
                ) : (
                  <TableScroll minWidth="52rem" stickyFirst>
                    <table className="border-separate border-spacing-0 text-sm">
                      <thead>
                        <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <th className="sticky left-0 z-10 whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-left">
                            {t('common.product')}
                          </th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-left">{t('forecast.fromCity')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-left">{t('forecast.toCity')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.qty')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.senderAfter')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.receiverCover')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transferRows.map((row, idx) => (
                          <tr key={`${row.productId}-${row.fromCityId}-${row.toCityId}-${idx}`} className="hover:bg-slate-50">
                            <td className="sticky left-0 z-10 min-w-[10rem] border-b border-slate-100 bg-white px-3 py-2.5 font-medium text-slate-900">
                              {row.name}
                            </td>
                            <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5">{row.fromCityName}</td>
                            <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5">{row.toCityName}</td>
                            <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                              {formatForecastQty(row.qty, row.unit)}
                            </td>
                            <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                              {formatForecastQty(row.senderAvailableAfter, row.unit)}
                            </td>
                            <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                              {formatForecastDays(row.receiverCoverDaysAfter, true)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                )}
              </Section>

              <Section title={t('forecast.table')} hint={t('forecast.tableHint')}>
                {tableRows.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('forecast.empty')}</p>
                ) : (
                  <TableScroll minWidth="72rem" stickyFirst>
                    <table className="border-separate border-spacing-0 text-sm">
                      <thead>
                        <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <th className="sticky left-0 z-10 min-w-[11rem] whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-left">
                            {t('common.product')}
                          </th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-left">{t('common.city')}</th>
                          <th
                            className={`whitespace-nowrap border-b px-3 py-3 text-right ${
                              windowDays === 7 ? 'border-slate-900 bg-slate-100 text-slate-800' : 'border-slate-200 bg-white'
                            }`}
                          >
                            {t('forecast.q7')}
                          </th>
                          <th
                            className={`whitespace-nowrap border-b px-3 py-3 text-right ${
                              windowDays === 30 ? 'border-slate-900 bg-slate-100 text-slate-800' : 'border-slate-200 bg-white'
                            }`}
                          >
                            {t('forecast.q30')}
                          </th>
                          <th
                            className={`whitespace-nowrap border-b px-3 py-3 text-right ${
                              windowDays === 90 ? 'border-slate-900 bg-slate-100 text-slate-800' : 'border-slate-200 bg-white'
                            }`}
                          >
                            {t('forecast.q90')}
                          </th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.rate')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.onHand')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.reserve')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.available')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.inbound')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.cover')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.exhaust')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-right">{t('forecast.buy')}</th>
                          <th className="whitespace-nowrap border-b border-slate-200 bg-white px-3 py-3 text-left">{t('forecast.confidence')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tableRows.map((row) => {
                          const qtyCell = (active: boolean) =>
                            `whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums ${
                              active ? 'bg-slate-50 font-medium text-slate-900' : ''
                            }`;
                          return (
                            <tr key={`${row.productId}-${row.cityId}`} className="hover:bg-slate-50">
                              <td className="sticky left-0 z-10 min-w-[11rem] max-w-[16rem] border-b border-slate-100 bg-white px-3 py-2.5 font-medium text-slate-900">
                                <div>{row.name}</div>
                                {row.spike ? <div className="mt-0.5 text-xs font-normal text-amber-700">{t('forecast.spike')}</div> : null}
                                {row.negativeStock ? (
                                  <div className="mt-0.5 text-xs font-normal text-rose-700">{t('forecast.negativeTag')}</div>
                                ) : null}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5">{row.cityName}</td>
                              <td className={qtyCell(windowDays === 7)}>{formatForecastQty(row.qty7, row.unit, kpiOk)}</td>
                              <td className={qtyCell(windowDays === 30)}>{formatForecastQty(row.qty30, row.unit, kpiOk)}</td>
                              <td className={qtyCell(windowDays === 90)}>{formatForecastQty(row.qty90, row.unit, kpiOk)}</td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right">
                                <div className="tabular-nums text-slate-900">{formatForecastRate(row.recRate, kpiOk)}</div>
                                <div
                                  className={`text-[11px] leading-tight ${
                                    row.recRateWindow === 90 && !(row.qty30 > 0) ? 'text-amber-700' : 'text-slate-500'
                                  }`}
                                >
                                  {forecastRateWindowLabel(row.recRateWindow, t)}
                                </div>
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                                {formatForecastQty(row.onHand, row.unit)}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                                {formatForecastQty(row.reserve, row.unit)}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                                {formatForecastQty(row.available, row.unit)}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                                {formatForecastQty(row.inbound, row.unit)}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                                {formatForecastDays(row.daysCover, kpiOk)}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                                {formatForecastDate(row.exhaustYmd, kpiOk)}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5 text-right tabular-nums">
                                {recOk ? formatForecastQty(row.cityDeficit ?? 0, row.unit, true) : '—'}
                              </td>
                              <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2.5">{forecastConfidenceLabel(row.confidence, t)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableScroll>
                )}
              </Section>
            </>
          )}
        </main>
      </div>
    </Protected>
  );
}
