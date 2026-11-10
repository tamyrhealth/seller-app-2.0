'use client';

import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import SellerGoodsView from '@/components/SellerGoodsView';
import { useTranslation } from '@/lib/i18n';

export default function ManagerSellerGoodsPage() {
  const { t } = useTranslation();

  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white max-w-full overflow-x-hidden">
        <NavManager />
        <div className="p-4 pb-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('sellerGoods.title')}</h1>
          <p className="text-sm text-gray-600 mt-1">{t('sellerGoods.managerHint')}</p>
        </div>
        <SellerGoodsView canMutate={false} />
      </div>
    </Protected>
  );
}
