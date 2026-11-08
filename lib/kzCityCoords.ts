export type KzGeoCity = {
  id: string;
  nameRu: string;
  nameKz: string;
  lat: number;
  lng: number;
  aliases: string[];
};

type RawGeo = Omit<KzGeoCity, 'aliases'> & { aliases?: string[] };

/** Geographic places only. Warehouse seller names are matched as prefix, not stored here. */
const RAW_GEO_CITIES: RawGeo[] = [
  { id: 'almaty', nameRu: 'Алматы', nameKz: 'Алматы', lat: 43.2389, lng: 76.8897, aliases: ['Алмата', 'Almaty'] },
  { id: 'astana', nameRu: 'Астана', nameKz: 'Астана', lat: 51.1694, lng: 71.4491, aliases: ['Нур-Султан', 'Нурсултан', 'Nur-Sultan', 'Astana'] },
  { id: 'shymkent', nameRu: 'Шымкент', nameKz: 'Шымкент', lat: 42.3419, lng: 69.5901, aliases: ['Чимкент', 'Shymkent'] },
  { id: 'atyrau', nameRu: 'Атырау', nameKz: 'Атырау', lat: 47.0945, lng: 51.9238, aliases: ['Гурьев', 'Atyrau'] },
  { id: 'aktobe', nameRu: 'Актобе', nameKz: 'Ақтөбе', lat: 50.2839, lng: 57.167, aliases: ['Актюбинск', 'Aktobe'] },
  { id: 'karaganda', nameRu: 'Караганда', nameKz: 'Қарағанды', lat: 49.806, lng: 73.085, aliases: ['Karaganda'] },
  { id: 'oral', nameRu: 'Уральск', nameKz: 'Орал', lat: 51.2333, lng: 51.3667, aliases: ['Oral', 'Uralsk'] },
  { id: 'kostanay', nameRu: 'Костанай', nameKz: 'Қостанай', lat: 53.2144, lng: 63.6246, aliases: ['Кустанай', 'Kostanay'] },
  { id: 'pavlodar', nameRu: 'Павлодар', nameKz: 'Павлодар', lat: 52.287, lng: 76.9674, aliases: ['Pavlodar'] },
  { id: 'semey', nameRu: 'Семей', nameKz: 'Семей', lat: 50.4111, lng: 80.2275, aliases: ['Семипалатинск', 'Semey'] },
  { id: 'oskemen', nameRu: 'Усть-Каменогорск', nameKz: 'Өскемен', lat: 49.9483, lng: 82.627, aliases: ['Оскемен', 'Oskemen', 'Ust-Kamenogorsk'] },
  { id: 'taraz', nameRu: 'Тараз', nameKz: 'Тараз', lat: 42.9, lng: 71.3667, aliases: ['Джамбул', 'Жамбыл', 'Taraz'] },
  { id: 'kyzylorda', nameRu: 'Кызылорда', nameKz: 'Қызылорда', lat: 44.8488, lng: 65.5099, aliases: ['Кзыл-Орда', 'Kyzylorda'] },
  { id: 'aktau', nameRu: 'Актау', nameKz: 'Ақтау', lat: 43.65, lng: 51.2, aliases: ['Шевченко', 'Aktau'] },
  { id: 'petropavl', nameRu: 'Петропавловск', nameKz: 'Петропавл', lat: 54.8753, lng: 69.1628, aliases: ['Petropavl'] },
  { id: 'kokshetau', nameRu: 'Кокшетау', nameKz: 'Көкшетау', lat: 53.2833, lng: 69.3883, aliases: ['Кокчетав', 'Kokshetau'] },
  { id: 'turkistan', nameRu: 'Туркестан', nameKz: 'Түркістан', lat: 43.2973, lng: 68.2518, aliases: ['Turkistan', 'Turkestan'] },
  { id: 'ekibastuz', nameRu: 'Экибастуз', nameKz: 'Екібастұз', lat: 51.7233, lng: 75.3228, aliases: ['Ekibastuz'] },
  { id: 'temirtau', nameRu: 'Темиртау', nameKz: 'Теміртау', lat: 50.0544, lng: 72.964, aliases: ['Temirtau'] },
  { id: 'taldykorgan', nameRu: 'Талдыкорган', nameKz: 'Талдықорған', lat: 45.0156, lng: 78.3739, aliases: ['Талды-Курган', 'Taldykorgan'] },
  { id: 'zhezkazgan', nameRu: 'Жезказган', nameKz: 'Жезқазған', lat: 47.7833, lng: 67.7144, aliases: ['Джезказган', 'Zhezkazgan'] },
  { id: 'balkhash', nameRu: 'Балхаш', nameKz: 'Балқаш', lat: 46.8481, lng: 74.995, aliases: ['Balkhash'] },
  { id: 'konaev', nameRu: 'Конаев', nameKz: 'Қонаев', lat: 43.853, lng: 77.0631, aliases: ['Капчагай', 'Қапшағай', 'Konaev'] },
  { id: 'zhanaozen', nameRu: 'Жанаозен', nameKz: 'Жаңаөзен', lat: 43.3378, lng: 52.8556, aliases: ['Новый Узень', 'Новый-Узень', 'Zhanaozen'] },
  { id: 'kulsary', nameRu: 'Кульсары', nameKz: 'Құлсары', lat: 46.953, lng: 54.0082, aliases: ['Кулсары', 'Kulsary'] },
  { id: 'shardara', nameRu: 'Шардара', nameKz: 'Шардара', lat: 41.2558, lng: 67.9694, aliases: ['Чардара', 'Shardara'] },
  { id: 'rudny', nameRu: 'Рудный', nameKz: 'Рудный', lat: 52.9728, lng: 63.12, aliases: ['Rudny'] },
  { id: 'lisakovsk', nameRu: 'Лисаковск', nameKz: 'Лисаковск', lat: 52.5471, lng: 62.4936, aliases: ['Lisakovsk'] },
  { id: 'satpayev', nameRu: 'Сатпаев', nameKz: 'Сәтбаев', lat: 47.9, lng: 67.5333, aliases: ['Satpayev'] },
  { id: 'kentau', nameRu: 'Кентау', nameKz: 'Кентау', lat: 43.5167, lng: 68.5167, aliases: ['Kentau'] },
  { id: 'arys', nameRu: 'Арыс', nameKz: 'Арыс', lat: 42.43, lng: 68.8, aliases: ['Арысь', 'Arys'] },
  { id: 'kaskelen', nameRu: 'Каскелен', nameKz: 'Қаскелең', lat: 43.1983, lng: 76.6311, aliases: ['Kaskelen'] },
  { id: 'talgar', nameRu: 'Талгар', nameKz: 'Талғар', lat: 43.3033, lng: 77.2408, aliases: ['Talgar'] },
  { id: 'esik', nameRu: 'Есик', nameKz: 'Есік', lat: 43.355, lng: 77.4525, aliases: ['Иссык', 'Esik'] },
  { id: 'zharkent', nameRu: 'Жаркент', nameKz: 'Жаркент', lat: 44.1667, lng: 80.0, aliases: ['Панфилов', 'Zharkent'] },
  { id: 'ayagoz', nameRu: 'Аягоз', nameKz: 'Аягөз', lat: 47.9647, lng: 80.4344, aliases: ['Ayagoz'] },
  { id: 'ridder', nameRu: 'Риддер', nameKz: 'Риддер', lat: 50.3442, lng: 83.5128, aliases: ['Лениногорск', 'Ridder'] },
  { id: 'altai', nameRu: 'Алтай', nameKz: 'Алтай', lat: 49.7269, lng: 84.2731, aliases: ['Зыряновск', 'Zyryanovsk'] },
  { id: 'saran', nameRu: 'Сарань', nameKz: 'Саран', lat: 49.8006, lng: 72.8506, aliases: ['Saran'] },
  { id: 'shakhtinsk', nameRu: 'Шахтинск', nameKz: 'Шахтинск', lat: 49.71, lng: 72.5922, aliases: ['Shakhtinsk'] },
  { id: 'stepnogorsk', nameRu: 'Степногорск', nameKz: 'Степногорск', lat: 52.3519, lng: 71.8817, aliases: ['Stepnogorsk'] },
  { id: 'shchuchinsk', nameRu: 'Щучинск', nameKz: 'Щучинск', lat: 52.9333, lng: 70.2, aliases: ['Shchuchinsk'] },
  { id: 'arkalyk', nameRu: 'Аркалык', nameKz: 'Арқалық', lat: 50.2486, lng: 66.9203, aliases: ['Arkalyk'] },
  { id: 'zhitikara', nameRu: 'Житикара', nameKz: 'Жітіқара', lat: 52.1908, lng: 61.2006, aliases: ['Джетыгара', 'Zhitikara'] },
  { id: 'khromtau', nameRu: 'Хромтау', nameKz: 'Хромтау', lat: 50.2503, lng: 58.44, aliases: ['Khromtau'] },
  { id: 'kandyagash', nameRu: 'Кандыагаш', nameKz: 'Қандыағаш', lat: 49.4694, lng: 57.4183, aliases: ['Kandyagash'] },
  { id: 'beyneu', nameRu: 'Бейнеу', nameKz: 'Бейнеу', lat: 45.3167, lng: 55.2, aliases: ['Beyneu'] },
  { id: 'aksu', nameRu: 'Аксу', nameKz: 'Ақсу', lat: 52.04, lng: 76.9275, aliases: ['Ермак', 'Aksu'] },
  { id: 'ushtobe', nameRu: 'Уштобе', nameKz: 'Үштөбе', lat: 45.2522, lng: 77.9803, aliases: ['Ushtobe'] },
  { id: 'tekeli', nameRu: 'Текели', nameKz: 'Текелі', lat: 44.8631, lng: 78.7642, aliases: ['Tekeli'] },
  { id: 'lenger', nameRu: 'Ленгер', nameKz: 'Леңгір', lat: 42.1833, lng: 69.8833, aliases: ['Lenger'] },
  { id: 'saryagash', nameRu: 'Сарыагаш', nameKz: 'Сарыағаш', lat: 41.45, lng: 69.1667, aliases: ['Saryagash'] },
  { id: 'aksai', nameRu: 'Аксай', nameKz: 'Ақсай', lat: 51.171, lng: 53.04, aliases: ['Aksai'] },
  { id: 'atbasar', nameRu: 'Атбасар', nameKz: 'Атбасар', lat: 51.8111, lng: 68.3603, aliases: ['Atbasar'] },
  { id: 'makinsk', nameRu: 'Макинск', nameKz: 'Макинск', lat: 52.6292, lng: 70.4172, aliases: ['Makinsk'] },
  { id: 'usharal', nameRu: 'Ушарал', nameKz: 'Үшарал', lat: 46.1697, lng: 80.9394, aliases: ['Usharal'] },
  { id: 'karazhal', nameRu: 'Каражал', nameKz: 'Қаражал', lat: 48.0078, lng: 70.7906, aliases: ['Karazhal'] },
];

/** Exact warehouse names that are not geographic, mapped to a geo city id. */
const RAW_EXCEPTIONS: Record<string, string> = {
  SKLAD: 'almaty',
  sklad: 'almaty',
};

export function normalizeMapAlias(raw: string): string {
  return String(raw || '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/ә/g, 'а')
    .replace(/ғ/g, 'г')
    .replace(/қ/g, 'к')
    .replace(/ң/g, 'н')
    .replace(/ө/g, 'о')
    .replace(/ұ/g, 'у')
    .replace(/ү/g, 'у')
    .replace(/һ/g, 'х')
    .replace(/і/g, 'и')
    .replace(/[ьъ]/g, '')
    .replace(/[ʼ’'`]/g, '')
    .replace(/[‐‑–—−]/g, '-')
    .replace(/[._/]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isNameBoundary(ch: string | undefined): boolean {
  return ch == null || ch === '-' || ch === ' ';
}

export const KZ_GEO_CITIES: KzGeoCity[] = RAW_GEO_CITIES.map((city) => ({
  ...city,
  aliases: Array.from(new Set([city.nameRu, city.nameKz, ...(city.aliases || [])].map(normalizeMapAlias))).filter(Boolean),
}));

const GEO_BY_ID = new Map(KZ_GEO_CITIES.map((c) => [c.id, c]));

const EXACT_ALIAS = new Map<string, KzGeoCity>();
const PREFIX_ALIASES: Array<{ alias: string; city: KzGeoCity }> = [];
for (const city of KZ_GEO_CITIES) {
  for (const alias of city.aliases) {
    if (!EXACT_ALIAS.has(alias)) EXACT_ALIAS.set(alias, city);
    PREFIX_ALIASES.push({ alias, city });
  }
}
PREFIX_ALIASES.sort((a, b) => b.alias.length - a.alias.length);

const EXCEPTIONS = new Map<string, KzGeoCity>();
for (const [raw, geoId] of Object.entries(RAW_EXCEPTIONS)) {
  const city = GEO_BY_ID.get(geoId);
  if (city) EXCEPTIONS.set(normalizeMapAlias(raw), city);
}

export function findKzGeoCity(name: string): KzGeoCity | null {
  const n = normalizeMapAlias(name);
  if (!n) return null;
  const exception = EXCEPTIONS.get(n);
  if (exception) return exception;
  const exact = EXACT_ALIAS.get(n);
  if (exact) return exact;
  for (const { alias, city } of PREFIX_ALIASES) {
    if (alias.length < 4) continue;
    if (!n.startsWith(alias)) continue;
    if (!isNameBoundary(n[alias.length])) continue;
    return city;
  }
  return null;
}

export function classifyWarehouseNames(names: string[]): { recognized: Array<{ name: string; geoId: string }>; unknown: string[] } {
  const recognized: Array<{ name: string; geoId: string }> = [];
  const unknown: string[] = [];
  for (const name of names) {
    const geo = findKzGeoCity(name);
    if (geo) recognized.push({ name, geoId: geo.id });
    else unknown.push(name);
  }
  return { recognized, unknown };
}
