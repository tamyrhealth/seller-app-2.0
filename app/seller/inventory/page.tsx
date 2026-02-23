'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';

export default function SellerInventoryPage() {
  const { profile, authReady, signOut } = useAuth();
  const [rows, setRows] = useState<Array<{ product_name: string; qty_on_hand: number }>>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cityId = profile?.city_id;

  useEffect(() => {
    if (!authReady || !cityId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data: inv, error: invErr } = await supabase
          .from('inventory')
          .select('product_id, qty_on_hand, products(name)')
          .eq('city_id', cityId);
        if (cancelled) return;
        if (invErr) {
          if (isSessionError(invErr)) {
            signOut('Сессия истекла');
            return;
          }
          setError(invErr.message);
          return;
        }
        setRows(
          (inv || []).map((i) => ({
            product_name: (i.products as { name: string })?.name ?? '',
            qty_on_hand: i.qty_on_hand,
          }))
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, cityId, signOut]);

  const filtered = rows.filter((r) =>
    r.product_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Link href="/seller" className="text-blue-600 font-medium">
              ← Назад
            </Link>
          </div>
          <h1 className="text-2xl font-bold mb-4">Остатки</h1>

          <input
            type="text"
            placeholder="Поиск товара"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-4 py-3 border rounded-lg mb-4"
          />

          {loading ? (
            <p>Загрузка...</p>
          ) : error ? (
            <p className="text-red-600">{error}</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((r, i) => (
                <div key={i} className="flex justify-between items-center p-4 bg-gray-50 rounded-lg">
                  <span className="font-medium">{r.product_name}</span>
                  <span className="text-lg font-bold">{r.qty_on_hand}</span>
                </div>
              ))}
              {filtered.length === 0 && <p className="text-gray-500">Нет товаров</p>}
            </div>
          )}
        </div>
        <NavSeller />
      </div>
    </Protected>
  );
}
