'use client';

import { useEffect, useMemo, useState } from 'react';
import AdminKazakhstanMap from '@/components/AdminKazakhstanMap';
import NavAdmin from '@/components/NavAdmin';
import Protected from '@/components/Protected';
import { formatForecastQty } from '@/lib/adminForecast';
import { buildAdminMap, type MapSelection, type MapSeller } from '@/lib/adminMap';
import { useAuth } from '@/lib/auth';
import { runExclusive } from '@/lib/exclusiveAsync';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';

function SellerPanel({
  seller,
  t,
  onClose,
}: {
  seller: MapSeller;
  t: (key: string) => string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{seller.name}</h2>
          <p className="mt-1 text-sm text-slate-500">{seller.address || t('map.noAddress')}</p>
          <p className={`mt-2 text-xs font-medium ${seller.isActive ? 'text-emerald-700' : 'text-slate-500'}`}>
            {seller.isActive ? t('map.active') : t('map.inactive')}
          </p>
        </div>
        <button type="button" className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" onClick={onClose}>
          {t('map.close')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('map.stock')}</p>
        {seller.stocks.length === 0 ? (
          <p className="text-sm text-slate-500">{t('map.emptyStock')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {seller.stocks.map((row) => (
                <tr key={row.productId} className="border-b border-slate-100">
                  <td className="py-2 pr-3 text-slate-800">{row.name}</td>
                  <td
                    className={`py-2 text-right tabular-nums ${row.qtyOnHand < 0 ? 'font-medium text-rose-700' : 'text-slate-900'}`}
                  >
                    {formatForecastQty(row.qtyOnHand, row.unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function AdminMapPage() {
  const { t, lang } = useTranslation();
  const { profile, authReady } = useAuth();
  const isAdmin = profile?.role === 'admin' && profile.is_active !== false;
  const [cities, setCities] = useState<Array<{ id: string; name: string; address?: string | null; is_active?: boolean | null }>>(
    []
  );
  const [inventory, setInventory] = useState<Array<{ city_id: string; product_id: string; qty_on_hand: number | string | null }>>(
    []
  );
  const [products, setProducts] = useState<Array<{ id: string; name: string; unit: string; is_active?: boolean | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selection, setSelection] = useState<MapSelection>({ expandedGeoId: null, selectedCityId: null });

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!authReady || !isAdmin) return;
    let cancelled = false;
    setLoading((was) => (cities.length === 0 ? true : was));
    setError(null);
    (async () => {
      try {
        const [cityRes, invRes, prodRes] = await Promise.all([
          runExclusive('admin-map-cities', async () =>
            supabase.from('cities').select('id, name, address, is_active').order('name')
          ),
          runExclusive('admin-map-inventory', async () => supabase.from('inventory').select('city_id, product_id, qty_on_hand')),
          runExclusive('admin-map-products', async () => supabase.from('products').select('id, name, unit, is_active')),
        ]);
        if (cancelled) return;
        if (cityRes.error) {
          setError(cityRes.error.message);
          setLoading(false);
          return;
        }
        if (invRes.error) {
          setError(invRes.error.message);
          setLoading(false);
          return;
        }
        if (prodRes.error) {
          setError(prodRes.error.message);
          setLoading(false);
          return;
        }
        setCities(cityRes.data || []);
        setInventory(invRes.data || []);
        setProducts(prodRes.data || []);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'network');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, authReady, isAdmin]);

  const report = useMemo(() => buildAdminMap({ cities, inventory, products }), [cities, inventory, products]);
  const selected = useMemo(() => {
    if (!selection.selectedCityId) return null;
    for (const marker of report.markers) {
      const hit = marker.sellers.find((s) => s.cityId === selection.selectedCityId);
      if (hit) return hit;
    }
    return report.unknown.find((s) => s.cityId === selection.selectedCityId) || null;
  }, [report, selection.selectedCityId]);

  function closePanel() {
    setSelection({ expandedGeoId: selection.expandedGeoId, selectedCityId: null });
  }

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-slate-50">
        <NavAdmin />
        <main className="mx-auto flex max-w-7xl flex-col gap-3 p-4 pb-32 lg:pb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t('map.title')}</h1>
            <p className="mt-1 text-sm text-slate-500">{t('map.subtitle')}</p>
          </div>

          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{t('map.loadError')}</div>
          ) : loading ? (
            <div className="h-[62vh] animate-pulse rounded-2xl border border-slate-200 bg-white" />
          ) : (
            <div className="flex flex-col gap-3 lg:flex-row">
              <div className="min-h-[28rem] flex-1 lg:h-[calc(100vh-9.5rem)]">
                <AdminKazakhstanMap
                  markers={report.markers}
                  selection={selection}
                  onSelection={setSelection}
                  lang={lang}
                  t={t}
                />
              </div>
              <aside className="hidden w-full max-w-sm shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:flex lg:h-[calc(100vh-9.5rem)] lg:flex-col">
                {selected ? (
                  <SellerPanel seller={selected} t={t} onClose={closePanel} />
                ) : (
                  <div className="p-4 text-sm text-slate-500">{t('map.panelHint')}</div>
                )}
              </aside>
            </div>
          )}

          {!loading && !error && report.unknown.length > 0 ? (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <h2 className="text-sm font-semibold text-amber-950">{t('map.unknown')}</h2>
              <p className="mt-1 text-xs text-amber-800">{t('map.unknownHint')}</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {report.unknown.map((seller) => (
                  <li key={seller.cityId}>
                    <button
                      type="button"
                      className="rounded-full border border-amber-300 bg-white px-3 py-1.5 text-sm text-slate-800"
                      onClick={() => setSelection({ expandedGeoId: null, selectedCityId: seller.cityId })}
                    >
                      {seller.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </main>

        {selected ? (
          <div className="fixed inset-x-0 bottom-0 z-20 flex h-[min(50vh,24rem)] flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl lg:hidden">
            <SellerPanel seller={selected} t={t} onClose={closePanel} />
          </div>
        ) : null}
      </div>
    </Protected>
  );
}
