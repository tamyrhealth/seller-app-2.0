'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { sessionScrollStore } from '@/lib/uiStorage';

function scrollKey(userId: string, path: string) {
  return `tamyr.scroll.v1.${userId}.${path}`;
}

function readScroll(userId: string, path: string): number | null {
  const raw = sessionScrollStore()?.getItem(scrollKey(userId, path));
  if (!raw) return null;
  const y = Number(raw);
  return Number.isFinite(y) ? y : null;
}

function writeScroll(userId: string, path: string, y: number) {
  sessionScrollStore()?.setItem(scrollKey(userId, path), String(Math.max(0, Math.round(y))));
}

export default function ClientUiStability() {
  const pathname = usePathname() || '/';
  const { profile } = useAuth();
  const userId = profile?.id;
  const pathRef = useRef(pathname);
  const skipRestoreRef = useRef(false);
  pathRef.current = pathname;

  useEffect(() => {
    if (typeof window === 'undefined' || !('scrollRestoration' in window.history)) return;
    window.history.scrollRestoration = 'auto';
  }, []);

  useEffect(() => {
    const onPop = () => {
      skipRestoreRef.current = true;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!userId) return;
    if (skipRestoreRef.current) {
      skipRestoreRef.current = false;
      return;
    }
    const saved = readScroll(userId, pathname);
    const restore = () => {
      if (saved == null) return;
      window.scrollTo(0, saved);
      document.querySelectorAll<HTMLElement>('[data-scroll-persist]').forEach((el) => {
        const id = el.getAttribute('data-scroll-persist');
        if (!id) return;
        const inner = sessionScrollStore()?.getItem(`${scrollKey(userId, pathname)}:${id}`);
        if (inner) el.scrollTop = Number(inner) || 0;
      });
    };
    const raf = window.requestAnimationFrame(restore);
    const t = window.setTimeout(restore, 50);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [pathname, userId]);

  useEffect(() => {
    if (!userId) return;
    const persist = () => {
      writeScroll(userId, pathRef.current, window.scrollY || window.pageYOffset || 0);
      document.querySelectorAll<HTMLElement>('[data-scroll-persist]').forEach((el) => {
        const id = el.getAttribute('data-scroll-persist');
        if (!id) return;
        sessionScrollStore()?.setItem(`${scrollKey(userId, pathRef.current)}:${id}`, String(el.scrollTop || 0));
      });
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') persist();
    };
    window.addEventListener('scroll', persist, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', persist);
    return () => {
      persist();
      window.removeEventListener('scroll', persist);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', persist);
    };
  }, [userId, pathname]);

  return null;
}
