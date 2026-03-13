'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Protected from '@/components/Protected';
import NavSeller from '@/components/NavSeller';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/auth';
import { isSessionError } from '@/lib/supabaseHelpers';
import { useTranslation } from '@/lib/i18n';
import { useEnsureActiveDevice } from '@/lib/useEnsureActiveDevice';
import { logAction } from '@/lib/actionLog';
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
  const { t } = useTranslation();
  const ensureActive = useEnsureActiveDevice();
  const router = useRouter();

  const [products, setProducts] = useState<Array<Product & { inventory?: { qty_on_hand: number } }>>([]);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [paymentType, setPaymentType] = useState<PaymentType | ''>('');
  const [comment, setComment] = useState('');
  const [orderType, setOrderType] = useState<'ordinary' | 'preorder' | 'debt'>('ordinary');
  const [pickupDate, setPickupDate] = useState('');
  const [debtCustomerPhone, setDebtCustomerPhone] = useState('');
  const [debtCustomerName, setDebtCustomerName] = useState('');
  const [debtDueAt, setDebtDueAt] = useState('');
  const [debtNote, setDebtNote] = useState('');
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
      setError(t('newOrder.cityMissing'));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data, error: qErr } = await supabase
          .from('inventory')
          .select('product_id, qty_on_hand, products(id, name, category, unit, price_retail, is_active, sort_order)')
          .eq('city_id', cityId)
          .gt('qty_on_hand', 0);
        if (cancelled) return;
        if (qErr) {
          if (isSessionError(qErr)) {
            signOut(t('auth.sessionExpired'));
            return;
          }
          setError(qErr.message);
          return;
        }
        const rows: Array<Product & { inventory?: { qty_on_hand: number } }> = [];
        for (const row of data || []) {
          const p = row.products as Product | Product[] | null;
          const prod = Array.isArray(p) ? p[0] : p;
          if (prod && prod.is_active) {
            rows.push({
              ...prod,
              inventory: { qty_on_hand: row.qty_on_hand },
            });
          }
        }
        rows.sort((a, b) => {
          const aOrder = a.sort_order ?? Number.POSITIVE_INFINITY;
          const bOrder = b.sort_order ?? Number.POSITIVE_INFINITY;
          return aOrder - bOrder;
        });
        setProducts(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('common.errorLoad'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, profile?.id, cityId, signOut]);

  const isPreorder = orderType === 'preorder';
  const isDebt = orderType === 'debt';

  function addToCart(p: Product & { inventory?: { qty_on_hand: number } }) {
    const qty = p.inventory?.qty_on_hand ?? 0;
    if (!isPreorder && !isDebt && qty <= 0) return;
    const maxQty = isPreorder ? 999 : qty;
    const existing = cart.find((c) => c.product_id === p.id);
    if (existing) {
      if ((existing.qty ?? 0) >= maxQty) return;
      setCart(cart.map((c) => (c.product_id === p.id ? { ...c, qty: (c.qty ?? 0) + 1 } : c)));
    } else {
      setCart([
        ...cart,
        {
          product_id: p.id,
          product_name: p.name,
          price_retail: p.price_retail,
          qty: 1,
          customPrice: '',
          qty_on_hand: isPreorder ? maxQty : qty,
        },
      ]);
    }
  }

  function updateCartQty(productId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((c) => {
          if (c.product_id !== productId) return c;
          const maxTotal = isPreorder ? 999 : c.qty_on_hand;
          const newQty = Math.max(0, Math.min(maxTotal, (c.qty ?? 0) + delta));
          return { ...c, qty: newQty };
        })
        .filter((c) => (c.qty ?? 0) > 0)
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

  const totalSum = cart.reduce((acc, item) => acc + getPrice(item) * (item.qty ?? 0), 0);

  const canSubmit =
    cart.length > 0 &&
    !!profile?.id &&
    !!cityId &&
    (isPreorder || isDebt || cart.every((c) => (c.qty ?? 0) <= c.qty_on_hand)) &&
    (orderType === 'ordinary' || orderType === 'preorder' ? !!paymentType : true) &&
    (orderType !== 'debt' || debtCustomerPhone.trim() !== '');

  async function handleConfirm() {
    if (!canSubmit || !profile?.id || !cityId) return;
    if (!(await ensureActive())) return;
    const isDebtToggle = orderType === 'debt';
    const phone = (debtCustomerPhone ?? '').toString().trim();
    if (isDebtToggle && !phone) {
      setError(t('newOrder.debtPhoneRequired'));
      return;
    }
    if (isPreorder && !paymentType) {
      alert(t('newOrder.mustSelectPayment'));
      return;
    }
    if (!isPreorder && !isDebtToggle) {
      const over = cart.find((c) => (c.qty ?? 0) > c.qty_on_hand);
      if (over) {
        setError(t('newOrder.insufficientStock'));
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    const todayYYYYMMDD = new Date().toISOString().slice(0, 10);
    try {
      const items = cart.map((item) => ({
        product_id: item.product_id,
        qty: item.qty ?? 0,
        price: getPrice(item).toString(),
      }));
      const isPreorderToggle = orderType === 'preorder';
      const pickedDate = pickupDate && pickupDate.trim() !== '' ? pickupDate.trim() : null;

      const payload: Record<string, unknown> = {
        items,
        payment_type: isDebtToggle ? 'debt' : paymentType || null,
        comment: isDebtToggle ? null : comment || null,
        is_preorder: isPreorderToggle,
        preorder_status: isPreorderToggle ? 'pending' : undefined,
        pickup_date: isPreorderToggle ? (pickedDate ?? todayYYYYMMDD) : null,
      };

      if (isDebtToggle) {
        payload.is_debt = true;
        payload.payment_type = 'debt';
        payload.debt_status = 'active';
        payload.debt_customer_phone = phone;
        payload.is_preorder = false;
        payload.preorder_status = undefined;
        payload.pickup_date = null;
      }

      const { data, error: rpcError } = await supabase.rpc('confirm_order', {
        payload,
      });

      if (rpcError) {
        if (isSessionError(rpcError)) {
          signOut(t('auth.sessionExpired'));
          return;
        }
        setError(rpcError.message);
        return;
      }
      const orderId = data as string;
      if (isPreorderToggle && orderId) {
        await supabase
          .from('orders')
          .update({
            is_preorder: true,
            preorder_status: 'pending',
            pickup_date: pickedDate ?? todayYYYYMMDD,
          })
          .eq('id', orderId);
      }
      if (isDebtToggle && orderId) {
        await supabase
          .from('orders')
          .update({
            is_debt: true,
            payment_type: 'debt',
            debt_status: 'active',
            debt_customer_phone: phone,
            updated_at: new Date().toISOString(),
          })
          .eq('id', orderId);
      }
      setCart([]);
      setPaymentType('');
      setComment('');
      setOrderType('ordinary');
      setPickupDate('');
      setDebtCustomerPhone('');
      setDebtCustomerName('');
      setDebtDueAt('');
      setDebtNote('');
      const action = isDebtToggle ? 'debt_create' : isPreorderToggle ? 'preorder_create' : 'order_create';
      void logAction(supabase, {
        user_id: profile.id,
        user_name: profile.display_name ?? null,
        user_role: profile.role ?? 'seller',
        action,
        entity_type: 'order',
        entity_id: orderId,
        details: { total: totalSum, items_count: cart.length },
      });
      router.refresh();
      router.push(isDebtToggle ? `/seller/debts` : `/seller/orders?id=${orderId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Protected role="seller">
      <div className="min-h-screen pb-24 md:pb-4 w-full max-w-full overflow-x-hidden bg-white">
        <div className="p-3 sm:p-4 w-full max-w-full min-w-0">
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <Link href="/seller" className="text-blue-600 font-medium text-sm">
              {t('common.back')}
            </Link>
          </div>

          <h1 className="text-lg sm:text-2xl font-bold mb-3 sm:mb-4 text-gray-900">{t('newOrder.title')}</h1>

          {error && <div className="mb-3 text-red-600 text-sm">{error}</div>}

          <input
            type="text"
            placeholder={t('newOrder.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-full px-4 py-3 sm:px-4 sm:py-3 border border-gray-300 rounded-xl mb-3 sm:mb-4 text-base min-h-[48px] text-gray-900 placeholder-gray-400 bg-white"
          />

          {loading ? (
            <p className="text-sm text-gray-900">{t('common.loading')}</p>
          ) : !profile ? (
            <p className="text-sm text-gray-900">{t('common.noProfile')}</p>
          ) : (
            <div className="space-y-2 mb-4 sm:mb-6">
              {filteredProducts.map((p) => (
                <div key={p.id} className="flex justify-between items-center gap-2 p-2 sm:p-3 bg-gray-50 rounded-lg min-w-0">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate text-gray-900">{p.name}</p>
                    <p className="text-xs text-gray-600">
                      {formatMoney(p.price_retail)} ₸ · {t('newOrder.stock')}: {p.inventory?.qty_on_hand ?? 0}
                    </p>
                  </div>
                  <button
                    onClick={() => addToCart(p)}
                    disabled={!isPreorder && (p.inventory?.qty_on_hand ?? 0) <= 0}
                    className="shrink-0 min-h-[48px] min-w-[48px] w-12 h-12 flex items-center justify-center bg-green-600 text-white rounded-xl disabled:opacity-50 text-lg font-medium"
                  >
                    +
                  </button>
                </div>
              ))}
              {filteredProducts.length === 0 && <p className="text-gray-600 text-sm">{t('newOrder.noProducts')}</p>}
            </div>
          )}

          {cart.length > 0 && (
            <div className="border border-gray-200 rounded-xl p-3 sm:p-4 mb-3 sm:mb-4 bg-white w-full max-w-full min-w-0">
              <div className="flex justify-between items-center gap-4 pb-3 mb-3 border-b border-gray-200">
                <h2 className="font-bold text-sm sm:text-base text-gray-900">{t('newOrder.cart')}</h2>
                <button
                  type="button"
                  onClick={() => {
                    if (!confirm(t('newOrder.clearCartConfirm'))) return;
                    setCart([]);
                  }}
                  className="shrink-0 px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg bg-gray-50 text-gray-700 hover:bg-gray-100 hover:border-gray-400"
                >
                  {t('newOrder.clearCart')}
                </button>
              </div>
              <div className="space-y-2 sm:space-y-3">
                {cart.map((item) => {
                  const qty = item.qty ?? 0;
                  return (
                    <div
                      key={item.product_id}
                      className="flex flex-wrap gap-2 sm:gap-3 items-center border-b border-gray-200 pb-3 last:border-0 min-w-0"
                    >
                      <span className="font-medium flex-1 min-w-0 text-sm truncate text-gray-900">{item.product_name}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.product_id, -1)}
                          className="min-h-[48px] min-w-[48px] w-12 h-12 flex items-center justify-center bg-gray-300 hover:bg-gray-400 rounded-xl text-lg font-medium"
                        >
                          −
                        </button>
                        <span className="min-w-[2.5rem] text-center text-sm font-medium tabular-nums text-gray-900">{qty}</span>
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.product_id, 1)}
                          className="min-h-[48px] min-w-[48px] w-12 h-12 flex items-center justify-center bg-gray-300 hover:bg-gray-400 rounded-xl text-lg font-medium"
                        >
                          +
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                        <span className="text-xs sm:text-sm shrink-0 text-gray-600">{t('newOrder.priceDefault')} {formatMoney(item.price_retail)}</span>
                        <input
                          type="number"
                          placeholder={t('newOrder.priceCustom')}
                          value={item.customPrice}
                          onChange={(e) => updateCustomPrice(item.product_id, e.target.value)}
                          className="w-20 sm:w-24 px-2 py-2 border border-gray-300 rounded-lg text-sm min-h-[48px] text-gray-900 placeholder-gray-400 bg-white"
                        />
                        <span className="font-medium text-sm shrink-0 text-gray-900">{formatMoney(getPrice(item) * qty)} ₸</span>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.product_id, 1)}
                          className="min-h-[40px] px-2 rounded-lg bg-gray-200 text-xs font-medium hover:bg-gray-300"
                        >
                          +1
                        </button>
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.product_id, 5)}
                          className="min-h-[40px] px-2 rounded-lg bg-gray-200 text-xs font-medium hover:bg-gray-300"
                        >
                          +5
                        </button>
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.product_id, 10)}
                          className="min-h-[40px] px-2 rounded-lg bg-gray-200 text-xs font-medium hover:bg-gray-300"
                        >
                          +10
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="font-bold mt-2 text-sm text-gray-900">{t('newOrder.total')}: {formatMoney(totalSum)} ₸</p>
            </div>
          )}

          {cart.length > 0 && (
            <div className="space-y-3 sm:space-y-4 mb-4 pb-24 md:pb-0">
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-900">{t('newOrder.orderType')}</label>
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      name="orderType"
                      checked={orderType === 'ordinary'}
                      onChange={() => setOrderType('ordinary')}
                      className="rounded-full border-gray-300"
                    />
                    <span className="text-sm text-gray-900">{t('newOrder.ordinary')}</span>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      name="orderType"
                      checked={orderType === 'preorder'}
                      onChange={() => {
                        setOrderType('preorder');
                        setPaymentType((p) => p || 'kaspi');
                      }}
                      className="rounded-full border-gray-300"
                    />
                    <span className="text-sm text-gray-900">{t('newOrder.preorder')}</span>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      name="orderType"
                      checked={orderType === 'debt'}
                      onChange={() => setOrderType('debt')}
                      className="rounded-full border-gray-300"
                    />
                    <span className="text-sm text-gray-900">{t('newOrder.debt')}</span>
                  </label>
                </div>
              </div>
              {orderType === 'ordinary' && (
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-900">{t('newOrder.paymentType')}</label>
                  <select
                    value={paymentType}
                    onChange={(e) => setPaymentType(e.target.value as PaymentType | '')}
                    className="w-full max-w-full px-4 py-3 border border-gray-300 rounded-xl min-h-[48px] text-gray-900 bg-white"
                  >
                    <option value="">{t('common.choose')}</option>
                    <option value="cash">{t('common.cash')}</option>
                    <option value="kaspi">{t('common.kaspi')}</option>
                    <option value="transfer">{t('common.transfer')}</option>
                  </select>
                </div>
              )}
              {orderType === 'preorder' && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-gray-900">{t('newOrder.paymentMethod')}</label>
                    <select
                      value={paymentType}
                      onChange={(e) => setPaymentType(e.target.value as PaymentType | '')}
                      className="w-full max-w-full px-4 py-3 border border-gray-300 rounded-xl min-h-[48px] text-gray-900 bg-white"
                    >
                      <option value="">{t('common.choose')}</option>
                      <option value="cash">{t('common.cash')}</option>
                      <option value="kaspi">{t('common.kaspiQR')}</option>
                      <option value="transfer">{t('common.transfer')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1 text-gray-900">{t('newOrder.pickupOptional')}</label>
                    <input
                      type="date"
                      value={pickupDate}
                      onChange={(e) => setPickupDate(e.target.value)}
                      className="w-full max-w-full px-4 py-3 border border-gray-300 rounded-xl min-h-[48px] text-gray-900 bg-white"
                    />
                  </div>
                </>
              )}
              {orderType === 'debt' && (
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-900">{t('newOrder.phoneRequired')}</label>
                  <input
                    type="tel"
                    value={debtCustomerPhone}
                    onChange={(e) => setDebtCustomerPhone(e.target.value)}
                    placeholder={t('newOrder.phonePlaceholder')}
                    className="w-full max-w-full px-4 py-3 border border-gray-300 rounded-xl min-h-[48px] text-gray-900 placeholder-gray-400 bg-white"
                  />
                </div>
              )}
              {orderType !== 'debt' && (
                <div>
                  <label className="block text-sm font-medium mb-1 text-gray-900">{t('newOrder.commentOptional')}</label>
                  <input
                    type="text"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="w-full max-w-full px-4 py-3 border border-gray-300 rounded-xl min-h-[48px] text-gray-900 placeholder-gray-400 bg-white"
                  />
                </div>
              )}
              <div className="sticky bottom-20 left-0 right-0 z-30 bg-white border-t border-gray-200 py-3 -mx-3 px-3 md:static md:border-0 md:py-0 md:mx-0">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={!canSubmit || submitting}
                  className="w-full max-w-full py-3 bg-green-600 text-white font-bold rounded-xl disabled:opacity-50 min-h-[52px] text-base"
                >
                  {submitting ? t('newOrder.saving') : t('newOrder.submit')}
                </button>
              </div>
            </div>
          )}
        </div>
        <NavSeller />
      </div>
    </Protected>
  );
}
