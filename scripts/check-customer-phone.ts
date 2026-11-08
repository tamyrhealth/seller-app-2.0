import { isReliableCustomerPhone, normalizeCustomerPhone } from '../lib/customerPhone';
import { readFileSync } from 'fs';
import { join } from 'path';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function eq(got: string | null, want: string | null, label: string) {
  if (got !== want) fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const CANON = '+77771234567';

eq(normalizeCustomerPhone('87771234567'), CANON, '11 digits starting 8');
eq(normalizeCustomerPhone('+77771234567'), CANON, '+7 11 digits');
eq(normalizeCustomerPhone('7771234567'), CANON, '10 digits starting 7');
eq(normalizeCustomerPhone('+7 (777) 123-45-67'), CANON, 'spaces parens dashes');
eq(normalizeCustomerPhone('8 777 123 45 67'), CANON, '8 with spaces');
eq(normalizeCustomerPhone('8-777-123-45-67'), CANON, '8 with dashes');
eq(normalizeCustomerPhone('+7(777)123-45-67'), CANON, 'compact +7');
eq(normalizeCustomerPhone('  +77771234567  '), CANON, 'trimmed');
eq(normalizeCustomerPhone(CANON), CANON, 'idempotent');
eq(normalizeCustomerPhone('+77771234567'), normalizeCustomerPhone('87771234567'), '8 and +7 same person');
eq(normalizeCustomerPhone('7771234567'), normalizeCustomerPhone('+77771234567'), '10-digit national same person');

eq(normalizeCustomerPhone('77011234567'), '+77011234567', 'NDC 70');
eq(normalizeCustomerPhone('87471234567'), '+77471234567', 'NDC 74 via 8');
eq(normalizeCustomerPhone('7511234567'), '+77511234567', '10-digit NDC 75');
eq(normalizeCustomerPhone('+7 760 123 45 67'), '+77601234567', 'NDC 76');
eq(normalizeCustomerPhone('77751234567'), '+77751234567', 'NDC 775');

eq(normalizeCustomerPhone(null), null, 'null is not a customer');
eq(normalizeCustomerPhone(undefined), null, 'undefined is not a customer');
eq(normalizeCustomerPhone(''), null, 'empty');
eq(normalizeCustomerPhone('   '), null, 'whitespace');
eq(normalizeCustomerPhone('12345'), null, 'too short');
eq(normalizeCustomerPhone('777123456'), null, '9 digits');
eq(normalizeCustomerPhone('877712345678'), null, 'too long');
eq(normalizeCustomerPhone('777712345678'), null, '12 digits');
eq(normalizeCustomerPhone('8777123456'), null, '10 digits starting 8 — incomplete');
eq(normalizeCustomerPhone('91234567890'), null, '11 digits not 7/8');
eq(normalizeCustomerPhone('1234567890'), null, 'random 10 digits');
eq(normalizeCustomerPhone('1700000000'), null, 'unix-like 10 digits');
eq(normalizeCustomerPhone('7271234567'), null, 'landline-like NDC 72 after prefix');
eq(normalizeCustomerPhone('77271234567'), null, 'NDC 72 with country code');
eq(normalizeCustomerPhone('7171234567'), null, '10-digit city code 717');
eq(normalizeCustomerPhone('84951234567'), null, 'RU-like 8 495');
eq(normalizeCustomerPhone('abc87771234567'), null, 'letters');
eq(normalizeCustomerPhone('заказ 87771234567'), null, 'embedded in text');
eq(normalizeCustomerPhone('7+7771234567'), null, 'plus in the middle');
eq(normalizeCustomerPhone('++77771234567'), null, 'double plus');

const a = normalizeCustomerPhone('87771234567');
const b = normalizeCustomerPhone('87771234568');
if (!a || !b || a === b) fail('two different numbers must not merge');
if (normalizeCustomerPhone('7011234567') === normalizeCustomerPhone('7771234567')) {
  fail('different 10-digit mobiles must not merge');
}

if (isReliableCustomerPhone('7771234567') !== true) fail('reliable 10-digit');
if (isReliableCustomerPhone('') !== false) fail('empty is not reliable');
if (isReliableCustomerPhone('123') !== false) fail('short is not reliable');

const similar = readFileSync(join(process.cwd(), 'lib/similarOrders.ts'), 'utf8');
if (!similar.includes("from './customerPhone'")) fail('similar-orders must use lib/customerPhone');
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261108180000_order_customer_fields.sql'), 'utf8');
if (!sql.includes('kz_normalize_customer_phone')) fail('SQL normalize missing');
if (!sql.includes("v_ndc NOT IN ('70', '74', '75', '76', '77')")) fail('SQL NDC must match TS');
if (normalizeCustomerPhone('87771234567') !== '+77771234567') fail('TS canon');
if (normalizeCustomerPhone('+77771234567') !== normalizeCustomerPhone('7771234567')) fail('TS 8/+7/10 same');

console.log('customer-phone checks ok');
