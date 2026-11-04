'use client';

import { useMemo, useState } from 'react';
import type { DraftCandidate } from '@/lib/assistant/orderDraftTypes';
import { filterCatalogProducts } from '@/lib/assistant/productAliases';

function money(n: number) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);
}

export type PickerProduct = { id: string; name: string; unit: string | null; price_retail?: number | null };

type Props = {
  rawName: string;
  selectedId: string;
  candidates: DraftCandidate[];
  catalog: PickerProduct[];
  disabled?: boolean;
  onPick: (product: { id: string; name: string; price: number }) => void;
  onOpenOther?: () => void;
};

export default function DraftProductPicker({ rawName, selectedId, candidates, catalog, disabled, onPick, onOpenOther }: Props) {
  const [otherOpen, setOtherOpen] = useState(false);
  const [q, setQ] = useState('');
  const shown = candidates.slice(0, 5);
  const hits = useMemo(() => {
    const catalogAs = catalog.map((p) => ({
      id: p.id,
      name: p.name,
      unit: p.unit,
      price_retail: p.price_retail ?? null,
    }));
    return filterCatalogProducts(q, catalogAs, 8);
  }, [catalog, q]);

  function pick(id: string, name: string, price: number) {
    onPick({ id, name, price });
    setOtherOpen(false);
    setQ('');
  }

  return (
    <div className="space-y-1">
      {rawName ? <p className="text-xs text-gray-500">Запрос: {rawName}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {shown.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            onClick={() => pick(c.id, c.name, Number(c.price || 0))}
            className={`rounded-lg border px-2 py-1 text-left text-sm ${
              selectedId === c.id ? 'border-green-600 bg-green-50' : 'border-gray-300 bg-white'
            } disabled:opacity-50`}
          >
            <span className="block font-medium">{c.name}</span>
            <span className="block text-xs text-gray-600">{money(Number(c.price || 0))} ₸</span>
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setOtherOpen((v) => !v);
            onOpenOther?.();
          }}
          className="rounded-lg border border-dashed border-gray-400 px-2 py-1 text-sm text-gray-800 disabled:opacity-50"
        >
          Другой товар
        </button>
      </div>
      {otherOpen ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по активному каталогу"
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            autoFocus
          />
          {q.trim() ? (
            hits.length ? (
              <ul className="mt-1 max-h-40 overflow-auto">
                {hits.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-1 py-1 text-left text-sm hover:bg-white"
                      onClick={() => pick(p.id, p.name, Number(p.price_retail || 0))}
                    >
                      <span>{p.name}</span>
                      <span className="text-xs text-gray-600">{money(Number(p.price_retail || 0))} ₸</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-gray-600">Нет активных товаров по запросу.</p>
            )
          ) : (
            <p className="mt-1 text-xs text-gray-600">Начните вводить название. Полный каталог не показываем.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
