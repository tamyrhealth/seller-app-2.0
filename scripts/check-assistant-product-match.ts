import { readFileSync } from 'fs';
import { join } from 'path';
import { matchCatalogProducts, resolveProductQuery } from '../lib/assistant/productAliases';
import { resolveSellerAndCity } from '../lib/assistant/sellerCityMatch';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const catalog = [
  { id: 'p1', name: 'ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 1000, is_active: true },
  { id: 'p2', name: 'ШИКІ ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 1100, is_active: true },
  { id: 'p3', name: 'ШАЙ ОРГ 500г', unit: 'g', price_retail: 800, is_active: true },
  { id: 'p4', name: 'ТӘТТІ ШАЙ', unit: 'g', price_retail: 900, is_active: true },
  { id: 'p5', name: 'ПЛАСТЫРЬ 50шт', unit: 'pcs', price_retail: 500, is_active: true },
  { id: 'p6', name: 'МОКСОПЛАСТЫРЬ', unit: 'pcs', price_retail: 600, is_active: true },
  { id: 'p7', name: 'АРҚА ПЛАСТЫРЬ', unit: 'pcs', price_retail: 650, is_active: true },
  { id: 'p8', name: 'АЮ ПЛАСТЫРЬ', unit: 'pcs', price_retail: 700, is_active: true },
  { id: 'p9', name: 'ДРАЖЕ 250г', unit: 'g', price_retail: 400, is_active: true },
  { id: 'p10', name: 'МАЗЬ', unit: 'pcs', price_retail: 300, is_active: true },
  { id: 'p11', name: 'МАЗЬ МАКСИ', unit: 'pcs', price_retail: 350, is_active: true },
  { id: 'p12', name: 'Крем дневной', unit: 'pcs', price_retail: 200, is_active: true },
  { id: 'p13', name: 'Крем ночной', unit: 'pcs', price_retail: 210, is_active: true },
  { id: 'hidden', name: 'ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 1, is_active: false },
];

function one(query: string, name: string) {
  const r = resolveProductQuery(query, catalog);
  if (!r.chosen || r.chosen.name !== name) {
    fail(`${query} expected ${name}, got ${r.chosen?.name || r.reason} (${r.candidates.map((c) => c.name).join(', ')})`);
  }
}

one('порошок', 'ПОРОШОК ОРГ 250г');
one('порошок орг', 'ПОРОШОК ОРГ 250г');
one('poroshok', 'ПОРОШОК ОРГ 250г');
one('шикі порошок', 'ШИКІ ПОРОШОК ОРГ 250г');
one('шики порошок', 'ШИКІ ПОРОШОК ОРГ 250г');
one('сырой порошок', 'ШИКІ ПОРОШОК ОРГ 250г');
one('чай', 'ШАЙ ОРГ 500г');
one('шай', 'ШАЙ ОРГ 500г');
one('shai', 'ШАЙ ОРГ 500г');
one('тәтті шай', 'ТӘТТІ ШАЙ');
one('татти чай', 'ТӘТТІ ШАЙ');
one('сладкий чай', 'ТӘТТІ ШАЙ');
one('пластырь', 'ПЛАСТЫРЬ 50шт');
one('моксопластырь', 'МОКСОПЛАСТЫРЬ');
one('арқа пластырь', 'АРҚА ПЛАСТЫРЬ');
one('аю пластырь', 'АЮ ПЛАСТЫРЬ');
one('драже', 'ДРАЖЕ 250г');
one('мазь', 'МАЗЬ');
one('мазь макси', 'МАЗЬ МАКСИ');
one('ПОРОШОК ОРГ 250г', 'ПОРОШОК ОРГ 250г');

const krem = resolveProductQuery('крем', catalog);
if (krem.chosen) fail('крем must not auto-pick');
if (krem.candidates.length < 2 || krem.candidates.length > 5) fail('крем should offer 2-5 candidates');
if (krem.candidates.some((c) => c.is_active === false)) fail('candidates must be active');
const short = resolveProductQuery('ма', catalog);
if (short.chosen) fail('short prefix must not auto-pick a product');

const missing = resolveProductQuery('несуществующий товар xyz', catalog);
if (missing.chosen || missing.candidates.length) fail('missing product must stay unresolved');

const inactiveOnly = resolveProductQuery('порошок', [
  { id: 'h', name: 'ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 1, is_active: false },
  { id: 'x', name: 'ШАЙ ОРГ 500г', unit: 'g', price_retail: 2, is_active: true },
]);
if (inactiveOnly.chosen?.name === 'ПОРОШОК ОРГ 250г') fail('must not pick inactive product');

const cities = [
  { id: 'c1', name: 'Астана' },
  { id: 'c2', name: 'Алматы' },
];
const sellers = [
  { id: 's1', display_name: 'Айгүл', city_id: 'c1' },
  { id: 's2', display_name: 'Марат', city_id: 'c2' },
];
for (const q of ['Айгүл', 'Айгуль', 'Aigul', 'aigul']) {
  const r = resolveSellerAndCity(q, '', sellers, cities);
  if (r.seller_id !== 's1' || r.city_id !== 'c1') fail(`${q} should resolve Айгүл / Астана`);
}

const twins = resolveSellerAndCity('Айгуль', '', [
  { id: 's1', display_name: 'Айгүл', city_id: 'c1' },
  { id: 's3', display_name: 'Айгуль', city_id: 'c2' },
], cities);
if (twins.seller_id || twins.city_id) fail('equal seller matches must not guess');
if (!twins.errors.some((e) => e.code === 'seller_ambiguous')) fail('need seller_ambiguous');

const noCity = resolveSellerAndCity('Марат', '', [{ id: 's2', display_name: 'Марат', city_id: 'c-missing' }], cities);
if (noCity.city_id) fail('must not invent a city');
if (!noCity.errors.some((e) => e.code === 'city_missing' || e.code === 'city_not_found')) fail('need city missing error');

const unknownCity = resolveSellerAndCity('Марат', 'Караганда', sellers, cities);
if (!unknownCity.errors.some((e) => e.code === 'city_not_found')) fail('unknown city');

if (matchCatalogProducts('сырой порошок', catalog)[0]?.name !== 'ШИКІ ПОРОШОК ОРГ 250г') {
  fail('generic powder alias must not override shiki');
}

const card = read('components/AssistantOrderDraftCard.tsx');
const picker = read('components/DraftProductPicker.tsx');
const resolve = read('lib/assistant/resolveOrder.ts');
const update = read('app/api/assistant/orders/update/route.ts');
const confirm = read('app/api/assistant/orders/confirm/route.ts');
const catalogRoute = read('app/api/assistant/orders/catalog/route.ts');

if (!picker.includes('Другой товар')) fail('other-product search');
if (!picker.includes('Поиск по активному каталогу')) fail('catalog search placeholder');
if (!picker.includes('Полный каталог не показываем')) fail('must not dump full catalog');
if (!card.includes('DraftProductPicker')) fail('card uses picker');
if (!card.includes('pickResolvedProduct')) fail('one-click pick');
if (!card.includes('/api/assistant/orders/update')) fail('save still uses update');
if (!card.includes('Подтвердить заказ')) fail('confirm kept');
if (!card.includes('Исправить')) fail('edit kept');
if (card.includes("from('products').delete")) fail('card must not delete products');
if (!catalogRoute.includes('price_retail')) fail('catalog must expose live prices');
if (!catalogRoute.includes("eq('is_active', true)")) fail('catalog active only');
if (!resolve.includes('resolveProductQuery')) fail('server resolve uses matcher');
if (!resolve.includes('resolveSellerAndCity')) fail('seller/city matcher');
if (!resolve.includes("eq('is_active', true)")) fail('resolve active catalog');
if (!resolve.includes('applyDraftEdit')) fail('edit/re-save kept');
if (!update.includes('applyDraftEdit')) fail('re-save goes through applyDraftEdit');
if (update.includes("rpc('confirm_order'")) fail('update must not confirm');
if (!confirm.includes("rpc('confirm_order'")) fail('confirm still uses confirm_order');
if (!confirm.includes('idempotency_key')) fail('confirm keeps idempotency');
if (!confirm.includes('revalidateResolved')) fail('confirm revalidates live prices/stock');

const confirmSql = read('supabase/run_confirm_order_reject_inactive_products.sql');
if (!confirmSql.includes('Product is not available')) fail('must not drop inactive confirm guard');

console.log('OK');
