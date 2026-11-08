export type KzGeoCity = {
  id: string;
  nameRu: string;
  nameKz: string;
  lat: number;
  lng: number;
  aliases: string[];
};

/** Explicit warehouse-name aliases only. No substring / prefix matching. */
const RAW_GEO_CITIES: Array<Omit<KzGeoCity, 'aliases'> & { aliases: string[] }> = [
  {
    id: 'almaty',
    nameRu: 'Алматы',
    nameKz: 'Алматы',
    lat: 43.2389,
    lng: 76.8897,
    aliases: ['Алматы', 'Алмата', 'Almaty', 'Алматы-Офис', 'Алматы Офис', 'Алматы-Ғалия', 'Алматы-Галия', 'Алматы Ғалия'],
  },
  {
    id: 'astana',
    nameRu: 'Астана',
    nameKz: 'Астана',
    lat: 51.1694,
    lng: 71.4491,
    aliases: ['Астана', 'Нур-Султан', 'Нурсултан', 'Nur-Sultan', 'Astana'],
  },
  {
    id: 'shymkent',
    nameRu: 'Шымкент',
    nameKz: 'Шымкент',
    lat: 42.3419,
    lng: 69.5901,
    aliases: ['Шымкент', 'Чимкент', 'Shymkent'],
  },
  {
    id: 'atyrau',
    nameRu: 'Атырау',
    nameKz: 'Атырау',
    lat: 47.0945,
    lng: 51.9238,
    aliases: ['Атырау', 'Гурьев', 'Atyrau'],
  },
  {
    id: 'aktobe',
    nameRu: 'Актобе',
    nameKz: 'Ақтөбе',
    lat: 50.2839,
    lng: 57.167,
    aliases: ['Актобе', 'Актюбинск', 'Ақтөбе', 'Aktobe'],
  },
  {
    id: 'karaganda',
    nameRu: 'Караганда',
    nameKz: 'Қарағанды',
    lat: 49.806,
    lng: 73.085,
    aliases: ['Караганда', 'Қарағанды', 'Karaganda'],
  },
  {
    id: 'oral',
    nameRu: 'Уральск',
    nameKz: 'Орал',
    lat: 51.2333,
    lng: 51.3667,
    aliases: ['Уральск', 'Орал', 'Oral', 'Uralsk'],
  },
  {
    id: 'kostanay',
    nameRu: 'Костанай',
    nameKz: 'Қостанай',
    lat: 53.2144,
    lng: 63.6246,
    aliases: ['Костанай', 'Кустанай', 'Қостанай', 'Kostanay'],
  },
  {
    id: 'pavlodar',
    nameRu: 'Павлодар',
    nameKz: 'Павлодар',
    lat: 52.287,
    lng: 76.9674,
    aliases: ['Павлодар', 'Pavlodar'],
  },
  {
    id: 'semey',
    nameRu: 'Семей',
    nameKz: 'Семей',
    lat: 50.4111,
    lng: 80.2275,
    aliases: ['Семей', 'Семипалатинск', 'Semey'],
  },
  {
    id: 'oskemen',
    nameRu: 'Усть-Каменогорск',
    nameKz: 'Өскемен',
    lat: 49.9483,
    lng: 82.627,
    aliases: ['Усть-Каменогорск', 'Оскемен', 'Өскемен', 'Oskemen', 'Ust-Kamenogorsk'],
  },
  {
    id: 'taraz',
    nameRu: 'Тараз',
    nameKz: 'Тараз',
    lat: 42.9,
    lng: 71.3667,
    aliases: ['Тараз', 'Джамбул', 'Жамбыл', 'Taraz'],
  },
  {
    id: 'kyzylorda',
    nameRu: 'Кызылорда',
    nameKz: 'Қызылорда',
    lat: 44.8488,
    lng: 65.5099,
    aliases: ['Кызылорда', 'Қызылорда', 'Кзыл-Орда', 'Kyzylorda'],
  },
  {
    id: 'aktau',
    nameRu: 'Актау',
    nameKz: 'Ақтау',
    lat: 43.65,
    lng: 51.2,
    aliases: ['Актау', 'Ақтау', 'Шевченко', 'Aktau'],
  },
  {
    id: 'petropavl',
    nameRu: 'Петропавловск',
    nameKz: 'Петропавл',
    lat: 54.8753,
    lng: 69.1628,
    aliases: ['Петропавловск', 'Петропавл', 'Petropavl'],
  },
  {
    id: 'kokshetau',
    nameRu: 'Кокшетау',
    nameKz: 'Көкшетау',
    lat: 53.2833,
    lng: 69.3883,
    aliases: ['Кокшетау', 'Кокчетав', 'Көкшетау', 'Kokshetau'],
  },
  {
    id: 'turkistan',
    nameRu: 'Туркестан',
    nameKz: 'Түркістан',
    lat: 43.2973,
    lng: 68.2518,
    aliases: ['Туркестан', 'Түркістан', 'Turkistan', 'Turkestan'],
  },
  {
    id: 'ekibastuz',
    nameRu: 'Экибастуз',
    nameKz: 'Екібастұз',
    lat: 51.7233,
    lng: 75.3228,
    aliases: ['Экибастуз', 'Екібастұз', 'Ekibastuz'],
  },
  {
    id: 'temirtau',
    nameRu: 'Темиртау',
    nameKz: 'Теміртау',
    lat: 50.0544,
    lng: 72.964,
    aliases: ['Темиртау', 'Теміртау', 'Temirtau'],
  },
  {
    id: 'taldykorgan',
    nameRu: 'Талдыкорган',
    nameKz: 'Талдықорған',
    lat: 45.0156,
    lng: 78.3739,
    aliases: ['Талдыкорган', 'Талды-Курган', 'Талдықорған', 'Taldykorgan'],
  },
  {
    id: 'zhezkazgan',
    nameRu: 'Жезказган',
    nameKz: 'Жезқазған',
    lat: 47.7833,
    lng: 67.7144,
    aliases: ['Жезказган', 'Джезказган', 'Жезқазған', 'Zhezkazgan'],
  },
  {
    id: 'balkhash',
    nameRu: 'Балхаш',
    nameKz: 'Балқаш',
    lat: 46.8481,
    lng: 74.995,
    aliases: ['Балхаш', 'Балқаш', 'Balkhash'],
  },
  {
    id: 'konaev',
    nameRu: 'Конаев',
    nameKz: 'Қонаев',
    lat: 43.853,
    lng: 77.0631,
    aliases: ['Конаев', 'Қонаев', 'Капчагай', 'Қапшағай', 'Konaev'],
  },
];

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
    .replace(/[ʼ’'`]/g, '')
    .replace(/[‐‑–—−]/g, '-')
    .replace(/[._/]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const KZ_GEO_CITIES: KzGeoCity[] = RAW_GEO_CITIES.map((city) => ({
  ...city,
  aliases: Array.from(new Set([city.nameRu, city.nameKz, ...city.aliases].map(normalizeMapAlias))).filter(Boolean),
}));

const ALIAS_TO_GEO = new Map<string, KzGeoCity>();
for (const city of KZ_GEO_CITIES) {
  for (const alias of city.aliases) {
    if (!ALIAS_TO_GEO.has(alias)) ALIAS_TO_GEO.set(alias, city);
  }
}

export function findKzGeoCity(name: string): KzGeoCity | null {
  return ALIAS_TO_GEO.get(normalizeMapAlias(name)) || null;
}
