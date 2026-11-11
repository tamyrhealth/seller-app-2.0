'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { City } from '@/lib/types';
import { useTranslation } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useUserUiState } from '@/lib/useUserUiState';
import PreorderDemandPanel from '@/components/PreorderDemandPanel';
import { availableQty } from '@/lib/inventoryAvailable';

type StockRow = {
  city_id: string;
  product_id: string;
  qty_on_hand: number;
  qty_reserved: number;
  product_name: string;
  unit: string;
  sort_order: number;
};

export default function InventoryBrowse() {
  const { t } = useTranslation();
  const { profile } = useAuth();
  const [cities, setCities] = useState<City[]>([]);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [ui, setUi] = useUserUiState(profile?.id, 'inventory-browse', { selectedCity: 'ALL', search: '' });
  const selectedCity = ui.selectedCity;
  const search = ui.search;
  const setSelectedCity = (selectedCity: string) => setUi((prev) => ({ ...prev, selectedCity }));
  const setSearch = (search: string) => setUi((prev) => ({ ...prev, search }));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const activeCities = useMemo(() => cities.filter((c) => c.is_active !== false), [cities]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cityRes, invRes] = await Promise.all([
        supabase.from('cities').select('id, name, address, is_active').order('name'),
        supabase
          .from('inventory')
          .select('city_id, product_id, qty_on_hand, qty_reserved, products(name, unit, is_active, sort_order)'),
      ]);
      if (cancelled) return;
      if (cityRes.error) {
        setError(cityRes.error.message);
        setLoading(false);
        return;
      }
      if (invRes.error) {
        setError(invRes.error.message);
        setCities(cityRes.data || []);
        setLoading(false);
        return;
      }
      setError('');
      setCities(cityRes.data || []);
      const mapped: StockRow[] = [];
      for (const row of invRes.data || []) {
        const p = row.products as
          | { name?: string; unit?: string; is_active?: boolean; sort_order?: number | null }
          | { name?: string; unit?: string; is_active?: boolean; sort_order?: number | null }[]
          | null;
        const prod = Array.isArray(p) ? p[0] : p;
        if (!prod || prod.is_active === false) continue;
        mapped.push({
          city_id: row.city_id as string,
          product_id: row.product_id as string,
          qty_on_hand: Number(row.qty_on_hand || 0),
          qty_reserved: Number(row.qty_reserved || 0),
          product_name: prod.name || '',
          unit: prod.unit || '',
          sort_order: prod.sort_order ?? Number.POSITIVE_INFINITY,
        });
      }
      mapped.sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.product_name.localeCompare(b.product_name, 'ru');
      });
      setRows(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const q = search.trim().toLowerCase();
  const visibleCities = selectedCity === 'ALL' ? activeCities : activeCities.filter((c) => c.id === selectedCity);

  function rowsForCity(cityId: string) {
    return rows.filter((r) => {
      if (r.city_id !== cityId) return false;
      if (!q) return true;
      return r.product_name.toLowerCase().includes(q);
    });
  }

  return (
    <div>
      <PreorderDemandPanel cityId={selectedCity} />
      <div className="mb-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('common.search')}
          className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900"
        />
      </div>
      <div className="flex gap-2 mb-4 overflow-x-auto pb-2 flex-wrap">
        <button
          type="button"
          onClick={() => setSelectedCity('ALL')}
          className={`px-4 py-2 rounded-lg whitespace-nowrap ${
            selectedCity === 'ALL' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'
          }`}
        >
          {t('admin.allCities')}
        </button>
        {activeCities.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedCity(c.id)}
            className={`px-4 py-2 rounded-lg whitespace-nowrap ${
              selectedCity === c.id ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>
      {error && <p className="text-red-700 text-sm mb-2">{error}</p>}
      {loading ? (
        <p className="text-gray-900">{t('common.loading')}</p>
      ) : (
        <div className="space-y-6">
          {visibleCities.map((city) => {
            const cityRows = rowsForCity(city.id);
            return (
              <section key={city.id}>
                <h2 className="font-bold mb-2 text-gray-900">{city.name}</h2>
                {cityRows.length === 0 ? (
                  <p className="text-sm text-gray-600">{t('manager.noStock')}</p>
                ) : (
                  <div className="space-y-2">
                    {cityRows.map((row) => (
                      <div
                        key={`${row.city_id}:${row.product_id}`}
                        className="flex justify-between items-center p-4 bg-gray-100 rounded-lg"
                      >
                        <p className="font-medium text-gray-900">{row.product_name}</p>
                        <p className="text-sm text-gray-900 whitespace-nowrap ml-3">
                          {availableQty(row.qty_on_hand, row.qty_reserved)} {row.unit}
                          {row.qty_reserved
                            ? ` (${t('stock.reserved')}: ${row.qty_reserved})`
                            : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
