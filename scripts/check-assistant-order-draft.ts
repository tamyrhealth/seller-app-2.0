import { readFileSync } from 'fs';
import { join } from 'path';
import { expandProductQuery, matchCatalogProducts } from '../lib/assistant/productAliases';
import { detectPayment, extractPhones, looksLikeInvoice } from '../lib/assistant/paymentParse';
import { pricesEqual, qtyValidationError } from '../lib/assistant/qty';
import { stripIdentifiers } from '../lib/assistant/sanitize';
import { isAssistantRole } from '../lib/roles';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const sql = read('supabase/migrations/20261103290000_assistant_order_drafts.sql');
const runSql = read('supabase/run_assistant_order_drafts.sql');
const verify = read('supabase/prod/post_apply_verify_block522.sql');
const routeChat = read('app/api/assistant/chat/route.ts');
const routeConfirm = read('app/api/assistant/orders/confirm/route.ts');
const routeCancel = read('app/api/assistant/orders/cancel/route.ts');
const routeUpdate = read('app/api/assistant/orders/update/route.ts');
const routeCatalog = read('app/api/assistant/orders/catalog/route.ts');
const ui = read('components/AssistantChats.tsx');
const card = read('components/AssistantOrderDraftCard.tsx');
const resolve = read('lib/assistant/resolveOrder.ts');
const summary = read('lib/assistant/draftSummary.ts');
const updateSql = read('supabase/migrations/20261103291000_assistant_order_draft_update.sql');
const updateRun = read('supabase/run_assistant_order_draft_update.sql');
const verifyUpdate = read('supabase/prod/post_apply_verify_block522b.sql');
const tools = read('lib/assistant/tools.ts');
const prompt = read('lib/assistant/prompt.ts');
const runModel = read('lib/assistant/runModel.ts');
const parse = read('lib/assistant/invoiceParse.ts');
const handle = read('lib/assistant/handleTurn.ts');
const confirmOrderSql = read('supabase/migrations/20261103250000_manager_assistant_chats.sql');

if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('5.2.2 migration must be transactional');
if (!sql.includes('assistant_order_drafts')) fail('drafts table');
if (!sql.includes('not_draft_owner')) fail('owner check on confirm/cancel');
if (!sql.includes('chat_owner_mismatch')) fail('save must bind draft to chat owner');
if (!sql.includes('SET row_security = off')) fail('DEFINER RPCs must set row_security off');
if (!sql.includes('begin_assistant_order_confirm')) fail('begin lock RPC');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.begin_assistant_order_confirm')) fail('begin grant');
if (!sql.includes('TO authenticated')) fail('user JWT RPCs');
if (!sql.includes('TO service_role')) fail('service RPCs');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/CREATE OR REPLACE FUNCTION public\.cancel_order/i.test(sql)) fail('must not rewrite cancel_order');
if (/UPDATE\s+public\.inventory/i.test(sql)) fail('drafts SQL must not touch inventory');
if (/INSERT\s+INTO\s+public\.orders/i.test(sql)) fail('drafts SQL must not insert orders');
if (/GRANT EXECUTE ON FUNCTION public\.save_assistant_order_draft[^\n]*authenticated/i.test(sql)) {
  fail('authenticated must not save drafts');
}
if (!sql.includes('REVOKE ALL ON TABLE public.assistant_order_drafts FROM PUBLIC, anon, authenticated')) {
  fail('re-apply must revoke authenticated table writes');
}
if (!runSql.includes('REVOKE ALL ON TABLE public.assistant_order_drafts FROM PUBLIC, anon, authenticated')) {
  fail('run SQL must revoke authenticated table writes on re-apply');
}
if (!sql.includes("owner_id = auth.uid() OR public.is_admin()")) fail('admin can audit drafts, others only own');
if (!runSql.includes('begin_assistant_order_confirm')) fail('run SQL missing begin');
if (!runSql.includes('not_draft_owner')) fail('run SQL missing owner guard');

const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) {
  fail('post_apply_verify_block522.sql must be SELECT-only');
}

if (!parse.includes('json_schema')) fail('structured outputs required');
if (!parse.includes('maskTextForModel') && !parse.includes('stripIdentifiers')) fail('parse must mask before OpenAI');
if (!runModel.includes('stripIdentifiers')) fail('Q&A history must mask phones');
if (!handle.includes('looksLikeInvoice')) fail('invoice heuristic');
if (!read('app/api/assistant/chat/route.ts').includes('findReusableInvoiceDraft')) fail('same-chat invoice reuse');
if (!read('components/AssistantChats.tsx').includes('Это новый заказ')) fail('force-new invoice button');
if (!handle.includes('parseInvoiceStructured')) fail('structured parse on invoice path');
if (!handle.includes('resolveInvoiceDraft')) fail('server-side resolve');
if (!handle.includes('buildDraftChatMessage')) fail('short draft chat message');
if (handle.includes('buildDraftMarkdown')) fail('must not dump draft markdown into chat');
if (handle.includes('confirm_order')) fail('prepare path must not create orders');
if (!summary.includes('Исправьте их в карточке заказа')) fail('short AI remarks message');

if (!routeChat.includes('generateAssistantTurn')) fail('chat route must split Q&A vs draft');
if (!routeChat.includes('save_assistant_order_draft')) fail('draft persist');
if (!routeChat.includes('owner_id !== user.id')) fail('own chat only');
if (routeChat.includes("rpc('confirm_order'")) fail('chat route must not confirm_order');

if (!routeConfirm.includes("rpc('confirm_order'")) fail('confirm route must call confirm_order');
if (!routeConfirm.includes('createUserClient')) fail('confirm_order must run as the user');
if (!routeConfirm.includes('revalidateResolved')) fail('re-check prices/stock');
if (!routeConfirm.includes('recoverCreatedOrder')) fail('timeout retry must recover existing order first');
const confirmPost = routeConfirm.slice(routeConfirm.indexOf('export async function POST'));
if (confirmPost.indexOf('recoverCreatedOrder') < 0 || confirmPost.indexOf('recoverCreatedOrder') > confirmPost.indexOf('revalidateResolved')) {
  fail('must look up existing order before revalidate');
}
if (!routeConfirm.includes("error.code !== '23505'")) fail('duplicate result messages must be ignored');
if (!routeConfirm.includes('idempotency_key')) fail('stable idempotency key');
if (!routeConfirm.includes('pending')) fail('timeout must not declare failure');
if (!routeConfirm.includes('not_draft_owner') && !routeConfirm.includes('чужой черновик')) {
  fail('foreign draft forbidden');
}
if (routeConfirm.includes('service.rpc(\'confirm_order\'') || routeConfirm.includes('service.rpc("confirm_order"')) {
  fail('service_role must not call confirm_order');
}
if (/payload\.seller_id\s*=\s*body/i.test(routeConfirm)) fail('client must not set seller_id');
if (!routeConfirm.includes('body.draftId') && !routeConfirm.includes("body.draftId")) {
  fail('confirm body is draftId');
}

if (!routeCancel.includes('cancel_assistant_order_draft')) fail('cancel RPC');
if (routeCancel.includes('confirm_order')) fail('cancel must not create orders');

if (!routeUpdate.includes('applyDraftEdit')) fail('update must rebuild on server');
if (!routeUpdate.includes('update_assistant_order_draft_content')) fail('update RPC');
if (routeUpdate.includes("rpc('confirm_order'")) fail('update must not confirm_order');
if (routeUpdate.includes('idempotency_key')) fail('update must not rotate idempotency_key');
if (!routeUpdate.includes('чужой черновик')) fail('update owner guard');
if (!routeUpdate.includes('draft_not_editable')) fail('update locked-status guard');
if (!routeCatalog.includes("eq('role', 'seller')")) fail('catalog sellers only');
if (!resolve.includes('export async function applyDraftEdit')) fail('applyDraftEdit');
const invoiceResolve = read('lib/assistant/invoiceResolve.ts');
if (!invoiceResolve.includes('total_ready') && !resolve.includes('total_ready')) fail('preview total_ready');
if (!resolve.includes('price_retail')) fail('live retail prices');

if (!/^BEGIN;/m.test(updateSql) || !/^COMMIT;/m.test(updateSql)) fail('5.2.2b migration must be transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(updateSql)) fail('update SQL must not rewrite confirm_order');
if (/UPDATE\s+public\.inventory/i.test(updateSql)) fail('update SQL must not touch inventory');
if (/INSERT\s+INTO\s+public\.orders/i.test(updateSql)) fail('update SQL must not insert orders');
if (!updateSql.includes('not_draft_owner')) fail('update SQL owner');
if (!updateSql.includes('draft_not_editable')) fail('update SQL status lock');
const updateFnBody = updateSql.slice(updateSql.indexOf('AS $$'), updateSql.lastIndexOf('$$'));
if (updateFnBody.includes('idempotency_key')) fail('update SQL must not write idempotency_key');
if (!updateSql.includes('GRANT EXECUTE ON FUNCTION public.update_assistant_order_draft_content')) fail('update grant');
if (/GRANT EXECUTE ON FUNCTION public\.update_assistant_order_draft_content[^\n]*authenticated/i.test(updateSql)) {
  fail('authenticated must not update drafts via SQL grant');
}
if (!updateRun.includes('update_assistant_order_draft_content')) fail('run SQL missing update rpc');
const verifyUpdateBare = verifyUpdate.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyUpdateBare)) {
  fail('post_apply_verify_block522b.sql must be SELECT-only');
}

if (!ui.includes('/api/assistant/orders/')) fail('UI confirm endpoint');
if (!ui.includes('AssistantOrderDraftCard')) fail('preview card');
if (!ui.includes("first !== 'pending'")) fail('UI must retry pending confirm once');
if (ui.includes("role: 'assistant'")) fail('UI must not insert assistant messages');
if (!card.includes('Подтвердить заказ')) fail('confirm button');
if (!card.includes('Исправить')) fail('fix button');
if (!card.includes('Закрыть без сохранения')) fail('discard edits without DB write');
if (!card.includes('Отмена')) fail('cancel button');
if (!card.includes('Сохранить изменения')) fail('save edits button');
if (!card.includes('Цена не определена')) fail('undefined price label');
if (!card.includes('Итого: не рассчитано')) fail('incomplete total label');
if (!card.includes("window.confirm")) fail('cancel confirmation');
if (!card.includes('/api/assistant/orders/update')) fail('card saves via update API');
if (!card.includes('disabled={busy || blocked')) fail('confirm blocked on errors');
if (!card.includes('sm:flex-row')) fail('responsive actions');
if (ui.includes('cancelDraft(id, true)') || ui.includes('onFix=')) fail('Исправить must not cancel the draft');
if (!ui.includes('onUpdated')) fail('reload after save');
if (!ui.includes('resolved')) fail('load resolved for edit');

if (/\.rpc\(['\"]confirm_order/i.test(tools)) fail('tools must not confirm orders');
if (/from\('(?:orders|inventory)'\)\.(insert|update|delete)/i.test(tools)) fail('tools stay read-only');
if (!prompt.includes('Подтвердить заказ') && !prompt.toLowerCase().includes('кнопки')) {
  fail('prompt must say confirmation is a button');
}

if (!confirmOrderSql.includes('Admin or manager must provide city_id and seller_id')) {
  fail('existing confirm_order manager rules must remain in 5.1 SQL');
}

if (isAssistantRole('seller')) fail('seller is not assistant');
if (!isAssistantRole('manager') || !isAssistantRole('admin')) fail('admin/manager are assistants');

const sample = `Айгүл 87771234567\n2 порошок\nШай 3\n04.11.2026\n13:45\nТөленген`;
if (!looksLikeInvoice(sample)) fail('sample packing slip should look like invoice');
if (!looksLikeInvoice('Айгүл\nшай 3шт\nшампунь 2шт\nдраже 2шт\nТөленген')) {
  fail('qty glued to шт without customer phone must look like invoice');
}
if (looksLikeInvoice('Сколько порошка в Астане?')) fail('stock question is not an invoice');
if (!handle.includes('hasInvoiceDraftSignals')) fail('draft signals without customer');
const phones = extractPhones(sample);
if (!phones.some((p) => p.replace(/\D/g, '').endsWith('7771234567'))) {
  fail('phone extract');
}
if (phones[0] && !phones[0].startsWith('+7')) fail('phone extract must store KZ canon +7');
const masked = stripIdentifiers(sample);
if (masked.includes('87771234567')) fail('phone must be masked before the model');
if (!masked.includes('скрыто')) fail('mask token');

const pay = detectPayment(sample);
if (!pay.paid_unspecified) fail('төленген is paid unspecified');
if (detectPayment('в долг 8777').is_debt !== true) fail('debt keyword');
if (detectPayment('предзаказ').is_preorder !== true) fail('preorder keyword');
if (detectPayment('kaspi').payment_type !== 'kaspi') fail('kaspi mapping');

const aliases = expandProductQuery('шай');
if (!aliases.includes('чай') && !aliases.some((a) => a.includes('чай') || a.includes('chai') || a.includes('shai'))) {
  fail('шай expands to чай');
}
const catalog = [
  { id: '1', name: 'ШАЙ ОРГ 500г', unit: 'g', price_retail: 10 },
  { id: '2', name: 'ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 20 },
  { id: '3', name: 'ШИКІ ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 21 },
  { id: '4', name: 'ТӘТТІ ШАЙ', unit: 'g', price_retail: 22 },
];
const tea = matchCatalogProducts('шай', catalog);
if (tea.length !== 1 || tea[0].name !== 'ШАЙ ОРГ 500г') fail('шай should uniquely match ШАЙ ОРГ 500г');
const powder = matchCatalogProducts('порошок', catalog);
if (powder.length !== 1 || powder[0].name !== 'ПОРОШОК ОРГ 250г') fail('порошок should uniquely match ПОРОШОК ОРГ 250г');
const shiki = matchCatalogProducts('шикі порошок', catalog);
if (shiki.length !== 1 || shiki[0].name !== 'ШИКІ ПОРОШОК ОРГ 250г') fail('шикі порошок must not become ordinary powder');
if (!card.includes('DraftProductPicker')) fail('one-click product picker');

if (!pricesEqual(100, 100.001) && !pricesEqual(100, 100)) fail('price compare 100');
if (!pricesEqual(10.5, 10.5)) fail('price compare equal');
if (pricesEqual(10, 11)) fail('price compare different');
if (qtyValidationError(2, 'pcs')) fail('int qty ok');
if (!qtyValidationError(1.5, 'pcs')) fail('fraction pcs invalid');
if (qtyValidationError(1.5, 'kg')) fail('kg decimals ok');

if (!routeConfirm.includes('CONFIRM_WAIT_MS')) fail('timeout budget');
if (!routeConfirm.includes('findOrderByKey') && !routeConfirm.includes('idempotency_actor_id')) {
  fail('timeout recovery by idempotency key');
}

console.log('OK');
