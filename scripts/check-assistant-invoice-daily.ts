import { readFileSync } from 'fs';
import { join } from 'path';
import { detectPayment, looksLikeInvoice, paymentLabel } from '../lib/assistant/paymentParse';
import { extractInvoiceCustomer } from '../lib/assistant/customerExtract';
import { resolveInvoiceFromCatalogs, draftChoiceHints } from '../lib/assistant/invoiceResolve';
import { sellerMatchesByPhone } from '../lib/assistant/invoiceSeller';
import {
  hasInvoiceDraftSignals,
  invoiceHeaderSellerName,
  looksLikeStockQuestion,
  mergeParsedInvoiceItems,
  parseInvoiceItemLines,
} from '../lib/assistant/invoiceLines';
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
if (!lowStock.warnings.some((e) => e.code === 'insufficient_stock')) fail('need insufficient_stock warning');
if (lowStock.resolved.items.some((i) => /шай/i.test(i.raw_name)) === false) fail('low stock must keep the tea line');
if (lowStock.can_confirm) fail('stock block confirm');

if (isAssistantRole('seller')) fail('seller has no assistant');
if (!isAssistantRole('manager') || !isAssistantRole('admin')) fail('manager/admin assistant');

const card = read('components/AssistantOrderDraftCard.tsx');
if (!card.includes('Закрыть без сохранения')) fail('cancel edit without DB write');
if (!card.includes("quickSetPayment('kaspi')")) fail('kaspi shortcut');
if (!card.includes("quickSetPayment('cash')")) fail('cash shortcut');
if (!card.includes('draftChoiceHints')) fail('choice hints');
if (!card.includes('Исходная строка')) fail('unresolved must show source line');
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
const handleTurnSrc = read('lib/assistant/handleTurn.ts');
if (!handleTurnSrc.includes('hasInvoiceDraftSignals')) fail('turn must open draft without customer phone');
if (!handleTurnSrc.includes('parseInvoiceItemLines')) fail('turn must use line items even if LLM intent=question');
const handleTurnBody = handleTurnSrc.slice(handleTurnSrc.indexOf('export async function generateAssistantTurn'));
if (handleTurnBody.indexOf('parseCancelIntent') > handleTurnBody.indexOf('hasInvoiceDraftSignals')) {
  fail('cancel must run before invoice draft');
}
if (!resolve.includes('availableQty')) fail('invoice stock must use reserved-aware available');
if (!resolve.includes('qty_reserved')) fail('invoice resolveOrder must select qty_reserved');
const invoiceResolveSrc = read('lib/assistant/invoiceResolve.ts');
if (!invoiceResolveSrc.includes('mergeLineAndLlmDraftItems')) fail('SKU-aware invoice merge');
if (!invoiceResolveSrc.includes('product_merge_ambiguous')) fail('merge-ambiguous must block confirm');
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
if (hasInvoiceDraftSignals('Айгүл\nпривет, какие остатки?')) fail('stock chat must not open a draft');
if (!looksLikeStockQuestion('Айгүл\nпривет, какие остатки?')) fail('остатки question');
if (!looksLikeStockQuestion('Сколько порошка в Астане?')) fail('stock question');
if (looksLikeInvoice('Сколько порошка в Астане?')) fail('stock question is not an invoice');
if (hasInvoiceDraftSignals('Сколько порошка в Астане?')) fail('stock question has no draft signals');
if (looksLikeStockQuestion('Айгүл\nшай 3шт\nТөленген')) fail('invoice with төленген is not a stock question');
if (invoiceHeaderSellerName('Айгүл 87771234567\n2 порошок') !== 'Айгүл') {
  fail('packed Айгүл 8777… must still be the seller');
}

const shtLines = parseInvoiceItemLines('шай 3шт\nшампунь 2 шт\n2шт драже');
if (shtLines.length !== 3) fail(`шт trio length ${shtLines.length} ${JSON.stringify(shtLines)}`);
if (!shtLines.some((i) => i.qty === 3 && /^шай$/i.test(i.name))) fail(`шай 3шт parsed ${JSON.stringify(shtLines)}`);
if (!shtLines.some((i) => i.qty === 2 && /шампунь/i.test(i.name))) fail('шампунь 2 шт');
if (!shtLines.some((i) => i.qty === 2 && /драже/i.test(i.name))) fail('2шт драже');

const unitLines = parseInvoiceItemLines(
  'шай 3штук\nшампунь 2 штуки\nдраже 2дана\nпорошок 1 pcs\nмазь 3pcs\nпластырь 2 дана'
);
if (unitLines.length !== 6) fail(`unit variants ${unitLines.length} ${JSON.stringify(unitLines)}`);
for (const [name, qty] of [
  ['шай', 3],
  ['шампунь', 2],
  ['драже', 2],
  ['порошок', 1],
  ['мазь', 3],
  ['пластырь', 2],
] as const) {
  if (!unitLines.some((i) => i.qty === qty && i.name.toLowerCase() === name)) {
    fail(`unit ${name}×${qty}: ${JSON.stringify(unitLines)}`);
  }
}

const mergedQty = mergeParsedInvoiceItems(
  [{ name: 'шай', qty: 3, is_gift: false }],
  [{ name: 'Шай', qty: 99, is_gift: false }]
);
if (mergedQty.length !== 1 || mergedQty[0].qty !== 3) fail(`same-name merge must keep line qty ${JSON.stringify(mergedQty)}`);

const mergedExtra = mergeParsedInvoiceItems(
  [{ name: 'порошок', qty: 1, is_gift: false }],
  [
    { name: 'шампунь', qty: 2, is_gift: false },
    { name: 'порошок', qty: 9, is_gift: false },
  ]
);
if (mergedExtra.length !== 2) fail(`merge extra length ${mergedExtra.length}`);
if (!mergedExtra.some((i) => /шампунь/i.test(i.name) && i.qty === 2)) fail('LLM-only line kept');
if (!mergedExtra.some((i) => /порошок/i.test(i.name) && i.qty === 1)) fail('line qty wins over LLM');

const smokeCatalog = [
  ...aigulCatalog,
];
const smokeSellers = [
  { id: 's1', display_name: 'Айгүл', city_id: 'c1' },
  { id: 's-bakyt', display_name: 'Бақыт', city_id: 'c1' },
  { id: 's-arna', display_name: 'Арна', city_id: 'c1' },
  { id: 's-gafura', display_name: 'Гафура', city_id: 'c1' },
];
const smokeStock = new Map([
  ...aigulStock,
  ['c1:p-shamp', 20],
  ['c1:p-drazhe', 20],
]);

function smokeDraft(text: string, llmItems: ParsedInvoice['items'] = [], payment_raw = 'Наличка') {
  return resolveInvoiceFromCatalogs(
    {
      intent: 'create_order',
      seller_name: '',
      city_name: '',
      customer_name: '',
      payment_raw,
      is_debt: false,
      is_preorder: false,
      pickup_date: '',
      pickup_time: '',
      note: '',
      items: llmItems,
    },
    text,
    [],
    {
      sellers: smokeSellers,
      cities,
      products: smokeCatalog,
      stockByCityProduct: smokeStock,
    }
  );
}

const prodNoCustomer = `Айгүл
шай 3шт
шампунь 2шт
драже 2шт
Төленген`;
if (!looksLikeInvoice(prodNoCustomer)) fail('prod invoice without customer must look like invoice');
if (!hasInvoiceDraftSignals(prodNoCustomer)) fail('prod invoice without customer must open draft');
const prodNoCustomerDraft = smokeDraft(prodNoCustomer, [], 'Төленген');
if (prodNoCustomerDraft.resolved.items.length !== 3) {
  fail(`prod 3 lines: ${prodNoCustomerDraft.resolved.items.map((i) => i.raw_name).join(',')}`);
}
if (!prodNoCustomerDraft.resolved.items.some((i) => i.qty === 3 && i.product_id === 'p-tea' && !i.unresolved)) {
  fail('prod tea ×3');
}
if (!prodNoCustomerDraft.resolved.items.some((i) => i.qty === 2 && i.product_id === 'p-shamp' && !i.unresolved)) {
  fail('prod shampoo ×2');
}
if (!prodNoCustomerDraft.resolved.items.some((i) => i.qty === 2 && i.product_id === 'p-drazhe' && !i.unresolved)) {
  fail('prod drazhe ×2');
}
if (prodNoCustomerDraft.can_confirm) fail('төленген without method cannot confirm');
if (!prodNoCustomerDraft.errors.some((e) => e.code === 'payment_unspecified')) fail('need payment_unspecified not stock Q&A');
if (prodNoCustomerDraft.resolved.total_sum !== 3 * 800 + 2 * 450 + 2 * 400) {
  fail(`prod total ${prodNoCustomerDraft.resolved.total_sum}`);
}

const prodTwoTea = `Айгүл
шай 2шт
шай 1шт
Төленген`;
if (!looksLikeInvoice(prodTwoTea) || !hasInvoiceDraftSignals(prodTwoTea)) fail('two tea lines must be an invoice');
const prodTwoTeaDraft = smokeDraft(
  prodTwoTea,
  [{ name: 'ШАЙ ОРГ 500г', qty: 3, is_gift: false }],
  'Төленген'
);
const prodTeaLines = prodTwoTeaDraft.resolved.items.filter((i) => i.product_id === 'p-tea');
if (prodTeaLines.length !== 2 || prodTeaLines.reduce((s, i) => s + i.qty, 0) !== 3) {
  fail(`prod two tea lines ${JSON.stringify(prodTeaLines)}`);
}
if (prodTwoTeaDraft.can_confirm) fail('two tea төленген still needs payment method');

const prodWithCustomer = `Айгүл
Айдос 87751234567
шай 3шт
шампунь 2шт
драже 2шт
Төленген`;
if (!looksLikeInvoice(prodWithCustomer)) fail('customer line still invoice');
const prodWithCustomerDraft = smokeDraft(prodWithCustomer, [], 'Төленген');
if (prodWithCustomerDraft.resolved.items.length !== 3) fail('customer invoice keeps 3 items');
if (prodWithCustomerDraft.resolved.customer_phone !== '+77751234567') {
  fail(`customer phone ${prodWithCustomerDraft.resolved.customer_phone}`);
}
if (prodWithCustomerDraft.can_confirm) fail('төленген with customer still needs Kaspi/cash');

const aigulSht = smokeDraft(`Айгүл
Анар 87071234567
Порошок 2
шай 3шт
Наличка`);
if (aigulSht.resolved.items.length !== 2) fail(`Айгүл items ${aigulSht.resolved.items.map((i) => i.raw_name).join(',')}`);
if (!aigulSht.resolved.items.some((i) => i.qty === 3 && i.product_id === 'p-tea' && !i.unresolved)) {
  fail('Айгүл шай 3шт must stay as tea ×3');
}
if (!aigulSht.resolved.items.some((i) => i.qty === 2 && i.product_id === 'p-pow')) fail('Айгүл powder ×2');
if (aigulSht.resolved.payment_type !== 'cash' || aigulSht.resolved.paid_status) fail('Айгүл наличка is cash unpaid');
if (aigulSht.resolved.total_sum !== 2 * 1000 + 3 * 800) fail(`Айгүл total ${aigulSht.resolved.total_sum}`);

const bakytSht = smokeDraft(`Бақыт
Клиент 87071111111
шампунь 2шт
Наличка`);
if (bakytSht.resolved.items.length !== 1) fail('Бақыт must keep shampoo line');
if (bakytSht.resolved.items[0].qty !== 2 || bakytSht.resolved.items[0].product_id !== 'p-shamp' || bakytSht.resolved.items[0].unresolved) {
  fail('Бақыт шампунь 2шт');
}
if (bakytSht.resolved.total_sum !== 900) fail(`Бақыт total ${bakytSht.resolved.total_sum}`);
if (bakytSht.resolved.payment_type !== 'cash') fail('Бақыт cash');

const arnaSht = smokeDraft(`Арна
Клиент 87072222222
драже 2шт
Наличка`);
if (!arnaSht.resolved.items.some((i) => i.qty === 2 && i.product_id === 'p-drazhe' && !i.unresolved)) {
  fail('Арна драже 2шт');
}
if (arnaSht.resolved.total_sum !== 800) fail(`Арна total ${arnaSht.resolved.total_sum}`);

const gafuraOk = smokeDraft(`Гафура
Клиент 87073333333
Порошок 1
Шай 1
1 Пластырь
Наличка`);
if (gafuraOk.resolved.items.length !== 3) fail(`Гафура items ${gafuraOk.resolved.items.length}`);
if (gafuraOk.resolved.total_sum !== 1000 + 800 + 500) fail(`Гафура total ${gafuraOk.resolved.total_sum}`);
if (gafuraOk.resolved.payment_type !== 'cash' || gafuraOk.resolved.paid_status) fail('Гафура cash not paid-status');
if (gafuraOk.resolved.items.some((i) => i.unresolved)) fail('Гафура all SKUs unique');

const droppedRecovered = resolveInvoiceFromCatalogs(
  {
    intent: 'create_order',
    seller_name: 'Бақыт',
    city_name: '',
    customer_name: '',
    payment_raw: 'Наличка',
    is_debt: false,
    is_preorder: false,
    pickup_date: '',
    pickup_time: '',
    note: '',
    items: [
      { name: 'порошок', qty: 1, is_gift: false },
      { name: 'шампунь', qty: 2, is_gift: false },
    ],
  },
  `Бақыт\nПорошок 1\nНаличка`,
  [],
  { sellers: smokeSellers, cities, products: smokeCatalog, stockByCityProduct: smokeStock }
);
if (!droppedRecovered.resolved.items.some((i) => i.product_id === 'p-shamp' && i.qty === 2)) {
  fail('LLM-only shampoo must not be dropped when other lines parsed');
}
if (droppedRecovered.resolved.items.filter((i) => i.product_id === 'p-pow').length !== 1) {
  fail('powder must not duplicate after LLM merge');
}

const aliasSku = smokeDraft(`Айгүл\nшай 3шт\nНаличка`, [{ name: 'ШАЙ ОРГ 500г', qty: 99, is_gift: false }]);
if (aliasSku.resolved.items.length !== 1) fail(`alias SKU merge length ${aliasSku.resolved.items.length}`);
if (aliasSku.resolved.items[0].product_id !== 'p-tea' || aliasSku.resolved.items[0].qty !== 3) {
  fail(`alias SKU must keep line qty 3, got ${JSON.stringify(aliasSku.resolved.items)}`);
}
if (aliasSku.resolved.total_sum !== 2400) fail(`alias SKU total ${aliasSku.resolved.total_sum}`);

const twoUserTea = smokeDraft(`Айгүл\nшай 2шт\nшай 1шт\nНаличка`, [
  { name: 'ШАЙ ОРГ 500г', qty: 3, is_gift: false },
]);
const twoUserTeaLines = twoUserTea.resolved.items.filter((i) => i.product_id === 'p-tea');
if (twoUserTeaLines.length !== 2) fail(`two user tea lines ${twoUserTeaLines.length}`);
if (twoUserTeaLines.reduce((s, i) => s + i.qty, 0) !== 3) fail('two user tea lines must total 3');
if (twoUserTea.warnings.some((w) => w.code === 'product_merge_ambiguous')) {
  fail('two explicit tea lines are not an LLM merge conflict');
}

const kremFilled = smokeDraft(`Айгүл\nКрем 3\nНаличка`, [
  { name: 'Крем дневной', qty: 99, is_gift: false },
]);
if (kremFilled.resolved.items.length !== 1) fail(`unique LLM SKU fill length ${kremFilled.resolved.items.length}`);
if (kremFilled.resolved.items[0].product_id !== 'p-krem1' || kremFilled.resolved.items[0].qty !== 3) {
  fail('unique LLM SKU may fill one ambiguous line but must keep line qty');
}
if (kremFilled.errors.some((e) => e.code === 'product_ambiguous')) {
  fail('unique cream SKU fill should clear product_ambiguous');
}

const kremConflict = smokeDraft(`Айгүл\nКрем 3\nНаличка`, [
  { name: 'Крем дневной', qty: 3, is_gift: false },
  { name: 'Крем ночной', qty: 3, is_gift: false },
]);
if (kremConflict.resolved.items.length !== 1) fail(`ambiguous cream must stay one line ${kremConflict.resolved.items.length}`);
if (!kremConflict.resolved.items[0].unresolved) fail('do not guess cream SKU when LLM lists both');
if (!kremConflict.warnings.some((w) => w.code === 'product_merge_ambiguous')) {
  fail('need product_merge_ambiguous when several SKUs map to one line');
}
if (kremConflict.can_confirm) fail('merge-ambiguous cream cannot confirm');

const twoPowCatalog = [
  ...smokeCatalog,
  { id: 'p-pow500', name: 'ПОРОШОК ОРГ 500г', unit: 'g', price_retail: 1500, is_active: true },
];
const twoPow = resolveInvoiceFromCatalogs(
  {
    intent: 'create_order',
    seller_name: '',
    city_name: '',
    customer_name: '',
    payment_raw: 'Наличка',
    is_debt: false,
    is_preorder: false,
    pickup_date: '',
    pickup_time: '',
    note: '',
    items: [{ name: 'ПОРОШОК ОРГ 250г', qty: 1, is_gift: false }],
  },
  `Айгүл\nПорошок 1\nПорошок 2\nНаличка`,
  [],
  { sellers: smokeSellers, cities, products: twoPowCatalog, stockByCityProduct: smokeStock }
);
if (twoPow.resolved.items.length !== 2) fail(`two powder lines ${twoPow.resolved.items.length}`);
if (twoPow.resolved.items.some((i) => !i.unresolved)) fail('do not assign one powder SKU to two unresolved lines');
if (!twoPow.warnings.some((w) => w.code === 'product_merge_ambiguous')) fail('two powder lines + one SKU is merge-ambiguous');
if (twoPow.can_confirm) fail('ambiguous powder merge cannot confirm');

const unknownKeep = smokeDraft(`Арна\nнесуществующийxyz 2шт\nНаличка`);
const unknownLine = unknownKeep.resolved.items.find((i) => /несуществующий/i.test(i.raw_name));
if (!unknownLine || !unknownLine.unresolved || unknownLine.qty !== 2) fail('unknown line must stay unresolved with source qty');
if (!unknownKeep.errors.some((e) => e.code === 'product_not_found')) fail('unknown needs correction error');
if (unknownKeep.can_confirm) fail('unknown cannot confirm');

const zeroStock = resolveInvoiceFromCatalogs(
  {
    intent: 'create_order',
    seller_name: 'Марат',
    city_name: 'Алматы',
    customer_name: '',
    payment_raw: 'нал',
    is_debt: false,
    is_preorder: false,
    pickup_date: '',
    pickup_time: '',
    note: '',
    items: [{ name: 'шай', qty: 3, is_gift: false }],
  },
  `Марат Алматы\nшай 3шт\nнал`,
  [],
  {
    sellers: otherSellers,
    cities,
    products,
    stockByCityProduct: new Map([['c2:p-tea', 0]]),
  }
);
if (!zeroStock.resolved.items.some((i) => i.product_id === 'p-tea' && i.qty === 3)) fail('zero stock keeps tea');
if (!zeroStock.warnings.some((w) => w.code === 'insufficient_stock')) fail('zero stock warning');
if (zeroStock.errors.some((e) => e.code === 'insufficient_stock')) fail('zero stock must not be a blocking error list hide');
if (zeroStock.can_confirm) fail('zero stock cannot confirm');

const reservedAvail = resolveInvoiceFromCatalogs(
  baseParsed({
    seller_name: 'Марат',
    payment_raw: 'нал',
    is_preorder: false,
    items: [{ name: 'шай', qty: 3, is_gift: false }],
  }),
  `Марат\nшай 3шт\nнал`,
  [],
  {
    sellers: otherSellers,
    cities,
    products,
    stockByCityProduct: new Map([['c2:p-tea', 1]]),
  }
);
if (!reservedAvail.warnings.some((w) => w.code === 'insufficient_stock')) {
  fail('available=1 must block sale of 3');
}
if (!reservedAvail.resolved.items.some((i) => i.product_id === 'p-tea' && i.qty === 3)) {
  fail('reserved-aware stock must keep the tea line');
}
if (reservedAvail.can_confirm) fail('available shortfall cannot confirm');

const dupLines = smokeDraft(`Айгүл\nшай 2шт\nшай 1шт\nНаличка`);
const dupTea = dupLines.resolved.items.filter((i) => i.product_id === 'p-tea');
if (dupTea.length !== 2 || dupTea.reduce((s, i) => s + i.qty, 0) !== 3) {
  fail(`duplicate tea lines ${JSON.stringify(dupTea)}`);
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
if (!parse.includes('Клиент и телефон НЕ обязательны')) fail('parse prompt customer optional');
if (!parse.includes('НЕ отвечай остатками')) fail('parse prompt must not route invoices to stock Q&A');
const lines = read('lib/assistant/invoiceLines.ts');
if (!lines.includes('invoiceHeaderSellerName')) fail('header seller extractor');
if (!lines.includes('mergeParsedInvoiceItems')) fail('keep mergeParsedInvoiceItems');
if (!lines.includes('штук(?:а|и)?')) fail('keep шт/штук unit token');
const invoiceSellerSrc = read('lib/assistant/invoiceSeller.ts');
if (!invoiceSellerSrc.includes('invoiceHeaderSellerName')) fail('seller resolve must prefer header line');
if (!parse.includes('НЕ делают предзаказ')) fail('parse prompt date is not preorder');

console.log('assistant-invoice-daily checks ok');
