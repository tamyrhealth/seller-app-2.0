'use client';

import AppNav from '@/components/AppNav';
import { useTranslation } from '@/lib/i18n';

export default function NavAdmin() {
  const { t } = useTranslation();

  return (
    <AppNav
      items={[
        { href: '/admin', label: t('admin.dashboard'), tone: 'primary' },
        { href: '/admin/stats', label: t('stats.nav') },
        { href: '/admin/finance', label: t('finance.nav') },
        { href: '/admin/customers', label: t('customers.nav') },
        { href: '/admin/abc', label: t('abc.nav') },
        { href: '/admin/forecast', label: t('forecast.nav') },
        { href: '/admin/map', label: t('map.nav') },
        { href: '/admin/new-order', label: t('admin.newOrder'), tone: 'success' },
        { href: '/admin/orders', label: t('admin.orders') },
        { href: '/admin/activity', label: t('admin.activity') },
        { href: '/admin/products', label: t('admin.products') },
        { href: '/admin/seller-tariffs', label: t('sellerTariffs.nav') },
        { href: '/admin/seller-balances', label: t('sellerBalances.nav') },
        { href: '/admin/seller-goods', label: t('sellerGoods.nav') },
        { href: '/admin/locations', label: t('admin.locations') },
        { href: '/admin/losses', label: t('admin.losses') },
        { href: '/admin/users', label: t('admin.users') },
        { href: '/admin/assistant', label: t('admin.assistant') },
      ]}
    />
  );
}
