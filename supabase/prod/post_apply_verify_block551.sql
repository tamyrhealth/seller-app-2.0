-- Read-only verify AFTER 5.5.1 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosecdef,
         p.provolatile,
         pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
rpc AS (
  SELECT * FROM fn
  WHERE proname IN (
    'admin_finance_expense_create',
    'admin_finance_expenses_list',
    'admin_finance_expense_update',
    'admin_finance_expense_delete',
    'admin_finance_expense_events',
    'finance_require_active_admin',
    'finance_expense_to_json',
    'is_active_admin'
  )
),
guc AS (
  SELECT p.proname, c AS cfg
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c ON true
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'admin_finance_expense_create',
      'admin_finance_expenses_list',
      'admin_finance_expense_update',
      'admin_finance_expense_delete',
      'admin_finance_expense_events',
      'finance_require_active_admin'
    )
),
tab_priv AS (
  SELECT c.relname,
         CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
         a.privilege_type::text AS privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname IN ('finance_expenses', 'finance_expense_events', 'finance_expense_categories')
),
fn_priv AS (
  SELECT p.proname,
         CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
         a.privilege_type::text AS privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'admin_finance_expense_create',
      'admin_finance_expenses_list',
      'admin_finance_expense_update',
      'admin_finance_expense_delete',
      'admin_finance_expense_events',
      'finance_require_active_admin'
    )
),
pol AS (
  SELECT tablename, policyname, cmd, roles::text AS roles
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('finance_expenses', 'finance_expense_events', 'finance_expense_categories')
),
trg AS (
  SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def
  FROM pg_trigger
  WHERE tgrelid IN ('public.finance_expenses'::regclass, 'public.finance_expense_events'::regclass)
    AND NOT tgisinternal
),
cols AS (
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'finance_expenses'
),
rls AS (
  SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('finance_expenses', 'finance_expense_events', 'finance_expense_categories')
),
confirm_def AS (
  SELECT def FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'finance_expenses.present'::text,
    CASE WHEN to_regclass('public.finance_expenses') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'finance_expense_events.present',
    CASE WHEN to_regclass('public.finance_expense_events') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'col.operation_id',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE column_name = 'operation_id') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'col.deleted_at',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE column_name = 'deleted_at') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'amount_positive_check',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.finance_expenses'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ~* 'amount\s*>\s*\(?0'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'operation_id_unique',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.finance_expenses'::regclass
        AND conname = 'finance_expenses_operation_id_key'
        AND contype = 'u'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'categories.count',
    (SELECT COUNT(*)::text FROM public.finance_expense_categories
      WHERE code IN ('logistics','cargo_customs','ads','rent','tax','salary','seller_payout','bonus','other')),
    '9'
  UNION ALL SELECT 'finance_expenses.rls',
    COALESCE((SELECT relrowsecurity::text FROM rls WHERE relname = 'finance_expenses'), 'missing'),
    'true'
  UNION ALL SELECT 'finance_expenses.force_rls',
    COALESCE((SELECT relforcerowsecurity::text FROM rls WHERE relname = 'finance_expenses'), 'missing'),
    'true'
  UNION ALL SELECT 'finance_expense_events.rls',
    COALESCE((SELECT relrowsecurity::text FROM rls WHERE relname = 'finance_expense_events'), 'missing'),
    'true'
  UNION ALL SELECT 'authenticated.finance_expenses.select',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expenses' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.finance_expenses.insert',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expenses' AND grantee = 'authenticated' AND privilege_type = 'INSERT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.finance_expenses.update',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expenses' AND grantee = 'authenticated' AND privilege_type = 'UPDATE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.finance_expenses.delete',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expenses' AND grantee = 'authenticated' AND privilege_type = 'DELETE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'anon.finance_expenses.select',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expenses' AND grantee IN ('anon', 'public') AND privilege_type = 'SELECT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.events.select',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expense_events' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'policy.hard_delete_denied',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'finance_expenses' AND policyname = 'finance_expenses_admin_delete' AND cmd = 'DELETE'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'policy.insert_created_by',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'finance_expenses'
        AND policyname = 'finance_expenses_admin_insert'
        AND qual IS NULL
        AND with_check ILIKE '%created_by = auth.uid()%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'identity_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM trg
      WHERE tgname = 'finance_expenses_protect_identity_trg'
        AND def ILIKE '%finance_expenses_protect_identity%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'events_immutable_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM trg
      WHERE tgname = 'finance_expense_events_protect_trg'
        AND def ILIKE '%finance_expense_events_protect%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'events.deny_update_policy',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'finance_expense_events' AND policyname = 'finance_expense_events_deny_update' AND cmd = 'UPDATE'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'events.deny_delete_policy',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'finance_expense_events' AND policyname = 'finance_expense_events_deny_delete' AND cmd = 'DELETE'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'service_role.events.update',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expense_events' AND grantee = 'service_role' AND privilege_type = 'UPDATE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'service_role.events.delete',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'finance_expense_events' AND grantee = 'service_role' AND privilege_type = 'DELETE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'update.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_finance_expense_update' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'delete.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_finance_expense_delete' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'events_rpc.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_finance_expense_events' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'list.search_path',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc WHERE proname = 'admin_finance_expenses_list' AND cfg = 'search_path=public'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'update.search_path',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc WHERE proname = 'admin_finance_expense_update' AND cfg = 'search_path=public'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'delete.search_path',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc WHERE proname = 'admin_finance_expense_delete' AND cfg = 'search_path=public'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'events_rpc.search_path',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc WHERE proname = 'admin_finance_expense_events' AND cfg = 'search_path=public'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.unique_violation_retry',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'admin_finance_expense_create' LIMIT 1), '')
      LIKE '%unique_violation%' THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.security_definer',
    COALESCE((SELECT prosecdef::text FROM rpc WHERE proname = 'admin_finance_expense_create' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'create.search_path',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc WHERE proname = 'admin_finance_expense_create' AND cfg = 'search_path=public'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.row_security_off',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc WHERE proname = 'admin_finance_expense_create' AND cfg ILIKE 'row_security=off'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_finance_expense_create' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.anon_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_finance_expense_create' AND grantee IN ('anon', 'public') AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'create.service_role_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_finance_expense_create' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'list.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_finance_expenses_list' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'helper.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'finance_require_active_admin' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'create.denies_non_admin',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'admin_finance_expense_create' LIMIT 1), '')
           LIKE '%finance_require_active_admin%'
         AND COALESCE((SELECT def FROM rpc WHERE proname = 'finance_require_active_admin' LIMIT 1), '')
           LIKE '%Finance permission denied%'
         AND COALESCE((SELECT def FROM rpc WHERE proname = 'finance_require_active_admin' LIMIT 1), '')
           LIKE '%IS DISTINCT FROM ''admin''%'
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.denies_inactive',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'finance_require_active_admin' LIMIT 1), '')
      LIKE '%Account is inactive%' THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.idempotent',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'admin_finance_expense_create' LIMIT 1), '')
      LIKE '%Idempotency key reused with a different payload%' THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'soft_delete.not_hard',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'admin_finance_expense_delete' LIMIT 1), '')
      LIKE '%deleted_at%'
      AND COALESCE((SELECT def FROM rpc WHERE proname = 'admin_finance_expense_delete' LIMIT 1), '')
        NOT LIKE '%DELETE FROM public.finance_expenses%'
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.untouched_insert_zero',
    CASE WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%total_sum%0%' THEN 'true' ELSE 'false' END,
    'true'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
