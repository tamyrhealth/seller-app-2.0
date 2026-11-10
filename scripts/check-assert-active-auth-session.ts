import { execFileSync } from 'child_process';
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

const mig1 = 'supabase/migrations/20261110210000_assert_active_auth_session.sql';
const run1 = 'supabase/run_assert_active_auth_session.sql';
const mig2 = 'supabase/migrations/20261110220000_assert_active_auth_session_enforce.sql';
const run2 = 'supabase/run_assert_active_auth_session_enforce.sql';
if (!existsSync(join(process.cwd(), mig1))) fail('phase1 migration missing');
if (!existsSync(join(process.cwd(), mig2))) fail('phase2 migration missing');
if (read(mig1) !== read(run1)) fail('phase1 run SQL must match migration');
if (read(mig2) !== read(run2)) fail('phase2 run SQL must match migration');
const sql1 = read(mig1);
const sql2 = read(mig2);
if (!/^BEGIN;/m.test(sql1) || !/^COMMIT;/m.test(sql1)) fail('phase1 transactional');
if (!/^BEGIN;/m.test(sql2) || !/^COMMIT;/m.test(sql2)) fail('phase2 transactional');
if (/DELETE\s+FROM\s+auth\.(sessions|refresh_tokens)/i.test(sql1 + sql2)) fail('must not delete auth.sessions');
if (!sql1.includes('claim_active_auth_session')) fail('claim rpc');
if (!sql1.includes('FOR UPDATE')) fail('claim must lock the session row');
if (sql1.includes('auth_session_guard_wrap')) fail('phase1 must not wrap RPCs');
if (sql1.includes('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.user_active_sessions')) {
  fail('phase1 must keep old-client session writes');
}
if (!sql2.includes('auth_session_guard_apply')) fail('phase2 apply/repair');
if (!sql2.includes('auth_session_guard_integrity')) fail('phase2 integrity');
if (!sql2.includes('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.user_active_sessions')) {
  fail('phase2 revoke client session writes');
}
if (!sql2.includes('auth_session_guard_products')) fail('products trigger');
if (sql2.includes('is_active_admin') && /auth_session_guard_wrap\('public\.is_active_admin/i.test(sql2)) {
  fail('must not wrap SELECT helper is_active_admin');
}

const tests = read('scripts/verify_assert_active_auth_session_tests.sql');
if (!tests.includes('first login must be allowed')) fail('first login test');
if (!tests.includes('same session re-claim')) fail('two tabs test');
if (!tests.includes('older JWT must not steal claim')) fail('takeover test');
if (!tests.includes('direct RPC with old JWT must fail')) fail('direct rpc test');
if (!tests.includes('authenticated must not insert user_active_sessions')) fail('session table write test');
if (!tests.includes('mutate without session_id must fail closed')) fail('missing session_id test');
if (!tests.includes('commission retry stub must still run')) fail('commission regression test');
if (!tests.includes('authenticated must not execute confirm_order__session_body')) fail('body bypass test');
if (!tests.includes('integrity must detect missing assert')) fail('create or replace detector');
if (!tests.includes('apply must restore wrappers')) fail('repair after replace');
if (/^\s*COMMIT;/m.test(tests)) fail('tests must not commit');

const stubs = read('scripts/verify_assert_active_auth_session_stubs.sql');
if (!stubs.includes('CREATE TABLE IF NOT EXISTS auth.sessions')) fail('auth.sessions stub');
if (!stubs.includes('CREATE OR REPLACE FUNCTION public.confirm_order')) fail('confirm_order stub');

const pre = read('supabase/prod/pre_apply_inspect_block5196a.sql');
const post1 = read('supabase/prod/post_apply_verify_block5196c_phase1.sql');
const post2 = read('supabase/prod/post_apply_verify_block5196c_phase2.sql');
const apply = read('supabase/prod/apply_block5196b.md');
const rollback = read('supabase/prod/rollback_block5196a.sql');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const post1Bare = post1.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const post2Bare = post2.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(post1Bare)) fail('phase1 postflight SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(post2Bare)) fail('phase2 postflight SELECT-only');
if (!pre.includes('confirm_order.present')) fail('preflight confirm_order');
if (post1Bare.includes("::regprocedure")) fail('phase1 postflight must not cast missing funcs');
if (post2Bare.includes("::regprocedure")) fail('phase2 postflight must not cast missing funcs');
if (!post1.includes('confirm_order.unwrapped')) fail('phase1 expects unwrapped confirm_order');
if (!post1.includes("sessions.authenticated_insert")) fail('phase1 insert check');
if (!post1.includes("'true'")) fail('phase1 keeps old-client insert');
if (!post2.includes('confirm_order.wrapped')) fail('phase2 wrapped');
if (!post2.includes('confirm_order.body_present')) fail('phase2 body');
if (!post2.includes('is_active_admin.unwrapped')) fail('phase2 select helper');
if (!apply.includes('post_apply_verify_block5196c_phase1.sql')) fail('apply phase1 postflight');
if (!apply.includes('post_apply_verify_block5196c_phase2.sql')) fail('apply phase2 postflight');
if (!apply.includes('Не запускать этот SQL на Production')) fail('apply blocked');
if (!apply.includes('run_assert_active_auth_session.sql')) fail('apply phase1 runner');
if (!apply.includes('run_assert_active_auth_session_enforce.sql')) fail('apply phase2 runner');
if (!apply.includes("signOut({ scope: 'others' })")) fail('official others signOut');
if (!rollback.includes('__session_body')) fail('rollback unwrap');
if (!rollback.includes('GRANT SELECT, INSERT, UPDATE ON TABLE public.user_active_sessions')) {
  fail('rollback restores old-client upsert');
}
if (!rollback.includes('REVOKE DELETE, TRUNCATE ON TABLE public.user_active_sessions')) {
  fail('rollback must not grant DELETE');
}
if (/DELETE\s+FROM\s+auth\.(sessions|refresh_tokens)/i.test(rollback)) fail('rollback must not delete auth.sessions');

const client = read('lib/auth.tsx');
if (!client.includes('claimActiveAuthSession')) fail('auth awaits claim');
if (!client.includes('revokeOtherAuthSessions')) fail('auth revokes others via API');
if (client.includes('syncActiveSession')) fail('must not upsert device_id');
if (!client.includes("claimed === 'allowed'")) fail('revoke others only after allowed claim');
if (!client.includes("scope: 'local'")) fail('denied uses local signOut');

const active = read('lib/activeSession.ts');
if (!active.includes("supabase.rpc('claim_active_auth_session')")) fail('claim rpc client');
if (!active.includes("supabase.rpc('check_active_auth_session')")) fail('check rpc client');
if (!active.includes("signOut({ scope: 'others' })")) fail('others scope');
if (active.includes(".from('user_active_sessions')")) fail('client must not write sessions table');
if (!active.includes('mapAuthSessionRpcResult')) fail('missing-rpc mapping');

const protectedUi = read('components/Protected.tsx');
if (!protectedUi.includes('claimActiveAuthSession')) fail('retry claims');
if (!protectedUi.includes("status === 'unknown'")) fail('unknown branch');

const ensure = read('lib/useEnsureActiveDevice.ts');
if (ensure.includes('claimActiveAuthSession')) fail('ensure must not claim/take over');
if (!ensure.includes("status === 'unknown'")) fail('ensure unknown');

let psqlRan = false;
let remigrateRan = false;
let rollbackRan = false;
let testsRan = false;
let postRan = false;

async function main() {
  try {
    if (!psqlBin) {
      console.log('SQL harness skipped (psql not available)');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'auth-sess-5196a-'));
    const uri = process.env.LOCAL_PG_URI || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
    const adminUri = uri.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const dbName = 'seller_app_5196a_audit';
    try {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    } catch {
      runPsqlC(adminUri, `DROP DATABASE IF EXISTS ${dbName};`);
    }
    runPsqlC(adminUri, `CREATE DATABASE ${dbName};`);
    const auditUri = uri.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    try {
      writeFileSync(join(dir, 'stubs.sql'), stubs, 'utf8');
      runPsqlFile(auditUri, join(dir, 'stubs.sql'));
      psqlRan = true;

      writeFileSync(join(dir, 'phase1.sql'), `${sql1}\n`, 'utf8');
      runPsqlFile(auditUri, join(dir, 'phase1.sql'));
      const wrappedBefore = runPsqlC(
        auditUri,
        "SELECT CASE WHEN pg_get_functiondef('public.confirm_order(jsonb)'::regprocedure) LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped' ELSE 'plain' END;",
      );
      if (wrappedBefore !== 'plain') fail('phase1 must leave confirm_order unwrapped');
      const insertAfter1 = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.user_active_sessions', 'INSERT');",
      );
      if (insertAfter1 !== 't') fail('phase1 must keep old-client INSERT on sessions');

      writeFileSync(join(dir, 'post1.sql'), `${post1}\n`, 'utf8');
      const post1Out = runPsqlFile(auditUri, join(dir, 'post1.sql'));
      if (/FAIL/i.test(post1Out)) fail(`phase1 postflight FAIL: ${post1Out.slice(-1500)}`);
      if (/ERROR|ОШИБКА/i.test(post1Out)) fail(`phase1 postflight error: ${post1Out.slice(-800)}`);

      const body2 = sql2.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;\s*$/m, '\n');
      writeFileSync(
        join(dir, 'rollback-probe.sql'),
        `BEGIN;\n${body2}\nDO $$ BEGIN RAISE EXCEPTION 'rollback_probe'; END $$;\nROLLBACK;\n`,
        'utf8',
      );
      try {
        runPsqlFile(auditUri, join(dir, 'rollback-probe.sql'));
        fail('rollback probe must raise');
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const detail = `${e.stderr || ''} ${e.message || ''}`;
        if (!/rollback_probe/i.test(detail)) fail(`rollback probe unexpected: ${detail.slice(-800)}`);
      }
      const stillPlain = runPsqlC(
        auditUri,
        "SELECT CASE WHEN pg_get_functiondef('public.confirm_order(jsonb)'::regprocedure) LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped' ELSE 'plain' END;",
      );
      if (stillPlain !== 'plain') fail('phase2 rollback probe must not leave wrappers');
      rollbackRan = true;

      writeFileSync(join(dir, 'phase2.sql'), `${sql2}\n`, 'utf8');
      runPsqlFile(auditUri, join(dir, 'phase2.sql'));
      runPsqlFile(auditUri, join(dir, 'phase2.sql'));
      remigrateRan = true;

      writeFileSync(join(dir, 'post2.sql'), `${post2}\n`, 'utf8');
      const postOut = runPsqlFile(auditUri, join(dir, 'post2.sql'));
      if (/FAIL/i.test(postOut)) fail(`phase2 postflight FAIL: ${postOut.slice(-1500)}`);
      postRan = true;

      writeFileSync(join(dir, 'tests.sql'), `BEGIN;\n${tests}\nROLLBACK;\n`, 'utf8');
      runPsqlFile(auditUri, join(dir, 'tests.sql'));
      testsRan = true;

      writeFileSync(join(dir, 'rollback.sql'), rollback, 'utf8');
      runPsqlFile(auditUri, join(dir, 'rollback.sql'));
      const claimAfterRb = runPsqlC(
        auditUri,
        "SELECT CASE WHEN to_regprocedure('public.claim_active_auth_session()') IS NULL THEN 'absent' ELSE 'present' END;",
      );
      if (claimAfterRb !== 'absent') fail('rollback file must drop claim');
      const bodyGone = runPsqlC(
        auditUri,
        "SELECT CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NULL THEN 'absent' ELSE 'present' END;",
      );
      if (bodyGone !== 'absent') fail('rollback must restore confirm_order name');
      const delAfter = runPsqlC(
        auditUri,
        "SELECT has_table_privilege('authenticated', 'public.user_active_sessions', 'DELETE');",
      );
      if (delAfter !== 'f') fail('rollback must not grant DELETE on sessions');
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
      fail(`SQL harness failed: ${detail.slice(-2500)}`);
    } else {
      console.log('SQL harness skipped (psql not available)');
    }
  }

  if (psqlRan && !rollbackRan) fail('rollback probe did not run');
  if (psqlRan && !remigrateRan) fail('remigrate did not run');
  if (psqlRan && !postRan) fail('postflight did not run');
  if (psqlRan && !testsRan) fail('sql tests did not run');

  console.log(
    psqlRan
      ? `assert-active-auth-session checks ok (rollback=${rollbackRan}; remigrate=${remigrateRan}; post=${postRan}; tests=${testsRan})`
      : 'assert-active-auth-session checks ok (static)',
  );
}

void main();
