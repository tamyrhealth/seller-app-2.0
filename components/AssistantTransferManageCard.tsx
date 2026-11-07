'use client';

import type { TransferManagePreview } from '@/lib/assistant/transferManageTypes';
import { transferStatusLabel } from '@/lib/stockTransfer';

type Props = {
  preview: TransferManagePreview;
  state?: string;
  readOnly: boolean;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

export default function AssistantTransferManageCard({
  preview,
  state,
  readOnly,
  busy,
  onConfirm,
  onDismiss,
}: Props) {
  const locked = state === 'confirmed' || state === 'dismissed' || readOnly;
  const canAct = preview.can_confirm && !locked && state !== 'blocked';
  const confirmLabel =
    preview.kind === 'receive'
      ? 'Подтвердить приёмку'
      : preview.kind === 'return_remainder'
        ? 'Вернуть остаток отправителю'
        : preview.kind === 'shortage'
          ? 'Подтвердить недостачу'
          : '';

  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3 text-gray-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {preview.kind === 'list' ? 'Перемещения' : 'Перемещение'}
      </p>
      {preview.kind === 'list' ? (
        <ul className="mt-2 space-y-1 text-sm">
          {preview.list.length === 0 ? (
            <li>{preview.empty_list_message || 'Ничего не найдено.'}</li>
          ) : null}
          {preview.list.map((row) => (
            <li key={row.transfer_number}>
              {row.transfer_number}: {row.from_city_name} → {row.to_city_name} · {row.status} · в пути {row.remaining}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className="mt-2 text-sm font-medium">
            {preview.transfer_number} · {preview.from_city_name || '—'} → {preview.to_city_name || '—'}
          </p>
          <p className="text-sm text-gray-700">
            Статус:{' '}
            {state === 'confirmed' ? preview.status || 'Операция выполнена' : preview.status || '—'} · в пути{' '}
            {preview.remaining}
          </p>
          {preview.created_by_name ? (
            <p className="text-sm text-gray-700">Отправил: {preview.created_by_name}</p>
          ) : null}
          <ul className="mt-2 space-y-1 text-sm">
            {preview.items.map((item) => (
              <li key={item.product_id}>
                {item.name}: отправлено {item.qty_sent}, принято {item.qty_received}, возвращено {item.qty_returned},
                списано {item.qty_lost}, в пути {item.remaining}
                {canAct && item.action_qty > 0 ? ` · сейчас ${item.action_qty}` : ''}
              </li>
            ))}
          </ul>
          {preview.reason ? <p className="mt-1 text-sm">Причина: {preview.reason}</p> : null}
          {preview.events.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-gray-800">
              {preview.events.map((ev, idx) => (
                <li key={`${ev.created_at}-${idx}`}>
                  {new Date(ev.created_at).toLocaleString('ru-KZ')} · {transferStatusLabel(ev.action)} ·{' '}
                  {ev.actor_name || ev.actor_id?.slice(0, 8) || '—'}
                  {ev.reason ? ` · ${ev.reason}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {(preview.errors || []).map((err) => (
        <p key={`${err.code}-${err.message}`} className="mt-1 text-sm text-red-700">
          {err.message}
        </p>
      ))}
      {state === 'confirmed' ? <p className="mt-1 text-sm text-green-800">Операция записана в историю перемещения.</p> : null}
      {state === 'dismissed' ? <p className="mt-1 text-sm text-gray-600">Операция отклонена, склад не изменён.</p> : null}
      {!readOnly && canAct ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="px-3 py-2 rounded-lg bg-green-600 text-white disabled:opacity-50"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-gray-900 disabled:opacity-50"
          >
            Отменить действие
          </button>
        </div>
      ) : null}
    </div>
  );
}
