'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';
import { useTranslation } from '@/lib/i18n';

export default function SellerInventoryPage() {
  const { profile, authReady, signOut } = useAuth();
  const { t } = useTranslation();
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
          .select('product_id, qty_on_hand, products(name, sort_order)')
          .eq('city_id', cityId);
        if (cancelled) return;
        if (invErr) {
          if (isSessionError(invErr)) {
            signOut(t('auth.sessionExpired'));
            return;
          }
          setError(invErr.message);
          return;
        }
        const mapped = (inv || []).map((i) => {
          const p = i.products as { name?: string; sort_order?: number | null } | null;
          return {
            product_name: p?.name ?? '',
            qty_on_hand: i.qty_on_hand,
            sort_order: p?.sort_order ?? null,
          };
        });
        mapped.sort((a, b) => {
          const sa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
          const sb = b.sort_order ?? Number.MAX_SAFE_INTEGER;
          if (sa !== sb) return sa - sb;
          return (a.product_name || '').localeCompare(b.product_name || '');
        });
        setRows(mapped);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('common.errorLoad'));
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
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <div className="p-3 sm:p-4 w-full max-w-full min-w-0">
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <Link href="/seller" className="text-blue-600 font-medium text-sm">
              {t('common.back')}
            </Link>
          </div>
          <h1 className="text-lg sm:text-2xl font-bold mb-3 sm:mb-4 text-gray-900">{t('inventory.title')}</h1>

          <input
            type="text"
            placeholder={t('inventory.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-full px-3 py-2.5 sm:px-4 sm:py-3 border border-gray-300 rounded-lg mb-3 sm:mb-4 min-h-[44px] text-gray-900 placeholder-gray-400 bg-white"
          />

          {loading ? (
            <p className="text-sm text-gray-900">{t('common.loading')}</p>
          ) : error ? (
            <p className="text-red-600 text-sm">{error}</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((r, i) => (
                <div key={i} className="flex justify-between items-center p-3 sm:p-4 bg-gray-50 rounded-lg min-w-0">
                  <span className="font-medium text-sm truncate min-w-0 flex-1 text-gray-900">{r.product_name}</span>
                  <span className="text-base sm:text-lg font-bold shrink-0 ml-2 text-gray-900">{r.qty_on_hand}</span>
                </div>
              ))}
              {filtered.length === 0 && <p className="text-gray-600 text-sm">{t('inventory.noProducts')}</p>}
            </div>
          )}
        </div>
        <NavSeller />
      </div>
    </Protected>
  );
}
