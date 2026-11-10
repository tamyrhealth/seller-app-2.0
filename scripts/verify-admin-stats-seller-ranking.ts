import { buildAdminStats, type StatsOrder, type StatsOrderItem } from '../lib/adminStats';
import {
  buildSellerRanking,
  commissionScopeAllowed,
  parseSellerBalances,
  parseSellerEarnings,
  statsEarningsRpcMissing,
  type SellerPeriodEarnings,
} from '../lib/adminStatsEarnings';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function ok(msg: string) {
  console.log('PASS', msg);
}

const names = new Map<string, string>([
  ['s1', 'Айгуль'],
  ['s2', 'Болат'],
  ['s3', 'Венера'],
  ['s4', 'Гульнара'],
  ['s5', 'Данияр'],
  ['s6', 'Ерлан'],
]);

const range = {
  from: new Date('2026-11-01T00:00:00+05:00'),
  toNext: new Date('2026-11-02T00:00:00+05:00'),
};

function item(id: string, productId: string, name: string, qty: number, line_sum: number, extra?: Partial<StatsOrderItem>) {
  return {
    id,
    product_id: productId,
    qty,
    price: line_sum / qty,
    line_sum,
    is_gift: false,
    product_name_snapshot: name,
    product: { name, unit: 'pcs' },
    ...extra,
  };
}

function order(partial: Partial<StatsOrder> & { id: string; seller_id: string; total_sum: number }): StatsOrder {
  return {
    status: 'confirmed',
    created_at: '2026-11-01T10:00:00+05:00',
    city_id: 'c1',
    order_items: [item(`${partial.id}-i1`, 'p-pow', 'Порошок 250 г', 1, partial.total_sum)],
    ...partial,
  };
}

function stats(orders: StatsOrder[], extra?: { cityId?: string | 'all'; productId?: string | 'all' }) {
  return buildAdminStats({
    orders,
    unpaidDebts: [],
    range,
    sellerId: 'all',
    cityId: extra?.cityId ?? 'all',
    productId: extra?.productId ?? 'all',
    sellerNames: names,
    deletedSellerLabel: 'Удалён',
  });
}

function earnings(rows: SellerPeriodEarnings[]) {
  return new Map(rows.map((r) => [r.sellerId, r]));
}

function rank(
  sellers: ReturnType<typeof stats>['sellers'],
  extra?: Partial<Parameters<typeof buildSellerRanking>[0]>
) {
  return buildSellerRanking({
    sellers,
    earnings: extra?.earnings ?? new Map(),
    balances: extra?.balances ?? new Map(),
    commissionAllowed: extra?.commissionAllowed ?? true,
    earningsStatus: extra?.earningsStatus ?? 'connected',
    limit: extra?.limit ?? 5,
  });
}

{
  const r = rank(stats([]).sellers);
  if (r.length !== 0) fail('empty period must be empty ranking');
  ok('empty period');
}

{
  const orders = [
    order({ id: 'o1', seller_id: 's1', total_sum: 100 }),
    order({ id: 'o2', seller_id: 's2', total_sum: 80 }),
    order({ id: 'o3', seller_id: 's3', total_sum: 60 }),
    order({ id: 'o4', seller_id: 's4', total_sum: 40 }),
  ];
  const r = rank(stats(orders).sellers);
  if (r.length !== 4) fail('1-4 sellers must all appear');
  if (r[0].place !== 1 || r[0].name !== 'Айгуль' || r[0].revenue !== 100) fail('place 1 revenue sort');
  ok('1-4 sellers');
}

{
  const orders = ['s1', 's2', 's3', 's4', 's5', 's6'].map((sid, i) =>
    order({ id: `o${i}`, seller_id: sid, total_sum: 600 - i * 10 })
  );
  const r = rank(stats(orders).sellers);
  if (r.length !== 5) fail('more than 5 must slice to 5');
  if (r.map((x) => x.sellerId).includes('s6')) fail('6th seller must be excluded');
  ok('more than 5 sellers');
}

{
  const orders = [
    order({ id: 'o1', seller_id: 's2', total_sum: 100 }),
    order({ id: 'o2', seller_id: 's1', total_sum: 100 }),
  ];
  const r = rank(stats(orders).sellers);
  if (r[0].name !== 'Айгуль' || r[1].name !== 'Болат') fail('tie revenue must sort by name');
  ok('tie revenue');
}

{
  const orders = [
    order({ id: 'ok', seller_id: 's1', total_sum: 50 }),
    order({ id: 'cx', seller_id: 's1', total_sum: 999, status: 'canceled' }),
  ];
  const s = stats(orders);
  if (s.revenue !== 50 || s.sellers[0].orderCount !== 1) fail('canceled must be excluded');
  ok('cancellations');
}

{
  const unpaid = order({
    id: 'd1',
    seller_id: 's1',
    total_sum: 200,
    is_debt: true,
    debt_status: 'open',
    payment_type: 'debt',
    created_at: '2026-11-01T10:00:00+05:00',
  });
  const paid = order({
    id: 'd2',
    seller_id: 's1',
    total_sum: 70,
    is_debt: true,
    debt_status: 'paid',
    debt_paid_at: '2026-11-01T12:00:00+05:00',
    payment_type: 'debt',
  });
  if (stats([unpaid]).revenue !== 0) fail('unpaid debt must not be revenue');
  if (stats([paid]).revenue !== 70) fail('paid debt must be revenue on paid_at');
  ok('debt before and after payment');
}

{
  const open = order({
    id: 'p1',
    seller_id: 's1',
    total_sum: 300,
    is_preorder: true,
    preorder_status: 'pending',
  });
  const done = order({
    id: 'p2',
    seller_id: 's1',
    total_sum: 90,
    is_preorder: true,
    preorder_status: 'fulfilled',
    fulfilled_at: '2026-11-01T15:00:00+05:00',
  });
  if (stats([open]).revenue !== 0) fail('open preorder must not be revenue');
  if (stats([done]).revenue !== 90) fail('fulfilled preorder must be revenue');
  ok('preorder before and after fulfill');
}

{
  const o = order({
    id: 'g1',
    seller_id: 's1',
    total_sum: 40,
    order_items: [
      item('g1-paid', 'p-pow', 'Порошок 250 г', 2, 40),
      item('g1-gift', 'p-tea', 'Шай 500 г', 1, 99, { is_gift: true, line_sum: 0, price: 0 }),
    ],
  });
  const s = stats([o]);
  const products = s.sellers[0].products;
  if (products.some((p) => p.name.includes('Шай'))) fail('gift must not appear as sold revenue');
  if (s.sellers[0].unitsSold !== 2) fail('gift qty must not count as sold units');
  if (s.revenue !== 40) fail('gift must not add revenue');
  ok('gifts excluded from sales');
}

{
  const orders = [
    order({
      id: 'm1',
      seller_id: 's1',
      total_sum: 100,
      order_items: [item('m1-i1', 'p-pow', 'Порошок 250 г', 5, 100)],
    }),
  ];
  const period: SellerPeriodEarnings = {
    sellerId: 's1',
    accrued: 0,
    reversed: 0,
    earned: 0,
    missingRateCount: 1,
    items: [
      {
        sellerId: 's1',
        orderItemId: 'm1-i1',
        productId: 'p-pow',
        accrued: 0,
        reversed: 0,
        missingRate: true,
      },
    ],
  };
  const r = rank(stats(orders).sellers, { earnings: earnings([period]) });
  if (r[0].earnedKnown || r[0].earned !== null) fail('missing_rate must not show 0 as earned');
  if (!r[0].incomplete) fail('missing_rate must be incomplete');
  if (r[0].products[0].commissionKnown) fail('product commission unknown on missing_rate');
  ok('missing_rate');
}

{
  const orders = [
    order({
      id: 'h1',
      seller_id: 's1',
      total_sum: 55,
      order_items: [item('h1-i1', 'p-pow', 'Порошок 250 г', 1, 55)],
    }),
  ];
  const r = rank(stats(orders).sellers, { earnings: new Map() });
  if (!r[0].earnedKnown || r[0].earned !== 0) fail('period earned without ledger rows is 0 by accrual date');
  if (!r[0].incomplete) fail('historical without ledger must warn');
  if (r[0].products[0].commissionKnown) fail('unmatched sale must not invent product commission');
  ok('historical without ledger');
}

{
  const jan = {
    from: new Date('2026-10-01T00:00:00+05:00'),
    toNext: new Date('2026-11-01T00:00:00+05:00'),
  };
  const o = order({ id: 'nov', seller_id: 's1', total_sum: 10 });
  const empty = buildAdminStats({
    orders: [o],
    unpaidDebts: [],
    range: jan,
    sellerId: 'all',
    cityId: 'all',
    productId: 'all',
    sellerNames: names,
    deletedSellerLabel: 'Удалён',
  });
  if (empty.revenue !== 0) fail('other period must not include november sale');
  ok('different periods');
}

{
  const orders = [
    order({ id: 'c1', seller_id: 's1', total_sum: 10, city_id: 'c1' }),
    order({ id: 'c2', seller_id: 's2', total_sum: 90, city_id: 'c2' }),
  ];
  const city = stats(orders, { cityId: 'c1' });
  if (city.revenue !== 10 || city.sellers.length !== 1) fail('city filter must scope revenue');
  const r = rank(city.sellers, {
    commissionAllowed: commissionScopeAllowed('c1', 'all'),
    earnings: earnings([
      {
        sellerId: 's1',
        accrued: 999,
        reversed: 0,
        earned: 999,
        missingRateCount: 0,
        items: [
          {
            sellerId: 's1',
            orderItemId: 'c1-i1',
            productId: 'p-pow',
            accrued: 999,
            reversed: 0,
            missingRate: false,
          },
        ],
      },
    ]),
    balances: new Map([['s1', 50]]),
  });
  if (r[0].earnedKnown || r[0].earned !== null || r[0].payable !== null) {
    fail('city filter must hide company commissions and payable');
  }
  ok('city filter does not mix commissions');
}

{
  const dup: StatsOrder = order({
    id: 'dup',
    seller_id: 's1',
    total_sum: 30,
    order_items: [item('dup-i1', 'p-pow', 'Порошок 250 г', 3, 30)],
  });
  const s = stats([dup, { ...dup }]);
  if (s.sellers[0].unitsSold !== 3 || s.revenue !== 30) fail('duplicate order id must not double-count');
  ok('no double-count');
}

{
  const orders = [
    order({
      id: 'e1',
      seller_id: 's1',
      total_sum: 100,
      order_items: [
        item('e1-i1', 'p-pow', 'Порошок 250 г', 55, 55),
        item('e1-i2', 'p-tea', 'Шай 500 г', 21, 21),
        item('e1-i3', 'p-dra', 'Драже', 12, 24),
      ],
    }),
  ];
  const period: SellerPeriodEarnings = {
    sellerId: 's1',
    accrued: 10,
    reversed: 2,
    earned: 8,
    missingRateCount: 0,
    items: [
      { sellerId: 's1', orderItemId: 'e1-i1', productId: 'p-pow', accrued: 5, reversed: 0, missingRate: false },
      { sellerId: 's1', orderItemId: 'e1-i2', productId: 'p-tea', accrued: 5, reversed: 2, missingRate: false },
      { sellerId: 's1', orderItemId: 'e1-i3', productId: 'p-dra', accrued: 0, reversed: 0, missingRate: false },
    ],
  };
  const r = rank(stats(orders).sellers, {
    earnings: earnings([period]),
    balances: new Map([['s1', 12.5]]),
  });
  if (!r[0].earnedKnown || r[0].earned !== 8) fail('earned = accrued - reversed');
  if (r[0].payable !== 12.5) fail('payable is current ledger balance');
  const namesSold = r[0].products.map((p) => `${p.name} ${p.qty}`).join('|');
  if (!namesSold.includes('Порошок 250 г 55') || !namesSold.includes('Шай 500 г 21')) fail('product detail qty');
  const dump = JSON.stringify(r);
  if (/cost|cogs|себестоим/i.test(dump)) fail('must not leak cost');
  ok('earned vs payable and product detail');
}

{
  const parsed = parseSellerEarnings({
    sellers: [
      {
        seller_id: 's1',
        accrued: '10.00',
        reversed: '2.00',
        earned: '8.00',
        missing_rate_count: 0,
        items: [{ order_item_id: 'x', product_id: 'p', accrued: 10, reversed: 2, missing_rate: false }],
      },
    ],
  });
  if (parsed.get('s1')?.earned !== 8) fail('parse earnings');
  const bal = parseSellerBalances({ items: [{ seller_id: 's1', balance: '12.50' }] });
  if (bal.get('s1') !== 12.5) fail('parse balances');
  ok('parsers');
}

{
  const missing = rank(stats([order({ id: 'z', seller_id: 's1', total_sum: 1 })]).sellers, {
    earningsStatus: 'missing',
    earnings: new Map(),
  });
  if (missing[0].earnedKnown || missing[0].incomplete) fail('rpc missing must not pretend 0 earned or incomplete ledger');
  if (missing[0].earned !== null) fail('rpc missing earned must be null');
  ok('rpc missing degrades');
}

{
  const err = rank(stats([order({ id: 'z2', seller_id: 's1', total_sum: 1 })]).sellers, {
    earningsStatus: 'error',
    earnings: new Map(),
  });
  if (err[0].earnedKnown || err[0].earned !== null) fail('rpc error must not confirm earned');
  ok('rpc error degrades');
}

{
  if (!statsEarningsRpcMissing('Could not find the function public.admin_stats_seller_earnings')) {
    fail('pgrst missing');
  }
  if (statsEarningsRpcMissing('Seller commission permission denied')) fail('permission is not missing rpc');
  ok('rpc missing classifier');
}

{
  const orders = [
    order({
      id: 'same',
      seller_id: 's1',
      total_sum: 30,
      order_items: [
        item('same-a', 'p-pow', 'Порошок 250 г', 1, 10),
        item('same-b', 'p-pow', 'Порошок 250 г', 2, 20),
      ],
    }),
  ];
  const period: SellerPeriodEarnings = {
    sellerId: 's1',
    accrued: 9,
    reversed: 0,
    earned: 9,
    missingRateCount: 0,
    items: [
      { sellerId: 's1', orderItemId: 'same-a', productId: 'p-pow', accrued: 3, reversed: 0, missingRate: false },
      { sellerId: 's1', orderItemId: 'same-b', productId: 'p-pow', accrued: 6, reversed: 0, missingRate: false },
    ],
  };
  const r = rank(stats(orders).sellers, { earnings: earnings([period]) });
  if (!r[0].products[0].commissionKnown || r[0].products[0].commission !== 9) {
    fail('two lines of same product must sum uniquely by order_item_id');
  }
  ok('same product two lines');
}

{
  const orders = [
    order({
      id: 'mix',
      seller_id: 's1',
      total_sum: 30,
      order_items: [
        item('mix-a', 'p-pow', 'Порошок 250 г', 1, 10),
        item('mix-b', 'p-tea', 'Шай 500 г', 1, 20),
      ],
    }),
  ];
  const period: SellerPeriodEarnings = {
    sellerId: 's1',
    accrued: 15,
    reversed: 0,
    earned: 15,
    missingRateCount: 0,
    items: [
      { sellerId: 's1', orderItemId: 'mix-a', productId: 'p-pow', accrued: 5, reversed: 0, missingRate: false },
      { sellerId: 's1', orderItemId: 'mix-b', productId: 'p-tea', accrued: 10, reversed: 0, missingRate: false },
    ],
  };
  const r = rank(stats(orders).sellers, { earnings: earnings([period]) });
  const pow = r[0].products.find((p) => p.productId === 'p-pow');
  const tea = r[0].products.find((p) => p.productId === 'p-tea');
  if (pow?.commission !== 5 || tea?.commission !== 10) fail('must not mix commissions across products');
  ok('no cross-product commission');
}

{
  const r = rank(stats([order({ id: 'neg', seller_id: 's1', total_sum: 10 })]).sellers, {
    earnings: earnings([
      {
        sellerId: 's1',
        accrued: 10,
        reversed: 0,
        earned: 10,
        missingRateCount: 0,
        items: [
          { sellerId: 's1', orderItemId: 'neg-i1', productId: 'p-pow', accrued: 10, reversed: 0, missingRate: false },
        ],
      },
    ]),
    balances: new Map([['s1', -40]]),
  });
  if (r[0].payable !== -40) fail('negative payable must pass through');
  if (!r[0].earnedKnown || r[0].earned !== 10) fail('period earned must stay separate from payable');
  ok('negative payable vs period earned');
}

{
  const r = rank(stats([order({ id: 'gds', seller_id: 's1', total_sum: 10 })]).sellers, {
    earnings: earnings([
      {
        sellerId: 's1',
        accrued: 4,
        reversed: 0,
        earned: 4,
        missingRateCount: 0,
        items: [
          { sellerId: 's1', orderItemId: 'gds-i1', productId: 'p-pow', accrued: 4, reversed: 0, missingRate: false },
        ],
      },
    ]),
    balances: new Map([['s1', 4]]),
  });
  const dump = JSON.stringify(r);
  if (/goods_reversal|goods_issue|cost_price/i.test(dump)) fail('goods/cost must not appear in ranking');
  ok('goods returns stay out of ranking payload');
}

console.log('OK admin stats seller ranking');
