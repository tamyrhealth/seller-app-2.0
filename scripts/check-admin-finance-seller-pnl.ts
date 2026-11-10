import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

const mig = 'supabase/migrations/20261110160000_admin_finance_seller_pnl.sql';
const run = 'supabase/run_admin_finance_seller_pnl.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE TABLE/i.test(sql)) fail('must not create tables');
if (/CREATE OR REPLACE FUNCTION public\.(confirm_order|fulfill_preorder|cancel_order)/i.test(sql)) {
  fail('must not rewrite order RPCs');
}
if (/INSERT\s+INTO\s+public\.finance_expenses/i.test(sql)) fail('must not write finance_expenses');
if (/UPDATE\s+public\.finance_expenses/i.test(sql)) fail('must not update finance_expenses');
if (/DELETE\s+FROM\s+public\.finance_expenses/i.test(sql)) fail('must not delete finance_expenses');
if (!sql.includes('admin_finance_seller_pnl')) fail('rpc name');
if (!sql.includes('finance_require_active_admin')) fail('admin gate');
if (!sql.includes("AT TIME ZONE 'Asia/Almaty'")) fail('almaty bounds');
if (!sql.includes("'include_in_pnl', false")) fail('cash out of pnl');
if (!sql.includes("'classified', false")) fail('adjustments unclassified');
if (!sql.includes("'include_in_commission_expense', false")) fail('adjustments excluded');
if (!sql.includes("'credit_is_revenue', false")) fail('credit is not revenue');
if (!sql.includes('unclassified_amount')) fail('unclassified payout');
if (!sql.includes('legacy_opex_amount')) fail('legacy payout');
if (!sql.includes('settlement_duplicate_amount')) fail('duplicate payout');
if (!sql.includes('ledger_consistent')) fail('goods ledger check');
if (sql.includes('ledger_activity_in_period')) fail('must not exclude all payouts for the month');
if (!sql.includes('SET row_security = off')) fail('row_security');
if (!sql.includes('SET search_path = public')) fail('search_path');
if (!sql.includes('REVOKE ALL ON FUNCTION public.admin_finance_seller_pnl')) fail('revoke');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.admin_finance_seller_pnl(date, date) TO authenticated')) {
  fail('grant authenticated');
}
if (sql.includes('cost_price_snapshot')) {
  const leaked = sql.includes("'cost_price_snapshot'");
  if (leaked) fail('must not return cost_price_snapshot in json');
}

const tests = read('scripts/verify_admin_finance_seller_pnl_tests.sql');
if (!tests.includes('jan accrued expected 1080')) fail('accrual without treating cash as expense');
if (!tests.includes('cash must stay out of pnl')) fail('payout test');
if (!tests.includes('jan goods credit')) fail('goods issue test');
if (!tests.includes('advance credit')) fail('goods advance test');
if (!tests.includes('feb return credit')) fail('next-month return');
if (!tests.includes('missing_rate count')) fail('missing_rate');
if (!tests.includes('adjustments must stay unclassified')) fail('adjustment category');
if (!tests.includes('zero cost lines')) fail('zero cost');
if (!tests.includes('unknown cost lines')) fail('unknown cost');
if (!tests.includes('empty period must be zeros')) fail('empty period');
if (!tests.includes('negative/end balance')) fail('negative balance');
if (!tests.includes('historical month must keep seller_payout as legacy opex')) fail('historical payout');
if (!tests.includes('mixed month unclassified')) fail('mixed month payout');
if (!tests.includes('duplicate matched by operation_id')) fail('duplicate payout');
if (!tests.includes('april documents without ledger must be inconsistent')) fail('goods mismatch');
if (!tests.includes('manager must not read finance pnl')) fail('manager deny');
if (!tests.includes('seller must not read finance pnl')) fail('seller deny');
if (!tests.includes('json must not leak cost_price_snapshot')) fail('json leak test');
if (/^\s*COMMIT;/m.test(tests)) fail('tests must not commit');

const pre = read('supabase/prod/pre_apply_inspect_block5177b.sql');
const post = read('supabase/prod/post_apply_verify_block5177b.sql');
const apply = read('supabase/prod/apply_block5177b.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('admin_finance_seller_pnl.absent')) fail('preflight absent rpc');
if (!post.includes('admin_finance_seller_pnl.security_definer')) fail('postflight definer');
if (!apply.includes('Не запускать этот SQL на Production')) fail('apply blocked');
if (!apply.includes('run_admin_finance_seller_pnl.sql')) fail('apply runner');

const finance = read('lib/adminFinance.ts');
const page = read('app/admin/finance/page.tsx');
if (!finance.includes('FINANCE_SELLER_PNL_RPC')) fail('buildAdminFinance must know seller pnl rpc');
if (!page.includes('FINANCE_SELLER_PNL_RPC') || !page.includes('p_from')) {
  fail('5.17.7D finance UI must call seller pnl rpc');
}
if (!page.includes('finance.pnlDisconnected')) fail('disconnected copy on finance page');
if (!page.includes('cityScoped') || !page.includes('finance.cityOperational')) {
  fail('city filter must not mix company seller pnl');
}
const sqlPnl = read('supabase/migrations/20261110160000_admin_finance_seller_pnl.sql');
const classPos = sqlPnl.indexOf("THEN 'settlement_duplicate'");
const legacyPos = sqlPnl.indexOf("THEN 'legacy_opex'");
const unclassPos = sqlPnl.indexOf("ELSE 'unclassified'");
if (!(classPos > 0 && classPos < legacyPos && legacyPos < unclassPos)) {
  fail('payout class must prefer operation_id/comment over cutover date');
}

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extraAccrual = read('scripts/verify_seller_commission_accrual_stubs.sql');
const extraBal = read('scripts/verify_seller_commission_balances_stubs.sql');
const extraGoods = read('scripts/verify_seller_goods_issue_stubs.sql');
const extraPnl = read('scripts/verify_admin_finance_seller_pnl_stubs.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const accrual = read('supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const balances = read('supabase/migrations/20261110120000_seller_commission_balance_rpcs.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const goods = read('supabase/migrations/20261110140000_seller_goods_issue_rpcs.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const body = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const harness = `BEGIN;\n${stubs}\n${foundation}\n${extraAccrual}\n${extraBal}\n${extraGoods}\n${extraPnl}\n${accrual}\n${goods}\n${body}\n${tests}\nROLLBACK;\n`;
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
    const dir = mkdtempSync(join(tmpdir(), 'seller-pnl-'));
    const file = join(dir, 'harness.sql');
    writeFileSync(file, harness, 'utf8');
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const out = runPsqlFile(uri, file);
    psqlRan = true;
    if (/ERROR:/i.test(out)) fail(`psql reported error: ${out.slice(-500)}`);

    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5177b_audit';
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
        )}\n${extraBal}\n${read('supabase/migrations/20261110120000_seller_commission_balance_rpcs.sql')}\n${extraGoods}\n${read(
          'supabase/migrations/20261110140000_seller_goods_issue_rpcs.sql',
        )}\n${extraPnl}\n`,
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
      const left = runPsqlC(
        auditUri,
        "SELECT COALESCE(to_regprocedure('public.admin_finance_seller_pnl(date, date)')::text, 'absent');",
      );
      if (left !== 'absent') fail(`rollback left pnl rpc as ${left}`);
      rollbackRan = true;

      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      const readSql = `BEGIN; ${adminJwtSql} SELECT public.admin_finance_seller_pnl(DATE '2026-01-01', DATE '2026-01-31'); COMMIT;`;
      const [a, b] = await Promise.all([spawnPsqlC(auditUri, readSql), spawnPsqlC(auditUri, readSql)]);
      if (a.status !== 0 || b.status !== 0) {
        fail(`concurrent reads failed a=${a.stderr.slice(-400)} b=${b.stderr.slice(-400)}`);
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
      ? `admin-finance-seller-pnl checks ok (sql harness passed; concurrent=${concurrentRan}; remigrate=${remigrateRan}; rollback=${rollbackRan})`
      : 'admin-finance-seller-pnl checks ok (static)',
  );
}

void main();
