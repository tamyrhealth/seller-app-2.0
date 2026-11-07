import { NextResponse } from 'next/server';
import { isAssistantRole } from '@/lib/roles';
import { createServiceClient, createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';
import { actorCanCreateTransfer, applyTransferEdit } from '@/lib/assistant/resolveTransfer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(status: number, code: string, message: string, retryable = false) {
  return NextResponse.json({ ok: false, code, message, retryable }, { status });
}

export async function POST(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');

  let body: {
    draftId?: string;
    from_city_id?: string;
    to_city_id?: string;
    items?: { product_id?: string; qty?: number; raw_name?: string }[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid_json', 'Некорректный запрос.');
  }

  const draftId = typeof body.draftId === 'string' ? body.draftId : '';
  if (!UUID_RE.test(draftId)) return jsonError(400, 'invalid_ids', 'Некорректный идентификатор.');
  if (!UUID_RE.test(body.from_city_id || '') || !UUID_RE.test(body.to_city_id || '')) {
    return jsonError(400, 'invalid_ids', 'Выберите исходный и конечный склады.');
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  const mapped = items
    .map((row) => ({
      product_id: typeof row.product_id === 'string' ? row.product_id : '',
      qty: Number(row.qty),
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
  if (!profile || profile.is_active === false || !isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Продавец не имеет доступа к ИИ-ассистенту.');
  }
  const perm = actorCanCreateTransfer(
    profile.role as string,
    profile.can_create_transfers === true,
    (profile as { can_manage_transfers?: boolean }).can_manage_transfers === true
  );
  if (!perm.allowed) return jsonError(403, perm.code, perm.message);

  const { data: draft, error: draftErr } = await userDb
    .from('assistant_stock_transfer_drafts')
    .select('id, owner_id, status')
    .eq('id', draftId)
    .maybeSingle();
  if (draftErr) {
    if (/assistant_stock_transfer_drafts|schema cache/i.test(draftErr.message)) {
      return jsonError(503, 'sql_missing', 'Сначала примените SQL этапа 5.2.5.', true);
    }
    return jsonError(400, 'draft_error', draftErr.message, true);
  }
  if (!draft) return jsonError(404, 'not_found', 'Черновик не найден.');
  if (draft.owner_id !== user.id) return jsonError(403, 'forbidden', 'Нельзя править чужой черновик.');
  if (!['preview', 'blocked'].includes(String(draft.status))) {
    return jsonError(409, 'not_editable', 'Черновик уже нельзя изменить.');
  }

  const [{ data: cities }, { data: products }, { data: inv }] = await Promise.all([
    userDb.from('cities').select('id, name, is_active'),
    userDb.from('products').select('id, name, unit, price_retail, is_active'),
    userDb.from('inventory').select('product_id, qty_on_hand').eq('city_id', body.from_city_id),
  ]);
  const stockByProduct = new Map(
    (inv || []).map((row) => [String(row.product_id), Number(row.qty_on_hand || 0)])
  );
  const next = applyTransferEdit(
    (cities || []) as { id: string; name: string; is_active: boolean | null }[],
    (products || []) as { id: string; name: string; unit: string | null; price_retail: number | null; is_active?: boolean }[],
    stockByProduct,
    body.from_city_id as string,
    body.to_city_id as string,
    mapped,
    {
      role: profile.role as string,
      can_create_transfers: profile.can_create_transfers === true,
      can_manage_transfers: (profile as { can_manage_transfers?: boolean }).can_manage_transfers === true,
    }
  );

  let service;
  try {
    service = createServiceClient();
  } catch {
    return jsonError(503, 'missing_service_role', 'Сервер без ключа для черновика.', true);
  }
  const { error: saveErr } = await service.rpc('update_assistant_stock_transfer_draft_content', {
    p_id: draftId,
    p_owner_id: user.id,
    p_status: next.can_confirm ? 'preview' : 'blocked',
    p_can_confirm: next.can_confirm,
    p_warnings: next.warnings,
    p_errors: next.errors,
    p_resolved: next.resolved,
    p_preview: next.preview,
  });
  if (saveErr) return jsonError(400, 'save_failed', saveErr.message, true);
  return NextResponse.json({ ok: true, can_confirm: next.can_confirm, errors: next.errors });
}
