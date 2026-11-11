import { execFile, execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
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

function runPsqlFileAt(uri: string, file: string): string {
  return execFileSync(psqlBin as string, [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|', '-f', file], {
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

function psqlCAsync(uri: string, sql: string): Promise<{ status: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      psqlBin as string,
      [uri, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        const err = error as { status?: number; message?: string } | null;
        resolve({
          status: err && err.status != null ? err.status : error ? 1 : 0,
          out: String(stdout || ''),
          err: `${stderr || ''} ${err?.message || ''}`,
        });
      }
    );
  });
}

const mig = 'supabase/migrations/20261111120000_preorder_inventory_reserve.sql';
const run = 'supabase/run_preorder_inventory_reserve.sql';
const inspect = 'supabase/prod/inspect_block5202a_readonly.sql';
const pre = 'supabase/prod/pre_apply_inspect_block5202a.sql';
const post = 'supabase/prod/post_apply_verify_block5202a.sql';
const rollback = 'supabase/prod/rollback_block5202a.sql';
const apply = 'supabase/prod/apply_block5202a.md';
const tests = 'scripts/verify_preorder_inventory_reserve_tests.sql';
const stubs = 'scripts/verify_preorder_inventory_reserve_stubs.sql';
const p0 = 'supabase/migrations/20261111090000_orders_protect_client_updates.sql';
const phase2 = 'supabase/migrations/20261110220000_assert_active_auth_session_enforce.sql';
const invoiceLines = 'lib/assistant/invoiceLines.ts';

if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration must be transactional');
if (!sql.includes('qty_reserved')) fail('qty_reserved column');
if (!sql.includes('inventory_reserve_up_to')) fail('reserve helper');
if (!sql.includes('inventory_deduct_available')) fail('available deduct');
if (!sql.includes('inventory_fulfill_sku')) fail('fulfill helper');
if (!sql.includes('inventory_release_reserve')) fail('release helper');
if (!sql.includes('inventory_allocate_pending_preorders')) fail('allocate helper');
if (!sql.includes('inventory_backfill_pending_preorder_reserves')) fail('backfill');
if (!sql.includes('inventory_lock_sku')) fail('unified lock');
if (!sql.includes("hashtext('inv:'")) fail('advisory inv lock prefix');
if (sql.includes('auth_session_guard_apply')) fail('must not re-apply phase 2');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order\(/i.test(sql) && !sql.includes('confirm_order__session_body')) {
  fail('must not unwrap confirm_order');
}
if (sql.includes('GRANT UPDATE') && /order_items/i.test(sql)) fail('must not grant order_items UPDATE');
if (!sql.includes('REVOKE ALL ON FUNCTION public.inventory_reserve_up_to')) fail('revoke helper execute');
if (/fulfill_preorder/i.test(sql.match(/receive_stock_transfer__session_body[\s\S]+?\$\$;/)?.[0] || '')) {
  fail('receive must not call fulfill');
}
if (!read(p0).includes('orders_block_client_write')) fail('p0 migration still present');
if (!read(phase2).includes('auth_session_guard_apply')) fail('phase 2 still present');
if (!read(invoiceLines).includes('штук(?:а|и)?')) fail('keep invoice parser fix');

const inspectBare = read(inspect).replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const preBare = read(pre).replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = read(post).replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(inspectBare)) fail('inspect SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('postflight SELECT-only');
if (!read(inspect).includes('pg_attribute')) fail('inspect must use pg_attribute for qty_reserved');
if (!read(pre).includes('pg_attribute')) fail('preflight must use pg_attribute for qty_reserved');
if (!read(post).includes('pg_attribute')) fail('postflight must use pg_attribute for qty_reserved');
if (!read(inspect).includes("'absent'")) fail('inspect must not call has_column_privilege on missing columns');
if (read(pre).includes('has_column_privilege')) fail('preflight must not probe missing qty_reserved privileges');
if (!read(inspect).includes('p0.orders.write_trigger')) fail('inspect must keep P0 trigger check');
if (!read(pre).includes('p0.orders.write_trigger')) fail('preflight must keep P0 trigger check');
if (!read(pre).includes('confirm.wrapped')) fail('preflight must keep Phase 2 wrap check');
if (!read(post).includes('p0.orders.write_trigger')) fail('postflight must keep P0 trigger check');
if (!read(post).includes('confirm.wrapper.session')) fail('postflight must keep Phase 2 wrap check');
if (!read(apply).includes('backup_main.ps1')) fail('apply backup');
if (!read(apply).includes('Do not apply')) fail('apply must say do not apply yet');
if (!read(apply).includes('SQL first')) fail('apply must publish SQL before client');
if (!read(rollback).includes('DROP COLUMN IF EXISTS qty_reserved')) fail('rollback drops reserved');
if (read(rollback).includes('DROP FUNCTION public.confirm_order(')) fail('rollback must not drop confirm wrapper');
if (!read(rollback).includes('CREATE OR REPLACE FUNCTION public.confirm_order__session_body')) {
  fail('rollback must restore confirm session body');
}
if (!read(rollback).includes('AND qty_on_hand >= v_need')) fail('rollback must restore pre-reserve stock check');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order__session_body[\s\S]+inventory_reserve_up_to/.test(read(rollback))) {
  fail('rollback confirm body must not keep reserve helpers');
}
if (read(rollback).includes("CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)")) {
  fail('rollback must not replace Phase 2 confirm_order wrapper');
}
if (read(rollback).includes('zz_orders_block_client_write')) fail('rollback must not touch P0 triggers');
if (!read('components/PreorderDemandPanel.tsx').includes('order_items!order_items_order_id_fkey')) {
  fail('demand panel must hint order_items FK');
}
if (read('components/PreorderDemandPanel.tsx').includes('profiles!')) {
  fail('demand panel must not embed profiles (PostgREST hint)');
}

const testSql = read(tests);
if (!testSql.includes('sale must not consume reserved stock')) fail('sale vs reserve test');
if (!testSql.includes('inbound must allocate uncovered')) fail('mixed inbound test');
if (!testSql.includes('second fulfill must be no-op')) fail('double fulfill test');
if (!testSql.includes('gift must reserve')) fail('gift test');
if (!testSql.includes('backfill must not write movements')) fail('backfill movement test');
if (!testSql.includes('JWT must not UPDATE qty_reserved')) fail('client reserved lock test');
if (!read(stubs).includes('CREATE TABLE public.inventory')) fail('stubs inventory');

const locations = read('app/admin/locations/page.tsx');
if (!locations.includes('PreorderDemandPanel')) fail('locations demand panel');
if (!read('components/InventoryBrowse.tsx').includes('PreorderDemandPanel')) fail('manager demand panel');
if (!read('lib/preorderDemand.ts').includes('uncovered')) fail('uncovered field');
if (read('app/seller/new-order/page.tsx').includes(".gt('qty_on_hand', 0)")) fail('seller catalog still hides zero stock');
if (read('app/admin/new-order/page.tsx').includes(".gt('qty_on_hand', 0)")) fail('admin catalog still hides zero stock');
if (!read('lib/assistant/invoiceLines.ts').includes('mergeParsedInvoiceItems')) fail('parser merge kept');

console.log('static OK');

async function main() {
  if (!psqlBin) {
    console.log('SQL harness skipped (psql not available)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'preorder-reserve-5202b-'));
  const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
  const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  const dbName = 'seller_app_5202b_preorder';
  try {
    try {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    } catch {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName};`);
    }
    runPsqlC(adminUri, `CREATE DATABASE ${dbName};`);
    const auditUri = uri.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    try {
      const ver = runPsqlC(auditUri, 'SHOW server_version;');
      if (!ver.startsWith('17')) fail(`expected PostgreSQL 17, got ${ver}`);
      writeFileSync(join(dir, 'stubs.sql'), read(stubs), 'utf8');
      runPsqlFile(auditUri, join(dir, 'stubs.sql'));
      writeFileSync(join(dir, 'inspect.sql'), read(inspect), 'utf8');
      writeFileSync(join(dir, 'pre.sql'), read(pre), 'utf8');
      writeFileSync(join(dir, 'post.sql'), read(post), 'utf8');
      const inspectBefore = runPsqlFileAt(auditUri, join(dir, 'inspect.sql'));
      const preBefore = runPsqlFileAt(auditUri, join(dir, 'pre.sql'));
      if (/qty_reserved.*does not exist/i.test(inspectBefore + preBefore)) {
        fail('inspect/pre must not error on missing qty_reserved');
      }
      if (!/inventory\.qty_reserved\s*\|\s*f/.test(inspectBefore.replace(/\r/g, '')) && !inspectBefore.includes('inventory.qty_reserved|f')) {
        fail(`inspect before migration must report inventory.qty_reserved false, got ${inspectBefore.slice(-400)}`);
      }
      if (!preBefore.includes('inventory.qty_reserved.absent|t')) {
        fail(`preflight must report qty_reserved absent, got ${preBefore.slice(-400)}`);
      }
      if (!inspectBefore.includes('authenticated.qty_reserved.update|absent')) {
        fail('inspect must skip has_column_privilege when column absent');
      }
      writeFileSync(join(dir, 'apply.sql'), sql, 'utf8');
      runPsqlFile(auditUri, join(dir, 'apply.sql'));
      runPsqlFile(auditUri, join(dir, 'apply.sql'));
      writeFileSync(join(dir, 'tests.sql'), `BEGIN;\n${testSql}\nROLLBACK;\n`, 'utf8');
      runPsqlFile(auditUri, join(dir, 'tests.sql'));
      runPsqlFile(auditUri, join(dir, 'apply.sql'));

      const city = '10000000-0000-4000-8000-000000000001';
      const prod = '30000000-0000-4000-8000-000000000001';
      runPsqlC(
        auditUri,
        `INSERT INTO public.cities (id, name) VALUES ('${city}', 'Almaty') ON CONFLICT DO NOTHING;
         INSERT INTO public.products (id, name) VALUES ('${prod}', 'Oil') ON CONFLICT DO NOTHING;
         INSERT INTO public.inventory (city_id, product_id, qty_on_hand, qty_reserved)
         VALUES ('${city}', '${prod}', 5, 0)
         ON CONFLICT (city_id, product_id) DO UPDATE SET qty_on_hand = 5, qty_reserved = 0;`,
      );

      const deduct = `BEGIN; SELECT public.inventory_deduct_available('${city}'::uuid, '${prod}'::uuid, 4); COMMIT;`;
      const raced = await Promise.all([psqlCAsync(auditUri, deduct), psqlCAsync(auditUri, deduct)]);
      const ok = raced.filter((r) => r.status === 0).length;
      const bad = raced.filter((r) => r.status !== 0).length;
      if (ok !== 1 || bad !== 1) {
        fail(`concurrent deduct expected 1 success 1 fail, got ok=${ok} bad=${bad} ${raced.map((r) => r.err).join(' | ')}`);
      }
      const left = runPsqlC(
        auditUri,
        `SELECT qty_on_hand::text || ',' || qty_reserved::text FROM public.inventory WHERE city_id = '${city}' AND product_id = '${prod}';`,
      );
      if (left !== '1.000,0.000' && left !== '1,0') fail(`after concurrent deduct expected 1,0 got ${left}`);

      runPsqlC(
        auditUri,
        `UPDATE public.inventory SET qty_on_hand = 5, qty_reserved = 0 WHERE city_id = '${city}' AND product_id = '${prod}';`,
      );
      const reserveSql = `BEGIN; SELECT public.inventory_reserve_up_to('${city}'::uuid, '${prod}'::uuid, 5); COMMIT;`;
      const saleSql = `BEGIN; SELECT public.inventory_deduct_available('${city}'::uuid, '${prod}'::uuid, 5); COMMIT;`;
      const mixed = await Promise.all([psqlCAsync(auditUri, reserveSql), psqlCAsync(auditUri, saleSql)]);
      const mixedOk = mixed.filter((r) => r.status === 0).length;
      if (mixedOk !== 1) fail(`sale vs reserve expected exactly one winner, got ${mixedOk}`);
      const state = runPsqlC(
        auditUri,
        `SELECT qty_on_hand::text || '/' || qty_reserved::text FROM public.inventory WHERE city_id = '${city}' AND product_id = '${prod}';`,
      );
      if (state !== '5.000/5.000' && state !== '0.000/0.000' && state !== '5/5' && state !== '0/0') {
        fail(`sale vs reserve leftover invalid: ${state}`);
      }

      const dead1 = `BEGIN; SELECT public.inventory_lock_sku('${city}'::uuid, '${prod}'::uuid); SELECT pg_sleep(0.4); SELECT public.inventory_add_physical('${city}'::uuid, '${prod}'::uuid, 1); COMMIT;`;
      const dead2 = `BEGIN; SELECT public.inventory_lock_sku('${city}'::uuid, '${prod}'::uuid); SELECT pg_sleep(0.4); SELECT public.inventory_deduct_available('${city}'::uuid, '${prod}'::uuid, 1); COMMIT;`;
      const dead = await Promise.all([psqlCAsync(auditUri, dead1), psqlCAsync(auditUri, dead2)]);
      if (dead.some((r) => /deadlock/i.test(r.err))) fail(`deadlock: ${dead.map((r) => r.err).join(' | ')}`);
      if (dead.filter((r) => r.status === 0).length < 1) fail('lock-order pair both failed');

      const inspectAfter = runPsqlFileAt(auditUri, join(dir, 'inspect.sql'));
      const postAfter = runPsqlFileAt(auditUri, join(dir, 'post.sql'));
      if (!inspectAfter.includes('inventory.qty_reserved|t')) {
        fail(`inspect after migration must see qty_reserved, got ${inspectAfter.slice(-400)}`);
      }
      if (!postAfter.includes('inventory.qty_reserved|t')) fail('postflight inventory.qty_reserved');
      if (!postAfter.includes('confirm.body.available|t')) fail('postflight confirm available helper');
      if (!postAfter.includes('qty_reserved.no_client_update|t')) fail('postflight no client UPDATE');
      if (!postAfter.includes('qty_reserved.client_select|t')) fail('postflight client SELECT');
      if (!postAfter.includes('helper.reserve.no_client|t')) fail('postflight helper revoke');
      if (!postAfter.includes('reserved_le_physical|t')) fail('postflight reserved_le_physical');
      if (!postAfter.includes('receive.no_fulfill|t')) fail('postflight receive no fulfill');
      console.log('pg OK');
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
    const e = err as { stderr?: string; message?: string };
    fail(`${e.stderr || ''} ${e.message || ''}`);
  }
}

void main();
