import { normalizeCustomerPhone } from '../customerPhone';
import { nameKey } from './nameFold';

const PHONE_CHUNK = /(?:\+?\d[\d\t ().-]{7,}\d)/g;
const PAYMENT_OR_META =
  /^(нал|налом|наличк|наличн|kaspi|каспи|qr|куар|карта|картой|перевод|аударым|долг|қарыз|предзаказ|оплач|төлен|толен|cash|card|transfer|debt)$/i;

export type ExtractedInvoiceCustomer = {
  name: string | null;
  phone: string | null;
};

function stripPhones(line: string): string {
  return line.replace(PHONE_CHUNK, ' ').replace(/\s+/g, ' ').trim();
}

function firstCanonPhone(text: string): string | null {
  const chunks = text.match(PHONE_CHUNK) || [];
  for (const chunk of chunks) {
    const canon = normalizeCustomerPhone(chunk);
    if (canon) return canon;
  }
  return null;
}

function cleanCustomerName(raw: string, sellerName: string | null | undefined): string | null {
  const text = stripPhones(raw)
    .replace(/[«»"']/g, '')
    .replace(/[,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (PAYMENT_OR_META.test(text.replace(/[.!?]/g, ''))) return null;
  if (/\d/.test(text)) return null;
  if (text.split(' ').length > 4) return null;
  if (!/[а-яёәғқңөұүһіa-z]{2,}/i.test(text)) return null;
  if (sellerName && nameKey(text) && nameKey(text) === nameKey(sellerName)) return null;
  return text.slice(0, 80);
}

export function extractInvoiceCustomer(
  text: string,
  sellerName?: string | null
): ExtractedInvoiceCustomer {
  const lines = String(text || '')
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let phone: string | null = null;
  let phoneLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const canon = firstCanonPhone(lines[i]);
    if (canon) {
      phone = canon;
      phoneLine = i;
      break;
    }
  }
  if (!phone) {
    phone = firstCanonPhone(text);
  }
  let name: string | null = null;
  if (phoneLine >= 0) {
    name = cleanCustomerName(lines[phoneLine], sellerName);
    if (!name && phoneLine > 0) {
      name = cleanCustomerName(lines[phoneLine - 1], sellerName);
    }
  }
  return { name, phone };
}

export function extractPhonesCanon(text: string): string[] {
  const chunks = String(text || '').match(PHONE_CHUNK) || [];
  const out: string[] = [];
  for (const chunk of chunks) {
    const canon = normalizeCustomerPhone(chunk);
    if (canon && !out.includes(canon)) out.push(canon);
  }
  return out;
}
