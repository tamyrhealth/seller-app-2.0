import { readFileSync } from 'fs';
import { join } from 'path';
import { homePathForRole, isAssistantRole, roleMatches } from '../lib/roles';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const sql = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20261103250000_manager_assistant_chats.sql'),
  'utf8'
);
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration must be transactional');
if (!sql.includes("'manager'::text")) fail('role check must allow manager');
if (!sql.includes('can_cancel_orders')) fail('manager cancel flag');
if (!sql.includes('assistant_chats') || !sql.includes('assistant_messages')) fail('chat tables');
if (!sql.includes('client_message_id')) fail('message idempotency');
if (!sql.includes("role = 'user'")) fail('RLS must allow only user-authored inserts');
if (!sql.includes('owner_id = auth.uid()')) fail('chats are owner-scoped');
if (!sql.includes('is_admin()')) fail('admin audit helper');
if (!sql.includes("v_role IN ('admin', 'manager')")) fail('confirm_order must accept manager');
if (!sql.includes('Seller not found')) fail('manager cannot invent a seller id');
if (!sql.includes('s.city_id = v_city_id')) fail('staff order city must match seller city');
if (!sql.includes("role = 'user'")) fail('cannot insert assistant-authored messages from client');
if (!sql.includes('Cannot reassign chat owner')) fail('owner_id must be frozen');
if (!sql.includes('profiles_prevent_privilege_escalation')) fail('must block self-promotion');
if (/CREATE OR REPLACE FUNCTION public\.apply_order_cancel/i.test(sql)) {
  fail('5.1 must not grant manager cancel via apply_order_cancel');
}
if (!sql.includes('pg_advisory_xact_lock')) fail('confirm_order must keep advisory locks');
if (!sql.includes('qty_on_hand >= v_need')) fail('confirm_order must keep stock guard');
if (!sql.includes('orders_idempotency_actor_key_uidx')) fail('confirm_order must keep idempotency conflict handling');
if (/UPDATE\s+public\.profiles\s+SET/i.test(sql)) fail('must not rewrite existing profiles');
if (/DELETE\s+FROM\s+public\.(profiles|orders|inventory)/i.test(sql)) fail('must not delete business rows');
if (!sql.includes('GRANT EXECUTE ON FUNCTION public.confirm_order')) fail('confirm_order execute grant');
if (!sql.includes('is_manager() AND role = \'seller\'')) fail('manager may list sellers only');

const runSql = readFileSync(
  join(process.cwd(), 'supabase', 'run_manager_assistant_chats.sql'),
  'utf8'
);
for (const needle of [
  'Cannot reassign chat owner',
  'profiles_prevent_privilege_escalation',
  's.city_id = v_city_id',
  "v_role IN ('admin', 'manager')",
  'is_assistant_user() AND owner_id = auth.uid()',
]) {
  if (!runSql.includes(needle)) fail(`run_manager_assistant_chats.sql missing ${needle}`);
}

const verify = readFileSync(
  join(process.cwd(), 'supabase', 'prod', 'post_apply_verify_block51.sql'),
  'utf8'
);
const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) {
  fail('post_apply_verify_block51.sql must be SELECT-only');
}

if (!isAssistantRole('admin') || !isAssistantRole('manager')) fail('assistant roles');
if (isAssistantRole('seller')) fail('seller is not assistant');
if (homePathForRole('manager') !== '/manager') fail('manager home');
if (homePathForRole('seller') !== '/seller') fail('seller home');
if (!roleMatches(['admin', 'manager'], 'manager')) fail('protected roles list');
if (roleMatches('admin', 'manager')) fail('manager is not admin');

console.log('OK');
