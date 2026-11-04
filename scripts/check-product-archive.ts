import { readFileSync } from 'fs';
import { join } from 'path';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const page = read('app/admin/products/page.tsx');
const adminOrder = read('app/admin/new-order/page.tsx');
const sellerOrder = read('app/seller/new-order/page.tsx');
const catalog = read('app/api/assistant/orders/catalog/route.ts');
const resolve = read('lib/assistant/resolveOrder.ts');
const tools = read('lib/assistant/tools.ts');
const sql = read('supabase/migrations/20261104010000_confirm_order_reject_inactive_products.sql');
const runSql = read('supabase/run_confirm_order_reject_inactive_products.sql');
const verify = read('supabase/prod/post_apply_verify_block_confirm_inactive_products.sql');
const rls = read('supabase.sql');

if (page.includes('.delete()') || page.includes("from('products').delete")) {
  fail('admin products must not physically delete');
}
if (page.includes('Удалить')) fail('delete button must be replaced');
if (!page.includes('Скрыть')) fail('hide button');
if (!page.includes('Восстановить')) fail('restore button');
if (!page.includes('Показать архив')) fail('show archive toggle');
if (!page.includes('update({ is_active: false })')) fail('hide sets is_active false');
if (!page.includes('update({ is_active: true })')) fail('restore sets is_active true');
if (!page.includes('История заказов, остатки и движения склада сохранятся')) {
  fail('hide confirmation must explain history is kept');
}
if (!page.includes("role=\"admin\"")) fail('products page must stay admin-only');

if (!adminOrder.includes('p.is_active') || !sellerOrder.includes('p.is_active')) {
  fail('new-order UI must filter inactive products');
}
if (!adminOrder.includes('prod.is_active') || !sellerOrder.includes('prod.is_active')) {
  fail('new-order inventory join must skip inactive products');
}
if (!catalog.includes(".eq('is_active', true)")) fail('assistant catalog must be active-only');
if (!resolve.includes('is_active') || !resolve.includes("eq('is_active', true)")) {
  fail('invoice resolve must use active catalog');
}
if (!resolve.includes('product.is_active === false')) fail('confirm revalidate must reject inactive products');
if (!tools.includes(".eq('is_active', true)")) fail('assistant stock tool must skip hidden products');

if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('inactive-product SQL must be transactional');
if (!sql.includes('Product is not available')) fail('confirm_order must reject inactive products');
if (!sql.includes('FROM public.products p') || !sql.includes('WHERE p.id = v_pid')) {
  fail('inactive check must lock product rows');
}
if (!sql.includes('FOR UPDATE')) fail('must keep row locks');
const idxReturn = sql.indexOf('RETURN v_order_id');
const idxInactive = sql.indexOf('Product is not available');
const idxStock = sql.indexOf('Insufficient stock for product');
if (!(idxReturn > 0 && idxReturn < idxInactive && idxInactive < idxStock)) {
  fail('inactive check must run after idempotent return and before stock decrement');
}
if (!sql.includes('orders_idempotency_actor_key_uidx')) fail('must keep idempotency conflict handling');
if (!sql.includes('qty_on_hand >= v_need')) fail('must keep stock guard');
if (/DELETE\s+FROM\s+public\.(orders|order_items|inventory|inventory_movements)/i.test(sql)) {
  fail('must not delete history or stock');
}
if (/UPDATE\s+public\.inventory\s+SET\s+qty_on_hand\s*=\s*0/i.test(sql)) fail('must not zero inventory');
if (!runSql.includes('Product is not available')) fail('run SQL missing inactive guard');
const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) {
  fail('post_apply verify must be SELECT-only');
}

if (!rls.includes('products_all_admin')) fail('products writes must stay admin RLS');
if (!rls.includes("USING (get_user_role() = 'admin')")) fail('admin role gate on products');

console.log('OK');
