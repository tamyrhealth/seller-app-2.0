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
 * Клиентская запись в action_logs закрыта (этап 5.4.2).
 * История заказов пишется только SECURITY DEFINER SQL (`log_order_action`).
 */
export async function logAction(
  _supabase: SupabaseClient,
  _params: ActionLogParams
): Promise<void> {
  return;
}
