'use client';

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';
import { addDaysYmd } from '@/lib/datetime';
import {
  buildAdminStats,
  formatQtyByUnit,
  formatQtyValue,
  resolvePeriod,
  type AdminStatsResult,
  type PeriodSpec,
  type StatsPeriodPreset,
  type SellerStatRow,
} from '@/lib/adminStats';
import { downloadAdminStatsExcel } from '@/lib/adminStatsExport';
import { fetchRecognizedWindow, fetchUnpaidDebts } from '@/lib/fetchAdminStatsOrders';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const PRESETS: { id: StatsPeriodPreset; labelKey: string }[] = [
  { id: 'today', labelKey: 'stats.today' },
  { id: 'yesterday', labelKey: 'stats.yesterday' },
  { id: 'last7', labelKey: 'stats.last7' },
  { id: 'last30', labelKey: 'stats.last30' },
  { id: 'thisMonth', labelKey: 'stats.thisMonth' },
  { id: 'lastMonth', labelKey: 'stats.lastMonth' },
  { id: 'custom', labelKey: 'stats.custom' },
];

const PIE_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#db2777', '#7c3aed', '#0d9488', '#ea580c', '#64748b'];

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

type SellerSort = 'revenue' | 'orders' | 'qty';
type ProductSort = 'qty' | 'revenue';

function qtyScore(row: SellerStatRow): number {
  return row.qtyByUnit.reduce((s, q) => s + q.qty, 0);
}

function fillDays(period: PeriodSpec, daily: AdminStatsResult['daily']) {
  const map = new Map(daily.map((d) => [d.date, d]));
  const out = [];
  let cur = period.fromYmd;
  while (cur <= period.toYmd) {
    out.push(map.get(cur) || { date: cur, revenue: 0, orders: 0 });
    cur = addDaysYmd(cur, 1);
  }
  return out;
}

export default function AdminStatsPage() {
  const { t } = useTranslation();
  const deletedSellerLabel = t('admin.deletedSeller');
  const [preset, setPreset] = useState<StatsPeriodPreset>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [sellerId, setSellerId] = useState<string | 'all'>('all');
  const [cityId, setCityId] = useState<string | 'all'>('all');
  const [productId, setProductId] = useState<string | 'all'>('all');
  const [sellers, setSellers] = useState<{ id: string; display_name: string | null }[]>([]);
  const [cities, setCities] = useState<{ id: string; name: string; is_active?: boolean | null }[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [stats, setStats] = useState<AdminStatsResult | null>(null);
  const [period, setPeriod] = useState<PeriodSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sellerSort, setSellerSort] = useState<SellerSort>('revenue');
  const [productSort, setProductSort] = useState<ProductSort>('qty');
  const [topMode, setTopMode] = useState<'qty' | 'revenue'>('qty');

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, display_name')
      .eq('role', 'seller')
      .then(({ data }) => setSellers(data || []));
    supabase.from('cities').select('id, name, is_active').then(({ data }) => setCities(data || []));
    supabase
      .from('products')
      .select('id, name')
      .order('sort_order')
      .then(({ data }) => setProducts(data || []));
  }, []);

  const sellerNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sellers) m.set(s.id, (s.display_name || '').trim());
    return m;
  }, [sellers]);

  useEffect(() => {
    const spec = resolvePeriod(preset, customFrom, customTo);
    setPeriod(spec);
    if (!spec) {
      setStats(null);
      setLoading(false);
      setError(preset === 'custom' ? t('admin.dateRangeInvalid') : null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const [rev, debts] = await Promise.all([fetchRecognizedWindow(spec.range), fetchUnpaidDebts()]);
      if (cancelled) return;
      if (rev.error) {
        setError(rev.error);
        setStats(null);
        setLoading(false);
        return;
      }
      setTruncated(rev.truncated || debts.truncated);
      setStats(
        buildAdminStats({
          orders: rev.orders,
          unpaidDebts: debts.orders,
          range: spec.range,
          sellerId,
          cityId,
          productId,
          sellerNames,
          deletedSellerLabel,
        })
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [preset, customFrom, customTo, sellerId, cityId, productId, sellerNames, deletedSellerLabel]);

  const dailyFilled = period && stats ? fillDays(period, stats.daily) : [];
  const pieData = (stats?.sellers || []).slice(0, 7).map((s) => ({ name: s.name, value: Math.round(s.revenue) }));
  if (stats && stats.sellers.length > 7) {
    const rest = stats.sellers.slice(7).reduce((s, r) => s + r.revenue, 0);
    pieData.push({ name: t('stats.others'), value: Math.round(rest) });
  }
  const topProducts = [...(stats?.products || [])]
    .sort((a, b) => (topMode === 'qty' ? b.qty - a.qty : b.revenue - a.revenue))
    .slice(0, 8)
    .map((p) => ({
      name: p.name.length > 18 ? `${p.name.slice(0, 18)}…` : p.name,
      value: topMode === 'qty' ? p.qty : Math.round(p.revenue),
    }));

  const sortedSellers = [...(stats?.sellers || [])].sort((a, b) => {
    if (sellerSort === 'orders') return b.orderCount - a.orderCount;
    if (sellerSort === 'qty') return qtyScore(b) - qtyScore(a);
    return b.revenue - a.revenue;
  });
  const sortedProducts = [...(stats?.products || [])].sort((a, b) =>
    productSort === 'revenue' ? b.revenue - a.revenue : b.qty - a.qty
  );

  function exportExcel() {
    if (!stats || !period) return;
    downloadAdminStatsExcel(stats, period, {
      seller: sellerId === 'all' ? t('admin.allSellers') : sellers.find((s) => s.id === sellerId)?.display_name || sellerId,
      city: cityId === 'all' ? t('admin.allCities') : cities.find((c) => c.id === cityId)?.name || cityId,
      product: productId === 'all' ? t('stats.allProducts') : products.find((p) => p.id === productId)?.name || productId,
    });
  }

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4 max-w-7xl mx-auto">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h1 className="text-2xl font-bold text-gray-900">{t('stats.title')}</h1>
            <button
              type="button"
              onClick={exportExcel}
              disabled={!stats || loading}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium disabled:opacity-50"
            >
              {t('stats.exportExcel')}
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium ${
                  preset === p.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800 hover:bg-gray-200'
                }`}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="flex flex-wrap gap-3 mb-4">
              <label className="text-sm text-gray-700">
                {t('admin.fromDate')}
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="ml-2 border border-gray-300 rounded-lg px-2 py-1"
                />
              </label>
              <label className="text-sm text-gray-700">
                {t('admin.toDate')}
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="ml-2 border border-gray-300 rounded-lg px-2 py-1"
                />
              </label>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <select
              value={sellerId}
              onChange={(e) => setSellerId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="all">{t('admin.allSellers')}</option>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name || s.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <select
              value={cityId}
              onChange={(e) => setCityId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="all">{t('admin.allCities')}</option>
              {cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.is_active === false ? ` (${t('stats.hiddenCity')})` : ''}
                </option>
              ))}
            </select>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="all">{t('stats.allProducts')}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {loading && <p className="text-gray-700">{t('common.loading')}</p>}
          {error && <p className="text-red-600 text-sm mb-3">{t('common.error')}: {error}</p>}
          {truncated && <p className="text-amber-800 text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">{t('stats.truncated')}</p>}
          {stats?.productFilterActive && (
            <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-3">{t('stats.productFilterNote')}</p>
          )}
          {stats && stats.lineDiscrepancyCount > 0 && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              {t('stats.lineDiscrepancy')} ({stats.lineDiscrepancyCount})
            </p>
          )}

          {!loading && stats && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                <Kpi label={t('stats.revenue')} value={`${formatMoney(stats.revenue)} ₸`} />
                <Kpi label={t('stats.orders')} value={String(stats.orderCount)} />
                <Kpi label={t('stats.avgCheck')} value={`${formatMoney(stats.averageCheck)} ₸`} />
                <Kpi label={t('stats.soldQty')} value={formatQtyByUnit(stats.qtyByUnit)} />
              </div>

              {stats.orderCount === 0 && (
                <p className="text-gray-600 mb-6">{t('stats.emptyPeriod')}</p>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <ChartCard title={t('stats.sellerShare')}>
                  {pieData.length === 0 ? (
                    <EmptyChart />
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                          {pieData.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v) => `${formatMoney(Number(v ?? 0))} ₸`} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>
                <ChartCard title={t('stats.dailyTrend')}>
                  {dailyFilled.every((d) => d.revenue === 0) ? (
                    <EmptyChart />
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={dailyFilled}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v) => `${formatMoney(Number(v ?? 0))} ₸`} />
                        <Line type="monotone" dataKey="revenue" stroke="#2563eb" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>
              </div>

              <ChartCard title={t('stats.topProducts')} className="mb-6">
                <div className="flex gap-2 mb-2">
                  <button type="button" className={`text-xs px-2 py-1 rounded ${topMode === 'qty' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`} onClick={() => setTopMode('qty')}>
                    {t('stats.byQty')}
                  </button>
                  <button type="button" className={`text-xs px-2 py-1 rounded ${topMode === 'revenue' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`} onClick={() => setTopMode('revenue')}>
                    {t('stats.byRevenue')}
                  </button>
                </div>
                {topProducts.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={topProducts} layout="vertical" margin={{ left: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#16a34a" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              <h2 className="font-bold text-gray-900 mb-2">{t('stats.sellerRanking')}</h2>
              <div className="border border-gray-200 rounded-xl overflow-x-auto mb-6">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-2 text-left">{t('admin.seller')}</th>
                      <SortTh active={sellerSort === 'revenue'} onClick={() => setSellerSort('revenue')}>{t('admin.revenue')}</SortTh>
                      <SortTh active={sellerSort === 'orders'} onClick={() => setSellerSort('orders')}>{t('admin.ordersCount')}</SortTh>
                      <SortTh active={sellerSort === 'qty'} onClick={() => setSellerSort('qty')}>{t('stats.soldQty')}</SortTh>
                      <th className="p-2 text-right">{t('stats.share')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSellers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-3 text-gray-600">{t('stats.emptyPeriod')}</td>
                      </tr>
                    )}
                    {sortedSellers.map((s) => (
                      <Fragment key={s.key}>
                        <tr className="border-t border-gray-200">
                          <td className="p-2">
                            <button type="button" className="text-left text-blue-700 hover:underline" onClick={() => setExpanded((c) => (c === s.key ? null : s.key))}>
                              {s.name}
                            </button>
                          </td>
                          <td className="p-2 text-right tabular-nums">{formatMoney(s.revenue)} ₸</td>
                          <td className="p-2 text-right">{s.orderCount}</td>
                          <td className="p-2 text-right">{formatQtyByUnit(s.qtyByUnit)}</td>
                          <td className="p-2 text-right">{s.sharePct.toFixed(1)}%</td>
                        </tr>
                        {expanded === s.key && (
                          <tr key={`${s.key}-items`} className="bg-gray-50">
                            <td colSpan={5} className="p-3">
                              {s.products.length === 0 ? (
                                <p className="text-xs text-gray-500">{t('admin.noSoldItems')}</p>
                              ) : (
                                <div className="space-y-1">
                                  {s.products.map((p) => (
                                    <div key={p.key} className="flex justify-between text-xs text-gray-800 gap-2">
                                      <span className="truncate">{p.name}</span>
                                      <span className="shrink-0 tabular-nums">
                                        {formatQtyValue(p.qty, p.unit)} · {formatMoney(p.revenue)} ₸
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 className="font-bold text-gray-900 mb-2">{t('stats.productStats')}</h2>
              <div className="border border-gray-200 rounded-xl overflow-x-auto mb-6">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-2 text-left">{t('admin.product')}</th>
                      <SortTh active={productSort === 'qty'} onClick={() => setProductSort('qty')}>{t('stats.qty')}</SortTh>
                      <th className="p-2 text-left">{t('stats.unit')}</th>
                      <SortTh active={productSort === 'revenue'} onClick={() => setProductSort('revenue')}>{t('admin.revenue')}</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedProducts.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-3 text-gray-600">{t('stats.emptyPeriod')}</td>
                      </tr>
                    )}
                    {sortedProducts.map((p) => (
                      <tr key={p.key} className="border-t border-gray-200">
                        <td className="p-2">{p.name}</td>
                        <td className="p-2 text-right tabular-nums">{p.unit === 'kg' ? Number(p.qty.toFixed(3)) : p.qty}</td>
                        <td className="p-2">{formatQtyValue(p.qty, p.unit).split(' ').slice(-1)[0]}</td>
                        <td className="p-2 text-right tabular-nums">{formatMoney(p.revenue)} ₸</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 className="font-bold text-gray-900 mb-2">{t('stats.debtAnalytics')}</h2>
              <p className="text-xs text-gray-500 mb-2">{t('stats.debtNote')}</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                <Kpi label={t('stats.unpaidDebts')} value={`${formatMoney(stats.unpaidDebtAmount)} ₸`} />
                <Kpi label={t('stats.unpaidDebtOrders')} value={String(stats.unpaidDebtOrders)} />
                {stats.overdueAvailable ? (
                  <>
                    <Kpi label={t('stats.overdueDebts')} value={`${formatMoney(stats.overdueDebtAmount || 0)} ₸`} />
                    <Kpi label={t('stats.overdueDebtOrders')} value={String(stats.overdueDebtOrders || 0)} />
                  </>
                ) : (
                  <div className="col-span-2 bg-gray-50 rounded-xl p-4 text-sm text-gray-600">{t('stats.overdueUnavailable')}</div>
                )}
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden mb-8">
                {stats.unpaidDebtBySeller.length === 0 ? (
                  <p className="p-3 text-sm text-gray-600">{t('stats.noDebts')}</p>
                ) : (
                  stats.unpaidDebtBySeller.map((d) => (
                    <div key={d.key} className="flex justify-between px-3 py-2 border-t border-gray-100 first:border-t-0 text-sm">
                      <span>{d.name} · {d.orderCount}</span>
                      <span className="tabular-nums">{formatMoney(d.amount)} ₸</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Protected>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-xl p-4">
      <p className="text-xs text-gray-600 mb-1">{label}</p>
      <p className="text-lg font-bold text-gray-900 break-words">{value}</p>
    </div>
  );
}

function ChartCard({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`border border-gray-200 rounded-xl p-3 ${className}`}>
      <h2 className="font-bold text-sm text-gray-900 mb-2">{title}</h2>
      {children}
    </div>
  );
}

function EmptyChart() {
  return <p className="h-[260px] flex items-center justify-center text-sm text-gray-500">—</p>;
}

function SortTh({ children, active, onClick }: { children: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <th className="p-2 text-right">
      <button type="button" onClick={onClick} className={`font-semibold ${active ? 'text-blue-700' : 'text-gray-900'}`}>
        {children}
      </button>
    </th>
  );
}
