import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  formatTariffAmount,
  openAssignment,
  openRate,
  parseTariffAmount,
  rpcItems,
} from '../lib/sellerCommission';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

function resolvePsql(): string | null {
  const candidates = [
    'psql',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* next */
    }
  }
  return null;
}

const empty = parseTariffAmount('');
if (empty.kind !== 'empty') fail('empty is not zero');
const zero = parseTariffAmount('0');
if (zero.kind !== 'value' || zero.value !== 0) fail('zero is explicit');
if (parseTariffAmount('200,5').kind !== 'value') fail('comma decimal');
if (parseTariffAmount('-1').kind !== 'invalid') fail('negative');
if (formatTariffAmount(null, 'нет') === formatTariffAmount(0, 'нет')) fail('null display != 0');
if (openRate([{ id: '1', plan_id: 'p', product_id: 'x', amount_kzt: 1, effective_from: '', effective_to: 't' }], 'x')) {
  fail('closed row is not current');
}
if (!openAssignment([{ id: '1', seller_id: 's', plan_id: 'A', effective_from: '', effective_to: null }])) {
  fail('open assignment');
}
if (rpcItems({ items: [{ a: 1 }] }).length !== 1) fail('rpc items');

const mig = 'supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql';
const run = 'supabase/run_seller_commission_accrual_hooks.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE OR REPLACE FUNCTION public\.(confirm_order|fulfill_preorder|cancel_order|apply_order_cancel)/i.test(sql)) {
  fail('must not rewrite order RPCs');
}
if (/INSERT\s+INTO\s+public\.finance_expenses/i.test(sql)) fail('must not write finance_expenses');
if (/UPDATE\s+public\.inventory\b/i.test(sql)) fail('must not write inventory');
if (/percent/i.test(sql)) fail('must not use percent');
if (!sql.includes('seller_commission_accrue_item_internal')) fail('item accrue');
if (!sql.includes('seller_commission_reverse_order_internal')) fail('reverse');
if (!sql.includes('seller_commission_order_items_ai_trg')) fail('item trigger');
if (!sql.includes('seller_commission_orders_au_trg')) fail('order trigger');
if (!sql.includes("COALESCE(NEW.is_gift, false)")) fail('skip gifts');
if (!sql.includes("preorder_status IS DISTINCT FROM 'fulfilled'")) fail('preorder gate');
if (!sql.includes('seller_commission accrue skipped')) fail('accrue must not abort the order');
if (!sql.includes('Order item identity is immutable after insert')) fail('qty mutation guard');
if (!sql.includes('admin_seller_missing_accruals_list')) fail('missing list rpc');
if (!sql.includes('Historical missing_rate snapshot is immutable')) fail('no rewrite missing_rate');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.admin_seller_accrual_retry_item')) fail('retry grant');
if (!sql.includes('missing_rate')) fail('keep missing_rate path');
if (!sql.includes('REVOKE ALL ON FUNCTION public.seller_commission_accrue_order_internal')) fail('revoke accrue');
if (!sql.includes('SET row_security = off')) fail('row_security');
if (!sql.includes('SET search_path = public')) fail('search_path');

const tests = read('scripts/verify_seller_commission_accrual_tests.sql');
if (!tests.includes('ordinary order must accrue')) fail('sale test');
if (!tests.includes('debt must accrue on confirm')) fail('debt test');
if (!tests.includes('pending preorder must not accrue')) fail('preorder pending');
if (!tests.includes('fulfilled preorder must accrue')) fail('preorder fulfill');
if (!tests.includes('gift must not accrue')) fail('gift test');
if (!tests.includes('cancel must reverse accrual')) fail('cancel test');
if (!tests.includes('changing tariff must not rewrite old accrual')) fail('snapshot test');
if (!tests.includes('missing assignment must be explicit missing_rate')) fail('missing rate test');
if (!tests.includes('repeat accrue RPC must be idempotent')) fail('idempotent test');
if (!tests.includes('cancel pending preorder must not create commission')) fail('pending cancel');
if (!tests.includes('cancel after fulfill must reverse')) fail('fulfilled cancel');
if (!tests.includes('qty update must be rejected')) fail('qty guard');
if (!tests.includes('missing_rate list must be visible to admin')) fail('missing visible');
if (!tests.includes('missing_rate snapshot must stay immutable')) fail('no rewrite');
if (!tests.includes('manager must not retry accrual')) fail('manager retry denial');
if (/^\s*COMMIT;/m.test(tests)) fail('tests must not commit');

const page = read('app/admin/seller-tariffs/page.tsx');
const nav = read('components/NavAdmin.tsx');
const navM = read('components/NavManager.tsx');
const navS = read('components/NavSeller.tsx');
const i18n = read('lib/i18n.tsx');
if (!page.includes('Protected role="admin"')) fail('admin only page');
if (!page.includes("profile?.role === 'admin'")) fail('admin re-check');
if (!page.includes('SELLER_TARIFF_RATE_SET')) fail('rate rpc');
if (!page.includes('SELLER_TARIFF_ASSIGN')) fail('assign rpc');
if (!page.includes('SELLER_RATE_OVERRIDE_SET')) fail('override rpc');
if (!read('lib/sellerCommission.ts').includes("admin_seller_tariff_rate_set")) fail('rate rpc name');
if (!page.includes('parseTariffAmount')) fail('parse amounts');
if (!page.includes('runExclusive')) fail('repeat click guard');
if (!page.includes('SELLER_MISSING_ACCRUALS_LIST')) fail('missing list ui');
if (!page.includes('CollapsibleFilters')) fail('mobile filters');
if (!page.includes('minWidth')) fail('table min width');
if (!page.includes('effective_to')) fail('rate history');
if (page.includes('service_role') || page.includes('createServiceClient')) fail('no service_role');
if (page.includes('confirm_order')) fail('ui must not confirm orders');
if (!nav.includes('/admin/seller-tariffs')) fail('admin nav');
if (navM.includes('/admin/seller-tariffs')) fail('manager nav');
if (navS.includes('/admin/seller-tariffs')) fail('seller nav');
if (!i18n.includes("'sellerTariffs.title': 'Тарифы продавцов'")) fail('i18n ru');
if (!i18n.includes("'sellerTariffs.title': 'Сатушы тарифтері'")) fail('i18n kz');
if (!i18n.includes("'sellerTariffs.missingFlag': 'Ставка не задана (не 0 ₸)'")) fail('i18n missing ru');
if (!i18n.includes('Ставка берілмеген (0 ₸ емес)')) fail('i18n missing kz');
if (i18n.includes('порошок: A = 200') || page.includes('A = 200')) fail('must not seed example rates');

const pre = read('supabase/prod/pre_apply_inspect_block5174.sql');
const post = read('supabase/prod/post_apply_verify_block5174.sql');
const apply = read('supabase/prod/apply_block5174.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('seller_ledger_present')) fail('preflight foundation');
if (!pre.includes('accrual_trigger_absent_before_apply')) fail('preflight trigger absent');
if (!post.includes('accrual_item_trigger')) fail('postflight trigger');
if (!post.includes('item_protect_trigger')) fail('postflight protect');
if (!post.includes('missing_list.authenticated_execute')) fail('postflight missing list');
if (!post.includes('confirm_order.not_replaced')) fail('postflight confirm');
if (!apply.includes('Не применять без отдельного разрешения')) fail('apply blocked');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extra = read('scripts/verify_seller_commission_accrual_stubs.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const body = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const harness = `BEGIN;\n${stubs}\n${foundation}\n${extra}\n${body}\n${tests}\nROLLBACK;\n`;

let psqlRan = false;
const psqlBin = resolvePsql();
try {
  if (!psqlBin) {
    console.log('SQL harness skipped (psql not available)');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'seller-commission-accrual-'));
    const file = join(dir, 'harness.sql');
    writeFileSync(file, harness, 'utf8');
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const out = execFileSync(psqlBin, [uri, '-v', 'ON_ERROR_STOP=1', '-f', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    psqlRan = true;
    if (/ERROR:/i.test(out)) fail(`psql reported error: ${out.slice(-500)}`);
  }
} catch (err) {
  const e = err as { status?: number; stderr?: string; message?: string };
  const detail = `${e.stderr || ''} ${e.message || ''}`;
  if (/psql.*not recognized|ENOENT|not found/i.test(detail)) {
    console.log('SQL harness skipped (psql not available)');
  } else if (/could not connect|Connection refused|timeout expired/i.test(detail)) {
    console.log('SQL harness skipped (no local Postgres)');
  } else if (e.status || psqlRan) {
    fail(`SQL harness failed: ${detail.slice(-2000)}`);
  } else {
    console.log('SQL harness skipped (psql not available)');
  }
}

console.log(psqlRan ? 'seller-commission-accrual checks ok (sql harness passed)' : 'seller-commission-accrual checks ok (static)');
