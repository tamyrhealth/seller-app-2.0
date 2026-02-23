'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

type AllowedRole = 'admin' | 'seller';

interface ProtectedProps {
  children: React.ReactNode;
  role?: AllowedRole;
}

export default function Protected({ children, role }: ProtectedProps) {
  const { session, profile, authReady, refreshProfile } = useAuth();
  const router = useRouter();

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
    if (role && profile && profile.role !== role) {
      if (profile.role === 'admin') router.replace('/admin');
      else router.replace('/seller');
    }
  }, [authReady, session, profile, role, router]);

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

  if (role && profile.role !== role) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <p className="text-center text-gray-700">Нет доступа</p>
        <button
          onClick={() =>
            profile.role === 'admin' ? router.push('/admin') : router.push('/seller')
          }
          className="px-6 py-2 rounded-lg bg-blue-600 text-white"
        >
          На главную
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
