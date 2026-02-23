'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';

export default function NavSeller() {
  const { signOut } = useAuth();

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-2 flex gap-2 justify-around z-50 md:static md:border-t-0 md:border-b md:p-4">
      <Link
        href="/seller"
        className="px-4 py-3 bg-blue-600 text-white rounded-lg text-center font-medium min-w-[80px]"
      >
        Главная
      </Link>
      <Link
        href="/seller/new-order"
        className="px-4 py-3 bg-green-600 text-white rounded-lg text-center font-medium min-w-[80px]"
      >
        Новый заказ
      </Link>
      <Link
        href="/seller/orders"
        className="px-4 py-3 bg-gray-600 text-white rounded-lg text-center font-medium min-w-[80px]"
      >
        Заказы
      </Link>
      <Link
        href="/seller/inventory"
        className="px-4 py-3 bg-gray-600 text-white rounded-lg text-center font-medium min-w-[80px]"
      >
        Остатки
      </Link>
      <button
        onClick={() => signOut()}
        className="px-4 py-3 bg-red-600 text-white rounded-lg font-medium min-w-[80px]"
      >
        Выход
      </button>
    </nav>
  );
}
