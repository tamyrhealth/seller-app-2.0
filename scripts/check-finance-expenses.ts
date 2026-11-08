import { readFileSync } from 'fs';
import { join } from 'path';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const sql = read('supabase/migrations/20261108140000_finance_expenses.sql');
const runSql = read('supabase/run_finance_expenses.sql');
if (sql !== runSql) fail('run SQL must match migration');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration transactional');
if (/CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(sql)) fail('must not rewrite confirm_order');
if (/CREATE OR REPLACE FUNCTION public\.apply_inventory_restock/i.test(sql)) fail('must not rewrite restock');
if (/CREATE OR REPLACE FUNCTION public\.apply_order_cancel/i.test(sql)) fail('must not rewrite cancel');
if (/UPDATE\s+public\.products/i.test(sql) || /ALTER TABLE public\.products/i.test(sql)) {
  fail('must not touch product cost');
}
if (/INSERT\s+INTO\s+public\.inventory/i.test(sql)) fail('must not write inventory');
if (/UPDATE\s+public\.orders/i.test(sql)) fail('must not write orders');

for (const cat of [
  'logistics',
  'cargo_customs',
  'ads',
  'rent',
  'tax',
  'salary',
  'seller_payout',
  'bonus',
  'other',
]) {
  if (!sql.includes(`'${cat}'`)) fail(`category ${cat}`);
}

if (!sql.includes('CREATE TABLE IF NOT EXISTS public.finance_expenses')) fail('expenses table');
if (!sql.includes('CREATE TABLE IF NOT EXISTS public.finance_expense_events')) fail('audit events table');
if (!sql.includes('CONSTRAINT finance_expenses_amount_positive CHECK (amount > 0)')) fail('amount > 0');
if (!sql.includes('CONSTRAINT finance_expenses_operation_id_key UNIQUE (operation_id)')) fail('unique operation_id');
if (!sql.includes('deleted_at timestamptz')) fail('soft delete column');
if (!sql.includes('created_by uuid NOT NULL')) fail('created_by required');
if (!sql.includes('REFERENCES public.finance_expense_categories(code)')) fail('extensible categories FK');
if (!sql.includes('city_id uuid REFERENCES public.cities(id)')) fail('nullable city FK');

if (!sql.includes('REVOKE ALL ON TABLE public.finance_expenses FROM PUBLIC, anon, authenticated')) {
  fail('revoke table from clients');
}
if (!sql.includes('REVOKE ALL ON TABLE public.finance_expense_events FROM PUBLIC, anon, authenticated')) {
  fail('revoke events from clients');
}
if (/GRANT SELECT ON TABLE public\.finance_expenses TO authenticated/i.test(sql)) {
  fail('must not grant table SELECT to authenticated');
}
if (!sql.includes('ALTER TABLE public.finance_expenses ENABLE ROW LEVEL SECURITY')) fail('RLS');
if (!sql.includes('ALTER TABLE public.finance_expenses FORCE ROW LEVEL SECURITY')) fail('FORCE RLS');
if (!sql.includes('finance_expenses_admin_delete') || !sql.includes('USING (false)')) {
  fail('hard DELETE policy must deny');
}
if (!sql.includes('WITH CHECK (public.is_active_admin() AND created_by = auth.uid())')) {
  fail('insert policy must bind created_by to auth.uid');
}

if (!sql.includes('Finance expense identity fields are immutable')) fail('immutable identity trigger');
if (!sql.includes('Finance expenses cannot be hard-deleted')) fail('block hard delete trigger');
if (!sql.includes('SET search_path = public')) fail('search_path');
if (!sql.includes('SET row_security = off')) fail('definer row_security off');
if (!sql.includes('Finance permission denied')) fail('non-admin denial');
if (!sql.includes('Account is inactive')) fail('inactive admin denial');
if (!sql.includes('Idempotency key reused with a different payload')) fail('idempotency conflict');
if (!sql.includes('RETURN public.finance_expense_to_json(v_existing)')) fail('idempotent return existing');
if (!sql.includes("action text NOT NULL CHECK (action = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text]))")) {
  fail('audit actions');
}

const rpcs = [
  'admin_finance_expense_create',
  'admin_finance_expenses_list',
  'admin_finance_expense_update',
  'admin_finance_expense_delete',
  'admin_finance_expense_events',
];
for (const name of rpcs) {
  if (!sql.includes(`CREATE OR REPLACE FUNCTION public.${name}`)) fail(`rpc ${name}`);
  if (!sql.includes(`GRANT EXECUTE ON FUNCTION public.${name}`)) fail(`grant ${name} authenticated`);
}
if (!sql.includes('REVOKE ALL ON TABLE public.finance_expense_events FROM service_role')) {
  fail('must revoke default service_role ALL before narrow events grant');
}
if (!sql.includes('GRANT SELECT, INSERT ON TABLE public.finance_expense_events TO service_role')) {
  fail('events grant must be select/insert only');
}
if (/GRANT ALL ON TABLE public\.finance_expense_events TO service_role/i.test(sql)) {
  fail('service_role must not UPDATE/DELETE audit events');
}
if (!sql.includes('Finance expense events are immutable')) fail('events immutability trigger');
if (!sql.includes('finance_expense_events_deny_update')) fail('events deny update policy');
if (!sql.includes('WHEN unique_violation')) fail('create must catch unique_violation');
if (!sql.includes('IF OLD.deleted_at IS NOT NULL THEN')) fail('deleted rows must stay frozen');
if (!sql.includes('REVOKE ALL ON FUNCTION public.admin_finance_expense_create(uuid, date, text, numeric, uuid, text) FROM PUBLIC, anon, service_role')) {
  fail('revoke create from anon/service_role');
}
if (!sql.includes('REVOKE ALL ON FUNCTION public.finance_require_active_admin() FROM PUBLIC, anon, authenticated, service_role')) {
  fail('helper must not be executable by clients');
}
if (!sql.includes('created_by, operation_id') || !sql.includes('v_uid, p_operation_id')) {
  fail('create must set created_by from auth.uid');
}
if (sql.includes('p_created_by')) fail('must not accept created_by from client');
if (!sql.includes('SET deleted_at = now()')) fail('soft delete');
if (/DELETE FROM public\.finance_expenses/i.test(sql)) fail('must not hard-delete expense rows');

const pre = read('supabase/prod/pre_apply_inspect_block551.sql');
const post = read('supabase/prod/post_apply_verify_block551.sql');
const apply = read('supabase/prod/apply_block551.md');
const verify = read('scripts/verify_finance_expenses.sql');
const preBare = pre.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
const postBare = post.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(preBare)) fail('preflight must be SELECT-only');
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(postBare)) fail('verify must be SELECT-only');
if (!pre.includes('finance_expenses_absent_before_apply')) fail('preflight absent table');
if (!pre.includes('confirm_order.present')) fail('preflight confirm_order');
if (!post.includes('authenticated.finance_expenses.select')) fail('postflight table grant');
if (!post.includes('create.service_role_execute')) fail('postflight service_role execute');
if (!post.includes('helper.authenticated_execute')) fail('postflight helper execute');
if (!post.includes('operation_id_unique')) fail('postflight unique');
if (!post.includes('soft_delete.not_hard')) fail('postflight soft delete');
if (!post.includes('create.row_security_off')) fail('postflight row_security');
if (!post.includes('amount\\s*>\\s*\\(?0') && !post.includes("amount\\s*>\\s*\\(?0")) {
  fail('postflight amount check must allow (0)::numeric');
}
if (!post.includes("LIKE '%finance_require_active_admin%'")) fail('postflight must follow admin helper chain');
const diagnose = read('supabase/prod/diagnose_block551_postflight.sql');
const hotfix = read('supabase/prod/hotfix_block551_events_grants.sql');
const diagnoseBare = diagnose.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(diagnoseBare)) fail('diagnose must be SELECT-only');
if (!hotfix.includes('REVOKE ALL ON TABLE public.finance_expense_events FROM service_role')) {
  fail('hotfix must revoke leftover service_role ALL');
}
if (/confirm_order/i.test(hotfix) && /CREATE OR REPLACE FUNCTION public\.confirm_order/i.test(hotfix)) {
  fail('hotfix must not rewrite confirm_order');
}
if (!post.includes('events_immutable_trigger')) fail('postflight events trigger');
if (!post.includes('service_role.events.update')) fail('postflight events grants');
if (!post.includes('create.unique_violation_retry')) fail('postflight unique retry');
if (!pre.includes('admin_finance_expense_update_absent_before_apply')) fail('preflight update rpc');
if (!pre.includes('admin_finance_expense_events_absent_before_apply')) fail('preflight events rpc');
if (!apply.includes('run_finance_expenses.sql')) fail('apply doc runner');
if (!apply.includes('pre_apply_inspect_block551.sql')) fail('apply doc preflight');
if (!apply.includes('Не DROP `confirm_order`')) fail('apply doc rollback caution');

if (!verify.includes('SET ROLE authenticated')) fail('harness must SET ROLE authenticated');
if (!verify.includes('seller must not create finance expense')) fail('seller denial test');
if (!verify.includes('manager must not list finance expenses')) fail('manager list denial');
if (!verify.includes('manager must not update finance expense')) fail('manager update denial');
if (!verify.includes('manager must not delete finance expense')) fail('manager delete denial');
if (!verify.includes('seller direct SELECT must fail')) fail('seller direct query test');
if (!verify.includes('inactive admin must not create finance expense')) fail('inactive admin test');
if (!verify.includes('idempotent create must return the same row')) fail('idempotency test');
if (!verify.includes('created_by must be auth.uid')) fail('created_by spoof test');
if (!verify.includes('soft delete must set deleted_at')) fail('soft delete test');
if (!verify.includes('audit must keep create/update/delete')) fail('audit test');
if (!verify.includes('events must be immutable')) fail('events immutability test');
if (!verify.includes('ROLLBACK;')) fail('harness must roll back');
if (/^\s*COMMIT;/m.test(verify)) fail('harness must not commit');

console.log('finance-expenses checks ok');
