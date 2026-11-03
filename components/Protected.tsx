'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';
import { checkActiveDevice } from '@/lib/activeSession';
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
  const [deviceOk, setDeviceOk] = useState<boolean | null>(null);
  const checkDoneRef = useRef(false);

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

  useEffect(() => {
    if (!authReady || !session?.user?.id || !profile || profile.is_active === false) return;
    if (role && !roleMatches(role, profile.role)) return;
    if (checkDoneRef.current) return;
    checkDoneRef.current = true;

    const deviceId = getOrCreateDeviceId();
    if (!deviceId) {
      setDeviceOk(true);
      return;
    }

    checkActiveDevice(session.user.id, deviceId).then((ok) => {
      if (ok) {
        setDeviceOk(true);
      } else {
        signOut(t('auth.deviceConflict'));
      }
    });
  }, [authReady, session?.user?.id, profile, role, signOut, t]);

  if (!authReady) {
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

  if (deviceOk === false) {
    return null;
  }

  if (deviceOk !== true) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <p className="text-lg">{t('common.loading')}</p>
      </div>
    );
  }

  return <>{children}</>;
}
