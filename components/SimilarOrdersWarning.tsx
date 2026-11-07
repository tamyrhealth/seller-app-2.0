'use client';

import Link from 'next/link';
import {
  displaySimilarOrderNumber,
  similarOrderOpenHref,
  type SimilarOrderMatch,
} from '@/lib/similarOrders';

type Props = {
  matches: SimilarOrderMatch[];
  role?: string | null;
  continueBusy?: boolean;
  onContinue: () => void;
};

export default function SimilarOrdersWarning({ matches, role, continueBusy, onContinue }: Props) {
  if (!matches.length) return null;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-semibold">Похожий заказ уже есть за последние 15 минут</p>
      <p className="mt-1">
        Продавец, город и состав (товары и количества) совпадают. Это предупреждение, повторную покупку можно
        оформить явно.
      </p>
      <ul className="mt-2 space-y-1">
        {matches.map((match) => (
          <li key={match.order_id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>№ {displaySimilarOrderNumber(match)}</span>
            <Link href={similarOrderOpenHref(role, match.order_id)} className="text-blue-700 underline">
              Открыть существующий
            </Link>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={continueBusy}
        onClick={onContinue}
        className="mt-3 w-full rounded-xl bg-amber-700 px-3 py-2 font-medium text-white disabled:opacity-50 sm:w-auto"
      >
        Это другой заказ — продолжить
      </button>
    </div>
  );
}
