'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  runInventoryOperationOnce,
  transferCancelFingerprint,
  transferCreateFingerprint,
  transferReceiveFingerprint,
  transferWriteOffFingerprint,
} from '@/lib/inventoryOperation';
import {
  mapTransferRpcError,
  transferOpenLabel,
  transferRemaining,
  transferStatusLabel,
} from '@/lib/stockTransfer';
import { supabase } from '@/lib/supabaseClient';
import type { City, Product } from '@/lib/types';

type TransferItem = {
  id: string;
  product_id: string;
  qty_sent: number;
  qty_received: number | null;
  qty_lost?: number | null;
  qty_returned?: number | null;
  products?: { name?: string } | { name?: string }[] | null;
};

type TransferRow = {
  id: string;
  transfer_number: string;
  from_city_id: string;
  to_city_id: string;
  status: string;
  comment: string | null;
  created_by: string | null;
  created_at: string;
  received_by: string | null;
  received_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  stock_transfer_items?: TransferItem[];
};

type TransferEvent = {
  id: string;
  action: string;
  actor_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

function productName(item: TransferItem, products: Product[]): string {
  const p = item.products;
  const nested = Array.isArray(p) ? p[0]?.name : p?.name;
  return nested || products.find((x) => x.id === item.product_id)?.name || item.product_id.slice(0, 8);
}

function hasMoreThan3Decimals(n: number) {
  const s = String(n);
  const dot = s.indexOf('.');
  if (dot === -1) return false;
  return s.slice(dot + 1).replace(/0+$/, '').length > 3;
}

function qtyError(qty: number, unit: string | null | undefined, opts?: { allowZero?: boolean }): string | null {
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

export default function TransfersPanel({
  cities,
  products,
  selectedCity,
  onChanged,
}: {
  cities: City[];
  products: Product[];
  selectedCity: string | null;
  onChanged: () => void;
}) {
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [profilesById, setProfilesById] = useState<Map<string, string>>(new Map());
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [fromCity, setFromCity] = useState('');
  const [toCity, setToCity] = useState('');
  const [comment, setComment] = useState('');
  const [lines, setLines] = useState<Array<{ product_id: string; qty: string }>>([{ product_id: '', qty: '' }]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<TransferEvent[]>([]);
  const [recvQty, setRecvQty] = useState<Record<string, string>>({});
  const [lostQty, setLostQty] = useState<Record<string, string>>({});
  const [cancelReason, setCancelReason] = useState('');
  const [shortageReason, setShortageReason] = useState('');

  const cityName = useCallback(
    (id: string) => cities.find((c) => c.id === id)?.name || id.slice(0, 8),
    [cities]
  );

  const who = useCallback(
    (id: string | null) => (id ? profilesById.get(id) || id.slice(0, 8) : '—'),
    [profilesById]
  );

  const load = useCallback(async () => {
    const base =
      'id, transfer_number, from_city_id, to_city_id, status, comment, created_by, created_at, received_by, received_at, cancelled_by, cancelled_at, cancelled_reason';
    const itemColsLost =
      'stock_transfer_items!stock_transfer_items_transfer_id_fkey(id, product_id, qty_sent, qty_received, qty_lost, qty_returned, products!stock_transfer_items_product_id_fkey(name))';
    const itemColsLegacy =
      'stock_transfer_items!stock_transfer_items_transfer_id_fkey(id, product_id, qty_sent, qty_received, products!stock_transfer_items_product_id_fkey(name))';
    const first = await supabase
      .from('stock_transfers')
      .select(`${base}, ${itemColsLost}`)
      .order('created_at', { ascending: false })
      .limit(300);
    const result = first.error
      ? await supabase
          .from('stock_transfers')
          .select(`${base}, ${itemColsLegacy}`)
          .order('created_at', { ascending: false })
          .limit(300)
      : first;
    if (result.error) {
      setTransfers([]);
      return;
    }
    setTransfers((result.data || []) as unknown as TransferRow[]);
  }, []);

  useEffect(() => {
    load();
    supabase
      .from('profiles')
      .select('id, display_name')
      .then(({ data }) => {
        const map = new Map<string, string>();
        for (const p of data || []) map.set(p.id, p.display_name || p.id.slice(0, 8));
        setProfilesById(map);
      });
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setEvents([]);
      return;
    }
    supabase
      .from('stock_transfer_events')
      .select('id, action, actor_id, details, created_at')
      .eq('transfer_id', openId)
      .order('created_at', { ascending: true })
      .then(({ data }) => setEvents((data || []) as TransferEvent[]));
    const row = transfers.find((t) => t.id === openId);
    const nextRecv: Record<string, string> = {};
    const nextLost: Record<string, string> = {};
    for (const item of row?.stock_transfer_items || []) {
      const remain = transferRemaining(item.qty_sent, item.qty_received, item.qty_lost, item.qty_returned);
      nextRecv[item.product_id] = remain > 0 ? String(remain) : '0';
      nextLost[item.product_id] = remain > 0 ? String(remain) : '0';
    }
    setRecvQty(nextRecv);
    setLostQty(nextLost);
    setCancelReason(row?.cancelled_reason || '');
  }, [openId, transfers]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return transfers.filter((t) => {
      if (needle && !t.transfer_number.toLowerCase().includes(needle)) return false;
      const remain = (t.stock_transfer_items || []).reduce(
        (sum, item) => sum + transferRemaining(item.qty_sent, item.qty_received, item.qty_lost, item.qty_returned),
        0
      );
      if (statusFilter === 'in_transit') {
        if (t.status === 'cancelled' || remain <= 0) return false;
      } else if (statusFilter && t.status !== statusFilter) {
        return false;
      }
      if (cityFilter && t.from_city_id !== cityFilter && t.to_city_id !== cityFilter) return false;
      if (dateFrom && t.created_at.slice(0, 10) < dateFrom) return false;
      if (dateTo && t.created_at.slice(0, 10) > dateTo) return false;
      return true;
    });
  }, [transfers, q, statusFilter, cityFilter, dateFrom, dateTo]);

  const openRow = transfers.find((t) => t.id === openId) || null;
  const openRemaining = (openRow?.stock_transfer_items || []).reduce(
    (sum, item) => sum + transferRemaining(item.qty_sent, item.qty_received, item.qty_lost, item.qty_returned),
    0
  );
  const openReceived = (openRow?.stock_transfer_items || []).reduce(
    (sum, item) => sum + Number(item.qty_received || 0),
    0
  );
  const isOpen = !!openRow && openRow.status !== 'cancelled' && openRemaining > 0;

  async function handleCreate() {
    if (busy) return;
    if (!fromCity || !toCity) {
      alert('Выберите города отправления и получения');
      return;
    }
    if (fromCity === toCity) {
      alert('Город отправления и город получения не могут совпадать');
      return;
    }
    const items: Array<{ product_id: string; qty: number }> = [];
    for (const line of lines) {
      if (!line.product_id && !line.qty) continue;
      const product = products.find((p) => p.id === line.product_id);
      const qty = Number(line.qty);
      const err = qtyError(qty, product?.unit);
      if (!line.product_id || err) {
        alert(err || 'Выберите товар и количество');
        return;
      }
      const existing = items.find((i) => i.product_id === line.product_id);
      if (existing) existing.qty = Number((existing.qty + qty).toFixed(3));
      else items.push({ product_id: line.product_id, qty });
    }
    if (items.length === 0) {
      alert('Добавьте хотя бы один товар');
      return;
    }
    const fingerprint = transferCreateFingerprint(fromCity, toCity, items, comment);
    setBusy(true);
    try {
      await runInventoryOperationOnce('transfer_create', fingerprint, async (operationId) => {
        const { error } = await supabase.rpc('create_stock_transfer', {
          p_operation_id: operationId,
          p_from_city_id: fromCity,
          p_to_city_id: toCity,
          p_items: items,
          p_comment: comment.trim() || null,
        });
        if (error) throw new Error(error.message);
      });
      setShowCreate(false);
      setLines([{ product_id: '', qty: '' }]);
      setComment('');
      await load();
      onChanged();
    } catch (err) {
      alert(mapTransferRpcError(err instanceof Error ? err.message : 'Не удалось создать перемещение'));
    } finally {
      setBusy(false);
    }
  }

  async function handleReceive() {
    if (busy || !openRow || !isOpen) return;
    const items: Array<{ product_id: string; qty_received: number }> = [];
    for (const line of openRow.stock_transfer_items || []) {
      const product = products.find((p) => p.id === line.product_id);
      const qty = Number(recvQty[line.product_id] || 0);
      const remain = transferRemaining(line.qty_sent, line.qty_received, line.qty_lost, line.qty_returned);
      if (!qty) continue;
      const err = qtyError(qty, product?.unit);
      if (err) {
        alert(err);
        return;
      }
      if (qty > remain) {
        alert('Количество больше остатка в пути');
        return;
      }
      items.push({ product_id: line.product_id, qty_received: qty });
    }
    if (items.length === 0) {
      alert('Укажите количество к получению хотя бы по одному товару');
      return;
    }
    const fingerprint = transferReceiveFingerprint(openRow.id, items);
    setBusy(true);
    try {
      await runInventoryOperationOnce('transfer_receive', fingerprint, async (operationId) => {
        const { error } = await supabase.rpc('receive_stock_transfer', {
          p_operation_id: operationId,
          p_transfer_id: openRow.id,
          p_items: items,
        });
        if (error) throw new Error(error.message);
      });
      await load();
      onChanged();
    } catch (err) {
      alert(mapTransferRpcError(err instanceof Error ? err.message : 'Не удалось подтвердить получение'));
    } finally {
      setBusy(false);
    }
  }

  async function handleWriteOff() {
    if (busy || !openRow || !isOpen) return;
    if (!shortageReason.trim()) {
      alert('Укажите причину недостачи');
      return;
    }
    const items: Array<{ product_id: string; qty: number }> = [];
    for (const line of openRow.stock_transfer_items || []) {
      const product = products.find((p) => p.id === line.product_id);
      const qty = Number(lostQty[line.product_id] || 0);
      const remain = transferRemaining(line.qty_sent, line.qty_received, line.qty_lost, line.qty_returned);
      if (!qty) continue;
      const err = qtyError(qty, product?.unit);
      if (err) {
        alert(err);
        return;
      }
      if (qty > remain) {
        alert('Количество больше остатка в пути');
        return;
      }
      items.push({ product_id: line.product_id, qty });
    }
    if (items.length === 0) {
      alert('Укажите количество недостачи хотя бы по одному товару');
      return;
    }
    const fingerprint = transferWriteOffFingerprint(openRow.id, items, shortageReason);
    setBusy(true);
    try {
      await runInventoryOperationOnce('transfer_writeoff', fingerprint, async (operationId) => {
        const { error } = await supabase.rpc('write_off_stock_transfer_shortage', {
          p_operation_id: operationId,
          p_transfer_id: openRow.id,
          p_items: items,
          p_reason: shortageReason.trim(),
        });
        if (error) throw new Error(error.message);
      });
      setShortageReason('');
      await load();
      onChanged();
    } catch (err) {
      alert(mapTransferRpcError(err instanceof Error ? err.message : 'Не удалось зафиксировать недостачу'));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (busy || !openRow || !isOpen) return;
    const fingerprint = transferCancelFingerprint(openRow.id, cancelReason);
    setBusy(true);
    try {
      await runInventoryOperationOnce('transfer_cancel', fingerprint, async (operationId) => {
        const { error } = await supabase.rpc('cancel_stock_transfer', {
          p_operation_id: operationId,
          p_transfer_id: openRow.id,
          p_reason: cancelReason.trim() || null,
        });
        if (error) throw new Error(error.message);
      });
      await load();
      onChanged();
    } catch (err) {
      alert(mapTransferRpcError(err instanceof Error ? err.message : 'Не удалось отменить перемещение'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 mb-8 border-t border-gray-200 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-xl font-bold text-gray-900">Перемещения между складами</h2>
        <button
          type="button"
          onClick={() => {
            setShowCreate((v) => !v);
            const from =
              selectedCity && selectedCity !== 'ALL' ? selectedCity : '';
            setFromCity(from);
          }}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg"
        >
          Создать перемещение
        </button>
      </div>

      {showCreate && (
        <div className="bg-gray-100 rounded-lg p-4 mb-4">
          <h3 className="font-bold mb-2 text-gray-900">Новое перемещение</h3>
          <select
            value={fromCity}
            onChange={(e) => setFromCity(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
          >
            <option value="">Город отправления</option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={toCity}
            onChange={(e) => setToCity(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
          >
            <option value="">Город получения</option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {lines.map((line, idx) => (
            <div key={idx} className="flex gap-2 mb-2">
              <select
                value={line.product_id}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...next[idx], product_id: e.target.value };
                  setLines(next);
                }}
                className="flex-1 px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
              >
                <option value="">Товар</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Кол-во"
                value={line.qty}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...next[idx], qty: e.target.value };
                  setLines(next);
                }}
                className="w-28 px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLines([...lines, { product_id: '', qty: '' }])}
            className="mb-2 px-3 py-1 bg-gray-300 text-gray-900 rounded text-sm"
          >
            + Товар
          </button>
          <textarea
            placeholder="Комментарий (необязательно)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded mb-2 bg-white text-gray-900"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg disabled:opacity-50"
            >
              {busy ? 'Сохранение…' : 'Отправить'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-2 md:grid-cols-4 mb-3">
        <input
          placeholder="Поиск T000001"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
        >
          <option value="">Все статусы</option>
          <option value="in_transit">В пути</option>
          <option value="received">Получено</option>
          <option value="received_with_variance">Получено с расхождением</option>
          <option value="cancelled">Отменено</option>
        </select>
        <select
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
        >
          <option value="">Все города</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
          />
        </div>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-600">Перемещений нет</p>
        ) : (
          filtered.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setOpenId(t.id === openId ? null : t.id)}
              className="w-full text-left p-4 bg-gray-100 rounded-lg"
            >
              <div className="flex justify-between gap-2 flex-wrap">
                <span className="font-medium text-gray-900">{t.transfer_number}</span>
                <span className="text-sm text-gray-700">
                  {transferOpenLabel(
                    t.status,
                    (t.stock_transfer_items || []).reduce(
                      (sum, item) =>
                        sum + transferRemaining(item.qty_sent, item.qty_received, item.qty_lost, item.qty_returned),
                      0
                    ),
                    (t.stock_transfer_items || []).reduce((sum, item) => sum + Number(item.qty_received || 0), 0)
                  )}
                </span>
              </div>
              <p className="text-sm text-gray-600">
                {cityName(t.from_city_id)} → {cityName(t.to_city_id)} ·{' '}
                {new Date(t.created_at).toLocaleString('ru-KZ')}
              </p>
            </button>
          ))
        )}
      </div>

      {openRow && (
        <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-white">
          <h3 className="font-bold text-gray-900 mb-2">Карточка {openRow.transfer_number}</h3>
          <p className="text-sm text-gray-700 mb-1">
            {cityName(openRow.from_city_id)} → {cityName(openRow.to_city_id)}
          </p>
          <p className="text-sm text-gray-700 mb-1">
            Статус: {transferOpenLabel(openRow.status, openRemaining, openReceived)}
          </p>
          <p className="text-sm text-gray-700 mb-1">
            Отправка: {new Date(openRow.created_at).toLocaleString('ru-KZ')} · {who(openRow.created_by)}
          </p>
          {openRow.comment && <p className="text-sm text-gray-700 mb-1">Комментарий: {openRow.comment}</p>}
          {openRow.received_at && (
            <p className="text-sm text-gray-700 mb-1">
              Получение: {new Date(openRow.received_at).toLocaleString('ru-KZ')} · {who(openRow.received_by)}
            </p>
          )}
          {openRow.cancelled_at && (
            <p className="text-sm text-gray-700 mb-2">
              Отмена: {new Date(openRow.cancelled_at).toLocaleString('ru-KZ')} · {who(openRow.cancelled_by)}
              {openRow.cancelled_reason ? ` · ${openRow.cancelled_reason}` : ''}
            </p>
          )}
          <ul className="mb-3 space-y-2">
            {(openRow.stock_transfer_items || []).map((item) => {
              const remain = transferRemaining(
                item.qty_sent,
                item.qty_received,
                item.qty_lost,
                item.qty_returned
              );
              return (
                <li key={item.id} className="text-sm text-gray-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex-1">{productName(item, products)}</span>
                    <span>отправлено {item.qty_sent}</span>
                    <span>получено {item.qty_received ?? 0}</span>
                    <span>в пути {remain}</span>
                    {Number(item.qty_lost || 0) > 0 && (
                      <span className="text-amber-800">недостача {item.qty_lost}</span>
                    )}
                    {Number(item.qty_returned || 0) > 0 && <span>возвращено {item.qty_returned}</span>}
                  </div>
                  {isOpen && remain > 0 && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      <label className="flex items-center gap-1">
                        Получить сейчас
                        <input
                          type="number"
                          className="w-24 px-2 py-1 border border-gray-300 rounded bg-white"
                          value={recvQty[item.product_id] ?? ''}
                          onChange={(e) => setRecvQty({ ...recvQty, [item.product_id]: e.target.value })}
                        />
                      </label>
                      <label className="flex items-center gap-1">
                        Недостача
                        <input
                          type="number"
                          className="w-24 px-2 py-1 border border-gray-300 rounded bg-white"
                          value={lostQty[item.product_id] ?? ''}
                          onChange={(e) => setLostQty({ ...lostQty, [item.product_id]: e.target.value })}
                        />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {isOpen && (
            <div className="flex flex-col gap-2 mb-3">
              <button
                type="button"
                onClick={handleReceive}
                disabled={busy}
                className="px-4 py-2 bg-green-600 text-white rounded-lg disabled:opacity-50"
              >
                {busy ? 'Сохранение…' : 'Подтвердить получение'}
              </button>
              <input
                placeholder="Причина недостачи"
                value={shortageReason}
                onChange={(e) => setShortageReason(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
              />
              <button
                type="button"
                onClick={handleWriteOff}
                disabled={busy}
                className="px-4 py-2 bg-amber-700 text-white rounded-lg disabled:opacity-50"
              >
                Подтвердить недостачу
              </button>
              <input
                placeholder="Причина отмены остатка в пути (необязательно)"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded bg-white text-gray-900"
              />
              <button
                type="button"
                onClick={handleCancel}
                disabled={busy}
                className="px-4 py-2 bg-red-600 text-white rounded-lg disabled:opacity-50"
              >
                Вернуть остаток отправителю
              </button>
            </div>
          )}
          <h4 className="font-semibold text-gray-900 mb-1">История</h4>
          {events.length === 0 ? (
            <p className="text-sm text-gray-600">Событий нет</p>
          ) : (
            <ul className="text-sm text-gray-800 space-y-1">
              {events.map((e) => (
                <li key={e.id}>
                  {new Date(e.created_at).toLocaleString('ru-KZ')} · {transferStatusLabel(e.action)} ·{' '}
                  {who(e.actor_id)}
                  {e.action === 'cancelled' && e.details && typeof e.details.reason === 'string' && e.details.reason
                    ? ` · ${e.details.reason}`
                    : ''}
                  {e.action === 'shortage' && e.details && typeof e.details.reason === 'string'
                    ? ` · ${e.details.reason}`
                    : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
