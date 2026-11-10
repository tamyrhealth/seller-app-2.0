import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ACTIVITY_PAGE_SIZE,
  activityCancelReturnedStock,
  activityItems,
  activityOrderHref,
  activityOrderNumber,
  activityPageRange,
  activitySumDisplay,
  activityTotalSum,
  applyActivityLogFilters,
  fetchCurrentOrderSums,
  isActivityDateRangeInvalid,
  readOrderIdFromSearch,
  unrecordedOrderIds,
} from '../lib/adminActivity';
import { orderHistoryActionLabel } from '../lib/orderActionHistory';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

if (ACTIVITY_PAGE_SIZE !== 50) fail('page size must be 50');
if (activityPageRange(1).from !== 0 || activityPageRange(1).to !== 49) fail('page 1 range');
if (activityPageRange(2).from !== 50 || activityPageRange(2).to !== 99) fail('page 2 range');
if (activityPageRange(0).page !== 1) fail('invalid page becomes 1');
if (!isActivityDateRangeInvalid('2026-11-08', '2026-11-01')) fail('end before start is invalid');
if (isActivityDateRangeInvalid('2026-11-01', '2026-11-08')) fail('valid range flagged');
if (activityOrderHref('abc-id') !== '/admin/orders?id=abc-id') fail('order href');
if (activityOrderNumber({ order_number: 'N000001' }) !== 'N000001') fail('order number from details');
if (activityOrderNumber({}) !== null) fail('missing number must stay empty');
if (activityTotalSum({}) !== null) fail('missing sum must stay empty');
if (activityTotalSum({ total_sum: 1500 }) !== 1500) fail('sum from details');
if (activitySumDisplay('order_create', { total_sum: 0, order_number: 'N000039' }).kind !== 'unrecorded') {
  fail('old create log with 0 and no items is unrecorded');
}
if (activitySumDisplay('preorder_create', { total_sum: 0 }).kind !== 'unrecorded') {
  fail('old preorder create 0 is unrecorded');
}
if (activitySumDisplay('order_create', { total_sum: 0, items: [{ name: 'Gift', qty: 1, is_gift: true }] }).kind !== 'value') {
  fail('create with item snapshot and 0 is a real zero');
}
const newSum = activitySumDisplay('order_create', {
  total_sum: 5000,
  items: [{ name: 'A', qty: 1, line_sum: 5000 }],
});
if (newSum.kind !== 'value' || newSum.value !== 5000) fail('new create log keeps real total');
if (activitySumDisplay('preorder_fulfill', { total_sum: 5000, items: [] }).kind !== 'value') {
  fail('fulfill total must stay');
}
if (readOrderIdFromSearch('?id=abc-uuid') !== 'abc-uuid') fail('parse order id query');
if (readOrderIdFromSearch('') !== null) fail('empty search has no id');
const oldRow = {
  id: '1',
  created_at: '',
  action: 'order_create',
  user_id: null,
  user_name: null,
  user_role: null,
  entity_type: 'order',
  entity_id: 'ord-a',
  details: { total_sum: 0, order_number: 'N000035' },
};
const newRow = {
  ...oldRow,
  id: '2',
  entity_id: 'ord-b',
  details: { total_sum: 5000, items: [{ name: 'A', qty: 1 }] },
};
if (unrecordedOrderIds([oldRow, oldRow, newRow]).join() !== 'ord-a') fail('unrecorded ids must be unique and skip new logs');
if (activityCancelReturnedStock({ already_canceled: true, returned_stock: false }) !== null) {
  fail('repeat cancel must not claim stock');
}
if (activityCancelReturnedStock({ returned_stock: true }) !== true) fail('cancel returned stock');
if (activityItems({}).length !== 0) fail('missing items stay empty');
if (orderHistoryActionLabel('order_cancel', { already_canceled: true }) !== 'Повторный запрос отмены — заказ уже отменён') {
  fail('repeat cancel label');
}
if (orderHistoryActionLabel('preorder_create') !== 'Создание предзаказа') fail('preorder label');
if (orderHistoryActionLabel('debt_create') !== 'Создание долга') fail('debt label');
if (orderHistoryActionLabel('preorder_fulfill') !== 'Выдача предзаказа') fail('fulfill label');
if (orderHistoryActionLabel('debt_pay') !== 'Оплата долга') fail('debt pay label');

const calls: string[] = [];
const chain = {
  eq(column: string) {
    calls.push(`eq:${column}`);
    return chain;
  },
  gte(column: string) {
    calls.push(`gte:${column}`);
    return chain;
  },
  lt(column: string) {
    calls.push(`lt:${column}`);
    return chain;
  },
};
applyActivityLogFilters(chain, {
  fromISO: 'a',
  toNextISO: 'b',
  userId: 'u1',
  action: 'order_create',
  entityId: 'oid',
});
const rangeAt = calls.findIndex((c) => c.startsWith('gte:'));
const userAt = calls.indexOf('eq:user_id');
if (calls[0] !== 'eq:entity_type') fail('must restrict entity_type=order first');
if (rangeAt < 0 || userAt < rangeAt) fail('date filters must apply before user/action/id');
if (!calls.includes('eq:action') || !calls.includes('eq:entity_id')) fail('action and order id filters');
if (calls.some((c) => c.includes('city'))) fail('city filter is not proven without SQL');

const page = read('app/admin/activity/page.tsx');
const helper = read('lib/adminActivity.ts');
const nav = read('components/NavAdmin.tsx');
const i18n = read('lib/i18n.tsx');
const actionLog = read('lib/actionLog.ts');

if (!page.includes('Protected role="admin"')) fail('page must be admin-only');
if (!page.includes('fetchAdminOrderActivity')) fail('page must use server-side activity query');
if (!page.includes('setPage(1)')) fail('filters must reset to first page');
if (!page.includes('orderHistoryActionLabel')) fail('human action labels');
if (page.includes('JSON.stringify')) fail('must not dump JSON');
if (page.includes('filterCity') || helper.includes('city_id')) fail('city filter not allowed in this stage');
if (!page.includes('admin.activityEmpty') || !page.includes('admin.activityError') || !page.includes('admin.activityLoading')) {
  fail('loading/empty/error states');
}
if (!page.includes('admin.activityOpenOrder')) fail('link to order');
if (!nav.includes("/admin/activity")) fail('nav link');
if (!i18n.includes("'admin.activityTitle': 'История действий с заказами'")) fail('ru title');
if (!i18n.includes("'admin.activityTitle': 'Тапсырыс әрекеттерінің тарихы'")) fail('kz title');
if (!helper.includes('.order(') || !helper.includes('.range(')) fail('order then range pagination');
const fetchFn = helper.slice(helper.indexOf('export async function fetchAdminOrderActivity'));
const applyAt = fetchFn.indexOf('applyActivityLogFilters');
const rangeAtSrc = fetchFn.indexOf('.range(');
if (applyAt < 0 || rangeAtSrc < 0 || rangeAtSrc < applyAt) fail('filters must run before range/limit');
if (!helper.includes("eq('order_number'")) fail('search must resolve order number on server');
if (!helper.includes('parseOrderNumberQuery')) fail('canonical order-number search');
if (!helper.includes("{ count: 'exact' }")) fail('pagination needs total count');
if (actionLog.includes(".from('action_logs').insert")) fail('client must not insert action_logs');
if (page.includes(".insert") && page.includes('action_logs')) fail('page must not write logs');
if (page.includes(".from('action_logs')")) fail('page must query through helper, not ad-hoc');
if (!page.includes('activitySumDisplay') || !i18n.includes('admin.currentOrderSum')) {
  fail('journal must label live totals as current, not historical');
}
if (!page.includes('fetchCurrentOrderSums') || !page.includes('unrecordedOrderIds')) {
  fail('old totals must be batched from orders');
}
if (!helper.includes(".in('id'")) fail('current sums must use one in() query');
if (page.includes('dateRangeInvalid, t]')) fail('activity load must not depend on unstable t');
if (!i18n.includes('admin.historicalSumMissing')) fail('missing current order sum copy');

const ordersPage = read('app/admin/orders/page.tsx');
if (!ordersPage.includes('readOrderIdFromSearch')) fail('admin orders must open /admin/orders?id=');
if (!ordersPage.includes('maybeSingle')) fail('open-by-id must load the order regardless of list filters');
if (!ordersPage.includes('admin.orderNotFound')) fail('missing order message');
if (!ordersPage.includes('closeOrderDetail')) fail('closing the card must not depend on date filters');
if (!ordersPage.includes('activitySumDisplay')) fail('order history must reuse unrecorded-sum heuristic');
if (ordersPage.includes('.single()')) fail('single() hides a missing order as a blank card');
if (!ordersPage.includes('popstate')) fail('browser back should sync selected order id');
if (ordersPage.includes('[selectedId, refreshKey, t]')) fail('detail effect must not depend on unstable t');
if (!ordersPage.includes('[selectedId, refreshKey]')) fail('detail effect deps must stay selectedId and refreshKey');
if (!ordersPage.includes('prev === next')) fail('URL sync must ignore unchanged id');
if (!ordersPage.includes('prev.length === 0 ? prev')) fail('cleared card must not setState a new empty history array');
if (!ordersPage.includes("detailError === 'admin.orderNotFound'")) {
  fail('order-not-found must translate at render for RU/KZ');
}

const migrations = read('supabase/migrations/20261107200000_action_logs_protect_and_order_history.sql');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(migrations)) fail('must not rewrite confirm_order');
if (/CREATE OR REPLACE FUNCTION public\.apply_order_cancel_report/i.test(page + helper)) {
  fail('must not touch cancel RPC');
}

void (async () => {
  let inCalls = 0;
  const client = {
    from(table: string) {
      if (table !== 'orders') fail(`unexpected table ${table}`);
      return {
        select() {
          return {
            async in(_column: string, values: string[]) {
              inCalls += 1;
              return {
                data: values.map((id) => ({ id, total_sum: 5000 })),
                error: null,
              };
            },
          };
        },
      };
    },
  };
  const batched = await fetchCurrentOrderSums(client, ['a', 'a', 'b']);
  if (inCalls !== 1) fail('current sums must use a single in() query');
  if (batched.sums.get('a') !== 5000 || batched.sums.get('b') !== 5000 || batched.error) {
    fail('batch current sums');
  }
  const skipped = await fetchCurrentOrderSums(client, []);
  if (inCalls !== 1 || skipped.sums.size !== 0) fail('empty id list must not query orders');
  console.log('admin-activity checks ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
