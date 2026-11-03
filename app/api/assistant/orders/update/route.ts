import { NextResponse } from 'next/server';
import { isAssistantRole } from '@/lib/roles';
import { createServiceClient, createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';
import { applyDraftEdit } from '@/lib/assistant/resolveOrder';
import type { PaymentType } from '@/lib/types';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENTS = new Set(['cash', 'kaspi', 'card', 'transfer', 'debt']);

function jsonError(status: number, code: string, message: string, retryable = false) {
  return NextResponse.json({ ok: false, code, message, retryable }, { status });
}

export async function POST(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');

  let body: {
    draftId?: string;
    seller_id?: string;
    city_id?: string;
    payment_type?: string;
    is_debt?: boolean;
    is_preorder?: boolean;
    invoice_date?: string;
    invoice_time?: string;
    pickup_date?: string;
    items?: { product_id?: string; qty?: number; is_gift?: boolean; raw_name?: string; price?: unknown; line_sum?: unknown }[];
    total_sum?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid_json', 'Некорректный запрос.');
  }

  const draftId = typeof body.draftId === 'string' ? body.draftId : '';
  if (!UUID_RE.test(draftId)) return jsonError(400, 'invalid_ids', 'Некорректный идентификатор.');
  if (!UUID_RE.test(body.seller_id || '') || !UUID_RE.test(body.city_id || '')) {
    return jsonError(400, 'invalid_ids', 'Выберите продавца и город.');
  }
  const paymentRaw = typeof body.payment_type === 'string' ? body.payment_type : '';
  const payment_type = (PAYMENTS.has(paymentRaw) ? paymentRaw : null) as PaymentType | null;
  const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  const mapped = items
    .map((row) => ({
      product_id: typeof row.product_id === 'string' ? row.product_id : '',
      qty: Number(row.qty),
      is_gift: row.is_gift === true,
      raw_name: typeof row.raw_name === 'string' ? row.raw_name.slice(0, 120) : '',
    }))
    .filter((row) => UUID_RE.test(row.product_id));
  if (!mapped.length) return jsonError(400, 'items', 'Добавьте товары из каталога.');

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
  if (!profile || profile.is_active === false || !isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Продавец не имеет доступа к ИИ-ассистенту.');
  }

  const { data: draft, error: draftErr } = await userDb
    .from('assistant_order_drafts')
    .select('id, owner_id, status, customer_phone')
    .eq('id', draftId)
    .maybeSingle();
  if (draftErr) {
    if (/assistant_order_drafts|schema cache/i.test(draftErr.message)) {
      return jsonError(503, 'sql_missing', 'Сначала примените SQL этапа 5.2.2.', true);
    }
    return jsonError(400, 'draft_error', draftErr.message, true);
  }
  if (!draft) return jsonError(404, 'not_found', 'Черновик не найден.');
  if (draft.owner_id !== user.id) return jsonError(403, 'forbidden', 'Нельзя изменить чужой черновик.');
  if (draft.status === 'confirmed' || draft.status === 'cancelled' || draft.status === 'confirming') {
    return jsonError(409, 'draft_not_editable', 'Этот черновик уже нельзя изменить.', false);
  }

  let result;
  try {
    result = await applyDraftEdit(
      userDb,
      {
        seller_id: body.seller_id as string,
        city_id: body.city_id as string,
        payment_type,
        is_debt: body.is_debt === true,
        is_preorder: body.is_preorder === true,
        invoice_date: typeof body.invoice_date === 'string' ? body.invoice_date : null,
        invoice_time: typeof body.invoice_time === 'string' ? body.invoice_time : null,
        pickup_date: typeof body.pickup_date === 'string' ? body.pickup_date : null,
        items: mapped,
      },
      typeof draft.customer_phone === 'string' ? draft.customer_phone : null
    );
  } catch (err) {
    return jsonError(500, 'resolve_failed', err instanceof Error ? err.message : 'resolve_failed', true);
  }

  let service;
  try {
    service = createServiceClient();
  } catch {
    return jsonError(503, 'missing_service_role', 'Сервер без ключа для черновика.', true);
  }

  const { error: saveErr } = await service.rpc('update_assistant_order_draft_content', {
    p_id: draftId,
    p_owner_id: user.id,
    p_status: result.can_confirm ? 'preview' : 'blocked',
    p_can_confirm: result.can_confirm,
    p_warnings: result.warnings,
    p_errors: result.errors,
    p_resolved: result.resolved,
    p_preview: result.preview,
    p_customer_phone: null,
  });
  if (saveErr) {
    if (/update_assistant_order_draft_content|schema cache/i.test(saveErr.message)) {
      return jsonError(503, 'sql_missing', 'Сначала примените SQL обновления черновиков (5.2.2b).', true);
    }
    if (/draft_not_editable/i.test(saveErr.message)) {
      return jsonError(409, 'draft_not_editable', 'Черновик уже подтверждается или закрыт.', false);
    }
    if (/not_draft_owner/i.test(saveErr.message)) {
      return jsonError(403, 'forbidden', 'Нельзя изменить чужой черновик.');
    }
    return jsonError(400, 'save_failed', saveErr.message, true);
  }

  return NextResponse.json({
    ok: true,
    can_confirm: result.can_confirm,
    errors: result.errors,
    warnings: result.warnings,
    preview: result.preview,
  });
}
