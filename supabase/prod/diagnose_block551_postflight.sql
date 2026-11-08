-- Read-only diagnostics for 5.5.1 postflight FAILs. No DDL/DML.
-- Do not apply hotfix from this file.

-- 1) Amount CHECK: Postgres stores numeric literals as (0)::numeric,
-- so ILIKE '%amount > 0%' misses CHECK ((amount > (0)::numeric)).
SELECT
  c.conname,
  c.contype,
  pg_get_constraintdef(c.oid) AS def
FROM pg_constraint c
WHERE c.conrelid = 'public.finance_expenses'::regclass
ORDER BY c.contype, c.conname;

-- 2) Admin gate: exception text lives in finance_require_active_admin, not in create RPC body.
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  (pg_get_functiondef(p.oid) LIKE '%finance_require_active_admin%') AS calls_require_admin,
  (pg_get_functiondef(p.oid) LIKE '%Finance permission denied%') AS has_denied_text,
  (pg_get_functiondef(p.oid) LIKE '%Account is inactive%') AS has_inactive_text,
  (pg_get_functiondef(p.oid) LIKE '%v_uid := public.finance_require_active_admin()%') AS assigns_require_admin
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('admin_finance_expense_create', 'finance_require_active_admin')
ORDER BY p.proname;

-- 3) service_role grants vs trigger. Direct ACL, not inherited role names.
SELECT
  CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
  a.privilege_type::text AS privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) a ON true
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public'
  AND c.relname = 'finance_expense_events'
ORDER BY 1, 2;

SELECT
  rolname,
  rolsuper,
  rolbypassrls
FROM pg_roles
WHERE rolname IN ('service_role', 'authenticator', 'anon', 'authenticated', 'postgres')
ORDER BY rolname;

SELECT
  r.rolname AS member,
  m.rolname AS member_of
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.member
JOIN pg_roles m ON m.oid = am.roleid
WHERE r.rolname = 'service_role' OR m.rolname = 'service_role'
ORDER BY 1, 2;

SELECT
  t.tgname,
  t.tgtype,
  pg_get_triggerdef(t.oid) AS def,
  p.proname AS fn
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.finance_expense_events'::regclass
  AND NOT t.tgisinternal
ORDER BY t.tgname;

SELECT
  has_table_privilege('service_role', 'public.finance_expense_events', 'SELECT') AS service_select,
  has_table_privilege('service_role', 'public.finance_expense_events', 'INSERT') AS service_insert,
  has_table_privilege('service_role', 'public.finance_expense_events', 'UPDATE') AS service_update,
  has_table_privilege('service_role', 'public.finance_expense_events', 'DELETE') AS service_delete,
  has_table_privilege('authenticated', 'public.finance_expense_events', 'UPDATE') AS auth_update,
  has_table_privilege('authenticated', 'public.finance_expense_events', 'DELETE') AS auth_delete;
