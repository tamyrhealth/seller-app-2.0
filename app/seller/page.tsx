'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { sumConfirmedInRange, isConfirmedInRange } from '@/lib/accounting';
import { getTodayLocalISO, getLocalDayRangeInTz } from '@/lib/datetime';
import { useTranslation } from '@/lib/i18n';
import type { Order } from '@/lib/types';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

export default function SellerPage() {
  const { profile, authReady, signOut } = useAuth();
  const { t } = useTranslation();
  const [todaySum, setTodaySum] = useState<number>(0);
  const [todayCount, setTodayCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const onVis = () => setRefreshKey((k) => k + 1);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!authReady || !profile?.id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const today = getTodayLocalISO('Asia/Almaty');
        const range = getLocalDayRangeInTz(today, 'Asia/Almaty');
        const fromISO = range.from.toISOString();
        const toNextISO = range.toNext.toISOString();
        const selectCols = 'id, created_at, total_sum, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, debt_payment_method';

        const [ordinaryRes, fulfilledRes, paidDebtsRes] = await Promise.all([
          supabase
            .from('orders')
            .select(selectCols)
            .eq('seller_id', profile.id)
            .gte('created_at', fromISO)
            .lt('created_at', toNextISO),
          supabase
            .from('orders')
            .select(selectCols)
            .eq('seller_id', profile.id)
            .gte('fulfilled_at', fromISO)
            .lt('fulfilled_at', toNextISO),
          supabase
            .from('orders')
            .select(selectCols)
            .eq('seller_id', profile.id)
            .gte('debt_paid_at', fromISO)
            .lt('debt_paid_at', toNextISO),
        ]);
        if (cancelled) return;

        const seen = new Set<string>();
        const allRows: Order[] = [];
        for (const row of [...(ordinaryRes.data || []), ...(fulfilledRes.data || []), ...(paidDebtsRes.data || [])]) {
          const o = row as Order;
          if (!seen.has(o.id)) {
            seen.add(o.id);
            allRows.push(o);
          }
        }
        const sum = sumConfirmedInRange(allRows, range);
        const count = allRows.filter((o) => isConfirmedInRange(o, range)).length;
        setTodaySum(sum);
        setTodayCount(count);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('common.errorLoad'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, profile?.id, signOut, refreshKey]);

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <div className="p-3 sm:p-4 w-full max-w-full min-w-0">
          <h1 className="text-lg sm:text-2xl font-bold mb-3 sm:mb-6 text-gray-900">{t('seller.title')}</h1>

          <div className="grid grid-cols-2 gap-2 sm:gap-4 mb-4 sm:mb-8">
            <Link
              href="/seller/new-order"
              className="p-3 sm:p-6 bg-green-600 text-white rounded-xl text-center font-bold text-sm sm:text-lg min-w-0 break-words"
            >
              {t('nav.newOrder')}
            </Link>
            <Link
              href="/seller/orders"
              className="p-3 sm:p-6 bg-blue-600 text-white rounded-xl text-center font-bold text-sm sm:text-lg min-w-0 break-words"
            >
              {t('orders.titleShort')}
            </Link>
            <Link
              href="/seller/preorders"
              className="p-3 sm:p-6 bg-amber-600 text-white rounded-xl text-center font-bold text-sm sm:text-lg min-w-0 break-words"
            >
              {t('nav.preorders')}
            </Link>
            <Link
              href="/seller/debts"
              className="p-3 sm:p-6 bg-orange-600 text-white rounded-xl text-center font-bold text-sm sm:text-lg min-w-0 break-words"
            >
              {t('nav.debts')}
            </Link>
            <Link
              href="/seller/inventory"
              className="p-3 sm:p-6 bg-blue-600 text-white rounded-xl text-center font-bold text-sm sm:text-lg min-w-0 break-words"
            >
              {t('nav.inventory')}
            </Link>
          </div>

          <div className="bg-gray-100 rounded-xl p-3 sm:p-4">
            <h2 className="font-bold mb-2 text-sm sm:text-base text-gray-900">{t('seller.today')}</h2>
            {loading ? (
              <p className="text-sm text-gray-900">{t('common.loading')}</p>
            ) : error ? (
              <p className="text-red-600 text-sm">{error}</p>
            ) : (
              <>
                <p className="text-sm text-gray-900">{t('seller.todaySum')}: {formatMoney(todaySum)} ₸</p>
                <p className="text-sm text-gray-900">
                  {t('seller.todayOrders')}: {todayCount}
                </p>
              </>
            )}
          </div>
        </div>
        <NavSeller />
      </div>
    </Protected>
  );
}
