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

const mig = 'supabase/migrations/20261110150000_revoke_inventory_movements_client_insert.sql';
const run = 'supabase/run_revoke_inventory_movements_client_insert.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE TABLE/i.test(sql)) fail('must not create tables');
if (/CREATE OR REPLACE FUNCTION/i.test(sql)) fail('must not replace functions');
if (!sql.includes('REVOKE INSERT ON TABLE public.inventory_movements FROM authenticated')) {
  fail('revoke authenticated');
}
if (!sql.includes('REVOKE INSERT ON TABLE public.inventory_movements FROM anon')) fail('revoke anon');
if (!sql.includes('REVOKE INSERT ON TABLE public.inventory_movements FROM PUBLIC')) fail('revoke public');
if (/REVOKE INSERT ON TABLE public.inventory_movements FROM service_role/i.test(sql)) {
  fail('must keep service_role insert');
}
if (/confirm_order|cancel_order|fulfill_preorder|admin_seller_goods/i.test(sql)) {
  fail('must not touch order/goods RPCs');
}

const goods = read('supabase/migrations/20261110140000_seller_goods_issue_rpcs.sql');
if (/GRANT ALL ON TABLE public.inventory_movements/i.test(goods)) fail('5.17.6 must not grant movements');
if (/REVOKE INSERT ON TABLE public.inventory_movements/i.test(goods)) fail('5.17.6 must not revoke movements');

const pre = read('supabase/prod/pre_apply_inspect_block5176d.sql');
const post = read('supabase/prod/post_apply_verify_block5176d.sql');
const apply = read('supabase/prod/apply_block5176d.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('authenticated.inventory_movements.insert')) fail('preflight insert check');
if (!pre.includes("'true'::text AS expected_value")) fail('preflight expects insert true');
if (!post.includes("'false'::text AS expected_value")) fail('postflight expects insert false');
if (!apply.includes('run_revoke_inventory_movements_client_insert.sql')) fail('apply runner');
if (!apply.includes('Не запускать без отдельного разрешения')) fail('apply blocked');

const dump = read('supabase/prod/_generated/20261110-143054/public_schema.sql');
if (!dump.includes('GRANT ALL ON TABLE public.inventory_movements TO authenticated')) {
  fail('prod dump must show GRANT ALL authenticated');
}
if (!dump.includes('GRANT ALL ON TABLE public.inventory_movements TO anon')) {
  fail('prod dump must show GRANT ALL anon');
}
if (!dump.includes('CREATE POLICY movements_admin_select ON public.inventory_movements FOR SELECT')) {
  fail('prod dump select policy');
}
if (dump.includes('CREATE POLICY movements_insert')) fail('prod dump must not have insert policy');

const adminJwtSql = [
  "SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false);",
  'SET ROLE authenticated;',
].join(' ');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extraAccrual = read('scripts/verify_seller_commission_accrual_stubs.sql');
const extraBal = read('scripts/verify_seller_commission_balances_stubs.sql');
const extraGoods = read('scripts/verify_seller_goods_issue_stubs.sql');
const extraGrant = read('scripts/verify_revoke_inventory_movements_insert_stubs.sql');
const tests = read('scripts/verify_seller_goods_issue_tests.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const accrual = read('supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const balances = read('supabase/migrations/20261110120000_seller_commission_balance_rpcs.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const goodsBody = goods.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const revokeBody = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');

let psqlRan = false;
let remigrateRan = false;
let rollbackRan = false;
let rlsBlocked = false;
let definerOk = false;
let goodsAfterRevoke = false;

async function main() {
  try {
    if (!psqlBin) {
      console.log('SQL harness skipped (psql not available)');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'inv-mov-revoke-'));
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5176d_audit';
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
        `${stubs}\n${foundation}\n${extraAccrual}\n${accrual}\n${extraBal}\n${extraGoods}\n${goods}\n${extraGrant}\n`,
        'utf8',
      );
      runPsqlFile(auditUri, baseFile);
      psqlRan = true;

      const insertPriv = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT');",
      );
      if (insertPriv !== 't') fail(`prod-like GRANT ALL missing, got ${insertPriv}`);

      const rls = await spawnPsqlC(
        auditUri,
        `BEGIN; ${adminJwtSql}
         INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta)
         VALUES ('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999', 'restock', 1);
         COMMIT;`,
      );
      const rlsText = `${rls.stdout}\n${rls.stderr}`;
      if (rls.status === 0) fail(`direct authenticated insert must fail RLS, got ${rlsText.slice(-400)}`);
      if (!/row-level security|RLS|политик/i.test(rlsText)) {
        fail(`expected RLS denial, got ${rlsText.slice(-600)}`);
      }
      rlsBlocked = true;

      const rollbackFile = join(dir, 'rollback.sql');
      writeFileSync(
        rollbackFile,
        `BEGIN;\n${revokeBody}\nDO $$ BEGIN RAISE EXCEPTION 'rollback_probe'; END $$;\nROLLBACK;\n`,
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
      const stillGranted = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT');",
      );
      if (stillGranted !== 't') fail('rollback must restore INSERT grant');
      rollbackRan = true;

      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      const afterPriv = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT');",
      );
      if (afterPriv !== 'f') fail(`authenticated INSERT must be false after revoke, got ${afterPriv}`);
      const anonPriv = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('anon', 'public.inventory_movements', 'INSERT');",
      );
      if (anonPriv !== 'f') fail(`anon INSERT must be false after revoke, got ${anonPriv}`);
      const servicePriv = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('service_role', 'public.inventory_movements', 'INSERT');",
      );
      if (servicePriv !== 't') fail(`service_role INSERT must remain, got ${servicePriv}`);
      const selectPriv = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.inventory_movements', 'SELECT');",
      );
      if (selectPriv !== 't') fail(`authenticated SELECT must remain, got ${selectPriv}`);

      const denied = await spawnPsqlC(
        auditUri,
        `BEGIN; ${adminJwtSql}
         INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta)
         VALUES ('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999', 'restock', 1);
         COMMIT;`,
      );
      const deniedText = `${denied.stdout}\n${denied.stderr}`;
      if (denied.status === 0) fail('direct insert must fail after revoke');
      if (
        !/permission denied|нет прав|недостаточно|нет доступа/i.test(deniedText) &&
        !/row-level security|политик/i.test(deniedText)
      ) {
        fail(`expected privilege/RLS denial after revoke, got ${deniedText.slice(-600)}`);
      }

      const definer = await spawnPsqlC(
        auditUri,
        `BEGIN; ${adminJwtSql}
         SELECT public.audit_inventory_movement_definer_insert(
           '11111111-1111-4111-8111-111111111111'::uuid,
           '99999999-9999-4999-8999-999999999999'::uuid
         );
         COMMIT;`,
      );
      if (definer.status !== 0) fail(`SECURITY DEFINER insert failed: ${definer.stderr.slice(-500)}`);
      definerOk = true;

      const goodsFile = join(dir, 'goods-tests.sql');
      writeFileSync(goodsFile, `BEGIN;\n${tests}\nROLLBACK;\n`, 'utf8');
      runPsqlFile(auditUri, goodsFile);
      goodsAfterRevoke = true;
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

  if (psqlRan && !rlsBlocked) fail('RLS direct-insert probe did not run');
  if (psqlRan && !definerOk) fail('SECURITY DEFINER probe did not run');
  if (psqlRan && !goodsAfterRevoke) fail('goods tests after revoke did not run');
  if (psqlRan && !remigrateRan) fail('revoke remigrate did not run');
  if (psqlRan && !rollbackRan) fail('rollback probe did not run');

  console.log(
    psqlRan
      ? `inventory-movements-insert-revoke checks ok (rls=${rlsBlocked}; definer=${definerOk}; goods=${goodsAfterRevoke}; remigrate=${remigrateRan}; rollback=${rollbackRan})`
      : 'inventory-movements-insert-revoke checks ok (static)',
  );
}

void main();
