'use client';

import { useEffect, useState } from 'react';
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
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
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

  useEffect(() => {
    loadCities();
    supabase.from('products').select('*').eq('is_active', true).then(({ data }) => setProducts(data || []));
  }, []);

  useEffect(() => {
    if (!selectedCity) {
      setInventory([]);
      return;
    }
    loadInventory(selectedCity);
  }, [selectedCity]);

  async function loadCities() {
    const { data } = await supabase.from('cities').select('*').order('name');
    setCities(data || []);
    setLoading(false);
  }

  async function loadInventory(cityId: string) {
    const { data } = await supabase
      .from('inventory')
      .select('id, product_id, qty_on_hand, low_stock_threshold, products(name)')
      .eq('city_id', cityId);

    setInventory(
      (data || []).map((i) => ({
        id: i.id,
        product_id: i.product_id,
        product_name: (i.products as { name: string })?.name ?? '',
        qty_on_hand: i.qty_on_hand,
        low_stock_threshold: i.low_stock_threshold,
      }))
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
    if (!restockForm.city_id || !restockForm.product_id || isNaN(qty) || qty <= 0) return;

    const { data: profile } = await supabase.auth.getUser();
    const uid = profile.data.user?.id;

    const { data: existing } = await supabase
      .from('inventory')
      .select('id, qty_on_hand')
      .eq('city_id', restockForm.city_id)
      .eq('product_id', restockForm.product_id)
      .single();

    if (existing) {
      await supabase
        .from('inventory')
        .update({ qty_on_hand: existing.qty_on_hand + qty })
        .eq('id', existing.id);
    } else {
      await supabase.from('inventory').insert({
        city_id: restockForm.city_id,
        product_id: restockForm.product_id,
        qty_on_hand: qty,
      });
    }

    await supabase.from('inventory_movements').insert({
      city_id: restockForm.city_id,
      product_id: restockForm.product_id,
      type: 'restock',
      qty_delta: qty,
      created_by: uid,
    });

    setRestockForm({ city_id: '', product_id: '', qty_add: '' });
    setShowRestock(false);
    if (selectedCity === restockForm.city_id) loadInventory(selectedCity);
  }

  async function handleAdjust() {
    if (!adjustRow || !selectedCity) return;
    const newQty = parseInt(adjustForm.new_qty, 10);
    if (isNaN(newQty) || newQty < 0) return;

    const delta = newQty - adjustRow.qty_on_hand;
    const { data: profile } = await supabase.auth.getUser();
    const uid = profile.data.user?.id;

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
      <div className="min-h-screen">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-4">Склады</h1>

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
          </div>

          {showCityForm && (
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2">
                {editCityId ? 'Редактирование города' : 'Новый город'}
              </h2>
              <input
                placeholder="Название"
                value={cityForm.name}
                onChange={(e) => setCityForm({ ...cityForm, name: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
              />
              <input
                placeholder="Адрес (опционально)"
                value={cityForm.address}
                onChange={(e) => setCityForm({ ...cityForm, address: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
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
                  className="px-4 py-2 bg-gray-300 rounded-lg"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          {showRestock && (
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2">Приход товара</h2>
              <select
                value={restockForm.city_id}
                onChange={(e) => setRestockForm({ ...restockForm, city_id: e.target.value })}
                className="w-full px-3 py-2 border rounded mb-2"
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
                className="w-full px-3 py-2 border rounded mb-2"
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
                className="w-full px-3 py-2 border rounded mb-2"
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
                  className="px-4 py-2 bg-gray-300 rounded-lg"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2 mb-4 overflow-x-auto pb-2 flex-wrap">
            {cities.map((c) => (
              <div key={c.id} className="flex items-center gap-1">
                <button
                  onClick={() => setSelectedCity(selectedCity === c.id ? null : c.id)}
                  className={`px-4 py-2 rounded-lg whitespace-nowrap ${
                    selectedCity === c.id ? 'bg-blue-600 text-white' : 'bg-gray-200'
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
                  className="px-2 py-1 bg-gray-300 rounded text-sm"
                  title="Редактировать"
                >
                  ✎
                </button>
              </div>
            ))}
          </div>

          {selectedCity && (
            <div>
              <h2 className="font-bold mb-2">
                Остатки: {cities.find((c) => c.id === selectedCity)?.name}
              </h2>
              <div className="space-y-2">
                {inventory.map((row) => (
                  <div
                    key={row.id}
                    className="flex justify-between items-center p-4 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium">{row.product_name}</p>
                      <p className="text-sm text-gray-500">
                        Остаток: {row.qty_on_hand} (порог: {row.low_stock_threshold})
                      </p>
                    </div>
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
                  </div>
                ))}
              </div>
            </div>
          )}

          {showAdjust && adjustRow && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-xl p-6 max-w-sm w-full">
                <h2 className="font-bold mb-2">Корректировка: {adjustRow.product_name}</h2>
                <input
                  type="number"
                  value={adjustForm.new_qty}
                  onChange={(e) => setAdjustForm({ new_qty: e.target.value })}
                  className="w-full px-3 py-2 border rounded mb-4"
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
                    className="flex-1 py-2 bg-gray-300 rounded-lg"
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
