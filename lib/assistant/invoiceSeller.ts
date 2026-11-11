import { nameKey } from '@/lib/assistant/nameFold';
import { invoiceHeaderSellerName } from '@/lib/assistant/invoiceLines';
import {
  matchSellers,
  resolveSellerAndCity,
  type CityMatchRow,
  type SellerMatchRow,
} from '@/lib/assistant/sellerCityMatch';

const PAYMENT_OR_META =
  /^(нал|налом|наличк|наличн|kaspi|каспи|qr|куар|карта|картой|перевод|аударым|долг|қарыз|предзаказ|оплач|төлен|толен|cash|card|transfer|debt|не оплач)$/i;
const PHONE_CHUNK = /(?:\+?\d[\d\t ().-]{7,}\d)/g;

function stripPhones(line: string): string {
  return line.replace(PHONE_CHUNK, ' ').replace(/\s+/g, ' ').trim();
}

function cleanName(raw: string): string {
  return stripPhones(raw)
    .replace(/^(продавец|сатушы)\s*[:\-–]?\s*/i, '')
    .replace(/[«»"']/g, '')
    .replace(/[,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function usableName(raw: string): string | null {
  const text = cleanName(raw);
  if (!text) return null;
  if (PAYMENT_OR_META.test(text.replace(/[.!?]/g, ''))) return null;
  if (/(төлен|толен|оплач|налич|kaspi|каспи|долг|қарыз|предзаказ)/i.test(text)) return null;
  if (/\d/.test(text)) return null;
  if (text.split(' ').length > 4) return null;
  if (!/[а-яёәғқңөұүһіa-z]{2,}/i.test(text)) return null;
  return text.slice(0, 80);
}

/** Customer phones never identify a seller: profiles have no phone field to match. */
export function sellerMatchesByPhone(_phone: string, _sellers: SellerMatchRow[]): SellerMatchRow[] {
  return [];
}

export function invoiceSellerNameQueries(text: string, parsedSellerName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = usableName(raw);
    if (!name) return;
    const key = nameKey(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  add(parsedSellerName);
  add(invoiceHeaderSellerName(text) || '');
  const sellerLine = String(text || '').match(/(?:продавец|сатушы)\s*[:\-–]\s*([^\n]+)/i);
  if (sellerLine) add(sellerLine[1]);
  return out;
}

export function resolveInvoiceSeller(
  parsedSellerName: string,
  parsedCityName: string,
  originalText: string,
  sellers: SellerMatchRow[],
  cities: CityMatchRow[]
) {
  const headerName = invoiceHeaderSellerName(originalText);
  const parsedName = usableName(parsedSellerName) || String(parsedSellerName || '').trim();
  const queries = invoiceSellerNameQueries(originalText, parsedName);
  const activeSellers = sellers.filter((s) => s.city_id);

  if (headerName) {
    const headerHits = matchSellers(headerName, activeSellers);
    if (headerHits.length === 1) {
      return resolveSellerAndCity(headerHits[0].display_name, parsedCityName, sellers, cities);
    }
    if (headerHits.length > 1) {
      return resolveSellerAndCity(headerName, parsedCityName, sellers, cities);
    }
  }

  if (parsedName && (!headerName || nameKey(parsedName) === nameKey(headerName))) {
    const placed = resolveSellerAndCity(parsedName, parsedCityName, sellers, cities);
    if (placed.seller_id || placed.errors.some((e) => e.code === 'seller_ambiguous')) {
      return placed;
    }
  }

  const unique = uniqueSellerHit(queries, sellers);
  if (unique) {
    return resolveSellerAndCity(unique.display_name, parsedCityName, sellers, cities);
  }
  const ambiguousQuery = queries.find((q) => matchSellers(q, activeSellers).length > 1);
  if (ambiguousQuery) {
    return resolveSellerAndCity(ambiguousQuery, parsedCityName, sellers, cities);
  }
  if (headerName) {
    return resolveSellerAndCity(headerName, parsedCityName, sellers, cities);
  }
  return resolveSellerAndCity(parsedName, parsedCityName, sellers, cities);
}

function uniqueSellerHit(queries: string[], sellers: SellerMatchRow[]): SellerMatchRow | null {
  const hits: SellerMatchRow[] = [];
  const ids = new Set<string>();
  for (const q of queries) {
    const matched = matchSellers(q, sellers.filter((s) => s.city_id));
    if (matched.length === 1 && !ids.has(matched[0].id)) {
      ids.add(matched[0].id);
      hits.push(matched[0]);
    }
  }
  if (hits.length === 1) return hits[0];
  return null;
}
