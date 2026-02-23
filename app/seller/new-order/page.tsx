'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';
import type { Product, PaymentType } from '@/lib/types';

function formatMoney(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

interface CartItem {
  product_id: string;
  product_name: string;
  price_retail: number;
  qty: number;
  customPrice: string;
  qty_on_hand: number;
}

export default function NewOrderPage() {
  const { profile, authReady, signOut } = useAuth();
  const router = useRouter();

  const [products, setProducts] = useState<Array<Product & { inventory?: { qty_on_hand: number } }>>([]);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [paymentType, setPaymentType] = useState<PaymentType | ''>('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cityId = profile?.city_id ?? null;

  const filteredProducts = useMemo(() => {
    return products.filter((p) => p.is_active && p.name.toLowerCase().includes(search.toLowerCase()));
  }, [products, search]);

  useEffect(() => {
    if (!authReady || !profile?.id) {
      setLoading(false);
      return;
    }
    if (!cityId) {
      setLoading(false);
      setError('У продавца не указан city_id в profiles');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data: invData, error: invErr } = await supabase
          .from('inventory')
          .select('product_id, qty_on_hand')
          .eq('city_id', cityId);
        if (cancelled) return;
        if (invErr) {
          if (isSessionError(invErr)) {
            signOut('Сессия истекла');
            return;
          }
          setError(invErr.message);
          return;
        }
        const { data: prodData, error: prodErr } = await supabase
          .from('products')
          .select('*')
          .eq('is_active', true);
        if (cancelled) return;
        if (prodErr) {
          if (isSessionError(prodErr)) {
            signOut('Сессия истекла');
            return;
          }
          setError(prodErr.message);
          return;
        }
        const invMap = new Map((invData || []).map((i) => [i.product_id, i.qty_on_hand]));
        setProducts(
          (prodData || []).map((p) => ({
            ...(p as Product),
            inventory: { qty_on_hand: invMap.get((p as Product).id) ?? 0 },
          }))
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, profile?.id, cityId, signOut]);

  function addToCart(p: Product & { inventory?: { qty_on_hand: number } }) {
    const qty = p.inventory?.qty_on_hand ?? 0;
    if (qty <= 0) return;
    const existing = cart.find((c) => c.product_id === p.id);
    if (existing) {
      if (existing.qty >= qty) return;
      setCart(cart.map((c) => (c.product_id === p.id ? { ...c, qty: c.qty + 1 } : c)));
    } else {
      setCart([
        ...cart,
        {
          product_id: p.id,
          product_name: p.name,
          price_retail: p.price_retail,
          qty: 1,
          customPrice: '',
          qty_on_hand: qty,
        },
      ]);
    }
  }

  function updateCartQty(productId: string, delta: number) {
    setCart(
      cart
        .map((c) => {
          if (c.product_id !== productId) return c;
          const newQty = Math.max(0, Math.min(c.qty_on_hand, c.qty + delta));
          return { ...c, qty: newQty };
        })
        .filter((c) => c.qty > 0)
    );
  }

  function updateCustomPrice(productId: string, value: string) {
    setCart(cart.map((c) => (c.product_id === productId ? { ...c, customPrice: value } : c)));
  }

  function getPrice(item: CartItem): number {
    const n = parseFloat(item.customPrice);
    if (!isNaN(n) && n >= 0) return n;
    return item.price_retail;
  }

  const totalSum = cart.reduce((acc, item) => acc + getPrice(item) * item.qty, 0);

  const canSubmit =
    cart.length > 0 && paymentType && cart.every((c) => c.qty <= c.qty_on_hand) && !!profile?.id && !!cityId;

  async function handleConfirm() {
    if (!canSubmit || !profile?.id || !cityId) return;
    setSubmitting(true);
    setError(null);
    try {
      const items = cart.map((item) => ({
        product_id: item.product_id,
        qty: item.qty,
        price: getPrice(item).toString(),
      }));
      const { data, error: rpcError } = await supabase.rpc('confirm_order', {
        payload: { items, payment_type: paymentType, comment: comment || null },
      });
      if (rpcError) {
        if (isSessionError(rpcError)) {
          signOut('Сессия истекла');
          return;
        }
        setError(rpcError.message);
        return;
      }
      setCart([]);
      setPaymentType('');
      setComment('');
      router.push(`/seller/orders?id=${data}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Link href="/seller" className="text-blue-600 font-medium">
              ← Назад
            </Link>
          </div>

          <h1 className="text-2xl font-bold mb-4">Новый заказ</h1>

          {error && <div className="mb-3 text-red-600">{error}</div>}

          <input
            type="text"
            placeholder="Поиск товара"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-4 py-3 border rounded-lg mb-4"
          />

          {loading ? (
            <p>Загрузка...</p>
          ) : !profile ? (
            <p>Нет профиля. Перезайди в аккаунт.</p>
          ) : (
            <div className="space-y-2 mb-6">
              {filteredProducts.map((p) => (
                <div key={p.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-sm text-gray-500">
                      {formatMoney(p.price_retail)} ₸ · Остаток: {p.inventory?.qty_on_hand ?? 0}
                    </p>
                  </div>
                  <button
                    onClick={() => addToCart(p)}
                    disabled={(p.inventory?.qty_on_hand ?? 0) <= 0}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg disabled:opacity-50"
                  >
                    +
                  </button>
                </div>
              ))}
              {filteredProducts.length === 0 && <p className="text-gray-500">Товары не найдены</p>}
            </div>
          )}

          {cart.length > 0 && (
            <div className="border rounded-xl p-4 mb-4 bg-white">
              <h2 className="font-bold mb-3">Корзина</h2>
              <div className="space-y-3">
                {cart.map((item) => (
                  <div
                    key={item.product_id}
                    className="flex flex-wrap gap-2 items-center border-b pb-2 last:border-0"
                  >
                    <span className="font-medium flex-1 min-w-[120px]">{item.product_name}</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => updateCartQty(item.product_id, -1)} className="w-8 h-8 bg-gray-300 rounded">-</button>
                      <span className="w-8 text-center">{item.qty}</span>
                      <button onClick={() => updateCartQty(item.product_id, 1)} className="w-8 h-8 bg-gray-300 rounded">+</button>
                    </div>
                    <span className="text-sm">цена по умолч. {formatMoney(item.price_retail)}</span>
                    <input
                      type="number"
                      placeholder="другая цена"
                      value={item.customPrice}
                      onChange={(e) => updateCustomPrice(item.product_id, e.target.value)}
                      className="w-24 px-2 py-1 border rounded text-sm"
                    />
                    <span className="font-medium">{formatMoney(getPrice(item) * item.qty)} ₸</span>
                  </div>
                ))}
              </div>
              <p className="font-bold mt-2">Итого: {formatMoney(totalSum)} ₸</p>
            </div>
          )}

          {cart.length > 0 && (
            <div className="space-y-4 mb-4">
              <div>
                <label className="block text-sm font-medium mb-1">Тип оплаты</label>
                <select
                  value={paymentType}
                  onChange={(e) => setPaymentType(e.target.value as PaymentType | '')}
                  className="w-full px-4 py-3 border rounded-lg"
                >
                  <option value="">Выберите</option>
                  <option value="cash">Наличные</option>
                  <option value="kaspi">Kaspi</option>
                  <option value="card">Карта</option>
                  <option value="transfer">Перевод</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Комментарий (опционально)</label>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg"
                />
              </div>
              <button
                onClick={handleConfirm}
                disabled={!canSubmit || submitting}
                className="w-full py-3 bg-green-600 text-white font-bold rounded-lg disabled:opacity-50"
              >
                {submitting ? 'Сохранение...' : 'Подтвердить'}
              </button>
            </div>
          )}
        </div>
        <NavSeller />
      </div>
    </Protected>
  );
}
