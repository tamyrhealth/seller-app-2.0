import { NextResponse } from 'next/server';
import { isAssistantRole } from '@/lib/roles';
import { createServiceClient, createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';
import { actorCanCreateTransfer, applyTransferEdit } from '@/lib/assistant/resolveTransfer';
import type { TransferResolved } from '@/lib/assistant/transferTypes';
import type { SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRM_WAIT_MS = 25000;

function jsonError(status: number, code: string, message: string, retryable = false) {
  return NextResponse.json({ ok: false, code, message, retryable }, { status });
}

function humanRpcError(message: string): string {
  if (/Account is inactive/i.test(message)) {
    return 'Учётная запись отключена.';
  }
  if (/Transfer permission denied/i.test(message)) {
    return 'Нет права создавать перемещения (can_create_transfers).';
  }
  if (/Insufficient stock/i.test(message)) {
    return 'Недостаточно остатков на исходном складе.';
  }
  if (/Inactive product/i.test(message)) {
    return 'Товар неактивен. Перемещение не создано.';
  }
  if (/Source city is inactive/i.test(message)) {
    return 'Исходный город неактивен.';
  }
  if (/Destination city is inactive/i.test(message)) {
    return 'Конечный город неактивен.';
  }
  if (/Invalid qty/i.test(message)) {
    return 'Некорректное количество. Для штучных товаров нужны целые числа, для кг — до 3 знаков.';
  }
  return message;
}

type DraftRow = {
  id: string;
  chat_id: string;
  owner_id: string;
  status: string;
  can_confirm: boolean;
  resolved: TransferResolved;
  idempotency_key: string;
  transfer_id: string | null;
  transfer_number: string | null;
  preview: { from_city_name?: string | null; to_city_name?: string | null; items?: unknown };
};

type TransferRow = {
  id: string;
  transfer_number?: string | null;
  status?: string | null;
};

async function loadDraft(userDb: SupabaseClient, draftId: string) {
  const { data, error } = await userDb
    .from('assistant_stock_transfer_drafts')
    .select(
      'id, chat_id, owner_id, status, can_confirm, resolved, idempotency_key, transfer_id, transfer_number, preview'
    )
    .eq('id', draftId)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as DraftRow | null;
}

async function loadTransfer(userDb: SupabaseClient, transferId: string) {
  const { data } = await userDb
    .from('stock_transfers')
    .select('id, transfer_number, status')
    .eq('id', transferId)
    .maybeSingle();
  return data as TransferRow | null;
}

function successBody(transfer: TransferRow, reused: boolean, preview: DraftRow['preview']) {
  const number = transfer.transfer_number || transfer.id.slice(0, 8);
  return {
    ok: true,
    reused,
    pending: false,
    transfer_id: transfer.id,
    transfer_number: number,
    status: transfer.status || 'in_transit',
    from_city_name: preview?.from_city_name || null,
    to_city_name: preview?.to_city_name || null,
    items: preview?.items || [],
    message: `Перемещение ${number} отправлено`,
  };
}

async function insertResultMessage(
  service: SupabaseClient,
  draft: DraftRow,
  transfer: TransferRow,
  reused: boolean
) {
  const number = transfer.transfer_number || transfer.id.slice(0, 8);
  const { error } = await service.from('assistant_messages').insert({
    chat_id: draft.chat_id,
    author_id: null,
    role: 'assistant',
    content: `Перемещение ${number} отправлено.`,
    client_message_id: draft.idempotency_key,
    metadata: { source: 'assistant_transfer', draft_id: draft.id, reused },
  });
  if (error && error.code !== '23505' && !/duplicate/i.test(error.message)) {
    throw error;
  }
}

async function finalizeExisting(
  service: SupabaseClient,
  userId: string,
  draft: DraftRow,
  transfer: TransferRow
) {
  await service.rpc('finalize_assistant_stock_transfer_draft', {
    p_id: draft.id,
    p_owner_id: userId,
    p_transfer_id: transfer.id,
    p_transfer_number: transfer.transfer_number,
    p_confirmed_by: userId,
  });
  await insertResultMessage(service, draft, transfer, true);
  return NextResponse.json(successBody(transfer, true, draft.preview));
}

async function findTransferByOperation(
  userDb: SupabaseClient,
  actorId: string,
  operationId: string
) {
  const { data } = await userDb
    .from('client_operations')
    .select('entity_id, result')
    .eq('actor_id', actorId)
    .eq('operation_id', operationId)
    .maybeSingle();
  const fromEntity = typeof data?.entity_id === 'string' ? data.entity_id : '';
  const fromResult =
    data?.result && typeof data.result === 'object' && data.result !== null && 'id' in data.result
      ? String((data.result as { id?: string }).id || '')
      : '';
  const id = fromEntity || fromResult;
  if (!id) return null;
  return loadTransfer(userDb, id);
}

async function recoverCreatedTransfer(
  userDb: SupabaseClient,
  service: SupabaseClient,
  userId: string,
  draft: DraftRow,
  hintedId?: string | null
) {
  if (hintedId) {
    const byId = await loadTransfer(userDb, hintedId);
    if (byId) return finalizeExisting(service, userId, draft, byId);
  }
  if (draft.transfer_id) {
    const byDraft = await loadTransfer(userDb, draft.transfer_id);
    if (byDraft) return finalizeExisting(service, userId, draft, byDraft);
  }
  const byKey = await findTransferByOperation(userDb, userId, draft.idempotency_key);
  if (byKey) return finalizeExisting(service, userId, draft, byKey);
  return null;
}

async function revalidate(userDb: SupabaseClient, resolved: TransferResolved, actor: {
  role: string | null;
  can_create_transfers: boolean;
  can_manage_transfers?: boolean;
}) {
  const [{ data: cities }, { data: products }] = await Promise.all([
    userDb.from('cities').select('id, name, is_active'),
    userDb.from('products').select('id, name, unit, price_retail, is_active'),
  ]);
  let stockByProduct = new Map<string, number>();
  if (resolved.from_city_id) {
    const { data: inv } = await userDb
      .from('inventory')
      .select('product_id, qty_on_hand')
      .eq('city_id', resolved.from_city_id);
    stockByProduct = new Map(
      (inv || []).map((row) => [String(row.product_id), Number(row.qty_on_hand || 0)])
    );
  }
  return applyTransferEdit(
    (cities || []) as { id: string; name: string; is_active: boolean | null }[],
    (products || []) as { id: string; name: string; unit: string | null; price_retail: number | null; is_active?: boolean }[],
    stockByProduct,
    resolved.from_city_id || '',
    resolved.to_city_id || '',
    (resolved.items || [])
      .filter((i) => i.product_id)
      .map((i) => ({ product_id: i.product_id as string, qty: i.qty, raw_name: i.raw_name })),
    actor
  );
}

export async function POST(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');

  let body: { draftId?: string };
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

  let profileQuery = await userDb
    .from('profiles')
    .select('id, role, is_active, can_create_transfers, can_manage_transfers')
    .eq('id', user.id)
    .maybeSingle();
  if (profileQuery.error && /can_manage_transfers/i.test(profileQuery.error.message)) {
    profileQuery = await userDb
      .from('profiles')
      .select('id, role, is_active, can_create_transfers')
      .eq('id', user.id)
      .maybeSingle();
  }
  const { data: profile } = profileQuery;
  if (!profile || profile.is_active === false) return jsonError(403, 'forbidden', 'Профиль недоступен.');
  if (!isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Продавец не имеет доступа к ИИ-ассистенту.');
  }
  const perm = actorCanCreateTransfer(
    profile.role as string,
    profile.can_create_transfers === true,
    (profile as { can_manage_transfers?: boolean }).can_manage_transfers === true
  );
  if (!perm.allowed) return jsonError(403, perm.code, perm.message);

  let draft: DraftRow | null;
  try {
    draft = await loadDraft(userDb, draftId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'draft_error';
    if (/assistant_stock_transfer_drafts|schema cache/i.test(message)) {
      return jsonError(503, 'sql_missing', 'Сначала примените SQL этапа 5.2.5.', true);
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

  const recoveredFirst = await recoverCreatedTransfer(userDb, service, user.id, draft, draft.transfer_id);
  if (recoveredFirst) return recoveredFirst;

  const { data: beginRaw, error: beginErr } = await userDb.rpc('begin_assistant_stock_transfer_confirm', {
    p_draft_id: draftId,
  });
  if (beginErr) {
    const recovered = await recoverCreatedTransfer(userDb, service, user.id, draft);
    if (recovered) return recovered;
    return jsonError(400, 'not_confirmable', humanRpcError(beginErr.message), false);
  }
  const begin = (beginRaw || {}) as { status?: string; transfer_id?: string; transfer_number?: string };
  const live = (await loadDraft(userDb, draftId)) || draft;
  const recoveredAfterBegin = await recoverCreatedTransfer(
    userDb,
    service,
    user.id,
    live,
    begin.transfer_id || live.transfer_id
  );
  if (recoveredAfterBegin) return recoveredAfterBegin;

  const check = await revalidate(userDb, live.resolved, {
    role: profile.role as string,
    can_create_transfers: profile.can_create_transfers === true,
    can_manage_transfers: (profile as { can_manage_transfers?: boolean }).can_manage_transfers === true,
  });
  if (!check.can_confirm) {
    const recovered = await recoverCreatedTransfer(userDb, service, user.id, live);
    if (recovered) return recovered;
    await service.rpc('fail_assistant_stock_transfer_confirm', {
      p_id: draftId,
      p_owner_id: user.id,
      p_errors: check.errors,
      p_can_confirm: false,
    });
    return NextResponse.json(
      {
        ok: false,
        code: 'stale',
        message: check.errors[0]?.message || 'Данные перемещения изменились. Отправьте накладную заново.',
        errors: check.errors,
        retryable: false,
      },
      { status: 409 }
    );
  }

  const rpcPromise = Promise.resolve(
    userDb.rpc('create_stock_transfer', {
      p_operation_id: live.idempotency_key,
      p_from_city_id: check.resolved.from_city_id,
      p_to_city_id: check.resolved.to_city_id,
      p_items: check.resolved.items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
      p_comment: check.resolved.comment,
    })
  );
  void rpcPromise.catch(() => undefined);
  const raced = await Promise.race([
    rpcPromise.then((res) => ({ kind: 'ok' as const, res })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), CONFIRM_WAIT_MS);
    }),
  ]);

  if (raced.kind === 'timeout') {
    const recovered = await recoverCreatedTransfer(userDb, service, user.id, live);
    if (recovered) return recovered;
    return NextResponse.json(
      {
        ok: false,
        code: 'pending',
        pending: true,
        retryable: true,
        message:
          'Отправка ещё обрабатывается. Повторите подтверждение — повторный запрос с тем же ключом новое перемещение не создаст.',
      },
      { status: 202 }
    );
  }

  const { data: created, error: rpcError } = raced.res;
  if (rpcError) {
    const recovered = await recoverCreatedTransfer(userDb, service, user.id, live);
    if (recovered) return recovered;
    await service.rpc('fail_assistant_stock_transfer_confirm', {
      p_id: draftId,
      p_owner_id: user.id,
      p_errors: [{ code: 'confirm_failed', message: humanRpcError(rpcError.message) }],
      p_can_confirm: /Insufficient stock|Inactive product|Transfer permission denied/i.test(rpcError.message)
        ? false
        : live.can_confirm,
    });
    return jsonError(400, 'confirm_failed', humanRpcError(rpcError.message), true);
  }
  const row = created as { id?: string; transfer_number?: string; status?: string } | null;
  if (!row?.id) {
    const recovered = await recoverCreatedTransfer(userDb, service, user.id, live);
    if (recovered) return recovered;
    return jsonError(500, 'confirm_empty', 'create_stock_transfer не вернул перемещение.', true);
  }

  const transfer = (await loadTransfer(userDb, row.id)) || {
    id: row.id,
    transfer_number: row.transfer_number,
    status: row.status || 'in_transit',
  };
  await service.rpc('finalize_assistant_stock_transfer_draft', {
    p_id: draftId,
    p_owner_id: user.id,
    p_transfer_id: transfer.id,
    p_transfer_number: transfer.transfer_number,
    p_confirmed_by: user.id,
  });
  await insertResultMessage(service, live, transfer, false);
  return NextResponse.json(successBody(transfer, false, live.preview));
}
