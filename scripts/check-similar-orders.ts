import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildSimilarItemBag,
  formatSimilarLookupError,
  normalizeCustomerPhone,
  parseSimilarOrdersResult,
  similarCompositionKey,
  similarMatchIds,
  similarMatchesAcknowledged,
  similarOrderOpenHref,
} from '../lib/similarOrders';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const bagLeft = buildSimilarItemBag([
  { product_id: b, qty: 2 },
  { product_id: a, qty: 1, is_gift: true },
  { product_id: a, qty: 1, is_gift: true },
]);
const bagRight = buildSimilarItemBag([
  { product_id: a, qty: 2, is_gift: true },
  { product_id: b, qty: 2 },
]);
if (JSON.stringify(bagLeft) !== JSON.stringify(bagRight)) fail('item bag must ignore line order and merge qty');
if (bagLeft[0].product_id !== a || bagLeft[0].is_gift !== true || bagLeft[0].qty !== 2) fail('gifts stay separate from paid qty');

const keySame = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '+7 (700) 111-22-33',
  items: [
    { product_id: b, qty: 1 },
    { product_id: a, qty: 1 },
  ],
});
const keyPermuted = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '77001112233',
  items: [
    { product_id: a, qty: 1 },
    { product_id: b, qty: 1 },
  ],
});
if (keySame !== keyPermuted) fail('composition key order-independent');

const keyOtherPhone = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '77009998877',
  items: [
    { product_id: a, qty: 1 },
    { product_id: b, qty: 1 },
  ],
});
if (keySame === keyOtherPhone) fail('different reliable phones must not share composition');

const keyAnon = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '123',
  items: [
    { product_id: a, qty: 1 },
    { product_id: b, qty: 1 },
  ],
});
const keyBlank = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: null,
  items: [
    { product_id: a, qty: 1 },
    { product_id: b, qty: 1 },
  ],
});
if (keyAnon !== keyBlank) fail('weak/short phone is not an identity');
if (normalizeCustomerPhone('77001112233') !== '+77001112233') fail('phone canon');
if (normalizeCustomerPhone('87771234567') !== normalizeCustomerPhone('+77771234567')) fail('8 and +7 same similar identity');
if (normalizeCustomerPhone('123') !== null) fail('invalid phone is not an identity');

const key8 = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '87771234567',
  items: [{ product_id: a, qty: 1 }],
});
const keyPlus = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '+77771234567',
  items: [{ product_id: a, qty: 1 }],
});
const key10 = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '7771234567',
  items: [{ product_id: a, qty: 1 }],
});
if (key8 !== keyPlus || keyPlus !== key10) fail('valid phone formats must share composition');
const keyInvalid = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: '12345',
  items: [{ product_id: a, qty: 1 }],
});
const keyNone = similarCompositionKey({
  sellerId: 's1',
  cityId: 'c1',
  customerPhone: null,
  items: [{ product_id: a, qty: 1 }],
});
if (keyInvalid !== keyNone) fail('invalid phone must stay anonymous, not a person');
if (key8 === keyNone) fail('valid phone must not collapse into anonymous');
if (normalizeCustomerPhone('12345') !== null) fail('short phone is not reliable');

const m1 = { order_id: a, order_number: 'N1', created_at: null, status: 'confirmed' };
const m2 = { order_id: b, order_number: 'N2', created_at: null, status: 'confirmed' };
const composition = 'cart-v1';
if (similarMatchesAcknowledged(null, composition, [m1])) fail('no ack must not proceed');
if (
  similarMatchesAcknowledged({ composition: 'old', matchIds: similarMatchIds([m1]) }, composition, [m1])
) {
  fail('stale cart ack must not proceed');
}
if (!similarMatchesAcknowledged({ composition, matchIds: similarMatchIds([m1, m2]) }, composition, [m2, m1])) {
  fail('acked ids should allow continue');
}
if (similarMatchesAcknowledged({ composition, matchIds: similarMatchIds([m1]) }, composition, [m1, m2])) {
  fail('new similar order after ack must warn again');
}

const parsed = parseSimilarOrdersResult({
  checked_at: 't',
  window_seconds: 900,
  identity_kind: 'phone',
  matches: [{ order_id: a, order_number: '12' }, { order_id: 'bad' }],
});
if (parsed.matches.length !== 1 || parsed.matches[0].order_number !== '12') fail('parse similar result');
if (!formatSimilarLookupError('Could not find the function public.find_similar_orders').includes('5.4.1')) {
  fail('missing SQL must be explicit');
}
if (formatSimilarLookupError('network down') !== 'Проверка похожих заказов не удалась: network down') {
  fail('network errors must surface');
}
if (similarOrderOpenHref('seller', a) !== `/seller/orders?id=${a}`) fail('seller open href');
if (similarOrderOpenHref('manager', a) !== `/manager/orders?id=${a}`) fail('manager open href');

const sql = read('supabase/migrations/20261107120000_find_similar_orders.sql');
const runSql = read('supabase/run_find_similar_orders.sql');
if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/(INSERT|UPDATE|DELETE).{0,80}action_logs/i.test(sql)) fail('must not write action_logs');
if (/CREATE\s+UNIQUE\s+INDEX/i.test(sql) || /UNIQUE\s*\(/i.test(sql)) fail('must not unique-lock composition');
if (!sql.includes('auth.uid()')) fail('RPC auth.uid');
if (!sql.includes('Account is inactive')) fail('inactive guard');
if (!sql.includes('Similar-order lookup permission denied')) fail('seller lock');
if (!sql.includes("interval '15 minutes'")) fail('15 minute window');
if (!sql.includes('canceled') || !sql.includes('cancelled')) fail('exclude canceled');
if (!sql.includes('debt_customer_phone')) fail('phone identity');
if (!sql.includes('is_gift')) fail('gift in bag');
if (!sql.includes('exclude_idempotency_key')) fail('exclude current attempt');
if (!sql.includes('REVOKE ALL ON FUNCTION public.find_similar_orders(jsonb) FROM PUBLIC, anon, service_role')) {
  fail('revoke service_role execute');
}
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.find_similar_orders(jsonb) TO authenticated')) {
  fail('grant authenticated');
}
if (/GRANT EXECUTE ON FUNCTION public\.find_similar_orders\(jsonb\) TO[^\n]*service_role/i.test(sql)) {
  fail('must not grant service_role');
}
if (sql.includes('INSERT INTO') || sql.includes('DELETE FROM')) fail('lookup must be read-only');
if (!sql.includes('SET row_security = off')) fail('definer RLS explicit');

const pre = read('supabase/prod/pre_apply_inspect_block541.sql');
const post = read('supabase/prod/post_apply_verify_block541.sql');
const apply = read('supabase/prod/apply_block541.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight must be SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify must be SELECT-only');
if (!pre.includes('find_similar_orders_absent_before_apply')) fail('preflight absent RPC');
if (!post.includes('find_similar_orders.service_role_execute')) fail('verify service_role execute');
if (!post.includes('find_similar_orders.search_path')) fail('verify search_path');
if (!post.includes('find_similar_orders.row_security_off')) fail('verify row_security off');
if (!post.includes('proconfig')) fail('verify must read pg_proc.proconfig for GUCs');
if (post.includes("def LIKE '%SET search_path = public%'")) {
  fail('postflight must not match CREATE equals-syntax in pg_get_functiondef');
}
if (!apply.includes('Повторный запуск')) fail('re-apply safety documented');
if (!post.includes('find_similar_orders.no_writes')) fail('verify no writes');
if (!apply.includes('backup_main.ps1')) fail('apply plan backup');
if (!apply.includes('pre_apply_inspect_block541.sql')) fail('apply plan preflight');

const seller = read('app/seller/new-order/page.tsx');
const admin = read('app/admin/new-order/page.tsx');
const card = read('components/AssistantOrderDraftCard.tsx');
const ui = read('components/AssistantChats.tsx');
const confirm = read('app/api/assistant/orders/confirm/route.ts');
const warn = read('components/SimilarOrdersWarning.tsx');
const browse = read('components/OrderBrowse.tsx');

for (const src of [seller, admin]) {
  const similarAt = src.indexOf('lookupSimilarOrders');
  const confirmAt = src.indexOf("rpc('confirm_order'");
  if (similarAt < 0 || confirmAt < 0 || similarAt > confirmAt) fail('forms must lookup similar before confirm_order');
  if (src.includes('getOrCreateOrderIdempotencyKey')) fail('warning must not mint a new idempotency key');
  if (!src.includes('peekOrderIdempotencyKey')) fail('forms must exclude an existing idempotency key only');
  if (!src.includes('Это другой заказ — продолжить') && !src.includes('SimilarOrdersWarning')) {
    fail('forms must show similar warning');
  }
  if (!src.includes('submitGate')) fail('double-click gate');
}
if (!warn.includes('Это другой заказ — продолжить')) fail('explicit continue');
if (!warn.includes('Открыть существующий')) fail('open existing');
if (!card.includes('lookupSimilarOrders')) fail('AI card lookup');
if (!card.includes('acknowledgedComposition')) fail('AI card continue binds composition');
if (!card.includes('[draftComposition]')) fail('AI card must reset ack when draft composition changes');
if (!card.includes('Это другой заказ — продолжить') && !card.includes('SimilarOrdersWarning')) fail('AI warning UI');
if (!ui.includes('acknowledged_similar_ids')) fail('AI confirm sends ack ids');
if (!ui.includes('acknowledged_similar_composition')) fail('AI confirm sends composition ack');
if (!ui.includes("code === 'similar_orders'")) fail('AI must show similar 409');
if (!ui.includes('Сеть недоступна')) fail('AI network error');
if (!confirm.includes("rpc('find_similar_orders'")) fail('AI route must call find_similar_orders');
if (!confirm.includes('createUserClient')) fail('AI similar lookup as user JWT');
if (confirm.includes('service.rpc(\'find_similar_orders\'') || confirm.includes('service.rpc("find_similar_orders"')) {
  fail('service_role must not call find_similar_orders');
}
if (!confirm.includes("code: 'similar_orders'")) fail('AI 409 similar');
if (!confirm.includes('fail_assistant_order_confirm')) fail('unlock draft after similar warn');
if (!confirm.includes('acknowledged_similar_composition')) fail('server must bind continue to composition');
if (!confirm.includes('similarCompositionKey')) fail('server must recompute live composition');
const revalidateBlock = confirm.slice(confirm.indexOf('revalidateResolved'), confirm.indexOf("rpc('find_similar_orders'"));
if (!revalidateBlock.includes('fail_assistant_order_confirm')) fail('revalidate error must leave confirming');
if (!confirm.includes('SIMILAR_SQL_HINT') && !confirm.includes('5.4.1')) fail('AI missing SQL explicit');
const confirmOrderAt = confirm.indexOf("rpc('confirm_order'");
const similarRpcAt = confirm.indexOf("rpc('find_similar_orders'");
if (similarRpcAt < 0 || confirmOrderAt < 0 || similarRpcAt > confirmOrderAt) {
  fail('AI must check similar before confirm_order');
}
if (!browse.includes("p.get('id')") && !browse.includes("params.get('id')")) fail('staff list must open ?id=');
if (!seller.includes('role="seller"')) fail('seller open-existing role');

const confirmSqlLatest = read('supabase/migrations/20261104010000_confirm_order_reject_inactive_products.sql');
if (!confirmSqlLatest.includes('CREATE OR REPLACE FUNCTION public.confirm_order')) fail('5.2.6/confirm sql still present');

console.log('similar-orders checks ok');
