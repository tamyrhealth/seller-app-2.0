'use client';

import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import SellerBalancesView from '@/components/SellerBalancesView';
import { useTranslation } from '@/lib/i18n';

export default function ManagerSellerBalancesPage() {
  const { t } = useTranslation();

  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white max-w-full overflow-x-hidden">
        <NavManager />
        <div className="p-4 pb-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('sellerBalances.title')}</h1>
          <p className="text-sm text-gray-600 mt-1">{t('sellerBalances.managerHint')}</p>
        </div>
        <SellerBalancesView canMutate={false} />
      </div>
    </Protected>
  );
}
