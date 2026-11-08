import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isConfirmedInRange, sumConfirmedInRange } from '../lib/accounting';
import {
  buildAdminStats,
  isOverdueUnpaidDebt,
  resolvePeriod,
  summarizeUnpaidDebts,
  type StatsOrder,
} from '../lib/adminStats';
import { addDaysYmd, startOfYearYmd } from '../lib/datetime';
import {
  buildAdminFinance,
  FINANCE_CARGO_CUSTOMS_CATEGORY,
  FINANCE_COSTS_RPC,
  FINANCE_EXPENSE_CREATE_RPC,
  FINANCE_EXPENSE_DELETE_RPC,
  FINANCE_EXPENSE_EVENTS_RPC,
  FINANCE_EXPENSE_UPDATE_RPC,
  FINANCE_EXPENSES_LIST_RPC,
  FINANCE_ORDER_SELECT,
  financeRpcErrorKind,
  mergeFinanceOrders,
  parseFinanceExpenseEvents,
  parseFinanceExpensesList,
  uniqueLiveExpenses,
  type BuildAdminFinanceInput,
  type FinanceOrder,
} from '../lib/adminFinance';
import {
  expensesForCityView,
  FINANCE_PERIOD_PRESETS,
  financeGrossKpi,
  financeNetKpi,
  isSessionOnlyExpenseCompleteness,
  monthRangeYmd,
  ordersForCityView,
  resolveFinanceRange,
  sortFinanceSellerRows,
} from '../lib/adminFinanceView';

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
const cityNames = new Map([
  ['c1', 'Атырау'],
  ['c2', 'Алматы'],
]);

const paid: FinanceOrder = {
  id: 'o-paid',
  city_id: 'c1',
  total_sum: 10000,
  created_at: '2026-11-08T06:00:00.000Z',
  status: 'confirmed',
  payment_type: 'kaspi',
  order_items: [
    { product_id: 'p1', qty: 2, price: 5000, line_sum: 10000, is_gift: false, product: { name: 'Молоко', unit: 'pcs' } },
  ],
};

function report(partial: Partial<BuildAdminFinanceInput> = {}) {
  const input: BuildAdminFinanceInput = {
    range,
    fromYmd,
    toYmd,
    costs: [{ id: 'p1', cost_price: 1000 }],
    expenses: [],
    cityNames,
    expensesInputComplete: true,
    orders: [],
  };
  return buildAdminFinance({ ...input, ...partial, orders: partial.orders ?? [] });
}

// --- empty period ---
const empty = report({ orders: [] });
if (empty.revenue !== 0 || empty.recognizedOrderCount !== 0) fail('empty revenue');
if (empty.averageCheck !== 0 || Number.isNaN(empty.averageCheck)) fail('empty average check must be 0');
if (empty.cogsKnown !== 0 || empty.cogsComplete !== true) fail('empty cogs');
if (empty.estimatedGrossProfit !== 0) fail('empty gross');
if (empty.estimatedNetProfit !== 0) fail('empty net with expenses marked complete');
if (empty.cityRows.length !== 0 || empty.productRows.length !== 0 || empty.sellerRows.length !== 0) fail('empty rows');
if (!empty.warnings.includes('zero_revenue')) fail('empty zero-revenue warning');

const emptyIncomplete = report({ orders: [], expensesInputComplete: false });
if (emptyIncomplete.estimatedNetProfit !== null) fail('empty net must stay untrusted until expenses confirmed');
if (emptyIncomplete.preliminaryNetProfit !== 0) fail('empty preliminary net');

// --- cancelled ---
const cancelled = report({
  orders: [
    {
      ...paid,
      id: 'o-cancel',
      status: 'canceled',
    },
  ],
});
if (cancelled.revenue !== 0 || cancelled.recognizedOrderCount !== 0) fail('cancelled must not enter revenue');
if (cancelled.averageCheck !== 0) fail('cancelled average check');
if (cancelled.cogsKnown !== 0) fail('cancelled must not enter cogs');
if (isConfirmedInRange({ ...paid, status: 'canceled' }, range)) fail('accounting must reject cancelled');

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
  order_items: paid.order_items,
};
const unpaid = report({ orders: [unpaidDebt] });
if (unpaid.revenue !== 0) fail('unpaid debt is not revenue');
if (unpaid.recognizedOrderCount !== 0 || unpaid.averageCheck !== 0) fail('unpaid debt is not a recognized sale');

const repaid: FinanceOrder = {
  ...unpaidDebt,
  debt_status: 'paid',
  debt_paid_at: '2026-11-08T12:00:00.000Z',
  debt_payment_method: 'kaspi',
};
const repaidR = report({ orders: [repaid] });
if (repaidR.revenue !== 8000) fail('repayment is revenue on debt_paid_at');
if (repaidR.recognizedOrderCount !== 1 || repaidR.averageCheck !== 8000) fail('repayment counts as one sale');

const repaidLater: FinanceOrder = {
  ...repaid,
  debt_paid_at: '2026-11-10T12:00:00.000Z',
};
if (report({ orders: [repaidLater] }).revenue !== 0) fail('unpaid-in-period debt paid later is not this period');

const mergedRepay = mergeFinanceOrders([[repaid], [repaid], [{ ...repaid, created_at: '2026-11-01T00:00:00.000Z' }]]);
if (mergedRepay.length !== 1) fail('repayment must not duplicate the same order');
if (sumConfirmedInRange(mergedRepay, range) !== 8000) fail('single repayment amount');

// --- preorder ---
const pendingPre: FinanceOrder = {
  id: 'o-pre',
  city_id: 'c2',
  total_sum: 3000,
  created_at: '2026-11-08T06:00:00.000Z',
  status: 'confirmed',
  payment_type: 'cash',
  is_preorder: true,
  preorder_status: 'pending',
  order_items: [
    { product_id: 'p1', qty: 1, price: 3000, line_sum: 3000, is_gift: false, product: { name: 'Молоко', unit: 'pcs' } },
  ],
};
if (report({ orders: [pendingPre] }).revenue !== 0) fail('unfulfilled preorder is not revenue');
if (report({ orders: [pendingPre] }).recognizedOrderCount !== 0) fail('unfulfilled preorder is not a sale');

const fulfilledPre: FinanceOrder = {
  ...pendingPre,
  preorder_status: 'fulfilled',
  fulfilled_at: '2026-11-08T15:00:00.000Z',
};
if (report({ orders: [fulfilledPre] }).revenue !== 3000) fail('fulfilled preorder is revenue on fulfilled_at');
if (report({ orders: [fulfilledPre] }).recognizedOrderCount !== 1) fail('fulfilled preorder counts as one sale');

const fulfilledOtherDay: FinanceOrder = {
  ...fulfilledPre,
  fulfilled_at: '2026-11-01T15:00:00.000Z',
};
if (report({ orders: [fulfilledOtherDay] }).revenue !== 0) fail('preorder fulfilled outside period');

// --- gifts ---
const withGift: FinanceOrder = {
  ...paid,
  id: 'o-gift',
  order_items: [
    { product_id: 'p1', qty: 2, price: 5000, line_sum: 10000, is_gift: false, product: { name: 'Молоко', unit: 'pcs' } },
    { product_id: 'p1', qty: 1, price: 0, line_sum: 0, is_gift: true, product: { name: 'Молоко', unit: 'pcs' } },
  ],
};
const giftR = report({ orders: [withGift] });
if (giftR.revenue !== 10000) fail('gift does not add revenue');
if (giftR.recognizedOrderCount !== 1 || giftR.averageCheck !== 10000) fail('gift does not create a second sale');
if (giftR.cogsKnown !== 3000) fail('gift qty must enter cogs: 3 * 1000');
if (giftR.giftCogsKnown !== 1000) fail('gift cogs isolated');
if (giftR.productRows[0].qtySold !== 2 || giftR.productRows[0].qtyGift !== 1) fail('gift qty on product row');
if (giftR.estimatedGrossProfit !== 7000) fail('gross after gift cogs');

// --- missing cost ---
const missing = report({
  orders: [paid],
  costs: [{ id: 'p1', cost_price: null }],
  expensesInputComplete: true,
});
if (missing.cogsComplete) fail('null cost is not zero');
if (missing.cogsKnown !== 0) fail('missing cost must not invent cogs');
if (missing.missingCostProductCount !== 1 || missing.missingCostLineCount < 1) fail('missing cost counters');
if (missing.estimatedGrossProfit !== null) fail('headline gross hidden when cogs missing');
if (missing.estimatedNetProfit !== null) fail('headline net hidden when cogs missing');
if (missing.partialGrossProfit !== 10000) fail('partial gross shows revenue minus known cogs');
if (missing.profitReliable) fail('profit not reliable with missing cogs');
if (missing.productRows[0].estimatedGrossProfit !== null) fail('product profit hidden without cost');
if (!missing.warnings.includes('cogs_incomplete')) fail('cogs_incomplete warning');

const mixedCost = report({
  orders: [
    paid,
    {
      id: 'o2',
      city_id: 'c2',
      total_sum: 4000,
      created_at: '2026-11-08T07:00:00.000Z',
      status: 'confirmed',
      payment_type: 'cash',
      order_items: [
        { product_id: 'p2', qty: 1, price: 4000, line_sum: 4000, is_gift: false, product: { name: 'Хлеб', unit: 'pcs' } },
      ],
    },
  ],
  costs: [
    { id: 'p1', cost_price: 1000 },
    { id: 'p2', cost_price: null },
  ],
});
if (mixedCost.revenue !== 14000) fail('mixed revenue');
if (mixedCost.cogsKnown !== 2000) fail('known cogs only p1');
if (mixedCost.cogsComplete) fail('one missing product blocks complete cogs');
if (mixedCost.estimatedGrossProfit !== null) fail('do not present total profit as a fact');

// --- company-wide expenses ---
const company = report({
  orders: [paid],
  expenses: [
    {
      id: 'e-rent',
      expense_date: '2026-11-08',
      category: 'rent',
      amount: 1500,
      city_id: null,
      operation_id: 'op-rent',
    },
  ],
  expensesInputComplete: true,
});
if (company.operatingExpenses !== 1500) fail('company rent in operating');
if (company.companyWideExpenses !== 1500) fail('company-wide total');
if (company.cityRows[0].cityOperatingExpenses !== 0) fail('company expense must not auto-allocate to city');
if (company.cityRows[0].companyExpensesExcluded !== 1500) fail('city sees excluded company amount');
if (company.estimatedNetProfit !== 10000 - 2000 - 1500) fail('company net = gross - operating');
if (!company.warnings.includes('company_expenses_not_allocated_to_cities')) fail('allocation warning');

const incompleteExp = report({
  orders: [paid],
  expenses: [
    {
      id: 'e-rent',
      expense_date: '2026-11-08',
      category: 'rent',
      amount: 1500,
      city_id: null,
      operation_id: 'op-rent',
    },
  ],
  expensesInputComplete: false,
});
if (incompleteExp.estimatedGrossProfit !== 8000) fail('gross still estimated when cogs complete');
if (incompleteExp.estimatedNetProfit !== null) fail('net not a fact until expenses confirmed');
if (incompleteExp.preliminaryNetProfit !== 6500) fail('preliminary net still computed');
if (incompleteExp.profitReliable) fail('profitReliable requires expenses complete');

// --- city expenses ---
const cityExp = report({
  orders: [paid],
  expenses: [
    {
      id: 'e-log',
      expense_date: '2026-11-08',
      category: 'logistics',
      amount: 500,
      city_id: 'c1',
      operation_id: 'op-log',
    },
    {
      id: 'e-ads',
      expense_date: '2026-11-08',
      category: 'ads',
      amount: 200,
      city_id: 'c2',
      operation_id: 'op-ads',
    },
  ],
});
if (cityExp.cityTaggedExpenses !== 700) fail('city tagged expenses');
const atyrau = cityExp.cityRows.find((c) => c.cityId === 'c1');
if (!atyrau || atyrau.cityOperatingExpenses !== 500) fail('Atyrau logistics');
if (atyrau.estimatedNetProfit !== 10000 - 2000 - 500) fail('city net uses city expenses only');
const almaty = cityExp.cityRows.find((c) => c.cityId === 'c2');
if (!almaty || almaty.revenue !== 0 || almaty.cityOperatingExpenses !== 200) fail('Almaty expense without sales stays unallocated from Atyrau');

// --- zero revenue with expenses ---
const zeroRev = report({
  orders: [],
  expenses: [
    {
      id: 'e-tax',
      expense_date: '2026-11-08',
      category: 'tax',
      amount: 100,
      city_id: null,
      operation_id: 'op-tax',
    },
  ],
  expensesInputComplete: true,
});
if (zeroRev.revenue !== 0) fail('zero revenue');
if (zeroRev.estimatedNetProfit !== -100) fail('zero revenue net is negative opex');
if (zeroRev.grossMarginPct !== null || zeroRev.netMarginPct !== null) fail('margins undefined at zero revenue');

// --- double-count protection ---
const dupExp = uniqueLiveExpenses(
  [
    {
      id: 'e1',
      expense_date: '2026-11-08',
      category: 'ads',
      amount: 100,
      operation_id: 'op-1',
    },
    {
      id: 'e1',
      expense_date: '2026-11-08',
      category: 'ads',
      amount: 100,
      operation_id: 'op-1',
    },
    {
      id: 'e2',
      expense_date: '2026-11-08',
      category: 'ads',
      amount: 100,
      operation_id: 'op-1',
    },
    {
      id: 'e-del',
      expense_date: '2026-11-08',
      category: 'ads',
      amount: 999,
      operation_id: 'op-del',
      deleted_at: '2026-11-08T10:00:00.000Z',
    },
    {
      id: 'e-out',
      expense_date: '2026-11-01',
      category: 'ads',
      amount: 50,
      operation_id: 'op-out',
    },
  ],
  fromYmd,
  toYmd
);
if (dupExp.length !== 1) fail('expenses must unique by id/operation_id, skip deleted and out of range');

const cargo = report({
  orders: [paid],
  expenses: [
    {
      id: 'e-cargo',
      expense_date: '2026-11-08',
      category: FINANCE_CARGO_CUSTOMS_CATEGORY,
      amount: 4000,
      city_id: null,
      operation_id: 'op-cargo',
    },
    {
      id: 'e-sal',
      expense_date: '2026-11-08',
      category: 'salary',
      amount: 300,
      city_id: null,
      operation_id: 'op-sal',
    },
  ],
});
if (cargo.cargoCustomsExpenses !== 4000) fail('cargo kept as its own line');
if (cargo.operatingExpenses !== 300) fail('cargo must not join operating opex');
if (cargo.estimatedNetProfit !== 10000 - 2000 - 300) fail('net must not subtract cargo_customs (avoid COGS double count)');
if (cargo.estimatedNetProfit === 10000 - 2000 - 300 - 4000) fail('cargo double-counted in net');
if (!cargo.warnings.includes('cargo_customs_held_out_of_net')) fail('cargo warning');
if (!cargo.expensesByCategory.some((c) => c.category === 'cargo_customs' && c.amount === 4000)) {
  fail('cargo still listed in category breakdown');
}

const parsed = parseFinanceExpensesList({
  items: [{ id: 'e1', expense_date: '2026-11-08', category: 'other', amount: '12.50', deleted_at: null }],
});
if (parsed.length !== 1 || parsed[0].id !== 'e1') fail('parse expenses list rpc shape');

if (empty.cogsIsHistorical !== false) fail('current cost must never be labeled historical');
if (giftR.warnings.includes('cogs_is_current_catalog_not_historical') === false) fail('historical warning always on');

const nov = monthRangeYmd(2026, 11);
if (nov.fromYmd !== '2026-11-01' || nov.toYmd !== '2026-11-30') fail('month bounds');

const TODAY = '2026-11-08';
function finRange(mode: Parameters<typeof resolveFinanceRange>[0]['mode'], customFrom = '', customTo = '') {
  return resolveFinanceRange({ mode, customFrom, customTo, todayYmd: TODAY });
}

const todayR = finRange('today');
if (!todayR || todayR.fromYmd !== TODAY || todayR.toYmd !== TODAY) fail('today ymd');
if (todayR.range.from.toISOString() !== '2026-11-07T19:00:00.000Z') fail('today from Almaty midnight');
if (todayR.range.toNext.toISOString() !== '2026-11-08T19:00:00.000Z') fail('today toNext Almaty midnight');

const yest = finRange('yesterday');
if (!yest || yest.fromYmd !== '2026-11-07' || yest.toYmd !== '2026-11-07') fail('yesterday');

const last7 = finRange('last7');
if (!last7 || last7.fromYmd !== '2026-11-02' || last7.toYmd !== TODAY) fail('last7 inclusive');

const last30 = finRange('last30');
if (!last30 || last30.fromYmd !== addDaysYmd(TODAY, -29) || last30.toYmd !== TODAY) fail('last30 inclusive');

const thisMonth = finRange('thisMonth');
if (!thisMonth || thisMonth.fromYmd !== '2026-11-01' || thisMonth.toYmd !== TODAY) fail('thisMonth to today not month-end');

const lastMonth = finRange('lastMonth');
if (!lastMonth || lastMonth.fromYmd !== '2026-10-01' || lastMonth.toYmd !== '2026-10-31') fail('lastMonth October');

const jan = resolveFinanceRange({ mode: 'lastMonth', customFrom: '', customTo: '', todayYmd: '2026-01-08' });
if (!jan || jan.fromYmd !== '2025-12-01' || jan.toYmd !== '2025-12-31') fail('lastMonth year wrap');

const leap = resolveFinanceRange({ mode: 'lastMonth', customFrom: '', customTo: '', todayYmd: '2024-03-05' });
if (!leap || leap.fromYmd !== '2024-02-01' || leap.toYmd !== '2024-02-29') fail('lastMonth leap February');

const last90 = finRange('last90');
if (!last90 || last90.fromYmd !== addDaysYmd(TODAY, -89) || last90.toYmd !== TODAY) fail('last90 inclusive');
if (last90.fromYmd !== '2026-08-11') fail('last90 calendar start');

const thisYear = finRange('thisYear');
if (!thisYear || thisYear.fromYmd !== '2026-01-01' || thisYear.toYmd !== TODAY) fail('thisYear to today');
if (thisYear.fromYmd !== startOfYearYmd(TODAY)) fail('thisYear uses startOfYearYmd');
if (thisYear.range.from.toISOString() !== '2025-12-31T19:00:00.000Z') fail('thisYear Almaty start');

const nye = resolveFinanceRange({ mode: 'thisYear', customFrom: '', customTo: '', todayYmd: '2026-01-01' });
if (!nye || nye.fromYmd !== '2026-01-01' || nye.toYmd !== '2026-01-01') fail('thisYear on Jan 1');

const customOk = finRange('custom', '2026-11-01', '2026-11-08');
if (!customOk || customOk.fromYmd !== '2026-11-01' || customOk.toYmd !== TODAY) fail('custom range');
if (finRange('custom', '2026-11-10', '2026-11-01')) fail('invalid custom range');

for (const mode of ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth'] as const) {
  const financeSpec = finRange(mode);
  const statsSpec = resolvePeriod(mode, '', '', TODAY);
  if (!financeSpec || !statsSpec) fail(`missing ${mode} spec`);
  if (financeSpec.fromYmd !== statsSpec.fromYmd || financeSpec.toYmd !== statsSpec.toYmd) {
    fail(`finance ${mode} must match stats`);
  }
  if (financeSpec.range.from.getTime() !== statsSpec.range.from.getTime()) fail(`finance ${mode} from instant`);
  if (financeSpec.range.toNext.getTime() !== statsSpec.range.toNext.getTime()) fail(`finance ${mode} toNext instant`);
}

if (FINANCE_PERIOD_PRESETS.map((p) => p.id).join(',') !== 'today,yesterday,last7,last30,thisMonth,lastMonth,last90,thisYear,custom') {
  fail('preset order');
}

const twoSales = report({ orders: [paid, repaid] });
if (twoSales.recognizedOrderCount !== 2) fail('two recognized sales');
if (twoSales.averageCheck !== 9000) fail('average check 18000/2');

const statsSameOrders = [paid, repaid, unpaidDebt, pendingPre, { ...paid, id: 'o-cancel', status: 'canceled' }] as StatsOrder[];
const statsSame = buildAdminStats({
  orders: statsSameOrders,
  unpaidDebts: [],
  range,
  sellerId: 'all',
  cityId: 'all',
  productId: 'all',
  sellerNames: new Map(),
  deletedSellerLabel: 'deleted',
});
const financeSame = report({
  orders: statsSameOrders,
});
if (statsSame.revenue !== financeSame.revenue) fail('finance revenue must match stats');
if (statsSame.orderCount !== financeSame.recognizedOrderCount) fail('finance order count must match stats');
if (Number(statsSame.averageCheck.toFixed(2)) !== financeSame.averageCheck) fail('finance AOV must match stats');

const nowAlmaty = new Date('2026-11-08T12:00:00+05:00');
const sellerNames = new Map([['s1', 'Айдар'], ['s2', 'Болат']]);
const debtBase: StatsOrder = {
  id: 'd1',
  seller_id: 's1',
  city_id: 'c1',
  total_sum: 5000,
  status: 'confirmed',
  payment_type: 'debt',
  is_debt: true,
  debt_status: 'active',
  created_at: '2026-10-01T06:00:00.000Z',
};
function debtSnap(unpaidDebts: StatsOrder[], cityId: string | 'all' = 'all') {
  return summarizeUnpaidDebts({
    unpaidDebts,
    cityId,
    sellerNames,
    cityNames,
    deletedSellerLabel: 'Удалённый продавец',
    unnamedCityLabel: 'Без города',
    now: nowAlmaty,
  });
}
const emptyDebt = debtSnap([]);
if (emptyDebt.unpaidDebtAmount !== 0 || emptyDebt.unpaidDebtOrders !== 0) fail('no debts');
if (emptyDebt.overdueAvailable) fail('no overdue without due dates');

const oneOpen = debtSnap([debtBase]);
if (oneOpen.unpaidDebtAmount !== 5000 || oneOpen.unpaidDebtOrders !== 1) fail('one open debt');
if (oneOpen.unpaidDebtBySellerCity.length !== 1 || oneOpen.unpaidDebtBySellerCity[0].sellerName !== 'Айдар') {
  fail('one debt table seller');
}
if (oneOpen.unpaidDebtBySellerCity[0].cityName !== 'Атырау') fail('one debt table city');

const paidDebt: StatsOrder = { ...debtBase, id: 'd-paid', debt_status: 'paid', debt_paid_at: '2026-11-01T00:00:00.000Z' };
const canceledDebt: StatsOrder = { ...debtBase, id: 'd-cancel', status: 'canceled' };
if (debtSnap([paidDebt, canceledDebt]).unpaidDebtOrders !== 0) fail('paid and canceled are not open AR');

const overdueDebt: StatsOrder = { ...debtBase, id: 'd-over', debt_due_at: '2026-11-07T12:00:00+05:00' };
const futureDebt: StatsOrder = {
  ...debtBase,
  id: 'd-future',
  seller_id: 's2',
  city_id: 'c2',
  total_sum: 3000,
  debt_due_at: '2026-11-09T12:00:00+05:00',
};
if (!isOverdueUnpaidDebt(overdueDebt, nowAlmaty)) fail('past due is overdue');
if (isOverdueUnpaidDebt(futureDebt, nowAlmaty)) fail('future due is not overdue');
if (isOverdueUnpaidDebt({ ...debtBase, debt_due_at: '2026-11-08T12:00:00+05:00' }, nowAlmaty)) {
  fail('due equal now is not overdue');
}

const mixed = debtSnap([overdueDebt, futureDebt, paidDebt, canceledDebt, debtBase]);
if (mixed.unpaidDebtOrders !== 3 || mixed.unpaidDebtAmount !== 13000) fail('mixed open debts');
if (mixed.overdueDebtAmount !== 5000 || mixed.overdueDebtOrders !== 1) fail('overdue subset');
if (mixed.unpaidDebtBySellerCity.length !== 2) fail('seller-city groups');
const statsDebt = buildAdminStats({
  orders: [paid] as StatsOrder[],
  unpaidDebts: [overdueDebt, futureDebt, paidDebt, canceledDebt, debtBase],
  range,
  sellerId: 'all',
  cityId: 'all',
  productId: 'all',
  sellerNames,
  deletedSellerLabel: 'Удалённый продавец',
  now: nowAlmaty,
});
if (statsDebt.unpaidDebtAmount !== mixed.unpaidDebtAmount) fail('finance AR must match stats amount');
if (statsDebt.unpaidDebtOrders !== mixed.unpaidDebtOrders) fail('finance AR must match stats count');
if (statsDebt.overdueDebtAmount !== mixed.overdueDebtAmount) fail('finance overdue must match stats');
if (statsDebt.overdueDebtOrders !== mixed.overdueDebtOrders) fail('finance overdue orders must match stats');
if (financeSame.revenue !== 18000) fail('AR must not be added to recognized revenue');
if (debtSnap([overdueDebt, futureDebt], 'c2').unpaidDebtAmount !== 3000) fail('city filter on AR');
if (debtSnap([{ ...debtBase, created_at: '2025-01-01T00:00:00.000Z' }]).unpaidDebtOrders !== 1) {
  fail('open AR is not limited to the P&L period');
}

const sellerNamesFinance = new Map([['s1', 'Айдар'], ['s2', 'Болат']]);
const s1 = report({
  orders: [{ ...paid, seller_id: 's1' }],
  sellerNames: sellerNamesFinance,
});
if (s1.sellerRows.length !== 1 || s1.sellerRows[0].sellerName !== 'Айдар') fail('one seller');
if (s1.sellerRows[0].cityName !== 'Атырау' || s1.sellerRows[0].orderCount !== 1) fail('seller city and count');
if (s1.sellerRows[0].revenue !== 10000 || s1.sellerRows[0].cogsKnown !== 2000) fail('seller revenue/cogs');
if (s1.sellerRows[0].estimatedGrossProfit !== 8000 || s1.sellerRows[0].grossMarginPct !== 80) fail('seller gross/margin');

const s2order: FinanceOrder = {
  ...paid,
  id: 'o-s2',
  seller_id: 's2',
  city_id: 'c2',
  total_sum: 4000,
  order_items: [
    { product_id: 'p1', qty: 1, price: 4000, line_sum: 4000, is_gift: false, product: { name: 'Молоко', unit: 'pcs' } },
  ],
};
const twoSellers = report({
  orders: [{ ...paid, seller_id: 's1' }, s2order],
  sellerNames: sellerNamesFinance,
});
if (twoSellers.sellerRows.length !== 2) fail('two sellers');
const sumRev = twoSellers.sellerRows.reduce((s, r) => s + r.revenue, 0);
const sumCogs = twoSellers.sellerRows.reduce((s, r) => s + r.cogsKnown, 0);
const sumGross = twoSellers.sellerRows.reduce((s, r) => s + (r.estimatedGrossProfit || 0), 0);
if (sumRev !== twoSellers.revenue) fail('seller revenue must match KPI');
if (sumCogs !== twoSellers.cogsKnown) fail('seller cogs must match KPI');
if (sumGross !== twoSellers.estimatedGrossProfit) fail('seller gross must match KPI');
if (twoSellers.sellerRows[0].sellerName !== 'Айдар') fail('default sort by gross');

const giftOnly: FinanceOrder = {
  ...paid,
  id: 'o-gift-only',
  seller_id: 's1',
  total_sum: 0,
  order_items: [
    { product_id: 'p1', qty: 1, price: 0, line_sum: 0, is_gift: true, product: { name: 'Молоко', unit: 'pcs' } },
  ],
};
const giftOnlyR = report({ orders: [giftOnly], sellerNames: sellerNamesFinance });
if (giftOnlyR.sellerRows[0].revenue !== 0 || giftOnlyR.sellerRows[0].orderCount !== 1) fail('gift-only still a sale');
if (giftOnlyR.sellerRows[0].cogsKnown !== 1000 || giftOnlyR.sellerRows[0].estimatedGrossProfit !== -1000) {
  fail('gift-only cogs/gross');
}
if (giftOnlyR.sellerRows[0].grossMarginPct !== null) fail('zero revenue must not divide margin');

if (report({ orders: [unpaidDebt] }).sellerRows.length !== 0) fail('unpaid debt is not a seller sale');
if (report({ orders: [pendingPre] }).sellerRows.length !== 0) fail('pending preorder is not a seller sale');
if (report({ orders: [{ ...paid, seller_id: 's1', status: 'canceled' }] }).sellerRows.length !== 0) {
  fail('canceled is not a seller sale');
}

const noSeller = report({ orders: [{ ...paid, seller_id: null }], noSellerLabel: 'Без продавца' });
if (noSeller.sellerRows[0].sellerName !== 'Без продавца' || noSeller.sellerRows[0].revenue !== 10000) {
  fail('missing seller_id row');
}
const deleted = report({
  orders: [{ ...paid, seller_id: 'deadbeef-id' }],
  sellerNames: sellerNamesFinance,
  deletedSellerLabel: 'Удалённый продавец',
});
if (!deleted.sellerRows[0].sellerName.startsWith('Удалённый продавец')) fail('deleted seller label');

const missingSeller = report({
  orders: [{ ...paid, seller_id: 's1' }],
  costs: [{ id: 'p1', cost_price: null }],
  sellerNames: sellerNamesFinance,
});
if (missingSeller.sellerRows[0].estimatedGrossProfit !== null || missingSeller.sellerRows[0].grossMarginPct !== null) {
  fail('incomplete seller gross hidden');
}
if (missingSeller.estimatedGrossProfit !== null) fail('headline still hidden');

const sortedMargin = sortFinanceSellerRows(twoSellers.sellerRows, 'revenue');
if (sortedMargin[0].revenue < sortedMargin[1].revenue) fail('sort by revenue');
if (sortFinanceSellerRows(twoSellers.sellerRows, 'orders')[0].orderCount < 1) fail('sort by orders');

const citySplit = expensesForCityView(
  [
    { id: 'a', city_id: 'c1', amount: 10, category: 'ads', expense_date: '2026-11-08' },
    { id: 'b', city_id: null, amount: 20, category: 'rent', expense_date: '2026-11-08' },
  ],
  'c1'
);
if (citySplit.pnlExpenses.length !== 1 || citySplit.companyExpenses.length !== 1) fail('city view keeps company separate');
if (ordersForCityView([paid, { ...paid, id: 'x', city_id: 'c2' }], 'c1').length !== 1) fail('city order filter');

if (financeGrossKpi(missing).kind !== 'unavailable') fail('gross kpi hidden without cost');
if (financeNetKpi(incompleteExp).kind !== 'preliminary') fail('net kpi preliminary when expenses open');
if (financeNetKpi(company).kind !== 'estimate') fail('net kpi estimate when complete');
if (isSessionOnlyExpenseCompleteness(false) !== true) fail('completeness is session-only');

const ev = parseFinanceExpenseEvents({
  items: [{ id: '1', action: 'create', created_at: '2026-11-08T00:00:00Z' }],
});
if (ev.length !== 1 || ev[0].action !== 'create') fail('parse events rpc');
const parsedStr = parseFinanceExpensesList('{"items":[{"id":"e9","expense_date":"2026-11-08","amount":"3.50"}]}');
if (parsedStr.length !== 1 || parsedStr[0].id !== 'e9') fail('parse jsonb string envelope');
if (parseFinanceExpensesList({ items: '[]' }).length !== 0) fail('parse empty items string');
if (financeRpcErrorKind('permission denied for function admin_finance_expenses_list') !== 'permission') {
  fail('permission rpc kind');
}
if (financeRpcErrorKind('Failed to fetch') !== 'network') fail('network rpc kind');
if (financeRpcErrorKind('Idempotency key reused with a different payload') !== 'conflict') fail('conflict rpc kind');

// --- static contract ---
const src = read('lib/adminFinance.ts');
if (!src.includes("from '@/lib/accounting'")) fail('must use accounting module');
if (!src.includes('isConfirmedInRange') || !src.includes('sumConfirmedInRange')) fail('must use existing recognition');
if (!src.includes(FINANCE_COSTS_RPC)) fail('costs rpc name');
if (!src.includes(FINANCE_EXPENSES_LIST_RPC)) fail('expenses rpc name');
if (src.includes(".from('products')") || src.includes('cost_price,')) fail('must not select products.cost_price');
if (src.includes('apply_inventory_restock') || src.includes('confirm_order')) fail('must not touch restock/confirm');
if (!FINANCE_ORDER_SELECT.includes('is_gift') || !FINANCE_ORDER_SELECT.includes('line_sum')) fail('order select gifts/lines');
if (FINANCE_ORDER_SELECT.includes('cost_price')) fail('order select must not request cost_price');

const page = read('app/admin/finance/page.tsx');
const nav = read('components/NavAdmin.tsx');
const i18n = read('lib/i18n.tsx');
const managerNav = read('components/NavManager.tsx');
if (!existsSync(join(process.cwd(), 'app/admin/finance/page.tsx'))) fail('finance page missing');
if (!page.includes('Protected role="admin"')) fail('admin-only finance page');
if (!page.includes('bg-slate-50') || !page.includes('rounded-2xl') || !page.includes('max-w-6xl')) fail('dashboard visual language');
if (!page.includes('grid-cols-2') || !page.includes('lg:grid-cols-4')) fail('kpi grid');
if (!page.includes('FINANCE_PERIOD_PRESETS') || !page.includes("setMode(p.id)")) fail('period chips');
if (!page.includes('finance.orderCount') || !page.includes('finance.avgCheck')) fail('sale count kpi');
if (!page.includes('recognizedOrderCount') || !page.includes('averageCheck')) fail('recognized sale fields');
if (page.includes("setMode('month')") || page.includes('padMonth')) fail('old month picker must be gone');
if (!page.includes('FinanceSkeleton') || !page.includes('animate-pulse')) fail('skeleton');
if (!page.includes('let cancelled = false')) fail('load cancel flag');
if (page.includes('[spec, refreshKey, t]') || page.includes(', t]')) fail('effects must not depend on unstable t');
if (!page.includes('[periodKey, refreshKey, spec]')) fail('stable load deps');
if (!page.includes('finally')) fail('saving must clear in finally');
if (!page.includes('financeRpcErrorKind')) fail('rpc error mapping');
if (page.includes(".from('finance_expenses')") || page.includes(".from('finance_expense_events')")) {
  fail('must not query finance tables directly');
}
if (page.includes("from('products')")) fail('must not select products on finance page');
if (!page.includes(`rpc(${FINANCE_COSTS_RPC}`) && !page.includes('FINANCE_COSTS_RPC')) fail('costs via rpc');
if (!page.includes('FINANCE_EXPENSE_CREATE_RPC') || !page.includes('FINANCE_EXPENSE_UPDATE_RPC')) fail('mutation rpcs');
if (!page.includes('FINANCE_EXPENSE_DELETE_RPC') || !page.includes('FINANCE_EXPENSE_EVENTS_RPC')) fail('delete/events rpcs');
if (!page.includes('p_operation_id') || !page.includes('newClientOperationId')) fail('operation_id idempotency');
if (!page.includes('disabled={saving}')) fail('disable while saving');
if (!page.includes('runExclusive')) fail('exclusive submit');
if (!page.includes('window.confirm')) fail('soft delete confirm');
if (!page.includes('expensesCompleteHint') || !page.includes('setExpensesComplete')) fail('session completeness ui');
if (page.includes('writeUserUi') || page.includes('localStorage')) fail('must not persist month-close');
if (!page.includes('finance.cogsHint') || !page.includes('finance.cargoHint')) fail('reliability copy');
if (!page.includes('finance.companyTitle') || !page.includes('finance.byCity')) fail('report sections');
if (!page.includes('finance.bySeller') || !page.includes('sortFinanceSellerRows')) fail('seller gross section');
if (!page.includes('finance.noSeller') || !page.includes('finance.bySellerHint')) fail('seller copy');
if (!page.includes('finance.sellerGross')) fail('seller gross label');
if (!page.includes('LineChart')) fail('daily chart from existing data');
if (page.includes('lucide')) fail('no new icon library');
if (!nav.includes('href="/admin/finance"') || !nav.includes("t('finance.nav')")) fail('nav finance');
if (managerNav.includes('/admin/finance')) fail('manager must not get finance nav');
if (!i18n.includes("'finance.nav': 'Финансы'") || !i18n.includes("'finance.nav': 'Қаржы'")) fail('i18n nav');
if (!i18n.includes("'finance.revenue': 'Признанная выручка'") || !i18n.includes("'finance.revenue': 'Мойындалған түсім'")) {
  fail('i18n recognized revenue');
}
if (!i18n.includes("'finance.cogs': 'Оценочная себестоимость'") || !i18n.includes("'finance.cogs': 'Бағаланған өзіндік құн'")) {
  fail('i18n estimated cogs');
}
if (!i18n.includes("'finance.net': 'Оценочная чистая прибыль'") || !i18n.includes("'finance.net': 'Бағаланған таза пайда'")) {
  fail('i18n estimated net');
}
if (!page.includes('fetchRecognizedWindow') || !page.includes('finance.truncated')) fail('same order window and truncation banner');
if (!page.includes('fetchUnpaidDebts') || !page.includes('summarizeUnpaidDebts')) fail('reuse stats unpaid debts');
if (!page.includes('finance.receivables') || !page.includes('finance.receivablesAsOfNow')) fail('AR as-of-now copy');
if (!page.includes('border-amber-200')) fail('AR visually distinct from P&L');
if (!page.includes('[refreshKey]')) fail('AR fetch independent of period');
if (page.includes('customer_phone') || page.includes('debt_customer')) fail('must not show customer PII on finance');
if (src.includes('unpaidDebtAmount') || src.includes('fetchUnpaidDebts')) fail('P&L builder must not mix AR');
if (!read('lib/fetchAdminStatsOrders.ts').includes('ORDER_STATS_MAX')) fail('order cap still in fetch');
if (!read('lib/accounting.ts').includes('getAccountingDate')) fail('accounting module intact');
if (!i18n.includes("'finance.permissionDenied':") || !i18n.includes("'finance.networkError':")) fail('i18n rpc errors');
const financeRu = [...i18n.matchAll(/'(finance\.[^']+)':/g)].map((m) => m[1]);
const ruSet = new Set(financeRu.slice(0, financeRu.length / 2));
const kzSet = new Set(financeRu.slice(financeRu.length / 2));
for (const key of ruSet) if (!kzSet.has(key)) fail(`kz missing ${key}`);
for (const key of kzSet) if (!ruSet.has(key)) fail(`ru missing ${key}`);
if (!i18n.includes('не сохранённое закрытие месяца') || !i18n.includes('сақталған ай жабылуы емес')) {
  fail('completeness not month close');
}

if (FINANCE_EXPENSE_CREATE_RPC !== 'admin_finance_expense_create') fail('create rpc name');
if (FINANCE_EXPENSE_UPDATE_RPC !== 'admin_finance_expense_update') fail('update rpc name');
if (FINANCE_EXPENSE_DELETE_RPC !== 'admin_finance_expense_delete') fail('delete rpc name');
if (FINANCE_EXPENSE_EVENTS_RPC !== 'admin_finance_expense_events') fail('events rpc name');

console.log('admin-finance checks ok');
