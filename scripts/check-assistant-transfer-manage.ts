import { readFileSync } from 'fs';
import { join } from 'path';
import { actorCanCreateTransfer, actorCanManageTransfers } from '../lib/assistant/resolveTransfer';
import { parseCancelIntent } from '../lib/assistant/cancelIntent';
import { parseTransferIntent } from '../lib/assistant/transferIntent';
import {
  extractTransferManageItems,
  parseTransferManageIntent,
  parseTransferNumberQuery,
} from '../lib/assistant/transferManageIntent';
import {
  assignManageActionQty,
  buildTransferManageMessage,
  collectTransferManageActionErrors,
  didManageMutationApply,
  filterTransferManageList,
  transferManageMutationSnapshot,
} from '../lib/assistant/resolveTransferManage';
import type { TransferManagePreview } from '../lib/assistant/transferManageTypes';
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
if (parseTransferManageIntent('Покажи перемещения')?.listFilter !== 'all') fail('generic list stays unfiltered');
const awaiting = parseTransferManageIntent('Покажи мои перемещения, которые ожидают приёмки');
if (awaiting?.kind !== 'list') fail('awaiting receipt is a list intent');
if (awaiting?.listFilter !== 'in_transit') fail('awaiting receipt must request in-transit only');
if (awaiting?.mineOnly !== true) fail('awaiting my transfers must set mineOnly');
const previewReceive = parseTransferManageIntent(
  'Хочу принять перемещение T000006. Покажи товары и количество для подтверждения, но пока ничего не проводи'
);
if (previewReceive?.kind !== 'receive') fail('preview receive still receive kind');
if (previewReceive?.transferNumber !== 'T000006') fail('preview receive number');
if (previewReceive?.previewOnly !== true) fail('do not confirm informational receive');
if (parseTransferManageIntent('Прими T000005')?.previewOnly) fail('real receive must still confirm');
const partialRu = parseTransferManageIntent('Прими 2 штуки порошка ОРГ 250 г из перемещения T000010');
if (partialRu?.kind !== 'receive') fail('partial receive kind');
if (partialRu?.transferNumber !== 'T000010') fail('partial receive number');
if (partialRu?.explicitAll) fail('partial receive is not take-all');
if (partialRu?.items.length !== 1 || partialRu.items[0].qty !== 2) {
  fail(`partial receive qty must be 2, got ${JSON.stringify(partialRu?.items)}`);
}
if (!/порош/i.test(partialRu.items[0].raw_name) || !/250/i.test(partialRu.items[0].raw_name)) {
  fail(`partial receive name must keep powder 250g, got ${partialRu.items[0].raw_name}`);
}
const partialKz = parseTransferManageIntent('T000010-дан 2 дана ұнтақ ОРГ 250 г қабылда');
if (partialKz?.kind !== 'receive' || partialKz.items[0]?.qty !== 2) fail('kz partial receive qty 2');
const twoItems = parseTransferManageIntent('Прими 2 порошка ОРГ 250 г и 1 чай из T000010');
if (twoItems?.items.length !== 2 || twoItems.items[0].qty !== 2 || twoItems.items[1].qty !== 1) {
  fail(`two-item receive parse ${JSON.stringify(twoItems?.items)}`);
}
if (parseTransferManageIntent('Прими T000010')?.items.length) fail('bare receive must not invent item qty');
if (parseTransferManageIntent('Прими T000010')?.explicitAll) fail('bare receive is not take-all');
if (!parseTransferManageIntent('Прими всё из T000010')?.explicitAll) fail('explicit all remaining');
if (extractTransferManageItems('Прими 2 штуки порошка ОРГ 250 г из перемещения T000010')[0]?.qty !== 2) {
  fail('extractItems must not treat 250 g as qty');
}
if (assignManageActionQty({ kind: 'receive', remaining: 3, matchedQty: 2, takeAllRemaining: false }) !== 2) {
  fail('specified qty 2 must not become remaining 3');
}
if (assignManageActionQty({ kind: 'receive', remaining: 3, matchedQty: undefined, takeAllRemaining: false }) !== 0) {
  fail('unspecified receive must not auto-fill remaining');
}
if (assignManageActionQty({ kind: 'receive', remaining: 3, matchedQty: undefined, takeAllRemaining: true }) !== 3) {
  fail('explicit all may take remaining');
}
if (parseTransferManageIntent('Алматы → Актау\n1 порошок')) fail('create must not be manage');

const closedAndOpen = [
  {
    transfer_number: 'T000001',
    from_city_name: 'A',
    to_city_name: 'B',
    status: 'Получено',
    remaining: 0,
    created_by: 'me',
  },
  {
    transfer_number: 'T000002',
    from_city_name: 'A',
    to_city_name: 'B',
    status: 'В пути',
    remaining: 4,
    created_by: 'me',
  },
  {
    transfer_number: 'T000003',
    from_city_name: 'A',
    to_city_name: 'B',
    status: 'Закрыто с недостачей',
    remaining: 0,
    created_by: 'me',
  },
  {
    transfer_number: 'T000004',
    from_city_name: 'A',
    to_city_name: 'B',
    status: 'В пути',
    remaining: 2,
    created_by: 'other',
  },
];
const mineWaiting = filterTransferManageList(closedAndOpen, { inTransit: true, mineOnly: true, actorId: 'me' });
if (mineWaiting.map((r) => r.transfer_number).join() !== 'T000002') fail('list must keep only my remaining > 0');
if (filterTransferManageList(closedAndOpen, { inTransit: true, mineOnly: true, actorId: 'nobody' }).length) {
  fail('empty in-transit list for current user');
}
const emptyListPreview: TransferManagePreview = {
  kind: 'list',
  can_confirm: false,
  transfer_id: null,
  transfer_number: null,
  from_city_name: null,
  to_city_name: null,
  status: null,
  created_by_name: null,
  created_at: null,
  remaining: 0,
  items: [],
  events: [],
  list: [],
  empty_list_message: 'Нет ваших перемещений, ожидающих приёмки.',
  reason: null,
  errors: [],
  operation_id: 'op',
};
const emptyListMsg = buildTransferManageMessage(emptyListPreview);
if (!emptyListMsg.includes('Нет ваших перемещений, ожидающих приёмки.')) fail('empty in-transit copy');
if (/T000/.test(emptyListMsg)) fail('empty list must not show closed transfers');

const closedReceiveErrs = collectTransferManageActionErrors({
  kind: 'receive',
  remaining: 0,
  items: [{ name: 'Товар', action_qty: 0, remaining: 0 }],
  reason: null,
});
if (closedReceiveErrs.some((e) => e.code === 'items_missing')) fail('closed receive must not ask for qty');
if (closedReceiveErrs.map((e) => e.code).join() !== 'nothing_remaining') fail('closed receive only remaining error');
const closedShortageErrs = collectTransferManageActionErrors({
  kind: 'shortage',
  remaining: 0,
  items: [{ name: 'Товар', action_qty: 0, remaining: 0 }],
  reason: '',
});
if (closedShortageErrs.some((e) => e.code === 'reason_required' || e.code === 'items_missing')) {
  fail('closed shortage must not require qty or reason after remaining check');
}
if (!closedShortageErrs.some((e) => /недостач/i.test(e.message))) fail('zero remaining shortage must mention shortage');
const openReceiveErrs = collectTransferManageActionErrors({
  kind: 'receive',
  remaining: 4,
  items: [{ name: 'Товар', action_qty: 4, remaining: 4 }],
  reason: null,
});
if (openReceiveErrs.length) fail('open receive with qty must stay confirmable');
const missingQtyErrs = collectTransferManageActionErrors({
  kind: 'receive',
  remaining: 4,
  items: [{ name: 'Товар', action_qty: 0, remaining: 4 }],
  reason: null,
});
if (!missingQtyErrs.some((e) => e.code === 'items_missing')) fail('open receive still requires qty when none given');

const beforeReceive: TransferManagePreview = {
  ...emptyListPreview,
  kind: 'receive',
  remaining: 1,
  items: [
    {
      product_id: 'p1',
      name: 'Товар',
      unit: 'pcs',
      qty_sent: 1,
      qty_received: 0,
      qty_returned: 0,
      qty_lost: 0,
      remaining: 1,
      action_qty: 1,
    },
  ],
  events: [{ action: 'sent', actor_id: 'a', actor_name: 'A', created_at: '1', reason: null }],
};
const afterReceive: TransferManagePreview = {
  ...beforeReceive,
  remaining: 0,
  status: 'Получено',
  can_confirm: false,
  items: [{ ...beforeReceive.items[0], qty_received: 1, remaining: 0, action_qty: 0 }],
  events: [
    ...beforeReceive.events,
    { action: 'received_partial', actor_id: 'b', actor_name: 'B', created_at: '2', reason: null },
  ],
};
if (
  !didManageMutationApply(
    'receive',
    transferManageMutationSnapshot(beforeReceive),
    transferManageMutationSnapshot(afterReceive)
  )
) {
  fail('successful receive must count as applied');
}
if (
  didManageMutationApply(
    'receive',
    transferManageMutationSnapshot(beforeReceive),
    transferManageMutationSnapshot(beforeReceive)
  )
) {
  fail('unchanged in-transit snapshot must not look like success');
}
const alreadyClosed: TransferManagePreview = { ...afterReceive };
if (
  !didManageMutationApply(
    'receive',
    transferManageMutationSnapshot(alreadyClosed),
    transferManageMutationSnapshot(alreadyClosed)
  )
) {
  fail('idempotent replay on remaining 0 must be allowed');
}
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
const resolveSrc = read('lib/assistant/resolveTransferManage.ts');
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
if (!card.includes('к приёмке')) fail('card must show qty to receive vs remaining');
if (!card.includes('останется')) fail('card must show leftover after partial receive');
if (!card.includes('Подтвердить приёмку')) fail('explicit receive button');
if (!card.includes('Вернуть остаток отправителю')) fail('explicit return button');
if (!card.includes('Подтвердить недостачу')) fail('explicit shortage button');
if (!ui.includes('AssistantTransferManageCard')) fail('manage card in chats');
if (!ui.includes('assistant-transfer-manage')) fail('exclusive manage action');
if (!users.includes('can_manage_transfers')) fail('users UI flag');
if (!users.includes('Разрешить полное управление перемещениями')) fail('users checkbox copy');
if (panel.includes('can_manage_transfers')) fail('TransfersPanel must not grow manager flags');
if (!panel.includes('dup ? `${name} · ${short}`')) fail('admin history must distinguish duplicate display names');
if (!handle.includes('id: actor.id || null')) fail('manage resolver must receive current user id');
if (!chat.includes('id: user.id')) fail('chat must pass user id for my-transfers filter');
if (!resolveSrc.includes('intent.listFilter === \'in_transit\'') && !resolveSrc.includes('intent.listFilter === "in_transit"')) {
  fail('list must honor in-transit filter');
}
if (!resolveSrc.includes('!intent.previewOnly')) fail('informational receive must not set can_confirm');
if (!resolveSrc.includes('remaining > 0')) fail('can_confirm requires remaining in transit');
if (!resolveSrc.includes('assignManageActionQty')) fail('receive qty must come from assignManageActionQty');
if (!resolveSrc.includes('takeAllRemaining')) fail('full remaining only when explicitly requested');
if (!manage.includes('fetchTransferManageLive')) fail('confirm must reload live transfer into the card');
if (!manage.includes('didManageMutationApply')) fail('success must require an applied mutation');
if (!manage.includes("'not_applied'")) fail('no-op RPC must not mark the card confirmed');
if (manage.includes('preview: { ...preview, can_confirm: false }')) {
  fail('must not persist the pre-receive snapshot as success');
}
const inspectT7 = read('supabase/prod/inspect_transfer_t000007.sql');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(inspectT7.replace(/--.*$/gm, ''))) {
  fail('T000007 inspect must be SELECT-only');
}
if (!inspectT7.includes("transfer_number = 'T000007'")) fail('inspect T000007');
if (!inspectT7.includes('qty_in_transit')) fail('inspect remaining');
if (!inspectT7.includes('stock_transfer_events')) fail('inspect events');
if (!inspectT7.includes("metadata->>'kind' = 'transfer_manage'")) fail('inspect assistant card snapshot');

console.log('check-assistant-transfer-manage: ok');
