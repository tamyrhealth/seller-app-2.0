import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ORDER_ITEMS_PUBLIC_SELECT } from '../lib/types';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const mig = 'supabase/migrations/20261108220000_order_item_cost_snapshot.sql';
const run = 'supabase/run_order_item_cost_snapshot.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
const sql = read(mig);
const runSql = read(run);
if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration transactional');

if (!sql.includes('ADD COLUMN IF NOT EXISTS cost_price_snapshot numeric(12,2)')) fail('nullable snapshot column');
if (!sql.includes('CHECK (cost_price_snapshot IS NULL OR cost_price_snapshot >= 0)')) fail('snapshot check');
if (/UPDATE\s+public\.order_items/i.test(sql) || /UPDATE\s+order_items\s+SET/i.test(sql)) {
  fail('must not backfill existing order_items');
}
if (/DELETE\s+FROM\s+public\.order_items/i.test(sql)) fail('must not delete order items');

const srcConfirm = read('supabase/migrations/20261108180000_order_customer_fields.sql');
const srcStart = srcConfirm.indexOf('CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)');
const srcEnd = srcConfirm.indexOf('REVOKE ALL ON FUNCTION public.confirm_order(jsonb) FROM PUBLIC;');
const srcFn = srcConfirm.slice(srcStart, srcEnd).replace(/\r\n/g, '\n');
const newStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)');
const newEnd = sql.indexOf('REVOKE ALL ON FUNCTION public.confirm_order(jsonb) FROM PUBLIC;');
const newFn = sql.slice(newStart, newEnd);
if (!srcFn.includes('v_cust_canon') || !newFn.includes('v_cust_canon')) fail('must use production confirm_order with customer fields');
if (srcFn.includes('cost_price_snapshot')) fail('source confirm_order must not already snapshot');
if (!newFn.includes('v_cost numeric')) fail('confirm_order must declare v_cost');
if (!newFn.includes('SELECT name, price_retail, cost_price INTO v_product_name, v_price, v_cost')) {
  fail('confirm_order must read catalog cost at insert');
}
if (!newFn.includes('INSERT INTO order_items (order_id, product_id, product_name_snapshot, price, qty, line_sum, is_gift, cost_price_snapshot)')) {
  fail('insert must include snapshot column');
}
if (!newFn.includes('md5(v_fp_obj::text)')) fail('fingerprint hashing kept');
const fpSlice = newFn.slice(newFn.indexOf('v_fp_obj := jsonb_build_object'), newFn.indexOf('v_fp := md5'));
if (!fpSlice.includes("'product_id'") || !fpSlice.includes("'qty'") || !fpSlice.includes("'price'") || !fpSlice.includes("'is_gift'")) {
  fail('fingerprint item keys kept');
}
if (fpSlice.includes('cost_price') || fpSlice.includes('snapshot')) fail('fingerprint payload must omit cost');
if (!newFn.includes('pg_advisory_xact_lock')) fail('advisory lock kept');
if (!newFn.includes('Insufficient stock for product')) fail('stock check kept');
if (!newFn.includes('Idempotency key reused with a different order payload')) fail('idempotency conflict kept');
if (!newFn.includes('Product is not available')) fail('inactive product kept');
if (!newFn.includes('IF NOT v_is_preorder THEN')) fail('preorder still skips stock at confirm');
if (!newFn.includes('Phone required for debt orders')) fail('debt phone kept');
if (!newFn.includes('WHEN unique_violation THEN')) fail('unique_violation handler kept');
if (!newFn.includes("SET qty_on_hand = qty_on_hand - v_need")) fail('inventory deduction kept');
if (newFn.includes('UPDATE order_items') || newFn.includes('UPDATE public.order_items')) fail('idempotent retry must not rewrite items');
if (!newFn.includes('v_is_gift THEN') || !newFn.includes('v_price := 0')) fail('gift price 0 kept');
if (!newFn.includes('v_cost')) fail('gift/debt/preorder rows still write v_cost');

if (!sql.includes('REVOKE ALL ON TABLE public.order_items FROM PUBLIC')) fail('revoke public table');
if (!sql.includes('REVOKE ALL ON TABLE public.order_items FROM anon')) fail('revoke anon table');
if (!sql.includes('REVOKE ALL ON TABLE public.order_items FROM authenticated')) fail('revoke authenticated table');
if (!sql.includes("AND c.column_name IS DISTINCT FROM 'cost_price_snapshot'")) fail('grants omit snapshot');
if (!sql.includes("GRANT SELECT (%s) ON TABLE public.order_items TO authenticated")) fail('keep public column select');
if (!sql.includes("GRANT INSERT (%s) ON TABLE public.order_items TO authenticated")) fail('keep public column insert');
if (!sql.includes("GRANT UPDATE (%s) ON TABLE public.order_items TO authenticated")) fail('keep public column update');
if (!sql.includes("GRANT DELETE ON TABLE public.order_items TO authenticated")) fail('keep delete for existing admin policy');
if (/GRANT SELECT ON TABLE public\.order_items TO authenticated/i.test(sql)) {
  fail('must not restore table-level SELECT');
}

if (!sql.includes('CREATE OR REPLACE FUNCTION public.admin_order_item_cost_snapshots(p_ids uuid[])')) {
  fail('admin snapshot rpc');
}
if (!sql.includes('SECURITY DEFINER')) fail('rpc security definer');
if (!sql.includes('SET search_path = public')) fail('search_path');
if (!sql.includes('SET row_security = off')) fail('rpc row_security off');
if (!sql.includes('Only admin can read product cost')) fail('non-admin denial');
if (!sql.includes('Account is inactive')) fail('inactive admin denial');
if (!sql.includes('Not authenticated')) fail('anon/null uid denial');
if (!sql.includes('cardinality(p_ids) = 0')) fail('empty array');
if (!sql.includes('cardinality(p_ids) > 20000')) fail('id cap');
if (!sql.includes('REVOKE ALL ON FUNCTION public.admin_order_item_cost_snapshots(uuid[]) FROM PUBLIC, anon')) {
  fail('rpc revoke anon');
}
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.admin_order_item_cost_snapshots(uuid[]) TO authenticated, service_role')) {
  fail('rpc execute authenticated');
}

const history = read('supabase/migrations/20261107200000_action_logs_protect_and_order_history.sql');
if (/\bcost_price\b/.test(history)) fail('order history snapshot must not include cost');
if (sql.includes('order_history_item_snapshot')) fail('must not rewrite order history in this stage');

if (ORDER_ITEMS_PUBLIC_SELECT.includes('cost_price')) fail('public select must omit cost');
const required = ['id', 'product_id', 'product_name_snapshot', 'qty', 'price', 'line_sum', 'is_gift'];
for (const col of required) {
  if (!ORDER_ITEMS_PUBLIC_SELECT.split(',').map((s) => s.trim()).includes(col)) {
    fail(`public select missing ${col}`);
  }
}

const appFiles = [
  'app/admin/orders/page.tsx',
  'app/seller/debts/page.tsx',
  'app/seller/preorders/page.tsx',
];
for (const rel of appFiles) {
  const page = read(rel);
  if (page.includes('order_items(*)')) fail(`${rel} still uses order_items(*)`);
  if (!page.includes('ORDER_ITEMS_PUBLIC_SELECT')) fail(`${rel} must use public item select`);
}

const types = read('lib/types.ts');
if (!types.includes('export const ORDER_ITEMS_PUBLIC_SELECT')) fail('types public select');

const noSnapshotClient = [
  'lib/fetchAdminStatsOrders.ts',
  'lib/adminCustomers.ts',
  'components/OrderBrowse.tsx',
  'app/seller/orders/SellerOrdersClient.tsx',
  'lib/assistant/resolveCancel.ts',
  'app/seller/debts/page.tsx',
  'app/seller/preorders/page.tsx',
];
for (const rel of noSnapshotClient) {
  const txt = read(rel);
  if (txt.includes('cost_price_snapshot')) fail(`${rel} must not read snapshot column`);
  if (txt.includes('admin_order_item_cost_snapshots')) fail(`${rel} must not call snapshot rpc`);
  if (txt.includes('order_items(*)')) fail(`${rel} still uses order_items(*)`);
}

if (read('lib/accounting.ts').includes('cost_price')) fail('accounting must stay revenue-only');
if (!read('lib/adminFinance.ts').includes('FINANCE_ORDER_SELECT')) fail('finance select constant');
if (read('lib/adminFinance.ts').includes('order_items(') && /order_items\([^)]*cost_price_snapshot/.test(read('lib/adminFinance.ts'))) {
  fail('finance nested select must omit snapshot');
}
if (!read('lib/adminFinance.ts').includes("order_items(id, product_id")) fail('finance items need id for rpc');
if (!read('lib/fetchAdminStatsOrders.ts').includes("order_items(id, product_id")) fail('stats items need id for rpc');
if (!read('lib/adminFinanceSnapshots.ts').includes('admin_order_item_cost_snapshots')) fail('snapshot loader rpc');
if (!read('app/admin/finance/page.tsx').includes('FINANCE_ITEM_SNAPSHOTS_RPC')) fail('finance page must load snapshots');
if (!read('app/admin/abc/page.tsx').includes('FINANCE_ITEM_SNAPSHOTS_RPC')) fail('abc page must load snapshots');
if (!read('lib/fetchAdminStatsOrders.ts').includes('ORDER_STATS_MAX = 20000')) fail('keep ORDER_STATS_MAX');
if (!read('lib/adminFinanceSnapshots.ts').includes('FINANCE_SNAPSHOT_BATCH = 20000')) fail('rpc batch 20000');
if (read('app/seller/orders/SellerOrdersClient.tsx').includes('adminFinanceSnapshots')) fail('seller must not load snapshots');
if (read('app/admin/orders/page.tsx').includes('admin_order_item_cost_snapshots')) fail('orders browse must not load snapshots');

console.log('order-cost-snapshot checks ok');
