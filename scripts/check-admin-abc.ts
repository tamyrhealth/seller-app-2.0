import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { assignAbcClasses, buildAdminAbc, visibleAbcRows, type AbcProductRow } from '../lib/adminAbc';
import { abcCogsHintKey, formatAbcPct, paretoPoints, resolveAbcRange, sortAbcRows } from '../lib/adminAbcView';
import { buildAdminFinance, type FinanceOrder } from '../lib/adminFinance';
import { resolveFinanceRange } from '../lib/adminFinanceView';
import { ordersForCityView } from '../lib/adminFinanceView';
import { lastMonthRangeYmd, yearRangeYmd } from '../lib/adminCustomersView';

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
const fromYmd = '2026-11-08';
const toYmd = '2026-11-08';

function item(
  productId: string,
  qty: number,
  lineSum: number,
  extra?: { gift?: boolean; name?: string; id?: string }
): NonNullable<FinanceOrder['order_items']>[number] {
  return {
    id: extra?.id,
    product_id: productId,
    qty,
    price: extra?.gift ? 0 : lineSum / qty,
    line_sum: extra?.gift ? 0 : lineSum,
    is_gift: extra?.gift || false,
    product: { name: extra?.name || productId, unit: 'pcs' },
  };
}

function order(partial: Partial<FinanceOrder> & { id: string; total_sum: number; order_items: FinanceOrder['order_items'] }): FinanceOrder {
  return {
    city_id: 'c1',
    created_at: '2026-11-08T06:00:00.000Z',
    status: 'confirmed',
    payment_type: 'kaspi',
    ...partial,
  };
}

function abc(partial: Parameters<typeof buildAdminAbc>[0] extends infer T ? Partial<T> : never, orders: FinanceOrder[]) {
  return buildAdminAbc({
    orders,
    costs: [
      { id: 'pA', cost_price: 100 },
      { id: 'pB', cost_price: 100 },
      { id: 'pC', cost_price: 100 },
      { id: 'pD', cost_price: 100 },
      { id: 'pE', cost_price: 100 },
      { id: 'p1', cost_price: 1000 },
      { id: 'p2', cost_price: 1000 },
    ],
    range,
    fromYmd,
    toYmd,
    cityId: 'all',
    catalog: new Map([
      ['pA', { isActive: true }],
      ['pB', { isActive: true }],
      ['pC', { isActive: false }],
      ['pD', { isActive: true }],
      ['pE', { isActive: true }],
      ['p1', { isActive: true }],
      ['p2', { isActive: true }],
    ]),
    catalogFilter: 'all',
    mode: 'revenue',
    complete: true,
    ...partial,
  });
}

function classesOf(rows: AbcProductRow[]) {
  return Object.fromEntries(rows.map((row) => [row.productId, row.abcClass]));
}

// --- thresholds 80 / 95 and boundary item stays in higher class ---
const thresholdOrders = [
  order({ id: 'oA', total_sum: 8000, order_items: [item('pA', 1, 8000, { name: 'A' })] }),
  order({ id: 'oB', total_sum: 1500, order_items: [item('pB', 1, 1500, { name: 'B' })] }),
  order({ id: 'oC', total_sum: 500, order_items: [item('pC', 1, 500, { name: 'C' })] }),
];
const thr = abc({}, thresholdOrders);
const byId = Object.fromEntries(thr.rows.map((r) => [r.productId, r]));
if (byId.pA.abcClass !== 'A' || Math.abs((byId.pA.share || 0) - 0.8) > 1e-9) fail('80% item is A and crosses 80');
if (byId.pB.abcClass !== 'B') fail('item starting at 80% is B and crosses 95');
if (byId.pC.abcClass !== 'C') fail('remainder is C');
if (thr.countA !== 1 || thr.countB !== 1 || thr.countC !== 1) fail('class counts');

const assigned = assignAbcClasses(
  [
    { id: 'x', v: 81 },
    { id: 'y', v: 14 },
    { id: 'z', v: 5 },
  ],
  (row) => row.v,
  (row) => row.id
);
if (assigned[0].abcClass !== 'A' || assigned[1].abcClass !== 'B' || assigned[2].abcClass !== 'C') {
  fail('crossing 81/14/5 stays in higher class');
}

// --- equal values stay in the same class ---
const ties = assignAbcClasses(
  [
    { id: 'a', v: 90 },
    { id: 'b', v: 5 },
    { id: 'c', v: 5 },
  ],
  (row) => row.v,
  (row) => row.id
);
if (ties[1].abcClass !== ties[2].abcClass) fail('equal values must not split classes');
if (ties[1].abcClass !== 'B') fail('tied remainder group is B');

// --- one product in several lines ---
const multi = abc(
  {},
  [
    order({
      id: 'o-multi',
      total_sum: 3000,
      order_items: [item('pA', 1, 1000, { name: 'A' }), item('pA', 2, 2000, { name: 'A' })],
    }),
  ]
);
if (multi.rows.length !== 1 || multi.rows[0].productId !== 'pA') fail('group by product_id not name');
if (multi.rows[0].qtySold !== 3 || multi.rows[0].revenue !== 3000) fail('multi-line qty/revenue');

const sameName = abc(
  {},
  [
    order({
      id: 'o-names',
      total_sum: 3000,
      order_items: [
        item('pA', 1, 1000, { name: 'Same' }),
        item('pB', 1, 2000, { name: 'Same' }),
      ],
    }),
  ]
);
if (sameName.rows.length !== 2) fail('same name different ids stay separate');

// --- gifts ---
const gift = abc(
  { costs: [{ id: 'p1', cost_price: 1000 }] },
  [
    order({
      id: 'o-gift',
      total_sum: 10000,
      order_items: [
        item('p1', 2, 10000, { name: 'Milk' }),
        item('p1', 1, 0, { name: 'Milk', gift: true }),
      ],
    }),
  ]
);
if (gift.revenue !== 10000) fail('gift does not add revenue');
if (gift.rows[0].qtyGift !== 1 || gift.rows[0].qtySold !== 2) fail('gift qty');
if (gift.rows[0].cogsKnown !== 3000) fail('gift enters estimated cogs');
if (gift.estimatedGrossProfit !== 7000) fail('gross after gift cogs');
if (gift.cogsQuality !== 'estimated' || gift.cogsIsHistorical) fail('abc catalog is not historical');

const snapAbc = abc(
  {
    costs: [{ id: 'p1', cost_price: 9999 }],
    itemSnapshots: new Map([['abc-i1', 400]]),
  },
  [order({ id: 'o-snap', total_sum: 10000, order_items: [item('p1', 2, 10000, { name: 'Milk', id: 'abc-i1' })] })]
);
if (snapAbc.rows[0].cogsKnown !== 800) fail('abc uses snapshot not later catalog');
if (snapAbc.estimatedGrossProfit !== 9200) fail('abc profit from snapshot');
if (snapAbc.cogsQuality !== 'historical' || !snapAbc.cogsIsHistorical) fail('abc all snapshots historical');

const mixedAbc = abc(
  {
    costs: [{ id: 'p1', cost_price: 1000 }],
    itemSnapshots: new Map([
      ['abc-h', 400],
      ['abc-e', null],
    ]),
  },
  [
    order({
      id: 'o-mix',
      total_sum: 10000,
      order_items: [
        item('p1', 1, 5000, { name: 'Milk', id: 'abc-h' }),
        item('p1', 1, 5000, { name: 'Milk', id: 'abc-e' }),
      ],
    }),
  ]
);
if (mixedAbc.rows[0].cogsKnown !== 1400) fail('abc mixed snapshot+catalog');
if (mixedAbc.cogsQuality !== 'mixed' || mixedAbc.cogsIsHistorical) fail('abc mixed is not historical');

const rpcAbc = abc(
  { costs: [{ id: 'p1', cost_price: 1000 }], itemSnapshotsUnavailable: true },
  [order({ id: 'o-rpc', total_sum: 10000, order_items: [item('p1', 2, 10000, { name: 'Milk', id: 'abc-i1' })] })]
);
if (rpcAbc.rows[0].cogsKnown !== 2000) fail('abc rpc fail catalog fallback');
if (rpcAbc.cogsIsHistorical) fail('abc rpc fail not historical');

// --- unpaid debt vs repayment ---
const unpaidDebt: FinanceOrder = {
  id: 'o-debt',
  city_id: 'c1',
  total_sum: 8000,
  created_at: '2026-11-08T06:00:00.000Z',
  status: 'confirmed',
  payment_type: 'debt',
  is_debt: true,
  debt_status: 'active',
  order_items: [item('p1', 1, 8000, { name: 'Milk' })],
};
if (abc({ costs: [{ id: 'p1', cost_price: 1000 }] }, [unpaidDebt]).revenue !== 0) fail('unpaid debt is not revenue');
const repaid: FinanceOrder = { ...unpaidDebt, debt_status: 'paid', debt_paid_at: '2026-11-08T12:00:00.000Z' };
if (abc({ costs: [{ id: 'p1', cost_price: 1000 }] }, [repaid]).revenue !== 8000) fail('repaid debt is revenue');

// --- preorders ---
const pendingPre: FinanceOrder = {
  id: 'o-pre',
  city_id: 'c1',
  total_sum: 3000,
  created_at: '2026-11-08T06:00:00.000Z',
  status: 'confirmed',
  payment_type: 'cash',
  is_preorder: true,
  preorder_status: 'pending',
  order_items: [item('p1', 1, 3000, { name: 'Milk' })],
};
if (abc({ costs: [{ id: 'p1', cost_price: 1000 }] }, [pendingPre]).revenue !== 0) fail('pending preorder is not revenue');
const fulfilledPre: FinanceOrder = {
  ...pendingPre,
  preorder_status: 'fulfilled',
  fulfilled_at: '2026-11-08T15:00:00.000Z',
};
if (abc({ costs: [{ id: 'p1', cost_price: 1000 }] }, [fulfilledPre]).revenue !== 3000) fail('fulfilled preorder is revenue');

// --- cancellations ---
const cancelled = abc(
  { costs: [{ id: 'p1', cost_price: 1000 }] },
  [{ ...repaid, id: 'o-cancel', status: 'canceled' }]
);
if (cancelled.revenue !== 0 || cancelled.rows.some((r) => r.abcClass)) fail('cancelled excluded');

// --- zero revenue ---
const zeroOnly = abc(
  { costs: [{ id: 'p1', cost_price: 1000 }] },
  [
    order({
      id: 'o-zero',
      total_sum: 0,
      order_items: [item('p1', 1, 0, { name: 'Milk', gift: true })],
    }),
  ]
);
if (zeroOnly.rows[0].abcClass !== null) fail('zero revenue has no class');
if (zeroOnly.rows[0].rankTag !== 'zero_revenue') fail('zero revenue tag');

// --- duplicate order_id ---
const dup = abc({ costs: [{ id: 'p1', cost_price: 1000 }] }, [repaid, repaid]);
if (dup.revenue !== 8000) fail('duplicate order_id must not double');

// --- missing cost blocks profit ABC, not treated as zero ---
const missing = abc(
  { mode: 'profit', costs: [{ id: 'pA', cost_price: null }, { id: 'pB', cost_price: 100 }] },
  [
    order({ id: 'o-miss-a', total_sum: 8000, order_items: [item('pA', 1, 8000, { name: 'A' })] }),
    order({ id: 'o-miss-b', total_sum: 2000, order_items: [item('pB', 1, 2000, { name: 'B' })] }),
  ]
);
if (missing.profitAbcAvailable) fail('missing cost blocks profit ABC');
if (missing.profitAbcBlockedReason !== 'missing_cost') fail('missing_cost reason');
if (missing.rows.some((r) => r.abcClass)) fail('no profit classes when cost missing');
if (missing.estimatedGrossProfit !== null) fail('headline gross hidden when cost missing');
if (missing.rows.find((r) => r.productId === 'pA')?.estimatedGrossProfit != null) fail('null cost is not zero');

// --- negative profit tagged separately ---
const loss = abc(
  {
    mode: 'profit',
    costs: [
      { id: 'pA', cost_price: 100 },
      { id: 'pB', cost_price: 5000 },
    ],
  },
  [
    order({ id: 'o-win', total_sum: 8000, order_items: [item('pA', 1, 8000, { name: 'A' })] }),
    order({ id: 'o-loss', total_sum: 500, order_items: [item('pB', 1, 500, { name: 'B' })] }),
  ]
);
const lossRow = loss.rows.find((r) => r.productId === 'pB');
const winRow = loss.rows.find((r) => r.productId === 'pA');
if (lossRow?.rankTag !== 'loss' || lossRow.abcClass !== null) fail('loss tagged, no class');
if (winRow?.abcClass !== 'A') fail('positive profit still ranked');
if (!loss.profitAbcAvailable) fail('overall positive gross still allows profit ABC');

// --- zero profit no class ---
const zeroProfit = abc(
  { mode: 'profit', costs: [{ id: 'pA', cost_price: 8000 }, { id: 'pB', cost_price: 100 }] },
  [
    order({ id: 'o-zp', total_sum: 8000, order_items: [item('pA', 1, 8000, { name: 'A' })] }),
    order({ id: 'o-pos', total_sum: 2000, order_items: [item('pB', 1, 2000, { name: 'B' })] }),
  ]
);
if (zeroProfit.rows.find((r) => r.productId === 'pA')?.rankTag !== 'zero_profit') fail('zero profit tag');
if (zeroProfit.rows.find((r) => r.productId === 'pA')?.abcClass) fail('zero profit has no class');

// --- non-positive total gross ---
const allLoss = abc(
  { mode: 'profit', costs: [{ id: 'pA', cost_price: 9000 }, { id: 'pB', cost_price: 9000 }] },
  [
    order({ id: 'o-l1', total_sum: 1000, order_items: [item('pA', 1, 1000, { name: 'A' })] }),
    order({ id: 'o-l2', total_sum: 1000, order_items: [item('pB', 1, 1000, { name: 'B' })] }),
  ]
);
if (allLoss.profitAbcAvailable || allLoss.profitAbcBlockedReason !== 'non_positive_total') fail('non-positive total blocks profit ABC');
if (allLoss.rows.some((r) => r.abcClass)) fail('no classes when total gross <= 0');

// --- city recalculates ranking ---
const cityOrders = [
  order({ id: 'o-c1', city_id: 'c1', total_sum: 9000, order_items: [item('pA', 1, 9000, { name: 'A' })] }),
  order({ id: 'o-c2', city_id: 'c2', total_sum: 1000, order_items: [item('pB', 1, 1000, { name: 'B' })] }),
];
const allCities = abc({}, cityOrders);
if (classesOf(allCities.rows).pA !== 'A' || classesOf(allCities.rows).pB !== 'B') fail('all-cities ranking');
const city1 = abc({ cityId: 'c1' }, cityOrders);
if (city1.rows.length !== 1 || city1.rows[0].productId !== 'pA' || city1.rows[0].abcClass !== 'A') fail('city ranking uses city total');
if (city1.revenue !== 9000) fail('city revenue');

// --- active/archived hide rows but keep denominator ---
const mixedCat = abc({ catalogFilter: 'active' }, thresholdOrders);
const visible = visibleAbcRows(mixedCat);
if (visible.some((r) => r.productId === 'pC')) fail('archived hidden from display');
if (!mixedCat.rows.find((r) => r.productId === 'pC')?.displayExcluded) fail('archived marked excluded');
if (mixedCat.countC !== 1) fail('hiding rows must not change class counts');
const archivedA = mixedCat.rows.find((r) => r.productId === 'pA');
if (archivedA?.abcClass !== 'A' || Math.abs((archivedA.share || 0) - 0.8) > 1e-9) fail('share keeps full denominator');

// --- 20 000 truncated ---
const truncated = abc({ complete: false }, thresholdOrders);
if (truncated.rows.some((r) => r.abcClass) || truncated.countA !== 0) fail('truncated hides classes');
if (truncated.profitAbcBlockedReason !== 'truncated') fail('truncated blocks profit ABC');

// --- match finance report ---
const financeOrders = [
  order({ id: 'o-f1', total_sum: 10000, order_items: [item('p1', 2, 10000, { name: 'Milk' }), item('p1', 1, 0, { name: 'Milk', gift: true })] }),
  order({ id: 'o-f2', city_id: 'c2', total_sum: 3000, order_items: [item('p2', 1, 3000, { name: 'Tea' })] }),
];
const costs = [
  { id: 'p1', cost_price: 1000 },
  { id: 'p2', cost_price: 500 },
];
for (const cityId of ['all', 'c1', 'c2'] as const) {
  const finance = buildAdminFinance({
    orders: ordersForCityView(financeOrders, cityId),
    range,
    fromYmd,
    toYmd,
    costs,
    expenses: [{ expense_date: fromYmd, category: 'ads', amount: 999, city_id: cityId === 'all' ? null : cityId }],
    cityNames: new Map(),
    expensesInputComplete: true,
  });
  const abcR = abc({ costs, cityId, catalog: new Map([['p1', { isActive: true }], ['p2', { isActive: true }]]) }, financeOrders);
  if (abcR.revenue !== finance.revenue) fail(`revenue mismatch vs finance ${cityId}`);
  if (abcR.estimatedGrossProfit !== finance.estimatedGrossProfit) fail(`gross mismatch vs finance ${cityId}`);
}

// --- ranges ---
const thisMonth = resolveAbcRange({
  mode: 'thisMonth',
  year: 2020,
  month: 1,
  customFrom: '',
  customTo: '',
  todayYmd: '2026-11-08',
});
if (!thisMonth || thisMonth.fromYmd !== '2026-11-01' || thisMonth.toYmd !== '2026-11-08') fail('abc thisMonth to today');
const financeThisMonth = resolveFinanceRange({ mode: 'thisMonth', customFrom: '', customTo: '', todayYmd: '2026-11-08' });
if (!financeThisMonth || financeThisMonth.fromYmd !== thisMonth.fromYmd || financeThisMonth.toYmd !== thisMonth.toYmd) {
  fail('abc thisMonth must match finance');
}
if (abcCogsHintKey({ cogsQuality: 'historical' }) !== 'abc.cogsHistorical') fail('abc historical label');
if (abcCogsHintKey({ cogsQuality: 'estimated' }) !== 'abc.cogsEstimated') fail('abc estimated label');
if (abcCogsHintKey({ cogsQuality: 'mixed' }) !== 'abc.cogsMixed') fail('abc mixed label');
if (abcCogsHintKey({ cogsQuality: 'incomplete' }) !== 'abc.cogsIncomplete') fail('abc incomplete label');
const last = lastMonthRangeYmd('2026-11-08');
if (last.fromYmd !== '2026-10-01' || last.toYmd !== '2026-10-31') fail('last month');
if (yearRangeYmd(2026).fromYmd !== '2026-01-01') fail('year');
if (formatAbcPct(0.8, true) !== '80.0%') fail('pct format');
if (formatAbcPct(0.8, false) !== '—') fail('pct hidden when incomplete');

const sorted = sortAbcRows(
  [
    { productId: 'b', name: 'Beta', unit: 'pcs', isActive: true, qtySold: 1, qtyGift: 0, revenue: 10, cogsKnown: 1, costMissing: false, estimatedGrossProfit: 9, share: 0.1, cumShare: 1, abcClass: 'C', rankTag: 'ranked', displayExcluded: false },
    { productId: 'a', name: 'Alpha', unit: 'pcs', isActive: true, qtySold: 2, qtyGift: 0, revenue: 90, cogsKnown: 1, costMissing: false, estimatedGrossProfit: 89, share: 0.9, cumShare: 0.9, abcClass: 'A', rankTag: 'ranked', displayExcluded: false },
  ],
  'revenue'
);
if (sorted[0].productId !== 'a') fail('sort by revenue');

const named = sortAbcRows(thr.rows, 'name');
const chart = paretoPoints(named);
if (chart.length < 2) fail('pareto needs ranked rows');
for (let i = 1; i < chart.length; i += 1) {
  if (chart[i].cumPct + 1e-9 < chart[i - 1].cumPct) fail('pareto must stay in cumulative order');
}

const revRank = abc({ mode: 'revenue', costs: [{ id: 'pA', cost_price: 7900 }, { id: 'pB', cost_price: 100 }] }, [
  order({ id: 'o-ind-a', total_sum: 8000, order_items: [item('pA', 1, 8000, { name: 'A' })] }),
  order({ id: 'o-ind-b', total_sum: 2000, order_items: [item('pB', 1, 2000, { name: 'B' })] }),
]);
const profitRank = abc({ mode: 'profit', costs: [{ id: 'pA', cost_price: 7900 }, { id: 'pB', cost_price: 100 }] }, [
  order({ id: 'o-ind-a', total_sum: 8000, order_items: [item('pA', 1, 8000, { name: 'A' })] }),
  order({ id: 'o-ind-b', total_sum: 2000, order_items: [item('pB', 1, 2000, { name: 'B' })] }),
]);
if (classesOf(revRank.rows).pA !== 'A' || classesOf(revRank.rows).pB !== 'B') fail('revenue ranking');
if (classesOf(profitRank.rows).pB !== 'A' || classesOf(profitRank.rows).pA === classesOf(profitRank.rows).pB) {
  fail('profit ranking must be independent');
}

const withGhost = abc(
  { catalog: new Map([['pA', { isActive: true }], ['pGhost', { isActive: true }]]) },
  [order({ id: 'o-only-a', total_sum: 1000, order_items: [item('pA', 1, 1000, { name: 'A' })] })]
);
if (withGhost.rows.some((r) => r.productId === 'pGhost') || withGhost.rows.some((r) => r.abcClass && r.revenue <= 0)) {
  fail('product without period sales must not get a class');
}

// --- files / honesty ---
const lib = read('lib/adminAbc.ts');
const page = read('app/admin/abc/page.tsx');
const nav = read('components/NavAdmin.tsx');
const i18n = read('lib/i18n.tsx');
const managerNav = read('components/NavManager.tsx');
const sellerNav = read('components/NavSeller.tsx');
if (!existsSync(join(process.cwd(), 'lib/adminAbc.ts'))) fail('adminAbc missing');
if (!existsSync(join(process.cwd(), 'lib/adminAbcView.ts'))) fail('adminAbcView missing');
if (!existsSync(join(process.cwd(), 'app/admin/abc/page.tsx'))) fail('abc page missing');
if (!lib.includes('isConfirmedInRange') && !lib.includes('buildAdminFinance')) fail('reuse finance/accounting');
if (!lib.includes('mergeFinanceOrders')) fail('dedupe order_id');
if (!lib.includes('allocateOrderLines') && !read('lib/adminFinance.ts').includes('allocateOrderLines')) fail('line allocation');
if (!page.includes('Protected role="admin"')) fail('admin-only');
if (!page.includes('fetchRecognizedWindow')) fail('recognized window');
if (!page.includes('FINANCE_COSTS_RPC')) fail('admin_product_costs');
if (!page.includes('FINANCE_ITEM_SNAPSHOTS_RPC') || !page.includes('snapshotsUnavailable')) fail('abc snapshot rpc');
if (!page.includes('finance.cogsMixed')) fail('abc mixed banner');
if (page.includes('cost_price') && page.includes("from('products')")) fail('must not select products.cost_price');
if (!page.includes("select('id, is_active')")) fail('catalog without cost');
if (!page.includes('bg-slate-50') || !page.includes('grid-cols-2')) fail('saas layout');
if (!page.includes('let cancelled = false')) fail('load cancel');
if (!page.includes('runExclusive')) fail('coalesce fetches');
if (page.includes('console.log')) fail('page must not log');
if (page.includes('/api/')) fail('no public abc API');
if (!page.includes('abcCogsHintKey')) fail('cogs quality labels');
if (!page.includes('abc.truncated')) fail('truncated copy');
if (!nav.includes("/admin/abc") || !nav.includes("t('abc.nav')")) fail('nav abc');
if (managerNav.includes('/admin/abc')) fail('manager must not see abc');
if (sellerNav.includes('/admin/abc')) fail('seller must not see abc');
if (page.includes(', t]')) fail('language switch must not refetch orders');
if (!page.includes('paretoPoints(visibleAbcTableRows(report))')) fail('pareto uses ranking not table sort');
if (!i18n.includes("'abc.nav': 'ABC'") || !i18n.includes("'abc.cogsHistorical': 'Историческая себестоимость'")) fail('i18n ru');
if (!i18n.includes("'abc.cogsEstimated': 'Оценочная себестоимость'")) fail('i18n estimated ru');
if (!i18n.includes("'abc.cogsMixed': 'Смешанная себестоимость'")) fail('i18n mixed ru');
if (!i18n.includes("'abc.cogsIncomplete': 'Недостаточно данных'")) fail('i18n incomplete ru');
if (!i18n.includes("'abc.cogsHistorical': 'Тарихи өзіндік құн'")) fail('i18n kz historical');
if (!i18n.includes("'abc.cogsEstimated': 'Бағаланған өзіндік құн'")) fail('i18n kz estimated');
if (!i18n.includes("'abc.cogsMixed': 'Аралас өзіндік құн'")) fail('i18n kz mixed');
if (!i18n.includes("'abc.cogsIncomplete': 'Дерек жеткіліксіз'")) fail('i18n kz incomplete');
const keys = [...i18n.matchAll(/'(abc\.[^']+)':/g)].map((m) => m[1]);
const ruSet = new Set(keys.slice(0, keys.length / 2));
const kzSet = new Set(keys.slice(keys.length / 2));
for (const key of ruSet) if (!kzSet.has(key)) fail(`kz missing ${key}`);
for (const key of kzSet) if (!ruSet.has(key)) fail(`ru missing ${key}`);
if (!read('lib/fetchAdminStatsOrders.ts').includes('ORDER_STATS_MAX = 20000')) fail('keep 20k cap');
if (lib.includes('estimatedNetProfit') && lib.includes('operatingExpenses')) fail('abc must not use opex/net');

console.log('admin-abc checks ok');
