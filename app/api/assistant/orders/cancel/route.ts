import { NextResponse } from 'next/server';
import { isAssistantRole } from '@/lib/roles';
import { createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status });
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
  const { data: profile } = await userDb.from('profiles').select('id, role, is_active').eq('id', user.id).maybeSingle();
  if (!profile || profile.is_active === false || !isAssistantRole(profile.role)) {
    return jsonError(403, 'forbidden', 'Нет доступа.');
  }

  const { data: draft } = await userDb.from('assistant_order_drafts').select('id, owner_id').eq('id', draftId).maybeSingle();
  if (!draft) return jsonError(404, 'not_found', 'Черновик не найден.');
  if (draft.owner_id !== user.id) return jsonError(403, 'forbidden', 'Нельзя отменить чужой черновик.');

  const { data, error } = await userDb.rpc('cancel_assistant_order_draft', { p_draft_id: draftId });
  if (error) return jsonError(400, 'cancel_failed', error.message);
  return NextResponse.json({ ok: true, result: data });
}
