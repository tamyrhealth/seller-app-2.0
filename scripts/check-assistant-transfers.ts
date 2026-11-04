import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTransferIntent } from '../lib/assistant/transferIntent';
import {
  actorCanCreateTransfer,
  applyTransferEdit,
  chooseTransferCity,
  shouldFlagInsufficientStock,
  stockQtyForSource,
} from '../lib/assistant/resolveTransfer';
import { matchTransferCities } from '../lib/assistant/transferCityMatch';
import { qtyValidationError } from '../lib/assistant/qty';
import { isAssistantRole } from '../lib/roles';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

function expectTransfer(text: string, from: string, to: string, items: { name: string; qty: number }[]) {
  const intent = parseTransferIntent(text);
  if (!intent) fail(`should detect transfer: ${text}`);
  if (intent.fromQuery.toLowerCase() !== from.toLowerCase()) {
    fail(`${text} from=${intent.fromQuery}, expected ${from}`);
  }
  if (intent.toQuery.toLowerCase() !== to.toLowerCase()) {
    fail(`${text} to=${intent.toQuery}, expected ${to}`);
  }
  if (intent.items.length !== items.length) {
    fail(`${text} items=${JSON.stringify(intent.items)}, expected ${JSON.stringify(items)}`);
  }
  items.forEach((item, i) => {
    if (!intent.items[i].raw_name.toLowerCase().includes(item.name.toLowerCase())) {
      fail(`${text} item name ${intent.items[i].raw_name} vs ${item.name}`);
    }
    if (intent.items[i].qty !== item.qty) fail(`${text} qty ${intent.items[i].qty} vs ${item.qty}`);
  });
}

expectTransfer('Алматы → Актау\n100 порошок\n25 чай', 'Алматы', 'Актау', [
  { name: 'порошок', qty: 100 },
  { name: 'чай', qty: 25 },
]);
expectTransfer('Отправь из Алматы в Актау 10 пластырь', 'Алматы', 'Актау', [{ name: 'пластырь', qty: 10 }]);
expectTransfer('Алматыдан Ақтауға 1.25 ұнтақ жібер', 'Алматы', 'Ақтау', [{ name: 'ұнтақ', qty: 1.25 }]);
if (parseTransferIntent('Айгерим Алматы\n10 порошок\nkaspi')) fail('order invoice must not be transfer');
if (parseTransferIntent('Отмени заказ N000033')) fail('cancel is not transfer');
if (parseTransferIntent('Где перемещение T000001')) fail('lookup is not create');
if (parseTransferIntent('Прими отправку T000001')) fail('receive is not create');

if (actorCanCreateTransfer('admin', false).allowed !== true) fail('admin can create without flag');
if (actorCanCreateTransfer('manager', true).allowed !== true) fail('manager with flag');
if (actorCanCreateTransfer('manager', false).allowed) fail('manager without flag cannot');
if (actorCanCreateTransfer('seller', true).allowed) fail('seller cannot create transfers');
if (isAssistantRole('seller')) fail('seller is not assistant');

const cities = [
  { id: '1', name: 'Алматы' },
  { id: '2', name: 'Ақтау' },
];
if (matchTransferCities('алмата', cities)[0]?.name !== 'Алматы') fail('almaty alias');
if (matchTransferCities('aktau', cities)[0]?.name !== 'Ақтау') fail('aktau alias');

const almatyWarehouses = [
  { id: 'galia', name: 'Алматы-Ғалия', is_active: true },
  { id: 'office', name: 'Алматы-Офис', is_active: true },
  { id: 'aktau', name: 'Ақтау', is_active: true },
];
const ambiguousFrom = chooseTransferCity('Алматы', almatyWarehouses, 'from');
if (ambiguousFrom.id) fail('Алматы must stay ambiguous when two warehouses match');
if (ambiguousFrom.candidates.length !== 2) fail(`expected 2 Almaty warehouses, got ${ambiguousFrom.candidates.length}`);
if (!ambiguousFrom.errors.some((e) => e.code === 'from_city_ambiguous')) fail('ambiguous source needs from_city_ambiguous');
if (!ambiguousFrom.candidates.some((c) => c.id === 'galia') || !ambiguousFrom.candidates.some((c) => c.id === 'office')) {
  fail('ambiguous source must expose warehouse ids for picker');
}
const uniqueTo = chooseTransferCity('Ақтау', almatyWarehouses, 'to');
if (uniqueTo.id !== 'aktau') fail('Aktau must resolve uniquely');

if (stockQtyForSource(null, new Map([['p1', 10]]), 'p1') !== null) fail('no stock until source warehouse is chosen');
if (stockQtyForSource('galia', new Map(), 'p1') !== 0) fail('missing inventory row is 0 only after warehouse chosen');
if (stockQtyForSource('galia', new Map([['p1', 7]]), 'p1') !== 7) fail('stock comes from chosen warehouse');
if (shouldFlagInsufficientStock(null, 2, 0)) fail('do not flag shortage while warehouse is ambiguous');
if (shouldFlagInsufficientStock('galia', 2, null)) fail('do not flag shortage without a stock reading');
if (!shouldFlagInsufficientStock('galia', 2, 0)) fail('flag shortage when chosen warehouse has 0');
if (shouldFlagInsufficientStock('galia', 2, 5)) fail('enough stock must not block');

const powder = { id: 'p1', name: 'Порошок', unit: 'pcs', price_retail: 1, is_active: true };
const tea = { id: 'p2', name: 'Чай', unit: 'pcs', price_retail: 1, is_active: true };
const afterPick = applyTransferEdit(
  almatyWarehouses,
  [powder, tea],
  new Map([
    ['p1', 10],
    ['p2', 4],
  ]),
  'galia',
  'aktau',
  [
    { product_id: 'p1', qty: 2, raw_name: 'Порошок' },
    { product_id: 'p2', qty: 1, raw_name: 'Чай' },
  ],
  { role: 'admin', can_create_transfers: false }
);
if (!afterPick.can_confirm) fail(`chosen warehouse with stock must confirm, errors=${JSON.stringify(afterPick.errors)}`);
if (afterPick.resolved.items.some((i) => i.stock == null)) fail('stock must be filled after warehouse pick');

const shortPick = applyTransferEdit(
  almatyWarehouses,
  [powder],
  new Map([['p1', 1]]),
  'office',
  'aktau',
  [{ product_id: 'p1', qty: 2, raw_name: 'Порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (shortPick.can_confirm) fail('true shortage must block confirm');
if (!shortPick.errors.some((e) => e.code === 'insufficient_stock' && e.message.includes('есть 1'))) {
  fail('true shortage must show actual remainder');
}

if (qtyValidationError(1.25, 'kg')) fail('kg 3 decimals allowed');
if (!qtyValidationError(1.2501, 'kg')) fail('kg 4 decimals blocked');
if (!qtyValidationError(1.5, 'pcs')) fail('piece qty must be integer');
if (qtyValidationError(2, 'pcs')) fail('integer pcs ok');

const sql = read('supabase/migrations/20261104220000_assistant_stock_transfers.sql');
const runSql = read('supabase/run_assistant_stock_transfers.sql');
const inspect = read('supabase/prod/pre_apply_inspect_block525.sql');
const verify = read('supabase/prod/post_apply_verify_block525.sql');
const handle = read('lib/assistant/handleTurn.ts');
const chat = read('app/api/assistant/chat/route.ts');
const confirm = read('app/api/assistant/transfers/confirm/route.ts');
const update = read('app/api/assistant/transfers/update/route.ts');
const ui = read('components/AssistantChats.tsx');
const card = read('components/AssistantTransferDraftCard.tsx');
const users = read('app/admin/users/page.tsx');
const panel = read('components/TransfersPanel.tsx');
const receiveSql = read('supabase/migrations/20261103230000_stock_transfer_partial_receive.sql');
const createOrig = read('supabase/migrations/20261103220000_stock_transfers.sql');

if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('SQL must be transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/DROP\s+(FUNCTION|TABLE|POLICY)[\s\S]{0,120}CASCADE/i.test(sql)) fail('must not DROP ... CASCADE');
if (/^\s*DROP FUNCTION/im.test(sql)) fail('must not DROP FUNCTION');
if (/CREATE OR REPLACE FUNCTION public\.receive_stock_transfer/i.test(sql)) fail('must not rewrite receive');
if (/CREATE OR REPLACE FUNCTION public\.cancel_stock_transfer/i.test(sql)) fail('must not rewrite cancel');
if (/CREATE OR REPLACE FUNCTION public\.write_off_stock_transfer_shortage/i.test(sql)) fail('must not rewrite shortage');
if (/CREATE OR REPLACE FUNCTION public\.apply_order_cancel/i.test(sql)) fail('must not touch cancel orders');
if (!sql.includes('can_create_transfers')) fail('manager create flag');
if (!sql.includes('NOT NULL DEFAULT false')) fail('flag default false');
if (!sql.includes('Transfer permission denied')) fail('direct RPC denied without flag');
if (!sql.includes('assistant_stock_transfer_drafts')) fail('draft table');
if (!sql.includes('client_operations')) fail('keep client_operations idempotency');
if (!sql.includes('pg_advisory_xact_lock')) fail('keep advisory locks');
if (!sql.includes('qty_on_hand >= v_need')) fail('must keep stock guard in create_stock_transfer');
if (!sql.includes('Source city is inactive')) fail('SQL city active check');
if (!sql.includes('Inactive product')) fail('SQL product active check');
if (!sql.includes("COALESCE(p.unit, '') IS DISTINCT FROM 'kg'")) fail('qty unit from products.unit');
if (!sql.includes('created_by = auth.uid()')) fail('manager can read own transfer');
if (!sql.includes('begin_assistant_stock_transfer_confirm')) fail('JWT begin confirm');
if (!sql.includes('GRANT ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) TO authenticated, service_role')) {
  fail('create_stock_transfer grants must match production (authenticated + service_role)');
}
if (!sql.includes("REVOKE ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon")) {
  fail('anon/public must not execute create_stock_transfer');
}
if (!sql.includes('Source city not found')) fail('keep original missing-city error');
if (!sql.includes('AND owner_id = v_uid AND status IN (\'preview\', \'blocked\')')) {
  fail('draft cancel must only touch preview/blocked, not confirming');
}

const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) fail('post verify must be SELECT-only');
if (/INSERT|UPDATE|DELETE/i.test(inspect.replace(/--.*$/gm, ''))) fail('pre inspect must be read-only');

if (!handle.includes('parseTransferIntent')) fail('turn must parse transfer');
const turnBody = handle.slice(handle.indexOf('export async function generateAssistantTurn'));
if (turnBody.indexOf('parseTransferIntent') > turnBody.indexOf('looksLikeInvoice')) {
  fail('transfer must run before invoice heuristic');
}
if (turnBody.indexOf('parseCancelIntent') > turnBody.indexOf('parseTransferIntent')) {
  fail('cancel must still run before transfer');
}
if (handle.includes("rpc('create_stock_transfer'")) fail('prepare path must not create transfer');

if (!chat.includes('save_assistant_stock_transfer_draft')) fail('persist transfer draft');
if (!chat.includes('can_create_transfers')) fail('chat loads transfer flag');
if (chat.includes("rpc('create_stock_transfer'")) fail('chat must not create stock transfer');

if (!confirm.includes('createUserClient')) fail('create_stock_transfer must run as the user');
if (!confirm.includes("rpc('create_stock_transfer'")) fail('confirm calls existing RPC');
if (confirm.includes("service.rpc('create_stock_transfer'") || confirm.includes('service.rpc("create_stock_transfer"')) {
  fail('service_role must not call create_stock_transfer');
}
if (!confirm.includes('idempotency_key')) fail('stable operation_id');
if (!confirm.includes('client_operations')) fail('recover transfer by operation_id');
if (!confirm.includes('pending')) fail('timeout retry');
if (!confirm.includes('Недостаточно остатков')) fail('human insufficient stock');
if (confirm.includes("service.rpc('create_stock_transfer'")) fail('service_role must not create transfers');
if (!update.includes('update_assistant_stock_transfer_draft_content')) fail('edit draft');

if (!ui.includes('AssistantTransferDraftCard')) fail('transfer card in chats');
if (!ui.includes('assistant-transfer-confirm')) fail('exclusive confirm');
if (!card.includes('Подтвердить отправку')) fail('explicit confirm button');
if (!card.includes("draft.status === 'confirmed'") && !card.includes('draft.transfer_id')) {
  fail('hide after send');
}
if (!card.includes('Повторить подтверждение')) fail('network retry must remain possible while confirming');
if (!card.includes('showEditCancel')) fail('edit/cancel hidden after send and while confirming');
if (!card.includes('needFromPick')) fail('card must offer warehouse picker when source is ambiguous');
if (!card.includes('insufficient_stock')) fail('card must hide fake shortage until warehouse chosen');
if (!card.includes('!sent && sourceReady && item.stock != null')) {
  fail('confirmed transfer card must hide pre-send stock remainder');
}
if (!read('lib/assistant/resolveTransfer.ts').includes('shouldFlagInsufficientStock')) {
  fail('stock check must skip unresolved source warehouse');
}

const mapper = read('lib/stockTransfer.ts');
if (!mapper.includes('Transfer permission denied')) fail('TransfersPanel must map new permission error');
if (!mapper.includes('Source city is inactive')) fail('TransfersPanel must map inactive city');

if (!inspect.includes('pg_get_function_identity_arguments')) fail('pre inspect signatures');
if (!inspect.includes('aclexplode')) fail('pre inspect grants');
if (!inspect.includes('policyname')) fail('pg_policies column is policyname');
if (/\bpolname\b/.test(inspect) || /\bpolname\b/.test(verify)) fail('must not query pg_policies.polname');
if (!inspect.includes('check_name')) fail('preflight must be one result table');
if (!inspect.includes("'PASS'")) fail('preflight must emit PASS/FAIL');
if (!verify.includes('check_name')) fail('post verify must be one result table');
if (!verify.includes('has_function_privilege')) fail('post inspect execute privileges');
if (!verify.includes('auth_save_must_be_false')) fail('post inspect save_draft not for authenticated');
if (!verify.includes('receive_stock_transfer.admin_only')) fail('post inspect receive admin');
if (!verify.includes('trigger.blocks_can_create_transfers')) fail('post inspect privilege trigger');
if (!verify.includes('city_not_found_kept')) fail('post inspect keeps original city-not-found');
if (!verify.includes('policyname')) fail('post verify pg_policies column is policyname');
if (!users.includes('can_create_transfers')) fail('users UI flag');
if (!users.includes('Разрешить создание перемещений')) fail('users checkbox copy');

if (!createOrig.includes('format_transfer_number')) fail('T000001 lives in original transfer SQL');
if (!receiveSql.includes('Only admin can receive transfers')) fail('receive remains admin-only in original SQL');
if (panel.includes('can_create_transfers')) fail('TransfersPanel must stay unchanged for manager create flag');

console.log('check-assistant-transfers: ok');
