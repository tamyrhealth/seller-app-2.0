'use client';

import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import { useAuth } from '@/lib/auth';

export default function ManagerHomePage() {
  const { profile } = useAuth();
  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white">
        <NavManager />
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Кабинет менеджера</h1>
          <p className="text-gray-700 mb-2">{profile?.display_name || 'Менеджер'}</p>
          <p className="text-sm text-gray-600">
            Доступны создание заказов от имени продавца, просмотр заказов и остатков, история диалогов
            ИИ-бота. Перемещения и финансы — только у администратора. Отмена заказов появится после
            отдельного разрешения.
          </p>
        </div>
      </div>
    </Protected>
  );
}
