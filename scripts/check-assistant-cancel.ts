import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCancelIntent } from '../lib/assistant/cancelIntent';
import { actorCanCancel } from '../lib/assistant/resolveCancel';
import { resolveCancelCardState } from '../lib/assistant/cancelCardState';
import { parseOrderNumberQuery } from '../lib/orderNumber';
import { isAssistantRole } from '../lib/roles';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

function expectCancel(text: string, number: string) {
  const intent = parseCancelIntent(text);
  if (!intent?.wantsCancel) fail(`should detect cancel: ${text}`);
  if (intent.canonicalNumber !== number) fail(`${text} => ${intent.canonicalNumber}, expected ${number}`);
}

expectCancel('Отмени заказ N000033', 'N000033');
expectCancel('Отмена N000033', 'N000033');
expectCancel('N000033 заказды болдырма', 'N000033');
expectCancel('Отменить заказ 33', 'N000033');
if (parseCancelIntent('Сколько порошка в Астане?')) fail('stock question is not cancel');
if (parseCancelIntent('не отменяй заказ N000033')) fail('negation is not cancel');
if (parseCancelIntent('2 порошок Айгүл kaspi')) fail('invoice is not cancel');
if (parseCancelIntent('Отмени заказ')?.canonicalNumber) fail('cancel without number has no canonical');

if (parseOrderNumberQuery('33') !== 'N000033') fail('short number 33');

if (actorCanCancel('admin', false).allowed !== true) fail('admin can cancel without flag');
if (actorCanCancel('manager', true).allowed !== true) fail('manager with flag');
if (actorCanCancel('manager', false).allowed) fail('manager without flag cannot');
if (actorCanCancel('seller', true).allowed) fail('seller cannot cancel via assistant actor helper');
if (isAssistantRole('seller')) fail('seller is not assistant');

const sql = read('supabase/migrations/20261104210000_apply_order_cancel_manager.sql');
const runSql = read('supabase/run_apply_order_cancel_manager.sql');
const verify = read('supabase/prod/post_apply_verify_block523.sql');
const inspect = read('supabase/prod/pre_apply_inspect_block523.sql');
const handle = read('lib/assistant/handleTurn.ts');
const chat = read('app/api/assistant/chat/route.ts');
const voidRoute = read('app/api/assistant/orders/void/route.ts');
const confirm = read('app/api/assistant/orders/confirm/route.ts');
const update = read('app/api/assistant/orders/update/route.ts');
const ui = read('components/AssistantChats.tsx');
const card = read('components/AssistantCancelCard.tsx');
const applyOld = read('supabase/migrations/20261103180000_order_cancel_numbers_history.sql');

if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('5.2.3 SQL must be transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/^\s*DROP FUNCTION/im.test(sql)) fail('must not DROP existing cancel RPCs');
if (/CASCADE/i.test(sql)) fail('must not use CASCADE');
if (!/FUNCTION public\.cancel_order\(p_order_id uuid\)\s+RETURNS void/m.test(sql)) {
  fail('cancel_order must stay RETURNS void');
}
if (!/FUNCTION public\.admin_cancel_order\(p_order_id uuid, p_reason text DEFAULT NULL\)\s+RETURNS void/m.test(sql)) {
  fail('admin_cancel_order must stay RETURNS void');
}
if (!/FUNCTION public\.apply_order_cancel\(p_order_id uuid, p_reason text DEFAULT NULL\)\s+RETURNS void/m.test(sql)) {
  fail('apply_order_cancel must stay RETURNS void');
}
if (!sql.includes('cancel_order_report')) fail('AI jsonb report RPC');
if (!sql.includes('admin_cancel_order_report')) fail('AI admin jsonb report RPC');
if (!sql.includes('apply_order_cancel_report')) fail('internal jsonb implementation');
if (!sql.includes('can_cancel_orders')) fail('SQL must enforce can_cancel_orders');
if (!sql.includes('Cancel permission denied')) fail('manager denied without flag');
if (!sql.includes('already_canceled')) fail('idempotent already canceled');
if (!sql.includes('FOR UPDATE')) fail('must lock order');
if (!sql.includes("type, qty_delta, order_id, created_by")) fail('must write inventory_movements');
if (!sql.includes("'cancel_sale'")) fail('cancel_sale movement');
if (!sql.includes('returned_stock')) fail('audit returned_stock');
if (!sql.includes("'items'")) fail('audit returned items');
if (!sql.includes("GRANT ALL ON FUNCTION public.cancel_order(uuid) TO authenticated")) fail('auth grant cancel_order');
if (!sql.includes('REVOKE ALL ON FUNCTION public.apply_order_cancel')) fail('apply_order_cancel not for users');
if (!sql.includes('REVOKE ALL ON FUNCTION public.cancel_order(uuid) FROM PUBLIC, anon, service_role')) {
  fail('cancel_order must revoke anon and service_role');
}
if (sql.includes("GRANT ALL ON FUNCTION public.cancel_order(uuid) TO service_role") || sql.includes("GRANT EXECUTE ON FUNCTION public.cancel_order(uuid) TO service_role")) {
  fail('do not grant service_role on cancel_order');
}
if (!sql.includes("'already_canceled', true")) fail('must log already_canceled replay');
if (!sql.includes('Cannot cancel order after 10 minutes')) fail('seller 10 minutes');
if (!sql.includes('v_order.seller_id = v_uid')) fail('seller own-order only');
if (!runSql.includes('can_cancel_orders')) fail('run SQL missing manager flag');
const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) fail('post verify must be SELECT-only');
if (/INSERT|UPDATE|DELETE/i.test(inspect.replace(/--.*$/gm, ''))) fail('pre inspect must be read-only');
if (!inspect.includes('pg_depend')) fail('pre inspect must list function dependencies');
if (!inspect.includes('pg_get_function_result')) fail('pre inspect must show result types');

if (!applyOld.includes('FOR UPDATE')) fail('existing cancel already locks');
if (!applyOld.includes('v_should_return')) fail('existing cancel already gates stock return');

if (!handle.includes('parseCancelIntent')) fail('turn must detect cancel before invoice');
const turnBody = handle.slice(handle.indexOf('export async function generateAssistantTurn'));
if (turnBody.indexOf('parseCancelIntent') > turnBody.indexOf('looksLikeInvoice')) fail('cancel must run before invoice');
if (!handle.includes('resolveCancelPreview')) fail('server-side cancel preview');
if (handle.includes("rpc('cancel_order'") || handle.includes('admin_cancel_order')) {
  fail('prepare path must not cancel');
}

if (!chat.includes('parseCancelIntent')) fail('chat may skip OpenAI for cancel');
if (!chat.includes('kind: \'cancel_preview\'')) fail('persist cancel card metadata');
if (!chat.includes('can_cancel_orders')) fail('chat loads cancel flag');

if (!voidRoute.includes('createUserClient')) fail('void must use user JWT');
if (!voidRoute.includes("rpcName = profile.role === 'admin' ? 'admin_cancel_order_report' : 'cancel_order_report'")) {
  fail('void must call jsonb report RPCs as the user');
}
if (voidRoute.includes('createServiceClient().rpc') || /service\.rpc\(['\"]cancel_order/.test(voidRoute)) {
  fail('service_role must not cancel orders');
}
if (!voidRoute.includes('isAssistantRole')) fail('void role check');
if (!voidRoute.includes('actorCanCancel')) fail('void checks can_cancel_orders before RPC');
if (!voidRoute.includes('Остатки возвращены')) fail('success copy when stock returned');
if (!voidRoute.includes('повторно не начислялись')) fail('repeat copy');

if (update.includes("rpc('cancel_order'") || update.includes('admin_cancel_order')) fail('draft update must not cancel live orders');
if (!confirm.includes("rpc('confirm_order'")) fail('confirm_order still used for create');
if (confirm.includes('admin_cancel_order') || confirm.includes("rpc('cancel_order'")) fail('confirm path must not cancel');

if (!ui.includes('AssistantCancelCard')) fail('cancel card in chats');
if (!ui.includes('/api/assistant/orders/void')) fail('UI confirms via void route');
if (!ui.includes('assistant-live-cancel')) fail('exclusive cancel click');
if (!ui.includes('messageId')) fail('void must receive preview message id');
if (!ui.includes("action: 'dismiss'")) fail('dismiss must persist via API');
if (!ui.includes('resolveCancelCardState')) fail('cards must use stored + live cancel state');
if (!ui.includes("source === 'assistant_cancel'")) fail('follow-up cancel messages must lock old cards');
if (!ui.includes("payload.ok !== true")) fail('network/partial responses must not lock the card');
if (ui.includes('function dismissCancelCard') && ui.includes("state: 'dismissed'") && !ui.includes("action: 'dismiss'")) {
  fail('dismiss must not be local-only');
}
if (!card.includes('Подтвердить отмену')) fail('confirm cancel button');
if (!card.includes('Оставить заказ')) fail('leave order button');
if (!card.includes('stock_note')) fail('stock consequence on card');
if (!card.includes('Заказ отменён')) fail('compact canceled status');
if (!card.includes('Отмена отклонена. Заказ оставлен без изменений')) fail('dismissed copy');
if (!voidRoute.includes("action === 'dismiss'")) fail('void persists dismiss without RPC');
if (!voidRoute.includes('persistCancelCardState')) fail('void must persist preview card state');
if (!voidRoute.includes("state: 'confirmed'")) fail('successful cancel must persist confirmed');
if (resolveCancelCardState({ storedState: 'preview', preview: { can_cancel: true, status: 'confirmed', errors: [] } as never }) !== 'preview') {
  fail('open preview stays actionable');
}
if (resolveCancelCardState({ storedState: 'preview', liveStatus: 'canceled', preview: { can_cancel: true, status: 'confirmed', errors: [] } as never }) !== 'confirmed') {
  fail('live canceled order must lock old cards');
}
if (resolveCancelCardState({ storedState: 'preview', preview: { can_cancel: true, status: 'confirmed', errors: [{ code: 'already_canceled', message: 'x' }] } as never }) !== 'confirmed') {
  fail('already_canceled preview must lock buttons');
}
if (resolveCancelCardState({ storedState: 'dismissed', preview: { can_cancel: true, status: 'confirmed', errors: [] } as never }) !== 'dismissed') {
  fail('dismissed stays dismissed when order is still live');
}

console.log('OK');
