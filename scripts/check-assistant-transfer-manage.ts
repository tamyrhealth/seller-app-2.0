import { readFileSync } from 'fs';
import { join } from 'path';
import { actorCanCreateTransfer, actorCanManageTransfers } from '../lib/assistant/resolveTransfer';
import { parseCancelIntent } from '../lib/assistant/cancelIntent';
import { parseTransferIntent } from '../lib/assistant/transferIntent';
import { parseTransferManageIntent, parseTransferNumberQuery } from '../lib/assistant/transferManageIntent';
import { isAssistantRole } from '../lib/roles';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

if (actorCanManageTransfers('admin', false).allowed !== true) fail('admin can manage without flag');
if (actorCanManageTransfers('manager', true).allowed !== true) fail('manager with manage flag');
if (actorCanManageTransfers('manager', false).allowed) fail('manager without manage flag cannot receive');
if (actorCanManageTransfers('seller', true).allowed) fail('seller cannot manage transfers');
if (actorCanCreateTransfer('manager', false, true).allowed !== true) fail('manage flag also allows create');
if (actorCanCreateTransfer('manager', true, false).allowed !== true) fail('create-only still creates');
if (actorCanCreateTransfer('manager', false, false).allowed) fail('manager without both flags cannot create');
if (isAssistantRole('seller')) fail('seller is not assistant');

if (parseTransferNumberQuery('Прими T000005') !== 'T000005') fail('parse T000005');
if (parseTransferManageIntent('Прими T000005')?.kind !== 'receive') fail('receive intent');
if (parseTransferManageIntent('Верни остаток T000005')?.kind !== 'return_remainder') fail('return intent');
if (parseTransferManageIntent('Недостача T000005 причина: бой')?.kind !== 'shortage') fail('shortage intent');
if (parseTransferManageIntent('Недостача T000005 причина: бой')?.reason !== 'бой') fail('shortage reason');
if (parseTransferManageIntent('Статус T000005')?.kind !== 'lookup') fail('lookup intent');
if (parseTransferManageIntent('Покажи перемещения')?.kind !== 'list') fail('list intent');
if (parseTransferManageIntent('Алматы → Актау\n1 порошок')) fail('create must not be manage');
if (parseTransferIntent('Прими T000005')) fail('create parser must ignore receive');
if (parseCancelIntent('Отмени перемещение T000005')) fail('order cancel must ignore transfer cancel');
if (!parseCancelIntent('Отмени заказ N000033')) fail('order cancel still works');

const sql = read('supabase/migrations/20261105010000_assistant_stock_transfer_manage.sql');
const runSql = read('supabase/run_assistant_stock_transfer_manage.sql');
const inspect = read('supabase/prod/pre_apply_inspect_block526.sql');
const verify = read('supabase/prod/post_apply_verify_block526.sql');
const origReceive = read('supabase/migrations/20261103230000_stock_transfer_partial_receive.sql');
const origWrite = read('supabase/migrations/20261103240000_product_cost_shortage_snapshot.sql');
const create525 = read('supabase/migrations/20261104220000_assistant_stock_transfers.sql');
const handle = read('lib/assistant/handleTurn.ts');
const chat = read('app/api/assistant/chat/route.ts');
const manage = read('app/api/assistant/transfers/manage/route.ts');
const card = read('components/AssistantTransferManageCard.tsx');
const ui = read('components/AssistantChats.tsx');
const users = read('app/admin/users/page.tsx');
const panel = read('components/TransfersPanel.tsx');

if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('SQL must be transactional');
if (/DROP\s+(FUNCTION|TABLE|POLICY)[\s\S]{0,120}CASCADE/i.test(sql)) fail('must not DROP ... CASCADE');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/CREATE OR REPLACE FUNCTION public\.apply_inventory_restock/i.test(sql)) fail('must not rewrite restock');
if (!sql.includes('can_manage_transfers boolean NOT NULL DEFAULT false')) fail('manage flag default false');
if (!sql.includes('stock_transfer_require')) fail('shared permission helper');
if (!sql.includes('Account is inactive')) fail('inactive profiles must be denied in require');
if (!sql.includes('COALESCE(p.is_active, false)')) fail('is_active must be read from JWT profile');
if (!sql.includes('v_uid uuid := auth.uid();')) fail('require must use auth.uid()');
if (/stock_transfer_require\([^)]*user_id/i.test(sql)) fail('require must not take client user_id');
if (!sql.includes('PERFORM public.stock_transfer_require(false);')) fail('create uses require(false)');
if ((sql.match(/PERFORM public\.stock_transfer_require\(true\);/g) || []).length !== 3) {
  fail('receive/cancel/shortage must use require(true)');
}
if (sql.includes('Only admin can receive transfers')) fail('receive must no longer be admin-only');
if (!sql.includes("INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)")) {
  fail('events must keep actor_id');
}
if (!sql.includes('can_manage_transfers')) fail('RLS/trigger mention manage flag');
if (!sql.includes('Received transfer cannot be cancelled')) fail('keep cannot cancel received remainder twice');
if (!sql.includes('Shortage reason is required')) fail('keep required shortage reason');
if (!sql.includes('qty_on_hand >= v_need')) fail('create stock guard kept');
if (!sql.includes('client_operations')) fail('idempotency kept');

if (!sql.includes('Insufficient stock')) fail('create body must keep stock check');
if (!origReceive.includes("RAISE EXCEPTION 'Only admin can receive transfers'")) fail('original receive snapshot kept');
if (!origWrite.includes('Only admin can write off transfer shortage')) fail('original write-off snapshot kept');
if (!create525.includes('can_create_transfers')) fail('5.2.5 create snapshot kept');

const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) fail('post verify must be SELECT-only');
if (/INSERT|UPDATE|DELETE/i.test(inspect.replace(/--.*$/gm, ''))) fail('pre inspect must be read-only');
if (!inspect.includes('can_manage_transfers_absent_before_apply')) fail('preflight expects flag absent');
if (!inspect.includes('stock_transfer_require_absent_before_apply')) fail('preflight expects require absent');
if (!verify.includes('require.checks_is_active')) fail('post verify inactive check');
if (!verify.includes('require.no_client_user_id')) fail('post verify no client user_id');
if (!verify.includes('receive.uses_require')) fail('post verify receive helper');
if (!verify.includes('rls.manage_select')) fail('post verify RLS');
if (!verify.includes('trigger.blocks_can_manage_transfers')) fail('post verify trigger');
if (!verify.includes('trigger.insert_or_update')) fail('post verify insert trigger');
if (!verify.includes('rls.write_policies_absent')) fail('post verify no write RLS');
if (!verify.includes('policyname')) fail('pg_policies column');

const turnBody = handle.slice(handle.indexOf('export async function generateAssistantTurn'));
if (turnBody.indexOf('parseTransferManageIntent') > turnBody.indexOf('parseTransferIntent')) {
  fail('manage intent must run before create transfer');
}
if (turnBody.indexOf('parseTransferManageIntent') > turnBody.indexOf('parseCancelIntent')) {
  fail('manage intent must run before order cancel');
}
if (!chat.includes('kind: \'transfer_manage\'') && !chat.includes("kind: 'transfer_manage'")) {
  fail('chat must persist transfer manage card');
}
if (!manage.includes("rpc('receive_stock_transfer'")) fail('manage confirm calls receive RPC');
if (!manage.includes("rpc('cancel_stock_transfer'")) fail('manage confirm calls cancel RPC');
if (!manage.includes("rpc('write_off_stock_transfer_shortage'")) fail('manage confirm calls shortage RPC');
if (manage.includes("service.rpc('receive_stock_transfer'") || manage.includes('service.rpc("receive_stock_transfer"')) {
  fail('service_role must not receive transfers');
}
if (!manage.includes('createUserClient')) fail('JWT user client');
if (!manage.includes('preview.operation_id')) fail('stable operation_id');
if (!manage.includes("meta.state === 'dismissed'")) fail('dismissed card must not confirm');
if (!sql.includes('BEFORE INSERT OR UPDATE ON public.profiles')) fail('privilege trigger must cover insert');
if (!sql.includes("TG_OP = 'INSERT'")) fail('privilege function must block insert of flags');
if (!card.includes('Подтвердить приёмку')) fail('explicit receive button');
if (!card.includes('Вернуть остаток отправителю')) fail('explicit return button');
if (!card.includes('Подтвердить недостачу')) fail('explicit shortage button');
if (!ui.includes('AssistantTransferManageCard')) fail('manage card in chats');
if (!ui.includes('assistant-transfer-manage')) fail('exclusive manage action');
if (!users.includes('can_manage_transfers')) fail('users UI flag');
if (!users.includes('Разрешить полное управление перемещениями')) fail('users checkbox copy');
if (panel.includes('can_manage_transfers')) fail('TransfersPanel must not grow manager flags');
if (!panel.includes('dup ? `${name} · ${short}`')) fail('admin history must distinguish duplicate display names');

console.log('check-assistant-transfer-manage: ok');
