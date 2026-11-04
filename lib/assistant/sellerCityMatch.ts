import { compactKey, levenshtein, nameKey } from '@/lib/assistant/nameFold';

export type SellerMatchRow = { id: string; display_name: string; city_id: string | null };
export type CityMatchRow = { id: string; name: string };

function scoreName(query: string, candidate: string): number {
  const q = nameKey(query);
  const n = nameKey(candidate);
  if (!q || !n) return 0;
  const qc = compactKey(query);
  const nc = compactKey(candidate);
  if (q === n || qc === nc) return 100;
  if (qc.length >= 4 && nc.length >= 4 && levenshtein(qc, nc) <= 1) return 92;
  if (q.length >= 3 && (n === q || n.startsWith(`${q} `) || q.startsWith(`${n} `))) return 88;
  if (q.length >= 4 && (n.includes(q) || q.includes(n))) return 72;
  return 0;
}

export function matchNamedRows<T>(query: string, rows: T[], nameOf: (row: T) => string): T[] {
  const q = nameKey(query);
  if (!q) return [];
  const scored = rows
    .map((row) => ({ row, score: scoreName(query, nameOf(row)) }))
    .filter((x) => x.score >= 72)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const best = scored[0].score;
  return scored.filter((x) => x.score === best).map((x) => x.row);
}

export function matchSellers(query: string, sellers: SellerMatchRow[]): SellerMatchRow[] {
  return matchNamedRows(query, sellers, (s) => s.display_name);
}

export function matchCities(query: string, cities: CityMatchRow[]): CityMatchRow[] {
  return matchNamedRows(query, cities, (c) => c.name);
}

export function resolveSellerAndCity(
  sellerQuery: string,
  cityQuery: string,
  sellers: SellerMatchRow[],
  cities: CityMatchRow[]
): {
  seller_id: string | null;
  seller_name: string | null;
  seller_candidates: { id: string; name: string; city: string }[];
  city_id: string | null;
  city_name: string | null;
  city_candidates: string[];
  errors: { code: string; message: string }[];
} {
  const errors: { code: string; message: string }[] = [];
  const cityById = new Map(cities.map((c) => [c.id, c]));
  const sellerMatches = matchSellers(sellerQuery, sellers.filter((s) => s.city_id));
  const seller_candidates = sellerMatches.map((s) => ({
    id: s.id,
    name: s.display_name,
    city: cityById.get(s.city_id || '')?.name || '',
  }));

  let seller_id: string | null = null;
  let seller_name: string | null = sellerQuery || null;
  if (!nameKey(sellerQuery)) {
    errors.push({ code: 'seller_missing', message: 'Продавец не указан. Напишите имя существующего продавца.' });
  } else if (sellerMatches.length === 0) {
    errors.push({
      code: 'seller_not_found',
      message: `Продавец «${sellerQuery}» не найден. Нового продавца не создаю.`,
    });
  } else if (sellerMatches.length > 1) {
    errors.push({
      code: 'seller_ambiguous',
      message: `Несколько продавцов с похожим именем: ${seller_candidates
        .map((s) => `${s.name} (${s.city || 'город ?'})`)
        .join(', ')}. Уточните.`,
    });
  } else {
    seller_id = sellerMatches[0].id;
    seller_name = sellerMatches[0].display_name || sellerQuery;
  }

  const cityMatches = matchCities(cityQuery, cities);
  const city_candidates = cityMatches.map((c) => c.name);
  let city_id: string | null = null;
  let city_name: string | null = cityQuery || null;
  const sellerRow = seller_id ? sellers.find((s) => s.id === seller_id) : null;

  if (nameKey(cityQuery)) {
    if (cityMatches.length === 0) {
      errors.push({ code: 'city_not_found', message: `Город «${cityQuery}» не найден. Новый склад не создаю.` });
    } else if (cityMatches.length > 1) {
      errors.push({ code: 'city_ambiguous', message: `Несколько городов: ${city_candidates.join(', ')}. Уточните.` });
    } else {
      city_id = cityMatches[0].id;
      city_name = cityMatches[0].name;
    }
  } else if (sellerRow?.city_id) {
    const city = cityById.get(sellerRow.city_id);
    if (city) {
      city_id = city.id;
      city_name = city.name;
    } else {
      errors.push({
        code: 'city_missing',
        message: 'У продавца нет допустимого города. Укажите активный город.',
      });
    }
  } else {
    errors.push({
      code: 'city_missing',
      message: 'Город не указан, и продавец не выбран однозначно. Укажите город.',
    });
  }

  if (sellerRow?.city_id && city_id && sellerRow.city_id !== city_id) {
    errors.push({
      code: 'seller_city_mismatch',
      message: `Продавец привязан к городу ${cityById.get(sellerRow.city_id)?.name || ''}, а в накладной другой город.`,
    });
  }

  return {
    seller_id,
    seller_name,
    seller_candidates: seller_candidates.length > 1 ? seller_candidates : [],
    city_id,
    city_name,
    city_candidates: city_candidates.length > 1 ? city_candidates : [],
    errors,
  };
}
