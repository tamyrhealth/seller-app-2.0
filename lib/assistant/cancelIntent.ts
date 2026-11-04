import { parseOrderNumberQuery } from '@/lib/orderNumber';

export type CancelIntent = {
  wantsCancel: boolean;
  orderQuery: string | null;
  canonicalNumber: string | null;
};

const CANCEL_VERB =
  /(отмен\w*|отмена|болдырма|жою|cancel)/i;
const NEGATIVE = /(не|емес)\s+(отмен|болдырма|жою|cancel)/i;
const ORDER_WORD = /(заказ|тапсырыс|order)/i;

export function parseCancelIntent(text: string): CancelIntent | null {
  const raw = text.trim();
  if (!raw || NEGATIVE.test(raw)) return null;
  if (!CANCEL_VERB.test(raw)) return null;
  const numbered = raw.match(/n\s*\d+/i);
  const digitsAfter = raw.match(/(?:заказ|тапсырыс|order)\s*n?\s*(\d{1,8})/i);
  const bareDigits = raw.match(/\b(\d{1,8})\b/);
  const query = numbered?.[0] || digitsAfter?.[1] || (ORDER_WORD.test(raw) ? bareDigits?.[1] || null : null);
  const canonicalNumber = query ? parseOrderNumberQuery(query) : null;
  return { wantsCancel: true, orderQuery: query, canonicalNumber };
}
