import { PostgrestError } from '@supabase/supabase-js';

const DEV = process.env.NODE_ENV === 'development';

export function devLog(phase: string, data?: unknown) {
  if (DEV) {
    console.log(`[auth] ${phase}`, data ?? '');
  }
}

/** Проверка, что ошибка Supabase связана с сессией/доступом (401/403, JWT expired, RLS) */
export function isSessionError(error: PostgrestError | { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = (error as PostgrestError).code ?? '';
  const msg = (error as PostgrestError).message ?? '';
  const combined = `${code} ${msg}`.toLowerCase();
  return (
    code === '401' || code === '403' ||
    combined.includes('401') || combined.includes('403') ||
    combined.includes('jwt') || combined.includes('session') ||
    combined.includes('row-level security') || combined.includes('rls')
  );
}
