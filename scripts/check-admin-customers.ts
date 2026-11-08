import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  buildAdminCustomers,
  filterCustomerRows,
  orderCustomerCanon,
  sortCustomerRows,
  type CustomerOrder,
} from '../lib/adminCustomers';
import {
  customerOrdersFetchStatus,
  formatCustomerKpi,
  lastMonthRangeYmd,
  resolveCustomerRange,
  yearRangeYmd,
} from '../lib/adminCustomersView';
import { CUSTOMER_ORDER_SELECT } from '../lib/adminCustomers';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const range = {
  from: new Date('2026-11-01T00:00:00+05:00'),
  toNext: new Date('2026-12-01T00:00:00+05:00'),
};
const now = new Date('2026-11-08T12:00:00+05:00');
const cities = new Map([
  ['c1', 'Алматы'],
  ['c2', 'Астана'],
]);

function order(partial: Partial<CustomerOrder> & { id: string }): CustomerOrder {
  return {
    status: 'confirmed',
    payment_type: 'cash',
    total_sum: 7000,
    created_at: '2026-11-05T06:00:00.000Z',
    city_id: 'c1',
    ...partial,
  };
}

function report(orders: CustomerOrder[], extra: Partial<Parameters<typeof buildAdminCustomers>[0]> = {}) {
  return buildAdminCustomers({
    orders,
    range,
    cityId: 'all',
    cityNames: cities,
    complete: true,
    now,
    ...extra,
  });
}

const sameClient = report([
  order({
    id: 'a',
    customer_name: 'Анар',
    customer_phone: '87071234567',
    created_at: '2026-11-02T06:00:00.000Z',
    total_sum: 7000,
  }),
  order({
    id: 'b',
    customer_name: 'Anar',
    customer_phone: '+77071234567',
    created_at: '2026-11-06T06:00:00.000Z',
    total_sum: 7000,
  }),
  order({
    id: 'c',
    customer_name: 'Анар',
    customer_phone: '7071234567',
    created_at: '2026-11-07T06:00:00.000Z',
    total_sum: 7000,
  }),
]);
if (sameClient.uniqueCustomers !== 1) fail(`same phone formats must merge: ${sameClient.uniqueCustomers}`);
if (sameClient.customers[0].phone !== '+77071234567') fail('canon key');
if (sameClient.customers[0].names.length < 2) fail('keep both names of one client');
if (sameClient.newCustomers !== 1) fail('first recognition in November is new');
if (sameClient.repeatCustomers !== 1) fail('repeat 2+ recognized');
if (sameClient.periodIdentifiedRevenue !== 21000) fail(`revenue ${sameClient.periodIdentifiedRevenue}`);

const sameName = report([
  order({ id: 'n1', customer_name: 'Анар', customer_phone: '87071111111', total_sum: 1000 }),
  order({ id: 'n2', customer_name: 'Анар', customer_phone: '87072222222', total_sum: 2000 }),
]);
if (sameName.uniqueCustomers !== 2) fail('same name different phones stay split');

const multiCity = report([
  order({ id: 'm1', customer_phone: '87071234567', customer_name: 'Анар', city_id: 'c1', total_sum: 1000 }),
  order({ id: 'm2', customer_phone: '87071234567', customer_name: 'Анар', city_id: 'c2', total_sum: 4000 }),
]);
if (multiCity.customers[0].cities.length !== 2) fail('one client several cities');
const almatyOnly = report(multiCity.customers.length ? [
  order({ id: 'm1', customer_phone: '87071234567', customer_name: 'Анар', city_id: 'c1', total_sum: 1000 }),
  order({ id: 'm2', customer_phone: '87071234567', customer_name: 'Анар', city_id: 'c2', total_sum: 4000 }),
] : [], { cityId: 'c1' });
if (almatyOnly.uniqueCustomers !== 1) fail('city filter keeps client');
if (almatyOnly.periodIdentifiedRevenue !== 1000) fail('city period revenue only that city');
if (almatyOnly.customers[0].lifetimeRecognizedCount !== 2) fail('lifetime counts all cities');

const debtUnpaid = report([
  order({
    id: 'd1',
    customer_phone: '87071234567',
    customer_name: 'Анар',
    is_debt: true,
    payment_type: 'debt',
    debt_status: 'active',
    total_sum: 5000,
    created_at: '2026-11-03T06:00:00.000Z',
  }),
]);
if (debtUnpaid.periodIdentifiedRevenue !== 0) fail('unpaid debt not in revenue');
if (debtUnpaid.unpaidDebtAmount !== 5000) fail('unpaid debt listed separately');
if (debtUnpaid.customers[0].isNewInPeriod !== false) fail('unpaid debt is not a recognized first purchase');

const debtPaid = report([
  order({
    id: 'd2',
    customer_phone: '87071234567',
    debt_customer_phone: '87071234567',
    debt_customer_name: 'Анар',
    is_debt: true,
    payment_type: 'debt',
    debt_status: 'paid',
    debt_paid_at: '2026-11-08T06:00:00.000Z',
    total_sum: 5000,
    created_at: '2026-10-01T06:00:00.000Z',
  }),
]);
if (debtPaid.periodIdentifiedRevenue !== 5000) fail('paid debt recognized on paid date');
if (debtPaid.newCustomers !== 1) fail('first recognition in period is new');

const preorderOpen = report([
  order({
    id: 'p1',
    customer_phone: '87071234567',
    is_preorder: true,
    preorder_status: 'pending',
    total_sum: 3000,
  }),
]);
if (preorderOpen.periodIdentifiedRevenue !== 0) fail('open preorder not revenue');

const preorderDone = report([
  order({
    id: 'p2',
    customer_phone: '87071234567',
    is_preorder: true,
    preorder_status: 'fulfilled',
    fulfilled_at: '2026-11-04T06:00:00.000Z',
    total_sum: 3000,
    created_at: '2026-10-20T06:00:00.000Z',
  }),
]);
if (preorderDone.periodIdentifiedRevenue !== 3000) fail('fulfilled preorder by fulfilled_at');

const canceled = report([
  order({ id: 'x1', customer_phone: '87071234567', status: 'canceled', total_sum: 9000 }),
  order({ id: 'x2', customer_phone: '87071234567', total_sum: 1000 }),
]);
if (canceled.periodIdentifiedRevenue !== 1000) fail('canceled excluded from revenue');
if (canceled.identifiedOrders !== 1) fail('coverage ignores canceled');

const gifts = report([
  order({
    id: 'g1',
    customer_phone: '87071234567',
    total_sum: 7000,
    order_items: [
      { product_id: 'tea', qty: 1, price: 7000, line_sum: 7000, is_gift: false, product_name_snapshot: 'Чай' },
      { product_id: 'gift', qty: 1, price: 0, line_sum: 0, is_gift: true, product_name_snapshot: 'Подарок' },
    ],
  }),
]);
if (gifts.periodIdentifiedRevenue !== 7000) fail('gifts do not add revenue');
if (gifts.customers[0].favoriteProducts.some((p) => p.key === 'gift')) fail('gifts not favorite products');
if (gifts.customers[0].history[0].revenue !== 7000) fail('history revenue skips gifts');

const oldCanon = orderCustomerCanon({
  id: 'old',
  debt_customer_phone: '8 707 123 45 67',
  debt_customer_name: 'Анар',
});
if (oldCanon !== '+77071234567') fail('old debt phone normalized on read');

const outside = report([
  order({
    id: 'old1',
    customer_phone: '87071234567',
    created_at: '2026-09-01T06:00:00.000Z',
    total_sum: 1000,
  }),
  order({
    id: 'new1',
    customer_phone: '87071234567',
    created_at: '2026-11-05T06:00:00.000Z',
    total_sum: 2000,
  }),
]);
if (outside.newCustomers !== 0) fail('prior history means not new in period');
if (outside.repeatCustomers !== 1) fail('repeat uses full history');
if (outside.customers[0].isNewInPeriod) fail('returning client must not be marked new');
if (!outside.customers[0].isRepeat) fail('returning client is repeat');
if (outside.periodIdentifiedRevenue !== 2000) fail('period revenue only November');

const inactive = report(
  [
    order({
      id: 'i30',
      customer_phone: '87070000001',
      created_at: '2026-10-01T06:00:00.000Z',
      total_sum: 1,
    }),
    order({
      id: 'i90',
      customer_phone: '87070000002',
      created_at: '2026-07-01T06:00:00.000Z',
      total_sum: 1,
    }),
  ],
  {
    range: {
      from: new Date('2026-07-01T00:00:00+05:00'),
      toNext: new Date('2026-12-01T00:00:00+05:00'),
    },
  }
);
if (inactive.inactive30 !== 2) fail(`inactive30 ${inactive.inactive30}`);
if (inactive.inactive90 !== 1) fail(`inactive90 ${inactive.inactive90}`);
const only90 = filterCustomerRows(inactive.customers, { nameQuery: '', phoneQuery: '', inactive: '90' });
if (only90.length !== 1 || only90[0].phone !== '+77070000002') fail('inactive 90 filter');

const search = filterCustomerRows(sameName.customers, { nameQuery: 'анар', phoneQuery: '707111', inactive: 'all' });
if (search.length !== 1) fail('name+phone search');

const sorted = sortCustomerRows(sameName.customers, 'revenue');
if (sorted[0].phone !== '+77072222222') fail('sort revenue');

const firstOnly = report([
  order({ id: 'f1', customer_phone: '87073333333', customer_name: 'Новый', total_sum: 1000 }),
]);
if (firstOnly.newCustomers !== 1 || firstOnly.repeatCustomers !== 0) fail('single order is new, not repeat');

const unnamed = report([order({ id: 'u1', total_sum: 5000, created_at: '2026-11-05T06:00:00.000Z' })]);
if (unnamed.identifiedOrders !== 0 || unnamed.unidentifiedOrders !== 1) fail('orders without phone');
if (unnamed.uniqueCustomers !== 0) fail('no phone is not a customer');
if (unnamed.coveragePct == null || Math.abs(unnamed.coveragePct - 0) > 0.01) fail('coverage 0');

const mixedCov = report([
  order({ id: 'k1', customer_phone: '87071234567', total_sum: 1 }),
  order({ id: 'k2', total_sum: 1 }),
]);
if (mixedCov.coveragePct == null || Math.abs(mixedCov.coveragePct - 50) > 0.01) fail('coverage 50');

const dup = report([
  order({ id: 'dup', customer_phone: '87071234567', total_sum: 1000 }),
  order({ id: 'dup', customer_phone: '87071234567', total_sum: 1000 }),
]);
if (dup.loadedOrders !== 1 || dup.periodIdentifiedRevenue !== 1000) fail('dedupe order id');

const incomplete = report([order({ id: 't1', customer_phone: '87071234567' })], {
  complete: false,
  totalOrders: 25000,
});
if (incomplete.complete) fail('truncated must not be complete');
if ((incomplete.totalOrders || 0) < 20000) fail('expose true total when known');
if (formatCustomerKpi(12, false) !== '—') fail('hide exact KPI when incomplete');
if (formatCustomerKpi(0, true) !== '0') fail('zero KPI still shown when complete');

const exactCap = customerOrdersFetchStatus({
  loaded: 20000,
  total: 20000,
  lastChunkLength: 1000,
  pageSize: 1000,
  max: 20000,
});
if (!exactCap.complete || exactCap.truncated) fail('exactly 20000 orders is complete');
const overCap = customerOrdersFetchStatus({
  loaded: 20000,
  total: 20001,
  lastChunkLength: 1000,
  pageSize: 1000,
  max: 20000,
});
if (overCap.complete || !overCap.truncated) fail('20001 must hide exact KPI');
const short = customerOrdersFetchStatus({
  loaded: 1500,
  total: 1500,
  lastChunkLength: 500,
  pageSize: 1000,
  max: 20000,
});
if (!short.complete) fail('short last page complete');

const thisMonth = resolveCustomerRange({
  mode: 'thisMonth',
  year: 2020,
  month: 1,
  customFrom: '',
  customTo: '',
  todayYmd: '2026-11-08',
});
if (!thisMonth || thisMonth.fromYmd !== '2026-11-01' || thisMonth.toYmd !== '2026-11-30') fail('this month');
const last = lastMonthRangeYmd('2026-11-08');
if (last.fromYmd !== '2026-10-01' || last.toYmd !== '2026-10-31') fail('last month');
const year = yearRangeYmd(2026);
if (year.fromYmd !== '2026-01-01' || year.toYmd !== '2026-12-31') fail('year');

const avg = sameClient.averageCheck;
if (avg == null || Math.abs(avg - 7000) > 0.01) fail('average check');

if (!read('lib/fetchAdminStatsOrders.ts').includes('ORDER_STATS_MAX = 20000')) fail('keep 20k cap');
if (!CUSTOMER_ORDER_SELECT.includes('customer_phone_canon')) fail('select canon');
if (!CUSTOMER_ORDER_SELECT.includes('debt_customer_phone')) fail('select old debt phone');
if (!CUSTOMER_ORDER_SELECT.includes('is_gift')) fail('select gifts');

const fetchSrc = read('lib/fetchAdminCustomerOrders.ts');
if (!fetchSrc.includes('ORDER_STATS_MAX')) fail('fetch uses 20k cap');
if (!fetchSrc.includes("count: 'exact'")) fail('exact order count');
if (!fetchSrc.includes('complete')) fail('complete flag');
if (!fetchSrc.includes('customerOrdersFetchStatus')) fail('completeness helper');
if (fetchSrc.includes('console.log')) fail('fetch must not log');
if (fetchSrc.includes('confirm_order') || fetchSrc.includes('apply_inventory')) fail('no stock/confirm');

const lib = read('lib/adminCustomers.ts');
if (!lib.includes('normalizeCustomerPhone')) fail('use phone canon');
if (!lib.includes('isConfirmedInRange') || !lib.includes('getAccountingDate')) fail('use accounting');
if (!lib.includes('isUnpaidDebt')) fail('unpaid debts');
if (lib.includes('console.log')) fail('analytics must not log phones');

const page = read('app/admin/customers/page.tsx');
const nav = read('components/NavAdmin.tsx');
const i18n = read('lib/i18n.tsx');
const managerNav = read('components/NavManager.tsx');
if (!existsSync(join(process.cwd(), 'app/admin/customers/page.tsx'))) fail('customers page missing');
if (!page.includes('Protected role="admin"')) fail('admin-only page');
if (!page.includes('bg-slate-50') || !page.includes('rounded-2xl')) fail('saas layout');
if (!page.includes('grid-cols-2')) fail('kpi grid');
if (!page.includes('let cancelled = false')) fail('load cancel');
if (!page.includes('runExclusive')) fail('coalesce overlapping fetches');
if (!page.includes('[refreshKey]')) fail('orders load must not depend on period filters');
if (page.includes('console.log')) fail('page must not log');
if (page.includes('/api/')) fail('no public customer API');
if (!page.includes('customers.truncated') || !page.includes('customers.identifiedShare')) fail('coverage copy');
if (!page.includes("role=\"admin\"")) fail('role admin');
if (!nav.includes('href="/admin/customers"')) fail('nav customers');
if (managerNav.includes('/admin/customers')) fail('manager must not see customers');
if (!i18n.includes("'customers.nav': 'Клиенты'") || !i18n.includes("'customers.nav': 'Клиенттер'")) fail('i18n nav');
const keys = [...i18n.matchAll(/'(customers\.[^']+)':/g)].map((m) => m[1]);
const ruSet = new Set(keys.slice(0, keys.length / 2));
const kzSet = new Set(keys.slice(keys.length / 2));
for (const key of ruSet) if (!kzSet.has(key)) fail(`kz missing ${key}`);
for (const key of kzSet) if (!ruSet.has(key)) fail(`ru missing ${key}`);

console.log('admin-customers checks ok');
