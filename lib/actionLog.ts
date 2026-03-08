import type { SupabaseClient } from '@supabase/supabase-js';

export interface ActionLogParams {
  user_id?: string | null;
  user_name?: string | null;
  user_role?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Логирует действие в public.action_logs.
 * Не блокирует основную операцию — ошибки логирования игнорируются.
 */
export async function logAction(
  supabase: SupabaseClient,
  params: ActionLogParams
): Promise<void> {
  try {
    await supabase.from('action_logs').insert({
      user_id: params.user_id ?? null,
      user_name: params.user_name ?? null,
      user_role: params.user_role ?? null,
      action: params.action,
      entity_type: params.entity_type ?? null,
      entity_id: params.entity_id ?? null,
      details: params.details ?? {},
    });
  } catch {
    // Игнорируем ошибки логирования — не ломаем основной поток
  }
}
