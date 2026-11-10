'use client';

import { useState, type ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n';

export default function CollapsibleFilters({
  title,
  children,
  defaultOpen = false,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const label = title || t('map.filters');

  return (
    <div className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm lg:hidden"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        <span className="text-slate-400">{open ? '▴' : '▾'}</span>
      </button>
      <div className={`${open ? 'mt-2 block' : 'hidden'} lg:mt-0 lg:block`}>{children}</div>
    </div>
  );
}
