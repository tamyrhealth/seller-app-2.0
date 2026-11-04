'use client';

import type { CancelPreview } from '@/lib/assistant/cancelTypes';

function money(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

function statusLabel(status: string) {
  const s = status.toLowerCase();
  if (s === 'canceled' || s === 'cancelled') return 'Отменён';
  if (s === 'confirmed') return 'Подтверждён';
  return status || '—';
}

type Props = {
  preview: CancelPreview;
  state?: string;
  readOnly: boolean;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

export default function AssistantCancelCard({ preview, state, readOnly, busy, onConfirm, onDismiss }: Props) {
  const locked = state === 'confirmed' || state === 'dismissed' || readOnly;
  const canAct = preview.can_cancel && !locked && state !== 'blocked';

  return (
    <div className="mt-2 rounded-xl border border-amber-300 bg-white p-3 text-gray-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Отмена заказа</p>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-gray-500">Номер</dt>
          <dd className="font-medium">{preview.order_number}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Статус</dt>
          <dd className="font-medium">{statusLabel(preview.status)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Продавец</dt>
          <dd className="font-medium">{preview.seller_name || '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Город</dt>
          <dd className="font-medium">{preview.city_name || '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Дата</dt>
          <dd className="font-medium">{preview.created_at ? new Date(preview.created_at).toLocaleString('ru-KZ') : '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Оплата</dt>
          <dd className="font-medium">{preview.payment_label}</dd>
        </div>
      </dl>
      {preview.is_preorder ? <p className="mt-1 text-sm">Предзаказ</p> : null}
      {preview.is_debt ? <p className="mt-1 text-sm">Долг</p> : null}
      <ul className="mt-2 divide-y divide-gray-100 text-sm">
        {(preview.items || []).map((item, idx) => (
          <li key={`${item.name}-${idx}`} className="flex justify-between py-1">
            <span>
              {item.name}
              {item.is_gift ? ' (подарок)' : ''} × {item.qty}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm font-semibold">Итого: {money(preview.total_sum || 0)}</p>
      <p className="mt-1 text-sm text-amber-900">{preview.stock_note}</p>
      {(preview.errors || []).map((e) => (
        <p key={e.code} className="mt-1 text-sm text-red-700">
          {e.message}
        </p>
      ))}
      {state === 'confirmed' ? <p className="mt-1 text-sm text-green-800">Отмена подтверждена.</p> : null}
      {state === 'dismissed' ? <p className="mt-1 text-sm text-gray-600">Заказ оставлен без изменений.</p> : null}
      {!readOnly && canAct ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="px-3 py-2 rounded-lg bg-red-600 text-white disabled:opacity-50"
          >
            Подтвердить отмену
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-gray-900 disabled:opacity-50"
          >
            Оставить заказ
          </button>
        </div>
      ) : null}
    </div>
  );
}
