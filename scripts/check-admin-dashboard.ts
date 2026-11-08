import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTodaySalesDashboard } from '../lib/todaySalesDashboard';
import {
  adminDashboardAvgCheck,
  productQtySharePct,
  sortCityRevenuesDesc,
} from '../lib/adminDashboardView';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const range = {
  from: new Date('2026-11-08T00:00:00+05:00'),
  toNext: new Date('2026-11-09T00:00:00+05:00'),
};

const dash = buildTodaySalesDashboard({
  orders: [
    {
      id: 'a',
      seller_id: 's1',
      total_sum: 10000,
      city_id: 'c1',
      created_at: '2026-11-08T06:00:00.000Z',
      status: 'confirmed',
      order_items: [{ product_id: 'p1', qty: 2, product: { name: 'Молоко', unit: 'pcs' } }],
    },
    {
      id: 'b',
      seller_id: 's2',
      total_sum: 5000,
      city_id: 'c2',
      created_at: '2026-11-08T07:00:00.000Z',
      status: 'confirmed',
      order_items: [{ product_id: 'p2', qty: 1, product: { name: 'Хлеб', unit: 'pcs' } }],
    },
  ],
  range,
  sellerNames: new Map([
    ['s1', 'Айжан'],
    ['s2', 'Бек'],
  ]),
  cityNames: new Map([
    ['c1', 'Алматы'],
    ['c2', 'Шымкент'],
  ]),
  deletedSellerLabel: 'Удалённый продавец',
});

if (dash.todayRevenue !== 15000) fail('todayRevenue KPI source');
if (dash.todayOrders !== 2) fail('todayOrders KPI source');
if (adminDashboardAvgCheck(dash.todayRevenue, dash.todayOrders) !== 7500) fail('avg check 15000/2');
if (adminDashboardAvgCheck(0, 0) !== 0) fail('avg check with zero orders must be 0');
if (dash.cityRevenues.length !== 2) fail('cities with sales KPI');

const empty = buildTodaySalesDashboard({
  orders: [],
  range,
  sellerNames: new Map(),
  cityNames: new Map(),
  deletedSellerLabel: 'Удалённый продавец',
});
if (empty.todayRevenue !== 0 || empty.todayOrders !== 0 || empty.cityRevenues.length !== 0) {
  fail('zero sales dashboard');
}
if (adminDashboardAvgCheck(empty.todayRevenue, empty.todayOrders) !== 0) fail('zero avg check');
if (sortCityRevenuesDesc(empty.cityRevenues).length !== 0) fail('empty city chart data');

const sorted = sortCityRevenuesDesc([
  { city_name: 'Шымкент', revenue: 5000, order_count: 1 },
  { city_name: 'Алматы', revenue: 10000, order_count: 1 },
]);
if (sorted[0].city_name !== 'Алматы' || sorted[1].city_name !== 'Шымкент') fail('cities must sort by revenue desc');
if (productQtySharePct(2, 2) !== 100) fail('top product share');
if (productQtySharePct(1, 2) !== 50) fail('relative product share');
if (productQtySharePct(1, 0) !== 0) fail('zero max product share');

const page = read('app/admin/page.tsx');
const i18n = read('lib/i18n.tsx');
const dashLib = read('lib/todaySalesDashboard.ts');
const view = read('lib/adminDashboardView.ts');

if (!page.includes('Protected role="admin"')) fail('admin-only page');
if (!page.includes('todayRevenue')) fail('KPI todayRevenue');
if (!page.includes('todayOrders')) fail('KPI todayOrders');
if (!page.includes('adminDashboardAvgCheck')) fail('KPI avg check helper');
if (!page.includes('cityRevenues.length')) fail('KPI cities with sales');
if (!page.includes('admin.avgCheck')) fail('avg check label');
if (!page.includes('admin.citiesWithSales')) fail('cities KPI label');
if (!page.includes('grid-cols-2') || !page.includes('lg:grid-cols-4')) fail('KPI 2x2 / 4-col layout');
if (!page.includes('max-w-6xl')) fail('content max width');
if (!page.includes('bg-slate-50')) fail('light dashboard background');
if (!page.includes('rounded-2xl')) fail('card radius');
if (!page.includes('BarChart') || !page.includes('layout="vertical"')) fail('horizontal city bars');
if (!page.includes('sortCityRevenuesDesc(cityRevenues)')) fail('chart must use existing cityRevenues');
if (!page.includes("dataKey=\"revenue\"")) fail('chart revenue bars');
if (!page.includes('formatMoney(Number(value ?? 0))} ₸')) fail('tooltip in tenge');
if (!page.includes('admin.noDataToday')) fail('empty sales copy');
if (!page.includes('DashboardSkeleton') || !page.includes('animate-pulse')) fail('skeleton placeholders');
if (!page.includes('admin.dashboardLoadError')) fail('load error copy');
if (!page.includes('setExpandedSeller')) fail('seller expand');
if (!page.includes('s.products.map')) fail('expanded seller products');
if (!page.includes('productQtySharePct')) fail('product qty indicators');
if (!page.includes('let cancelled = false')) fail('load cancel flag');
if (page.includes('[refreshKey, t]') || page.includes(', t]')) fail('effects must not depend on unstable t');
if (!page.includes('[refreshKey, deletedSellerLabel]')) fail('stable load deps');
if (page.includes('lucide')) fail('no new icon library');

const fromOrders = page.split(".from('orders')").length - 1;
const fromProfiles = page.split(".from('profiles')").length - 1;
const fromCities = page.split(".from('cities')").length - 1;
if (fromOrders !== 3) fail(`expected 3 orders queries, got ${fromOrders}`);
if (fromProfiles !== 1) fail('profiles query must stay');
if (fromCities !== 1) fail('cities query must stay');
if (page.includes(".from('order_items')") || page.includes(".from('products')") || page.includes(".from('stock')")) {
  fail('no extra supabase tables');
}

if (dashLib.includes('avgCheck') || dashLib.includes('adminDashboardAvgCheck')) {
  fail('todaySalesDashboard must stay unchanged for avg check');
}
if (!view.includes('todayOrders > 0') && !view.includes('if (!todayOrders) return 0')) {
  fail('avg check zero guard');
}

if (!i18n.includes("'admin.avgCheck': 'Средний чек'")) fail('ru avg check');
if (!i18n.includes("'admin.avgCheck': 'Орташа чек'")) fail('kz avg check');
if (!i18n.includes("'admin.citiesWithSales': 'Городов с продажами'")) fail('ru cities kpi');
if (!i18n.includes("'admin.citiesWithSales': 'Сатылымы бар қалалар'")) fail('kz cities kpi');
if (!i18n.includes("'admin.dashboardLoadError': 'Не удалось загрузить дашборд'")) fail('ru load error');
if (!i18n.includes('Бақылау тақтасын жүктеу мүмкін болмады')) fail('kz load error');
if (!i18n.includes("'admin.todaySubtitle': 'Показатели за сегодня'")) fail('ru subtitle');
if (!i18n.includes("'admin.todaySubtitle': 'Бүгінгі көрсеткіштер'")) fail('kz subtitle');

const nav = read('components/NavAdmin.tsx');
if (!nav.includes('href="/admin"')) fail('nav home link must remain');

console.log('admin-dashboard checks ok');
