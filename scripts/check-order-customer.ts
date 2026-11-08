import { readFileSync } from 'fs';
import { join } from 'path';
import { applyCustomerToConfirmPayload, orderCustomerDisplay } from '../lib/orderCustomer';
import { buildClientOrderFingerprint } from '../lib/orderIdempotency';
import { normalizeCustomerPhone } from '../lib/customerPhone';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const sql = read('supabase/migrations/20261108180000_order_customer_fields.sql');
const runSql = read('supabase/run_order_customer_fields.sql');
if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration transactional');
if (/UPDATE\s+public\.orders\s+SET/i.test(sql) && !sql.includes('UPDATE orders SET total_sum = v_total')) {
  fail('must not backfill old orders');
}
if (!sql.includes('ADD COLUMN IF NOT EXISTS customer_name')) fail('customer_name column');
if (!sql.includes('ADD COLUMN IF NOT EXISTS customer_phone')) fail('customer_phone column');
if (!sql.includes('ADD COLUMN IF NOT EXISTS customer_phone_canon')) fail('customer_phone_canon column');
if (!sql.includes('CREATE OR REPLACE FUNCTION public.kz_normalize_customer_phone')) fail('sql normalize');
if (!sql.includes("v_ndc NOT IN ('70', '74', '75', '76', '77')")) fail('sql NDC list');
if (!sql.includes("length(v_digits) = 11 AND left(v_digits, 1) = '8'")) fail('sql 8→7');
if (!sql.includes("length(v_digits) = 10 AND left(v_digits, 1) = '7'")) fail('sql 10-digit prefix');
if (!sql.includes("REVOKE ALL ON FUNCTION public.kz_normalize_customer_phone(text) FROM PUBLIC, anon, authenticated, service_role")) {
  fail('normalize must not be a public API');
}

function normSql(s: string) {
  return s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n+/g, '\n').trim();
}

function sliceBetween(src: string, start: string, end: string, label: string) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) fail(`missing region ${label}`);
  return normSql(src.slice(i, j));
}

function extractConfirm(src: string, kind: 'dump' | 'new') {
  if (kind === 'dump') {
    const i = src.indexOf('CREATE OR REPLACE FUNCTION public.confirm_order');
    const j = src.lastIndexOf('$function$');
    if (i < 0 || j < 0) fail('dump confirm_order missing');
    return src.slice(i, j);
  }
  const i = src.indexOf('CREATE OR REPLACE FUNCTION public.confirm_order');
  const j = src.indexOf('REVOKE ALL ON FUNCTION public.confirm_order');
  if (i < 0 || j < 0) fail('migration confirm_order missing');
  return src.slice(i, j);
}

const dump = read('supabase/prod/_generated/20261108-153703/confirm_order_before.sql');
const dumpConfirm = extractConfirm(dump, 'dump');
const newConfirm = extractConfirm(sql, 'new');
const frozen = [
  ['auth', 'v_actor_id := auth.uid()', 'Phone required for debt orders'],
  ['stock', 'FOR v_pid IN', 'INSERT INTO orders'],
  ['lines', 'FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)', 'EXCEPTION'],
  ['unique', 'WHEN unique_violation THEN', 'END;'],
] as const;
for (const [label, start, end] of frozen) {
  const left = sliceBetween(dumpConfirm, start, end, `dump ${label}`);
  const right = sliceBetween(newConfirm, start, end, `new ${label}`);
  if (left !== right) fail(`confirm_order ${label} diverged from 20261108-153703 dump`);
}
const fpStart = "'actor_id', v_actor_id::text";
const fpEnd = 'FROM jsonb_array_elements(v_items) e';
const dumpFp = sliceBetween(dumpConfirm, fpStart, fpEnd, 'dump fp').replace(/\s+/g, ' ');
const newFp = sliceBetween(newConfirm, fpStart, fpEnd, 'new fp').replace(/\s+/g, ' ');
if (dumpFp !== newFp) fail('base fingerprint jsonb keys diverged from dump');

const stockMarks = [
  'Insufficient stock for product',
  'qty_on_hand = qty_on_hand - v_need',
  'Product is not available',
  'pg_advisory_xact_lock',
  "hashtext('confirm_order:' || v_actor_id::text)",
  'v_price := 0',
  'inventory_movements',
  'Phone required for debt orders',
  'orders_idempotency_actor_key_uidx',
  'UPDATE orders SET total_sum = v_total',
  'IF NOT v_is_preorder THEN',
];
for (const mark of stockMarks) {
  if (!dump.includes(mark)) fail(`dump missing ${mark}`);
  if (!sql.includes(mark)) fail(`confirm_order lost ${mark}`);
}
if (sql.includes('action_logs') || sql.includes('log_order_action')) fail('confirm_order must not write action_logs');
if (!sql.includes('NOT v_is_debt AND (v_cust_name IS NOT NULL OR v_cust_phone IS NOT NULL)')) {
  fail('fingerprint extra keys only when non-debt has customer');
}
if (!sql.includes('v_cust_name := v_debt_name')) fail('debt copies into customer_*');
if (!sql.includes('CREATE OR REPLACE FUNCTION public.find_similar_orders')) fail('rewrite find_similar_orders');
if (!sql.includes('kz_normalize_customer_phone(o.debt_customer_phone)')) fail('old debt phones normalized on read');
if (sql.includes('o.customer_name')) fail('must not match similar orders by name');
if (!sql.includes("GRANT ALL ON FUNCTION public.confirm_order(jsonb) TO authenticated")) fail('confirm grant auth');
if (!sql.includes("GRANT ALL ON FUNCTION public.confirm_order(jsonb) TO service_role")) fail('confirm grant service');
if (!sql.includes('REVOKE ALL ON FUNCTION public.find_similar_orders(jsonb) FROM PUBLIC, anon, service_role')) {
  fail('similar revoke service_role');
}
if (/CREATE POLICY|ALTER POLICY|GRANT .* ON TABLE public\.orders/i.test(sql)) fail('must not widen orders RLS/GRANT');

const pre = read('supabase/prod/pre_apply_inspect_block562.sql');
const post = read('supabase/prod/post_apply_verify_block562.sql');
const apply = read('supabase/prod/apply_block562.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('postflight SELECT-only');
if (pre.includes('orders.policy_count') || post.includes('policy_count_unchanged_shape')) {
  fail('policy checks must not compare a value to itself');
}
if (post.includes("def NOT LIKE '%customer_name%' OR def LIKE '%identity_kind%'")) {
  fail('find_similar.no_name_match must not pass just because identity_kind exists');
}
if (!pre.includes('orders.seller_select_policy') || !pre.includes("'absent'")) fail('preflight must FAIL if seller select policy missing');
if (!post.includes('confirm_order.anon_execute') || !post.includes("'false'")) fail('postflight must FAIL if anon can execute confirm_order');
if (!post.includes('kz_normalize.anon_execute')) fail('postflight must FAIL if anon can execute kz_normalize');
if (!post.includes("def NOT LIKE '%o.customer_name%'")) fail('postflight must FAIL if similar matches on name');
if (!post.includes("def NOT LIKE '%length(v_phone_digits) >= 10%'")) fail('postflight must FAIL if similar uses digit-length identity');
if (!apply.includes('backup_main.ps1')) fail('apply backup');
if (!apply.includes('pre_apply_inspect_block562.sql')) fail('apply preflight');
if (!apply.includes('seller-app:order-idempotency:v3')) fail('must keep v3 store key');
if (apply.includes('idempotency:v4')) fail('must not bump store to v4');

const cash = {
  actorUserId: 'user-a',
  sellerId: 's1',
  cityId: 'c1',
  isPreorder: false,
  isDebt: false,
  paymentType: 'cash' as string | null,
  comment: 'hello',
  pickupDate: null as string | null,
  debtCustomerPhone: null as string | null,
  debtCustomerName: null as string | null,
  debtDueAt: null as string | null,
  debtNote: null as string | null,
  items: [{ product_id: 'a', qty: 1, price: '10' }],
};
const fpOld = buildClientOrderFingerprint(cash);
const fpEmpty = buildClientOrderFingerprint({ ...cash, customerName: '', customerPhone: '' });
if (fpOld !== fpEmpty) fail('empty customer must keep v3 fingerprint');
const fpOldKeys = Object.keys(JSON.parse(fpOld) as Record<string, unknown>);
if (fpOldKeys.includes('customer_name') || fpOldKeys.includes('customer_phone')) {
  fail('old cash fingerprint must omit customer keys');
}

const fpWith = buildClientOrderFingerprint({ ...cash, customerName: 'A', customerPhone: '87771234567' });
if (fpOld === fpWith) fail('customer on cash must change fingerprint');
const fpOther = buildClientOrderFingerprint({ ...cash, customerName: 'A', customerPhone: '87771234568' });
if (fpWith === fpOther) fail('different customer must not share fingerprint');

const fpDebt = buildClientOrderFingerprint({
  ...cash,
  isDebt: true,
  paymentType: 'debt',
  comment: null,
  debtCustomerPhone: '87771234567',
  debtCustomerName: 'A',
  customerName: 'A',
  customerPhone: '87771234567',
});
const fpDebtKeys = Object.keys(JSON.parse(fpDebt) as Record<string, unknown>);
if (fpDebtKeys.includes('customer_name') || fpDebtKeys.includes('customer_phone')) {
  fail('debt fingerprint must stay on debt_* keys');
}

const payload: Record<string, unknown> = { items: [] };
applyCustomerToConfirmPayload(payload, { isDebt: false, name: null, phone: null });
if ('customer_name' in payload || 'customer_phone' in payload || 'is_debt' in payload) {
  fail('ordinary without customer must look like old payload');
}
applyCustomerToConfirmPayload(payload, { isDebt: false, name: 'A', phone: 'not-a-phone' });
if (payload.customer_phone !== 'not-a-phone') fail('invalid ordinary phone stored raw');
if (normalizeCustomerPhone('not-a-phone') != null) fail('invalid phone has no canon');

const debtPayload: Record<string, unknown> = { items: [] };
applyCustomerToConfirmPayload(debtPayload, { isDebt: true, name: 'A', phone: '87771234567' });
if (debtPayload.debt_customer_phone !== '87771234567' || debtPayload.customer_phone !== '87771234567') {
  fail('debt must write both customer_* and debt_customer_*');
}

if (orderCustomerDisplay({ customer_name: 'A', customer_phone: '1' }) !== 'A · 1') fail('display prefers customer_*');
if (orderCustomerDisplay({ debt_customer_name: 'B', debt_customer_phone: '2' }) !== 'B · 2') fail('display falls back to debt_*');
if (orderCustomerDisplay({}) !== '—') fail('empty customer display');
if (orderCustomerDisplay({ debt_customer_name: 'Old', debt_customer_phone: '8777' }) !== 'Old · 8777') {
  fail('old debt-only orders must still display');
}

const similarLatest = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.find_similar_orders'));
if (!similarLatest.includes('v_phone_canon IS NOT NULL')) fail('similar identity is reliable canon only');
if (similarLatest.includes('length(v_phone_digits) >= 10')) fail('similar must not treat any 10+ digits as identity');
if (similarLatest.includes('o.customer_name')) fail('similar must not match by name');
if (!similarLatest.includes("interval '15 minutes'")) fail('similar window');
if (!similarLatest.includes('o.seller_id = v_seller_id') || !similarLatest.includes('o.city_id = v_city_id')) {
  fail('similar still seller+city scoped');
}
if (!similarLatest.includes('NOT v_has_identity')) fail('anonymous similar path');

const admin = read('app/admin/new-order/page.tsx');
const seller = read('app/seller/new-order/page.tsx');
for (const src of [admin, seller]) {
  if (!src.includes('applyCustomerToConfirmPayload')) fail('forms must attach customer fields');
  if (!src.includes('newOrder.customerNameOptional')) fail('name field');
  if (!src.includes('newOrder.customerPhoneOptional')) fail('optional phone');
  if (!src.includes("orderType !== 'debt' || debtCustomerPhone.trim() !== ''")) fail('debt phone still required');
}
const handle = read('lib/assistant/handleTurn.ts');
if (handle.includes('is_debt ? phones[0]')) fail('AI must keep invoice phone for all orders');
if (!handle.includes('customer_phone: phones[0] || null')) fail('AI draft stores extracted phone');
const tools = read('lib/assistant/tools.ts');
if (/customer_phone|debt_customer_phone|customer_phone_canon/.test(tools)) fail('assistant tools must not select phones');
const idem = read('lib/orderIdempotency.ts');
if (!idem.includes("seller-app:order-idempotency:v3")) fail('store key stays v3');
if (idem.includes('idempotency:v4')) fail('do not bump v4');

const browse = read('components/OrderBrowse.tsx');
if (!browse.includes('customer_name, customer_phone')) fail('browse must select customer columns');
if (!browse.includes('orderCustomerDisplay')) fail('browse display helper');
if (!browse.includes("'id, order_number, created_at, total_sum, status, payment_type, city_id, seller_id, is_preorder, preorder_status, is_debt, debt_status, pickup_date'")) {
  fail('order list select must not require new customer columns');
}

console.log('order-customer checks ok');
