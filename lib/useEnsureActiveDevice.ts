'use client';

import { useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { checkActiveDevice } from '@/lib/activeSession';
import { getOrCreateDeviceId } from '@/lib/deviceId';

/**
 * Хук для проверки активного устройства перед критичными действиями.
 * Возвращает функцию ensureActive: () => Promise<boolean>.
 * Если устройство неактивно — выполняет signOut и возвращает false.
 */
export function useEnsureActiveDevice() {
  const { session, signOut } = useAuth();
  const { t } = useTranslation();

  return useCallback(async (): Promise<boolean> => {
    const userId = session?.user?.id;
    const deviceId = getOrCreateDeviceId();
    if (!userId || !deviceId) return true;
    const ok = await checkActiveDevice(userId, deviceId);
    if (!ok) {
      signOut(t('auth.deviceConflict'));
      return false;
    }
    return true;
  }, [session?.user?.id, signOut, t]);
}
