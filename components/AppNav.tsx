'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';

export type AppNavItem = {
  href: string;
  label: string;
  tone?: 'primary' | 'success' | 'neutral';
};

function linkClass(active: boolean, tone: AppNavItem['tone'] = 'neutral') {
  const base = 'rounded-lg font-medium transition-colors';
  if (tone === 'primary') {
    return `${base} bg-blue-600 text-white ${active ? 'ring-2 ring-offset-1 ring-blue-800' : 'hover:bg-blue-700'}`;
  }
  if (tone === 'success') {
    return `${base} bg-green-600 text-white ${active ? 'ring-2 ring-offset-1 ring-green-800' : 'hover:bg-green-700'}`;
  }
  return active
    ? `${base} bg-slate-900 text-white`
    : `${base} bg-gray-200 text-gray-900 hover:bg-gray-300`;
}

function isActivePath(pathname: string, href: string, items: AppNavItem[]) {
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  return !items.some(
    (item) => item.href !== href && item.href.startsWith(`${href}/`) && (pathname === item.href || pathname.startsWith(`${item.href}/`))
  );
}

function currentLabel(pathname: string, items: AppNavItem[]) {
  const hit = [...items].sort((a, b) => b.href.length - a.href.length).find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  return hit?.label ?? '';
}

export default function AppNav({ items, showLang = true }: { items: AppNavItem[]; showLang?: boolean }) {
  const pathname = usePathname() || '/';
  const { signOut } = useAuth();
  const { lang, setLang, t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const title = currentLabel(pathname, items) || t('nav.menu');

  const langSwitch = (
    <div className="flex shrink-0 rounded-full border border-gray-300 bg-white text-xs">
      <button
        type="button"
        onClick={() => setLang('kz')}
        className={`px-2.5 py-1.5 rounded-l-full ${lang === 'kz' ? 'bg-gray-300 text-gray-900' : 'text-gray-600'}`}
      >
        KZ
      </button>
      <button
        type="button"
        onClick={() => setLang('ru')}
        className={`px-2.5 py-1.5 rounded-r-full border-l border-gray-300 ${lang === 'ru' ? 'bg-gray-300 text-gray-900' : 'text-gray-600'}`}
      >
        RU
      </button>
    </div>
  );

  const logoutBtn = (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        void signOut();
      }}
      className="px-3 py-2 bg-red-600 text-white rounded-lg font-medium"
    >
      {t('nav.logout')}
    </button>
  );

  return (
    <>
      <header className="lg:hidden sticky top-0 z-40 border-b border-gray-200 bg-white pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-2 px-3">
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-900"
            aria-expanded={open}
            aria-label={open ? t('common.close') : t('nav.menu')}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="text-lg leading-none">{open ? '✕' : '☰'}</span>
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">{title}</p>
          {showLang ? langSwitch : null}
        </div>
      </header>

      <div
        className={`lg:hidden fixed inset-0 z-50 ${open ? 'pointer-events-auto' : 'pointer-events-none'}`}
      >
        <button
          type="button"
          aria-label={t('common.close')}
          className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
          onClick={() => setOpen(false)}
        />
        <aside
          className={`absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] flex-col bg-white shadow-xl transition-transform duration-200 ease-out pt-[env(safe-area-inset-top)] ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-3">
            <p className="text-sm font-semibold text-gray-900">{t('nav.menu')}</p>
            <button type="button" className="rounded-lg px-2 py-1 text-sm text-gray-600" onClick={() => setOpen(false)}>
              {t('common.close')}
            </button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            <ul className="flex flex-col gap-1.5">
              {items.map((item) => {
                const active = isActivePath(pathname, item.href, items);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={`${linkClass(active, item.tone)} block px-3 py-2.5 text-sm`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {showLang ? langSwitch : <span />}
            {logoutBtn}
          </div>
        </aside>
      </div>

      <nav className="hidden lg:flex bg-white border-b border-gray-200 px-3 py-2 flex-wrap gap-1.5 items-center">
        {items.map((item) => {
          const active = isActivePath(pathname, item.href, items);
          return (
            <Link key={item.href} href={item.href} className={`${linkClass(active, item.tone)} px-3 py-1.5 text-sm`}>
              {item.label}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          {showLang ? langSwitch : null}
          {logoutBtn}
        </div>
      </nav>
    </>
  );
}
