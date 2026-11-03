'use client';

import type { AssistantDraftRow } from '@/lib/assistant/orderDraftTypes';

function money(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

type Props = {
  draft: AssistantDraftRow;
  readOnly: boolean;
  busy: boolean;
  onConfirm: (id: string) => void;
  onFix: (id: string) => void;
  onCancel: (id: string) => void;
};

export default function AssistantOrderDraftCard({ draft, readOnly, busy, onConfirm, onFix, onCancel }: Props) {
  const preview = draft.preview || {
    seller_name: null,
    city_name: null,
    items: [],
    total_sum: 0,
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

  return (
    <div className="mt-2 rounded-xl border border-gray-300 bg-white p-3 text-gray-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Предварительный заказ</p>
      {done && draft.order_number ? (
        <p className="mt-1 text-sm font-medium text-green-800">Заказ {draft.order_number} успешно создан</p>
      ) : null}
      {pending ? <p className="mt-1 text-sm text-amber-800">Заказ обрабатывается, статус ещё не подтверждён.</p> : null}
      {draft.status === 'cancelled' ? <p className="mt-1 text-sm text-gray-600">Черновик отменён.</p> : null}
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
        {(preview.items || []).map((item, idx) => (
          <li key={`${item.name}-${idx}`} className="flex justify-between gap-2 py-1">
            <span>
              {item.name}
              {item.is_gift ? ' (подарок)' : ''} × {item.qty}
            </span>
            <span className="shrink-0">{money(item.line_sum)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm font-semibold">Сумма: {money(preview.total_sum || 0)}</p>
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
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={busy || blocked}
            onClick={() => onConfirm(draft.id)}
            className="px-3 py-2 rounded-lg bg-green-600 text-white disabled:opacity-50"
          >
            Подтвердить заказ
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onFix(draft.id)}
            className="px-3 py-2 rounded-lg bg-gray-200 text-gray-900 disabled:opacity-50"
          >
            Исправить
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancel(draft.id)}
            className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-gray-900 disabled:opacity-50"
          >
            Отмена
          </button>
        </div>
      ) : null}
    </div>
  );
}
