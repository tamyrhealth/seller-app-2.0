'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';

const FAB_SIZE = 56;
const MENU_BUTTON_SIZE = 60;
const BOTTOM_OFFSET = 16;
const SAFE_BOTTOM = 24;

export const SELLER_NAV_HEIGHT_MOBILE = FAB_SIZE + BOTTOM_OFFSET + SAFE_BOTTOM;

export default function NavSeller() {
  const { signOut } = useAuth();
  const { t, lang, setLang } = useTranslation();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const close = () => setOpen(false);

  const menuBtnClass =
    'flex items-center justify-center text-white rounded-xl text-center text-sm font-medium shadow-md active:scale-95 transition-transform';

  const items: { href: string; label: string; bg: string }[] = [
    { href: '/seller', label: t('nav.home'), bg: 'bg-blue-600' },
    { href: '/seller/new-order', label: t('nav.newOrder'), bg: 'bg-green-600' },
    { href: '/seller/orders', label: t('nav.orders'), bg: 'bg-gray-600' },
    { href: '/seller/preorders', label: t('nav.preorders'), bg: 'bg-amber-600' },
    { href: '/seller/inventory', label: t('nav.inventory'), bg: 'bg-blue-600' },
  ];

  return (
    <>
      {/* Desktop: horizontal bar */}
      <nav className="hidden md:block md:static border-b border-gray-200 bg-white">
        <div className="flex items-center justify-end gap-2 px-4 py-2">
          <button
            type="button"
            onClick={() => setLang('kz')}
            className={`px-2 py-1 rounded-l-full border border-gray-300 text-xs ${lang === 'kz' ? 'bg-gray-300 text-gray-900' : 'bg-white'}`}
          >
            KZ
          </button>
          <button
            type="button"
            onClick={() => setLang('ru')}
            className={`px-2 py-1 rounded-r-full border border-gray-300 border-l-0 text-xs ${lang === 'ru' ? 'bg-gray-300 text-gray-900' : 'bg-white'}`}
          >
            RU
          </button>
        </div>
        <div className="flex flex-wrap justify-around gap-2 px-4 py-3">
          {items.map(({ href, label, bg }) => (
            <Link
              key={href}
              href={href}
              className={`min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium ${pathname === href ? 'ring-2 ring-offset-1 ring-gray-600 ' : ''}${bg} text-white`}
            >
              {label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => signOut()}
            className="min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white"
          >
            {t('nav.logout')}
          </button>
        </div>
      </nav>

      {/* Mobile: FAB + expandable menu */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 pointer-events-none z-50 flex justify-end items-end pb-[var(--seller-nav-bottom,24px)] pr-4">
        <div className="pointer-events-auto flex flex-col items-end gap-3">
          {/* Expanded panel: 2x3 grid */}
          <div
            className={`grid grid-cols-2 gap-3 transition-all duration-200 ease-out overflow-hidden ${
              open ? 'opacity-100 max-h-[400px] mb-2' : 'opacity-0 max-h-0 mb-0 pointer-events-none'
            }`}
          >
            {items.map(({ href, label, bg }) => (
              <Link
                key={href}
                href={href}
                onClick={close}
                className={`${menuBtnClass} ${bg} min-h-[60px] min-w-[60px] w-[60px] h-[60px] ${pathname === href ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-200' : ''}`}
              >
                <span className="truncate px-1 text-xs sm:text-sm">{label}</span>
              </Link>
            ))}
            <button
              type="button"
              onClick={() => {
                close();
                signOut();
              }}
              className={`${menuBtnClass} bg-red-600 min-h-[60px] min-w-[60px] w-[60px] h-[60px]`}
            >
              <span className="truncate px-1 text-xs sm:text-sm">{t('nav.logout')}</span>
            </button>
          </div>
          {/* FAB */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center justify-center w-14 h-14 rounded-full bg-gray-600 text-white shadow-lg active:scale-95 transition-transform"
            style={{ minWidth: FAB_SIZE, minHeight: FAB_SIZE }}
            aria-label={t('nav.menu')}
          >
            <span className="text-lg font-medium">{open ? '✕' : '☰'}</span>
          </button>
        </div>
      </div>

      {/* Mobile: overlay when menu open */}
      {open && (
        <button
          type="button"
          aria-label={t('common.close')}
          className="md:hidden fixed inset-0 bg-black/30 z-40"
          onClick={close}
        />
      )}

      {/* Mobile: lang switcher - in top-right of screen or inside FAB area; keep minimal */}
      <div className="md:hidden fixed top-2 right-2 z-50 flex gap-0 rounded-full border border-gray-300 bg-white shadow text-xs">
        <button
          type="button"
          onClick={() => setLang('kz')}
          className={`px-2.5 py-1.5 rounded-l-full ${lang === 'kz' ? 'bg-gray-300 text-gray-900' : ''}`}
        >
          KZ
        </button>
        <button
          type="button"
          onClick={() => setLang('ru')}
          className={`px-2.5 py-1.5 rounded-r-full border-l border-gray-300 ${lang === 'ru' ? 'bg-gray-300 text-gray-900' : ''}`}
        >
          RU
        </button>
      </div>
    </>
  );
}
