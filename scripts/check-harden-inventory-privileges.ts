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

const mig = 'supabase/migrations/20261110190000_harden_inventory_table_privileges.sql';
const run = 'supabase/run_harden_inventory_table_privileges.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE TABLE/i.test(sql)) fail('must not create tables');
if (/CREATE OR REPLACE FUNCTION/i.test(sql)) fail('must not replace functions');
if (/INSERT\s+INTO\s+public\.inventory/i.test(sql)) fail('must not write inventory');
if (/UPDATE\s+public\.inventory/i.test(sql)) fail('must not update inventory');
if (/DELETE\s+FROM\s+public\.inventory/i.test(sql)) fail('must not delete inventory');
if (!sql.includes('REVOKE ALL ON TABLE public.inventory FROM authenticated')) fail('revoke inventory authenticated');
if (!sql.includes('REVOKE ALL ON TABLE public.inventory_movements FROM authenticated')) {
  fail('revoke movements authenticated');
}
if (!sql.includes('GRANT SELECT ON TABLE public.inventory TO authenticated')) fail('keep inventory select');
if (!sql.includes('GRANT SELECT ON TABLE public.inventory_movements TO authenticated')) {
  fail('keep movements select');
}
if (/REVOKE ALL ON TABLE public.inventory FROM service_role/i.test(sql)) fail('must keep service_role inventory');
if (/confirm_order|fulfill_preorder|cancel_order|admin_seller_goods/i.test(sql)) {
  fail('must not rewrite operational RPCs');
}

const tests = read('scripts/verify_harden_inventory_privileges_tests.sql');
if (!tests.includes('authenticated must not TRUNCATE inventory')) fail('truncate inventory test');
if (!tests.includes('authenticated must not TRUNCATE inventory_movements')) fail('truncate movements test');
if (!tests.includes('seller jwt must not UPDATE inventory')) fail('seller update test');
if (!tests.includes('manager jwt must not INSERT inventory_movements')) fail('manager insert test');
if (!tests.includes('SECURITY DEFINER stock bump failed')) fail('definer test');
if (/^\s*COMMIT;/m.test(tests)) fail('tests must not commit');

const locations = read('app/admin/locations/page.tsx');
if (!locations.includes(".from('inventory')") || !locations.includes(".from('inventory_movements')")) {
  fail('admin locations still selects inventory tables');
}
if (/\.from\('inventory'\)\.(insert|update|delete)/.test(locations)) fail('locations must not write inventory');

const pages = [
  'app/seller/inventory/page.tsx',
  'app/admin/forecast/page.tsx',
  'components/InventoryBrowse.tsx',
  'components/SellerGoodsView.tsx',
];
for (const p of pages) {
  const src = read(p);
  if (!src.includes(".from('inventory')")) fail(`${p} inventory select`);
  if (/\.from\('inventory'\)\.(insert|update|delete)/.test(src)) fail(`${p} must not write inventory`);
}

const pre = read('supabase/prod/pre_apply_inspect_block5192.sql');
const post = read('supabase/prod/post_apply_verify_block5192.sql');
const apply = read('supabase/prod/apply_block5192.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('authenticated.inventory.truncate')) fail('preflight inventory truncate');
if (!pre.includes('authenticated.inventory_movements.insert')) fail('preflight movements insert');
if (!post.includes('authenticated.inventory.truncate')) fail('postflight inventory truncate');
if (!post.includes('authenticated.inventory.insert')) fail('postflight inventory insert false');
if (!apply.includes('Не запускать этот SQL на Production')) fail('apply blocked');
if (!apply.includes('run_harden_inventory_table_privileges.sql')) fail('apply runner');
if (!apply.includes('admin_seller_missing_accruals_list')) fail('commission retry note');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extraAccrual = read('scripts/verify_seller_commission_accrual_stubs.sql');
const extraBal = read('scripts/verify_seller_commission_balances_stubs.sql');
const extraGoods = read('scripts/verify_seller_goods_issue_stubs.sql');
const extraAcl = read('scripts/verify_harden_inventory_privileges_stubs.sql');
const goodsTests = read('scripts/verify_seller_goods_issue_tests.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const accrual = read('supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const balances = read('supabase/migrations/20261110120000_seller_commission_balance_rpcs.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const goods = read('supabase/migrations/20261110140000_seller_goods_issue_rpcs.sql');
const body = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');

const adminJwtSql = [
  "SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false);",
  'SET ROLE authenticated;',
].join(' ');

let psqlRan = false;
let remigrateRan = false;
let rollbackRan = false;
let privDenied = false;
let definerOk = false;
let goodsAfter = false;

async function main() {
  try {
    if (!psqlBin) {
      console.log('SQL harness skipped (psql not available)');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'inv-acl-5192-'));
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5192_audit';
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
        `${stubs}\n${foundation}\n${extraAccrual}\n${accrual}\n${extraBal}\n${extraGoods}\n${goods}\n${extraAcl}\n`,
        'utf8',
      );
      runPsqlFile(auditUri, baseFile);
      psqlRan = true;

      const beforeTrunc = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory_movements', 'TRUNCATE');",
      );
      if (beforeTrunc !== 't') fail(`pre-state TRUNCATE must be true, got ${beforeTrunc}`);

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
      const stillTrunc = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory_movements', 'TRUNCATE');",
      );
      if (stillTrunc !== 't') fail('rollback must restore TRUNCATE grant');
      rollbackRan = true;

      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      const afterTrunc = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory_movements', 'TRUNCATE');",
      );
      if (afterTrunc !== 'f') fail(`TRUNCATE must be false after harden, got ${afterTrunc}`);
      const afterInvAll = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory', 'UPDATE');",
      );
      if (afterInvAll !== 'f') fail(`inventory UPDATE must be false, got ${afterInvAll}`);
      const selectKept = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory', 'SELECT');",
      );
      if (selectKept !== 't') fail(`inventory SELECT must remain, got ${selectKept}`);

      const truncProbe = await spawnPsqlC(
        auditUri,
        `BEGIN; ${adminJwtSql} TRUNCATE public.inventory_movements; COMMIT;`,
      );
      if (truncProbe.status === 0) fail('authenticated TRUNCATE must fail');
      privDenied = true;

      const testsFile = join(dir, 'priv-tests.sql');
      writeFileSync(testsFile, `BEGIN;\n${tests}\nROLLBACK;\n`, 'utf8');
      runPsqlFile(auditUri, testsFile);
      definerOk = true;

      const goodsFile = join(dir, 'goods-tests.sql');
      writeFileSync(goodsFile, `BEGIN;\n${goodsTests}\nROLLBACK;\n`, 'utf8');
      runPsqlFile(auditUri, goodsFile);
      goodsAfter = true;
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

  if (psqlRan && !privDenied) fail('TRUNCATE denial probe did not run');
  if (psqlRan && !definerOk) fail('privilege tests did not run');
  if (psqlRan && !goodsAfter) fail('goods tests after harden did not run');
  if (psqlRan && !remigrateRan) fail('remigrate did not run');
  if (psqlRan && !rollbackRan) fail('rollback probe did not run');

  console.log(
    psqlRan
      ? `harden-inventory-privileges checks ok (truncate_denied=${privDenied}; definer=${definerOk}; goods=${goodsAfter}; remigrate=${remigrateRan}; rollback=${rollbackRan})`
      : 'harden-inventory-privileges checks ok (static)',
  );
}

void main();
