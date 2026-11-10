import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { asAccrualConsistency, asUnaccruedItems } from '../lib/sellerCommission';

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

const parsed = asUnaccruedItems({
  items: [
    {
      order_item_id: 'a',
      order_id: 'o',
      seller_id: 's',
      product_id: 'p',
      qty: 2,
      reason: 'hook_skip',
      retryable: true,
      status: 'unaccrued',
    },
  ],
});
if (parsed.length !== 1 || !parsed[0].retryable) fail('parse unaccrued');
const sum = asAccrualConsistency({ unaccrued_hook_skip: 2, auto_recalc: false, missing_rate: 1 });
if (!sum || sum.unaccruedHookSkip !== 2 || sum.missingRate !== 1) fail('parse summary');

const mig = 'supabase/migrations/20261110200000_seller_commission_unaccrued_detect.sql';
const run = 'supabase/run_seller_commission_unaccrued_detect.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE OR REPLACE FUNCTION public\.(confirm_order|fulfill_preorder|cancel_order)/i.test(sql)) {
  fail('must not rewrite order RPCs');
}
if (!sql.includes('RAISE WARNING')) {
  /* hooks stay in 5.17.4; this file must not reintroduce abort-on-accrual */
}
if (/EXCEPTION[\s\S]*confirm_order/i.test(sql)) fail('must not wrap confirm_order');
if (!sql.includes('admin_seller_unaccrued_items_list')) fail('unaccrued list');
if (!sql.includes('admin_seller_accrual_consistency_summary')) fail('consistency summary');
if (!sql.includes('no tariff at sale time')) fail('retry tariff guard');
if (!sql.includes('tariff was recorded after the sale')) fail('backdated retry guard');
if (!sql.includes('seller_commission_tariff_recorded_by_sale')) fail('recorded-by-sale helper');
if (!sql.includes('v_ov.created_at > p_at')) fail('override created_at check');
if (!sql.includes('auto_recalc')) fail('no auto recalc flag');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.admin_seller_unaccrued_items_list')) fail('grant list');
if (!sql.includes('SET row_security = off')) fail('row_security');
if (/INSERT\s+INTO\s+public\.seller_ledger/i.test(sql) && !sql.includes('seller_commission_accrue_item_internal')) {
  fail('must not insert ledger except via accrue');
}
if (/UPDATE\s+public\.seller_ledger/i.test(sql)) fail('must not rewrite ledger rows');
if (/UPDATE\s+public\.orders/i.test(sql)) fail('must not update orders');

const tests = read('scripts/verify_seller_commission_unaccrued_tests.sql');
if (!tests.includes('hook skip must appear in unaccrued list')) fail('hook skip test');
if (!tests.includes('retry must use sale-time rate')) fail('sale-time rate');
if (!tests.includes('retry must not use later current tariff')) fail('current tariff guard');
if (!tests.includes('retry without tariff must be refused')) fail('no tariff refuse');
if (!tests.includes('backdated tariff must not be retryable')) fail('backdated list');
if (!tests.includes('backdated retry must be refused')) fail('backdated retry');
if (!tests.includes('canceled without accrual must not be a retry candidate')) fail('cancel skip');
if (!tests.includes('gift must not appear as unaccrued')) fail('gift');
if (!tests.includes('pending preorder must not be unaccrued candidate')) fail('preorder');
if (!tests.includes('manager must not retry')) fail('manager');
if (!tests.includes('seller must not list unaccrued')) fail('seller');
if (!tests.includes('repeat retry must fail')) fail('idempotent retry');
if (/^\s*COMMIT;/m.test(tests)) fail('tests must not commit');

const page = read('app/admin/seller-tariffs/page.tsx');
const i18n = read('lib/i18n.tsx');
const lib = read('lib/sellerCommission.ts');
if (!page.includes('SELLER_UNACCRUED_ITEMS_LIST')) fail('unaccrued ui');
if (!page.includes('SELLER_ACCRUAL_CONSISTENCY')) fail('summary ui');
if (!page.includes('SELLER_MISSING_ACCRUALS_LIST')) fail('keep missing_rate ui');
if (!page.includes("runExclusive('seller-tariffs-retry'")) fail('retry exclusive');
if (!page.includes('window.confirm')) fail('retry confirm');
if (!page.includes('retryBusy')) fail('retry busy');
if (!page.includes("messageKind === 'error'")) fail('rpc error styling');
if (!page.includes('error.message')) fail('rpc error text');
if (!page.includes('retryFailed')) fail('empty retry payload');
if (!page.includes('row.retryable')) fail('retryable gate');
if (!page.includes('reasonBackdated')) fail('backdated ui');
if (page.includes('confirm_order')) fail('ui must not confirm orders');
if (!lib.includes("admin_seller_unaccrued_items_list")) fail('rpc name');
if (!i18n.includes("'sellerTariffs.unaccruedTitle': 'Сбои начисления'")) fail('i18n ru');
if (!i18n.includes("'sellerTariffs.unaccruedTitle': 'Есеп сбойлары'")) fail('i18n kz');
if (!i18n.includes('sellerTariffs.reasonHookSkip')) fail('reason i18n');
if (!i18n.includes('sellerTariffs.reasonBackdated')) fail('backdated i18n');
if (!i18n.includes('sellerTariffs.retryConfirm')) fail('confirm i18n');

const pre = read('supabase/prod/pre_apply_inspect_block5194.sql');
const post = read('supabase/prod/post_apply_verify_block5194.sql');
const apply = read('supabase/prod/apply_block5194.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('unaccrued_list_absent_before_apply')) fail('preflight absent');
if (!post.includes('unaccrued_list.present')) fail('postflight present');
if (!post.includes('recorded_by_sale.present')) fail('postflight helper');
if (!apply.includes('Не запускать этот SQL на Production без отдельного разрешения')) fail('apply blocked');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extra = read('scripts/verify_seller_commission_accrual_stubs.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const hooks = read('supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const body = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const oldTests = read('scripts/verify_seller_commission_accrual_tests.sql');
const harness = `BEGIN;\n${stubs}\n${foundation}\n${extra}\n${hooks}\n${body}\n${oldTests}\n${tests}\nROLLBACK;\n`;

const psqlBin = resolvePsql();

function runPsqlFile(uri: string, file: string): string {
  return execFileSync(psqlBin as string, [uri, '-v', 'ON_ERROR_STOP=1', '-f', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPsqlC(uri: string, sqlText: string): string {
  return execFileSync(psqlBin as string, [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sqlText], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function spawnPsqlC(uri: string, sqlText: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(psqlBin as string, [uri, '-v', 'ON_ERROR_STOP=1', '-c', sqlText], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

let psqlRan = false;
let concurrentRan = false;
let remigrateRan = false;

async function main() {
  try {
    if (!psqlBin) {
      console.log('seller-commission-unaccrued checks ok (static; psql skipped)');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'seller-commission-unaccrued-'));
    const file = join(dir, 'harness.sql');
    writeFileSync(file, harness, 'utf8');
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const out = runPsqlFile(uri, file);
    psqlRan = true;
    if (/ERROR:/i.test(out)) fail(`psql reported error: ${out.slice(-500)}`);

    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5194_audit';
    try {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    } catch {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName};`);
    }
    runPsqlC(adminUri, `CREATE DATABASE ${dbName};`);
    const auditUri = uri.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    try {
      const baseFile = join(dir, 'base.sql');
      writeFileSync(baseFile, `${stubs}\n${foundation}\n${extra}\n${hooks}\n`, 'utf8');
      runPsqlFile(auditUri, baseFile);
      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      const planId = runPsqlC(auditUri, "SELECT id FROM public.seller_tariff_plans WHERE code = 'A';");
      if (!planId) fail('plan A missing in audit db');
      runPsqlC(
        auditUri,
        `ALTER TABLE public.order_items DISABLE TRIGGER seller_commission_order_items_ai_trg;
         INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, created_at)
         VALUES ('40404040-4040-4400-8400-404040404001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','confirmed', false, now());
         INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
         VALUES ('41414141-4141-4414-8414-414141414001','40404040-4040-4400-8400-404040404001','99999999-9999-4999-8999-999999999999', 1, false);
         ALTER TABLE public.order_items ENABLE TRIGGER seller_commission_order_items_ai_trg;
         SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
         SET ROLE authenticated;
         SELECT public.admin_seller_tariff_rate_set(
           '${planId}'::uuid,
           '99999999-9999-4999-8999-999999999999',
           200,
           TIMESTAMPTZ '2026-01-01 00:00:00+00'
         );
         SELECT public.admin_seller_tariff_assign(
           'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
           '${planId}'::uuid,
           TIMESTAMPTZ '2026-01-01 00:00:00+00'
         );
         RESET ROLE;`,
      );
      const jwt =
        "SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true); SET ROLE authenticated;";
      const retrySql = `BEGIN; ${jwt} SELECT public.admin_seller_accrual_retry_item('41414141-4141-4414-8414-414141414001'); COMMIT;`;
      const [a, b] = await Promise.all([spawnPsqlC(auditUri, retrySql), spawnPsqlC(auditUri, retrySql)]);
      const texts = [a, b].map((r) => `${r.stdout}\n${r.stderr}`);
      const success = [a, b].filter((r) => r.status === 0).length;
      const already = texts.filter((t) => /already exists/i.test(t)).length;
      const count = runPsqlC(
        auditUri,
        "SELECT count(*) FROM public.seller_ledger WHERE order_item_id = '41414141-4141-4414-8414-414141414001' AND entry_type = 'accrual';",
      );
      if (count !== '1') fail(`parallel retry must leave 1 accrual, got ${count}`);
      if (!(success === 1 && already === 1) && !(success === 2 && count === '1')) {
        if (success < 1) fail(`parallel retry no success a=${texts[0].slice(-400)} b=${texts[1].slice(-400)}`);
      }
      concurrentRan = true;
    } finally {
      try {
        runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
      } catch {
        try {
          runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName};`);
        } catch {
          /* ignore */
        }
      }
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

  if (psqlRan && !remigrateRan) fail('remigrate did not run');
  if (psqlRan && !concurrentRan) fail('parallel retry did not run');
  console.log(
    psqlRan
      ? `seller-commission-unaccrued checks ok (sql harness passed; concurrent=${concurrentRan}; remigrate=${remigrateRan})`
      : 'seller-commission-unaccrued checks ok (static)',
  );
}

void main();
