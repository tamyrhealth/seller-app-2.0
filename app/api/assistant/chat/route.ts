import { NextResponse } from 'next/server';
import { isAssistantRole } from '@/lib/roles';
import { ASSISTANT_USER_MESSAGE_MAX } from '@/lib/assistant/limits';
import { generateAssistantTurn } from '@/lib/assistant/handleTurn';
import {
  buildInvoiceDraftFingerprint,
  findReusableInvoiceDraft,
  invoiceReuseChatMessage,
  type InvoiceDraftReuseRow,
} from '@/lib/assistant/invoiceDraftFingerprint';
import { parseCancelIntent } from '@/lib/assistant/cancelIntent';
import { parseTransferIntent } from '@/lib/assistant/transferIntent';
import { parseTransferManageIntent } from '@/lib/assistant/transferManageIntent';
import { createServiceClient, createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ClaimStatus = {
  status?: string;
  assistant_message_id?: string;
  lease_id?: string;
};

function jsonError(status: number, code: string, message: string, retryable = false) {
  return NextResponse.json({ ok: false, code, message, retryable }, { status });
}

function sqlMissing(message: string) {
  return /assistant_generations|claim_assistant_generation|schema cache/i.test(message);
}

export async function POST(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');

  let body: { chatId?: string; content?: string; clientMessageId?: string; forceNewInvoiceDraft?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid_json', 'Некорректный запрос.');
  }

  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!UUID_RE.test(chatId) || !UUID_RE.test(clientMessageId)) {
    return jsonError(400, 'invalid_ids', 'Некорректный идентификатор.');
  }
  if (!content) return jsonError(400, 'empty', 'Пустое сообщение.');
  if (content.length > ASSISTANT_USER_MESSAGE_MAX) {
    return jsonError(400, 'too_long', `Сообщение длиннее ${ASSISTANT_USER_MESSAGE_MAX} символов.`);
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
    .select('id, role, is_active, can_cancel_orders, can_create_transfers, can_manage_transfers')
    .eq('id', user.id)
    .maybeSingle();
  if (profileQuery.error && /can_manage_transfers/i.test(profileQuery.error.message)) {
    profileQuery = await userDb
      .from('profiles')
      .select('id, role, is_active, can_cancel_orders, can_create_transfers')
      .eq('id', user.id)
      .maybeSingle();
  }
  if (profileQuery.error && /can_create_transfers/i.test(profileQuery.error.message)) {
    profileQuery = await userDb
      .from('profiles')
      .select('id, role, is_active, can_cancel_orders')
      .eq('id', user.id)
      .maybeSingle();
  }
  const { data: profile, error: profileErr } = profileQuery;
  if (profileErr || !profile) return jsonError(403, 'forbidden', 'Профиль недоступен.');
  if (profile.is_active === false) return jsonError(403, 'inactive', 'Учётная запись отключена.');
  if (!isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Продавец не имеет доступа к ИИ-ассистенту.');
  }

  const { data: chat, error: chatErr } = await userDb
    .from('assistant_chats')
    .select('id, owner_id, archived_at')
    .eq('id', chatId)
    .maybeSingle();
  if (chatErr) return jsonError(400, 'chat_error', chatErr.message);
  if (!chat || chat.archived_at) return jsonError(404, 'not_found', 'Диалог не найден.');
  if (chat.owner_id !== user.id) {
    return jsonError(403, 'forbidden', 'Можно писать только в свой диалог.');
  }

  const { data: inserted, error: insertErr } = await userDb
    .from('assistant_messages')
    .insert({
      chat_id: chatId,
      author_id: user.id,
      role: 'user',
      content,
      client_message_id: clientMessageId,
      metadata: { source: 'assistant_ui' },
    })
    .select('id, content')
    .maybeSingle();

  if (insertErr && insertErr.code !== '23505' && !insertErr.message.toLowerCase().includes('duplicate')) {
    return jsonError(400, 'insert_user', insertErr.message, true);
  }

  let userMessageId = inserted?.id as string | undefined;
  let storedContent = typeof inserted?.content === 'string' ? inserted.content : content;
  if (!userMessageId) {
    const { data: existing } = await userDb
      .from('assistant_messages')
      .select('id, content')
      .eq('chat_id', chatId)
      .eq('client_message_id', clientMessageId)
      .maybeSingle();
    userMessageId = existing?.id as string | undefined;
    storedContent = typeof existing?.content === 'string' ? existing.content : storedContent;
  }
  if (storedContent !== content) {
    return jsonError(409, 'message_mismatch', 'Этот запрос уже сохранён с другим текстом.', false);
  }

  const cancelIntent = parseCancelIntent(storedContent);
  const transferIntent = parseTransferIntent(storedContent);
  const transferManageIntent = parseTransferManageIntent(storedContent);
  if (!cancelIntent && !transferIntent && !transferManageIntent && !process.env.OPENAI_API_KEY) {
    return jsonError(503, 'missing_openai_key', 'Сервер без OPENAI_API_KEY. Сообщение сохранено, ответ ИИ недоступен.', true);
  }

  let service;
  try {
    service = createServiceClient();
  } catch {
    return jsonError(503, 'missing_service_role', 'Сервер без SUPABASE_SERVICE_ROLE_KEY. Сообщение сохранено.', true);
  }

  const { data: claimRaw, error: claimErr } = await service.rpc('claim_assistant_generation', {
    p_chat_id: chatId,
    p_owner_id: user.id,
    p_request_id: clientMessageId,
    p_user_message_id: userMessageId || null,
  });
  if (claimErr) {
    if (sqlMissing(claimErr.message)) {
      return jsonError(503, 'sql_missing', 'Сначала примените SQL этапа 5.2.1. Сообщение пользователя сохранено.', true);
    }
    return jsonError(400, 'claim_failed', claimErr.message, true);
  }

  const claim = (claimRaw || {}) as ClaimStatus;
  if (claim.status === 'done') {
    return NextResponse.json({ ok: true, reused: true });
  }
  if (claim.status === 'running' || claim.status === 'busy') {
    return jsonError(409, 'busy', 'Ответ по этому диалогу ещё формируется. Подождите и обновите историю.', true);
  }
  if (claim.status === 'rate_limited') {
    return jsonError(429, 'rate_limited', 'Слишком много запросов к ИИ. Подождите несколько минут.', true);
  }
  if (claim.status !== 'claimed' || !claim.lease_id) {
    return jsonError(400, 'claim_failed', 'Не удалось начать генерацию.', true);
  }
  const leaseId = claim.lease_id;

  try {
    const { data: history } = await userDb
      .from('assistant_messages')
      .select('role, content')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
    const rows = (history || []).filter((row) => row.role === 'user' || row.role === 'assistant');
    const last = rows[rows.length - 1];
    const withoutCurrent =
      last?.role === 'user' && last.content === storedContent ? rows.slice(0, -1) : rows;
    const turn = await generateAssistantTurn(userDb, withoutCurrent, storedContent, {
      id: user.id,
      role: profile.role as string,
      can_cancel_orders: profile.can_cancel_orders === true,
      can_create_transfers: (profile as { can_create_transfers?: boolean }).can_create_transfers === true,
      can_manage_transfers: (profile as { can_manage_transfers?: boolean }).can_manage_transfers === true,
    });
    let text = turn.content;
    const forceNewInvoiceDraft = body.forceNewInvoiceDraft === true;
    let skipDraftSave = false;
    if (turn.draft && !forceNewInvoiceDraft) {
      const { data: existingDrafts } = await service
        .from('assistant_order_drafts')
        .select(
          'id, status, idempotency_key, order_id, order_number, resolved, customer_phone, created_at'
        )
        .eq('chat_id', chatId)
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      const fingerprint = buildInvoiceDraftFingerprint(turn.draft.resolved);
      const hit = findReusableInvoiceDraft((existingDrafts || []) as InvoiceDraftReuseRow[], fingerprint);
      if (hit?.row.idempotency_key) {
        turn.draft.id = hit.row.id;
        turn.draft.idempotency_key = String(hit.row.idempotency_key);
        turn.draft.reuse = hit.kind;
        turn.draft.order_id = hit.row.order_id || null;
        turn.draft.order_number = hit.row.order_number || null;
        text = invoiceReuseChatMessage(hit);
        if (hit.kind === 'confirmed') {
          turn.draft.can_confirm = false;
          skipDraftSave = true;
        } else if (hit.row.status === 'confirming') {
          skipDraftSave = true;
        }
      }
    }
    if (turn.draft && !skipDraftSave) {
      const { error: saveErr } = await service.rpc('save_assistant_order_draft', {
        p_id: turn.draft.id,
        p_chat_id: chatId,
        p_owner_id: user.id,
        p_created_by: user.id,
        p_user_message_id: userMessageId || null,
        p_status: turn.draft.status,
        p_can_confirm: turn.draft.can_confirm,
        p_warnings: turn.draft.warnings,
        p_errors: turn.draft.errors,
        p_resolved: turn.draft.resolved,
        p_preview: turn.draft.preview,
        p_customer_phone: turn.draft.customer_phone,
        p_idempotency_key: turn.draft.idempotency_key,
      });
      if (saveErr) {
        if (/draft_not_writable/i.test(saveErr.message) && turn.draft.reuse) {
          skipDraftSave = true;
        } else if (/assistant_order_drafts|save_assistant_order_draft|schema cache/i.test(saveErr.message)) {
          text += '\n\nЧерновик заказа не сохранён: сначала примените SQL этапа 5.2.2.';
          turn.draft = null;
        } else {
          throw saveErr;
        }
      }
    }
    if (turn.transfer) {
      const { error: saveErr } = await service.rpc('save_assistant_stock_transfer_draft', {
        p_id: turn.transfer.id,
        p_chat_id: chatId,
        p_owner_id: user.id,
        p_created_by: user.id,
        p_user_message_id: userMessageId || null,
        p_status: turn.transfer.status,
        p_can_confirm: turn.transfer.can_confirm,
        p_warnings: turn.transfer.warnings,
        p_errors: turn.transfer.errors,
        p_resolved: turn.transfer.resolved,
        p_preview: turn.transfer.preview,
        p_idempotency_key: turn.transfer.idempotency_key,
      });
      if (saveErr) {
        if (/assistant_stock_transfer_drafts|save_assistant_stock_transfer_draft|schema cache/i.test(saveErr.message)) {
          text += '\n\nЧерновик перемещения не сохранён: сначала примените SQL этапа 5.2.5.';
          turn.transfer = null;
        } else {
          throw saveErr;
        }
      }
    }
    const { data: assistantMessageId, error: completeErr } = await service.rpc('complete_assistant_generation', {
      p_request_id: clientMessageId,
      p_lease_id: leaseId,
      p_content: text,
    });
    if (completeErr) {
      const stale = /stale_lease|lease_expired/i.test(completeErr.message);
      if (!stale) {
        await service.rpc('fail_assistant_generation', {
          p_request_id: clientMessageId,
          p_lease_id: leaseId,
          p_error: completeErr.message,
        });
      }
      return jsonError(500, 'save_reply_failed', 'Ответ модели не сохранён. Повторите запрос.', true);
    }
    if (turn.draft && assistantMessageId) {
      await service.rpc('attach_assistant_order_draft_message', {
        p_id: turn.draft.id,
        p_assistant_message_id: assistantMessageId,
      });
      await service
        .from('assistant_messages')
        .update({
          metadata: {
            source: 'openai',
            request_id: clientMessageId,
            kind: 'order_draft',
            draft_id: turn.draft.id,
            reuse: turn.draft.reuse || null,
            order_id: turn.draft.order_id || null,
            order_number: turn.draft.order_number || null,
            replay_content: storedContent,
          },
        })
        .eq('id', assistantMessageId);
    } else if (turn.transfer && assistantMessageId) {
      await service.rpc('attach_assistant_stock_transfer_draft_message', {
        p_id: turn.transfer.id,
        p_assistant_message_id: assistantMessageId,
      });
      await service
        .from('assistant_messages')
        .update({
          metadata: {
            source: 'assistant_transfer',
            request_id: clientMessageId,
            kind: 'transfer_draft',
            draft_id: turn.transfer.id,
          },
        })
        .eq('id', assistantMessageId);
    } else if (turn.cancel && assistantMessageId) {
      await service
        .from('assistant_messages')
        .update({
          metadata: {
            source: 'assistant_cancel',
            request_id: clientMessageId,
            kind: 'cancel_preview',
            state: turn.cancel.can_cancel ? 'preview' : 'blocked',
            preview: turn.cancel,
          },
        })
        .eq('id', assistantMessageId);
    } else if (turn.transferManage && assistantMessageId) {
      await service
        .from('assistant_messages')
        .update({
          metadata: {
            source: 'assistant_transfer_manage',
            request_id: clientMessageId,
            kind: 'transfer_manage',
            state: turn.transferManage.can_confirm ? 'preview' : 'blocked',
            preview: turn.transferManage,
          },
        })
        .eq('id', assistantMessageId);
    }
    return NextResponse.json({
      ok: true,
      reused: false,
      draftId: turn.draft?.id || turn.transfer?.id || null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'openai_error';
    await service.rpc('fail_assistant_generation', {
      p_request_id: clientMessageId,
      p_lease_id: leaseId,
      p_error: message,
    });
    const retryable = !/invalid_api_key|incorrect api key/i.test(message);
    if (/timeout|ETIMEDOUT|AbortError|timed out/i.test(message)) {
      return jsonError(504, 'timeout', 'ИИ не ответил вовремя. Сообщение сохранено, можно повторить.', true);
    }
    if (/429|rate limit/i.test(message)) {
      return jsonError(429, 'openai_rate', 'Лимит OpenAI. Подождите и повторите.', true);
    }
    return jsonError(502, 'openai_error', 'ИИ временно недоступен. История не потеряна, можно повторить.', retryable);
  }
}
