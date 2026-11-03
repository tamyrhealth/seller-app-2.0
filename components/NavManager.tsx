'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';

export default function NavManager() {
  const { signOut } = useAuth();
  const { t } = useTranslation();

  return (
    <nav className="bg-white border-b border-gray-200 p-4 flex flex-wrap gap-2 items-center">
      <Link href="/manager" className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium">
        {t('manager.home')}
      </Link>
      <Link
        href="/manager/new-order"
        className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
      >
        Новый заказ
      </Link>
      <Link
        href="/manager/orders"
        className="px-4 py-2 bg-gray-200 text-gray-900 rounded-lg font-medium hover:bg-gray-300"
      >
        {t('admin.orders')}
      </Link>
      <Link
        href="/manager/inventory"
        className="px-4 py-2 bg-gray-200 text-gray-900 rounded-lg font-medium hover:bg-gray-300"
      >
        {t('manager.inventory')}
      </Link>
      <Link
        href="/manager/assistant"
        className="px-4 py-2 bg-gray-200 text-gray-900 rounded-lg font-medium hover:bg-gray-300"
      >
        {t('admin.assistant')}
      </Link>
      <button
        onClick={() => signOut()}
        className="ml-auto px-4 py-2 bg-red-600 text-white rounded-lg font-medium"
      >
        {t('admin.logout')}
      </button>
    </nav>
  );
}
