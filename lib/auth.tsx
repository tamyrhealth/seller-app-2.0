'use client';

import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import type { Profile } from '@/lib/types';
import { claimActiveAuthSession, revokeOtherAuthSessions } from '@/lib/activeSession';
import { clearAllUserUi } from '@/lib/uiStorage';

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

function isAuthInvalidError(error: { message?: string; status?: number; name?: string } | null | undefined): boolean {
  if (!error) return false;
  const status = error.status;
  const msg = `${error.name || ''} ${error.message || ''}`.toLowerCase();
  if (status && status !== 401 && status !== 403) return false;
  if (/failed to fetch|network|timeout|offline|abort/.test(msg)) return false;
  if (status === 401 || status === 403) return true;
  return /invalid.*(jwt|token|claim)|token.*expired|refresh_token|not authenticated|session missing|user from session/.test(
    msg
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const mountedRef = useRef(true);
  const sessionRef = useRef<Session | null>(null);
  const userRef = useRef<User | null>(null);
  const profileRef = useRef<Profile | null>(null);
  const readyOnceRef = useRef(false);

  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  function safeSet<T>(setter: (v: T) => void, value: T) {
    if (mountedRef.current) setter(value);
  }

  function applySession(s: Session | null) {
    sessionRef.current = s;
    userRef.current = s?.user ?? null;
    safeSet(setSession, s);
    safeSet(setUser, s?.user ?? null);
  }

  function applyProfile(p: Profile | null) {
    profileRef.current = p;
    safeSet(setProfile, p);
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

  async function refreshProfile(opts?: { silent?: boolean }) {
    const hadSession = !!sessionRef.current || readyOnceRef.current;
    const silent = opts?.silent === true || hadSession;
    if (DEV) console.log('[auth] refreshProfile start', { silent });
    if (!silent) safeSet(setLoading, true);
    try {
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      const u = s?.user ?? null;
      applySession(s ?? null);
      if (DEV) console.log('[auth] getSession done', { hasSession: !!s });

      if (!u?.id) {
        applyProfile(null);
        return;
      }
      const p = await loadProfile(u.id);
      applyProfile(p);
      if (DEV) console.log('[auth] profile loaded', !!p);
      if (p?.is_active !== false) {
        const claimed = await claimActiveAuthSession();
        if (claimed === 'allowed') {
          void revokeOtherAuthSessions();
        } else if (claimed === 'denied') {
          await supabase.auth.signOut({ scope: 'local' });
          applyProfile(null);
          applySession(null);
          router.push(`/auth/sign-in?msg=${encodeURIComponent('Аккаунт открыт на другом устройстве')}`);
          return;
        }
        /* unknown / missing RPC / network: keep session, do not signOut others */
      }
    } catch (err) {
      if (DEV) console.log('[auth] refreshProfile error', err);
      if (!sessionRef.current) {
        applyProfile(null);
        applySession(null);
      }
    } finally {
      readyOnceRef.current = true;
      safeSet(setLoading, false);
      if (DEV) console.log('[auth] refreshProfile end');
    }
  }

  async function revalidateSession() {
    if (!sessionRef.current) return;
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        if (isAuthInvalidError(error)) {
          applySession(null);
          applyProfile(null);
        }
        return;
      }
      if (!data.user) {
        applySession(null);
        applyProfile(null);
        return;
      }
      if (data.user.id !== userRef.current?.id || !profileRef.current) {
        void refreshProfile({ silent: true });
      }
    } catch {
      /* keep existing session on network failure */
    }
  }

  async function signOut(msg?: string) {
    const uid = userRef.current?.id;
    await supabase.auth.signOut();
    clearAllUserUi(uid);
    applyProfile(null);
    applySession(null);
    readyOnceRef.current = true;
    safeSet(setLoading, false);
    const q = msg ? `?msg=${encodeURIComponent(msg)}` : '';
    router.push(`/auth/sign-in${q}`);
  }

  useEffect(() => {
    mountedRef.current = true;
    void refreshProfile({ silent: false });

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mountedRef.current) return;
      if (DEV) console.log('[auth] onAuthStateChange', event);

      if (event === 'SIGNED_OUT') {
        applySession(null);
        applyProfile(null);
        readyOnceRef.current = true;
        safeSet(setLoading, false);
        return;
      }

      if (event === 'TOKEN_REFRESHED') {
        if (s) applySession(s);
        return;
      }

      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'USER_UPDATED') {
        const nextId = s?.user?.id || null;
        const sameUser = !!nextId && nextId === userRef.current?.id;
        if (s) applySession(s);
        if (sameUser && profileRef.current) return;
        void refreshProfile({ silent: readyOnceRef.current });
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') void revalidateSession();
    };
    const onOnline = () => {
      void revalidateSession();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      mountedRef.current = false;
      sub.subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const authReady = !loading;

  return (
    <AuthContext.Provider
      value={{ session, user, profile, loading, authReady, refreshProfile: () => refreshProfile({ silent: true }), signOut }}
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
