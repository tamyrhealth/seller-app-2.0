'use client';

import type { ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n';

export default function TableScroll({
  children,
  minWidth,
  stickyFirst = false,
  hint = true,
  className = '',
}: {
  children: ReactNode;
  minWidth?: string;
  stickyFirst?: boolean;
  hint?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={`table-scroll ${stickyFirst ? 'table-scroll-sticky-first' : ''} ${className}`.trim()}>
      {hint ? <p className="table-scroll-hint">{t('table.scrollHint')}</p> : null}
      <div className="table-scroll-x" data-scroll-persist="table">
        <div className="table-scroll-inner" style={minWidth ? { minWidth } : undefined}>
          {children}
        </div>
      </div>
    </div>
  );
}
