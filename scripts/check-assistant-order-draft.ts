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
const ui = read('components/AssistantChats.tsx');
const card = read('components/AssistantOrderDraftCard.tsx');
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
if (!handle.includes('parseInvoiceStructured')) fail('structured parse on invoice path');
if (!handle.includes('resolveInvoiceDraft')) fail('server-side resolve');
if (handle.includes('confirm_order')) fail('prepare path must not create orders');

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

if (!ui.includes('/api/assistant/orders/')) fail('UI confirm endpoint');
if (!ui.includes('AssistantOrderDraftCard')) fail('preview card');
if (!ui.includes("first !== 'pending'")) fail('UI must retry pending confirm once');
if (ui.includes("role: 'assistant'")) fail('UI must not insert assistant messages');
if (!card.includes('Подтвердить заказ')) fail('confirm button');
if (!card.includes('Исправить')) fail('fix button');
if (!card.includes('Отмена')) fail('cancel button');
if (!card.includes('disabled={busy || blocked}')) fail('confirm blocked on errors');
if (!card.includes('sm:flex-row')) fail('responsive actions');

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
if (looksLikeInvoice('Сколько порошка в Астане?')) fail('stock question is not an invoice');
const phones = extractPhones(sample);
if (!phones.some((p) => p.endsWith('7771234567') || p.includes('7771234567') || p.endsWith('87771234567'))) {
  fail('phone extract');
}
const masked = stripIdentifiers(sample);
if (masked.includes('87771234567')) fail('phone must be masked before the model');
if (!masked.includes('скрыто')) fail('mask token');

const pay = detectPayment(sample);
if (!pay.paid_unspecified) fail('төленген is paid unspecified');
if (detectPayment('в долг 8777').is_debt !== true) fail('debt keyword');
if (detectPayment('предзаказ').is_preorder !== true) fail('preorder keyword');
if (detectPayment('kaspi').payment_type !== 'kaspi') fail('kaspi mapping');

const aliases = expandProductQuery('шай');
if (!aliases.includes('чай') && !aliases.some((a) => a.includes('чай'))) fail('шай expands to чай');
const catalog = [
  { id: '1', name: 'Чай зелёный', unit: 'pcs', price_retail: 10 },
  { id: '2', name: 'Порошок', unit: 'pcs', price_retail: 20 },
  { id: '3', name: 'Порошок детский', unit: 'pcs', price_retail: 21 },
];
const tea = matchCatalogProducts('шай', catalog);
if (tea.length !== 1 || tea[0].name !== 'Чай зелёный') fail('шай should uniquely match tea');
const powder = matchCatalogProducts('порошок', catalog);
if (powder.length < 2) fail('порошок should be ambiguous when two powder products exist');
const uniquePowder = matchCatalogProducts('порошок детский', catalog);
if (uniquePowder.length !== 1) fail('specific powder name should uniquely match');

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
