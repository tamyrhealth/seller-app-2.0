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

const mig = 'supabase/migrations/20261110180000_admin_stats_seller_earnings.sql';
const run = 'supabase/run_admin_stats_seller_earnings.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE TABLE/i.test(sql)) fail('must not create tables');
if (/CREATE OR REPLACE FUNCTION public\.(confirm_order|fulfill_preorder|cancel_order)/i.test(sql)) {
  fail('must not rewrite order RPCs');
}
if (sql.includes('CREATE OR REPLACE FUNCTION public.admin_finance_seller_pnl')) fail('must not rewrite finance pnl');
if (/INSERT\s+INTO\s+public\.seller_ledger/i.test(sql)) fail('must not write ledger');
if (/UPDATE\s+public\.seller_ledger/i.test(sql)) fail('must not update ledger');
if (!sql.includes('admin_stats_seller_earnings')) fail('rpc name');
if (!sql.includes('seller_commission_require_active_admin')) fail('admin gate');
if (!sql.includes("AT TIME ZONE 'Asia/Almaty'")) fail('almaty bounds');
if (!sql.includes('missing_rate')) fail('missing_rate');
if (!sql.includes("entry_type = 'accrual' AND NOT COALESCE(l.missing_rate, false)")) fail('earned excludes missing_rate');
if (!sql.includes("entry_type = 'reversal'")) fail('reversals');
if (!sql.includes('SET row_security = off')) fail('row_security');
if (!sql.includes('SET search_path = public')) fail('search_path');
if (!sql.includes('SECURITY DEFINER')) fail('security definer');
if (!sql.includes('REVOKE ALL ON FUNCTION public.admin_stats_seller_earnings')) fail('revoke');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.admin_stats_seller_earnings(date, date) TO authenticated')) {
  fail('grant authenticated');
}
if (/cost_price|cogs|себестоим/i.test(sql)) fail('sql must not expose cost');

const sqlTests = read('scripts/verify_admin_stats_seller_earnings_tests.sql');
if (!sqlTests.includes('empty period must be zeros')) fail('empty period sql');
if (!sqlTests.includes('missing_rate count')) fail('missing_rate sql');
if (!sqlTests.includes('goods return not earned') && !sqlTests.includes('cash not earned')) {
  fail('non-commission entries excluded');
}
if (!sqlTests.includes('json must not leak cost_price_snapshot')) fail('json leak sql');
if (!sqlTests.includes('manager must not read stats earnings')) fail('manager deny');
if (!sqlTests.includes('seller must not read stats earnings')) fail('seller deny');
if (!sqlTests.includes('anon must not EXECUTE')) fail('anon deny');
if (!sqlTests.includes('same product two order items')) fail('two lines sql');
if (/^\s*COMMIT;/m.test(sqlTests)) fail('tests must not commit');

const ranking = read('scripts/verify-admin-stats-seller-ranking.ts');
for (const needle of [
  'empty period',
  '1-4 sellers',
  'more than 5',
  'tie revenue',
  'cancellations',
  'debt before and after',
  'preorder before and after',
  'gifts excluded',
  'missing_rate',
  'historical without ledger',
  'city filter does not mix',
  'no double-count',
  'must not leak cost',
  'same product two lines',
  'no cross-product commission',
  'negative payable vs period earned',
]) {
  if (!ranking.includes(needle)) fail(`ranking test ${needle}`);
}

const page = read('app/admin/stats/page.tsx');
if (!page.includes('STATS_SELLER_EARNINGS_RPC') || !page.includes('p_from')) fail('stats page must call earnings rpc');
if (!page.includes('SELLER_BALANCES_LIST')) fail('stats page payable from balances rpc');
if (!page.includes('stats.topSellers')) fail('top-5 copy');
if (!page.includes('setExpandedTop')) fail('in-page expand');
if (!page.includes('stats.earningsIncomplete')) fail('incomplete warning');
if (!page.includes('stats.earningsCityScope')) fail('city scope warning');
if (!page.includes('stats.earningsRpcError')) fail('rpc error copy');
if (!page.includes('stats.payableHintShort')) fail('payable not mixed with period');
if (!page.includes('break-words')) fail('long names wrap');
if (/cost_price|себестоим/i.test(page)) fail('page must not show cost');

const i18n = read('lib/i18n.tsx');
for (const key of [
  'stats.topSellers',
  'stats.earned',
  'stats.payableNow',
  'stats.earningsIncomplete',
  'stats.earningsCityScope',
  'stats.commissionDateNote',
  'stats.earningsRpcError',
  'stats.payableHintShort',
]) {
  const n = i18n.split(`'${key}'`).length - 1;
  if (n < 2) fail(`i18n ${key} ru/kz`);
}

const lib = read('lib/adminStatsEarnings.ts');
if (!lib.includes('allocateProductCommissions')) fail('unique order_item matching');
if (lib.includes('it.productId === p.productId ||')) fail('must not match commissions by product_id OR');
if (!lib.includes('earnedKnown = connected && !missingRate')) fail('period earned independent of sale-date match');

const pre = read('supabase/prod/pre_apply_inspect_block518.sql');
const post = read('supabase/prod/post_apply_verify_block518.sql');
const apply = read('supabase/prod/apply_block518.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('admin_stats_seller_earnings.absent')) fail('preflight absent rpc');
if (!post.includes('admin_stats_seller_earnings.security_definer')) fail('postflight definer');
if (!apply.includes('Не запускать этот SQL на Production')) fail('apply blocked');
if (!apply.includes('run_admin_stats_seller_earnings.sql')) fail('apply runner');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extraAccrual = read('scripts/verify_seller_commission_accrual_stubs.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const body = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const harness = `BEGIN;\n${stubs}\n${foundation}\n${extraAccrual}\n${body}\n${sqlTests}\nROLLBACK;\n`;
if (!harness.includes('ROLLBACK;')) fail('harness rollback');

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
    const dir = mkdtempSync(join(tmpdir(), 'seller-stats-earn-'));
    const file = join(dir, 'harness.sql');
    writeFileSync(file, harness, 'utf8');
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const out = runPsqlFile(uri, file);
    psqlRan = true;
    if (/ERROR:/i.test(out)) fail(`psql reported error: ${out.slice(-500)}`);

    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_518_audit';
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
        `${stubs}\n${read('supabase/migrations/20261109010000_seller_commission_foundation.sql')}\n${extraAccrual}\n`,
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
        "SELECT COALESCE(to_regprocedure('public.admin_stats_seller_earnings(date, date)')::text, 'absent');",
      );
      if (left !== 'absent') fail(`rollback left earnings rpc as ${left}`);
      rollbackRan = true;

      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      const testsFile = join(dir, 'tests.sql');
      writeFileSync(testsFile, `BEGIN;\n${sqlTests}\nROLLBACK;\n`, 'utf8');
      runPsqlFile(auditUri, testsFile);

      const readSql = `BEGIN; SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false); SET ROLE authenticated; SELECT public.admin_stats_seller_earnings(DATE '2026-11-01', DATE '2026-11-01'); COMMIT;`;
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
      ? `admin-stats-seller-earnings checks ok (sql harness passed; concurrent=${concurrentRan}; remigrate=${remigrateRan}; rollback=${rollbackRan})`
      : 'admin-stats-seller-earnings checks ok (static)',
  );
}

void main();
