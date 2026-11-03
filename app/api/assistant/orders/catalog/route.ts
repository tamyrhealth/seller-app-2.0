import { NextResponse } from 'next/server';
import { isAssistantRole } from '@/lib/roles';
import { createUserClient, readBearerToken } from '@/lib/assistant/supabaseServer';

export const runtime = 'nodejs';

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

export async function GET(req: Request) {
  const token = readBearerToken(req);
  if (!token) return jsonError(401, 'unauthorized', 'Нужна авторизация.');
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

  const [{ data: cities }, { data: sellers }, { data: products }] = await Promise.all([
    userDb.from('cities').select('id, name, is_active').eq('is_active', true).order('name'),
    userDb.from('profiles').select('id, display_name, city_id, role, is_active').eq('role', 'seller').eq('is_active', true).order('display_name'),
    userDb.from('products').select('id, name, unit, is_active').eq('is_active', true).order('name'),
  ]);

  const cityName = new Map((cities || []).map((c) => [c.id as string, String(c.name || '')]));
  return NextResponse.json({
    ok: true,
    cities: (cities || []).map((c) => ({ id: c.id, name: c.name })),
    sellers: (sellers || [])
      .filter((s) => s.city_id)
      .map((s) => ({
        id: s.id,
        name: s.display_name || '',
        city_id: s.city_id,
        city_name: cityName.get(s.city_id as string) || '',
      })),
    products: (products || []).map((p) => ({ id: p.id, name: p.name, unit: p.unit })),
    payments: [
      { id: 'cash', label: 'Наличные' },
      { id: 'kaspi', label: 'Kaspi' },
      { id: 'card', label: 'Карта' },
      { id: 'transfer', label: 'Перевод' },
    ],
  });
}
