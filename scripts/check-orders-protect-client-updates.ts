import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const mig = read('supabase/migrations/20261111090000_orders_protect_client_updates.sql');
const run = read('supabase/run_orders_protect_client_updates.sql');
const inspect = read('supabase/prod/inspect_block5201_orders_readonly.sql');
const pre = read('supabase/prod/pre_apply_inspect_block5201.sql');
const post = read('supabase/prod/post_apply_verify_block5201.sql');
const rollback = read('supabase/prod/rollback_block5201.sql');
const apply = read('supabase/prod/apply_block5201.md');
const debts = read('app/seller/debts/page.tsx');
const adminOrders = read('app/admin/orders/page.tsx');
const enforce = read('supabase/migrations/20261110220000_assert_active_auth_session_enforce.sql');

if (mig !== run) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(mig) || !/^COMMIT;/m.test(mig)) fail('migration must be transactional');
if (!/^BEGIN;/m.test(rollback) || !/^COMMIT;/m.test(rollback)) fail('rollback must be transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(mig)) fail('must not rewrite confirm_order');
if (/CREATE OR REPLACE FUNCTION public\.mark_debt_paid/i.test(mig)) fail('must not rewrite mark_debt_paid');
if (/\b(PERFORM|SELECT|CALL)\s+public\.auth_session_guard_apply\s*\(/i.test(mig)) {
  fail('must not re-apply session phase 2');
}
if (!mig.includes('orders_block_client_write')) fail('block function');
if (!mig.includes('zz_orders_block_client_write')) fail('orders write trigger');
if (!mig.includes('zz_order_items_block_client_write')) fail('order_items write trigger');
if (!mig.includes('WITH CHECK (false)')) fail('RLS insert/update must deny JWT');
if (!mig.includes('REVOKE ALL ON TABLE public.orders FROM anon')) fail('revoke anon orders');
if (!mig.includes('REVOKE ALL ON TABLE public.orders FROM authenticated')) fail('revoke authenticated orders');
if (!mig.includes('REVOKE ALL ON TABLE public.order_items FROM authenticated')) fail('revoke order_items writes');
if (!mig.includes('GRANT SELECT ON TABLE public.orders TO authenticated')) fail('keep orders select');
if (mig.includes('GRANT SELECT ON TABLE public.order_items TO authenticated')) {
  fail('order_items must not table-level SELECT (cost_price_snapshot leak)');
}
if (!mig.includes('cost_price_snapshot')) fail('order_items grants must omit cost_price_snapshot');
if (/GRANT UPDATE/i.test(mig) && /ON TABLE public\.orders/i.test(mig)) fail('must not grant table UPDATE on orders');
if (!mig.includes('complete_seller_debt_pay')) fail('debt pay RPC');
if (!mig.includes('PERFORM public.assert_active_auth_session()')) fail('new RPC must assert session');
if (!mig.includes('PERFORM public.mark_debt_paid')) fail('debt pay must call mark_debt_paid');
if (!mig.includes('Debt is already paid')) fail('replay guard');
if (!mig.includes('payment_method must be cash or kaspi')) fail('method guard');
if (!mig.includes('FOR UPDATE')) fail('row lock');
if (!mig.includes('Seller can only mark own debts as paid')) fail('owner check');
if (mig.includes('EXECUTE ') && /EXECUTE\s+'/i.test(mig)) fail('no dynamic SQL');
if (mig.includes("GRANT UPDATE (")) fail('no column UPDATE grants');
if (/GRANT EXECUTE ON FUNCTION public\.complete_seller_debt_pay[\s\S]{0,80}service_role/.test(mig)) {
  fail('new RPC must not grant service_role execute');
}

if (!mig.includes("current_user IN ('postgres', 'supabase_admin', 'service_role')")) {
  fail('DEFINER/service path must skip block trigger');
}

const inspectBare = inspect.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(inspectBare)) fail('inspect must be SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight must be SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('postflight must be SELECT-only');
if (!inspect.includes('has_column_privilege')) fail('inspect column grants');
if (!inspect.includes("table_name = 'orders'")) fail('inspect must list orders columns');
if (!inspect.includes("table_name = 'order_items'")) fail('inspect must list order_items columns');
if (!inspect.includes('assert_active_auth_session')) fail('inspect session wrap');
if (!pre.includes('confirm_order.wrapped')) fail('preflight expects phase 2 wrap');
if (!pre.includes('authenticated.orders.insert_open')) fail('preflight insert grant');
if (pre.includes('authenticated.order_items.insert_open')) fail('preflight must not expect table-level order_items INSERT');
if (!pre.includes('authenticated.order_items.table_insert')) fail('preflight table-level order_items INSERT closed');
if (!pre.includes('authenticated.order_items.qty_insert')) fail('preflight column INSERT still open');
if (!pre.includes('authenticated.order_items.cost_select')) fail('preflight cost_price_snapshot hidden');
if (!pre.includes('mark_debt_paid.body_owner_check')) fail('preflight owner check on session body');
if (!pre.includes('mark_debt_paid.body_authenticated_execute')) fail('preflight body execute');
if (!pre.includes('orders_update.with_check')) fail('preflight orders_update WITH CHECK');
if (!mig.includes('P0 abort: mark_debt_paid body must reject foreign seller debts')) {
  fail('migration must abort if foreign-pay check missing');
}
if (!post.includes('authenticated.orders.status_update')) fail('postflight status lock');
if (!post.includes('authenticated.order_items.insert')) fail('postflight items insert lock');
if (!post.includes('authenticated.order_items.qty_insert')) fail('postflight column insert lock');
if (!post.includes('authenticated.order_items.cost_select')) fail('postflight cost still hidden');
if (!post.includes('debt_pay_rpc.assert')) fail('postflight RPC session assert');
if (!post.includes('debt_pay_rpc.replay_guard')) fail('postflight replay guard');
if (!post.includes('commission.orders_trigger')) fail('postflight commission trigger');
if (!pre.includes('commission.orders_trigger')) fail('preflight commission trigger');
if (!apply.includes('backup_main.ps1')) fail('apply backup');
if (!apply.includes('run_orders_protect_client_updates.sql')) fail('apply run file');
if (!apply.includes('rollback_block5201.sql')) fail('apply rollback command');
if (/psql[\s\S]{0,80}run_assert_active_auth_session_enforce/i.test(apply)) {
  fail('apply must not rerun phase 2');
}
if (!rollback.includes('DROP FUNCTION IF EXISTS public.complete_seller_debt_pay')) fail('rollback drops new RPC');
if (!rollback.includes('WITH CHECK (true)')) fail('rollback restores observed WITH CHECK true');
if (!rollback.includes('GRANT UPDATE ON TABLE public.orders TO anon')) fail('rollback restores observed anon UPDATE');
if (/GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.order_items/.test(rollback)) {
  fail('rollback must not grant table-level INSERT on order_items');
}
if (!rollback.includes('GRANT INSERT (%s)')) fail('rollback restores column INSERT only');

if (debts.includes(".update(")) fail('seller debts must not table-update orders');
if (debts.includes("rpc('mark_debt_paid'")) fail('seller debts must use complete_seller_debt_pay only');
if (!debts.includes("rpc('complete_seller_debt_pay'")) fail('seller debts must call complete_seller_debt_pay');
if (!adminOrders.includes("rpc('mark_debt_paid'")) fail('admin orders keep mark_debt_paid');

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkTs(p, acc);
    else if (/\.(ts|tsx)$/.test(name.name)) acc.push(p);
  }
  return acc;
}

const srcRoots = ['app', 'lib', 'components'].filter((d) => {
  try {
    readdirSync(join(process.cwd(), d));
    return true;
  } catch {
    return false;
  }
});
const writeRe = /\.from\(\s*['"](orders|order_items)['"]\s*\)[\s\S]{0,200}\.(update|insert|upsert|delete)\s*\(/;
for (const root of srcRoots) {
  for (const file of walkTs(join(process.cwd(), root))) {
    const text = readFileSync(file, 'utf8');
    if (writeRe.test(text)) fail(`client write to orders/order_items in ${file}`);
  }
}

if (enforce.includes('auth_session_guard_orders')) fail('do not sneak orders into phase 2 trigger list here');
if (!enforce.includes("'public.mark_debt_paid(uuid, text)'")) fail('session targets still include mark_debt_paid');

const tests = read('scripts/verify_orders_protect_client_updates_tests.sql');
if (!tests.includes('Direct order table writes are not allowed')) fail('sql tests expect block exception');
if (!tests.includes('SET LOCAL ROLE authenticated')) fail('sql tests must impersonate client');
if (!tests.includes('SET status = ')) fail('sql tests must try status bypass');
if (!tests.includes('INSERT INTO public.order_items')) fail('sql tests must try fake order_items');
if (!tests.includes('complete_seller_debt_pay')) fail('sql tests must cover allowed RPC presence');

console.log('OK');
