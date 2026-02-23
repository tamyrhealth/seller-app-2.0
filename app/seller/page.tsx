'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

export default function SellerPage() {
  const { profile, authReady, signOut } = useAuth();
  const [todaySum, setTodaySum] = useState<number>(0);
  const [todayCount, setTodayCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        const today = new Date().toISOString().slice(0, 10);
        const { data, error: e } = await supabase
          .from('orders')
          .select('total_sum')
          .eq('seller_id', profile.id)
          .eq('status', 'confirmed')
          .gte('created_at', `${today}T00:00:00`)
          .lt('created_at', `${today}T23:59:59.999`);
        if (cancelled) return;
        if (e) {
          if (isSessionError(e)) {
            signOut('Сессия истекла');
            return;
          }
          setError(e.message);
          return;
        }
        const rows = data || [];
        const sum = rows.reduce((acc, r) => acc + Number(r.total_sum), 0);
        setTodaySum(sum);
        setTodayCount(rows.length);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, profile?.id, signOut]);

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4">
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-6">Продавец</h1>

          <div className="grid grid-cols-2 gap-4 mb-8">
            <Link
              href="/seller/new-order"
              className="p-6 bg-green-600 text-white rounded-xl text-center font-bold text-lg"
            >
              Новый заказ
            </Link>
            <Link
              href="/seller/orders"
              className="p-6 bg-blue-600 text-white rounded-xl text-center font-bold text-lg"
            >
              Мои заказы
            </Link>
            <Link
              href="/seller/inventory"
              className="p-6 bg-blue-600 text-white rounded-xl text-center font-bold text-lg col-span-2"
            >
              Остатки
            </Link>
          </div>

          <div className="bg-gray-100 rounded-xl p-4">
            <h2 className="font-bold mb-2">Сегодня</h2>
            {loading ? (
              <p>Загрузка...</p>
            ) : error ? (
              <p className="text-red-600">{error}</p>
            ) : (
              <>
                <p>Сумма: {formatMoney(todaySum)} ₸</p>
                <p>Заказов: {todayCount}</p>
              </>
            )}
          </div>
        </div>
        <NavSeller />
      </div>
    </Protected>
  );
}
