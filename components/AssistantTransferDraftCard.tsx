'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import DraftProductPicker from '@/components/DraftProductPicker';
import type { AssistantTransferDraftRow, TransferCityCandidate } from '@/lib/assistant/transferTypes';

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

function cityChoices(raw: unknown, catalog: CatalogCity[] = []): TransferCityCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (typeof row === 'string') {
        const name = row.trim();
        const hit = catalog.find((c) => c.name === name);
        return name ? { id: hit?.id || '', name } : null;
      }
      if (row && typeof row === 'object' && 'id' in row && 'name' in row) {
        const id = String((row as TransferCityCandidate).id || '');
        const name = String((row as TransferCityCandidate).name || '');
        const hit = id ? null : catalog.find((c) => c.name === name);
        return name ? { id: id || hit?.id || '', name } : null;
      }
      return null;
    })
    .filter((row): row is TransferCityCandidate => Boolean(row?.name));
}

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
  const sourceReady = Boolean(draft.resolved?.from_city_id);
  const visibleErrors = (draft.errors || []).filter((err) => {
    if (!sourceReady && err.code === 'insufficient_stock') return false;
    return true;
  });
  const fromChoices = cityChoices(
    draft.resolved?.from_city_candidates || draft.preview?.from_city_candidates,
    catalog?.cities || []
  );
  const toChoices = cityChoices(
    draft.resolved?.to_city_candidates || draft.preview?.to_city_candidates,
    catalog?.cities || []
  );
  const needFromPick = editable && !draft.resolved?.from_city_id && fromChoices.length > 1;
  const needToPick = editable && !draft.resolved?.to_city_id && toChoices.length > 1;
  const needProductPick =
    editable &&
    !editing &&
    Boolean(draft.resolved?.from_city_id) &&
    Boolean(draft.resolved?.to_city_id) &&
    (draft.resolved?.items || []).some((item) => !item.product_id && (item.candidates || []).length > 1);
  const showConfirm =
    !editing &&
    !sent &&
    !cancelled &&
    !needFromPick &&
    !needToPick &&
    !needProductPick &&
    (confirming || (editable && draft.can_confirm));
  const showEditCancel = editable && !editing;
  const showButtons = showConfirm || showEditCancel;

  useEffect(() => {
    if (!editable || catalog || (!needFromPick && !needToPick && !needProductPick && fromChoices.length + toChoices.length === 0)) return;
    if (fromChoices.some((c) => !c.id) || toChoices.some((c) => !c.id) || needFromPick || needToPick || needProductPick) {
      void loadCatalog().catch((err) => {
        setLocalError(err instanceof Error ? err.message : 'Каталог недоступен.');
      });
    }
    // loadCatalog is stable enough for this card lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, catalog, needFromPick, needToPick, needProductPick]);

  async function saveWarehousePick(nextFrom: string, nextTo: string) {
    if (!nextFrom || !nextTo) return;
    const mapped = seedLines(draft)
      .map((line) => ({
        product_id: line.product_id,
        qty: Number(String(line.qty).replace(',', '.')),
        raw_name: line.raw_name,
      }))
      .filter((line) => Number.isFinite(line.qty) && line.qty > 0 && (line.product_id || line.raw_name));
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
          from_city_id: nextFrom,
          to_city_id: nextTo,
          items: mapped,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || payload.ok === false) throw new Error(payload.message || 'Не удалось сохранить склад.');
      await onUpdated();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Не удалось сохранить склад.');
    } finally {
      setSaving(false);
    }
  }

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
      {!editing && (needFromPick || needToPick) ? (
        <div className="mt-2 space-y-2 text-sm">
          {needFromPick ? (
            <label className="block">
              <span className="block text-gray-600 mb-1">Выберите отправителя</span>
              <select
                value=""
                disabled={saving || busy}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  const toId = draft.resolved?.to_city_id || toCityId || '';
                  if (!toId) {
                    setFromCityId(id);
                    setLocalError('Выберите также конечный склад.');
                    return;
                  }
                  void saveWarehousePick(id, toId);
                }}
                className="w-full rounded border border-gray-300 px-2 py-1 bg-white"
              >
                <option value="">Выберите исходный склад</option>
                {fromChoices.filter((c) => c.id).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {needToPick ? (
            <label className="block">
              <span className="block text-gray-600 mb-1">Выберите получателя</span>
              <select
                value=""
                disabled={saving || busy}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  const fromId = draft.resolved?.from_city_id || fromCityId || '';
                  if (!fromId) {
                    setToCityId(id);
                    setLocalError('Выберите также исходный склад.');
                    return;
                  }
                  void saveWarehousePick(fromId, id);
                }}
                className="w-full rounded border border-gray-300 px-2 py-1 bg-white"
              >
                <option value="">Выберите конечный склад</option>
                {toChoices.filter((c) => c.id).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {!editing ? (
        <ul className="mt-2 space-y-1 text-sm">
          {(draft.resolved?.items?.length ? draft.resolved.items : items).map((item, idx) => {
            const resolvedItem = draft.resolved?.items?.[idx];
            const candidates = resolvedItem?.candidates || ('candidates' in item ? item.candidates : []) || [];
            const showPick = needProductPick && !resolvedItem?.product_id && candidates.length > 1;
            const name = 'product_name' in item && item.product_name ? item.product_name : 'name' in item ? item.name : resolvedItem?.raw_name;
            const qty = item.qty;
            const unit = 'unit' in item ? item.unit : null;
            const stock = 'stock' in item ? item.stock : null;
            const unresolved = 'unresolved' in item ? item.unresolved : !resolvedItem?.product_id;
            return (
              <li key={`${name}-${idx}`}>
                {name}: {qty}
                {unit ? ` ${unit}` : ''}
                {!sent && sourceReady && item.stock != null ? ` · остаток ${item.stock}` : ''}
                {unresolved ? ' · не распознан' : ''}
                {showPick ? (
                  <div className="mt-1">
                    <DraftProductPicker
                      rawName={resolvedItem?.raw_name || String(name || '')}
                      selectedId=""
                      candidates={candidates.map((c) => ({ id: c.id, name: c.name, price: 0 }))}
                      catalog={catalog?.products || []}
                      disabled={saving || busy}
                      onPick={(p) => {
                        const current = seedLines(draft).map((line, lineIdx) =>
                          lineIdx === idx ? { ...line, product_id: p.id, raw_name: p.name } : line
                        );
                        const fromId = draft.resolved?.from_city_id || fromCityId;
                        const toId = draft.resolved?.to_city_id || toCityId;
                        if (!fromId || !toId) return;
                        void (async () => {
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
                                from_city_id: fromId,
                                to_city_id: toId,
                                items: current.map((line) => ({
                                  product_id: line.product_id,
                                  qty: Number(String(line.qty).replace(',', '.')),
                                  raw_name: line.raw_name,
                                })),
                              }),
                            });
                            const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
                            if (!res.ok || payload.ok === false) throw new Error(payload.message || 'Не удалось сохранить товар.');
                            await onUpdated();
                          } catch (err) {
                            setLocalError(err instanceof Error ? err.message : 'Не удалось сохранить товар.');
                          } finally {
                            setSaving(false);
                          }
                        })();
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
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
                candidates={(draft.resolved?.items?.[idx]?.candidates || []).map((c) => ({
                  id: c.id,
                  name: c.name,
                  price: 0,
                }))}
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
      {visibleErrors.length > 0 && !sent ? (
        <ul className="mt-2 space-y-1 text-sm text-red-700">
          {visibleErrors.map((err) => (
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
