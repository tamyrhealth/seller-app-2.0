'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { checkActiveDevice, type DeviceAccess } from '@/lib/activeSession';
import { getOrCreateDeviceId } from '@/lib/deviceId';
import { homePathForRole, roleMatches } from '@/lib/roles';
import type { Role } from '@/lib/types';

interface ProtectedProps {
  children: React.ReactNode;
  role?: Role | Role[];
}

export default function Protected({ children, role }: ProtectedProps) {
  const { session, profile, authReady, refreshProfile, signOut } = useAuth();
  const router = useRouter();
  const { t } = useTranslation();
  const [deviceAccess, setDeviceAccess] = useState<DeviceAccess | 'pending'>('pending');
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!authReady) return;

    if (!session) {
      router.replace('/auth/sign-in');
      return;
    }
    if (profile && profile.is_active === false) {
      router.replace('/auth/sign-in');
      return;
    }
    if (role && profile && !roleMatches(role, profile.role)) {
      router.replace(homePathForRole(profile.role));
    }
  }, [authReady, session, profile, role, router]);

  const runDeviceCheck = useCallback(async () => {
    if (!session?.user?.id) return;
    const deviceId = getOrCreateDeviceId();
    const status = await checkActiveDevice(session.user.id, deviceId);
    if (status === 'allowed') {
      setDeviceAccess('allowed');
      return;
    }
    if (status === 'denied') {
      setDeviceAccess('denied');
      await signOut(t('auth.deviceConflict'));
      return;
    }
    if (status === 'unknown') {
      setDeviceAccess('unknown');
    }
  }, [session?.user?.id, signOut, t]);

  useEffect(() => {
    if (!authReady || !session?.user?.id || !profile || profile.is_active === false) return;
    if (role && !roleMatches(role, profile.role)) return;
    if (deviceAccess !== 'pending') return;
    void runDeviceCheck();
  }, [authReady, session?.user?.id, profile, role, deviceAccess, runDeviceCheck]);

  useEffect(() => {
    if (!session) {
      setEntered(false);
      setDeviceAccess('pending');
      return;
    }
    if (
      profile &&
      profile.is_active !== false &&
      deviceAccess === 'allowed' &&
      (!role || roleMatches(role, profile.role))
    ) {
      setEntered(true);
    }
  }, [session, profile, deviceAccess, role]);

  if (!authReady && !entered) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <p className="text-lg">Загрузка...</p>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  if (!profile) {
    if (entered) return <>{children}</>;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <p className="text-center text-gray-700">Профиль не найден</p>
        <button
          onClick={() => refreshProfile()}
          className="px-6 py-2 rounded-lg bg-blue-600 text-white font-medium"
        >
          Reload
        </button>
      </div>
    );
  }

  if (profile.is_active === false) {
    return null;
  }

  if (role && !roleMatches(role, profile.role)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <p className="text-center text-gray-700">Нет доступа</p>
        <button
          onClick={() => router.push(homePathForRole(profile.role))}
          className="px-6 py-2 rounded-lg bg-blue-600 text-white"
        >
          На главную
        </button>
      </div>
    );
  }

  if (deviceAccess === 'denied') {
    return null;
  }

  if (deviceAccess === 'unknown' && !entered) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <p className="text-center text-gray-800 max-w-md">{t('auth.deviceCheckUnknown')}</p>
        <button
          type="button"
          className="px-6 py-2 rounded-lg bg-blue-600 text-white font-medium min-h-11"
          onClick={() => {
            setDeviceAccess('pending');
          }}
        >
          {t('auth.deviceCheckRetry')}
        </button>
      </div>
    );
  }

  if (deviceAccess !== 'allowed' && !entered) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <p className="text-lg">{t('common.loading')}</p>
      </div>
    );
  }

  return <>{children}</>;
}
