import { readFileSync } from 'fs';
import { join } from 'path';
import { formatChatNumber } from '../lib/chatNumber';
import { isCanceledStatus, orderStatusI18nKey } from '../lib/orderStatus';
import { runExclusive } from '../lib/exclusiveAsync';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const sql = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20261103260000_assistant_chat_numbers.sql'),
  'utf8'
);
const runSql = readFileSync(
  join(process.cwd(), 'supabase', 'run_assistant_chat_numbers.sql'),
  'utf8'
);
const verify = readFileSync(
  join(process.cwd(), 'supabase', 'prod', 'post_apply_verify_block511.sql'),
  'utf8'
);
const chatsUi = readFileSync(join(process.cwd(), 'components', 'AssistantChats.tsx'), 'utf8');
const inventoryUi = readFileSync(join(process.cwd(), 'components', 'InventoryBrowse.tsx'), 'utf8');
const ordersUi = readFileSync(join(process.cwd(), 'components', 'OrderBrowse.tsx'), 'utf8');
const managerInv = readFileSync(join(process.cwd(), 'app', 'manager', 'inventory', 'page.tsx'), 'utf8');
const managerOrders = readFileSync(join(process.cwd(), 'app', 'manager', 'orders', 'page.tsx'), 'utf8');
const i18n = readFileSync(join(process.cwd(), 'lib', 'i18n.tsx'), 'utf8');

if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('5.1.1 migration must be transactional');
if (!sql.includes('assistant_chats_chat_number_seq')) fail('must use a sequence, not MAX+1');
if (!sql.includes("format_chat_number")) fail('chat number formatter');
if (!sql.includes("open_empty_assistant_chat")) fail('empty-chat RPC required');
if (!sql.includes('pg_advisory_xact_lock')) fail('empty-chat RPC must lock per owner');
if (!sql.includes('assistant_chats_one_empty_per_owner_uidx')) fail('unique empty chat per owner');
if (!sql.includes('Cannot change chat number')) fail('chat_number must be immutable');
if (!sql.includes('Cannot change message_count')) fail('message_count must not be client-writable');
if (!sql.includes('pg_trigger_depth()')) fail('message_count updates must be trigger-nested only');
if (!sql.includes('VALUES (v_uid, \'Новый диалог\')')) fail('RPC insert must use auth.uid() as owner');
if (!sql.includes('owner_id = v_uid')) fail('RPC must create chats only for auth.uid()');
if (!sql.includes('is_assistant_user()')) fail('RPC must reject sellers');
if (/DELETE\s+FROM\s+public\.assistant_messages/i.test(sql)) fail('must not delete chat history');
if (/DELETE\s+FROM\s+public\.(orders|inventory|profiles|products)/i.test(sql)) {
  fail('must not delete business rows');
}
if (/UPDATE\s+public\.(orders|inventory|profiles|products)\s+SET/i.test(sql)) {
  fail('must not rewrite orders/inventory/profiles/products');
}
if (!runSql.includes('open_empty_assistant_chat')) fail('run SQL must include RPC');
if (!runSql.includes('assistant_chats_one_empty_per_owner_uidx')) fail('run SQL must include unique empty index');

const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) {
  fail('post_apply_verify_block511.sql must be SELECT-only');
}
if (/\bpolname\b/.test(verify)) fail('pg_policies uses policyname, not polname');
if (!verify.includes('policyname')) fail('verify must list pg_policies.policyname');

if (formatChatNumber(1) !== 'C000001') fail('C000001 formatting');
if (formatChatNumber(12) !== 'C000012') fail('C000012 formatting');
if (formatChatNumber(1000000) !== 'C1000000') fail('wide chat numbers must not truncate');

if (orderStatusI18nKey('confirmed') !== 'orders.status.confirmed') fail('confirmed i18n key');
if (orderStatusI18nKey('canceled') !== 'orders.status.canceled') fail('canceled i18n key');
if (orderStatusI18nKey('cancelled') !== 'orders.status.canceled') fail('cancelled alias');
if (!isCanceledStatus('canceled') || !isCanceledStatus('cancelled')) fail('canceled detector');
if (isCanceledStatus('confirmed')) fail('confirmed is not canceled');

if (!i18n.includes("'orders.status.confirmed': 'Подтверждён'")) fail('RU confirmed');
if (!i18n.includes("'orders.status.canceled': 'Отменён'")) fail('RU canceled');
if (!i18n.includes("'orders.status.confirmed': 'Расталған'")) fail('KZ confirmed');
if (!i18n.includes("'orders.status.canceled': 'Болдырылған'")) fail('KZ canceled');

if (!chatsUi.includes("placeholder=\"Сообщение\"")) fail('message placeholder');
if (!chatsUi.includes('open_empty_assistant_chat')) fail('UI must call empty-chat RPC');
if (!chatsUi.includes('Shift') && !chatsUi.includes('shiftKey')) fail('Shift+Enter newline');
if (!chatsUi.includes('scrollIntoView')) fail('auto-scroll');
if (!chatsUi.includes('justify-end')) fail('user messages on the right');
if (chatsUi.includes('Текст сохранится в истории диалога')) fail('old placeholder must go');
if (!chatsUi.includes('ИИ пока не подключён')) fail('honest AI-offline banner');
if (!chatsUi.includes('23505')) fail('message idempotency must remain');
if (!chatsUi.includes('runExclusive')) fail('double-click empty chat must be serialized in UI');

if (inventoryUi.includes('cost_price') || managerInv.includes('cost_price')) fail('manager inventory must not read cost_price');
if (inventoryUi.includes('Итого по КЗ') || managerInv.includes('Итого по КЗ')) fail('KZ money total must not appear');
if (/restock|apply_inventory|create_stock_transfer|Корректировка|Приход товара/i.test(inventoryUi + managerInv)) {
  fail('manager inventory must stay read-only');
}

if (/cancel_order|admin_cancel_order|fulfill_preorder|mark_debt_paid/i.test(ordersUi + managerOrders)) {
  fail('manager orders UI must not call mutating RPCs');
}
if (!ordersUi.includes('orders.status.confirmed')) fail('order list must use localized status');
if (!ordersUi.includes('parseOrderNumberQuery')) fail('order number search');

async function main() {
  let emptyOpens = 0;
  async function openEmptyOnce() {
    emptyOpens += 1;
    await new Promise((r) => setTimeout(r, 20));
    return 'same-chat';
  }
  const [a, b, c] = await Promise.all([
    runExclusive('empty-chat-test', openEmptyOnce),
    runExclusive('empty-chat-test', openEmptyOnce),
    runExclusive('empty-chat-test', openEmptyOnce),
  ]);
  if (emptyOpens !== 1) fail(`concurrent empty opens must share one RPC, got ${emptyOpens}`);
  if (a !== 'same-chat' || b !== a || c !== a) fail('exclusive empty-chat results must match');

  const seen = new Set<string>();
  for (let i = 1; i <= 20; i += 1) {
    const n = formatChatNumber(i);
    if (seen.has(n)) fail('chat numbers must be unique');
    seen.add(n);
  }

  console.log('OK');
}

void main();
