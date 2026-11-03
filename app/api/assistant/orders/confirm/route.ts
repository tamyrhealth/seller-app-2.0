import { NextResponse } from 'next/server';
import { isAssistantRole } from '@/lib/roles';
import { createServiceClient, createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';
import { revalidateResolved } from '@/lib/assistant/resolveOrder';
import type { DraftResolved } from '@/lib/assistant/orderDraftTypes';
import type { SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRM_WAIT_MS = 25000;

function jsonError(status: number, code: string, message: string, retryable = false) {
  return NextResponse.json({ ok: false, code, message, retryable }, { status });
}

type DraftRow = {
  id: string;
  chat_id: string;
  owner_id: string;
  status: string;
  can_confirm: boolean;
  resolved: DraftResolved;
  customer_phone: string | null;
  idempotency_key: string;
  order_id: string | null;
  order_number: string | null;
  preview: { seller_name?: string | null; city_name?: string | null; items?: unknown; total_sum?: number };
};

type OrderRow = {
  id: string;
  order_number?: string | null;
  status?: string | null;
  total_sum?: number | null;
};

async function loadDraft(userDb: SupabaseClient, draftId: string) {
  const { data, error } = await userDb
    .from('assistant_order_drafts')
    .select(
      'id, chat_id, owner_id, status, can_confirm, resolved, customer_phone, idempotency_key, order_id, order_number, preview'
    )
    .eq('id', draftId)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as DraftRow | null;
}

async function loadOrder(userDb: SupabaseClient, orderId: string) {
  const { data } = await userDb
    .from('orders')
    .select('id, order_number, status, total_sum, payment_type, is_preorder, is_debt, city_id, seller_id')
    .eq('id', orderId)
    .maybeSingle();
  return data as OrderRow | null;
}

async function findOrderByKey(userDb: SupabaseClient, actorId: string, key: string) {
  const { data } = await userDb
    .from('orders')
    .select('id, order_number, status, total_sum, payment_type, is_preorder, is_debt')
    .eq('idempotency_key', key)
    .eq('idempotency_actor_id', actorId)
    .maybeSingle();
  return data as OrderRow | null;
}

function successBody(order: OrderRow, reused: boolean, preview: DraftRow['preview']) {
  const number = order.order_number || order.id.slice(0, 8);
  return {
    ok: true,
    reused,
    pending: false,
    order_id: order.id,
    order_number: number,
    status: order.status || 'confirmed',
    total_sum: Number(order.total_sum || 0),
    seller_name: preview?.seller_name || null,
    city_name: preview?.city_name || null,
    items: preview?.items || [],
    message: `Заказ ${number} успешно создан`,
  };
}

async function insertResultMessage(
  service: SupabaseClient,
  draft: DraftRow,
  order: OrderRow,
  reused: boolean
) {
  const number = order.order_number || order.id.slice(0, 8);
  const { error } = await service.from('assistant_messages').insert({
    chat_id: draft.chat_id,
    author_id: null,
    role: 'assistant',
    content: `Заказ ${number} успешно создан.`,
    client_message_id: draft.idempotency_key,
    metadata: { source: 'assistant_order', draft_id: draft.id, reused },
  });
  if (error && error.code !== '23505' && !/duplicate/i.test(error.message)) {
    throw error;
  }
}

async function finalizeExisting(
  service: SupabaseClient,
  userId: string,
  draft: DraftRow,
  order: OrderRow
) {
  await service.rpc('finalize_assistant_order_draft', {
    p_id: draft.id,
    p_owner_id: userId,
    p_order_id: order.id,
    p_order_number: order.order_number,
    p_confirmed_by: userId,
  });
  await insertResultMessage(service, draft, order, true);
  return NextResponse.json(successBody(order, true, draft.preview));
}

/** Recover a completed confirm_order before re-checking prices/stock. */
async function recoverCreatedOrder(
  userDb: SupabaseClient,
  service: SupabaseClient,
  userId: string,
  draft: DraftRow,
  hintedOrderId?: string | null
) {
  const key = String(draft.idempotency_key);
  if (hintedOrderId) {
    const byId = await loadOrder(userDb, hintedOrderId);
    if (byId) return finalizeExisting(service, userId, draft, byId);
  }
  if (draft.order_id) {
    const byDraft = await loadOrder(userDb, draft.order_id);
    if (byDraft) return finalizeExisting(service, userId, draft, byDraft);
  }
  const byKey = await findOrderByKey(userDb, userId, key);
  if (byKey) return finalizeExisting(service, userId, draft, byKey);
  return null;
}

export async function POST(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');

  let body: { draftId?: string; seller_id?: unknown; city_id?: unknown; total_sum?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid_json', 'Некорректный запрос.');
  }
  const draftId = typeof body.draftId === 'string' ? body.draftId : '';
  if (!UUID_RE.test(draftId)) return jsonError(400, 'invalid_ids', 'Некорректный идентификатор.');

  let userDb;
  try {
    userDb = createUserClient(token);
  } catch {
    return jsonError(500, 'config', 'Сервер не настроен.');
  }

  const { data: authData, error: authErr } = await userDb.auth.getUser(token);
  const user = authData?.user;
  if (authErr || !user?.id) return jsonError(401, 'unauthorized', 'Сессия недействительна.');

  const { data: profile } = await userDb.from('profiles').select('id, role, is_active').eq('id', user.id).maybeSingle();
  if (!profile || profile.is_active === false) return jsonError(403, 'forbidden', 'Профиль недоступен.');
  if (!isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Продавец не имеет доступа к ИИ-ассистенту.');
  }

  let draft: DraftRow | null;
  try {
    draft = await loadDraft(userDb, draftId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'draft_error';
    if (/assistant_order_drafts|schema cache/i.test(message)) {
      return jsonError(503, 'sql_missing', 'Сначала примените SQL этапа 5.2.2.', true);
    }
    return jsonError(400, 'draft_error', message, true);
  }
  if (!draft) return jsonError(404, 'not_found', 'Черновик не найден.');
  if (draft.owner_id !== user.id) {
    return jsonError(403, 'forbidden', 'Нельзя подтвердить чужой черновик.');
  }

  let service;
  try {
    service = createServiceClient();
  } catch {
    return jsonError(503, 'missing_service_role', 'Сервер без ключа для черновика.', true);
  }

  const recoveredFirst = await recoverCreatedOrder(userDb, service, user.id, draft, draft.order_id);
  if (recoveredFirst) return recoveredFirst;

  const { data: beginRaw, error: beginErr } = await userDb.rpc('begin_assistant_order_confirm', {
    p_draft_id: draftId,
  });
  if (beginErr) {
    const recovered = await recoverCreatedOrder(userDb, service, user.id, draft);
    if (recovered) return recovered;
    return jsonError(400, 'not_confirmable', beginErr.message, false);
  }
  const begin = (beginRaw || {}) as { status?: string; order_id?: string; order_number?: string };

  const live = (await loadDraft(userDb, draftId)) || draft;
  const recoveredAfterBegin = await recoverCreatedOrder(
    userDb,
    service,
    user.id,
    live,
    begin.order_id || live.order_id
  );
  if (recoveredAfterBegin) return recoveredAfterBegin;

  let check;
  try {
    check = await revalidateResolved(userDb, live.resolved, live.customer_phone);
  } catch (err) {
    return jsonError(500, 'revalidate_failed', err instanceof Error ? err.message : 'revalidate_failed', true);
  }

  if (!check.ok || !check.payload) {
    const recovered = await recoverCreatedOrder(userDb, service, user.id, live);
    if (recovered) return recovered;
    await service.rpc('fail_assistant_order_confirm', {
      p_id: draftId,
      p_owner_id: user.id,
      p_errors: check.errors,
      p_can_confirm: false,
    });
    return NextResponse.json(
      {
        ok: false,
        code: 'stale',
        message: check.errors[0]?.message || 'Данные заказа изменились. Отправьте накладную заново.',
        errors: check.errors,
        retryable: false,
      },
      { status: 409 }
    );
  }

  const payload = {
    ...check.payload,
    idempotency_key: String(live.idempotency_key),
  };

  const rpcPromise = Promise.resolve(userDb.rpc('confirm_order', { payload }));
  void rpcPromise.catch(() => undefined);
  const raced = await Promise.race([
    rpcPromise.then((res) => ({ kind: 'ok' as const, res })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), CONFIRM_WAIT_MS);
    }),
  ]);

  if (raced.kind === 'timeout') {
    const recovered = await recoverCreatedOrder(userDb, service, user.id, live);
    if (recovered) return recovered;
    return NextResponse.json(
      {
        ok: false,
        code: 'pending',
        pending: true,
        retryable: true,
        message:
          'Заказ ещё обрабатывается. Статус неизвестен — повторите подтверждение, новый заказ из-за этого не создастся.',
      },
      { status: 202 }
    );
  }

  const { data: orderId, error: rpcError } = raced.res;
  if (rpcError) {
    const recovered = await recoverCreatedOrder(userDb, service, user.id, live);
    if (recovered) return recovered;
    await service.rpc('fail_assistant_order_confirm', {
      p_id: draftId,
      p_owner_id: user.id,
      p_errors: [{ code: 'confirm_failed', message: rpcError.message }],
      p_can_confirm: /Insufficient stock|Idempotency key reused/i.test(rpcError.message)
        ? false
        : live.can_confirm,
    });
    return jsonError(400, 'confirm_failed', rpcError.message, true);
  }
  if (!orderId || typeof orderId !== 'string') {
    const recovered = await recoverCreatedOrder(userDb, service, user.id, live);
    if (recovered) return recovered;
    return jsonError(500, 'confirm_empty', 'confirm_order не вернул заказ.', true);
  }

  const order = (await loadOrder(userDb, orderId)) || {
    id: orderId,
    order_number: null,
    status: 'confirmed',
    total_sum: live.preview?.total_sum || 0,
  };
  await service.rpc('finalize_assistant_order_draft', {
    p_id: draftId,
    p_owner_id: user.id,
    p_order_id: order.id,
    p_order_number: order.order_number,
    p_confirmed_by: user.id,
  });
  await insertResultMessage(service, live, order, false);
  return NextResponse.json(successBody(order, false, live.preview));
}
