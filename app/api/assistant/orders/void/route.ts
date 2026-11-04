import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAssistantRole } from '@/lib/roles';
import { createServiceClient, createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';
import { actorCanCancel } from '@/lib/assistant/resolveCancel';
import { resolveCancelCardState } from '@/lib/assistant/cancelCardState';
import type { CancelPreview } from '@/lib/assistant/cancelTypes';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(status: number, code: string, message: string, retryable = false) {
  return NextResponse.json({ ok: false, code, message, retryable }, { status });
}

async function persistCancelCardState(
  service: SupabaseClient,
  args: { chatId: string; messageId: string; state: 'confirmed' | 'dismissed'; already?: boolean }
) {
  const { data: msg } = await service
    .from('assistant_messages')
    .select('id, metadata')
    .eq('id', args.messageId)
    .eq('chat_id', args.chatId)
    .maybeSingle();
  if (!msg) return;
  const meta = (msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {}) as Record<string, unknown>;
  if (meta.kind !== 'cancel_preview') return;
  const preview = (meta.preview && typeof meta.preview === 'object' ? meta.preview : {}) as Record<string, unknown>;
  const nextPreview =
    args.state === 'confirmed' ? { ...preview, status: 'canceled', can_cancel: false } : preview;
  await service
    .from('assistant_messages')
    .update({
      metadata: {
        ...meta,
        kind: 'cancel_preview',
        state: args.state,
        already_canceled: args.already === true,
        preview: nextPreview,
      },
    })
    .eq('id', msg.id);
}

export async function POST(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');

  let body: { orderId?: string; chatId?: string; messageId?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid_json', 'Некорректный запрос.');
  }
  const action = body.action === 'dismiss' ? 'dismiss' : 'cancel';
  const orderId = typeof body.orderId === 'string' ? body.orderId : '';
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  if (!UUID_RE.test(chatId) || (messageId && !UUID_RE.test(messageId))) {
    return jsonError(400, 'invalid_ids', 'Некорректный идентификатор.');
  }
  if (action === 'cancel' && !UUID_RE.test(orderId)) {
    return jsonError(400, 'invalid_ids', 'Некорректный идентификатор.');
  }
  if (action === 'dismiss' && !UUID_RE.test(messageId)) {
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

  const { data: profile } = await userDb
    .from('profiles')
    .select('id, role, is_active, can_cancel_orders')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || profile.is_active === false) return jsonError(403, 'forbidden', 'Профиль недоступен.');
  if (!isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Продавец не имеет доступа к ИИ-ассистенту.');
  }

  const { data: chat } = await userDb.from('assistant_chats').select('id, owner_id').eq('id', chatId).maybeSingle();
  if (!chat || chat.owner_id !== user.id) return jsonError(403, 'forbidden', 'Можно действовать только в своём диалоге.');

  let service: SupabaseClient | null = null;
  try {
    service = createServiceClient();
  } catch {
    service = null;
  }

  if (action === 'dismiss') {
    const { data: msg } = service
      ? await service.from('assistant_messages').select('id, metadata').eq('id', messageId).eq('chat_id', chatId).maybeSingle()
      : await userDb.from('assistant_messages').select('id, metadata').eq('id', messageId).eq('chat_id', chatId).maybeSingle();
    if (!msg) return jsonError(404, 'not_found', 'Карточка отмены не найдена.');
    const meta = (msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {}) as {
      kind?: string;
      state?: string;
      preview?: CancelPreview;
    };
    if (meta.kind !== 'cancel_preview' || !meta.preview) {
      return jsonError(400, 'invalid_card', 'Это не карточка отмены.');
    }
    const { data: live } = await userDb
      .from('orders')
      .select('status, preorder_status')
      .eq('id', meta.preview.order_id)
      .maybeSingle();
    const next = resolveCancelCardState({
      storedState: meta.state,
      preview: meta.preview,
      liveStatus: live?.status as string | undefined,
      livePreorderStatus: live?.preorder_status as string | undefined,
    });
    const persistState = next === 'confirmed' ? 'confirmed' : 'dismissed';
    if (!service) return jsonError(500, 'config', 'Сервер не настроен.', true);
    await persistCancelCardState(service, {
      chatId,
      messageId,
      state: persistState,
      already: persistState === 'confirmed',
    });
    return NextResponse.json({
      ok: true,
      dismissed: persistState === 'dismissed',
      already: persistState === 'confirmed',
      state: persistState,
    });
  }

  const perm = actorCanCancel(profile.role as string, profile.can_cancel_orders === true);
  if (!perm.allowed) return jsonError(403, 'cancel_forbidden', perm.message);

  const { data: order, error: orderErr } = await userDb
    .from('orders')
    .select('id, order_number, status, is_preorder, preorder_status')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) return jsonError(400, 'order_error', orderErr.message, true);
  if (!order) return jsonError(404, 'not_found', 'Заказ не найден.');

  const rpcName = profile.role === 'admin' ? 'admin_cancel_order_report' : 'cancel_order_report';
  const rpcArgs =
    profile.role === 'admin'
      ? { p_order_id: orderId, p_reason: 'ИИ-ассистент' }
      : { p_order_id: orderId };

  const { data: report, error: rpcError } = await userDb.rpc(rpcName, rpcArgs);
  if (rpcError) {
    if (/Cancel permission denied/i.test(rpcError.message)) {
      return jsonError(403, 'cancel_forbidden', 'Отмена запрещена на сервере (can_cancel_orders).', false);
    }
    if (/Not allowed|Only admin/i.test(rpcError.message)) {
      return jsonError(403, 'cancel_forbidden', rpcError.message, false);
    }
    return jsonError(400, 'cancel_failed', rpcError.message, true);
  }

  const result = (report && typeof report === 'object' ? report : {}) as {
    already_canceled?: boolean;
    returned_stock?: boolean;
    order_number?: string;
  };
  const number = result.order_number || order.order_number || orderId.slice(0, 8);
  const already = result.already_canceled === true;
  const returned = result.returned_stock === true;
  const message = already
    ? `Заказ ${number} уже отменён. Остатки повторно не начислялись.`
    : returned
      ? `Заказ ${number} отменён. Остатки возвращены.`
      : `Заказ ${number} отменён. Остатки не менялись (не были списаны).`;

  if (service) {
    if (UUID_RE.test(messageId)) {
      await persistCancelCardState(service, { chatId, messageId, state: 'confirmed', already });
    }
    await service.from('assistant_messages').insert({
      chat_id: chatId,
      author_id: null,
      role: 'assistant',
      content: message,
      client_message_id: null,
      metadata: {
        source: 'assistant_cancel',
        order_id: orderId,
        already_canceled: already,
        returned_stock: returned,
      },
    });
  }

  return NextResponse.json({ ok: true, already, returned_stock: returned, order_number: number, message });
}
