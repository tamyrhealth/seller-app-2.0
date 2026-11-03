'use client';

import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import InventoryBrowse from '@/components/InventoryBrowse';
import { useTranslation } from '@/lib/i18n';

export default function ManagerInventoryPage() {
  const { t } = useTranslation();
  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white">
        <NavManager />
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">{t('manager.inventory')}</h1>
          <p className="text-sm text-gray-600 mb-4">{t('manager.stockReadOnly')}</p>
          <InventoryBrowse />
        </div>
      </div>
    </Protected>
  );
}
