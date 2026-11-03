'use client';

import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import OrderBrowse from '@/components/OrderBrowse';
import { useTranslation } from '@/lib/i18n';

export default function ManagerOrdersPage() {
  const { t } = useTranslation();
  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white">
        <NavManager />
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">{t('nav.orders')}</h1>
          <OrderBrowse />
        </div>
      </div>
    </Protected>
  );
}
