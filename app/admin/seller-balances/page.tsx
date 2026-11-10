'use client';

import Link from 'next/link';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import SellerBalancesView from '@/components/SellerBalancesView';
import { useAuth } from '@/lib/auth';
import { useTranslation } from '@/lib/i18n';

export default function AdminSellerBalancesPage() {
  const { profile } = useAuth();
  const { t } = useTranslation();
  const isAdmin = profile?.role === 'admin';

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white max-w-full overflow-x-hidden">
        <NavAdmin />
        <div className="p-4 pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('sellerBalances.title')}</h1>
            <Link href="/admin/seller-tariffs" className="text-sm text-blue-800">
              {t('sellerTariffs.nav')}
            </Link>
          </div>
          {!isAdmin && profile ? <p className="text-red-700 mt-2">{t('sellerBalances.forbidden')}</p> : null}
        </div>
        <SellerBalancesView canMutate={isAdmin} />
      </div>
    </Protected>
  );
}
