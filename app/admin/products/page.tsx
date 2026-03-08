'use client';

import { useEffect, useState } from 'react';
import Protected from '@/components/Protected';
import NavAdmin from '@/components/NavAdmin';
import { supabase } from '@/lib/supabaseClient';
import type { Product } from '@/lib/types';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

const UNIT_LABELS: Record<string, string> = {
  pcs: 'шт',
  g: 'г',
  kg: 'кг',
  ml: 'мл',
  l: 'л',
};

function unitLabel(unit: string | null | undefined): string {
  if (!unit) return '';
  return UNIT_LABELS[unit] ?? unit;
}

export default function AdminProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    category: '',
    unit: 'pcs',
    price_retail: '',
    is_active: true,
  });
  const [showArchived, setShowArchived] = useState(false);

  const filtered = products.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) &&
      (showArchived || p.is_active)
  );

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await supabase.from('products').select('*').order('name');
    setProducts(data || []);
    setLoading(false);
  }

  function resetForm() {
    setForm({
      name: '',
      category: '',
      unit: 'pcs',
      price_retail: '',
      is_active: true,
    });
    setShowForm(false);
    setEditingId(null);
  }

  async function handleSave() {
    const price = parseFloat(form.price_retail);
    if (!form.name || isNaN(price) || price < 0) {
      alert('Заполните название и цену');
      return;
    }

    if (editingId) {
      const { error } = await supabase
        .from('products')
        .update({
          name: form.name,
          category: form.category || null,
          unit: form.unit,
          price_retail: price,
          is_active: form.is_active,
        })
        .eq('id', editingId);
      if (error) alert(error.message);
      else resetForm();
    } else {
      const { error } = await supabase.from('products').insert({
        name: form.name,
        category: form.category || null,
        unit: form.unit,
        price_retail: price,
        is_active: form.is_active,
      });
      if (error) alert(error.message);
      else resetForm();
    }
    load();
  }

  async function handleDelete(p: Product) {
    const confirmed = window.confirm(
      `Удалить товар ${p.name}? Это действие нельзя отменить.`
    );
    if (!confirmed) return;

    const { data: invRows } = await supabase
      .from('inventory')
      .select('id')
      .eq('product_id', p.id)
      .limit(1);
    const { data: orderItemRows } = await supabase
      .from('order_items')
      .select('id')
      .eq('product_id', p.id)
      .limit(1);

    const hasDeps = (invRows?.length ?? 0) > 0 || (orderItemRows?.length ?? 0) > 0;

    if (hasDeps) {
      const { error } = await supabase
        .from('products')
        .update({ is_active: false })
        .eq('id', p.id);
      if (error) {
        alert('Не удалось удалить товар. Попробуйте снова.');
        return;
      }
      alert(
        'Товар используется в остатках/заказах. Он скрыт (архивирован), но не удалён.'
      );
    } else {
      const { error } = await supabase.from('products').delete().eq('id', p.id);
      if (error) {
        alert('Не удалось удалить товар. Попробуйте снова.');
        return;
      }
    }

    if (editingId === p.id) resetForm();
    await load();
  }

  function startEdit(p: Product) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      category: p.category || '',
      unit: p.unit,
      price_retail: String(p.price_retail),
      is_active: p.is_active,
    });
    setShowForm(true);
  }

  return (
    <Protected role="admin">
      <div className="min-h-screen bg-white">
        <NavAdmin />
        <div className="p-4">
          <h1 className="text-2xl font-bold mb-4 text-gray-900">Товары</h1>

          <div className="flex gap-2 mb-4 flex-wrap items-center">
            <input
              type="text"
              placeholder="Поиск"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg flex-1 min-w-[200px] bg-white text-gray-900"
            />
            <button
              onClick={() => {
                resetForm();
                setShowForm(true);
              }}
              className="px-4 py-2 bg-green-600 text-white rounded-lg"
            >
              + Создать
            </button>
            <label className="flex items-center gap-2 whitespace-nowrap text-gray-900">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Показать архив
            </label>
          </div>

          {showForm && (
            <div className="bg-gray-100 rounded-lg p-4 mb-4">
              <h2 className="font-bold mb-2 text-gray-900">
                {editingId ? 'Редактирование' : 'Новый товар'}
              </h2>
              <div className="grid gap-2">
                <input
                  placeholder="Название"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
                />
                <input
                  placeholder="Категория"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
                />
                <select
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
                >
                  <option value="pcs">шт</option>
                  <option value="kg">кг</option>
                  <option value="l">л</option>
                </select>
                <input
                  type="number"
                  placeholder="Цена розничная"
                  value={form.price_retail}
                  onChange={(e) => setForm({ ...form, price_retail: e.target.value })}
                  className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
                />
                <label className="flex items-center gap-2 text-gray-900">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  />
                  Активен
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg"
                  >
                    Сохранить
                  </button>
                  <button
                    onClick={resetForm}
                    className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <p className="text-gray-900">Загрузка...</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((p) => (
                <div
                  key={p.id}
                  className="flex justify-between items-center p-4 bg-gray-100 rounded-lg"
                >
                  <div>
                    <p className="font-medium text-gray-900">
                      {p.name}
                      {showArchived && !p.is_active && (
                        <span className="ml-2 text-gray-600">(архив)</span>
                      )}
                    </p>
                    <p className="text-sm text-gray-600">
                      {p.category || '-'} · {formatMoney(p.price_retail)} ₸ / {unitLabel(p.unit)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => startEdit(p)}
                      className="px-3 py-1 bg-blue-600 text-white rounded text-sm"
                    >
                      Редактировать
                    </button>
                    <button
                      onClick={() => handleDelete(p)}
                      className="px-3 py-1 bg-red-600 text-white rounded text-sm"
                    >
                      Удалить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Protected>
  );
}
