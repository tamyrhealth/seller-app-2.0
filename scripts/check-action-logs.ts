import { readFileSync } from 'fs';
import { join } from 'path';
import {
  orderHistoryActionLabel,
  orderHistoryActorLabel,
  orderHistoryPaymentLabel,
  parseOrderHistoryItems,
} from '../lib/orderActionHistory';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

if (orderHistoryActionLabel('order_create') !== 'Создание заказа') fail('create label');
if (orderHistoryActionLabel('order_cancel') !== 'Отмена заказа') fail('cancel label');
if (orderHistoryActionLabel('order_cancel_already') !== 'Повторный запрос отмены — заказ уже отменён') {
  fail('already-canceled label must not look like a new cancel');
}
if (
  orderHistoryActionLabel('order_cancel', { already_canceled: true }) !==
  'Повторный запрос отмены — заказ уже отменён'
) {
  fail('details.already_canceled must not look like a new cancel');
}
if (orderHistoryPaymentLabel('kaspi') !== 'Kaspi QR') fail('payment label');
if (orderHistoryActorLabel('Айгуль', 'seller') !== 'Айгуль (продавец)') fail('actor label');
const items = parseOrderHistoryItems({
  items: [
    { name: 'B', qty: 1, price: 10, line_sum: 10, is_gift: false },
    { name: 'A', qty: 2, is_gift: true },
  ],
});
if (items.length !== 2 || items[1].is_gift !== true) fail('parse items');

const sql = read('supabase/migrations/20261107200000_action_logs_protect_and_order_history.sql');
const runSql = read('supabase/run_action_logs_protect_and_order_history.sql');
if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/CREATE OR REPLACE FUNCTION public\.find_similar_orders/i.test(sql)) fail('must not rewrite 5.4.1');
if (/UPDATE\s+public\.action_logs/i.test(sql) || /DELETE\s+FROM\s+public\.action_logs/i.test(sql)) {
  fail('must not rewrite or delete existing logs');
}
if (!sql.includes('REVOKE INSERT, UPDATE, DELETE ON TABLE public.action_logs FROM PUBLIC, anon, authenticated')) {
  fail('revoke client writes');
}
if (!sql.includes('DROP POLICY IF EXISTS "action_logs_insert_authenticated"')) fail('drop insert policy');
if (!sql.includes('action_logs_select_admin') && !sql.includes('GRANT SELECT ON TABLE public.action_logs TO authenticated')) {
  fail('keep admin select path');
}
if (!sql.includes('SET row_security = off')) fail('log_order_action must set row_security off');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.log_order_action(text, uuid, jsonb) TO postgres')) {
  fail('log_order_action postgres only');
}
if (/GRANT EXECUTE ON FUNCTION public\.log_order_action[^\n]*authenticated/i.test(sql)) {
  fail('authenticated must not call log_order_action');
}
if (!sql.includes('CREATE CONSTRAINT TRIGGER orders_log_insert_trg')) fail('deferred constraint trigger');
if (!sql.includes('DEFERRABLE INITIALLY DEFERRED')) fail('trigger must wait until commit');
if (!sql.includes('SELECT * INTO v_order FROM public.orders WHERE id = NEW.id')) {
  fail('create log must re-read live total_sum');
}
if (!sql.includes('order_history_item_snapshot')) fail('item snapshot');
if (!sql.includes("'price'") || !sql.includes("'line_sum'") || !sql.includes("'is_gift'")) fail('item fields');
if (/CREATE OR REPLACE FUNCTION public\.apply_order_cancel_report/i.test(sql)) {
  fail('must not replace apply_order_cancel_report until production def is compared');
}
if (!sql.includes("'preorder_fulfill'") || !sql.includes("'debt_pay'")) fail('other events still logged');
if (!sql.includes('Insufficient stock')) fail('fulfill stock logic kept');
if (
  !sql.includes(
    'SELECT id, city_id, seller_id, is_preorder, preorder_status, status, order_number'
  )
) {
  fail('fulfill SELECT list must match production');
}
if (!sql.includes('SELECT id, seller_id, is_debt, debt_status, order_number')) {
  fail('debt SELECT list must match production');
}

function extractFnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`));
  if (start < 0) fail(`missing function ${name}`);
  const from = src.slice(start);
  const tagMatch = from.match(/AS\s+(\$[a-zA-Z_]*\$)/i);
  if (!tagMatch || tagMatch.index == null) fail(`missing body tag ${name}`);
  const tag = tagMatch[1];
  const bodyStart = from.indexOf(tag, tagMatch.index) + tag.length;
  const bodyEnd = from.indexOf(tag, bodyStart);
  if (bodyEnd < 0) fail(`unclosed body ${name}`);
  return from.slice(bodyStart, bodyEnd);
}

function stripLogDetails(body: string): string {
  return body.replace(/PERFORM public\.log_order_action\([\s\S]*?\);\s*/g, 'PERFORM public.log_order_action();\n');
}

function norm(body: string): string {
  return stripLogDetails(body)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const live = read('supabase/prod/_generated/block542_live_functions.sql');
if (norm(extractFnBody(sql, 'fulfill_preorder')) !== norm(extractFnBody(live, 'fulfill_preorder'))) {
  fail('fulfill_preorder business logic must match production except log details');
}
if (norm(extractFnBody(sql, 'mark_debt_paid')) !== norm(extractFnBody(live, 'mark_debt_paid'))) {
  fail('mark_debt_paid business logic must match production except log details');
}

const confirm = read('supabase/migrations/20261104010000_confirm_order_reject_inactive_products.sql');
if (!confirm.includes('UPDATE orders SET total_sum = v_total')) fail('confirm_order still two-step total');
if (confirm.includes('log_order_action')) fail('confirm_order must stay without action_logs');

const pre = read('supabase/prod/pre_apply_inspect_block542.sql');
const post = read('supabase/prod/post_apply_verify_block542.sql');
const apply = read('supabase/prod/apply_block542.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('postflight SELECT-only');
if (!post.includes('proconfig') && !post.includes('row_security=off')) fail('postflight GUC via proconfig');
if (!post.includes('authenticated.insert')) fail('postflight insert grant');
if (!post.includes('trigger.deferred')) fail('postflight deferred trigger');
if (!post.includes('trigger.constraint')) fail('postflight constraint trigger catalog');
if (!post.includes("cfg = 'search_path=public'")) fail('postflight search_path via proconfig');
if (!post.includes('cancel.report_not_rewritten')) fail('postflight must prove cancel RPC not rewritten');
if (!post.includes('action_logs.rls')) fail('postflight RLS catalog');
if (!post.includes('relrowsecurity')) fail('postflight relrowsecurity');
if (!apply.includes('backup_main.ps1')) fail('apply backup');
const inspectCancel = read('supabase/prod/inspect_block542_cancel_def.sql');
if (!inspectCancel.includes('pg_get_functiondef')) fail('cancel inspect dump');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(
  inspectCancel.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")
)) {
  fail('cancel inspect must be SELECT-only');
}

const ui = read('app/admin/orders/page.tsx');
const helper = read('lib/orderActionHistory.ts');
const actionLog = read('lib/actionLog.ts');
if (!ui.includes('orderHistoryActionLabel(h.action, details)')) fail('admin history must pass details for already_canceled');
if (!ui.includes('historyError')) fail('admin history error state');
if (!ui.includes("error.message")) fail('admin history must surface load error');
if (!helper.includes('order_cancel_already')) fail('helper already-canceled');
if (actionLog.includes(".from('action_logs').insert")) fail('client must not insert action_logs');

console.log('action-logs checks ok');
