'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';

export default function NavAdmin() {
  const { signOut } = useAuth();

  return (
    <nav className="bg-white border-b border-gray-200 p-4 flex flex-wrap gap-2 items-center">
      <Link
        href="/admin"
        className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium"
      >
        Дашборд
      </Link>
      <Link
        href="/admin/orders"
        className="px-4 py-2 bg-gray-600 text-white rounded-lg font-medium"
      >
        Заказы
      </Link>
      <Link
        href="/admin/products"
        className="px-4 py-2 bg-gray-600 text-white rounded-lg font-medium"
      >
        Товары
      </Link>
      <Link
        href="/admin/locations"
        className="px-4 py-2 bg-gray-600 text-white rounded-lg font-medium"
      >
        Склады
      </Link>
      <Link
        href="/admin/users"
        className="px-4 py-2 bg-gray-600 text-white rounded-lg font-medium"
      >
        Продавцы
      </Link>
      <button
        onClick={() => signOut()}
        className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium ml-auto"
      >
        Выход
      </button>
    </nav>
  );
}
