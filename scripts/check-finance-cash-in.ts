import { readFileSync } from 'fs';
import { join } from 'path';
import { isConfirmedInRange, isRevenueOrder, type OrderForAccounting } from '../lib/accounting';
import {
  buildCashInReport,
  getVerifiedDebtCollectionAt,
  isVerifiedDebtCollectionInRange,
  recognitionRuleGap,
  sumVerifiedDebtCollectionsInRange,
} from '../lib/financeCashIn';

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

const cash: OrderForAccounting = {
  status: 'confirmed',
  payment_type: 'kaspi',
  total_sum: 5000,
  created_at: '2026-11-08T06:00:00.000Z',
  is_preorder: false,
  is_debt: false,
};

const unpaidDebt: OrderForAccounting = {
  status: 'confirmed',
  payment_type: 'debt',
  total_sum: 8000,
  created_at: '2026-11-08T06:00:00.000Z',
  is_debt: true,
  debt_status: 'active',
};

const paidDebt: OrderForAccounting = {
  ...unpaidDebt,
  debt_status: 'paid',
  debt_paid_at: '2026-11-08T12:00:00.000Z',
  debt_payment_method: 'kaspi',
};

const openPreorder: OrderForAccounting = {
  status: 'confirmed',
  payment_type: 'kaspi',
  total_sum: 3000,
  created_at: '2026-11-08T06:00:00.000Z',
  is_preorder: true,
  preorder_status: 'pending',
};

const fulfilledPreorder: OrderForAccounting = {
  ...openPreorder,
  preorder_status: 'fulfilled',
  fulfilled_at: '2026-11-08T15:00:00.000Z',
};

const canceled: OrderForAccounting = {
  ...cash,
  status: 'canceled',
};

if (isConfirmedInRange(cash, range) !== true) fail('cash order is recognized revenue');
if (isVerifiedDebtCollectionInRange(cash, range)) fail('kaspi confirm is not a dated cash receipt');

if (isConfirmedInRange(unpaidDebt, range)) fail('unpaid debt is not revenue');
if (isVerifiedDebtCollectionInRange(unpaidDebt, range)) fail('unpaid debt is not a collection');
if (getVerifiedDebtCollectionAt(unpaidDebt)) fail('active debt has no collection timestamp');

if (!isConfirmedInRange(paidDebt, range)) fail('paid debt is recognized on debt_paid_at');
if (!isVerifiedDebtCollectionInRange(paidDebt, range)) fail('paid debt is a dated collection');

if (isConfirmedInRange(openPreorder, range)) fail('open preorder is not revenue');
if (isVerifiedDebtCollectionInRange(openPreorder, range)) fail('open preorder is not cash in');

if (!isConfirmedInRange(fulfilledPreorder, range)) fail('fulfilled preorder is revenue on fulfilled_at');
if (isVerifiedDebtCollectionInRange(fulfilledPreorder, range)) {
  fail('fulfillment date is not a payment date');
}

if (isConfirmedInRange(canceled, range) || isVerifiedDebtCollectionInRange(canceled, range)) {
  fail('canceled order is neither revenue nor cash');
}

const cashIn = buildCashInReport([cash, unpaidDebt, paidDebt, openPreorder, fulfilledPreorder, canceled], range);
if (cashIn.quality !== 'incomplete' || cashIn.inflowsIncomplete !== true) fail('full Cash In must stay incomplete');
if (cashIn.verifiedDebtCollections !== 8000 || cashIn.verifiedDebtCollectionCount !== 1) {
  fail(`only paid debt is verified collection, got ${cashIn.verifiedDebtCollections}/${cashIn.verifiedDebtCollectionCount}`);
}
if (!cashIn.reasons.includes('no_payment_ledger')) fail('must explain missing payment ledger');
if (!cashIn.reasons.includes('cash_confirm_is_not_a_receipt')) fail('must not treat confirm as receipt');

const laterDebt = { ...paidDebt, debt_paid_at: '2026-11-10T12:00:00.000Z' };
if (sumVerifiedDebtCollectionsInRange([laterDebt], range).amount !== 0) fail('collection uses debt_paid_at, not created_at');

const paidNoTimestamp = { ...paidDebt, debt_paid_at: null };
if (isConfirmedInRange(paidNoTimestamp, range) || isVerifiedDebtCollectionInRange(paidNoTimestamp, range)) {
  fail('paid without timestamp is incomplete — do not invent cash or revenue');
}

const gapCash = recognitionRuleGap(cash, range);
if (!gapCash.confirmedInRange || !gapCash.revenueOrder) fail('kaspi confirmed should match both rules');

const noType: OrderForAccounting = { ...cash, payment_type: null };
const gapNoType = recognitionRuleGap(noType, range);
if (!gapNoType.confirmedInRange) fail('isConfirmedInRange still recognizes confirmed order without payment_type');
if (gapNoType.revenueOrder) fail('isRevenueOrder stays stricter on payment_type — do not switch finance to it');

const debtTypeStillDebt: OrderForAccounting = {
  ...paidDebt,
  payment_type: 'debt',
  debt_payment_method: null,
};
const gapDebt = recognitionRuleGap(debtTypeStillDebt, range);
if (!gapDebt.confirmedInRange) fail('paid debt remains recognized by isConfirmedInRange');
if (gapDebt.revenueOrder) fail('isRevenueOrder rejects debt without cash method — keep current finance rule');

const accounting = read('lib/accounting.ts');
if (!accounting.includes('getAccountingDate')) fail('recognition source of truth');
if (accounting.includes('buildCashInReport')) fail('cash-in must not rewrite accounting dates');

const cashLib = read('lib/financeCashIn.ts');
if (cashLib.includes('isOrderPaid')) fail('do not treat isOrderPaid as Cash In');
if (!cashLib.includes('inflowsIncomplete: true')) fail('must refuse full Cash In');

const page = read('app/admin/finance/page.tsx');
if (!page.includes('finance.cashInIncomplete')) fail('UI must say inflows are incomplete');
if (!page.includes('buildCashInReport')) fail('finance page must use cash-in helper');
if (!page.includes('finance.profitAndCash')) fail('profit vs cash section');
if (!page.includes('Protected role="admin"')) fail('admin-only');
if (page.includes("rpc('confirm_order'")) fail('must not call confirm_order');

const i18n = read('lib/i18n.tsx');
if (!i18n.includes('Данные о поступлениях неполные')) fail('ru incomplete copy');
if (!i18n.includes('Түсім деректері толық емес')) fail('kk incomplete copy');

const finance = read('lib/adminFinance.ts');
if (!finance.includes("category === FINANCE_CARGO_CUSTOMS_CATEGORY")) fail('cargo still split');
if (!finance.includes('cargo_customs_held_out_of_net')) fail('cargo stays out of net');
if (!finance.includes('isConfirmedInRange')) fail('finance still uses isConfirmedInRange');
if (finance.includes('isRevenueOrder')) fail('do not silently switch finance to isRevenueOrder');

console.log('finance-cash-in checks ok');
