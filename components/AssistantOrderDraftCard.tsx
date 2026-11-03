'use client';

import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { AssistantDraftRow, DraftCandidate, DraftItemResolved } from '@/lib/assistant/orderDraftTypes';
import type { PaymentType } from '@/lib/types';

function money(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

type CatalogSeller = { id: string; name: string; city_id: string; city_name: string };
type CatalogProduct = { id: string; name: string; unit: string | null };
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
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
  onUpdated: () => Promise<void> | void;
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

export default function AssistantOrderDraftCard({ draft, readOnly, busy, onConfirm, onCancel, onUpdated }: Props) {
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

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');
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

  const selectedSeller = catalog?.sellers.find((s) => s.id === sellerId) || null;
  const sellerCities = useMemo(() => {
    if (!catalog) return [];
    if (!selectedSeller) return catalog.cities;
    return catalog.cities.filter((c) => c.id === selectedSeller.city_id);
  }, [catalog, selectedSeller]);

  async function token() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  }

  async function openEdit() {
    if (readOnly || busy || locked) return;
    setLocalError('');
    const access = await token();
    if (!access) {
      setLocalError('Сессия истекла. Войдите снова.');
      return;
    }
    const res = await fetch('/api/assistant/orders/catalog', {
      headers: { Authorization: `Bearer ${access}` },
    });
    const payload = (await res.json().catch(() => ({}))) as Catalog & { ok?: boolean; message?: string };
    if (!res.ok || payload.ok === false) {
      setLocalError(payload.message || 'Не удалось загрузить справочники.');
      return;
    }
    setCatalog({
      sellers: payload.sellers || [],
      products: payload.products || [],
      cities: payload.cities || [],
      payments: payload.payments || [],
    });
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
      const access = await token();
      if (!access) {
        setLocalError('Сессия истекла. Войдите снова.');
        return;
      }
      const items = lines
        .filter((line) => line.product_id)
        .map((line) => ({
          product_id: line.product_id,
          qty: Number(line.qty.replace(',', '.')),
          is_gift: line.is_gift,
          raw_name: line.raw_name,
        }));
      const body: SaveBody = {
        seller_id: sellerId,
        city_id: cityId,
        payment_type: isDebt ? 'debt' : paymentType || null,
        is_debt: isDebt,
        is_preorder: isPreorder && !isDebt,
        invoice_date: invoiceDate || null,
        invoice_time: invoiceTime || null,
        pickup_date: isPreorder ? pickupDate || null : null,
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
        return;
      }
      setEditing(false);
      await onUpdated();
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
      {done && draft.order_number ? (
        <p className="mt-1 text-sm font-medium text-green-800">Заказ {draft.order_number} успешно создан</p>
      ) : null}
      {pending ? <p className="mt-1 text-sm text-amber-800">Заказ обрабатывается, статус ещё не подтверждён.</p> : null}
      {draft.status === 'cancelled' ? <p className="mt-1 text-sm text-gray-600">Черновик отменён.</p> : null}
      {localError ? <p className="mt-1 text-sm text-red-700">{localError}</p> : null}

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
                <label className="block text-sm">
                  <span className="text-gray-500">{line.raw_name ? `Товар (${line.raw_name})` : 'Товар'}</span>
                  <select
                    value={line.product_id}
                    onChange={(e) => {
                      const product = catalog.products.find((p) => p.id === e.target.value);
                      changeLine(idx, { product_id: e.target.value, raw_name: product?.name || line.raw_name, unresolved: !e.target.value });
                    }}
                    className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1.5"
                  >
                    <option value="">Выберите товар</option>
                    {(line.candidates.length ? line.candidates : []).map((c) => (
                      <option key={`c-${c.id}`} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    {catalog.products
                      .filter((p) => !line.candidates.some((c) => c.id === p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
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
                    {item.candidates?.length ? (
                      <span className="block text-xs text-amber-800">Варианты: {item.candidates.map((c) => c.name).join(', ')}</span>
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
      {!readOnly && !done && draft.status !== 'cancelled' ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            disabled={busy || blocked || editing || pending}
            onClick={() => onConfirm(draft.id)}
            className="px-3 py-2 rounded-lg bg-green-600 text-white disabled:opacity-50"
          >
            Подтвердить заказ
          </button>
          {editing ? (
            <button
              type="button"
              disabled={busy || saving}
              onClick={() => void saveChanges()}
              className="px-3 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50"
            >
              Сохранить изменения
            </button>
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
