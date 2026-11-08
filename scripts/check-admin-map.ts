import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  buildAdminMap,
  geoMarkerLabel,
  MAP_VB_H,
  MAP_VB_W,
  pointInKzOutline,
  projectKz,
  reduceMapClick,
  SPIDERFY_MIN_SEP,
  spiderfyMinDistance,
  spiderfyOffsets,
  spiderfyOffsetsForOrigin,
} from '../lib/adminMap';
import { classifyWarehouseNames, findKzGeoCity, KZ_GEO_CITIES, normalizeMapAlias } from '../lib/kzCityCoords';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const products = [
  { id: 'p1', name: 'Мука', unit: 'kg', is_active: true },
  { id: 'p2', name: 'Коробка', unit: 'pcs', is_active: true },
];

const grouped = buildAdminMap({
  cities: [
    { id: 'c-office', name: 'Алматы-Офис', address: 'ул. Абая 1', is_active: true },
    { id: 'c-galia', name: 'Алматы-Ғалия', address: 'Ғалия 8', is_active: true },
    { id: 'c-astana', name: 'Нур-Султан', address: null, is_active: true },
    { id: 'c-atyrau', name: 'Атырау', address: 'Набережная', is_active: true },
    { id: 'c-hidden', name: 'Алматы', address: '   ', is_active: false },
    { id: 'c-unknown', name: 'Склад Запад 12', address: 'тест', is_active: true },
  ],
  inventory: [
    { city_id: 'c-office', product_id: 'p1', qty_on_hand: 12.5 },
    { city_id: 'c-galia', product_id: 'p2', qty_on_hand: 3 },
    { city_id: 'c-unknown', product_id: 'p2', qty_on_hand: -1 },
  ],
  products,
});

const almaty = grouped.markers.find((m) => m.geoId === 'almaty');
if (!almaty || almaty.sellers.length !== 3) fail('Almaty-Office and Almaty-Galiya must share one marker');
if (geoMarkerLabel(almaty, 'ru') !== 'Алматы (3)') fail('cluster label shows count');
const office = almaty.sellers.find((s) => s.cityId === 'c-office');
const galia = almaty.sellers.find((s) => s.cityId === 'c-galia');
const hidden = almaty.sellers.find((s) => s.cityId === 'c-hidden');
if (!office || office.stocks[0]?.qtyOnHand !== 12.5) fail('office keeps own stock');
if (!galia || galia.stocks[0]?.qtyOnHand !== 3) fail('galiya keeps own stock');
if (office.stocks.some((s) => s.productId === 'p2') || galia.stocks.some((s) => s.productId === 'p1')) {
  fail('must not merge inventory across warehouses');
}
if (!hidden || hidden.isActive || hidden.address !== null || hidden.stocks.length !== 0) {
  fail('inactive warehouse stays separate with empty address and stock');
}
if (findKzGeoCity('Алматинская') || findKzGeoCity('Новый-Алматы') || findKzGeoCity('Семиозерка-Тест')) {
  fail('must not match a similar but wrong place');
}
if (findKzGeoCity('Алматы Склад')?.id !== 'almaty') fail('space after city name is a warehouse delimiter');
if (findKzGeoCity('SKLAD')?.id !== 'almaty') fail('SKLAD exception → Almaty');
if (findKzGeoCity('Өскемен-Арна')?.id !== 'oskemen') fail('compound kazakh city with hyphenated seller');
if (findKzGeoCity('Усть-Каменогорск-Арна')?.id !== 'oskemen') fail('longest match for Ust-Kamenogorsk');
if (findKzGeoCity('Астана-Ғафура')?.id !== 'astana') fail('Astana prefix');
if (findKzGeoCity('Жезқазған-Айдана')?.id !== 'zhezkazgan') fail('future warehouse auto-detect');
if (findKzGeoCity('Павлодар-Продавец')?.id !== 'pavlodar') fail('future Pavlodar');
if (findKzGeoCity('Көкшетау-Продавец')?.id !== 'kokshetau') fail('future Kokshetau');
if (findKzGeoCity('Жаңаөзен-Мереке')?.id !== 'zhanaozen') fail('Zhanaozen');
if (findKzGeoCity('Құлсары-Гүлжанат')?.id !== 'kulsary') fail('Kulsary');
if (findKzGeoCity('Шардара-Ләззат')?.id !== 'shardara') fail('Shardara');
if (findKzGeoCity('Ақтау-Жанбота')?.id !== 'aktau') fail('Aktau kazakh spelling');
if (findKzGeoCity('Қарағанды-Гүлжан')?.id !== 'karaganda') fail('Karaganda kazakh spelling');

const aliasOwner = new Map<string, string>();
for (const city of KZ_GEO_CITIES) {
  for (const alias of city.aliases) {
    const prev = aliasOwner.get(alias);
    if (prev && prev !== city.id) fail(`duplicate alias ${alias} for ${prev} and ${city.id}`);
    aliasOwner.set(alias, city.id);
  }
}

const network = [
  'Атырау-Айгүл',
  'Атырау-Бибигүл',
  'Атырау-Лара',
  'Алматы-Офис',
  'Алматы-Ғалия',
  'Астана-Ғафура',
  'Ақтау-Жанбота',
  'Ақтөбе-Гүлдәурен',
  'Қарағанды-Гүлжан',
  'Қызылорда-Бақыт',
  'Орал-Зульфия',
  'Өскемен-Арна',
  'Тараз-Айнұр',
  'Шымкент-Ақнұр',
  'Жаңаөзен-Мереке',
  'Құлсары-Гүлжанат',
  'Шардара-Ләззат',
  'SKLAD',
  'Семей',
];
const classified = classifyWarehouseNames(network);
if (classified.unknown.length) fail(`network unknown: ${classified.unknown.join(', ')}`);
if (classified.recognized.filter((r) => r.geoId === 'atyrau').length !== 3) fail('Atyrau cluster of 3');
if (classified.recognized.filter((r) => r.geoId === 'almaty').length !== 3) fail('Almaty cluster includes SKLAD');
if (normalizeMapAlias('Алматы - Офис') !== 'алматы-офис') fail('normalize hyphen spacing');

const astana = grouped.markers.find((m) => m.geoId === 'astana');
if (!astana || astana.sellers.length !== 1 || astana.sellers[0].cityId !== 'c-astana') fail('Nur-Sultan maps to Astana');
if (grouped.unknown.length !== 1 || grouped.unknown[0].cityId !== 'c-unknown') fail('unknown coords stay off the map');
if (grouped.unknown[0].negativeCount !== 1) fail('unknown stock still loaded');

const atyrau = grouped.markers.find((m) => m.geoId === 'atyrau');
if (!atyrau) fail('Atyrau marker');
if (!(almaty.x > atyrau.x)) fail('Almaty is east of Atyrau');
if (!(astana.y < almaty.y)) fail('Astana is north of Almaty');

const idle = { expandedGeoId: null, selectedCityId: null, selectedTransferGroupId: 'route:atyrau->almaty' };
const single = reduceMapClick(idle, { type: 'geo', geoId: 'astana' }, astana);
if (single.expandedGeoId !== null || single.selectedCityId !== 'c-astana' || single.selectedTransferGroupId !== null) {
  fail('single seller opens panel directly and clears transfer');
}

const open = reduceMapClick(
  { expandedGeoId: null, selectedCityId: null, selectedTransferGroupId: null },
  { type: 'geo', geoId: 'almaty' },
  almaty
);
if (open.expandedGeoId !== 'almaty' || open.selectedCityId !== null) fail('cluster click spiderfies without picking a seller');
const pick = reduceMapClick(open, { type: 'seller', geoId: 'almaty', cityId: 'c-galia' }, almaty);
if (pick.selectedCityId !== 'c-galia' || pick.expandedGeoId !== 'almaty') fail('leaf click keeps spiderfy and opens panel');
const closeSame = reduceMapClick(open, { type: 'geo', geoId: 'almaty' }, almaty);
if (closeSame.expandedGeoId !== null || closeSame.selectedCityId !== null) fail('second click on cluster closes spiderfy');
const switchCity = reduceMapClick(open, { type: 'geo', geoId: 'atyrau' }, atyrau);
if (switchCity.selectedCityId !== 'c-atyrau' || switchCity.expandedGeoId !== null) fail('other city closes previous spiderfy');
const bg = reduceMapClick({ ...pick, selectedTransferGroupId: 'local:almaty' }, { type: 'background' });
if (bg.expandedGeoId !== null || bg.selectedCityId !== null || bg.selectedTransferGroupId !== null) {
  fail('background clears warehouse and transfer selection');
}

if (spiderfyOffsets(1).length !== 0) fail('one seller has no spiderfy offsets');
for (const n of [2, 3, 4, 6, 8]) {
  if (spiderfyMinDistance(n) + 1e-6 < SPIDERFY_MIN_SEP) fail(`spiderfy overlap at n=${n}`);
}
const edge = spiderfyOffsetsForOrigin(4, { x: 24, y: 40 });
for (const off of edge) {
  const x = 24 + off.dx;
  const y = 40 + off.dy;
  if (x < 28 || y < 28 || x > MAP_VB_W - 28 || y > MAP_VB_H - 28) fail('spiderfy must stay inside map near edges');
}
for (const city of KZ_GEO_CITIES) {
  if (!pointInKzOutline(city.lng, city.lat)) fail(`city outside outline: ${city.id}`);
}
if (astana.sellers[0].address !== null) fail('missing address stays null');

const pAlmaty = projectKz(76.8897, 43.2389);
const pAtyrau = projectKz(51.9238, 47.0945);
if (Math.hypot(pAlmaty.x - pAtyrau.x, pAlmaty.y - pAtyrau.y) < 80) fail('projected cities must stay apart');

const page = read('app/admin/map/page.tsx');
const map = read('components/AdminKazakhstanMap.tsx');
const nav = read('components/NavAdmin.tsx');
const i18n = read('lib/i18n.tsx');
const managerNav = read('components/NavManager.tsx');
const sellerNav = read('components/NavSeller.tsx');
if (!existsSync(join(process.cwd(), 'app/admin/map/page.tsx'))) fail('map page missing');
if (!page.includes('Protected role="admin"')) fail('admin only');
if (!page.includes("role === 'admin'") || !page.includes('if (!authReady || !isAdmin) return')) {
  fail('must not load stock until admin role is confirmed');
}
if (!page.includes('[refreshKey, authReady, isAdmin]')) fail('stable load deps');
if (page.includes(', t]')) fail('language must not refetch');
if (page.includes('confirm_order') || page.includes('apply_inventory') || page.includes('create_stock_transfer')) {
  fail('map is read-only');
}
if (page.includes('/api/')) fail('no public map API');
if (page.includes('console.log')) fail('no console');
if (!page.includes('runExclusive')) fail('coalesce fetches');
if (!page.includes('let cancelled = false')) fail('cancel load');
if (!page.includes('lg:hidden') || !page.includes('hidden') || !page.includes('lg:flex')) fail('mobile bottom panel');
if (!map.includes('spiderfyOffsetsForOrigin') || !map.includes('touch-none')) fail('spiderfy + touch zoom');
if (!map.includes("addEventListener('wheel'")) fail('non-passive wheel');
if (!page.includes('overscroll-contain') || !page.includes('safe-area-inset-bottom')) fail('mobile panel scroll/safe area');
if (!page.includes('fetchInTransitMapTransfers') || !page.includes("eq('status', 'in_transit')") && !read('lib/fetchAdminMapTransfers.ts').includes(".eq('status', 'in_transit')")) {
  fail('load only in_transit transfers');
}
const fetchSrc = read('lib/fetchAdminMapTransfers.ts');
if (!fetchSrc.includes('.range(') || !fetchSrc.includes('MAP_TRANSFER_PAGE') || !fetchSrc.includes('truncated')) {
  fail('transfer pagination required');
}
if (page.includes('receive_stock_transfer') || page.includes('cancel_stock_transfer') || page.includes('write_off')) {
  fail('map must not mutate transfers');
}
if (!map.includes('animateMotion') || !map.includes('data-map-hit="truck"') || !map.includes('prefers-reduced-motion')) {
  fail('decorative truck motion with reduced-motion');
}
if (!map.includes('map.layerAnimation') || !i18n.includes('не GPS-трекинг') || !i18n.includes('GPS-трекинг емес')) {
  fail('animation is labelled as not GPS tracking');
}
if (page.includes('ETA') || page.includes('gps') || map.includes('percentAlong')) fail('must not invent GPS progress');
if (!map.includes('data-map-hit="route"') || !map.includes('data-map-hit="local-transfer"')) fail('transfer hit targets');
if (!map.includes('map.layerWarehouses') || !map.includes('map.layerTransfers')) fail('layer toggles');
const localBlock = map.slice(map.indexOf('data-map-hit="local-transfer"'));
if (localBlock.includes('TransferTruckIcon') || localBlock.includes('animateMotion')) fail('no trucks on intra-city markers');
if (!page.includes('formatForecastQty(item.remaining') || page.includes('group.remaining')) {
  fail('panel must show per-item qty, not mixed-unit group remaining');
}
if (!page.includes('mapTransfersForDisplay') || !page.includes('map.statusPartial')) {
  fail('unreliable overlay hidden; statuses translated');
}
if (!nav.includes('href="/admin/map"')) fail('nav');
if (managerNav.includes('/admin/map') || sellerNav.includes('/admin/map')) fail('staff nav leak');
if (!i18n.includes("'map.nav': 'Карта'")) fail('i18n nav');
const keys = [...i18n.matchAll(/'(map\.[^']+)':/g)].map((m) => m[1]);
const ruSet = new Set(keys.slice(0, keys.length / 2));
const kzSet = new Set(keys.slice(keys.length / 2));
for (const key of ruSet) if (!kzSet.has(key)) fail(`kz missing ${key}`);
for (const key of kzSet) if (!ruSet.has(key)) fail(`ru missing ${key}`);

const sampleUnknown = classifyWarehouseNames(['Склад Запад 12', 'Алматинская', 'Новый-Алматы']).unknown;
if (sampleUnknown.length !== 3) fail(`expected 3 true unknowns, got ${sampleUnknown.join(', ')}`);
console.log('admin-map checks ok');
console.log(
  `network warehouses: ${classified.recognized.length}/${network.length} recognized, unknown: ${classified.unknown.join(', ') || 'none'}`
);
