'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { AssistantDraftRow, DraftCandidate, DraftItemResolved } from '@/lib/assistant/orderDraftTypes';
import type { PaymentType } from '@/lib/types';
import DraftProductPicker from '@/components/DraftProductPicker';
import SimilarOrdersWarning from '@/components/SimilarOrdersWarning';
import {
  lookupSimilarOrders,
  similarCompositionKey,
  similarMatchIds,
  similarMatchesAcknowledged,
  type SimilarAck,
  type SimilarOrderMatch,
} from '@/lib/similarOrders';
import { useAuth } from '@/lib/auth';
import { draftChoiceHints } from '@/lib/assistant/invoiceResolve';
import { confirmedOrderLabel } from '@/lib/assistant/draftCardSync';

function money(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

type CatalogSeller = { id: string; name: string; city_id: string; city_name: string };
type CatalogProduct = { id: string; name: string; unit: string | null; price_retail?: number };
type CatalogCity = { id: string; name: string };
type CatalogPayment = { id: string; label: string };

type Catalog = {
  sellers: CatalogSeller[];
  products: CatalogProduct[];
  cities: CatalogCity[];
  payments: CatalogPayment[];
};

type EditLine = {
  product_id: string;
  qty: string;
  is_gift: boolean;
  raw_name: string;
  unresolved: boolean;
  candidates: DraftCandidate[];
};

type SaveBody = {
  seller_id: string;
  city_id: string;
  payment_type: string | null;
  is_debt: boolean;
  is_preorder: boolean;
  invoice_date: string | null;
  invoice_time: string | null;
  pickup_date: string | null;
  items: { product_id: string; qty: number; is_gift: boolean; raw_name: string }[];
};

type Props = {
  draft: AssistantDraftRow;
  readOnly: boolean;
  busy: boolean;
  onConfirm: (
    id: string,
    opts?: { acknowledgedSimilarIds?: string[]; acknowledgedComposition?: string }
  ) => void;
  onCancel: (id: string) => void;
  onUpdated: () => Promise<void> | void;
  serverSimilarMatches?: SimilarOrderMatch[];
};

function totalReady(draft: AssistantDraftRow) {
  const preview = draft.preview;
  if (!preview) return false;
  if (typeof preview.total_ready === 'boolean') return preview.total_ready;
  if ((preview.items || []).some((i) => i.unresolved)) return false;
  return !(draft.errors || []).some((e) => e.code === 'product_ambiguous' || e.code === 'product_not_found');
}

function seedLines(draft: AssistantDraftRow): EditLine[] {
  const resolvedItems = draft.resolved?.items;
  if (resolvedItems?.length) {
    return resolvedItems.map((item: DraftItemResolved) => ({
      product_id: item.product_id || '',
      qty: String(item.qty || 1),
      is_gift: item.is_gift === true,
      raw_name: item.raw_name || item.product_name || '',
      unresolved: item.unresolved || !item.product_id,
      candidates: item.candidates || [],
    }));
  }
  return (draft.preview?.items || []).map((item) => ({
    product_id: '',
    qty: String(item.qty || 1),
    is_gift: item.is_gift === true,
    raw_name: item.name || '',
    unresolved: item.unresolved === true,
    candidates: item.candidates || [],
  }));
}

export default function AssistantOrderDraftCard({
  draft,
  readOnly,
  busy,
  onConfirm,
  onCancel,
  onUpdated,
  serverSimilarMatches = [],
}: Props) {
  const preview = draft.preview || {
    seller_name: null,
    city_name: null,
    items: [],
    total_sum: 0,
    total_ready: false,
    payment_label: '',
    is_debt: false,
    is_preorder: false,
    invoice_date: null,
    invoice_time: null,
    pickup_date: null,
  };
  const blocked = !draft.can_confirm || draft.status === 'blocked' || draft.status === 'cancelled';
  const done = draft.status === 'confirmed';
  const pending = draft.status === 'confirming';
  const locked = done || pending || draft.status === 'cancelled';
  const ready = totalReady(draft);

  const [editing, setEditing] = useState(() => !readOnly && draft.status === 'blocked' && !draft.can_confirm);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');
  const [autoOpened, setAutoOpened] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [sellerId, setSellerId] = useState(draft.resolved?.seller_id || '');
  const [cityId, setCityId] = useState(draft.resolved?.city_id || '');
  const [paymentType, setPaymentType] = useState<PaymentType | ''>(
    draft.resolved?.is_debt ? 'debt' : draft.resolved?.payment_type || ''
  );
  const [isDebt, setIsDebt] = useState(draft.resolved?.is_debt === true || preview.is_debt === true);
  const [isPreorder, setIsPreorder] = useState(draft.resolved?.is_preorder === true || preview.is_preorder === true);
  const [invoiceDate, setInvoiceDate] = useState(draft.resolved?.invoice_date || preview.invoice_date || '');
  const [invoiceTime, setInvoiceTime] = useState(draft.resolved?.invoice_time || preview.invoice_time || '');
  const [pickupDate, setPickupDate] = useState(draft.resolved?.pickup_date || preview.pickup_date || '');
  const [lines, setLines] = useState<EditLine[]>(() => seedLines(draft));
  const { profile } = useAuth();
  const [similarWarning, setSimilarWarning] = useState<SimilarOrderMatch[]>([]);
  const [similarAck, setSimilarAck] = useState<SimilarAck | null>(null);
  const [similarChecking, setSimilarChecking] = useState(false);

  const selectedSeller = catalog?.sellers.find((s) => s.id === sellerId) || null;
  const sellerCities = useMemo(() => {
    if (!catalog) return [];
    if (!selectedSeller) return catalog.cities;
    return catalog.cities.filter((c) => c.id === selectedSeller.city_id);
  }, [catalog, selectedSeller]);

  const shownSimilar = similarWarning.length > 0 ? similarWarning : serverSimilarMatches;
  const draftComposition = similarCompositionKey({
    sellerId: draft.resolved?.seller_id || '',
    cityId: draft.resolved?.city_id || '',
    customerPhone: draft.customer_phone || null,
    items: (draft.resolved?.items || [])
      .filter((item) => item.product_id && Number(item.qty) > 0)
      .map((item) => ({
        product_id: String(item.product_id),
        qty: Number(item.qty),
        is_gift: item.is_gift === true,
      })),
  });

  const choiceHints = draftChoiceHints([...(draft.errors || []), ...(draft.warnings || [])]);
  const needsPaymentPick =
    (draft.errors || []).some((e) =>
      ['payment_unspecified', 'payment_missing', 'payment_ambiguous'].includes(e.code)
    ) && !isDebt;

  useEffect(() => {
    setSimilarWarning([]);
    setSimilarAck(null);
  }, [draftComposition]);

  useEffect(() => {
    if (readOnly || locked || draft.can_confirm || draft.status === 'cancelled') return;
    if (autoOpened) return;
    setAutoOpened(true);
    void openEdit();
    // openEdit is stable enough per draft id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  useEffect(() => {
    if (readOnly || locked || !draft.can_confirm) return;
    const seller = draft.resolved?.seller_id || '';
    const city = draft.resolved?.city_id || '';
    const items = (draft.resolved?.items || [])
      .filter((item) => item.product_id && Number(item.qty) > 0)
      .map((item) => ({
        product_id: String(item.product_id),
        qty: Number(item.qty),
        is_gift: item.is_gift === true,
      }));
    if (!seller || !city || items.length === 0) return;
    let cancelled = false;
    void lookupSimilarOrders(supabase, {
      sellerId: seller,
      cityId: city,
      items,
      customerPhone: draft.customer_phone || null,
      excludeIdempotencyKey: draft.idempotency_key || null,
    }).then((similar) => {
      if (cancelled || !similar.ok) return;
      if (similar.result.matches.length > 0) setSimilarWarning(similar.result.matches);
    });
    return () => {
      cancelled = true;
    };
  }, [
    draft.can_confirm,
    draft.customer_phone,
    draft.idempotency_key,
    draft.resolved?.city_id,
    draft.resolved?.items,
    draft.resolved?.seller_id,
    locked,
    readOnly,
  ]);

  async function requestConfirm(ackOverride?: SimilarAck | null) {
    if (readOnly || locked || done) return;
    const seller = draft.resolved?.seller_id || '';
    const city = draft.resolved?.city_id || '';
    const items = (draft.resolved?.items || [])
      .filter((item) => item.product_id && Number(item.qty) > 0)
      .map((item) => ({
        product_id: String(item.product_id),
        qty: Number(item.qty),
        is_gift: item.is_gift === true,
      }));
    if (!seller || !city || items.length === 0) {
      setLocalError('Нельзя проверить похожие заказы: нет продавца, города или товаров.');
      return;
    }
    setSimilarChecking(true);
    setLocalError('');
    try {
      const composition = similarCompositionKey({
        sellerId: seller,
        cityId: city,
        customerPhone: draft.customer_phone || null,
        items,
      });
      const similar = await lookupSimilarOrders(supabase, {
        sellerId: seller,
        cityId: city,
        items,
        customerPhone: draft.customer_phone || null,
        excludeIdempotencyKey: draft.idempotency_key || null,
      });
      if (!similar.ok) {
        setLocalError(similar.error);
        return;
      }
      const ack = ackOverride === undefined ? similarAck : ackOverride;
      if (
        similar.result.matches.length > 0 &&
        !similarMatchesAcknowledged(ack, composition, similar.result.matches)
      ) {
        setSimilarWarning(similar.result.matches);
        return;
      }
      setSimilarWarning([]);
      onConfirm(draft.id, {
        acknowledgedSimilarIds: similarMatchIds(similar.result.matches),
        acknowledgedComposition: composition,
      });
    } finally {
      setSimilarChecking(false);
    }
  }

  async function token() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  }

  async function loadCatalog(access: string) {
    const res = await fetch('/api/assistant/orders/catalog', {
      headers: { Authorization: `Bearer ${access}` },
    });
    const payload = (await res.json().catch(() => ({}))) as Catalog & { ok?: boolean; message?: string };
    if (!res.ok || payload.ok === false) {
      throw new Error(payload.message || 'Не удалось загрузить справочники.');
    }
    const next = {
      sellers: payload.sellers || [],
      products: payload.products || [],
      cities: payload.cities || [],
      payments: payload.payments || [],
    };
    setCatalog(next);
    return next;
  }

  async function persistItems(
    nextLines: EditLine[],
    overrides?: { payment_type?: PaymentType | ''; is_debt?: boolean }
  ) {
    const access = await token();
    if (!access) {
      setLocalError('Сессия истекла. Войдите снова.');
      return false;
    }
    const seller = sellerId || draft.resolved?.seller_id || '';
    const city = cityId || draft.resolved?.city_id || '';
    if (!seller || !city) {
      setLocalError('Сначала выберите продавца и город.');
      return false;
    }
    const items = nextLines.map((line) => ({
      product_id: line.product_id,
      qty: Number(String(line.qty).replace(',', '.')),
      is_gift: line.is_gift,
      raw_name: line.raw_name,
    }));
    const debt = overrides?.is_debt ?? isDebt;
    const pay = overrides?.payment_type !== undefined ? overrides.payment_type : paymentType;
    const body: SaveBody = {
      seller_id: seller,
      city_id: city,
      payment_type: debt ? 'debt' : pay || draft.resolved?.payment_type || null,
      is_debt: debt,
      is_preorder: isPreorder && !debt,
      invoice_date: invoiceDate || draft.resolved?.invoice_date || null,
      invoice_time: invoiceTime || draft.resolved?.invoice_time || null,
      pickup_date: isPreorder && !debt ? pickupDate || draft.resolved?.pickup_date || null : null,
      items,
    };
    const res = await fetch('/api/assistant/orders/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
      body: JSON.stringify({ draftId: draft.id, ...body }),
    });
    const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok || payload.ok === false) {
      setLocalError(payload.message || 'Не удалось сохранить черновик.');
      return false;
    }
    await onUpdated();
    return true;
  }

  async function pickResolvedProduct(idx: number, product: { id: string; name: string; price: number }) {
    if (readOnly || busy || locked || saving) return;
    const next = seedLines(draft).map((line, i) =>
      i === idx ? { ...line, product_id: product.id, raw_name: product.name, unresolved: false } : line
    );
    setSaving(true);
    setLocalError('');
    try {
      const access = await token();
      if (!access) {
        setLocalError('Сессия истекла. Войдите снова.');
        return;
      }
      if (!catalog) await loadCatalog(access);
      const ok = await persistItems(next);
      if (ok) setEditing(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setSaving(false);
    }
  }

  async function openEdit() {
    if (readOnly || busy || locked) return;
    setLocalError('');
    const access = await token();
    if (!access) {
      setLocalError('Сессия истекла. Войдите снова.');
      return;
    }
    try {
      await loadCatalog(access);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Не удалось загрузить справочники.');
      return;
    }
    setSellerId(draft.resolved?.seller_id || '');
    setCityId(draft.resolved?.city_id || '');
    setPaymentType(draft.resolved?.is_debt ? 'debt' : draft.resolved?.payment_type || '');
    setIsDebt(draft.resolved?.is_debt === true || preview.is_debt === true);
    setIsPreorder(draft.resolved?.is_preorder === true || preview.is_preorder === true);
    setInvoiceDate(draft.resolved?.invoice_date || preview.invoice_date || '');
    setInvoiceTime(draft.resolved?.invoice_time || preview.invoice_time || '');
    setPickupDate(draft.resolved?.pickup_date || preview.pickup_date || '');
    setLines(seedLines(draft));
    setEditing(true);
  }

  function changeSeller(id: string) {
    setSellerId(id);
    const seller = catalog?.sellers.find((s) => s.id === id);
    if (seller) setCityId(seller.city_id);
  }

  function changeLine(idx: number, patch: Partial<EditLine>) {
    setLines((prev) =>
      prev.map((line, i) =>
        i === idx
          ? {
              ...line,
              ...patch,
              unresolved: patch.product_id !== undefined ? !patch.product_id : line.unresolved,
            }
          : line
      )
    );
  }

  function addLine() {
    setLines((prev) => [...prev, { product_id: '', qty: '1', is_gift: false, raw_name: '', unresolved: true, candidates: [] }]);
  }

  async function saveChanges() {
    if (readOnly || busy || saving) return;
    setSaving(true);
    setLocalError('');
    try {
      const ok = await persistItems(lines);
      if (ok) setEditing(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setSaving(false);
    }
  }

  function closeEditWithoutSave() {
    if (saving) return;
    setSellerId(draft.resolved?.seller_id || '');
    setCityId(draft.resolved?.city_id || '');
    setPaymentType(draft.resolved?.is_debt ? 'debt' : draft.resolved?.payment_type || '');
    setIsDebt(draft.resolved?.is_debt === true || preview.is_debt === true);
    setIsPreorder(draft.resolved?.is_preorder === true || preview.is_preorder === true);
    setInvoiceDate(draft.resolved?.invoice_date || preview.invoice_date || '');
    setInvoiceTime(draft.resolved?.invoice_time || preview.invoice_time || '');
    setPickupDate(draft.resolved?.pickup_date || preview.pickup_date || '');
    setLines(seedLines(draft));
    setLocalError('');
    setEditing(false);
  }

  async function quickSetPayment(next: PaymentType) {
    if (readOnly || busy || locked || saving) return;
    setIsDebt(false);
    setPaymentType(next);
    const seller = sellerId || draft.resolved?.seller_id || '';
    const city = cityId || draft.resolved?.city_id || '';
    if (!seller || !city) {
      setLocalError('Сначала выберите продавца, затем Kaspi или наличные.');
      if (!editing) void openEdit();
      return;
    }
    setSaving(true);
    setLocalError('');
    try {
      const access = await token();
      if (!access) {
        setLocalError('Сессия истекла. Войдите снова.');
        return;
      }
      if (!catalog) await loadCatalog(access);
      const ok = await persistItems(seedLines(draft), { payment_type: next, is_debt: false });
      if (ok) setEditing(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Сеть недоступна.');
    } finally {
      setSaving(false);
    }
  }

  function requestCancel() {
    if (readOnly || busy || locked) return;
    const ok = window.confirm('Отменить этот черновик? Заказ создан не будет. Это нельзя отменить.');
    if (ok) onCancel(draft.id);
  }

  return (
    <div className="mt-2 rounded-xl border border-gray-300 bg-white p-3 text-gray-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Предварительный заказ</p>
      {done ? (
        <p className="mt-1 text-sm font-medium text-green-800">
          {confirmedOrderLabel(draft.order_number, draft.order_id)}
        </p>
      ) : null}
      {pending ? <p className="mt-1 text-sm text-amber-800">Заказ обрабатывается, статус ещё не подтверждён.</p> : null}
      {draft.status === 'cancelled' ? <p className="mt-1 text-sm text-gray-600">Черновик отменён.</p> : null}
      {localError ? <p className="mt-1 text-sm text-red-700">{localError}</p> : null}
      {choiceHints.length > 0 && !done && draft.status !== 'cancelled' ? (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
          <p className="font-medium">Чтобы подтвердить заказ, выберите:</p>
          <ul className="mt-1 list-disc pl-4">
            {choiceHints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {needsPaymentPick && !readOnly && !locked ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || saving}
            onClick={() => void quickSetPayment('kaspi')}
            className="px-3 py-2 rounded-lg bg-red-600 text-white disabled:opacity-50"
          >
            Kaspi
          </button>
          <button
            type="button"
            disabled={busy || saving}
            onClick={() => void quickSetPayment('cash')}
            className="px-3 py-2 rounded-lg bg-gray-800 text-white disabled:opacity-50"
          >
            Наличные
          </button>
        </div>
      ) : null}

      {editing && catalog ? (
        <div className="mt-2 space-y-2">
          <label className="block text-sm">
            <span className="text-gray-500">Продавец</span>
            <select
              value={sellerId}
              onChange={(e) => changeSeller(e.target.value)}
              className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1.5"
            >
              <option value="">Выберите продавца</option>
              {catalog.sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.city_name})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-gray-500">Город</span>
            <select
              value={cityId}
              onChange={(e) => setCityId(e.target.value)}
              className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1.5"
            >
              <option value="">Выберите город</option>
              {sellerCities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <label>
              <span className="text-gray-500">Дата</span>
              <input
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5"
              />
            </label>
            <label>
              <span className="text-gray-500">Время</span>
              <input
                type="time"
                value={invoiceTime}
                onChange={(e) => setInvoiceTime(e.target.value)}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-gray-500">Оплата</span>
            <select
              value={isDebt ? 'debt' : paymentType}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'debt') {
                  setIsDebt(true);
                  setIsPreorder(false);
                  setPaymentType('debt');
                } else {
                  setIsDebt(false);
                  setPaymentType(v as PaymentType);
                }
              }}
              className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1.5"
            >
              <option value="">Выберите оплату</option>
              {(catalog.payments || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="debt">Долг</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPreorder && !isDebt}
              disabled={isDebt}
              onChange={(e) => setIsPreorder(e.target.checked)}
            />
            Предзаказ
          </label>
          {isPreorder && !isDebt ? (
            <label className="block text-sm">
              <span className="text-gray-500">Дата выдачи</span>
              <input
                type="date"
                value={pickupDate}
                onChange={(e) => setPickupDate(e.target.value)}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5"
              />
            </label>
          ) : null}
          <ul className="space-y-2">
            {lines.map((line, idx) => (
              <li key={`${line.raw_name}-${idx}`} className="rounded-lg border border-gray-200 p-2">
                <div className="text-sm">
                  <span className="text-gray-500">{line.raw_name ? `Товар (${line.raw_name})` : 'Товар'}</span>
                  {line.product_id ? (
                    <p className="font-medium">{catalog.products.find((p) => p.id === line.product_id)?.name || line.raw_name}</p>
                  ) : null}
                  <DraftProductPicker
                    rawName={line.raw_name}
                    selectedId={line.product_id}
                    candidates={line.candidates}
                    catalog={catalog.products}
                    onPick={(p) => changeLine(idx, { product_id: p.id, raw_name: p.name, unresolved: false })}
                  />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex items-center gap-1">
                    Кол-во
                    <input
                      inputMode="decimal"
                      value={line.qty}
                      onChange={(e) => changeLine(idx, { qty: e.target.value })}
                      className="w-20 rounded border border-gray-300 px-2 py-1"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={line.is_gift}
                      onChange={(e) => changeLine(idx, { is_gift: e.target.checked })}
                    />
                    Подарок
                  </label>
                  <button type="button" className="ml-auto text-red-700" onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}>
                    Удалить
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button type="button" onClick={addLine} className="text-sm text-blue-800">
            + Добавить товар
          </button>
        </div>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-gray-500">Продавец</dt>
              <dd className="font-medium">{preview.seller_name || '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Город</dt>
              <dd className="font-medium">{preview.city_name || '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Клиент</dt>
              <dd className="font-medium">
                {[preview.customer_name || draft.resolved?.customer_name, preview.customer_phone || draft.customer_phone || draft.resolved?.customer_phone]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Оплата</dt>
              <dd className="font-medium">{preview.payment_label || '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Дата / время</dt>
              <dd className="font-medium">
                {preview.invoice_date || '—'}
                {preview.invoice_time ? ` ${preview.invoice_time}` : ''}
              </dd>
            </div>
          </dl>
          {preview.is_preorder ? (
            <p className="mt-1 text-sm">Предзаказ, выдача: {preview.pickup_date || '—'}</p>
          ) : null}
          {preview.is_debt ? <p className="mt-1 text-sm">Долг</p> : null}
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {(preview.items || []).map((item, idx) => {
              const unknown = item.unresolved === true;
              return (
                <li key={`${item.name}-${idx}`} className="flex justify-between gap-2 py-1">
                  <span>
                    {item.name}
                    {item.is_gift ? ' (подарок)' : ''} × {item.qty}
                    {item.unresolved === true ? (
                      <div className="mt-1">
                        <p className="text-xs text-red-700">Не распознан. Исходная строка: {item.name}. Выберите товар.</p>
                        <DraftProductPicker
                          rawName={item.name}
                          selectedId=""
                          candidates={item.candidates || []}
                          catalog={catalog?.products || []}
                          disabled={readOnly || busy || locked || saving}
                          onOpenOther={() => {
                            void token().then(async (access) => {
                              if (!access) return;
                              try {
                                await loadCatalog(access);
                              } catch (err) {
                                setLocalError(err instanceof Error ? err.message : 'Каталог недоступен.');
                              }
                            });
                          }}
                          onPick={(p) => void pickResolvedProduct(idx, p)}
                        />
                      </div>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-right">
                    {unknown ? 'Цена не определена' : money(item.line_sum)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-sm font-semibold">{ready ? `Итого: ${money(preview.total_sum || 0)}` : 'Итого: не рассчитано'}</p>
        </>
      )}

      {(draft.warnings || []).length > 0 ? (
        <ul className="mt-2 list-disc pl-4 text-sm text-amber-800">
          {draft.warnings.map((w) => (
            <li key={w.code + w.message}>{w.message}</li>
          ))}
        </ul>
      ) : null}
      {(draft.errors || []).length > 0 ? (
        <ul className="mt-2 list-disc pl-4 text-sm text-red-700">
          {draft.errors.map((e) => (
            <li key={e.code + e.message}>{e.message}</li>
          ))}
        </ul>
      ) : null}
      {shownSimilar.length > 0 ? (
        <div className="mt-3">
          <SimilarOrdersWarning
            matches={shownSimilar}
            role={profile?.role}
            continueBusy={busy || similarChecking}
            onContinue={() => {
              const seller = draft.resolved?.seller_id || '';
              const city = draft.resolved?.city_id || '';
              const items = (draft.resolved?.items || [])
                .filter((item) => item.product_id && Number(item.qty) > 0)
                .map((item) => ({
                  product_id: String(item.product_id),
                  qty: Number(item.qty),
                  is_gift: item.is_gift === true,
                }));
              const nextAck: SimilarAck = {
                composition: similarCompositionKey({
                  sellerId: seller,
                  cityId: city,
                  customerPhone: draft.customer_phone || null,
                  items,
                }),
                matchIds: similarMatchIds(shownSimilar),
              };
              setSimilarAck(nextAck);
              void requestConfirm(nextAck);
            }}
          />
        </div>
      ) : null}
      {!readOnly && !done && !pending && draft.status !== 'cancelled' ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            disabled={busy || blocked || editing || pending || similarChecking}
            onClick={() => void requestConfirm()}
            className="px-3 py-2 rounded-lg bg-green-600 text-white disabled:opacity-50"
          >
            Подтвердить заказ
          </button>
          {editing ? (
            <>
              <button
                type="button"
                disabled={busy || saving}
                onClick={() => void saveChanges()}
                className="px-3 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50"
              >
                Сохранить изменения
              </button>
              <button
                type="button"
                disabled={busy || saving}
                onClick={closeEditWithoutSave}
                className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-gray-900 disabled:opacity-50"
              >
                Закрыть без сохранения
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || pending}
              onClick={() => void openEdit()}
              className="px-3 py-2 rounded-lg bg-gray-200 text-gray-900 disabled:opacity-50"
            >
              Исправить
            </button>
          )}
          <button
            type="button"
            disabled={busy || pending}
            onClick={requestCancel}
            className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-gray-900 disabled:opacity-50"
          >
            Отмена
          </button>
        </div>
      ) : null}
    </div>
  );
}
