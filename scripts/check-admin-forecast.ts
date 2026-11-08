import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAccountingDate } from '../lib/accounting';
import {
  buildAdminForecast,
  filterForecastRows,
  getPhysicalDemandAt,
  isPendingPreorder,
  mergeForecastOrders,
  parseForecastParams,
  recommendQty,
  targetBelowLeadSafety,
  type ForecastOrder,
} from '../lib/adminForecast';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const todayYmd = '2026-11-08';
const params = { leadDays: 20, safetyDays: 10, targetDays: 40 };
const catalog = [{ id: 'p1', name: 'Мука', unit: 'kg', isActive: true }];
const cities = [
  { id: 'c1', name: 'Атырау' },
  { id: 'c2', name: 'Алматы' },
];

function item(productId: string, qty: number, extra?: { gift?: boolean; name?: string; unit?: string }) {
  return {
    product_id: productId,
    qty,
    is_gift: extra?.gift || false,
    product: { name: extra?.name || productId, unit: extra?.unit || 'kg' },
  };
}

function order(partial: Partial<ForecastOrder> & { id: string }): ForecastOrder {
  return {
    city_id: 'c1',
    created_at: '2026-11-01T06:00:00.000Z',
    status: 'confirmed',
    payment_type: 'kaspi',
    order_items: [item('p1', 2)],
    ...partial,
  };
}

function report(
  orders: ForecastOrder[],
  extra: Partial<Parameters<typeof buildAdminForecast>[0]> = {}
) {
  return buildAdminForecast({
    orders,
    inventory: extra.inventory || [{ city_id: 'c1', product_id: 'p1', qty_on_hand: 10 }],
    transfers: extra.transfers || [],
    catalog,
    cities,
    todayYmd,
    window: 30,
    params,
    complete: true,
    ...extra,
  });
}

const sale = report([order({ id: 'o-sale' })]);
const row = sale.cityRows.find((r) => r.productId === 'p1' && r.cityId === 'c1');
if (!row || row.qty30 !== 2) fail('regular sale qty');
if (getPhysicalDemandAt(order({ id: 'o-sale' })) == null) fail('regular sale has physical date');

const unpaid: ForecastOrder = {
  id: 'o-debt',
  city_id: 'c1',
  created_at: '2026-11-01T06:00:00.000Z',
  status: 'confirmed',
  payment_type: 'debt',
  is_debt: true,
  debt_status: 'active',
  order_items: [item('p1', 3)],
};
if (getAccountingDate(unpaid) != null) fail('unpaid debt is not revenue');
if (getPhysicalDemandAt(unpaid) == null) fail('unpaid debt is physical demand');
if (report([unpaid]).cityRows[0].qty30 !== 3) fail('unpaid debt counted once');

const paid: ForecastOrder = {
  ...unpaid,
  id: 'o-paid',
  debt_status: 'paid',
  debt_paid_at: '2026-11-08T12:00:00.000Z',
};
if (report([paid]).cityRows[0].qty30 !== 3) fail('repayment must not double physical qty');

const gift = report([
  order({
    id: 'o-gift',
    order_items: [item('p1', 2), item('p1', 1, { gift: true })],
  }),
]);
if (gift.cityRows[0].qty30 !== 3) fail('gifts enter physical qty');

const pending: ForecastOrder = {
  id: 'o-pre',
  city_id: 'c1',
  created_at: '2026-10-01T06:00:00.000Z',
  status: 'confirmed',
  is_preorder: true,
  preorder_status: 'pending',
  order_items: [item('p1', 4)],
};
if (!isPendingPreorder(pending) || getPhysicalDemandAt(pending) != null) fail('pending preorder is reserve only');
const pendingR = report([pending], { inventory: [{ city_id: 'c1', product_id: 'p1', qty_on_hand: 10 }] });
if (pendingR.cityRows[0].qty30 !== 0) fail('pending not in sales');
if (pendingR.cityRows[0].reserve !== 4 || pendingR.cityRows[0].available !== 6) fail('reserve subtracted once');

const fulfilled: ForecastOrder = {
  ...pending,
  id: 'o-pre-f',
  is_preorder: false,
  preorder_status: 'fulfilled',
  fulfilled_at: '2026-11-01T09:00:00.000Z',
};
const fulR = report([fulfilled], { inventory: [{ city_id: 'c1', product_id: 'p1', qty_on_hand: 6 }] });
if (fulR.cityRows[0].qty30 !== 4) fail('fulfilled preorder uses fulfilled_at');
if (fulR.cityRows[0].reserve !== 0) fail('fulfilled is not reserved again');

const cancelled = report([order({ id: 'o-cancel', status: 'canceled' })]);
if ((cancelled.cityRows[0]?.qty30 || 0) !== 0) fail('canceled excluded');

const inbound = report([order({ id: 'o-in' })], {
  transfers: [
    {
      id: 't1',
      status: 'in_transit',
      from_city_id: 'c2',
      to_city_id: 'c1',
      stock_transfer_items: [{ product_id: 'p1', qty_sent: 5, qty_received: 0 }],
    },
  ],
});
if (inbound.cityRows[0].inbound !== 5) fail('in_transit is inbound');
if (inbound.cityRows[0].available !== 10) fail('inbound is not available');

const received = report([], {
  inventory: [{ city_id: 'c1', product_id: 'p1', qty_on_hand: 10 }],
  transfers: [
    {
      id: 't2',
      status: 'received',
      from_city_id: 'c2',
      to_city_id: 'c1',
      stock_transfer_items: [{ product_id: 'p1', qty_sent: 5, qty_received: 5 }],
    },
    {
      id: 't3',
      status: 'cancelled',
      from_city_id: 'c2',
      to_city_id: 'c1',
      stock_transfer_items: [{ product_id: 'p1', qty_sent: 8, qty_received: 0 }],
    },
    {
      id: 't4',
      status: 'received_with_variance',
      from_city_id: 'c2',
      to_city_id: 'c1',
      stock_transfer_items: [{ product_id: 'p1', qty_sent: 4, qty_received: 2, qty_lost: 2 }],
    },
  ],
});
if (received.cityRows[0].inbound !== 0) fail('received/cancelled/shortage are not inbound');

const neg = report([], { inventory: [{ city_id: 'c1', product_id: 'p1', qty_on_hand: -2 }] });
if (!neg.cityRows[0].negativeStock || neg.cityRows[0].available !== 0) fail('negative stock warning');
if (neg.negativeStockCount !== 1) fail('negative counter');

const zero = report([], { inventory: [{ city_id: 'c1', product_id: 'p1', qty_on_hand: 8 }] });
if (zero.cityRows[0].confidence !== 'low' || zero.cityRows[0].recRate !== 0) fail('zero sales low confidence');

if (recommendQty(1.251, 'kg') !== 1.251) fail('kg keeps decimals');
if (recommendQty(1.2, 'pcs') !== 2) fail('pcs ceils');

const frac = report([order({ id: 'o-kg', order_items: [item('p1', 1.5)] })]);
if (frac.cityRows[0].qty30 !== 1.5) fail('fractional qty');

const missing = parseForecastParams({ leadDays: '', safetyDays: '10', targetDays: '40' });
if (missing.leadDays != null) fail('empty lead is not a fake China default');
const smallTarget = parseForecastParams({ leadDays: '20', safetyDays: '10', targetDays: '25' });
if (!targetBelowLeadSafety(smallTarget)) fail('target must be >= lead+safety');
const blocked = report([order({ id: 'o-p' })], { params: smallTarget });
if (blocked.recsAvailable || blocked.products[0].purchaseQty != null) fail('block purchase when target too small');

const noParams = report([order({ id: 'o-np' })], { params: { leadDays: null, safetyDays: null, targetDays: null } });
if (noParams.recsAvailable || noParams.recsBlockedReason !== 'missing_params') fail('missing params hide purchase');
if (noParams.cityRows[0].qty30 !== 2) fail('velocity still shown without params');

const twoCities = report(
  [
    order({ id: 'o-c1', city_id: 'c1', order_items: [item('p1', 30)] }),
    order({ id: 'o-c2', city_id: 'c2', order_items: [item('p1', 30)] }),
  ],
  {
    inventory: [
      { city_id: 'c1', product_id: 'p1', qty_on_hand: 80 },
      { city_id: 'c2', product_id: 'p1', qty_on_hand: 5 },
    ],
  }
);
if ((twoCities.products[0].purchaseQty || 0) !== 0) fail('enough company stock: buy 0');
if (twoCities.transfers.length !== 1) fail('recommend one transfer');
if (twoCities.transfers[0].fromCityId !== 'c1' || twoCities.transfers[0].toCityId !== 'c2') fail('transfer direction');
if (twoCities.transfers[0].senderAvailableAfter < (twoCities.cityRows.find((r) => r.cityId === 'c1')?.targetStock || 0)) {
  fail('must not create sender deficit');
}

const short = report(
  [
    order({ id: 'o-s1', city_id: 'c1', order_items: [item('p1', 30)] }),
    order({ id: 'o-s2', city_id: 'c2', order_items: [item('p1', 30)] }),
  ],
  {
    inventory: [
      { city_id: 'c1', product_id: 'p1', qty_on_hand: 5 },
      { city_id: 'c2', product_id: 'p1', qty_on_hand: 5 },
    ],
  }
);
if (!(short.products[0].purchaseQty! > 0)) fail('company shortage needs purchase');

const mixed = report(
  [
    order({ id: 'o-m1', city_id: 'c1', order_items: [item('p1', 30)] }),
    order({ id: 'o-m2', city_id: 'c2', order_items: [item('p1', 30)] }),
  ],
  {
    inventory: [
      { city_id: 'c1', product_id: 'p1', qty_on_hand: 50 },
      { city_id: 'c2', product_id: 'p1', qty_on_hand: 0 },
    ],
  }
);
if (!(mixed.products[0].purchaseQty! > 0)) fail('company shortage still buys after transfers');
if (mixed.transfers.length < 1) fail('uneven stock still suggests transfer');
const mixedPurchase = mixed.products[0].purchaseQty;
const filteredCity = filterForecastRows(mixed.cityRows, { cityId: 'c2', productId: 'all', problemsOnly: false });
if (filteredCity.length !== 1 || filteredCity[0].cityId !== 'c2') fail('city filter hides other cities');
if (mixed.products[0].purchaseQty !== mixedPurchase) fail('city filter must not change company purchase');

const pendingDup = mergeForecastOrders([[pending], [pending]]);
if (pendingDup.length !== 1) fail('pending order id deduped');
const pendingOnce = report(pendingDup, { inventory: [{ city_id: 'c1', product_id: 'p1', qty_on_hand: 10 }] });
if (pendingOnce.cityRows[0].reserve !== 4) fail('pending reserve counted once');

const pcsCat = [{ id: 'p2', name: 'Коробка', unit: 'pcs', isActive: true }];
const pcsMove = buildAdminForecast({
  orders: [
    order({ id: 'o-p2a', city_id: 'c1', order_items: [item('p2', 2.4, { unit: 'pcs' })] }),
    order({ id: 'o-p2b', city_id: 'c2', order_items: [item('p2', 2.4, { unit: 'pcs' })] }),
  ],
  inventory: [
    { city_id: 'c1', product_id: 'p2', qty_on_hand: 5 },
    { city_id: 'c2', product_id: 'p2', qty_on_hand: 0 },
  ],
  transfers: [],
  catalog: pcsCat,
  cities,
  todayYmd,
  window: 30,
  params,
  complete: true,
});
const senderTarget = pcsMove.cityRows.find((r) => r.productId === 'p2' && r.cityId === 'c1')?.targetStock || 0;
if (!pcsMove.transfers.length) fail('pcs transfer should still move floor qty');
if (pcsMove.transfers[0].senderAvailableAfter + 1e-9 < senderTarget) fail('integer transfer must not put sender below target');

const dup = report([order({ id: 'same' }), order({ id: 'same' })]);
if (dup.cityRows[0].qty30 !== 2) fail('dedupe order id');

const truncated = report([order({ id: 'o-t' })], { complete: false });
if (truncated.recsAvailable || truncated.products[0].purchaseQty != null) fail('truncated hides recs');

const spikeOrders: ForecastOrder[] = [];
for (let i = 0; i < 20; i += 1) {
  spikeOrders.push(
    order({
      id: `old-${i}`,
      created_at: '2026-10-20T06:00:00.000Z',
      order_items: [item('p1', 1)],
    })
  );
}
spikeOrders.push(order({ id: 'new-spike', created_at: '2026-11-07T06:00:00.000Z', order_items: [item('p1', 40)] }));
const spike = report(spikeOrders);
if (!spike.cityRows[0].spike) fail('detect demand spike');
if (Math.abs(spike.cityRows[0].recRate - spike.cityRows[0].rate30) > 1e-9) fail('do not inflate rec rate with 7d spike');

const lib = read('lib/adminForecast.ts');
const page = read('app/admin/forecast/page.tsx');
const nav = read('components/NavAdmin.tsx');
const i18n = read('lib/i18n.tsx');
const managerNav = read('components/NavManager.tsx');
const sellerNav = read('components/NavSeller.tsx');
if (!existsSync(join(process.cwd(), 'app/admin/forecast/page.tsx'))) fail('forecast page missing');
if (!lib.includes('getPhysicalDemandAt')) fail('physical demand helper');
if (lib.includes('getAccountingDate') || lib.includes('isConfirmedInRange')) fail('must not use revenue date as demand');
if (lib.includes('debt_paid_at') && lib.includes('getPhysicalDemandAt') && /debt_paid_at/.test(lib.slice(lib.indexOf('getPhysicalDemandAt'), lib.indexOf('getPhysicalDemandAt') + 800))) {
  fail('physical demand must ignore repayment date');
}
if (getPhysicalDemandAt(paid)?.toISOString() === new Date(paid.debt_paid_at || '').toISOString() && paid.created_at !== paid.debt_paid_at) {
  const phys = getPhysicalDemandAt(paid)!;
  if (phys.getTime() === new Date(paid.debt_paid_at!).getTime()) fail('physical date is not repayment');
}
if (!page.includes('Protected role="admin"')) fail('admin only');
if (!page.includes("role === 'admin'") || !page.includes('if (!authReady || !isAdmin) return')) {
  fail('must not load stock until admin role is confirmed');
}
if (page.includes('admin_product_costs') || page.includes('FINANCE_COSTS_RPC')) fail('no cost rpc');
if (page.includes('confirm_order') || page.includes('apply_inventory') || page.includes('create_stock_transfer')) {
  fail('forecast is read-only');
}
if (page.includes('/api/')) fail('no public forecast API');
if (page.includes('console.log')) fail('no console');
if (!page.includes('runExclusive')) fail('coalesce fetches');
if (!page.includes('let cancelled = false')) fail('cancel load');
if (!page.includes('[refreshKey, authReady, isAdmin]')) fail('stable load deps');
if (page.includes(', t]')) fail('language must not refetch');
if (!page.includes('bg-slate-50') || !page.includes('overflow-x-auto')) fail('layout');
if (!nav.includes('href="/admin/forecast"')) fail('nav');
if (managerNav.includes('/admin/forecast') || sellerNav.includes('/admin/forecast')) fail('staff nav leak');
if (!i18n.includes("'forecast.nav': 'Прогноз'") || !i18n.includes("'forecast.nav': 'Болжам'")) fail('i18n nav');
const keys = [...i18n.matchAll(/'(forecast\.[^']+)':/g)].map((m) => m[1]);
const ruSet = new Set(keys.slice(0, keys.length / 2));
const kzSet = new Set(keys.slice(keys.length / 2));
for (const key of ruSet) if (!kzSet.has(key)) fail(`kz missing ${key}`);
for (const key of kzSet) if (!ruSet.has(key)) fail(`ru missing ${key}`);
if (!read('lib/adminForecastView.ts').includes('ORDER_STATS_MAX')) fail('20k cap');
if (read('lib/adminForecastView.ts').includes("gte('debt_paid_at'") || read('lib/adminForecastView.ts').includes('run(\'debt_paid_at\')')) {
  fail('fetch must not use repayment window');
}

console.log('admin-forecast checks ok');
