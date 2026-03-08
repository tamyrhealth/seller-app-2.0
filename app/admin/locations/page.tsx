'use client';

import { useEffect, useMemo, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { supabase } from '@/lib/supabaseClient';
import type { City } from '@/lib/types';
import type { Product } from '@/lib/types';

interface InventoryRow {
  id: string;
  product_id: string;
  product_name: string;
  qty_on_hand: number;
  low_stock_threshold: number;
}

export default function AdminLocationsPage() {
  const [cities, setCities] = useState<City[]>([]);
  const [selectedCity, setSelectedCity] = useState<string | null>('ALL');
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCityForm, setShowCityForm] = useState(false);
  const [showRestock, setShowRestock] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustRow, setAdjustRow] = useState<InventoryRow | null>(null);
  const [cityForm, setCityForm] = useState({ name: '', address: '' });
  const [editCityId, setEditCityId] = useState<string | null>(null);
  const [restockForm, setRestockForm] = useState({
    city_id: '',
    product_id: '',
    qty_add: '',
  });
  const [adjustForm, setAdjustForm] = useState({ new_qty: '' });
  const [products, setProducts] = useState<Product[]>([]);

  const priceByProductId = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) {
      map.set(p.id, Number((p as any).price_retail ?? 0));
    }
    return map;
  }, [products]);

  function formatMoney(n: number) {
    return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
  }

  useEffect(() => {
    loadCities();
    supabase.from('products').select('*').eq('is_active', true).then(({ data }) => setProducts(data || []));
  }, []);

  useEffect(() => {
    if (!selectedCity) {
      setInventory([]);
      return;
    }
    if (selectedCity === 'ALL') {
      loadInventoryAll();
    } else {
      loadInventory(selectedCity);
    }
  }, [selectedCity]);

  async function loadCities() {
    const { data } = await supabase.from('cities').select('*').order('name');
    setCities(data || []);
    setLoading(false);
  }

  async function loadInventoryAll() {
    const { data } = await supabase
      .from('inventory')
      .select('product_id, qty_on_hand, products(name)');

    const map = new Map<string, { product_name: string; qty_on_hand: number }>();

    for (const row of data || []) {
      const pid = row.product_id as string;
      const products = row.products as { name?: string } | { name?: string }[] | null;
      const name = Array.isArray(products) ? products[0]?.name ?? '' : products?.name ?? '';
      const prev = map.get(pid);
      const qty = row.qty_on_hand as number;
      if (prev) {
        prev.qty_on_hand += qty;
      } else {
        map.set(pid, { product_name: name, qty_on_hand: qty });
      }
    }

    const aggregated: InventoryRow[] = Array.from(map.entries())
      .map(([product_id, v]) => ({
        id: product_id,
        product_id,
        product_name: v.product_name,
        qty_on_hand: v.qty_on_hand,
        low_stock_threshold: 0,
      }))
      .sort((a, b) => b.qty_on_hand - a.qty_on_hand);

    setInventory(aggregated);
  }

  async function loadInventory(cityId: string) {
    const { data } = await supabase
      .from('inventory')
      .select('id, product_id, qty_on_hand, low_stock_threshold, products(name)')
      .eq('city_id', cityId);

    setInventory(
      (data || []).map((i) => {
        const p = i.products as { name?: string } | { name?: string }[] | null;
        const product_name = Array.isArray(p) ? p[0]?.name ?? '' : p?.name ?? '';
        return {
          id: i.id,
          product_id: i.product_id,
          product_name,
          qty_on_hand: i.qty_on_hand,
          low_stock_threshold: i.low_stock_threshold,
        };
      })
    );
  }

  async function saveCity() {
    if (!cityForm.name.trim()) return;
    if (editCityId) {
      await supabase
        .from('cities')
        .update({ name: cityForm.name, address: cityForm.address || null })
        .eq('id', editCityId);
    } else {
      await supabase.from('cities').insert({
        name: cityForm.name,
        address: cityForm.address || null,
      });
    }
    setCityForm({ name: '', address: '' });
    setEditCityId(null);
    setShowCityForm(false);
    loadCities();
  }

  async function handleRestock() {
    const qty = parseInt(restockForm.qty_add, 10);
    if (!restockForm.city_id || !restockForm.product_id || isNaN(qty) || qty <= 0) {
      alert('Введите корректное количество');
      return;
    }

    const { data, error: userError } = await supabase.auth.getUser();
    if (userError) {
      console.error('handleRestock: getUser error', userError);
      alert('Не удалось добавить приход, попробуйте снова');
      return;
    }
    const uid = data.user?.id;

    const { data: existing } = await supabase
      .from('inventory')
      .select('id, qty_on_hand')
      .eq('city_id', restockForm.city_id)
      .eq('product_id', restockForm.product_id)
      .single();

    if (existing) {
      const { error } = await supabase
        .from('inventory')
        .update({ qty_on_hand: existing.qty_on_hand + qty })
        .eq('id', existing.id);
      if (error) {
        console.error('handleRestock: update inventory error', error);
        alert('Не удалось добавить приход, попробуйте снова');
        return;
      }
    } else {
      const { error } = await supabase.from('inventory').insert({
        city_id: restockForm.city_id,
        product_id: restockForm.product_id,
        qty_on_hand: qty,
      });
      if (error) {
        console.error('handleRestock: insert inventory error', error);
        alert('Не удалось добавить приход, попробуйте снова');
        return;
      }
    }

    const { error: moveError } = await supabase.from('inventory_movements').insert({
      city_id: restockForm.city_id,
      product_id: restockForm.product_id,
      type: 'restock',
      qty_delta: qty,
      created_by: uid,
    });
    if (moveError) {
      console.error('handleRestock: insert movement error', moveError);
      alert('Не удалось добавить приход, попробуйте снова');
      return;
    }

    setRestockForm({ city_id: '', product_id: '', qty_add: '' });
    setShowRestock(false);
    // Обновляем остатки для текущего режима (город или Весь КЗ)
    if (selectedCity === 'ALL') {
      await loadInventoryAll();
    } else if (selectedCity) {
      await loadInventory(selectedCity);
    }
  }

  async function handleAdjust() {
    if (!adjustRow || !selectedCity) return;
    const newQty = parseInt(adjustForm.new_qty, 10);
    if (isNaN(newQty) || newQty < 0) return;

    const delta = newQty - adjustRow.qty_on_hand;
    const res = await supabase.auth.getUser() as unknown as { data?: { user?: { id?: string } }; user?: { id?: string } };
    const uid = res.data?.user?.id ?? res.user?.id;

    await supabase
      .from('inventory')
      .update({ qty_on_hand: newQty })
      .eq('id', adjustRow.id);

    await supabase.from('inventory_movements').insert({
      city_id: selectedCity!,
      product_id: adjustRow.product_id,
      type: 'adjust',
      qty_delta: delta,
      created_by: uid,
    });

    setAdjustRow(null);
    setAdjustForm({ new_qty: '' });
    setShowAdjust(false);
    loadInventory(selectedCity!);
  }

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-4 text-gray-900">Склады</h1>

          <div className="flex gap-2 mb-4 flex-wrap">
            <button
              onClick={() => {
                setShowCityForm(true);
                setEditCityId(null);
                setCityForm({ name: '', address: '' });
              }}
              className="px-4 py-2 bg-green-600 text-white rounded-lg"
            >
              + Город
            </button>
            <button
              onClick={() => {
                setShowRestock(true);
                setRestockForm({
                  city_id: selectedCity || '',
                  product_id: '',
                  qty_add: '',
                });
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg"
            >
              Приход товара
            </button>
            <button
              onClick={() => setSelectedCity('ALL')}
              className={`px-4 py-2 rounded-lg ${
                selectedCity === 'ALL' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'
              }`}
            >
              Весь КЗ
            </button>
          </div>

          {showCityForm && (
            <div className="bg-gray-100 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2 text-gray-900">
                {editCityId ? 'Редактирование города' : 'Новый город'}
              </h2>
              <input
                placeholder="Название"
                value={cityForm.name}
                onChange={(e) => setCityForm({ ...cityForm, name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
              />
              <input
                placeholder="Адрес (опционально)"
                value={cityForm.address}
                onChange={(e) => setCityForm({ ...cityForm, address: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
              />
              <div className="flex gap-2">
                <button
                  onClick={saveCity}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg"
                >
                  Сохранить
                </button>
                <button
                  onClick={() => setShowCityForm(false)}
                  className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          {showRestock && (
            <div className="bg-gray-100 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2 text-gray-900">Приход товара</h2>
              <select
                value={restockForm.city_id}
                onChange={(e) => setRestockForm({ ...restockForm, city_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
              >
                <option value="">Выберите город</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={restockForm.product_id}
                onChange={(e) => setRestockForm({ ...restockForm, product_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
              >
                <option value="">Выберите товар</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Количество"
                value={restockForm.qty_add}
                onChange={(e) => setRestockForm({ ...restockForm, qty_add: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleRestock}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg"
                >
                  Добавить
                </button>
                <button
                  onClick={() => setShowRestock(false)}
                  className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2 mb-4 overflow-x-auto pb-2 flex-wrap">
            <button
              onClick={() => setSelectedCity('ALL')}
              className={`px-4 py-2 rounded-lg whitespace-nowrap ${
                selectedCity === 'ALL' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'
              }`}
            >
              Весь КЗ
            </button>
            {cities.map((c) => (
              <div key={c.id} className="flex items-center gap-1">
                <button
                  onClick={() => setSelectedCity(c.id)}
                  className={`px-4 py-2 rounded-lg whitespace-nowrap ${
                    selectedCity === c.id ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'
                  }`}
                >
                  {c.name}
                </button>
                <button
                  onClick={() => {
                    setEditCityId(c.id);
                    setCityForm({ name: c.name, address: c.address || '' });
                    setShowCityForm(true);
                  }}
                  className="px-2 py-1 bg-gray-300 text-gray-900 rounded text-sm"
                  title="Редактировать"
                >
                  ✎
                </button>
              </div>
            ))}
          </div>

          {selectedCity && (
            <div>
              <h2 className="font-bold mb-2 text-gray-900">
                Остатки:{' '}
                {selectedCity === 'ALL'
                  ? 'Весь КЗ'
                  : cities.find((c) => c.id === selectedCity)?.name}
              </h2>
              <div className="space-y-2">
                {inventory.map((row) => (
                  <div
                    key={row.id}
                    className="flex justify-between items-center p-4 bg-gray-100 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{row.product_name}</p>
                      <p className="text-sm text-gray-600">
                        Остаток: {row.qty_on_hand}
                        {selectedCity !== 'ALL'
                          ? ` (порог: ${row.low_stock_threshold})`
                          : ''}
                      </p>
                    </div>
                    {selectedCity === 'ALL' ? (
                      <button
                        disabled
                        className="px-3 py-1 bg-gray-300 text-gray-600 rounded text-sm cursor-not-allowed"
                        title="Корректировка доступна только для конкретного города"
                      >
                        Корректировка
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setAdjustRow(row);
                          setAdjustForm({ new_qty: String(row.qty_on_hand) });
                          setShowAdjust(true);
                        }}
                        className="px-3 py-1 bg-blue-600 text-white rounded text-sm"
                      >
                        Корректировка
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-4 font-semibold text-gray-900">
                {(() => {
                  const total = inventory.reduce((sum, row) => {
                    const price = priceByProductId.get(row.product_id) ?? 0;
                    return sum + price * row.qty_on_hand;
                  }, 0);
                  return selectedCity === 'ALL'
                    ? `Итого по КЗ: ${formatMoney(total)} ₸`
                    : `Итого по городу: ${formatMoney(total)} ₸`;
                })()}
              </div>
            </div>
          )}

          {showAdjust && adjustRow && (
            <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-xl p-6 max-w-sm w-full">
                <h2 className="font-bold mb-2 text-gray-900">Корректировка: {adjustRow.product_name}</h2>
                <input
                  type="number"
                  value={adjustForm.new_qty}
                  onChange={(e) => setAdjustForm({ new_qty: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded mb-4 bg-white text-gray-900"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleAdjust}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-lg"
                  >
                    Сохранить
                  </button>
                  <button
                    onClick={() => {
                      setShowAdjust(false);
                      setAdjustRow(null);
                    }}
                    className="flex-1 py-2 bg-gray-300 text-gray-900 rounded-lg"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Protected>
  );
}
