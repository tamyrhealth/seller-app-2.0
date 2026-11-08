import { matchCities, type CityMatchRow } from '@/lib/assistant/sellerCityMatch';
import { nameKey, nameTokens } from '@/lib/assistant/nameFold';
import { isSkladCode, stripCityCase } from '@/lib/assistant/transferIntent';
import { findKzGeoCity, KZ_GEO_CITIES } from '@/lib/kzCityCoords';

const CITY_ALIAS_GROUPS: string[][] = [
  ['алматы', 'алмата', 'almaty', 'alma ata'],
  ['актау', 'ақтау', 'aktau'],
  ['астана', 'нур султан', 'нұр-сұлтан', 'nur sultan', 'astana'],
  ['семей', 'семипалатинск', 'semey'],
  ['шымкент', 'чимкент', 'shymkent'],
  ['караганда', 'қарағанды', 'karaganda'],
  ['уральск', 'орал', 'oral', 'uralsk'],
  ['кокшетау', 'көкшетау', 'kokshetau'],
  ['павлодар', 'pavlodar'],
  ['кызылорда', 'қызылорда', 'kyzylorda'],
  ['тараз', 'джамбул', 'taraz'],
  ['атырау', 'atyrau'],
  ['петропавловск', 'петропавл', 'petropavl'],
  ['костанай', 'қостанай', 'kostanay'],
];

function aliasQuery(query: string): string[] {
  const q = nameKey(stripCityCase(query));
  if (!q) return [];
  const out = new Set<string>([q, nameKey(query)]);
  for (const group of CITY_ALIAS_GROUPS) {
    const keys = group.map((g) => nameKey(g));
    if (keys.includes(q) || keys.some((k) => inflectedCityKey(q, k))) {
      for (const alias of group) out.add(nameKey(alias));
    }
  }
  return [...out].filter(Boolean);
}

/** Астану ↔ Астана: same stem, last letter may inflect. */
function inflectedCityKey(queryKey: string, aliasKey: string): boolean {
  if (!queryKey || !aliasKey) return false;
  if (queryKey === aliasKey) return true;
  if (queryKey.length < 5 || aliasKey.length < 5) return false;
  if (Math.abs(queryKey.length - aliasKey.length) > 1) return false;
  const n = Math.min(queryKey.length, aliasKey.length);
  return queryKey.slice(0, n - 1) === aliasKey.slice(0, n - 1);
}

function queryForms(query: string): string[] {
  const stripped = stripCityCase(query);
  const forms = new Set<string>([query.trim(), stripped]);
  if (stripped.length >= 5 && /[уюеыая]$/i.test(stripped)) {
    forms.add(`${stripped.slice(0, -1)}а`);
    forms.add(`${stripped.slice(0, -1)}я`);
  }
  return [...forms].filter(Boolean);
}

/** Geographic city for a user query. SKLAD is a warehouse code, not Almaty. */
export function geoCityForTransferQuery(query: string): { id: string; nameRu: string } | null {
  if (!query.trim() || isSkladCode(query)) return null;
  for (const form of queryForms(query)) {
    if (isSkladCode(form)) continue;
    const hyphen = /[-–—]/.test(form);
    const geo = findKzGeoCity(form);
    if (geo && !hyphen) return { id: geo.id, nameRu: geo.nameRu };
  }
  const qk = nameKey(stripCityCase(query));
  for (const city of KZ_GEO_CITIES) {
    for (const alias of [city.nameRu, city.nameKz, ...city.aliases]) {
      if (inflectedCityKey(qk, nameKey(alias))) return { id: city.id, nameRu: city.nameRu };
    }
  }
  return null;
}

function warehouseGeoId(name: string): string | null {
  if (isSkladCode(name)) return null;
  return findKzGeoCity(name)?.id || null;
}

export function inCityPrepositional(nameRu: string): string {
  if (nameKey(nameRu) === 'astana') return 'Астане';
  return nameRu;
}

export function matchTransferCities(query: string, cities: CityMatchRow[]): CityMatchRow[] {
  const queries = aliasQuery(query);
  const seen = new Map<string, CityMatchRow>();
  for (const q of queries) {
    for (const row of matchCities(q, cities)) seen.set(row.id, row);
  }
  if (seen.size) return [...seen.values()];
  return matchCities(query, cities);
}

/**
 * Warehouse resolution for stock transfers.
 * 1) exact SKLAD / exact warehouse name
 * 2) normalized compound name (Алматы-Офис)
 * 3) existing alias / fuzzy name match
 * 4) geographic city → all active warehouses in that city
 */
export function matchTransferWarehouses(query: string, cities: CityMatchRow[]): CityMatchRow[] {
  const q = query.trim();
  if (!q) return [];

  if (isSkladCode(q)) {
    return cities.filter((c) => isSkladCode(c.name));
  }

  const qFold = nameKey(stripCityCase(q));
  const qRaw = nameKey(q);
  const exact = cities.filter((c) => {
    const n = nameKey(c.name);
    return n === qFold || n === qRaw;
  });
  if (exact.length) return exact;

  const tokens = nameTokens(stripCityCase(q)).filter((t) => t !== 'sklad' || isSkladCode(q));
  if (tokens.length >= 2) {
    const hits = cities.filter((c) => {
      const names = nameTokens(c.name);
      return tokens.every((t) => names.some((n) => n === t || (t.length >= 4 && (n.startsWith(t) || t.startsWith(n)))));
    });
    if (hits.length) return hits;
  }

  const named = matchTransferCities(q, cities);
  if (named.length) return named;

  const geo = geoCityForTransferQuery(q);
  if (!geo) return [];
  return cities.filter((c) => warehouseGeoId(c.name) === geo.id);
}
