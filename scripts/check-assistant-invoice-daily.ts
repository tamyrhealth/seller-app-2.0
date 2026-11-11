import { readFileSync } from 'fs';
import { join } from 'path';
import { detectPayment, looksLikeInvoice, paymentLabel } from '../lib/assistant/paymentParse';
import { extractInvoiceCustomer } from '../lib/assistant/customerExtract';
import { resolveInvoiceFromCatalogs, draftChoiceHints } from '../lib/assistant/invoiceResolve';
import { sellerMatchesByPhone } from '../lib/assistant/invoiceSeller';
import { invoiceHeaderSellerName, parseInvoiceItemLines } from '../lib/assistant/invoiceLines';
import { resolveProductQuery } from '../lib/assistant/productAliases';
import { isAssistantRole } from '../lib/roles';
import type { ParsedInvoice } from '../lib/assistant/invoiceParse';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const SAMPLE = `Айгүл 87771234567
2 порошок
Шай 3
09.11.2026
13:45
Төленген`;

function baseParsed(over: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    intent: 'create_order',
    seller_name: '',
    city_name: '',
    customer_name: 'Айгүл',
    payment_raw: 'Төленген',
    is_debt: false,
    is_preorder: true,
    pickup_date: '09.11.2026',
    pickup_time: '13:45',
    note: '',
    items: [
      { name: 'порошок', qty: 2, is_gift: false },
      { name: 'Шай', qty: 3, is_gift: false },
    ],
    ...over,
  };
}

const cities = [
  { id: 'c1', name: 'Астана' },
  { id: 'c2', name: 'Алматы' },
];
const uniqueSellers = [{ id: 's1', display_name: 'Айгүл', city_id: 'c1' }];
const twinSellers = [
  { id: 's1', display_name: 'Айгүл', city_id: 'c1' },
  { id: 's3', display_name: 'Айгуль', city_id: 'c2' },
];
const otherSellers = [
  { id: 's2', display_name: 'Марат', city_id: 'c2' },
  { id: 's4', display_name: 'Zhanarys', city_id: 'c1' },
];
const products = [
  { id: 'p-tea', name: 'ШАЙ ОРГ 500г', unit: 'g', price_retail: 800, is_active: true },
  { id: 'p-pow', name: 'ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 1000, is_active: true },
  { id: 'p-shiki', name: 'ШИКІ ПОРОШОК ОРГ 250г', unit: 'g', price_retail: 1100, is_active: true },
];
const stockOk = new Map([
  ['c1:p-tea', 20],
  ['c1:p-pow', 20],
  ['c2:p-tea', 20],
  ['c2:p-pow', 20],
]);

if (!looksLikeInvoice(SAMPLE)) fail('sample looks like invoice');

const payWords: Array<[string, string | null, string | boolean]> = [
  ['Төленген', null, 'paid'],
  ['Оплачено', null, 'paid'],
  ['Kaspi', 'kaspi', 'kaspi'],
  ['Каспи', 'kaspi', 'kaspi'],
  ['Наличные', 'cash', 'cash'],
  ['Қолма-қол', 'cash', 'cash'],
  ['Қарыз', 'debt', 'debt'],
  ['Долг', 'debt', 'debt'],
  ['Не оплачено', null, 'unpaid'],
];
for (const [word, type, extra] of payWords) {
  const got = detectPayment(`чай 1\n${word}`);
  if (extra === 'paid') {
    if (got.payment_type !== null || got.paid_status !== 'paid' || !got.paid_unspecified) {
      fail(`${word} must be paid without method: ${JSON.stringify(got)}`);
    }
  } else if (extra === 'unpaid') {
    if (got.paid_status !== 'unpaid' || got.payment_type !== null) fail(`${word} unpaid: ${JSON.stringify(got)}`);
  } else if (extra === 'debt') {
    if (!got.is_debt || got.payment_type !== 'debt') fail(`${word} debt: ${JSON.stringify(got)}`);
  } else if (got.payment_type !== type) {
    fail(`${word} → ${got.payment_type}`);
  }
}
if (detectPayment('Төленген').payment_type === 'kaspi') fail('төленген must not become kaspi');
if (paymentLabel(null, false, 'paid').includes('Kaspi') === false) fail('paid label must mention Kaspi/cash choice');

const customer = extractInvoiceCustomer(SAMPLE, 'Айгүл');
if (customer.phone !== '+77771234567') fail(`customer phone ${customer.phone}`);
if (sellerMatchesByPhone(customer.phone || '', uniqueSellers).length) {
  fail('customer phone must not match a seller');
}

const sampleDraft = resolveInvoiceFromCatalogs(baseParsed(), SAMPLE, [customer.phone || ''], {
  sellers: uniqueSellers,
  cities,
  products,
  stockByCityProduct: stockOk,
});
if (sampleDraft.resolved.is_preorder) fail('date/time must not become preorder');
if (sampleDraft.resolved.invoice_date !== '2026-11-09') fail(`invoice date ${sampleDraft.resolved.invoice_date}`);
if (sampleDraft.resolved.invoice_time !== '13:45') fail(`invoice time ${sampleDraft.resolved.invoice_time}`);
if (sampleDraft.resolved.seller_id !== 's1') fail('unique Айгүл must map to seller');
if (sampleDraft.resolved.city_id !== 'c1') fail('seller city must fill');
if (sampleDraft.resolved.payment_type) fail('төленген must not invent payment method');
if (sampleDraft.resolved.paid_status !== 'paid') fail('paid status');
if (sampleDraft.can_confirm) fail('cannot confirm without payment method');
if (!sampleDraft.errors.some((e) => e.code === 'payment_unspecified')) fail('need payment_unspecified');
if (sampleDraft.resolved.items.some((i) => i.unresolved)) fail('sample products must resolve uniquely');
if (sampleDraft.resolved.customer_phone !== '+77771234567') fail('keep customer phone');
const hints = draftChoiceHints(sampleDraft.errors);
if (!hints.some((h) => /Kaspi|налич/i.test(h))) fail('hints must ask for Kaspi/cash');

const completeText = `Марат Алматы
Анар 87071234567
1 шай
Kaspi`;
const complete = resolveInvoiceFromCatalogs(
  baseParsed({
    seller_name: 'Марат',
    city_name: 'Алматы',
    customer_name: 'Анар',
    payment_raw: 'Kaspi',
    is_preorder: false,
    pickup_date: '',
    pickup_time: '',
    items: [{ name: 'шай', qty: 1, is_gift: false }],
  }),
  completeText,
  ['+77071234567'],
  {
    sellers: otherSellers,
    cities,
    products,
    stockByCityProduct: stockOk,
  }
);
if (!complete.can_confirm) fail(`full invoice should confirm: ${complete.errors.map((e) => e.code).join(',')}`);
if (complete.resolved.payment_type !== 'kaspi') fail('kaspi method');
if (complete.resolved.seller_id !== 's2') fail('Марат seller');

const noSeller = resolveInvoiceFromCatalogs(baseParsed({ seller_name: '' }), SAMPLE, ['+77771234567'], {
  sellers: otherSellers,
  cities,
  products,
  stockByCityProduct: stockOk,
});
if (noSeller.resolved.seller_id) fail('must not invent seller from customer name');
if (!noSeller.errors.some((e) => e.code === 'seller_missing' || e.code === 'seller_not_found')) {
  fail('need seller_missing or seller_not_found');
}
if (noSeller.can_confirm) fail('no seller cannot confirm');

const twins = resolveInvoiceFromCatalogs(baseParsed({ seller_name: '' }), SAMPLE, ['+77771234567'], {
  sellers: twinSellers,
  cities,
  products,
  stockByCityProduct: stockOk,
});
if (twins.resolved.seller_id) fail('two Айгүл must not auto-pick');
if (!twins.errors.some((e) => e.code === 'seller_ambiguous')) fail('need seller_ambiguous');

const noPay = resolveInvoiceFromCatalogs(
  baseParsed({ payment_raw: '', is_preorder: false }),
  `Марат\n1 шай`,
  [],
  {
    sellers: otherSellers,
    cities,
    products,
    stockByCityProduct: stockOk,
  }
);
if (!noPay.errors.some((e) => e.code === 'payment_missing')) fail('missing method');
if (noPay.resolved.payment_type) fail('must not invent kaspi');

const ambCatalog = [
  ...products,
  { id: 'p-pow500', name: 'ПОРОШОК ОРГ 500г', unit: 'g', price_retail: 1500, is_active: true },
];
const amb = resolveProductQuery('порошок орг', ambCatalog);
if (amb.chosen) fail('two powder SKUs must not auto-pick');
if (amb.candidates.length < 2) fail('must offer SKU picker');

const inflect = resolveProductQuery('порошка', products);
if (inflect.chosen?.id !== 'p-pow') fail(`порошка → ${inflect.chosen?.name || inflect.reason}`);
const teaInflect = resolveProductQuery('чая', products);
if (teaInflect.chosen?.id !== 'p-tea') fail(`чая → ${teaInflect.chosen?.name || teaInflect.reason}`);

const missing = resolveProductQuery('несуществующий xyz', products);
if (missing.chosen || missing.candidates.length) fail('unknown product stays unresolved');

const lowStock = resolveInvoiceFromCatalogs(
  baseParsed({
    seller_name: 'Марат',
    payment_raw: 'нал',
    is_preorder: false,
    items: [{ name: 'шай', qty: 5, is_gift: false }],
  }),
  `Марат\n5 шай\nнал`,
  [],
  {
    sellers: otherSellers,
    cities,
    products,
    stockByCityProduct: new Map([['c2:p-tea', 1]]),
  }
);
if (!lowStock.errors.some((e) => e.code === 'insufficient_stock')) fail('need insufficient_stock');
if (lowStock.can_confirm) fail('stock block confirm');

if (isAssistantRole('seller')) fail('seller has no assistant');
if (!isAssistantRole('manager') || !isAssistantRole('admin')) fail('manager/admin assistant');

const card = read('components/AssistantOrderDraftCard.tsx');
if (!card.includes('Закрыть без сохранения')) fail('cancel edit without DB write');
if (!card.includes("quickSetPayment('kaspi')")) fail('kaspi shortcut');
if (!card.includes("quickSetPayment('cash')")) fail('cash shortcut');
if (!card.includes('draftChoiceHints')) fail('choice hints');
if (!card.includes('lookupSimilarOrders')) fail('similar lookup');
if (!card.includes('draft.can_confirm')) fail('prefetch similar after fields filled');
if (!card.includes('setEditing(false)') && !card.includes('closeEditWithoutSave')) fail('close edit');
if (card.includes("rpc('confirm_order'")) fail('card must not confirm via rpc');

const confirm = read('app/api/assistant/orders/confirm/route.ts');
if (!confirm.includes('idempotency_key')) fail('confirm idempotency');
if (!confirm.includes('revalidateResolved')) fail('double-stock guard via revalidate');
if (!confirm.includes("rpc('confirm_order'")) fail('confirm_order stays user JWT');

const chat = read('app/api/assistant/chat/route.ts');
if (!chat.includes('isAssistantRole')) fail('chat role guard');
if (!chat.includes('is_active === false')) fail('inactive denied');
if (!chat.includes("Продавец не имеет доступа")) fail('seller 403 copy');

const cancelRoute = read('app/api/assistant/orders/cancel/route.ts');
if (!cancelRoute.includes('cancel_assistant_order_draft')) fail('draft cancel RPC');
if (cancelRoute.includes("rpc('confirm_order'")) fail('draft cancel must not write orders');

const resolve = read('lib/assistant/resolveOrder.ts');
if (!resolve.includes('resolveInvoiceFromCatalogs')) fail('catalog resolve');
const AIGUL_INVOICE = `Айгүл
Анар 87071234567
Порошок 1
Шай 1
1 Пластырь
1 мазь
2 шампунь
Крем 3
Драже 2
Наличка`;

const aigulCatalog = [
  ...products,
  { id: 'p-plaster', name: 'ПЛАСТЫРЬ 50шт', unit: 'pcs', price_retail: 500, is_active: true },
  { id: 'p-maz', name: 'МАЗЬ', unit: 'pcs', price_retail: 300, is_active: true },
  { id: 'p-shamp', name: 'ШАМПУНЬ', unit: 'pcs', price_retail: 450, is_active: true },
  { id: 'p-krem1', name: 'Крем дневной', unit: 'pcs', price_retail: 200, is_active: true },
  { id: 'p-krem2', name: 'Крем ночной', unit: 'pcs', price_retail: 210, is_active: true },
  { id: 'p-drazhe', name: 'ДРАЖЕ 250г', unit: 'g', price_retail: 400, is_active: true },
];
const aigulStock = new Map([
  ...stockOk,
  ['c1:p-plaster', 20],
  ['c1:p-maz', 20],
  ['c1:p-shamp', 20],
  ['c1:p-krem1', 20],
  ['c1:p-krem2', 20],
  ['c1:p-drazhe', 20],
]);

const aigulEmptyAi: ParsedInvoice = {
  intent: 'create_order',
  seller_name: '',
  city_name: '',
  customer_name: 'Анар',
  payment_raw: 'Наличка',
  is_debt: false,
  is_preorder: false,
  pickup_date: '',
  pickup_time: '',
  note: '',
  items: [],
};

const aigulDraft = resolveInvoiceFromCatalogs(aigulEmptyAi, AIGUL_INVOICE, ['+77071234567'], {
  sellers: uniqueSellers,
  cities,
  products: aigulCatalog,
  stockByCityProduct: aigulStock,
});
if (aigulDraft.resolved.seller_id !== 's1') fail(`Айгүл must resolve as seller, got ${aigulDraft.resolved.seller_name}`);
if (aigulDraft.resolved.city_id !== 'c1') fail('unique seller city must fill');
if (aigulDraft.resolved.customer_name !== 'Анар') fail(`customer ${aigulDraft.resolved.customer_name}`);
if (aigulDraft.resolved.payment_type !== 'cash') fail('Наличка is cash');
if (aigulDraft.resolved.paid_status) fail('Наличка must not mark the order paid');
const aigulNames = aigulDraft.resolved.items.map((i) => `${i.raw_name}:${i.qty}`).sort().join(',');
if (!aigulNames.includes('Порошок:1') && !aigulNames.includes('порошок:1')) {
  if (!aigulDraft.resolved.items.some((i) => i.qty === 1 && /порошок/i.test(i.raw_name))) {
    fail(`qty/name lines: ${aigulNames}`);
  }
}
if (!aigulDraft.resolved.items.some((i) => i.qty === 1 && /пластыр/i.test(i.raw_name))) fail('qty-before plaster');
if (!aigulDraft.resolved.items.some((i) => i.qty === 2 && /шампун/i.test(i.raw_name))) fail('qty-before shampoo');
if (!aigulDraft.resolved.items.some((i) => i.qty === 3 && /крем/i.test(i.raw_name))) fail('qty-after cream');
const kremLine = aigulDraft.resolved.items.find((i) => /крем/i.test(i.raw_name));
if (!kremLine?.unresolved) fail('крем must stay ambiguous when several SKUs exist');
if ((kremLine?.candidates?.length || 0) < 2) fail('крем must offer SKU choices');
if (aigulDraft.can_confirm) fail('must not confirm while cream SKU is ambiguous');
if (!aigulDraft.errors.some((e) => e.code === 'product_ambiguous')) fail('need product_ambiguous for крем');
const shamp = aigulDraft.resolved.items.find((i) => /шампун/i.test(i.raw_name));
if (shamp?.unresolved || shamp?.product_id !== 'p-shamp') fail('unique shampoo must auto-pick');

const polluted = resolveInvoiceFromCatalogs(aigulEmptyAi, AIGUL_INVOICE, ['+77071234567'], {
  sellers: [
    { id: 's1', display_name: 'Айгүл', city_id: 'c1' },
    { id: 's5', display_name: 'Анар', city_id: 'c2' },
  ],
  cities,
  products: aigulCatalog,
  stockByCityProduct: aigulStock,
});
if (polluted.resolved.seller_id !== 's1') fail('customer Анар must not override seller Айгүл');

const aigulTwins = resolveInvoiceFromCatalogs(aigulEmptyAi, AIGUL_INVOICE, ['+77071234567'], {
  sellers: twinSellers,
  cities,
  products: aigulCatalog,
  stockByCityProduct: aigulStock,
});
if (aigulTwins.resolved.seller_id) fail('two Айгүл must not auto-pick');
if (!aigulTwins.errors.some((e) => e.code === 'seller_ambiguous')) fail('need seller_ambiguous for two Айгүл');
if (aigulTwins.resolved.city_id) fail('must not guess city when sellers are ambiguous');

const oneKrem = resolveInvoiceFromCatalogs(aigulEmptyAi, AIGUL_INVOICE, ['+77071234567'], {
  sellers: uniqueSellers,
  cities,
  products: aigulCatalog.filter((p) => p.id !== 'p-krem2'),
  stockByCityProduct: aigulStock,
});
const oneKremLine = oneKrem.resolved.items.find((i) => /крем/i.test(i.raw_name));
if (oneKremLine?.product_id !== 'p-krem1' || oneKremLine.unresolved) fail('single cream SKU must auto-pick');

if (invoiceHeaderSellerName('Айгүл\nпривет, какие остатки?')) {
  fail('first line must not become a seller outside an invoice');
}
if (looksLikeInvoice('Айгүл\nпривет, какие остатки?')) fail('chat question is not an invoice');
if (invoiceHeaderSellerName('Айгүл 87771234567\n2 порошок') !== 'Айгүл') {
  fail('packed Айгүл 8777… must still be the seller');
}
if (!parseInvoiceItemLines(SAMPLE).some((i) => i.qty === 2 && /порошок/i.test(i.name))) {
  fail('packed invoice qty-first lines must parse');
}

const updateRoute = read('app/api/assistant/orders/update/route.ts');
if (updateRoute.includes('parseInvoiceItemLines') || updateRoute.includes('invoiceHeaderSellerName')) {
  fail('card save must not re-parse the original invoice text');
}
if (!updateRoute.includes('applyDraftEdit') || !updateRoute.includes('qty: Number(row.qty)')) {
  fail('card save must keep edited qty');
}
if (!updateRoute.includes('payment_type')) fail('card save must keep edited payment');
if (updateRoute.includes("rpc('confirm_order'")) fail('update must not confirm');

if (resolve.includes('parsed.is_preorder === true || keywords.is_preorder')) {
  fail('must not trust LLM preorder from a date');
}

const parse = read('lib/assistant/invoiceParse.ts');
if (!parse.includes('это НЕ Kaspi')) fail('parse prompt paid vs method');
if (!parse.includes('qty может стоять до или после')) fail('parse prompt qty both sides');
const lines = read('lib/assistant/invoiceLines.ts');
if (!lines.includes('invoiceHeaderSellerName')) fail('header seller extractor');
const invoiceSellerSrc = read('lib/assistant/invoiceSeller.ts');
if (!invoiceSellerSrc.includes('invoiceHeaderSellerName')) fail('seller resolve must prefer header line');
if (!parse.includes('НЕ делают предзаказ')) fail('parse prompt date is not preorder');

console.log('assistant-invoice-daily checks ok');
