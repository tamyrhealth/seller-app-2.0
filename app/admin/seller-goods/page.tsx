'use client';

import Link from 'next/link';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import SellerGoodsView from '@/components/SellerGoodsView';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';

export default function AdminSellerGoodsPage() {
  const { profile } = useAuth();
  const { t } = useTranslation();
  const isAdmin = profile?.role === 'admin';

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white max-w-full overflow-x-hidden">
        <NavAdmin />
        <div className="p-4 pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('sellerGoods.title')}</h1>
            <Link href="/admin/seller-balances" className="text-sm text-blue-800">
              {t('sellerBalances.nav')}
            </Link>
          </div>
          {!isAdmin && profile ? <p className="text-red-700 mt-2">{t('sellerBalances.forbidden')}</p> : null}
        </div>
        <SellerGoodsView canMutate={isAdmin} />
      </div>
    </Protected>
  );
}
