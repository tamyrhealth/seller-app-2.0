'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from '@/lib/i18n';
import { buildPreorderDemandRows, type PreorderDemandOrder, type PreorderDemandRow } from '@/lib/preorderDemand';

export default function PreorderDemandPanel(props: { cityId?: string | null }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PreorderDemandRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let ordersQuery = supabase
        .from('orders')
        .select(
          'id, order_number, seller_id, city_id, pickup_date, order_items!order_items_order_id_fkey(product_id, product_name_snapshot, qty, qty_reserved)'
        )
        .eq('is_preorder', true)
        .eq('preorder_status', 'pending')
        .neq('status', 'canceled')
        .order('created_at', { ascending: true });
      if (props.cityId && props.cityId !== 'ALL') {
        ordersQuery = ordersQuery.eq('city_id', props.cityId);
      }
      const { data, error: qErr } = await ordersQuery;
      if (cancelled) return;
      if (qErr) {
        setError(qErr.message);
        setRows([]);
        setLoading(false);
        return;
      }

      const sellerIds = [...new Set((data || []).map((row) => row.seller_id as string).filter(Boolean))];
      const cityIds = [...new Set((data || []).map((row) => row.city_id as string).filter(Boolean))];
      const [profilesRes, citiesRes] = await Promise.all([
        sellerIds.length
          ? supabase.from('profiles').select('id, display_name').in('id', sellerIds)
          : Promise.resolve({ data: [], error: null }),
        cityIds.length
          ? supabase.from('cities').select('id, name').in('id', cityIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (cancelled) return;
      if (profilesRes.error || citiesRes.error) {
        setError((profilesRes.error || citiesRes.error)?.message || '');
        setRows([]);
        setLoading(false);
        return;
      }
      const sellers = new Map((profilesRes.data || []).map((p) => [p.id as string, (p.display_name as string | null) || null]));
      const cities = new Map((citiesRes.data || []).map((c) => [c.id as string, (c.name as string | null) || null]));

      const mapped: PreorderDemandOrder[] = (data || []).map((row) => ({
        id: row.id as string,
        order_number: (row.order_number as string | null) || null,
        seller_id: row.seller_id as string,
        city_id: row.city_id as string,
        seller_name: sellers.get(row.seller_id as string) || null,
        city_name: cities.get(row.city_id as string) || null,
        pickup_date: (row.pickup_date as string | null) || null,
        order_items: (row.order_items as PreorderDemandOrder['order_items']) || [],
      }));
      setError('');
      setRows(buildPreorderDemandRows(mapped));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.cityId]);

  const uncovered = rows.filter((r) => r.uncovered > 0);

  return (
    <section className="mb-6">
      <h2 className="font-bold mb-1 text-gray-900">{t('preorderDemand.title')}</h2>
      <p className="text-sm text-gray-600 mb-3">{t('preorderDemand.hint')}</p>
      {error ? <p className="text-sm text-red-700 mb-2">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-gray-900">{t('common.loading')}</p>
      ) : uncovered.length === 0 ? (
        <p className="text-sm text-gray-600">{t('preorderDemand.empty')}</p>
      ) : (
        <div className="space-y-2">
          {uncovered.map((row) => (
            <div
              key={`${row.order_id}:${row.product_id}`}
              className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-gray-900"
            >
              <p className="font-medium">
                {row.product_name} · {t('preorderDemand.uncovered')}: {row.uncovered}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                {row.city_name} · {row.seller_name} · {t('preorderDemand.order')} {row.order_number} ·{' '}
                {t('preorderDemand.qty')}: {row.qty} · {t('forecast.reserve')}: {row.reserved}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
