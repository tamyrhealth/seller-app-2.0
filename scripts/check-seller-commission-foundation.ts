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
      /* try next */
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

const mig = 'supabase/migrations/20261109010000_seller_commission_foundation.sql';
const run = 'supabase/run_seller_commission_foundation.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (!existsSync(join(process.cwd(), run))) fail('run SQL missing');
const sql = read(mig);
const runSql = read(run);
if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration transactional');

for (const name of [
  'confirm_order',
  'fulfill_preorder',
  'cancel_order',
  'admin_cancel_order',
  'apply_order_cancel',
  'mark_debt_paid',
]) {
  if (new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}`, 'i').test(sql)) {
    fail(`must not rewrite ${name}`);
  }
}

if (/INSERT\s+INTO\s+public\.finance_expenses/i.test(sql)) fail('must not write finance_expenses');
if (/UPDATE\s+public\.orders\b/i.test(sql)) fail('must not write orders');
if (/INSERT\s+INTO\s+public\.inventory\b/i.test(sql)) fail('must not write inventory');
if (/INSERT\s+INTO\s+public\.inventory_movements/i.test(sql)) fail('must not write inventory_movements');
if (/ALTER TABLE public\.inventory/i.test(sql)) fail('must not alter inventory');
if (/buildAdminFinance/.test(sql)) fail('must not touch finance builder');

if (!sql.includes('CREATE TABLE IF NOT EXISTS public.seller_tariff_plans')) fail('plans table');
if (!sql.includes('CREATE TABLE IF NOT EXISTS public.seller_tariff_rates')) fail('rates table');
if (!sql.includes('CREATE TABLE IF NOT EXISTS public.seller_tariff_assignments')) fail('assignments table');
if (!sql.includes('CREATE TABLE IF NOT EXISTS public.seller_rate_overrides')) fail('overrides table');
if (!sql.includes('CREATE TABLE IF NOT EXISTS public.seller_ledger')) fail('ledger table');
if (!sql.includes('CREATE TABLE IF NOT EXISTS public.seller_goods_issues')) fail('goods issues table');
if (!sql.includes('CREATE TABLE IF NOT EXISTS public.seller_goods_issue_items')) fail('goods issue items table');
if (!sql.includes("('A', 'Тариф A', true)")) fail('seed plan A');
if (!sql.includes("('B', 'Тариф B', true)")) fail('seed plan B');
if (!sql.includes('amount_kzt numeric(12,2) NOT NULL')) fail('fixed KZT rate');
if (sql.includes('percent') || sql.includes('percentage')) fail('must not use percent rates');
if (!sql.includes("CONSTRAINT seller_tariff_rates_amount_check CHECK (amount_kzt >= 0)")) fail('rate >= 0');
if (!sql.includes('Seller tariff rate periods overlap')) fail('rate overlap protection');
if (!sql.includes('Seller tariff assignment periods overlap')) fail('assignment overlap protection');
if (!sql.includes('Seller rate override periods overlap')) fail('override overlap protection');
if (!sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS seller_tariff_rates_open_uidx')) fail('open rate unique');
if (!sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS seller_tariff_assignments_open_uidx')) fail('open assignment unique');
if (!sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS seller_rate_overrides_open_uidx')) fail('open override unique');
if (!sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS seller_ledger_accrual_item_uidx")) {
  fail('accrual unique per order_item');
}
if (/seller_ledger_accrual_item_uidx[\s\S]*NOT reversed/i.test(sql)) {
  fail('accrual unique must not depend on reversed flag');
}
if (!sql.includes("WHERE entry_type = 'accrual'")) fail('accrual unique predicate');
if (!sql.includes("CONSTRAINT seller_ledger_operation_id_key UNIQUE (operation_id)")) fail('operation_id unique');
if (!sql.includes('missing_rate boolean NOT NULL DEFAULT false')) fail('missing_rate column');
if (!sql.includes('unit_rate_snapshot numeric(12,2)')) fail('rate snapshot');
if (!sql.includes("'accrual'::text")) fail('accrual type');
if (!sql.includes("'cash_payout'::text")) fail('payout type');
if (!sql.includes("'cash_advance'::text")) fail('advance type');
if (!sql.includes("'goods_issue'::text")) fail('goods_issue type');
if (!sql.includes('Seller ledger is append-only')) fail('ledger immutability');
if (!sql.includes('cost_price_snapshot numeric(12,2)')) fail('goods cost snapshot');
if (!sql.includes('ALTER TABLE public.seller_ledger FORCE ROW LEVEL SECURITY')) fail('ledger FORCE RLS');
if (!sql.includes('REVOKE ALL ON TABLE public.seller_ledger FROM PUBLIC, anon, authenticated, service_role')) {
  fail('revoke ledger from clients and service_role');
}
if (/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL) ON TABLE public\.seller_ledger TO (authenticated|service_role)/i.test(sql)) {
  fail('must not grant ledger to authenticated or service_role');
}
if (!sql.includes('SET search_path = public')) fail('search_path');
if (!sql.includes('SET row_security = off')) fail('row_security off');
if (!sql.includes('pg_advisory_xact_lock(51730312, hashtext(p_seller_id::text))')) fail('seller balance lock');
if (!sql.includes('Payout exceeds available balance')) fail('payout cap');
if (!sql.includes('Tariff rate cannot be NULL')) fail('NULL rate rejected');
if (!sql.includes('Idempotency key reused with a different payload')) fail('idempotency conflict');
if (!sql.includes('Seller accrual already exists for order item')) fail('duplicate accrual message');
if (!sql.includes('v_existing.actor_id IS DISTINCT FROM p_actor_id')) fail('idempotency must compare actor_id');
if (!sql.includes('v_existing.qty IS DISTINCT FROM p_qty')) fail('idempotency must compare qty');

const rpcs = [
  'admin_seller_tariff_plans_list',
  'admin_seller_tariff_plan_upsert',
  'admin_seller_tariff_rates_list',
  'admin_seller_tariff_rate_set',
  'admin_seller_tariff_assignments_list',
  'admin_seller_tariff_assign',
  'admin_seller_rate_overrides_list',
  'admin_seller_rate_override_set',
  'admin_seller_balance',
  'admin_seller_ledger_list',
  'seller_my_balance',
  'seller_my_ledger',
  'admin_seller_cash_payout',
  'admin_seller_cash_advance',
];
for (const name of rpcs) {
  if (!sql.includes(`CREATE OR REPLACE FUNCTION public.${name}`)) fail(`rpc ${name}`);
  if (!sql.includes(`GRANT EXECUTE ON FUNCTION public.${name}`)) fail(`grant ${name}`);
}
if (!sql.includes('REVOKE ALL ON FUNCTION public.seller_commission_require_active_admin() FROM PUBLIC, anon, authenticated, service_role')) {
  fail('helper must not be executable by clients');
}
if (!sql.includes('REVOKE ALL ON FUNCTION public.seller_ledger_post_internal')) {
  fail('internal post must be revoked');
}
if (!sql.includes('REVOKE ALL ON FUNCTION public.seller_ledger_post_accrual_internal')) {
  fail('internal accrual must be revoked');
}
if (!sql.includes('REVOKE ALL ON FUNCTION public.admin_seller_cash_post')) {
  fail('cash_post helper must be revoked');
}
if (sql.includes('p_created_by') || sql.includes('p_actor_id uuid') && sql.includes('admin_seller_cash_payout')) {
  const payout = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.admin_seller_cash_payout'));
  if (payout.includes('p_actor_id')) fail('payout must not accept actor_id from client');
}

const tests = read('scripts/verify_seller_commission_foundation_tests.sql');
if (!tests.includes('SET ROLE authenticated')) fail('harness must SET ROLE authenticated');
if (!tests.includes('double accrual must be rejected')) fail('double accrual test');
if (!tests.includes('double payout with same operation_id must be idempotent')) fail('double payout test');
if (!tests.includes('explicit advance must allow negative balance')) fail('advance negative test');
if (!tests.includes('payout over balance must fail')) fail('over-balance test');
if (!tests.includes('overlapping rate must be rejected')) fail('rate overlap test');
if (!tests.includes('closed interval overlap must be rejected')) fail('closed overlap test');
if (!tests.includes('NULL rate must be rejected')) fail('NULL rate test');
if (!tests.includes('known zero rate must not be missing_rate')) fail('zero vs missing test');
if (!tests.includes('manager must not set rates')) fail('manager rate denial');
if (!tests.includes('manager must not create payout')) fail('manager payout denial');
if (!tests.includes('seller must not create payout')) fail('seller payout denial');
if (!tests.includes('seller must not read others via admin RPC')) fail('seller isolation');
if (!tests.includes('authenticated must not call seller_ledger_post_internal')) fail('internal RPC bypass test');
if (!tests.includes('same operation_id different comment must fail')) fail('idempotency payload test');
if (!tests.includes('same operation_id different actor must fail')) fail('idempotency actor test');
if (!tests.includes('ledger must be append-only')) fail('append-only test');
if (/^\s*COMMIT;/m.test(tests)) fail('harness tests must not commit');

const pre = read('supabase/prod/pre_apply_inspect_block5173a.sql');
const post = read('supabase/prod/post_apply_verify_block5173a.sql');
const apply = read('supabase/prod/apply_block5173a.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight must be SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify must be SELECT-only');
if (!pre.includes('seller_ledger_absent_before_apply')) fail('preflight absent ledger');
if (!pre.includes('confirm_order.present')) fail('preflight confirm_order');
if (!pre.includes('cancel_order.present')) fail('preflight cancel_order');
if (!post.includes('authenticated.seller_ledger.select')) fail('postflight table grant');
if (!post.includes('service_role.seller_ledger.insert')) fail('postflight service_role table');
if (!post.includes('payout.service_role_execute')) fail('postflight service_role execute');
if (!post.includes('helper.authenticated_execute')) fail('postflight helper execute');
if (!post.includes('accrual_item_unique')) fail('postflight unique');
if (!post.includes('assignments_open_unique')) fail('postflight open unique');
if (!post.includes('create.row_security_off')) fail('postflight row_security');
if (!post.includes('confirm_order.untouched')) fail('postflight confirm_order untouched');
if (!post.includes('cancel_order.untouched')) fail('postflight cancel_order untouched');
if (!apply.includes('run_seller_commission_foundation.sql')) fail('apply doc runner');
if (!apply.includes('Не применять без отдельного разрешения')) fail('apply doc must stay blocked');
if (!apply.includes('backup_main.ps1')) fail('apply doc backup command');
if (!apply.includes('pre_apply_inspect_block5173a.sql')) fail('apply doc preflight');
if (!apply.includes('post_apply_verify_block5173a.sql')) fail('apply doc postflight');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const migrationBody = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const harness = `BEGIN;\n${stubs}\n${migrationBody}\n${tests}\nROLLBACK;\n`;
if (!harness.includes('ROLLBACK;')) fail('harness must roll back');

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
    const dir = mkdtempSync(join(tmpdir(), 'seller-commission-'));
    const file = join(dir, 'harness.sql');
    writeFileSync(file, harness, 'utf8');
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const out = runPsqlFile(uri, file);
    psqlRan = true;
    if (/ERROR:/i.test(out)) fail(`psql reported error: ${out.slice(-500)}`);

    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5173b_audit';
    try {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    } catch {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName};`);
    }
    runPsqlC(adminUri, `CREATE DATABASE ${dbName};`);
    const auditUri = uri.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    try {
      const rollbackFile = join(dir, 'rollback.sql');
      writeFileSync(
        rollbackFile,
        `BEGIN;\n${stubs}\n${migrationBody}\nDO $$ BEGIN RAISE EXCEPTION 'rollback_probe'; END $$;\nROLLBACK;\n`,
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
      const leftover = runPsqlC(
        auditUri,
        "SELECT COALESCE(to_regclass('public.seller_ledger')::text, 'absent');",
      );
      if (leftover !== 'absent') fail(`rollback left seller_ledger as ${leftover}`);
      rollbackRan = true;

      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${stubs}\n${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      runPsqlC(
        auditUri,
        `SELECT public.seller_ledger_post_internal(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0090'::uuid,
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
          'adjustment', 400, NULL, NULL, NULL, NULL, NULL, NULL,
          false, NULL, NULL, now(),
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'seed race');`,
      );

      const payoutSql = (op: string) =>
        `BEGIN; ${adminJwtSql} SELECT pg_sleep(1); SELECT public.admin_seller_cash_payout('${op}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 400, 'race'); COMMIT;`;
      const [a, b] = await Promise.all([
        spawnPsqlC(auditUri, payoutSql('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0aa1')),
        spawnPsqlC(auditUri, payoutSql('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0aa2')),
      ]);
      const texts = [a, b].map((r) => `${r.stdout}\n${r.stderr}`);
      const success = [a, b].filter((r) => r.status === 0).length;
      const exceeded = texts.filter((t) => /Payout exceeds available balance/i.test(t)).length;
      if (success !== 1 || exceeded !== 1) {
        fail(
          `concurrent payout expected 1 success + 1 over-balance, got success=${success} exceeded=${exceeded} a=${texts[0].slice(-400)} b=${texts[1].slice(-400)}`,
        );
      }
      const payoutCount = runPsqlC(
        auditUri,
        "SELECT count(*)::text FROM public.seller_ledger WHERE seller_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND entry_type = 'cash_payout';",
      );
      const bal = runPsqlC(
        auditUri,
        "SELECT public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')::text;",
      );
      if (payoutCount !== '1') fail(`concurrent payout wrote ${payoutCount} rows`);
      if (bal !== '0.00' && bal !== '0') fail(`concurrent payout left balance ${bal}`);

      const planId = runPsqlC(auditUri, "SELECT id::text FROM public.seller_tariff_plans WHERE code = 'A';");
      const assignSql =
        `BEGIN; ${adminJwtSql} SELECT pg_sleep(1); SELECT public.admin_seller_tariff_assign('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid, '${planId}'::uuid, TIMESTAMPTZ '2026-06-01 00:00:00+00'); COMMIT;`;
      const [c, d] = await Promise.all([
        spawnPsqlC(auditUri, assignSql),
        spawnPsqlC(auditUri, assignSql),
      ]);
      if (c.status !== 0 || d.status !== 0) {
        fail(`parallel assign failed c=${c.stderr} d=${d.stderr}`);
      }
      const openAssign = runPsqlC(
        auditUri,
        "SELECT count(*)::text FROM public.seller_tariff_assignments WHERE seller_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' AND effective_to IS NULL;",
      );
      const allAssign = runPsqlC(
        auditUri,
        "SELECT count(*)::text FROM public.seller_tariff_assignments WHERE seller_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';",
      );
      if (openAssign !== '1') fail(`parallel assign left ${openAssign} open rows`);
      if (allAssign !== '1') fail(`parallel assign wrote ${allAssign} rows`);
      concurrentRan = true;
    } finally {
      try {
        runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
      } catch {
        try {
          runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName};`);
        } catch {
          /* ignore cleanup */
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
      ? `seller-commission-foundation checks ok (sql harness passed; concurrent=${concurrentRan}; remigrate=${remigrateRan}; rollback=${rollbackRan})`
      : 'seller-commission-foundation checks ok (static)',
  );
}

void main();
