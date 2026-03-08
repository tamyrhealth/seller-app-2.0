'use client';

import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import type { Profile } from '@/lib/types';
import { syncActiveSession } from '@/lib/activeSession';
import { getOrCreateDeviceId } from '@/lib/deviceId';

const DEV = process.env.NODE_ENV === 'development';

type AuthCtx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  authReady: boolean;
  refreshProfile: () => Promise<void>;
  signOut: (msg?: string) => Promise<void>;
};

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const mountedRef = useRef(true);

  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  function safeSet<T>(setter: (v: T) => void, value: T) {
    if (mountedRef.current) setter(value);
  }

  async function loadProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, role, city_id, is_active')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return (data as Profile) ?? null;
  }

  async function refreshProfile() {
    if (DEV) console.log('[auth] refreshProfile start');
    safeSet(setLoading, true);
    try {
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      const u = s?.user ?? null;
      safeSet(setSession, s ?? null);
      safeSet(setUser, u);
      if (DEV) console.log('[auth] getSession done', { hasSession: !!s });

      if (!u?.id) {
        safeSet(setProfile, null);
        return;
      }
      const p = await loadProfile(u.id);
      safeSet(setProfile, p);
      if (DEV) console.log('[auth] profile loaded', !!p);
      if (p?.is_active !== false) {
        const deviceId = getOrCreateDeviceId();
        if (deviceId) void syncActiveSession(u.id, deviceId);
      }
    } catch (err) {
      if (DEV) console.log('[auth] refreshProfile error', err);
      safeSet(setProfile, null);
      safeSet(setSession, null);
      safeSet(setUser, null);
    } finally {
      safeSet(setLoading, false);
      if (DEV) console.log('[auth] refreshProfile end');
    }
  }

  async function signOut(msg?: string) {
    await supabase.auth.signOut();
    safeSet(setProfile, null);
    safeSet(setSession, null);
    safeSet(setUser, null);
    const q = msg ? `?msg=${encodeURIComponent(msg)}` : '';
    router.push(`/auth/sign-in${q}`);
  }

  useEffect(() => {
    mountedRef.current = true;
    refreshProfile();

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mountedRef.current) return;
      if (DEV) console.log('[auth] onAuthStateChange', event);

      if (event === 'SIGNED_OUT') {
        safeSet(setSession, null);
        safeSet(setUser, null);
        safeSet(setProfile, null);
        safeSet(setLoading, false);
        return;
      }
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        refreshProfile();
      }
    });

    return () => {
      mountedRef.current = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const authReady = !loading;

  return (
    <AuthContext.Provider
      value={{ session, user, profile, loading, authReady, refreshProfile, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
