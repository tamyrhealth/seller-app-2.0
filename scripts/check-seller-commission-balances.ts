import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  asSellerBalance,
  cashHistoryToTimestamp,
  cashOperationTimestamp,
  parseCashAmount,
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

const psqlBin = resolvePsql();

function runPsqlFile(uri: string, file: string): string {
  return execFileSync(psqlBin as string, [uri, '-v', 'ON_ERROR_STOP=1', '-f', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPsqlC(uri: string, sql: string): string {
  return execFileSync(psqlBin as string, [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function spawnPsqlC(uri: string, sql: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(psqlBin as string, [uri, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      windowsHide: true,
    });
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

if (parseCashAmount('').kind !== 'empty') fail('empty cash');
if (parseCashAmount('0').kind !== 'invalid') fail('zero cash invalid');
if (parseCashAmount('-1').kind !== 'invalid') fail('negative cash');
if (parseCashAmount('10,5').kind !== 'value') fail('comma cash');
if (cashOperationTimestamp('2026-04-01') !== '2026-04-01T00:00:00+05:00') fail('cash ts');
if (cashHistoryToTimestamp('2026-04-01') !== '2026-04-01T23:59:59.999+05:00') fail('history to ts');
if (!(cashHistoryToTimestamp('2026-04-01') > cashOperationTimestamp('2026-04-01'))) fail('history covers the day');
const sample = asSellerBalance({
  seller_id: 's',
  accrued: 1,
  reversed: -1,
  paid: 2,
  advances: 3,
  goods: 0,
  adjustments: 4,
  balance: 5,
});
if (!sample || sample.balance !== 5 || sample.paid !== 2) fail('asSellerBalance');
if (rpcItems({ items: [1] }).length !== 1) fail('rpc items');

const mig = 'supabase/migrations/20261110120000_seller_commission_balance_rpcs.sql';
const run = 'supabase/run_seller_commission_balance_rpcs.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE TABLE/i.test(sql)) fail('must not create tables');
if (/CREATE OR REPLACE FUNCTION public\.(confirm_order|fulfill_preorder|cancel_order)/i.test(sql)) {
  fail('must not rewrite order RPCs');
}
if (/INSERT\s+INTO\s+public\.finance_expenses/i.test(sql)) fail('must not write finance_expenses');
if (!sql.includes('admin_seller_balances_list')) fail('list rpc');
if (!sql.includes("'accrued'")) fail('accrued key');
if (!sql.includes("'reversed'")) fail('reversed key');
if (!sql.includes("'paid'")) fail('paid key');
if (!sql.includes("'advances'")) fail('advances key');
if (!sql.includes("'goods'")) fail('goods key');
if (!sql.includes("'adjustments'")) fail('adjustments key');
if (!sql.includes("'balance'")) fail('balance key');
if (!sql.includes('DROP FUNCTION IF EXISTS public.admin_seller_cash_payout(uuid, uuid, numeric, text)')) {
  fail('drop old 4-arg payout');
}
if (!sql.includes('p_accrued_at timestamptz')) fail('operation date param');
if (!sql.includes('Operation date cannot be in the future')) fail('future date guard');
if (!sql.includes('pg_advisory_xact_lock(51730312')) fail('seller lock');
if (!sql.includes('pg_advisory_xact_lock(51730311')) fail('operation lock');
if (!sql.includes('SET row_security = off')) fail('row_security');
if (!sql.includes('SET search_path = public')) fail('search_path');
if (!sql.includes('REVOKE ALL ON FUNCTION public.admin_seller_cash_post')) fail('revoke cash_post');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.admin_seller_balances_list() TO authenticated')) {
  fail('grant list');
}

const tests = read('scripts/verify_seller_commission_balances_tests.sql');
if (!tests.includes('balance key must remain')) fail('compat key test');
if (!tests.includes('inactive seller must be listed')) fail('inactive list');
if (!tests.includes('operation date must be accrued_at')) fail('date stored');
if (!tests.includes('same payload must be idempotent')) fail('idempotent');
if (!tests.includes('different date must fail')) fail('date idempotency');
if (!tests.includes('future date must fail')) fail('future test');
if (!tests.includes('advance must allow negative balance')) fail('advance test');
if (!tests.includes('later accrual must reduce negative balance')) fail('repay test');
if (!tests.includes('manager must not create payout')) fail('manager payout');
if (!tests.includes('seller must not list all balances')) fail('seller list deny');
if (!tests.includes('must not write finance_expenses')) fail('pnl isolation');
if (!tests.includes('cash_payout must have exactly one overload')) fail('overload test');
if (!tests.includes('breakdown must equal balance')) fail('math test');
if (!tests.includes('history filter must not change all-time balance')) fail('history vs balance');
if (!tests.includes('four-arg')) fail('4-arg call');
if (!tests.includes('inactive admin must not create payout')) fail('inactive admin');
if (/^\s*COMMIT;/m.test(tests)) fail('tests must not commit');

const adminPage = read('app/admin/seller-balances/page.tsx');
const managerPage = read('app/manager/seller-balances/page.tsx');
const sellerPage = read('app/seller/balance/page.tsx');
const view = read('components/SellerBalancesView.tsx');
const nav = read('components/NavAdmin.tsx');
const navM = read('components/NavManager.tsx');
const navS = read('components/NavSeller.tsx');
const i18n = read('lib/i18n.tsx');
if (!adminPage.includes('Protected role="admin"')) fail('admin protected');
if (!adminPage.includes('canMutate={isAdmin}')) fail('admin mutate guard');
if (!managerPage.includes('Protected role="manager"')) fail('manager protected');
if (!managerPage.includes('canMutate={false}')) fail('manager read only');
if (managerPage.includes('SELLER_CASH_PAYOUT') || managerPage.includes('SELLER_CASH_ADVANCE')) {
  fail('manager page must not call cash rpc');
}
if (!sellerPage.includes('Protected role="seller"')) fail('seller protected');
if (!sellerPage.includes('SELLER_MY_BALANCE')) fail('seller self balance');
if (sellerPage.includes('SELLER_BALANCES_LIST') || sellerPage.includes('SELLER_CASH_PAYOUT')) {
  fail('seller must not use staff/cash rpc');
}
if (!sellerPage.includes('cashHistoryToTimestamp')) fail('seller history end of day');
if (!view.includes('runExclusive')) fail('repeat click');
if (!view.includes('cashHistoryToTimestamp')) fail('history end of day');
if (!view.includes('historyHint')) fail('history vs balance hint');
if (!adminPage.includes('overflow-x-hidden')) fail('admin overflow');
if (!managerPage.includes('overflow-x-hidden')) fail('manager overflow');
if (!sellerPage.includes('overflow-x-hidden')) fail('seller overflow');
if (!i18n.includes("'sellerBalances.historyHint': 'История за выбранные даты")) fail('i18n history ru');
if (!view.includes('newClientOperationId')) fail('operation id');
if (!view.includes('lg:hidden')) fail('mobile cards');
if (!view.includes('TableScroll')) fail('table scroll');
if (!view.includes('advanceOk')) fail('advance confirm');
if (!nav.includes('/admin/seller-balances')) fail('admin nav');
if (!navM.includes('/manager/seller-balances')) fail('manager nav');
if (!navS.includes('/seller/balance')) fail('seller nav');
if (navS.includes('/admin/seller-balances')) fail('seller admin nav');
if (!i18n.includes("'sellerBalances.title': 'Балансы и выплаты продавцам'")) fail('i18n ru');
if (!i18n.includes("'sellerBalances.title': 'Сатушы баланстары мен төлемдері'")) fail('i18n kz');

const pre = read('supabase/prod/pre_apply_inspect_block5175.sql');
const post = read('supabase/prod/post_apply_verify_block5175.sql');
const apply = read('supabase/prod/apply_block5175.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('balances_list_absent_before_apply')) fail('preflight list absent');
if (!post.includes('cash_payout.5arg')) fail('postflight 5arg');
if (!post.includes('cash_payout.overload_count')) fail('postflight overload');
if (!post.includes('cash_post.authenticated_execute')) fail('postflight cash_post');
if (!apply.includes('Не запускать этот SQL повторно на Production')) fail('apply blocked');
if (!apply.includes('run_seller_commission_balance_rpcs.sql')) fail('apply runner');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extraAccrual = read('scripts/verify_seller_commission_accrual_stubs.sql');
const extraBal = read('scripts/verify_seller_commission_balances_stubs.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const accrual = read('supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const body = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const harness = `BEGIN;\n${stubs}\n${foundation}\n${extraAccrual}\n${accrual}\n${extraBal}\n${body}\n${tests}\nROLLBACK;\n`;
if (!harness.includes('ROLLBACK;')) fail('harness rollback');

const adminJwtSql = [
  "SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false);",
  'SET ROLE authenticated;',
].join(' ');

let psqlRan = false;
let concurrentRan = false;
let remigrateRan = false;
let rollbackRan = false;

async function main() {
  try {
    if (!psqlBin) {
      console.log('SQL harness skipped (psql not available)');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'seller-commission-bal-'));
    const file = join(dir, 'harness.sql');
    writeFileSync(file, harness, 'utf8');
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const out = runPsqlFile(uri, file);
    psqlRan = true;
    if (/ERROR:/i.test(out)) fail(`psql reported error: ${out.slice(-500)}`);

    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5175b_audit';
    try {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    } catch {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName};`);
    }
    runPsqlC(adminUri, `CREATE DATABASE ${dbName};`);
    const auditUri = uri.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    try {
      const baseFile = join(dir, 'base.sql');
      writeFileSync(
        baseFile,
        `${stubs}\n${read('supabase/migrations/20261109010000_seller_commission_foundation.sql')}\n${extraAccrual}\n${read(
          'supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql',
        )}\n${extraBal}\n`,
        'utf8',
      );
      runPsqlFile(auditUri, baseFile);

      const rollbackFile = join(dir, 'rollback.sql');
      writeFileSync(
        rollbackFile,
        `BEGIN;\n${body}\nDO $$ BEGIN RAISE EXCEPTION 'rollback_probe'; END $$;\nROLLBACK;\n`,
        'utf8',
      );
      try {
        runPsqlFile(auditUri, rollbackFile);
        fail('rollback probe must raise');
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const detail = `${e.stderr || ''} ${e.message || ''}`;
        if (!/rollback_probe/i.test(detail)) fail(`rollback probe unexpected: ${detail.slice(-800)}`);
      }
      const listLeft = runPsqlC(
        auditUri,
        "SELECT COALESCE(to_regprocedure('public.admin_seller_balances_list()')::text, 'absent');",
      );
      if (listLeft !== 'absent') fail(`rollback left balances_list as ${listLeft}`);
      const payoutArgs = runPsqlC(
        auditUri,
        "SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'admin_seller_cash_payout' AND pronamespace = 'public'::regnamespace;",
      );
      if (!payoutArgs.includes('p_comment text') || payoutArgs.includes('p_accrued_at')) {
        fail(`rollback must restore 4-arg payout, got ${payoutArgs}`);
      }
      rollbackRan = true;

      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      runPsqlC(
        auditUri,
        `SELECT public.seller_ledger_post_internal(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa5090'::uuid,
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
          'adjustment', 400, NULL, NULL, NULL, NULL, NULL, NULL,
          false, NULL, NULL, now(),
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'seed race');`,
      );
      const payoutSql = (op: string) =>
        `BEGIN; ${adminJwtSql} SELECT pg_sleep(1); SELECT public.admin_seller_cash_payout('${op}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 400, 'race', TIMESTAMPTZ '2026-04-01 00:00:00+05'); COMMIT;`;
      const [a, b] = await Promise.all([
        spawnPsqlC(auditUri, payoutSql('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5aa1')),
        spawnPsqlC(auditUri, payoutSql('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5aa2')),
      ]);
      const texts = [a, b].map((r) => `${r.stdout}\n${r.stderr}`);
      const success = [a, b].filter((r) => r.status === 0).length;
      const exceeded = texts.filter((t) => /Payout exceeds available balance/i.test(t)).length;
      if (success !== 1 || exceeded !== 1) {
        fail(
          `concurrent payout expected 1 success + 1 over-balance, got success=${success} exceeded=${exceeded} a=${texts[0].slice(-400)} b=${texts[1].slice(-400)}`,
        );
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

  if (psqlRan && !concurrentRan) fail('two-session concurrency tests did not run');
  if (psqlRan && !remigrateRan) fail('migration re-run did not run');
  if (psqlRan && !rollbackRan) fail('rollback probe did not run');

  console.log(
    psqlRan
      ? `seller-commission-balances checks ok (sql harness passed; concurrent=${concurrentRan}; remigrate=${remigrateRan}; rollback=${rollbackRan})`
      : 'seller-commission-balances checks ok (static)',
  );
}

void main();
