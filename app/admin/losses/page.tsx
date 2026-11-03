'use client';

import { useEffect, useMemo, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { useTranslation } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';
import { formatQtyByUnit } from '@/lib/adminStats';
import { expandShortageEvent, filterLossRows, lossKpis, type LossReportRow } from '@/lib/transferLoss';
import type { City, Product } from '@/lib/types';

function formatKzt(n: number): string {
  return new Intl.NumberFormat('ru-KZ', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatCost(n: number | null): string {
  if (n == null) return 'Не указана';
  return `${formatKzt(n)} ₸`;
}

type EventRow = {
  id: string;
  transfer_id: string;
  actor_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  stock_transfers?: {
    transfer_number?: string;
    from_city_id?: string;
    to_city_id?: string;
  } | { transfer_number?: string; from_city_id?: string; to_city_id?: string }[] | null;
};

export default function AdminLossesPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<LossReportRow[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [fromYmd, setFromYmd] = useState('');
  const [toYmd, setToYmd] = useState('');
  const [cityId, setCityId] = useState('');
  const [productId, setProductId] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [eventsRes, transfersRes, productsRes, citiesRes, profilesRes] = await Promise.all([
        supabase
          .from('stock_transfer_events')
          .select(
            'id, transfer_id, actor_id, details, created_at, stock_transfers(transfer_number, from_city_id, to_city_id)'
          )
          .eq('action', 'shortage')
          .order('created_at', { ascending: false }),
        supabase.from('stock_transfers').select('id, transfer_number, from_city_id, to_city_id'),
        supabase.from('products').select('id, name, unit, is_active'),
        supabase.from('cities').select('id, name').order('name'),
        supabase.from('profiles').select('id, display_name'),
      ]);
      if (cancelled) return;
      if (eventsRes.error) {
        setError(eventsRes.error.message);
        setLoading(false);
        return;
      }
      const transferById = new Map(
        (transfersRes.data || []).map((t) => [
          t.id as string,
          t as { id: string; transfer_number: string; from_city_id: string; to_city_id: string },
        ])
      );
      const productById = new Map((productsRes.data || []).map((p) => [p.id, p as Product]));
      const nameById = new Map(
        (profilesRes.data || []).map((p) => [p.id as string, (p.display_name as string | null) || '—'])
      );
      const expanded: LossReportRow[] = [];
      for (const ev of (eventsRes.data || []) as EventRow[]) {
        const nested = Array.isArray(ev.stock_transfers) ? ev.stock_transfers[0] : ev.stock_transfers;
        const tr = transferById.get(ev.transfer_id);
        const fromCityId = nested?.from_city_id || tr?.from_city_id || '';
        const toCityId = nested?.to_city_id || tr?.to_city_id || '';
        expanded.push(
          ...expandShortageEvent({
            eventId: ev.id,
            createdAt: ev.created_at,
            transferId: ev.transfer_id,
            transferNumber: nested?.transfer_number || tr?.transfer_number || ev.transfer_id.slice(0, 8),
            fromCityId,
            toCityId,
            actorId: ev.actor_id,
            actorName: ev.actor_id ? nameById.get(ev.actor_id) || '—' : '—',
            details: ev.details,
            productName: (id) => productById.get(id)?.name || id,
            productUnit: (id) => productById.get(id)?.unit || 'pcs',
          })
        );
      }
      setRows(expanded);
      setCities((citiesRes.data || []) as City[]);
      setProducts((productsRes.data || []) as Product[]);
      setError('');
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(
    () => filterLossRows(rows, { fromYmd, toYmd, cityId, productId }),
    [rows, fromYmd, toYmd, cityId, productId]
  );
  const kpis = useMemo(() => lossKpis(filtered), [filtered]);
  const cityName = (id: string) => cities.find((c) => c.id === id)?.name || id || '—';

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-4 text-gray-900">{t('admin.losses')}</h1>
          <p className="text-sm text-gray-600 mb-4">
            Официально оформленные недостачи по межскладским перемещениям. Себестоимость берётся из снимка на момент
            оформления, а не из текущей розничной цены.
          </p>
          <div className="grid gap-2 md:grid-cols-4 mb-4">
            <input
              type="date"
              value={fromYmd}
              onChange={(e) => setFromYmd(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
            />
            <input
              type="date"
              value={toYmd}
              onChange={(e) => setToYmd(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
            />
            <select
              value={cityId}
              onChange={(e) => setCityId(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
            >
              <option value="">Все города</option>
              {cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
            >
              <option value="">Все товары</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 md:grid-cols-3 mb-4">
            <div className="p-4 bg-gray-100 rounded-lg">
              <p className="text-sm text-gray-600">Общая сумма потерь</p>
              <p className="text-xl font-bold text-gray-900">{formatKzt(kpis.knownValue)} ₸</p>
              {kpis.unknownLineCount > 0 && (
                <p className="text-xs text-amber-800 mt-1">
                  {kpis.unknownLineCount} строк без себестоимости не включены в сумму (не считаются нулевым убытком).
                </p>
              )}
            </div>
            <div className="p-4 bg-gray-100 rounded-lg">
              <p className="text-sm text-gray-600">Потерянные единицы</p>
              <p className="text-xl font-bold text-gray-900">{formatQtyByUnit(kpis.qtyByUnit)}</p>
            </div>
            <div className="p-4 bg-gray-100 rounded-lg">
              <p className="text-sm text-gray-600">Перемещений с недостачами</p>
              <p className="text-xl font-bold text-gray-900">{kpis.transferCount}</p>
            </div>
          </div>
          {loading ? (
            <p className="text-gray-900">Загрузка...</p>
          ) : error ? (
            <p className="text-red-700">{error}</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-600">Недостач за выбранный период нет</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm text-left text-gray-900">
                <thead>
                  <tr className="border-b border-gray-300">
                    <th className="py-2 pr-3">Дата оформления</th>
                    <th className="py-2 pr-3">Перемещение</th>
                    <th className="py-2 pr-3">Откуда</th>
                    <th className="py-2 pr-3">Куда</th>
                    <th className="py-2 pr-3">Товар</th>
                    <th className="py-2 pr-3">Кол-во</th>
                    <th className="py-2 pr-3">Себестоимость</th>
                    <th className="py-2 pr-3">Сумма потерь</th>
                    <th className="py-2 pr-3">Причина</th>
                    <th className="py-2 pr-3">Кто оформил</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <tr key={`${row.eventId}:${row.productId}`} className="border-b border-gray-200">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {new Date(row.createdAt).toLocaleString('ru-KZ')}
                      </td>
                      <td className="py-2 pr-3 font-medium">{row.transferNumber}</td>
                      <td className="py-2 pr-3">{cityName(row.fromCityId)}</td>
                      <td className="py-2 pr-3">{cityName(row.toCityId)}</td>
                      <td className="py-2 pr-3">{row.productName}</td>
                      <td className="py-2 pr-3">
                        {row.qty} {row.unit === 'pcs' ? 'шт' : row.unit}
                      </td>
                      <td className="py-2 pr-3">{formatCost(row.unitCost)}</td>
                      <td className="py-2 pr-3">{formatCost(row.totalCost)}</td>
                      <td className="py-2 pr-3">{row.reason || '—'}</td>
                      <td className="py-2 pr-3">{row.actorName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Protected>
  );
}
