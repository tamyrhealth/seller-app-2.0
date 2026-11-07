import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAssistantRole } from '@/lib/roles';
import { createServiceClient, createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';
import { actorCanManageTransfers } from '@/lib/assistant/resolveTransfer';
import type { TransferManagePreview } from '@/lib/assistant/transferManageTypes';
import { mapTransferRpcError } from '@/lib/stockTransfer';
import { transferRemaining } from '@/lib/stockTransfer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(status: number, code: string, message: string, retryable = false) {
  return NextResponse.json({ ok: false, code, message, retryable }, { status });
}

async function persistState(
  service: SupabaseClient,
  args: { chatId: string; messageId: string; state: 'confirmed' | 'dismissed'; preview?: TransferManagePreview }
) {
  const { data: msg } = await service
    .from('assistant_messages')
    .select('id, metadata')
    .eq('id', args.messageId)
    .eq('chat_id', args.chatId)
    .maybeSingle();
  if (!msg) return;
  const meta = (msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {}) as Record<string, unknown>;
  if (meta.kind !== 'transfer_manage') return;
  const preview = args.preview || (meta.preview as TransferManagePreview);
  await service
    .from('assistant_messages')
    .update({
      metadata: {
        ...meta,
        kind: 'transfer_manage',
        state: args.state,
        preview,
      },
    })
    .eq('id', msg.id);
}

export async function POST(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');

  let body: { chatId?: string; messageId?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid_json', 'Некорректный запрос.');
  }
  const action = body.action === 'dismiss' ? 'dismiss' : 'confirm';
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  if (!UUID_RE.test(chatId) || !UUID_RE.test(messageId)) {
    return jsonError(400, 'invalid_ids', 'Некорректный идентификатор.');
  }

  let userDb;
  try {
    userDb = createUserClient(token);
  } catch {
    return jsonError(500, 'config', 'Сервер не настроен.');
  }
  const { data: authData, error: authErr } = await userDb.auth.getUser(token);
  const user = authData?.user;
  if (authErr || !user?.id) return jsonError(401, 'unauthorized', 'Сессия недействительна.');
  let profileQuery = await userDb
    .from('profiles')
    .select('id, role, is_active, can_manage_transfers')
    .eq('id', user.id)
    .maybeSingle();
  if (profileQuery.error && /can_manage_transfers/i.test(profileQuery.error.message)) {
    profileQuery = await userDb
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .maybeSingle();
  }
  const { data: profile } = profileQuery;
  if (!profile || profile.is_active === false || !isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Продавец не имеет доступа к ИИ-ассистенту.');
  }

  const { data: chat } = await userDb.from('assistant_chats').select('id, owner_id').eq('id', chatId).maybeSingle();
  if (!chat || chat.owner_id !== user.id) return jsonError(403, 'forbidden', 'Можно действовать только в своём диалоге.');

  let service;
  try {
    service = createServiceClient();
  } catch {
    return jsonError(503, 'missing_service_role', 'Сервер без ключа для карточки.', true);
  }
  const { data: msg } = await service
    .from('assistant_messages')
    .select('id, metadata, chat_id')
    .eq('id', messageId)
    .eq('chat_id', chatId)
    .maybeSingle();
  if (!msg) return jsonError(404, 'not_found', 'Карточка не найдена.');
  const meta = (msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {}) as Record<string, unknown>;
  if (meta.kind !== 'transfer_manage') return jsonError(409, 'wrong_card', 'Это не карточка управления перемещением.');
  const preview = meta.preview as TransferManagePreview | undefined;
  if (!preview) return jsonError(409, 'wrong_card', 'Нет данных карточки.');
  if (meta.state === 'confirmed') return NextResponse.json({ ok: true, reused: true });
  if (meta.state === 'dismissed') {
    if (action === 'dismiss') return NextResponse.json({ ok: true, dismissed: true, reused: true });
    return jsonError(409, 'dismissed', 'Операция уже отклонена. Склад не изменён.');
  }
  if (action === 'dismiss') {
    await persistState(service, { chatId, messageId, state: 'dismissed', preview });
    return NextResponse.json({ ok: true, dismissed: true });
  }

  const perm = actorCanManageTransfers(profile.role as string, profile.can_manage_transfers === true);
  if (!perm.allowed) return jsonError(403, perm.code, perm.message);
  if (!preview.can_confirm || !preview.transfer_id || !UUID_RE.test(preview.operation_id || '')) {
    return jsonError(409, 'blocked', 'Эту операцию нельзя подтвердить.');
  }

  const { data: live } = await userDb
    .from('stock_transfer_items')
    .select('product_id, qty_sent, qty_received, qty_lost, qty_returned')
    .eq('transfer_id', preview.transfer_id);
  const remainByProduct = new Map(
    (live || []).map((row) => [
      String(row.product_id),
      transferRemaining(Number(row.qty_sent), row.qty_received, row.qty_lost, row.qty_returned),
    ])
  );
  for (const line of preview.items) {
    const remain = remainByProduct.get(line.product_id);
    if (remain == null) return jsonError(409, 'stale', 'Состав перемещения изменился. Запросите карточку заново.');
    if (line.action_qty > remain) {
      return jsonError(409, 'stale', `Актуальный остаток в пути для «${line.name}»: ${remain}.`);
    }
  }

  const items = preview.items
    .filter((line) => line.action_qty > 0)
    .map((line) => ({ product_id: line.product_id, qty: line.action_qty }));

  let rpcError = '';
  if (preview.kind === 'receive') {
    const { error } = await userDb.rpc('receive_stock_transfer', {
      p_operation_id: preview.operation_id,
      p_transfer_id: preview.transfer_id,
      p_items: items,
    });
    rpcError = error?.message || '';
  } else if (preview.kind === 'return_remainder') {
    const { error } = await userDb.rpc('cancel_stock_transfer', {
      p_operation_id: preview.operation_id,
      p_transfer_id: preview.transfer_id,
      p_reason: preview.reason || null,
    });
    rpcError = error?.message || '';
  } else if (preview.kind === 'shortage') {
    if (!preview.reason || preview.reason.trim().length < 3) {
      return jsonError(400, 'reason_required', 'Для недостачи нужна обязательная причина.');
    }
    const { error } = await userDb.rpc('write_off_stock_transfer_shortage', {
      p_operation_id: preview.operation_id,
      p_transfer_id: preview.transfer_id,
      p_items: items,
      p_reason: preview.reason.trim(),
    });
    rpcError = error?.message || '';
  } else {
    return jsonError(409, 'blocked', 'Эта карточка только для просмотра.');
  }

  if (rpcError) {
    if (/Transfer manage permission denied|Transfer permission denied|Only admin/i.test(rpcError)) {
      return jsonError(403, 'forbidden', 'Нет права управлять перемещениями (can_manage_transfers).');
    }
    return jsonError(409, 'rpc', mapTransferRpcError(rpcError), /idempotency|pending|timeout/i.test(rpcError));
  }

  await persistState(service, { chatId, messageId, state: 'confirmed', preview: { ...preview, can_confirm: false } });
  return NextResponse.json({ ok: true });
}
