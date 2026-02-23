'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function HomePage() {
  const { session, profile, authReady } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authReady) return;
    if (!session || !profile) {
      router.replace('/auth/sign-in');
      return;
    }
    if (profile.role === 'admin') {
      router.replace('/admin');
    } else {
      router.replace('/seller');
    }
  }, [authReady, session, profile, router]);


  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-lg">Загрузка...</p>
    </div>
  );
}
