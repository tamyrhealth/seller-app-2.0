'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  inventoryAdjustFingerprint,
  inventoryRestockFingerprint,
  runInventoryOperationOnce,
} from '@/lib/inventoryOperation';
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
  const [showHiddenCities, setShowHiddenCities] = useState(false);
  const [cityActionError, setCityActionError] = useState<string | null>(null);
  const [stockBusy, setStockBusy] = useState(false);
  const [movements, setMovements] = useState<
    Array<{
      id: string;
      created_at: string;
      type: string;
      qty_delta: number;
      city_id: string;
      product_id: string;
      created_by: string | null;
    }>
  >([]);
  const [profilesById, setProfilesById] = useState<Map<string, string>>(new Map());

  const isCityActive = (c: City) => c.is_active !== false;
  const activeCities = useMemo(() => cities.filter(isCityActive), [cities]);
  const hiddenCities = useMemo(() => cities.filter((c) => !isCityActive(c)), [cities]);

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

  function hasMoreThan3Decimals(n: number) {
    const s = String(n);
    const dot = s.indexOf('.');
    if (dot === -1) return false;
    return s.slice(dot + 1).replace(/0+$/, '').length > 3;
  }

  function qtyValidationError(qty: number, unit: string | null | undefined, opts?: { allowZero?: boolean }): string | null {
    if (isNaN(qty)) return 'Введите корректное количество';
    if (opts?.allowZero) {
      if (qty < 0) return 'Введите корректное количество';
    } else if (qty <= 0) {
      return 'Введите корректное количество';
    }
    if (unit === 'kg') {
      if (hasMoreThan3Decimals(qty)) return 'Для кг допускается не больше 3 знаков после запятой';
      return null;
    }
    if (!Number.isInteger(qty)) return 'Для этого товара количество должно быть целым';
    return null;
  }

  useEffect(() => {
    loadCities();
    supabase.from('products').select('*').eq('is_active', true).then(({ data }) => setProducts(data || []));
    supabase
      .from('profiles')
      .select('id, display_name')
      .then(({ data }) => {
        const map = new Map<string, string>();
        for (const p of data || []) {
          map.set(p.id, p.display_name || p.id.slice(0, 8));
        }
        setProfilesById(map);
      });
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
    loadMovements(selectedCity);
  }, [selectedCity, cities]);

  async function loadCities() {
    const { data } = await supabase.from('cities').select('*').order('name');
    setCities(data || []);
    setLoading(false);
  }

  async function loadInventoryAll() {
    const { data } = await supabase
      .from('inventory')
      .select('city_id, product_id, qty_on_hand, products(name)');

    const activeCityIds = new Set(cities.filter((c) => c.is_active !== false).map((c) => c.id));
    const map = new Map<string, { product_name: string; qty_on_hand: number }>();

    for (const row of data || []) {
      if (cities.length > 0 && !activeCityIds.has(row.city_id as string)) continue;
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

  async function loadMovements(cityId: string | null) {
    if (!cityId) {
      setMovements([]);
      return;
    }
    let q = supabase
      .from('inventory_movements')
      .select('id, created_at, type, qty_delta, city_id, product_id, created_by')
      .order('created_at', { ascending: false })
      .limit(30);
    if (cityId !== 'ALL') q = q.eq('city_id', cityId);
    const { data } = await q;
    setMovements((data || []) as typeof movements);
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

  async function hideCity(city: City) {
    setCityActionError(null);
    const [sellersRes, preordersRes, debtsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('city_id', city.id)
        .eq('role', 'seller')
        .eq('is_active', true),
      supabase
        .from('orders')
        .select('id')
        .eq('city_id', city.id)
        .eq('is_preorder', true)
        .eq('preorder_status', 'pending')
        .neq('status', 'canceled')
        .limit(1),
      supabase
        .from('orders')
        .select('id')
        .eq('city_id', city.id)
        .eq('debt_status', 'active')
        .limit(1),
    ]);

    const checkError = sellersRes.error || preordersRes.error || debtsRes.error;
    if (checkError) {
      setCityActionError(
        `Нельзя скрыть «${city.name}»: не удалось проверить активных продавцов, предзаказы или долги (${checkError.message}). Город не изменён.`
      );
      return;
    }

    const activeSellers = sellersRes.count;
    const pendingPreorders = preordersRes.data;
    const activeDebts = debtsRes.data;

    const blockers: string[] = [];
    if ((activeSellers ?? 0) > 0) {
      blockers.push(`активных продавцов: ${activeSellers}`);
    }
    if (pendingPreorders && pendingPreorders.length > 0) {
      blockers.push('есть незавершённые предзаказы');
    }
    if (activeDebts && activeDebts.length > 0) {
      blockers.push('есть активные долги');
    }
    if (blockers.length > 0) {
      setCityActionError(
        `Нельзя скрыть «${city.name}»: ${blockers.join('; ')}. Сначала переведите продавцов в другой город и закройте незавершённые заказы. История заказов и склад не удаляются.`
      );
      return;
    }

    const { error } = await supabase.from('cities').update({ is_active: false }).eq('id', city.id);
    if (error) {
      setCityActionError(error.message);
      return;
    }
    if (selectedCity === city.id) setSelectedCity('ALL');
    loadCities();
  }

  async function restoreCity(city: City) {
    setCityActionError(null);
    const { error } = await supabase.from('cities').update({ is_active: true }).eq('id', city.id);
    if (error) {
      setCityActionError(error.message);
      return;
    }
    loadCities();
  }

  async function handleRestock() {
    if (stockBusy) return;
    const product = products.find((p) => p.id === restockForm.product_id);
    const unit = product?.unit;
    const qty = Number(restockForm.qty_add);
    const qtyErr = qtyValidationError(qty, unit);
    if (!restockForm.city_id || !restockForm.product_id || qtyErr) {
      alert(qtyErr || 'Введите корректное количество');
      return;
    }
    if (!activeCities.some((c) => c.id === restockForm.city_id)) {
      alert('Приход возможен только в активный город');
      return;
    }
    const cityId = restockForm.city_id;
    const productId = restockForm.product_id;
    const fingerprint = inventoryRestockFingerprint(cityId, productId, qty);
    setStockBusy(true);
    try {
      await runInventoryOperationOnce('restock', fingerprint, async (operationId) => {
        const { error } = await supabase.rpc('apply_inventory_restock', {
          p_operation_id: operationId,
          p_city_id: cityId,
          p_product_id: productId,
          p_qty: qty,
        });
        if (error) throw new Error(error.message);
      });
      setRestockForm({ city_id: '', product_id: '', qty_add: '' });
      setShowRestock(false);
      if (selectedCity === 'ALL') await loadInventoryAll();
      else if (selectedCity) await loadInventory(selectedCity);
      await loadMovements(selectedCity);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Не удалось добавить приход');
    } finally {
      setStockBusy(false);
    }
  }

  async function handleAdjust() {
    if (stockBusy || !adjustRow || !selectedCity || selectedCity === 'ALL') return;
    const product = products.find((p) => p.id === adjustRow.product_id);
    const unit = product?.unit;
    const newQty = Number(adjustForm.new_qty);
    const qtyErr = qtyValidationError(newQty, unit, { allowZero: true });
    if (qtyErr) {
      alert(qtyErr);
      return;
    }
    if (!activeCities.some((c) => c.id === selectedCity)) {
      alert('Сначала восстановите город');
      return;
    }
    const fingerprint = inventoryAdjustFingerprint(selectedCity, adjustRow.product_id, newQty);
    setStockBusy(true);
    try {
      await runInventoryOperationOnce('adjust', fingerprint, async (operationId) => {
        const { error } = await supabase.rpc('apply_inventory_adjust', {
          p_operation_id: operationId,
          p_city_id: selectedCity,
          p_product_id: adjustRow.product_id,
          p_new_qty: newQty,
        });
        if (error) throw new Error(error.message);
      });
      setAdjustRow(null);
      setAdjustForm({ new_qty: '' });
      setShowAdjust(false);
      await loadInventory(selectedCity);
      await loadMovements(selectedCity);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Не удалось сохранить корректировку');
    } finally {
      setStockBusy(false);
    }
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
                const restockCity =
                  selectedCity && selectedCity !== 'ALL' && activeCities.some((c) => c.id === selectedCity)
                    ? selectedCity
                    : '';
                setRestockForm({
                  city_id: restockCity,
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

          {cityActionError && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{cityActionError}</div>
          )}

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
                {activeCities.map((c) => (
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
                step={products.find((p) => p.id === restockForm.product_id)?.unit === 'kg' ? '0.001' : '1'}
                min={products.find((p) => p.id === restockForm.product_id)?.unit === 'kg' ? '0.001' : '1'}
                value={restockForm.qty_add}
                onChange={(e) => setRestockForm({ ...restockForm, qty_add: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleRestock}
                  disabled={stockBusy}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
                >
                  {stockBusy ? 'Сохранение…' : 'Добавить'}
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
            {activeCities.map((c) => (
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
                  type="button"
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
                <button
                  type="button"
                  onClick={() => hideCity(c)}
                  className="px-2 py-1 bg-orange-100 text-orange-800 rounded text-sm"
                  title="Скрыть город"
                >
                  Скрыть
                </button>
              </div>
            ))}
          </div>

          <div className="mb-4">
            <button
              type="button"
              onClick={() => setShowHiddenCities((v) => !v)}
              className="px-3 py-2 text-sm rounded-lg bg-gray-100 text-gray-800 border border-gray-300"
            >
              {showHiddenCities
                ? 'Скрыть список неактивных городов'
                : `Показать скрытые города (${hiddenCities.length})`}
            </button>
            {showHiddenCities && (
              <div className="mt-3 p-3 rounded-lg border border-gray-200 bg-gray-50">
                <p className="text-sm font-medium text-gray-900 mb-2">Скрытые города</p>
                {hiddenCities.length === 0 ? (
                  <p className="text-sm text-gray-600">Нет скрытых городов.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {hiddenCities.map((c) => (
                      <div key={c.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedCity(c.id)}
                          className={`px-3 py-2 rounded-lg text-sm whitespace-nowrap ${
                            selectedCity === c.id ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'
                          }`}
                          title="Посмотреть остатки без восстановления"
                        >
                          {c.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => restoreCity(c)}
                          className="px-2 py-1 bg-green-600 text-white rounded text-sm"
                        >
                          Восстановить
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
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
                    {selectedCity === 'ALL' || hiddenCities.some((c) => c.id === selectedCity) ? (
                      <button
                        disabled
                        className="px-3 py-1 bg-gray-300 text-gray-600 rounded text-sm cursor-not-allowed"
                        title={
                          selectedCity === 'ALL'
                            ? 'Корректировка доступна только для конкретного города'
                            : 'Сначала восстановите город'
                        }
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
              <div className="mt-6">
                <h3 className="font-bold mb-2 text-gray-900">История склада</h3>
                {movements.length === 0 ? (
                  <p className="text-sm text-gray-600">Записей нет</p>
                ) : (
                  <ul className="space-y-1 text-sm text-gray-800">
                    {movements.map((m) => {
                      const productName =
                        products.find((p) => p.id === m.product_id)?.name ||
                        inventory.find((r) => r.product_id === m.product_id)?.product_name ||
                        m.product_id.slice(0, 8);
                      const cityName = cities.find((c) => c.id === m.city_id)?.name || m.city_id.slice(0, 8);
                      const who = m.created_by ? profilesById.get(m.created_by) || m.created_by.slice(0, 8) : '—';
                      const when = new Date(m.created_at).toLocaleString('ru-KZ');
                      const typeLabel =
                        m.type === 'restock'
                          ? 'приход'
                          : m.type === 'adjust'
                            ? 'корректировка'
                            : m.type === 'sale'
                              ? 'продажа'
                              : m.type === 'cancel_sale'
                                ? 'отмена продажи'
                                : m.type;
                      return (
                        <li key={m.id}>
                          {when} · {typeLabel} · {productName} · {cityName} · {m.qty_delta} · {who}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}

          {showAdjust && adjustRow && (
            <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-xl p-6 max-w-sm w-full">
                <h2 className="font-bold mb-2 text-gray-900">Корректировка: {adjustRow.product_name}</h2>
                <input
                  type="number"
                  step={products.find((p) => p.id === adjustRow.product_id)?.unit === 'kg' ? '0.001' : '1'}
                  min="0"
                  value={adjustForm.new_qty}
                  onChange={(e) => setAdjustForm({ new_qty: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded mb-4 bg-white text-gray-900"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleAdjust}
                    disabled={stockBusy}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
                  >
                    {stockBusy ? 'Сохранение…' : 'Сохранить'}
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
