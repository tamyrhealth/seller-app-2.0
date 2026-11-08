import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTransferIntent } from '../lib/assistant/transferIntent';
import {
  actorCanCreateTransfer,
  applyTransferEdit,
  chooseTransferCity,
  mergeTransferEditItems,
  shouldFlagInsufficientStock,
  stockQtyForSource,
} from '../lib/assistant/resolveTransfer';
import { matchTransferCities } from '../lib/assistant/transferCityMatch';
import { resolveProductQuery } from '../lib/assistant/productAliases';
import { qtyValidationError } from '../lib/assistant/qty';
import { isAssistantRole } from '../lib/roles';
import { looksLikeInvoice } from '../lib/assistant/paymentParse';
import { parseCancelIntent } from '../lib/assistant/cancelIntent';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

function expectTransfer(text: string, from: string, to: string, items: { name: string; qty: number }[]) {
  const intent = parseTransferIntent(text);
  if (!intent) fail(`should detect transfer: ${text}`);
  if (intent.fromQuery.toLowerCase() !== from.toLowerCase()) {
    fail(`${text} from=${intent.fromQuery}, expected ${from}`);
  }
  if (intent.toQuery.toLowerCase() !== to.toLowerCase()) {
    fail(`${text} to=${intent.toQuery}, expected ${to}`);
  }
  if (intent.items.length !== items.length) {
    fail(`${text} items=${JSON.stringify(intent.items)}, expected ${JSON.stringify(items)}`);
  }
  items.forEach((item, i) => {
    if (!intent.items[i].raw_name.toLowerCase().includes(item.name.toLowerCase())) {
      fail(`${text} item name ${intent.items[i].raw_name} vs ${item.name}`);
    }
    if (intent.items[i].qty !== item.qty) fail(`${text} qty ${intent.items[i].qty} vs ${item.qty}`);
  });
}

expectTransfer('Алматы → Актау\n100 порошок\n25 чай', 'Алматы', 'Актау', [
  { name: 'порошок', qty: 100 },
  { name: 'чай', qty: 25 },
]);
expectTransfer('Отправь из Алматы в Актау 10 пластырь', 'Алматы', 'Актау', [{ name: 'пластырь', qty: 10 }]);
expectTransfer('Алматыдан Ақтауға 1.25 ұнтақ жібер', 'Алматы', 'Ақтау', [{ name: 'ұнтақ', qty: 1.25 }]);
expectTransfer(
  'Создай перемещение со склада Алматы-Офис на склад Актау-Жанбота: Порошок ОРГ 250 г — 1 штука.',
  'Алматы-Офис',
  'Актау-Жанбота',
  [{ name: 'Порошок ОРГ 250 г', qty: 1 }]
);
expectTransfer(
  'Отправь из Алматы-Офис в Актау-Жанбота\nПорошок ОРГ 250 г — 1 штука',
  'Алматы-Офис',
  'Актау-Жанбота',
  [{ name: 'Порошок ОРГ 250 г', qty: 1 }]
);
expectTransfer(
  'со склада Алматы-Офис на склад Актау-Жанбота: Порошок ОРГ 250 г — 1 штука и Чай — 2 шт',
  'Алматы-Офис',
  'Актау-Жанбота',
  [
    { name: 'Порошок ОРГ 250 г', qty: 1 },
    { name: 'Чай', qty: 2 },
  ]
);
expectTransfer(
  'Алматы-Офистен Ақтау-Жанботаға Порошок ОРГ 250 г 1 дана жібер',
  'Алматы-Офис',
  'Ақтау-Жанбота',
  [{ name: 'Порошок ОРГ 250 г', qty: 1 }]
);
expectTransfer(
  'Жөнелт Алматы-Офистен Ақтау-Жанботаға\n1 ұнтақ\n2 шай',
  'Алматы-Офис',
  'Ақтау-Жанбота',
  [
    { name: 'ұнтақ', qty: 1 },
    { name: 'шай', qty: 2 },
  ]
);
if (parseTransferIntent('Айгерим Алматы\n10 порошок\nkaspi')) fail('order invoice must not be transfer');
if (parseTransferIntent('Отмени заказ N000033')) fail('cancel is not transfer');
if (parseTransferIntent('Где перемещение T000001')) fail('lookup is not create');
if (parseTransferIntent('Прими отправку T000001')) fail('receive is not create');

function namesOverlap(a: string, b: string) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.includes(y) || y.includes(x);
}

function expectTransferLoose(text: string, from: string, to: string, items: { name: string; qty: number }[]) {
  const intent = parseTransferIntent(text);
  if (!intent) fail(`should detect transfer: ${text}`);
  if (intent.fromQuery.toLowerCase() !== from.toLowerCase()) {
    fail(`${text} from=${intent.fromQuery}, expected ${from}`);
  }
  if (intent.toQuery.toLowerCase() !== to.toLowerCase()) {
    fail(`${text} to=${intent.toQuery}, expected ${to}`);
  }
  if (intent.items.length !== items.length) {
    fail(`${text} items=${JSON.stringify(intent.items)}, expected ${JSON.stringify(items)}`);
  }
  items.forEach((item, i) => {
    if (!namesOverlap(intent.items[i].raw_name, item.name)) {
      fail(`${text} item name ${intent.items[i].raw_name} vs ${item.name}`);
    }
    if (intent.items[i].qty !== item.qty) fail(`${text} qty ${intent.items[i].qty} vs ${item.qty}`);
  });
}

expectTransferLoose('Перемещение со SKLAD в Астану\n1 порошок', 'SKLAD', 'Астану', [{ name: 'порошок', qty: 1 }]);
expectTransferLoose('Перемещение со склада SKLAD в Астану\n1 порошок', 'SKLAD', 'Астану', [{ name: 'порошок', qty: 1 }]);
expectTransferLoose('Отправь с Алматы-Офис в Семей\n2 порошка\n3 чая', 'Алматы-Офис', 'Семей', [
  { name: 'порош', qty: 2 },
  { name: 'ча', qty: 3 },
]);
expectTransferLoose('Перемести 2 порошка из SKLAD в Астана-Гафура', 'SKLAD', 'Астана-Гафура', [{ name: 'порош', qty: 2 }]);
expectTransferLoose('Перемести 1 порошок из SKLAD в Астана-Гафура', 'SKLAD', 'Астана-Гафура', [{ name: 'порошок', qty: 1 }]);
expectTransferLoose('Перемести 3 чая из SKLAD в Астана-Гафура', 'SKLAD', 'Астана-Гафура', [{ name: 'ча', qty: 3 }]);
expectTransferLoose('Перемести 2 шай из SKLAD в Астана-Гафура', 'SKLAD', 'Астана-Гафура', [{ name: 'шай', qty: 2 }]);
expectTransferLoose('SKLAD-тан Астанаға\n5 ұнтақ', 'SKLAD', 'Астана', [{ name: 'ұнтақ', qty: 5 }]);
expectTransferLoose('Алматы-Офистен Семейге 2 ұнтақ жібер', 'Алматы-Офис', 'Семей', [{ name: 'ұнтақ', qty: 2 }]);
expectTransferLoose('SKLAD → Астана-Гафура\nПорошок 5\nЧай 2', 'SKLAD', 'Астана-Гафура', [
  { name: 'Порошок', qty: 5 },
  { name: 'Чай', qty: 2 },
]);
expectTransferLoose('SKLAD -> Астана-Гафура\nПорошок 5\nЧай 2', 'SKLAD', 'Астана-Гафура', [
  { name: 'Порошок', qty: 5 },
  { name: 'Чай', qty: 2 },
]);
const kzNoQty = parseTransferIntent('SKLAD-тан Астанаға тауар жіберу');
if (!kzNoQty || kzNoQty.fromQuery.toLowerCase() !== 'sklad' || kzNoQty.toQuery.toLowerCase() !== 'астана') {
  fail('kazakh send without qty must stay a transfer, not a sale');
}
if (kzNoQty.items.length) fail('тауар жіберу has no qty lines');

const incomplete = parseTransferIntent('Перемещение со SKLAD в Астану');
if (!incomplete) fail('incomplete transfer must not fall through to invoice');
if (incomplete.fromQuery.toLowerCase() !== 'sklad' || incomplete.toQuery.toLowerCase() !== 'астану') {
  fail(`incomplete pair ${incomplete.fromQuery} → ${incomplete.toQuery}`);
}
if (incomplete.items.length) fail('incomplete transfer has no items and must not be confirmable later');

const unknownWh = parseTransferIntent('Перемещение со Неттакого в Семей\n1 порошок');
if (!unknownWh) fail('unknown warehouse still a transfer intent');
if (unknownWh.fromQuery !== 'Неттакого' || unknownWh.toQuery !== 'Семей') fail('keep unknown warehouse query');

const first = parseTransferIntent('Перемещение со SKLAD в Астану\n1 порошок');
const second = parseTransferIntent('Перемещение со SKLAD в Астану\n1 порошок');
if (JSON.stringify(first) !== JSON.stringify(second)) fail('repeat parse must be stable');

if (parseTransferIntent('Айгерим Алматы\n10 порошок\nналичка')) fail('cash invoice must not be transfer');
if (parseTransferIntent('Айгерим Алматы\nдоставка курьером\n10 порошок\nналичка')) fail('sale with delivery is not transfer');
if (parseTransferIntent('Айгерим Алматы\nотправка сегодня\n10 порошок\nkaspi')) fail('sale mentioning отправка stays a sale');

const transferSamples = [
  'Перемещение со SKLAD в Астану\n1 порошок',
  'SKLAD → Астана-Гафура\n1 порошок',
  'SKLAD-тан Астанаға\n5 ұнтақ',
  'Отправь с Алматы-Офис в Семей\n2 порошка\n3 чая',
  'Перемести 2 порошка из SKLAD в Астана-Гафура',
];
for (const sample of transferSamples) {
  if (!parseTransferIntent(sample)) fail(`transfer sample must not fall through to sale: ${sample}`);
}
if (parseTransferIntent('Айгерим Алматы\n10 порошок\nдолг')) fail('debt invoice must not be transfer');
if (!looksLikeInvoice('Айгерим Алматы\n10 порошок\nkaspi')) fail('kaspi invoice heuristic');
if (!looksLikeInvoice('Айгерим Алматы\n10 порошок\nналичка')) fail('cash invoice heuristic');
if (!looksLikeInvoice('Айгерим Алматы\nдоставка курьером\n10 порошок\nналичка')) fail('delivery sale still looks like invoice');
if (!parseCancelIntent('Отмени заказ N000033')) fail('cancel order must stay cancel');

if (actorCanCreateTransfer('admin', false).allowed !== true) fail('admin can create without flag');
if (actorCanCreateTransfer('manager', true).allowed !== true) fail('manager with flag');
if (actorCanCreateTransfer('manager', false).allowed) fail('manager without flag cannot');
if (actorCanCreateTransfer('manager', false, true).allowed) fail('can_manage_transfers must not grant create');
if (read('lib/assistant/resolveTransfer.ts').includes('canCreateTransfers || canManageTransfers')) {
  fail('create permission must match SQL and ignore can_manage_transfers');
}
if (actorCanCreateTransfer('seller', true).allowed) fail('seller cannot create transfers');
if (isAssistantRole('seller')) fail('seller is not assistant');

const cities = [
  { id: '1', name: 'Алматы' },
  { id: '2', name: 'Ақтау' },
];
if (matchTransferCities('алмата', cities)[0]?.name !== 'Алматы') fail('almaty alias');
if (matchTransferCities('aktau', cities)[0]?.name !== 'Ақтау') fail('aktau alias');

const almatyWarehouses = [
  { id: 'galia', name: 'Алматы-Ғалия', is_active: true },
  { id: 'office', name: 'Алматы-Офис', is_active: true },
  { id: 'aktau', name: 'Ақтау', is_active: true },
];
const ambiguousFrom = chooseTransferCity('Алматы', almatyWarehouses, 'from');
if (ambiguousFrom.id) fail('Алматы must stay ambiguous when two warehouses match');
if (ambiguousFrom.candidates.length !== 2) fail(`expected 2 Almaty warehouses, got ${ambiguousFrom.candidates.length}`);
if (!ambiguousFrom.errors.some((e) => e.code === 'from_city_ambiguous')) fail('ambiguous source needs from_city_ambiguous');
if (!ambiguousFrom.candidates.some((c) => c.id === 'galia') || !ambiguousFrom.candidates.some((c) => c.id === 'office')) {
  fail('ambiguous source must expose warehouse ids for picker');
}
const uniqueTo = chooseTransferCity('Ақтау', almatyWarehouses, 'to');
if (uniqueTo.id !== 'aktau') fail('Aktau must resolve uniquely');

const withSklad = [...almatyWarehouses, { id: 'sklad', name: 'SKLAD', is_active: true }];
const skladHit = chooseTransferCity('SKLAD', withSklad, 'from');
if (skladHit.id !== 'sklad') fail(`SKLAD warehouse code must resolve uniquely, got ${skladHit.id}`);

const namedWarehouses = [
  { id: 'galia', name: 'Алматы-Ғалия', is_active: true },
  { id: 'office', name: 'Алматы-Офис', is_active: true },
  { id: 'zhan', name: 'Актау-Жанбота', is_active: true },
  { id: 'aktau', name: 'Ақтау', is_active: true },
];
const office = chooseTransferCity('Алматы-Офис', namedWarehouses, 'from');
if (office.id !== 'office') fail(`Алматы-Офис must be unique, got ${office.id}`);
const zhan = chooseTransferCity('Актау-Жанбота', namedWarehouses, 'to');
if (zhan.id !== 'zhan') fail(`Актау-Жанбота must be unique, got ${zhan.id}`);
const stillAmbiguous = chooseTransferCity('Алматы', namedWarehouses, 'from');
if (stillAmbiguous.id) fail('bare Алматы must stay ambiguous');
if (stillAmbiguous.candidates.length !== 2) fail('bare Алматы must offer both warehouses');

const liveWarehouses = [
  { id: 'sklad', name: 'SKLAD', is_active: true },
  { id: 'gafura', name: 'Астана-Гафура', is_active: true },
  { id: 'galia', name: 'Алматы-Ғалия', is_active: true },
  { id: 'office', name: 'Алматы-Офис', is_active: true },
  { id: 'semey', name: 'Семей', is_active: true },
  { id: 'atyrau', name: 'Атырау', is_active: true },
];
if (chooseTransferCity('SKLAD', liveWarehouses, 'from').id !== 'sklad') fail('SKLAD must stay the SKLAD warehouse');
if (chooseTransferCity('Астана-Гафура', liveWarehouses, 'to').id !== 'gafura') fail('Астана-Гафура must be exact');
if (chooseTransferCity('Астану', liveWarehouses, 'to').id !== 'gafura') fail('Астану with one Astana warehouse must pick it');
if (chooseTransferCity('Астана', liveWarehouses, 'to').id !== 'gafura') fail('Астана with one warehouse must pick it');
if (chooseTransferCity('Астанаға', liveWarehouses, 'to').id !== 'gafura') fail('Астанаға must map to Astana warehouse');
if (chooseTransferCity('Алматы-Офис', liveWarehouses, 'from').id !== 'office') fail('Алматы-Офис exact');
if (chooseTransferCity('Алматы-Ғалия', liveWarehouses, 'from').id !== 'galia') fail('Алматы-Ғалия exact');
if (chooseTransferCity('Семей', liveWarehouses, 'to').id !== 'semey') fail('Семей exact');
if (chooseTransferCity('Семейге', liveWarehouses, 'to').id !== 'semey') fail('Семейге must map to Семей');
if (chooseTransferCity('Атырау', liveWarehouses, 'to').id !== 'atyrau') fail('Атырау exact');
if (chooseTransferCity('Атырауға', liveWarehouses, 'to').id !== 'atyrau') fail('Атырауға must map to Атырау');
if (chooseTransferCity('Алматыға', liveWarehouses, 'from').id) fail('Алматыға with two warehouses must stay ambiguous');
if (chooseTransferCity('Алматыға', liveWarehouses, 'from').candidates.length !== 2) fail('Алматыға must list both Almaty warehouses');
if (chooseTransferCity('Алматы', liveWarehouses, 'from').candidates.some((c) => c.id === 'sklad')) {
  fail('Алматы geo match must not swallow SKLAD');
}

const twoAstana = [...liveWarehouses, { id: 'ast2', name: 'Астана-Центр', is_active: true }];
const astanaPick = chooseTransferCity('Астану', twoAstana, 'to');
if (astanaPick.id) fail('two Astana warehouses must not auto-pick');
if (astanaPick.candidates.length !== 2) fail('two Astana warehouses must both appear');
if (!astanaPick.errors.some((e) => e.message.includes('В Астане найдено несколько складов. Выберите получателя'))) {
  fail(`astana ambiguous copy got ${JSON.stringify(astanaPick.errors)}`);
}
const almatyPick = chooseTransferCity('Алматы', liveWarehouses, 'from');
if (!almatyPick.errors.some((e) => e.message.includes('В Алматы найдено несколько складов. Выберите отправителя'))) {
  fail(`almaty ambiguous copy got ${JSON.stringify(almatyPick.errors)}`);
}

const unknownCity = chooseTransferCity('Неттакого', liveWarehouses, 'from');
if (unknownCity.id || unknownCity.candidates.length) fail('unknown warehouse must not substitute another city');
if (!unknownCity.errors.some((e) => e.code === 'from_city_not_found')) fail('unknown warehouse needs from_city_not_found');

const inactiveOnly = [
  { id: 'sklad', name: 'SKLAD', is_active: false },
  { id: 'office', name: 'Алматы-Офис', is_active: true },
];
const inactiveSklad = chooseTransferCity('SKLAD', inactiveOnly, 'from');
if (inactiveSklad.id) fail('inactive SKLAD must not be selected');
if (!inactiveSklad.errors.some((e) => e.code === 'from_city_inactive')) fail('inactive SKLAD needs from_city_inactive');

const powder250 = { id: 'p250', name: 'Порошок ОРГ 250 г', unit: 'pcs', price_retail: 1, is_active: true };
const powder500 = { id: 'p500', name: 'Порошок ОРГ 500 г', unit: 'pcs', price_retail: 1, is_active: true };
const exact250 = resolveProductQuery('Порошок ОРГ 250 г', [powder250, powder500]);
if (exact250.chosen?.id !== 'p250') fail('250 g query must pick the 250 g product, not invent a name');
const bothPowders = resolveProductQuery('Порошок ОРГ', [powder250, powder500]);
if (bothPowders.chosen) fail('bare Порошок ОРГ with two sizes must not guess');
if (bothPowders.candidates.length < 2) fail('bare Порошок ОРГ must offer existing sizes');
const powderInflect = resolveProductQuery('порошка', [powder250, powder500]);
if (powderInflect.chosen) fail('inflected порошка with two SKUs must not pick at random');

const sameWh = applyTransferEdit(
  liveWarehouses,
  [powder250],
  new Map([['p250', 5]]),
  'sklad',
  'sklad',
  [{ product_id: 'p250', qty: 1, raw_name: 'Порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (sameWh.can_confirm) fail('same source and destination must block confirm');
if (!sameWh.errors.some((e) => e.code === 'same_city')) fail('same warehouse needs same_city');

const restock = applyTransferEdit(
  liveWarehouses,
  [powder250],
  new Map([['p250', 9]]),
  'office',
  'gafura',
  [{ product_id: 'p250', qty: 2, raw_name: 'Порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (restock.resolved.items[0]?.stock !== 9) fail('changing source warehouse must reread stock');
if (!restock.can_confirm) fail('unique warehouses with stock must allow confirm after pick');

const rawPick = applyTransferEdit(
  liveWarehouses,
  [powder250, powder500],
  new Map([['p250', 4]]),
  'sklad',
  'gafura',
  [{ product_id: '', qty: 1, raw_name: 'порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (rawPick.can_confirm) fail('ambiguous powder must not confirm after warehouse pick');
if (!rawPick.errors.some((e) => e.code === 'product_ambiguous')) fail('warehouse pick keeps product_ambiguous');
if ((rawPick.resolved.items[0]?.candidates || []).length < 2) fail('ambiguous powder must keep candidates');

const mergedDup = mergeTransferEditItems([
  { product_id: 'p250', qty: 2, raw_name: 'порошок' },
  { product_id: 'p250', qty: 2, raw_name: 'порошок' },
]);
if (mergedDup.length !== 1 || mergedDup[0].qty !== 4) fail('duplicate product lines must merge qty');
const dupStock = applyTransferEdit(
  liveWarehouses,
  [powder250],
  new Map([['p250', 3]]),
  'sklad',
  'gafura',
  [
    { product_id: 'p250', qty: 2, raw_name: 'порошок' },
    { product_id: 'p250', qty: 2, raw_name: 'порошок' },
  ],
  { role: 'admin', can_create_transfers: false }
);
if (dupStock.can_confirm) fail('merged duplicate qty over stock must block confirm');
if (!dupStock.errors.some((e) => e.code === 'insufficient_stock' && e.message.includes('нужно 4'))) {
  fail(`duplicate lines must check summed stock, got ${JSON.stringify(dupStock.errors)}`);
}

const zeroQty = applyTransferEdit(
  liveWarehouses,
  [powder250],
  new Map([['p250', 9]]),
  'sklad',
  'gafura',
  [{ product_id: 'p250', qty: 0, raw_name: 'Порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (zeroQty.can_confirm) fail('zero qty must not confirm');
if (!zeroQty.errors.some((e) => e.code === 'qty_invalid')) fail('zero qty needs qty_invalid');
const negQty = applyTransferEdit(
  liveWarehouses,
  [powder250],
  new Map([['p250', 9]]),
  'sklad',
  'gafura',
  [{ product_id: 'p250', qty: -1, raw_name: 'Порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (negQty.can_confirm) fail('negative qty must not confirm');
const kgOk = applyTransferEdit(
  liveWarehouses,
  [{ id: 'k1', name: 'Сырьё', unit: 'kg', price_retail: 1, is_active: true }],
  new Map([['k1', 5]]),
  'sklad',
  'gafura',
  [{ product_id: 'k1', qty: 1.25, raw_name: 'Сырьё' }],
  { role: 'admin', can_create_transfers: false }
);
if (!kgOk.can_confirm) fail(`kg 1.25 must confirm, ${JSON.stringify(kgOk.errors)}`);
const pcsFrac = applyTransferEdit(
  liveWarehouses,
  [powder250],
  new Map([['p250', 9]]),
  'sklad',
  'gafura',
  [{ product_id: 'p250', qty: 1.5, raw_name: 'Порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (pcsFrac.can_confirm) fail('fractional pcs must not confirm');
const teaCatalog = [{ id: 'tea', name: 'Чай', unit: 'pcs', price_retail: 1, is_active: true }];
if (resolveProductQuery('ұнтақ', [powder250]).chosen?.id !== 'p250') fail('ұнтақ alias must match powder');
if (resolveProductQuery('шай', teaCatalog).chosen?.id !== 'tea') fail('шай alias must match tea');

if (stockQtyForSource(null, new Map([['p1', 10]]), 'p1') !== null) fail('no stock until source warehouse is chosen');
if (stockQtyForSource('galia', new Map(), 'p1') !== 0) fail('missing inventory row is 0 only after warehouse chosen');
if (stockQtyForSource('galia', new Map([['p1', 7]]), 'p1') !== 7) fail('stock comes from chosen warehouse');
if (shouldFlagInsufficientStock(null, 2, 0)) fail('do not flag shortage while warehouse is ambiguous');
if (shouldFlagInsufficientStock('galia', 2, null)) fail('do not flag shortage without a stock reading');
if (!shouldFlagInsufficientStock('galia', 2, 0)) fail('flag shortage when chosen warehouse has 0');
if (shouldFlagInsufficientStock('galia', 2, 5)) fail('enough stock must not block');

const powder = { id: 'p1', name: 'Порошок', unit: 'pcs', price_retail: 1, is_active: true };
const tea = { id: 'p2', name: 'Чай', unit: 'pcs', price_retail: 1, is_active: true };
const afterPick = applyTransferEdit(
  almatyWarehouses,
  [powder, tea],
  new Map([
    ['p1', 10],
    ['p2', 4],
  ]),
  'galia',
  'aktau',
  [
    { product_id: 'p1', qty: 2, raw_name: 'Порошок' },
    { product_id: 'p2', qty: 1, raw_name: 'Чай' },
  ],
  { role: 'admin', can_create_transfers: false }
);
if (!afterPick.can_confirm) fail(`chosen warehouse with stock must confirm, errors=${JSON.stringify(afterPick.errors)}`);
if (afterPick.resolved.items.some((i) => i.stock == null)) fail('stock must be filled after warehouse pick');

const shortPick = applyTransferEdit(
  almatyWarehouses,
  [powder],
  new Map([['p1', 1]]),
  'office',
  'aktau',
  [{ product_id: 'p1', qty: 2, raw_name: 'Порошок' }],
  { role: 'admin', can_create_transfers: false }
);
if (shortPick.can_confirm) fail('true shortage must block confirm');
if (!shortPick.errors.some((e) => e.code === 'insufficient_stock' && e.message.includes('есть 1'))) {
  fail('true shortage must show actual remainder');
}

if (qtyValidationError(1.25, 'kg')) fail('kg 3 decimals allowed');
if (!qtyValidationError(1.2501, 'kg')) fail('kg 4 decimals blocked');
if (!qtyValidationError(1.5, 'pcs')) fail('piece qty must be integer');
if (qtyValidationError(2, 'pcs')) fail('integer pcs ok');

const sql = read('supabase/migrations/20261104220000_assistant_stock_transfers.sql');
const runSql = read('supabase/run_assistant_stock_transfers.sql');
const inspect = read('supabase/prod/pre_apply_inspect_block525.sql');
const verify = read('supabase/prod/post_apply_verify_block525.sql');
const handle = read('lib/assistant/handleTurn.ts');
const chat = read('app/api/assistant/chat/route.ts');
const confirm = read('app/api/assistant/transfers/confirm/route.ts');
const update = read('app/api/assistant/transfers/update/route.ts');
const ui = read('components/AssistantChats.tsx');
const card = read('components/AssistantTransferDraftCard.tsx');
const users = read('app/admin/users/page.tsx');
const panel = read('components/TransfersPanel.tsx');
const receiveSql = read('supabase/migrations/20261103230000_stock_transfer_partial_receive.sql');
const createOrig = read('supabase/migrations/20261103220000_stock_transfers.sql');

if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('SQL must be transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/DROP\s+(FUNCTION|TABLE|POLICY)[\s\S]{0,120}CASCADE/i.test(sql)) fail('must not DROP ... CASCADE');
if (/^\s*DROP FUNCTION/im.test(sql)) fail('must not DROP FUNCTION');
if (/CREATE OR REPLACE FUNCTION public\.receive_stock_transfer/i.test(sql)) fail('must not rewrite receive');
if (/CREATE OR REPLACE FUNCTION public\.cancel_stock_transfer/i.test(sql)) fail('must not rewrite cancel');
if (/CREATE OR REPLACE FUNCTION public\.write_off_stock_transfer_shortage/i.test(sql)) fail('must not rewrite shortage');
if (/CREATE OR REPLACE FUNCTION public\.apply_order_cancel/i.test(sql)) fail('must not touch cancel orders');
if (!sql.includes('can_create_transfers')) fail('manager create flag');
if (!sql.includes('NOT NULL DEFAULT false')) fail('flag default false');
if (!sql.includes('Transfer permission denied')) fail('direct RPC denied without flag');
if (!sql.includes('assistant_stock_transfer_drafts')) fail('draft table');
if (!sql.includes('client_operations')) fail('keep client_operations idempotency');
if (!sql.includes('pg_advisory_xact_lock')) fail('keep advisory locks');
if (!sql.includes('qty_on_hand >= v_need')) fail('must keep stock guard in create_stock_transfer');
if (!sql.includes('Source city is inactive')) fail('SQL city active check');
if (!sql.includes('Inactive product')) fail('SQL product active check');
if (!sql.includes("COALESCE(p.unit, '') IS DISTINCT FROM 'kg'")) fail('qty unit from products.unit');
if (!sql.includes('created_by = auth.uid()')) fail('manager can read own transfer');
if (!sql.includes('begin_assistant_stock_transfer_confirm')) fail('JWT begin confirm');
if (!sql.includes('GRANT ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) TO authenticated, service_role')) {
  fail('create_stock_transfer grants must match production (authenticated + service_role)');
}
if (!sql.includes("REVOKE ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon")) {
  fail('anon/public must not execute create_stock_transfer');
}
if (!sql.includes('Source city not found')) fail('keep original missing-city error');
if (!sql.includes('AND owner_id = v_uid AND status IN (\'preview\', \'blocked\')')) {
  fail('draft cancel must only touch preview/blocked, not confirming');
}

const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) fail('post verify must be SELECT-only');
if (/INSERT|UPDATE|DELETE/i.test(inspect.replace(/--.*$/gm, ''))) fail('pre inspect must be read-only');

if (!handle.includes('parseTransferIntent')) fail('turn must parse transfer');
const turnBody = handle.slice(handle.indexOf('export async function generateAssistantTurn'));
if (turnBody.indexOf('parseTransferIntent') > turnBody.indexOf('looksLikeInvoice')) {
  fail('transfer must run before invoice heuristic');
}
if (turnBody.indexOf('parseCancelIntent') > turnBody.indexOf('parseTransferIntent')) {
  fail('cancel must still run before transfer');
}
if (turnBody.indexOf('parseTransferManageIntent') > turnBody.indexOf('parseCancelIntent')) {
  fail('manage must still run before cancel');
}
if (handle.includes("rpc('create_stock_transfer'")) fail('prepare path must not create transfer');

if (!chat.includes('save_assistant_stock_transfer_draft')) fail('persist transfer draft');
if (!chat.includes('can_create_transfers')) fail('chat loads transfer flag');
if (chat.includes("rpc('create_stock_transfer'")) fail('chat must not create stock transfer');

if (!confirm.includes('createUserClient')) fail('create_stock_transfer must run as the user');
if (!confirm.includes("rpc('create_stock_transfer'")) fail('confirm calls existing RPC');
if (!confirm.includes('let body: { draftId?: string }')) fail('confirm must not accept client warehouse/product ids');
if (!confirm.includes('p_operation_id: live.idempotency_key')) fail('confirm must reuse draft idempotency key');
if (!confirm.includes('qty_on_hand') || !confirm.includes('revalidate')) {
  fail('confirm must reread stock before RPC');
}
if (!sql.includes("v_row.status <> 'preview' OR v_row.can_confirm IS NOT TRUE")) {
  fail('begin confirm must reject blocked/ambiguous drafts');
}
if (confirm.includes("service.rpc('create_stock_transfer'") || confirm.includes('service.rpc("create_stock_transfer"')) {
  fail('service_role must not call create_stock_transfer');
}
if (!confirm.includes('idempotency_key')) fail('stable operation_id');
if (!confirm.includes('client_operations')) fail('recover transfer by operation_id');
if (!confirm.includes('pending')) fail('timeout retry');
if (!confirm.includes('Недостаточно остатков')) fail('human insufficient stock');
if (confirm.includes("service.rpc('create_stock_transfer'")) fail('service_role must not create transfers');
if (!update.includes('update_assistant_stock_transfer_draft_content')) fail('edit draft');

if (!ui.includes('AssistantTransferDraftCard')) fail('transfer card in chats');
if (!ui.includes('assistant-transfer-confirm')) fail('exclusive confirm');
if (!card.includes('Подтвердить отправку')) fail('explicit confirm button');
if (!card.includes("draft.status === 'confirmed'") && !card.includes('draft.transfer_id')) {
  fail('hide after send');
}
if (!card.includes('Повторить подтверждение')) fail('network retry must remain possible while confirming');
if (!card.includes('showEditCancel')) fail('edit/cancel hidden after send and while confirming');
if (!card.includes('needFromPick')) fail('card must offer warehouse picker when source is ambiguous');
if (!card.includes('Выберите получателя')) fail('card must ask to pick destination warehouse');
if (!card.includes('Выберите отправителя')) fail('card must ask to pick source warehouse');
if (!card.includes('needProductPick')) fail('card must offer product picker when SKU is ambiguous');
if (!card.includes('!needProductPick')) fail('confirm must stay hidden while product is ambiguous');
if (!read('lib/assistant/resolveTransfer.ts').includes('найдено несколько складов')) {
  fail('ambiguous geo city must use the clarification copy');
}
if (!read('lib/assistant/transferCityMatch.ts').includes('matchTransferWarehouses')) {
  fail('warehouse matcher must live in transferCityMatch');
}
if (!update.includes('row.product_id || row.raw_name')) fail('update must keep unresolved item names after warehouse pick');
if (!card.includes('insufficient_stock')) fail('card must hide fake shortage until warehouse chosen');
if (!card.includes('!sent && sourceReady && item.stock != null')) {
  fail('confirmed transfer card must hide pre-send stock remainder');
}
if (!read('lib/assistant/resolveTransfer.ts').includes('shouldFlagInsufficientStock')) {
  fail('stock check must skip unresolved source warehouse');
}

const mapper = read('lib/stockTransfer.ts');
if (!mapper.includes('Transfer permission denied')) fail('TransfersPanel must map new permission error');
if (!mapper.includes('Source city is inactive')) fail('TransfersPanel must map inactive city');

if (!inspect.includes('pg_get_function_identity_arguments')) fail('pre inspect signatures');
if (!inspect.includes('aclexplode')) fail('pre inspect grants');
if (!inspect.includes('policyname')) fail('pg_policies column is policyname');
if (/\bpolname\b/.test(inspect) || /\bpolname\b/.test(verify)) fail('must not query pg_policies.polname');
if (!inspect.includes('check_name')) fail('preflight must be one result table');
if (!inspect.includes("'PASS'")) fail('preflight must emit PASS/FAIL');
if (!verify.includes('check_name')) fail('post verify must be one result table');
if (!verify.includes('has_function_privilege')) fail('post inspect execute privileges');
if (!verify.includes('auth_save_must_be_false')) fail('post inspect save_draft not for authenticated');
if (!verify.includes('receive_stock_transfer.admin_only')) fail('post inspect receive admin');
if (!verify.includes('trigger.blocks_can_create_transfers')) fail('post inspect privilege trigger');
if (!verify.includes('city_not_found_kept')) fail('post inspect keeps original city-not-found');
if (!verify.includes('policyname')) fail('post verify pg_policies column is policyname');
if (!users.includes('can_create_transfers')) fail('users UI flag');
if (!users.includes('Разрешить создание перемещений')) fail('users checkbox copy');

if (!createOrig.includes('format_transfer_number')) fail('T000001 lives in original transfer SQL');
if (!receiveSql.includes('Only admin can receive transfers')) fail('receive remains admin-only in original SQL');
if (panel.includes('can_create_transfers')) fail('TransfersPanel must stay unchanged for manager create flag');

console.log('check-assistant-transfers: ok');
