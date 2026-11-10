'use client';

import { useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { checkActiveDevice } from '@/lib/activeSession';
import { getOrCreateDeviceId } from '@/lib/deviceId';

/**
 * Хук для проверки активного устройства перед критичными действиями.
 * Возвращает функцию ensureActive: () => Promise<boolean>.
 * DENIED — signOut. UNKNOWN — false без выхода. ALLOWED — true.
 */
export function useEnsureActiveDevice() {
  const { session, signOut } = useAuth();
  const { t } = useTranslation();

  return useCallback(async (): Promise<boolean> => {
    const userId = session?.user?.id;
    const deviceId = getOrCreateDeviceId();
    if (!userId) return false;
    if (!deviceId) {
      if (typeof window !== 'undefined') window.alert(t('auth.deviceCheckUnknown'));
      return false;
    }
    const status = await checkActiveDevice(userId, deviceId);
    if (status === 'allowed') return true;
    if (status === 'denied') {
      await signOut(t('auth.deviceConflict'));
      return false;
    }
    if (status === 'unknown') {
      if (typeof window !== 'undefined') window.alert(t('auth.deviceCheckUnknown'));
      return false;
    }
    return false;
  }, [session?.user?.id, signOut, t]);
}
