import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { asSellerGoodsIssue, parseQty, rpcItems } from '../lib/sellerCommission';

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

if (parseQty('').kind !== 'empty') fail('empty qty');
if (parseQty('0').kind !== 'invalid') fail('zero qty invalid');
if (parseQty('2,5').kind !== 'value') fail('comma qty');
const sample = asSellerGoodsIssue({
  id: 'i',
  seller_id: 's',
  credit_amount: 10,
  cost_total: 4,
  issue_kind: 'settlement',
  status: 'issued',
  items: [{ product_id: 'p', qty: 1, unit_credit_amount: 10, line_credit_amount: 10 }],
});
if (!sample || sample.credit_amount !== 10 || sample.items.length !== 1) fail('asSellerGoodsIssue');
if (rpcItems({ items: [1] }).length !== 1) fail('rpc items');

const mig = 'supabase/migrations/20261110140000_seller_goods_issue_rpcs.sql';
const run = 'supabase/run_seller_goods_issue_rpcs.sql';
if (!existsSync(join(process.cwd(), mig))) fail('migration missing');
if (read(mig) !== read(run)) fail('run SQL must match migration');
const sql = read(mig);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('transactional');
if (/CREATE TABLE/i.test(sql)) fail('must not create tables');
if (/CREATE OR REPLACE FUNCTION public\.(confirm_order|fulfill_preorder|cancel_order)/i.test(sql)) {
  fail('must not rewrite order RPCs');
}
if (/INSERT\s+INTO\s+public\.finance_expenses/i.test(sql)) fail('must not write finance_expenses');
if (/INSERT\s+INTO\s+public\.orders\b/i.test(sql)) fail('must not write orders');
if (!sql.includes('admin_seller_goods_issue')) fail('issue rpc');
if (!sql.includes('admin_seller_goods_advance')) fail('advance rpc');
if (!sql.includes('admin_seller_goods_return')) fail('return rpc');
if (!sql.includes('Physical receipt must be confirmed')) fail('physical receipt');
if (!sql.includes('pg_advisory_xact_lock(51730312')) fail('seller lock');
if (!sql.includes("hashtext('inv:'")) fail('inventory lock');
if (!sql.includes('seller_goods_out')) fail('out movement');
if (!sql.includes('seller_goods_in')) fail('in movement');
if (!sql.includes("format_goods_issue_number")) fail('GI number');
if (!sql.includes('Product cost is required')) fail('missing cost');
if (!sql.includes('SET row_security = off')) fail('row_security');
if (!sql.includes('REVOKE ALL ON FUNCTION public.admin_seller_goods_issue_post')) fail('revoke post');
if (!sql.includes('updated_at = now()')) fail('inventory updated_at');
if (!sql.includes('p_include_cost')) fail('cost visibility flag');
if (!sql.includes('WHEN unique_violation THEN')) fail('unique_violation handler');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.admin_seller_goods_issue')) fail('grant issue');

const tests = read('scripts/verify_seller_goods_issue_tests.sql');
if (!tests.includes('same payload must be idempotent')) fail('idempotent');
if (!tests.includes('different payload must fail')) fail('changed payload');
if (!tests.includes('advance must allow negative balance')) fail('advance');
if (!tests.includes('insufficient stock must fail')) fail('stock');
if (!tests.includes('missing cost must fail')) fail('cost test');
if (!tests.includes('repeat reverse must fail')) fail('repeat return');
if (!tests.includes('manager must not create goods issue')) fail('manager');
if (!tests.includes('seller must not create goods issue')) fail('seller mutate');
if (!tests.includes('must not write finance_expenses')) fail('pnl isolation');
if (!tests.includes('must not change orders')) fail('orders isolation');
if (!tests.includes('Physical receipt must be confirmed')) fail('physical test');
if (!tests.includes('zero qty must fail')) fail('zero qty');
if (!tests.includes('negative qty must fail')) fail('negative qty');
if (!tests.includes('reverse order credit')) fail('item order');
if (!tests.includes('return must restore original city')) fail('return city');
if (!tests.includes('balance must equal SUM')) fail('ledger sum');
if (!tests.includes('manager list must not include cost_total')) fail('manager cost hide');
if (!tests.includes('seller list must not include cost_total')) fail('seller cost hide');
if (/^\s*COMMIT;/m.test(tests)) fail('tests must not commit');

const adminPage = read('app/admin/seller-goods/page.tsx');
const managerPage = read('app/manager/seller-goods/page.tsx');
const sellerPage = read('app/seller/goods/page.tsx');
const view = read('components/SellerGoodsView.tsx');
const nav = read('components/NavAdmin.tsx');
const navM = read('components/NavManager.tsx');
const navS = read('components/NavSeller.tsx');
const i18n = read('lib/i18n.tsx');
if (!adminPage.includes('Protected role="admin"')) fail('admin protected');
if (!adminPage.includes('canMutate={isAdmin}')) fail('admin mutate guard');
if (!managerPage.includes('Protected role="manager"')) fail('manager protected');
if (!managerPage.includes('canMutate={false}')) fail('manager read only');
if (managerPage.includes('SELLER_GOODS_ISSUE')) fail('manager page must not call issue rpc');
if (!sellerPage.includes('Protected role="seller"')) fail('seller protected');
if (!sellerPage.includes('SELLER_MY_GOODS_ISSUES')) fail('seller self list');
if (sellerPage.includes('SELLER_GOODS_ISSUE') || sellerPage.includes('SELLER_GOODS_RETURN')) {
  fail('seller must not mutate goods');
}
if (!view.includes('runExclusive')) fail('repeat click');
if (!view.includes('advanceOk')) fail('advance confirm');
if (!view.includes('p_received: true')) fail('return received flag');
if (!view.includes('lg:hidden')) fail('mobile cards');
if (!view.includes('duplicateProduct')) fail('duplicate ui');
if (!view.includes('canMutate ? <th')) fail('hide cost from manager table');
if (!read('app/admin/locations/page.tsx').includes('seller_goods_out')) fail('locations movement label');
if (!i18n.includes('sellerGoods.duplicateProduct')) fail('i18n duplicate');
if (!adminPage.includes('overflow-x-hidden')) fail('admin overflow');
if (!managerPage.includes('overflow-x-hidden')) fail('manager overflow');
if (!sellerPage.includes('overflow-x-hidden')) fail('seller overflow');
if (!nav.includes('/admin/seller-goods')) fail('admin nav');
if (!navM.includes('/manager/seller-goods')) fail('manager nav');
if (!navS.includes('/seller/goods')) fail('seller nav');
if (!i18n.includes("'sellerGoods.title': 'Выдача товаров в счёт вознаграждения'")) fail('i18n ru');
if (!i18n.includes("'sellerGoods.title': 'Сыйақы есебіне тауар беру'")) fail('i18n kz');

const pre = read('supabase/prod/pre_apply_inspect_block5176.sql');
const post = read('supabase/prod/post_apply_verify_block5176.sql');
const apply = read('supabase/prod/apply_block5176.md');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify SELECT-only');
if (!pre.includes('goods_issue_rpc_absent_before_apply')) fail('preflight absent');
if (!pre.includes('inventory.qty_on_hand.type')) fail('preflight qty type');
if (!pre.includes('movement_type_check.before')) fail('preflight movement check');
if (!post.includes('goods_post.authenticated_execute')) fail('postflight post revoke');
if (!post.includes('movement_type_check.seller_goods_out')) fail('postflight movement types');
if (!post.includes('inventory.qty_on_hand.unchanged')) fail('postflight qty unchanged');
if (!post.includes('fulfill_preorder.not_replaced')) fail('postflight fulfill');
if (!apply.includes('Не запускать этот SQL на Production')) fail('apply blocked');
if (!apply.includes('run_seller_goods_issue_rpcs.sql')) fail('apply runner');

const stubs = read('scripts/verify_seller_commission_foundation_stubs.sql');
const extraAccrual = read('scripts/verify_seller_commission_accrual_stubs.sql');
const extraBal = read('scripts/verify_seller_commission_balances_stubs.sql');
const extraGoods = read('scripts/verify_seller_goods_issue_stubs.sql');
const foundation = read('supabase/migrations/20261109010000_seller_commission_foundation.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const accrual = read('supabase/migrations/20261110090000_seller_commission_accrual_hooks.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const balances = read('supabase/migrations/20261110120000_seller_commission_balance_rpcs.sql')
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\nCOMMIT;\s*$/m, '\n');
const body = sql.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
const harness = `BEGIN;\n${stubs}\n${foundation}\n${extraAccrual}\n${accrual}\n${extraBal}\n${extraGoods}\n${body}\n${tests}\nROLLBACK;\n`;
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
    const dir = mkdtempSync(join(tmpdir(), 'seller-goods-'));
    const file = join(dir, 'harness.sql');
    writeFileSync(file, harness, 'utf8');
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const out = runPsqlFile(uri, file);
    psqlRan = true;
    if (/ERROR:/i.test(out)) fail(`psql reported error: ${out.slice(-500)}`);

    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5176b_audit';
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
        )}\n${extraBal}\n${read('supabase/migrations/20261110120000_seller_commission_balance_rpcs.sql')}\n${extraGoods}\n`,
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
      const issueLeft = runPsqlC(
        auditUri,
        "SELECT COALESCE(to_regprocedure('public.admin_seller_goods_issue(uuid, uuid, uuid, jsonb, text, timestamptz)')::text, 'absent');",
      );
      if (issueLeft !== 'absent') fail(`rollback left goods issue as ${issueLeft}`);
      rollbackRan = true;

      const applyFile = join(dir, 'apply.sql');
      writeFileSync(applyFile, `${sql}\n`, 'utf8');
      runPsqlFile(auditUri, applyFile);
      runPsqlFile(auditUri, applyFile);
      remigrateRan = true;

      runPsqlC(
        auditUri,
        `UPDATE public.inventory SET qty_on_hand = 5
         WHERE city_id = '11111111-1111-4111-8111-111111111111'
           AND product_id = '99999999-9999-4999-8999-999999999999';
         SELECT public.seller_ledger_post_internal(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6090'::uuid,
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
          'adjustment', 400, NULL, NULL, NULL, NULL, NULL, NULL,
          false, NULL, NULL, now(),
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'seed race');`,
      );
      const issueSql = (op: string) =>
        `BEGIN; ${adminJwtSql} SELECT pg_sleep(1); SELECT public.admin_seller_goods_advance('${op}'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, jsonb_build_array(jsonb_build_object('product_id','99999999-9999-4999-8999-999999999999','qty',5,'unit_credit_amount',80)), 'race', NULL); COMMIT;`;
      const [a, b] = await Promise.all([
        spawnPsqlC(auditUri, issueSql('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6aa1')),
        spawnPsqlC(auditUri, issueSql('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6aa2')),
      ]);
      const texts = [a, b].map((r) => `${r.stdout}\n${r.stderr}`);
      const success = [a, b].filter((r) => r.status === 0).length;
      const stockFail = texts.filter((t) => /Insufficient stock/i.test(t)).length;
      if (success !== 1 || stockFail !== 1) {
        fail(
          `concurrent issue expected 1 success + 1 insufficient stock, got success=${success} stockFail=${stockFail} a=${texts[0].slice(-400)} b=${texts[1].slice(-400)}`,
        );
      }

      runPsqlC(
        auditUri,
        `UPDATE public.inventory SET qty_on_hand = 20
         WHERE city_id = '11111111-1111-4111-8111-111111111111'
           AND product_id = '99999999-9999-4999-8999-999999999999';
         SELECT public.seller_ledger_post_internal(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6091'::uuid,
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
          'adjustment', 400, NULL, NULL, NULL, NULL, NULL, NULL,
          false, NULL, NULL, now(),
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'seed cash race');`,
      );
      const cashSql =
        `BEGIN; ${adminJwtSql} SELECT pg_sleep(1); SELECT public.admin_seller_cash_payout('eeeeeeee-eeee-4eee-8eee-eeeeeeee6cc1'::uuid, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid, 400, 'race cash', TIMESTAMPTZ '2026-05-01 00:00:00+05'); COMMIT;`;
      const goodsSql =
        `BEGIN; ${adminJwtSql} SELECT pg_sleep(1); SELECT public.admin_seller_goods_issue('eeeeeeee-eeee-4eee-8eee-eeeeeeee6aa1'::uuid, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, jsonb_build_array(jsonb_build_object('product_id','99999999-9999-4999-8999-999999999999','qty',1,'unit_credit_amount',400)), 'race goods', NULL); COMMIT;`;
      const [c, d] = await Promise.all([spawnPsqlC(auditUri, cashSql), spawnPsqlC(auditUri, goodsSql)]);
      const texts2 = [c, d].map((r) => `${r.stdout}\n${r.stderr}`);
      const success2 = [c, d].filter((r) => r.status === 0).length;
      const exceeded = texts2.filter((t) => /exceeds available balance/i.test(t)).length;
      if (success2 !== 1 || exceeded !== 1) {
        fail(
          `concurrent cash+goods expected 1 success + 1 over-balance, got success=${success2} exceeded=${exceeded} c=${texts2[0].slice(-400)} d=${texts2[1].slice(-400)}`,
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
      ? `seller-goods-issues checks ok (sql harness passed; concurrent=${concurrentRan}; remigrate=${remigrateRan}; rollback=${rollbackRan})`
      : 'seller-goods-issues checks ok (static)',
  );
}

void main();
