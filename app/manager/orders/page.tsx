'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavManager from '@/components/NavManager';
import { supabase } from '@/lib/supabaseClient';
import { displayOrderNumber } from '@/lib/orderNumber';

type OrderRow = {
  id: string;
  order_number: string | null;
  created_at: string;
  total_sum: number;
  status: string;
  is_preorder?: boolean;
  is_debt?: boolean;
};

export default function ManagerOrdersPage() {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase
      .from('orders')
      .select('id, order_number, created_at, total_sum, status, is_preorder, is_debt')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setRows((data || []) as OrderRow[]);
      });
  }, []);

  return (
    <Protected role="manager">
      <div className="min-h-screen bg-white">
        <NavManager />
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Заказы</h1>
          {error && <p className="text-red-700 text-sm mb-2">{error}</p>}
          <div className="space-y-2">
            {rows.map((o) => (
              <div key={o.id} className="p-3 bg-gray-100 rounded-lg text-sm text-gray-900">
                <span className="font-medium">{displayOrderNumber(o)}</span>
                {' · '}
                {new Date(o.created_at).toLocaleString('ru-KZ')}
                {' · '}
                {o.total_sum} ₸
                {' · '}
                {o.status}
                {o.is_preorder ? ' · предзаказ' : ''}
                {o.is_debt ? ' · долг' : ''}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Protected>
  );
}
