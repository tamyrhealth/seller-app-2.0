import { extractInvoiceCustomer } from '../lib/assistant/customerExtract';
import { nameKey } from '../lib/assistant/nameFold';
import { detectPayment, extractPhones, looksLikeInvoice, paymentLabel } from '../lib/assistant/paymentParse';
import { applyCustomerToConfirmPayload } from '../lib/orderCustomer';
import { buildClientOrderFingerprint } from '../lib/orderIdempotency';
import { normalizeCustomerPhone } from '../lib/customerPhone';
import { stripIdentifiers } from '../lib/assistant/sanitize';
import { readFileSync } from 'fs';
import { join } from 'path';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const SAMPLE = `Zhanarys
Анар 87071234567
шай 1
Наличка`;

if (!looksLikeInvoice(SAMPLE)) fail('sample must look like invoice');
const customer = extractInvoiceCustomer(SAMPLE, 'Zhanarys');
if (customer.name !== 'Анар') fail(`buyer name: ${customer.name}`);
if (customer.phone !== '+77071234567') fail(`buyer phone: ${customer.phone}`);
if (nameKey(customer.name || '') === nameKey('Zhanarys')) fail('seller must not become buyer');
if (normalizeCustomerPhone('87071234567') !== '+77071234567') fail('8→+7 canon');

const split = extractInvoiceCustomer(`Zhanarys\nАнар\n87071234567\nшай 1\nнал`, 'Zhanarys');
if (split.name !== 'Анар' || split.phone !== '+77071234567') fail('name and phone on separate lines');

const sameLine = extractInvoiceCustomer('Анар 87071234567', 'Zhanarys');
if (sameLine.name !== 'Анар' || sameLine.phone !== '+77071234567') fail('name and phone on one line');

for (const raw of ['87071234567', '+77071234567', '7071234567', '8 707 123 45 67']) {
  const got = extractInvoiceCustomer(`Клиент\n${raw}\nчай 1`).phone;
  if (got !== '+77071234567') fail(`phone format ${raw} → ${got}`);
}

const cash = detectPayment(SAMPLE);
if (cash.payment_type !== 'cash' || cash.ambiguous) fail('Наличка must be cash');
if (paymentLabel('cash', false) !== 'Наличные') fail('cash label');

const cashWords = ['нал', 'наличка', 'наличные', 'налом', 'қолма-қол', 'қолма қол'];
for (const word of cashWords) {
  const got = detectPayment(`чай 1\n${word}`);
  if (got.payment_type !== 'cash') fail(`cash word ${word} → ${got.payment_type}`);
}

const transferWords = ['перевод', 'переводом', 'перевёл', 'перевел', 'аударым', 'аударды'];
for (const word of transferWords) {
  const got = detectPayment(`чай 1\n${word}`);
  if (got.payment_type !== 'transfer') fail(`transfer word ${word} → ${got.payment_type}`);
}

const kaspiWords = ['Kaspi', 'каспи', 'каспий', 'Kaspi Pay', 'каспи пэй', 'Kaspi QR', 'каспи QR', 'каспи куар', 'QR'];
for (const word of kaspiWords) {
  const got = detectPayment(`чай 1\n${word}`);
  if (got.payment_type !== 'kaspi' || got.ambiguous) fail(`kaspi word ${word} → ${JSON.stringify(got)}`);
}

const cardWords = ['карта', 'картой', 'карточка', 'банк картасы'];
for (const word of cardWords) {
  const got = detectPayment(`чай 1\n${word}`);
  if (got.payment_type !== 'card') fail(`card word ${word} → ${got.payment_type}`);
}

if (detectPayment('Kaspi Pay').payment_type !== 'kaspi') fail('Kaspi Pay maps to existing kaspi enum');
if (detectPayment('Kaspi QR').payment_type !== 'kaspi') fail('Kaspi QR maps to existing kaspi enum');
if (detectPayment('нал и kaspi').ambiguous !== true || detectPayment('нал и kaspi').payment_type !== null) {
  fail('cash+kaspi must ask, not guess');
}
if (detectPayment('на карте остатков нет порошка').payment_type === 'card') {
  fail('карта in ordinary text is not payment');
}
if (detectPayment('перевод товара на склад Астана').payment_type === 'transfer') {
  fail('warehouse transfer is not payment transfer');
}

const none = extractInvoiceCustomer('Zhanarys\nшай 1\nНаличка', 'Zhanarys');
if (none.name || none.phone) fail('old invoice without buyer stays empty');
if (detectPayment('Zhanarys\nшай 1\nНаличка').payment_type !== 'cash') fail('old invoice cash');

const debt = extractInvoiceCustomer('Анар 87071234567\nчай 1\nдолг', 'Zhanarys');
if (debt.name !== 'Анар' || debt.phone !== '+77071234567') fail('debt keeps customer');
if (detectPayment('чай 1\nв долг').is_debt !== true || detectPayment('чай 1\nв долг').payment_type !== 'debt') {
  fail('debt payment');
}
if (detectPayment('чай 1\nпредзаказ\nнал').is_preorder !== true) fail('preorder flag');
if (detectPayment('чай 1\nпредзаказ\nнал').payment_type !== 'cash') fail('preorder can still be cash');
const preorderCustomer = extractInvoiceCustomer('Анар 87071234567\nчай 1\nпредзаказ', 'Zhanarys');
if (preorderCustomer.name !== 'Анар' || preorderCustomer.phone !== '+77071234567') {
  fail('preorder keeps customer');
}

const payload: Record<string, unknown> = { items: [{ product_id: 'a', qty: 1, price: '7000' }] };
applyCustomerToConfirmPayload(payload, { isDebt: false, name: 'Анар', phone: '+77071234567' });
if (payload.customer_name !== 'Анар' || payload.customer_phone !== '+77071234567') fail('confirm payload cash customer');
if ('is_debt' in payload) fail('ordinary order is not debt');

const fp1 = buildClientOrderFingerprint({
  actorUserId: 'u',
  sellerId: 's',
  cityId: 'c',
  isPreorder: false,
  isDebt: false,
  paymentType: 'cash',
  comment: null,
  pickupDate: null,
  debtCustomerPhone: null,
  debtCustomerName: null,
  debtDueAt: null,
  debtNote: null,
  customerName: 'Анар',
  customerPhone: '+77071234567',
  items: [{ product_id: 'a', qty: 1, price: '7000' }],
});
const fp2 = buildClientOrderFingerprint({
  actorUserId: 'u',
  sellerId: 's',
  cityId: 'c',
  isPreorder: false,
  isDebt: false,
  paymentType: 'cash',
  comment: null,
  pickupDate: null,
  debtCustomerPhone: null,
  debtCustomerName: null,
  debtDueAt: null,
  debtNote: null,
  customerName: 'Анар',
  customerPhone: '+77071234567',
  items: [{ product_id: 'a', qty: 1, price: '7000' }],
});
if (fp1 !== fp2) fail('repeat confirm same customer fingerprint');

const phones = extractPhones(SAMPLE);
if (phones[0] !== '+77071234567') fail(`extractPhones canon ${phones[0]}`);
const packed = extractPhones(`Айгүл 87771234567\n2 порошок\nШай 3`);
if (packed[0] !== '+77771234567') fail(`extractPhones must not swallow next line: ${packed[0]}`);
const maskedPacked = stripIdentifiers(`Айгүл 87771234567\n2 порошок`);
if (maskedPacked.includes('87771234567')) fail('packed phone must be masked');
if (!maskedPacked.includes('2 порошок')) fail('mask must keep product qty on the next line');

const parse = read('lib/assistant/invoiceParse.ts');
if (!parse.includes('customer_name')) fail('AI schema must extract customer_name');
if (/customer_phone/.test(parse) && parse.includes("customer_phone: {")) fail('AI schema must not take phones');
const card = read('components/AssistantOrderDraftCard.tsx');
if (!card.includes('preview.customer_name') && !card.includes('Клиент')) fail('card must show customer');
const resolve = read('lib/assistant/resolveOrder.ts');
if (!resolve.includes('extractInvoiceCustomer')) fail('resolve must use deterministic customer extract');
if (!resolve.includes('payment_ambiguous')) fail('ambiguous payment must block guess');
const tools = read('lib/assistant/tools.ts');
if (/customer_phone|debt_customer_phone/.test(tools)) fail('tools must not expose phones');

console.log('assistant-customer-payment checks ok');
