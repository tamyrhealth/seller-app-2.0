import type { ParsedInvoiceItem } from '@/lib/assistant/invoiceParse';
import { detectPayment } from '@/lib/assistant/paymentParse';

const PHONE_CHUNK = /(?:\+?\d[\d\t ().-]{7,}\d)/;
const DATE_LINE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;
const TIME_LINE = /^\d{1,2}:\d{2}$/;
const QTY = '(\\d+(?:[.,]\\d+)?)';
const UNIT = '(?:шт\\.?|штук(?:а|и)?|pcs|дана(?:сы)?|кг|kg|мл|ml|г|g)?';
const QTY_TOKEN = `${QTY}\\s*${UNIT}`;
const QTY_FIRST = new RegExp(`^${QTY_TOKEN}\\s+(.+)$`, 'iu');
const QTY_LAST = new RegExp(`^(.+?)\\s+${QTY_TOKEN}$`, 'iu');

const META_NAME =
  /^(продавец|сатушы|клиент|покупатель|город|қала|оплата|төлем)$/i;

export function lineHasPhone(line: string): boolean {
  return PHONE_CHUNK.test(line);
}

export function isInvoiceMetaLine(raw: string): boolean {
  const line = String(raw || '').trim();
  if (!line) return true;
  if (DATE_LINE.test(line) || TIME_LINE.test(line)) return true;
  if (lineHasPhone(line)) return true;
  const pay = detectPayment(line);
  if (pay.payment_type || pay.is_debt || pay.paid_unspecified || pay.paid_status || pay.is_preorder) {
    const leftover = line
      .replace(/наличк[ауие]?|наличн\w*|наличные|налом|нал|қолма-?\s*қол|колма-?\s*кол|kaspi|каспи|qr|куар|карта|перевод|аударым|долг|қарыз|предзаказ|оплач\w*|төлен\w*|толен\w*|cash|card|transfer|debt/gi, '')
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .trim();
    if (!leftover) return true;
  }
  return META_NAME.test(line.replace(/[:\-–].*$/, '').trim());
}

function parseQty(raw: string): number | null {
  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 99999) return null;
  return n;
}

function cleanItemName(raw: string): string | null {
  let name = String(raw || '')
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const gift = /(подарок|сыйлық|сыйлык)/i.test(name);
  name = name
    .replace(/\b(подарок|сыйлық|сыйлык)\b/gi, ' ')
    .replace(/\b(шт\.?|штук(?:а|и)?|pcs|дана(?:сы)?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || isInvoiceMetaLine(name)) return null;
  if (lineHasPhone(name)) return null;
  if (!/[а-яёәғқңөұүһіa-z]{2,}/i.test(name)) return null;
  return name.slice(0, 80);
}

function lineGift(raw: string): boolean {
  return /(подарок|сыйлық|сыйлык)/i.test(raw);
}

export function parseInvoiceItemLine(raw: string): ParsedInvoiceItem | null {
  const line = String(raw || '').trim();
  if (!line || isInvoiceMetaLine(line) || lineHasPhone(line)) return null;
  const first = QTY_FIRST.exec(line);
  const last = QTY_LAST.exec(line);
  let qty: number | null = null;
  let nameRaw = '';
  if (first && /^\d/.test(line)) {
    qty = parseQty(first[1]);
    nameRaw = first[2];
  } else if (last) {
    qty = parseQty(last[2]);
    nameRaw = last[1];
  } else {
    return null;
  }
  const name = cleanItemName(nameRaw);
  if (!name || qty == null) return null;
  return { name, qty, is_gift: lineGift(line) };
}

function lineLooksLikeQtyItem(line: string): boolean {
  return /\d/.test(line) && /[а-яёәғқңөұүһіa-z]{2,}/i.test(line);
}

export function parseInvoiceItemLines(text: string): ParsedInvoiceItem[] {
  const items: ParsedInvoiceItem[] = [];
  for (const line of String(text || '')
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (isInvoiceMetaLine(line) || lineHasPhone(line)) continue;
    const item = parseInvoiceItemLine(line);
    if (item) {
      items.push(item);
      continue;
    }
    if (!lineLooksLikeQtyItem(line)) continue;
    const loose = /(\d+(?:[.,]\d+)?)/.exec(line);
    const qty = loose ? parseQty(loose[1]) : 1;
    const name = cleanItemName(
      line.replace(/\d+(?:[.,]\d+)?\s*(?:шт\.?|штук(?:а|и)?|pcs|дана(?:сы)?)?/iu, ' ')
    );
    if (!name || qty == null) continue;
    items.push({ name, qty, is_gift: lineGift(line) });
  }
  return items;
}

export function mergeParsedInvoiceItems(
  lineItems: ParsedInvoiceItem[],
  modelItems: ParsedInvoiceItem[]
): ParsedInvoiceItem[] {
  const out = [...lineItems];
  const seen = new Set(out.map((item) => item.name.toLowerCase().replace(/\s+/g, ' ')));
  for (const item of modelItems || []) {
    const key = String(item?.name || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function invoiceHeaderSellerName(text: string): string | null {
  const rawText = String(text || '');
  const hasItemLines = parseInvoiceItemLines(rawText).length > 0;
  const hasSellerLabel = /(?:продавец|сатушы)\s*[:\-–]/i.test(rawText);
  if (!hasItemLines && !hasSellerLabel) return null;
  let packed: string | null = null;
  for (const raw of rawText
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)) {
    if (parseInvoiceItemLine(raw)) break;
    if (isInvoiceMetaLine(raw) && !lineHasPhone(raw)) continue;
    const stripped = raw
      .replace(PHONE_CHUNK, ' ')
      .replace(/^(продавец|сатушы)\s*[:\-–]?\s*/i, '')
      .replace(/[«»"']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!stripped) continue;
    if (/\d/.test(stripped)) continue;
    if (stripped.split(' ').length > 4) continue;
    if (!/[а-яёәғқңөұүһіa-z]{2,}/i.test(stripped)) continue;
    if (lineHasPhone(raw)) {
      if (!packed) packed = stripped.slice(0, 80);
      continue;
    }
    return stripped.slice(0, 80);
  }
  return packed;
}
