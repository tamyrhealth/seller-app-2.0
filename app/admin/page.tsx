'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  adminDashboardAvgCheck,
  productQtySharePct,
  sortCityRevenuesDesc,
} from '@/lib/adminDashboardView';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';
import { getTodayLocalISO, getLocalDayRangeInTz } from '@/lib/datetime';
import { isSilentPageReload, markPageQueryPainted } from '@/lib/pageViewport';
import {
  buildTodaySalesDashboard,
  type CityRevenue,
  type OrderRow,
  type ProductQty,
  type SellerTodayRow,
} from '@/lib/todaySalesDashboard';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

const UNIT_LABELS: Record<string, string> = {
  pcs: 'шт.',
  kg: 'кг',
  g: 'г',
  l: 'л',
  ml: 'мл',
};

function unitLabel(unit: string | null | undefined): string {
  if (!unit) return 'шт.';
  return UNIT_LABELS[unit] ?? unit;
}

function formatQty(qty: number, unit: string): string {
  const label = unitLabel(unit);
  if (unit === 'kg') {
    const s = Number(qty.toFixed(3)).toString();
    return `${s} ${label}`;
  }
  return `${qty} ${label}`;
}

function IconRevenue() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 19V5" strokeLinecap="round" />
      <path d="M4 19h16" strokeLinecap="round" />
      <path d="M8 15l4-5 3 3 5-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconOrders() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCities() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20V10l4-2 4 3 4-2 4 2v9" strokeLinejoin="round" />
      <path d="M9 20v-5h6v5" />
    </svg>
  );
}

function KpiCard({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'blue' | 'green' | 'indigo' | 'amber';
  icon: ReactNode;
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${tones[tone]}`}>{icon}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-white shadow-sm border border-slate-200" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-white shadow-sm border border-slate-200" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="h-56 animate-pulse rounded-2xl bg-white shadow-sm border border-slate-200" />
        <div className="h-56 animate-pulse rounded-2xl bg-white shadow-sm border border-slate-200" />
      </div>
    </div>
  );
}

export default function AdminPage() {
  const { t } = useTranslation();
  const deletedSellerLabel = t('admin.deletedSeller');
  const [todayRevenue, setTodayRevenue] = useState(0);
  const [todayOrders, setTodayOrders] = useState(0);
  const [cityRevenues, setCityRevenues] = useState<CityRevenue[]>([]);
  const [sellerRows, setSellerRows] = useState<SellerTodayRow[]>([]);
  const [productRows, setProductRows] = useState<ProductQty[]>([]);
  const [expandedSeller, setExpandedSeller] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const paintedScopeRef = useRef<string | null>(null);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!isSilentPageReload('admin-today', paintedScopeRef)) setLoading(true);
      setError(null);
      const today = getTodayLocalISO('Asia/Almaty');
      const range = getLocalDayRangeInTz(today, 'Asia/Almaty');
      const fromISO = range.from.toISOString();
      const toNextISO = range.toNext.toISOString();
      const orderSelect =
        'id, seller_id, total_sum, city_id, created_at, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, order_items(product_id, qty, is_gift, product_name_snapshot, product:products(name, unit))';

      const [createdRes, fulfilledRes, debtPaidRes] = await Promise.all([
        supabase.from('orders').select(orderSelect).gte('created_at', fromISO).lt('created_at', toNextISO),
        supabase.from('orders').select(orderSelect).gte('fulfilled_at', fromISO).lt('fulfilled_at', toNextISO),
        supabase.from('orders').select(orderSelect).gte('debt_paid_at', fromISO).lt('debt_paid_at', toNextISO),
      ]);

      const loadError = createdRes.error || fulfilledRes.error || debtPaidRes.error;
      if (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setLoading(false);
        }
        return;
      }

      const seen = new Set<string>();
      const allRows: OrderRow[] = [];
      for (const row of [...(createdRes.data || []), ...(fulfilledRes.data || []), ...(debtPaidRes.data || [])] as OrderRow[]) {
        if (row.id && !seen.has(row.id)) {
          seen.add(row.id);
          allRows.push(row);
        } else if (!row.id) allRows.push(row);
      }

      const sellerIds = [...new Set(allRows.map((o) => o.seller_id).filter((id): id is string => !!id))];
      const nameMap = new Map<string, string>();
      if (sellerIds.length > 0) {
        const { data: profiles, error: profileError } = await supabase.from('profiles').select('id, display_name').in('id', sellerIds);
        if (profileError) {
          if (!cancelled) {
            setError(profileError.message);
            setLoading(false);
          }
          return;
        }
        for (const p of profiles || []) {
          nameMap.set(p.id, (p.display_name || '').trim());
        }
      }
      const { data: cities, error: cityError } = await supabase.from('cities').select('id, name');
      if (cityError) {
        if (!cancelled) {
          setError(cityError.message);
          setLoading(false);
        }
        return;
      }
      const cityNameMap = new Map((cities || []).map((c) => [c.id, c.name]));

      const dash = buildTodaySalesDashboard({
        orders: allRows,
        range,
        sellerNames: nameMap,
        cityNames: cityNameMap,
        deletedSellerLabel,
      });
      if (cancelled) return;
      setTodayRevenue(dash.todayRevenue);
      setTodayOrders(dash.todayOrders);
      setCityRevenues(dash.cityRevenues);
      setSellerRows(dash.sellerRows);
      setProductRows(dash.productRows);
      setLoading(false);
      markPageQueryPainted('admin-today', paintedScopeRef);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, deletedSellerLabel]);

  const avgCheck = adminDashboardAvgCheck(todayRevenue, todayOrders);
  const sellersTotal = sellerRows.reduce((s, r) => s + r.revenue, 0);
  const sortedCities = useMemo(() => sortCityRevenuesDesc(cityRevenues), [cityRevenues]);
  const maxProductQty = productRows.reduce((m, p) => (p.qty > m ? p.qty : m), 0);
  const chartHeight = Math.min(360, Math.max(220, sortedCities.length * 36));

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-slate-50">
        <NavAdmin />
        <div className="mx-auto max-w-6xl p-4 pb-10">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t('admin.dashboard')}</h1>
            <p className="mt-1 text-sm text-slate-500">{t('admin.todaySubtitle')}</p>
          </div>

          {loading ? (
            <DashboardSkeleton />
          ) : error ? (
            <div className="rounded-2xl border border-red-200 bg-white p-4 text-sm text-red-700 shadow-sm">
              {t('admin.dashboardLoadError')}: {error}
            </div>
          ) : (
            <>
              <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <KpiCard
                  label={t('admin.todayRevenue')}
                  value={`${formatMoney(todayRevenue)} ₸`}
                  tone="blue"
                  icon={<IconRevenue />}
                />
                <KpiCard
                  label={t('admin.todayOrders')}
                  value={String(todayOrders)}
                  tone="green"
                  icon={<IconOrders />}
                />
                <KpiCard
                  label={t('admin.avgCheck')}
                  value={`${formatMoney(avgCheck)} ₸`}
                  hint={t('admin.avgCheckHint')}
                  tone="indigo"
                  icon={<IconCheck />}
                />
                <KpiCard
                  label={t('admin.citiesWithSales')}
                  value={String(cityRevenues.length)}
                  tone="amber"
                  icon={<IconCities />}
                />
              </div>

              <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="mb-3 text-sm font-semibold text-slate-900">{t('admin.cityRevenue')}</h2>
                {sortedCities.length === 0 ? (
                  <p className="py-10 text-center text-sm text-slate-500">{t('admin.noDataToday')}</p>
                ) : (
                  <div style={{ height: chartHeight }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={sortedCities} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                        <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} />
                        <YAxis
                          type="category"
                          dataKey="city_name"
                          width={108}
                          tick={{ fontSize: 11, fill: '#334155' }}
                          tickFormatter={(value: string) => (value.length > 14 ? `${value.slice(0, 13)}…` : value)}
                        />
                        <Tooltip
                          formatter={(value) => [`${formatMoney(Number(value ?? 0))} ₸`, t('admin.revenue')]}
                          labelFormatter={(label) => String(label)}
                        />
                        <Bar dataKey="revenue" fill="#2563eb" radius={[0, 6, 6, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-100 px-4 py-3">
                    <h2 className="text-sm font-semibold text-slate-900">{t('admin.todaySellerSales')}</h2>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {sellerRows.length === 0 && (
                      <p className="p-4 text-sm text-slate-500">{t('admin.noDataToday')}</p>
                    )}
                    {sellerRows.map((s) => (
                      <div key={s.key}>
                        <button
                          type="button"
                          onClick={() => setExpandedSeller((cur) => (cur === s.key ? null : s.key))}
                          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-slate-50"
                        >
                          <span className="truncate text-sm font-medium text-slate-900">{s.name}</span>
                          <span className="shrink-0 text-sm tabular-nums text-slate-900">{formatMoney(s.revenue)} ₸</span>
                        </button>
                        {expandedSeller === s.key && (
                          <div className="space-y-1 px-4 pb-3 pl-5">
                            {s.products.length === 0 ? (
                              <p className="text-xs text-slate-500">{t('admin.noSoldItems')}</p>
                            ) : (
                              s.products.map((p) => (
                                <div key={p.key} className="flex justify-between gap-2 text-xs text-slate-600">
                                  <span className="truncate">{p.name}</span>
                                  <span className="shrink-0 tabular-nums">{formatQty(p.qty, p.unit)}</span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900">
                    <span>{t('admin.todaySellersTotal')}</span>
                    <span className="tabular-nums">{formatMoney(sellersTotal)} ₸</span>
                  </div>
                </div>

                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-100 px-4 py-3">
                    <h2 className="text-sm font-semibold text-slate-900">{t('admin.todaySoldProducts')}</h2>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {productRows.length === 0 && (
                      <p className="p-4 text-sm text-slate-500">{t('admin.noDataToday')}</p>
                    )}
                    {productRows.map((p) => {
                      const pct = productQtySharePct(p.qty, maxProductQty);
                      return (
                        <div key={p.key} className="px-4 py-3">
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="truncate text-sm text-slate-900">{p.name}</span>
                            <span className="shrink-0 text-sm tabular-nums text-slate-900">{formatQty(p.qty, p.unit)}</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-blue-600" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Protected>
  );
}
