import { matchCities, type CityMatchRow } from '@/lib/assistant/sellerCityMatch';
import { nameKey } from '@/lib/assistant/nameFold';
import { stripCityCase } from '@/lib/assistant/transferIntent';

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
    if (keys.includes(q)) {
      for (const alias of group) out.add(nameKey(alias));
    }
  }
  return [...out].filter(Boolean);
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
