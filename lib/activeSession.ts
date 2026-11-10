'use client';

import { supabase } from '@/lib/supabaseClient';
import { interpretActiveDeviceQuery, type DeviceAccess } from '@/lib/deviceAccess';

export type { DeviceAccess };
export { interpretActiveDeviceQuery };

/**
 * Синхронизирует активное устройство пользователя.
 * Если записи нет — создаёт, если есть — обновляет device_id и last_seen_at.
 * При входе с нового устройства перезаписывает device_id, старое устройство перестаёт быть активным.
 */
export async function syncActiveSession(userId: string, deviceId: string): Promise<void> {
  if (!userId || !deviceId) return;
  await supabase
    .from('user_active_sessions')
    .upsert(
      {
        user_id: userId,
        device_id: deviceId,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
}

/**
 * Проверяет, является ли текущее устройство активным для пользователя.
 */
export async function checkActiveDevice(userId: string, deviceId: string): Promise<DeviceAccess> {
  try {
    if (!userId) return 'denied';
    if (!deviceId) return 'unknown';
    const { data, error } = await supabase
      .from('user_active_sessions')
      .select('device_id')
      .eq('user_id', userId)
      .maybeSingle();

    return interpretActiveDeviceQuery({
      userId,
      deviceId,
      rowDeviceId: data?.device_id,
      error: error ? { message: error.message, code: error.code } : null,
    });
  } catch {
    return 'unknown';
  }
}
