'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import { supabase } from '@/lib/supabaseClient';

type Row = {
  city: string;
  product: string;
  qty: number;
  unit: string;
};

export default function ManagerInventoryPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase
      .from('inventory')
      .select('qty_on_hand, products(name, unit), cities(name)')
      .order('qty_on_hand')
      .then(({ data, error: err }) => {
        if (err) {
          setError(err.message);
          return;
        }
        setRows(
          (data || []).map((r) => {
            const p = r.products as { name?: string; unit?: string } | { name?: string; unit?: string }[] | null;
            const c = r.cities as { name?: string } | { name?: string }[] | null;
            const prod = Array.isArray(p) ? p[0] : p;
            const city = Array.isArray(c) ? c[0] : c;
            return {
              city: city?.name || '—',
              product: prod?.name || '—',
              qty: Number(r.qty_on_hand || 0),
              unit: prod?.unit || '',
            };
          })
        );
      });
  }, []);

  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white">
        <NavManager />
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Остатки</h1>
          <p className="text-sm text-gray-600 mb-4">Только просмотр. Перемещения менеджеру недоступны.</p>
          {error && <p className="text-red-700 text-sm mb-2">{error}</p>}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left text-gray-900">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-3">Город</th>
                  <th className="py-2 pr-3">Товар</th>
                  <th className="py-2 pr-3">Остаток</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.city}:${r.product}:${i}`} className="border-b border-gray-200">
                    <td className="py-2 pr-3">{r.city}</td>
                    <td className="py-2 pr-3">{r.product}</td>
                    <td className="py-2 pr-3">
                      {r.qty} {r.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Protected>
  );
}
