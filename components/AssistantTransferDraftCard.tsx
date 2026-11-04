'use client';

import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import DraftProductPicker from '@/components/DraftProductPicker';
import type { AssistantTransferDraftRow } from '@/lib/assistant/transferTypes';

type CatalogProduct = { id: string; name: string; unit: string | null };
type CatalogCity = { id: string; name: string };

type Catalog = {
  cities: CatalogCity[];
  products: CatalogProduct[];
};

type EditLine = {
  product_id: string;
  qty: string;
  raw_name: string;
};

type Props = {
  draft: AssistantTransferDraftRow;
  readOnly: boolean;
  busy: boolean;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
  onUpdated: () => Promise<void> | void;
};

function seedLines(draft: AssistantTransferDraftRow): EditLine[] {
  const items = draft.resolved?.items?.length ? draft.resolved.items : [];
  if (items.length) {
    return items.map((item) => ({
      product_id: item.product_id || '',
      qty: String(item.qty || ''),
      raw_name: item.raw_name || item.product_name || '',
    }));
  }
  return (draft.preview?.items || []).map((item) => ({
    product_id: '',
    qty: String(item.qty || ''),
    raw_name: item.name || '',
  }));
}

export default function AssistantTransferDraftCard({
  draft,
  readOnly,
  busy,
  onConfirm,
  onCancel,
  onUpdated,
}: Props) {
  const sent = draft.status === 'confirmed' || Boolean(draft.transfer_id);
  const cancelled = draft.status === 'cancelled';
  const confirming = draft.status === 'confirming' && !sent;
  const editable = !readOnly && !sent && !cancelled && (draft.status === 'preview' || draft.status === 'blocked');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fromCityId, setFromCityId] = useState(draft.resolved?.from_city_id || '');
  const [toCityId, setToCityId] = useState(draft.resolved?.to_city_id || '');
  const [lines, setLines] = useState<EditLine[]>(() => seedLines(draft));

  const showConfirm = !editing && !sent && !cancelled && (confirming || (editable && draft.can_confirm));
  const showEditCancel = editable && !editing;
  const showButtons = showConfirm || showEditCancel;

  async function loadCatalog() {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error('Сессия истекла.');
    const res = await fetch('/api/assistant/orders/catalog', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = (await res.json().catch(() => ({}))) as Catalog & { ok?: boolean; message?: string };
    if (!res.ok || payload.ok === false) throw new Error(payload.message || 'Каталог недоступен.');
    setCatalog({ cities: payload.cities || [], products: payload.products || [] });
  }

  async function startEdit() {
    setLocalError('');
    try {
      if (!catalog) await loadCatalog();
      setFromCityId(draft.resolved?.from_city_id || '');
      setToCityId(draft.resolved?.to_city_id || '');
      setLines(seedLines(draft));
      setEditing(true);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Каталог недоступен.');
    }
  }

  async function saveEdit() {
    setSaving(true);
    setLocalError('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Сессия истекла.');
      const res = await fetch('/api/assistant/transfers/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          draftId: draft.id,
          from_city_id: fromCityId,
          to_city_id: toCityId,
          items: lines.map((line) => ({
            product_id: line.product_id,
            qty: Number(String(line.qty).replace(',', '.')),
            raw_name: line.raw_name,
          })),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || payload.ok === false) throw new Error(payload.message || 'Не удалось сохранить.');
      setEditing(false);
      await onUpdated();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Не удалось сохранить.');
    } finally {
      setSaving(false);
    }
  }

  const items = useMemo(() => draft.preview?.items || [], [draft.preview]);

  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3 text-gray-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Межскладская отправка</p>
      {sent ? (
        <p className="mt-1 text-sm font-medium text-green-800">
          Отправлено {draft.transfer_number || ''}
        </p>
      ) : cancelled ? (
        <p className="mt-1 text-sm text-gray-600">Черновик отменён</p>
      ) : null}
      <p className="mt-2 text-sm">
        <span className="font-medium">{draft.preview?.from_city_name || '—'}</span>
        {' → '}
        <span className="font-medium">{draft.preview?.to_city_name || '—'}</span>
      </p>
      {!editing ? (
        <ul className="mt-2 space-y-1 text-sm">
          {items.map((item, idx) => (
            <li key={`${item.name}-${idx}`}>
              {item.name}: {item.qty}
              {item.unit ? ` ${item.unit}` : ''}
              {item.stock == null ? '' : ` · остаток ${item.stock}`}
              {item.unresolved ? ' · не распознан' : ''}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 space-y-2">
          <select
            value={fromCityId}
            onChange={(e) => setFromCityId(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 bg-white"
          >
            <option value="">Исходный склад</option>
            {(catalog?.cities || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={toCityId}
            onChange={(e) => setToCityId(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 bg-white"
          >
            <option value="">Конечный склад</option>
            {(catalog?.cities || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {lines.map((line, idx) => (
            <div key={idx} className="space-y-1">
              <DraftProductPicker
                rawName={line.raw_name}
                selectedId={line.product_id}
                candidates={[]}
                catalog={catalog?.products || []}
                onPick={(p) => {
                  const next = [...lines];
                  next[idx] = { ...next[idx], product_id: p.id, raw_name: p.name };
                  setLines(next);
                }}
              />
              <input
                value={line.qty}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...next[idx], qty: e.target.value };
                  setLines(next);
                }}
                className="w-24 rounded border border-gray-300 px-2 py-1"
              />
            </div>
          ))}
        </div>
      )}
      {(draft.errors || []).length > 0 && !sent ? (
        <ul className="mt-2 space-y-1 text-sm text-red-700">
          {draft.errors.map((err) => (
            <li key={`${err.code}-${err.message}`}>{err.message}</li>
          ))}
        </ul>
      ) : null}
      {localError ? <p className="mt-2 text-sm text-red-700">{localError}</p> : null}
      {showButtons ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {showConfirm ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(draft.id)}
              className="px-3 py-1.5 rounded bg-green-600 text-white disabled:opacity-50"
            >
              {confirming ? 'Повторить подтверждение' : 'Подтвердить отправку'}
            </button>
          ) : null}
          {showEditCancel ? (
            <>
              <button
                type="button"
                disabled={busy || saving}
                onClick={() => void startEdit()}
                className="px-3 py-1.5 rounded bg-gray-200 text-gray-900 disabled:opacity-50"
              >
                Исправить
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onCancel(draft.id)}
                className="px-3 py-1.5 rounded bg-white border border-gray-300 text-gray-900 disabled:opacity-50"
              >
                Отменить черновик
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveEdit()}
            className="px-3 py-1.5 rounded bg-blue-600 text-white disabled:opacity-50"
          >
            Сохранить
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => setEditing(false)}
            className="px-3 py-1.5 rounded bg-gray-200"
          >
            Назад
          </button>
        </div>
      ) : null}
    </div>
  );
}
