import { draftChoiceHints } from '@/lib/assistant/invoiceResolve';
import type { ResolveResult } from '@/lib/assistant/orderDraftTypes';

export function remarksPhrase(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n100 >= 11 && n100 <= 14) return `${n} замечаний`;
  if (n10 === 1) return `${n} замечание`;
  if (n10 >= 2 && n10 <= 4) return `${n} замечания`;
  return `${n} замечаний`;
}

export function buildDraftChatMessage(result: ResolveResult): string {
  const n = result.errors.length;
  if (n === 0) {
    return 'Накладная распознана. Проверьте карточку заказа.';
  }
  const hints = draftChoiceHints(result.errors);
  const extra = hints.length ? ` ${hints.join('. ')}.` : '';
  return `Накладная распознана. Найдены ${remarksPhrase(n)}. Исправьте их в карточке заказа.${extra}`;
}
