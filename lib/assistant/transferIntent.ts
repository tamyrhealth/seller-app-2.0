import { nameKey } from '@/lib/assistant/nameFold';

export type TransferParsedItem = { raw_name: string; qty: number };

export type TransferIntent = {
  fromQuery: string;
  toQuery: string;
  items: TransferParsedItem[];
  comment: string | null;
};

const LOOKUP =
  /(где|статус|прими|принять|принят|недостач|оформить недостач|спиши недостач|отмени.{0,20}(отправк|перемещ|T\s?\d)|cancel.{0,20}transfer)/i;

const VERB = /(перемест|отправ|жөнелт|жонелт|жібер|жибер|ауыстыр|\btransfer\b)/i;
const ARROW = /\s*(?:→|->|—|–|>)\s*/;
const ORDER_HINT = /(накладн|заказ|kaspi|каспи|долг|қарыз|предзаказ|подарок|сыйлық|оплач|төлен)/i;

const STOP = new Set(
  [
    'отправь',
    'отправка',
    'отправки',
    'перемести',
    'перемещение',
    'перемещения',
    'жібер',
    'жибер',
    'жөнелт',
    'жонелт',
    'ауыстыр',
    'transfer',
    'шт',
    'кг',
    'kg',
    'pcs',
    'товар',
    'товара',
    'товары',
  ].map((s) => nameKey(s))
);

export function stripCityCase(value: string): string {
  return value
    .replace(/^(из|с|от|from)\s+/i, '')
    .replace(/^(в|на|to)\s+/i, '')
    .replace(/(дан|ден|тан|тен|нан|нен)$/i, '')
    .replace(/(ға|ге|қа|ке)$/i, '')
    .replace(/[.,;:!?]+$/g, '')
    .replace(VERB, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCity(value: string): string {
  const stripped = stripCityCase(value);
  const parts = stripped.split(/\s+/).filter((p) => !STOP.has(nameKey(p)));
  return parts.join(' ').trim();
}

function parseQty(raw: string): number {
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function extractCityPair(text: string): { from: string; to: string } | null {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (!ARROW.test(line)) continue;
    const [left, right] = line.split(ARROW);
    const from = cleanCity(left || '');
    const to = cleanCity(right || '');
    if (from && to) return { from, to };
  }

  const ru = /(?:из|с)\s+([^\d\n]+?)\s+(?:в|на)\s+([^\d\n]+?)(?=\s+\d|[.,;]|$|\n)/i.exec(text);
  if (ru) {
    const from = cleanCity(ru[1]);
    const to = cleanCity(ru[2]);
    if (from && to) return { from, to };
  }

  const en = /\bfrom\s+([^\d\n]+?)\s+to\s+([^\d\n]+?)(?=\s+\d|[.,;]|$|\n)/i.exec(text);
  if (en) {
    const from = cleanCity(en[1]);
    const to = cleanCity(en[2]);
    if (from && to) return { from, to };
  }

  const kz = /([^\s,]+(?:дан|ден|тан|тен|нан|нен))\s+([^\s,]+(?:ға|ге|қа|ке))/i.exec(text);
  if (kz) {
    const from = cleanCity(kz[1]);
    const to = cleanCity(kz[2]);
    if (from && to) return { from, to };
  }

  return null;
}

function extractItems(text: string, pair: { from: string; to: string }): TransferParsedItem[] {
  const skip = new Set([nameKey(pair.from), nameKey(pair.to)]);
  const items: TransferParsedItem[] = [];
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);

  for (const line of lines) {
    if (ARROW.test(line) && !/\d/.test(line)) continue;
    if (/(?:из|с)\s+.+\s+(?:в|на)\s+/i.test(line) && !/\d/.test(line)) continue;
    const qtyFirst = /^(\d+(?:[.,]\d+)?)\s+(.+)$/.exec(line);
    const qtyLast = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:шт|кг|kg|pcs)?$/i.exec(line);
    const hit = qtyFirst || qtyLast;
    if (!hit) continue;
    const qty = parseQty(qtyFirst ? hit[1] : hit[2]);
    const raw = cleanCity(qtyFirst ? hit[2] : hit[1]);
    if (!Number.isFinite(qty) || qty <= 0 || !raw) continue;
    if (skip.has(nameKey(raw))) continue;
    items.push({ raw_name: raw, qty });
  }

  if (items.length) return items;

  const inline = text.replace(/\n/g, ' ');
  const re = /(\d+(?:[.,]\d+)?)\s+([^,;]+?)(?=(?:,|;| и | және |\s+жібер|\s+жибер|\s+отправ|\s+перемест|$))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inline))) {
    const qty = parseQty(m[1]);
    const raw = cleanCity(m[2]);
    if (!Number.isFinite(qty) || qty <= 0 || !raw) continue;
    if (skip.has(nameKey(raw))) continue;
    if (!/[а-яёәғқңөұүһіa-z]{2,}/i.test(raw)) continue;
    items.push({ raw_name: raw, qty });
  }
  return items;
}

export function parseTransferIntent(text: string): TransferIntent | null {
  const raw = text.trim();
  if (!raw || LOOKUP.test(raw)) return null;
  const pair = extractCityPair(raw);
  if (!pair) return null;
  const hasVerb = VERB.test(raw);
  const hasArrow = ARROW.test(raw);
  const items = extractItems(raw, pair);
  if (!hasVerb && !hasArrow && items.length === 0) return null;
  if (!hasVerb && !hasArrow && ORDER_HINT.test(raw)) return null;
  return {
    fromQuery: pair.from,
    toQuery: pair.to,
    items,
    comment: null,
  };
}
