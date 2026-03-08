'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';

export default function NavAdmin() {
  const { signOut } = useAuth();
  const { lang, setLang, t } = useTranslation();

  return (
    <nav className="bg-white border-b border-gray-200 p-4 flex flex-wrap gap-2 items-center">
      <Link
        href="/admin"
        className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium"
      >
        {t('admin.dashboard')}
      </Link>
      <Link
        href="/admin/orders"
        className="px-4 py-2 bg-gray-200 text-gray-900 rounded-lg font-medium hover:bg-gray-300"
      >
        {t('admin.orders')}
      </Link>
      <Link
        href="/admin/products"
        className="px-4 py-2 bg-gray-200 text-gray-900 rounded-lg font-medium hover:bg-gray-300"
      >
        {t('admin.products')}
      </Link>
      <Link
        href="/admin/locations"
        className="px-4 py-2 bg-gray-200 text-gray-900 rounded-lg font-medium hover:bg-gray-300"
      >
        {t('admin.locations')}
      </Link>
      <Link
        href="/admin/users"
        className="px-4 py-2 bg-gray-200 text-gray-900 rounded-lg font-medium hover:bg-gray-300"
      >
        {t('admin.users')}
      </Link>
      <div className="ml-auto flex items-center gap-2">
        <div className="flex rounded-full border border-gray-300 bg-white text-sm">
          <button
            type="button"
            onClick={() => setLang('kz')}
            className={`px-3 py-1.5 rounded-l-full ${lang === 'kz' ? 'bg-gray-300 text-gray-900' : 'text-gray-600 bg-white'}`}
          >
            KZ
          </button>
          <button
            type="button"
            onClick={() => setLang('ru')}
            className={`px-3 py-1.5 rounded-r-full border-l border-gray-300 ${lang === 'ru' ? 'bg-gray-300 text-gray-900' : 'text-gray-600 bg-white'}`}
          >
            RU
          </button>
        </div>
        <button
          onClick={() => signOut()}
          className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium"
        >
          {t('admin.logout')}
        </button>
      </div>
    </nav>
  );
}
