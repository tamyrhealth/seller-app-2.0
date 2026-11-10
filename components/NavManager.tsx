'use client';

import AppNav from '@/components/AppNav';
import { useTranslation } from '@/lib/i18n';

export default function NavManager() {
  const { t } = useTranslation();

  return (
    <AppNav
      items={[
        { href: '/manager', label: t('manager.home'), tone: 'primary' },
        { href: '/manager/new-order', label: t('admin.newOrder'), tone: 'success' },
        { href: '/manager/orders', label: t('admin.orders') },
        { href: '/manager/inventory', label: t('manager.inventory') },
        { href: '/manager/assistant', label: t('admin.assistant') },
      ]}
    />
  );
}
