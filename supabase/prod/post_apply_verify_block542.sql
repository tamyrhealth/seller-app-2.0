-- Read-only verify AFTER 5.4.2 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosecdef,
         pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
priv_fn AS (
  SELECT p.proname,
         CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
         a.privilege_type::text AS privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND p.proname IN ('log_order_action', 'order_history_item_snapshot')
),
tab_priv AS (
  SELECT
    CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
    a.privilege_type::text AS privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND c.relname = 'action_logs'
),
pol AS (
  SELECT policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'action_logs'
),
trg AS (
  SELECT tgname, tgdeferrable, tginitdeferred, tgconstraint, pg_get_triggerdef(oid) AS def
  FROM pg_trigger
  WHERE tgrelid = 'public.orders'::regclass
    AND tgname = 'orders_log_insert_trg'
    AND NOT tgisinternal
),
guc AS (
  SELECT p.proname, c AS cfg
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c ON true
  WHERE n.nspname = 'public'
    AND p.proname IN ('log_order_action', 'orders_log_insert', 'order_history_item_snapshot')
),
log_def AS (
  SELECT def FROM fn WHERE proname = 'log_order_action' LIMIT 1
),
insert_def AS (
  SELECT def FROM fn WHERE proname = 'orders_log_insert' LIMIT 1
),
confirm_def AS (
  SELECT def FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'insert_policy_absent'::text,
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE policyname = 'action_logs_insert_authenticated') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'select_admin_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE policyname = 'action_logs_select_admin' AND cmd = 'SELECT') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'authenticated.insert',
    CASE WHEN EXISTS (SELECT 1 FROM tab_priv WHERE grantee = 'authenticated' AND privilege_type = 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.update',
    CASE WHEN EXISTS (SELECT 1 FROM tab_priv WHERE grantee = 'authenticated' AND privilege_type = 'UPDATE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.delete',
    CASE WHEN EXISTS (SELECT 1 FROM tab_priv WHERE grantee = 'authenticated' AND privilege_type = 'DELETE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.select',
    CASE WHEN EXISTS (SELECT 1 FROM tab_priv WHERE grantee = 'authenticated' AND privilege_type = 'SELECT') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'anon.insert',
    CASE WHEN EXISTS (SELECT 1 FROM tab_priv WHERE grantee IN ('anon', 'public') AND privilege_type = 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'action_logs.rls',
    COALESCE((
      SELECT c.relrowsecurity::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'action_logs'
    ), 'missing'),
    'true'
  UNION ALL SELECT 'action_logs.update_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE cmd = 'UPDATE') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'action_logs.delete_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE cmd = 'DELETE') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'log_order_action.security_definer',
    COALESCE((SELECT prosecdef::text FROM fn WHERE proname = 'log_order_action' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'log_order_action.auth_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM priv_fn WHERE proname = 'log_order_action' AND grantee IN ('authenticated', 'anon', 'public') AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'log_order_action.row_security_off',
    CASE WHEN EXISTS (SELECT 1 FROM guc WHERE proname = 'log_order_action' AND cfg = 'row_security=off') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'log_order_action.search_path',
    CASE WHEN EXISTS (SELECT 1 FROM guc WHERE proname = 'log_order_action' AND cfg = 'search_path=public') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'orders_log_insert.row_security_off',
    CASE WHEN EXISTS (SELECT 1 FROM guc WHERE proname = 'orders_log_insert' AND cfg = 'row_security=off') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'orders_log_insert.search_path',
    CASE WHEN EXISTS (SELECT 1 FROM guc WHERE proname = 'orders_log_insert' AND cfg = 'search_path=public') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'trigger.count',
    COALESCE((SELECT count(*)::text FROM trg), '0'),
    '1'
  UNION ALL SELECT 'trigger.deferred',
    COALESCE((SELECT (tgdeferrable AND tginitdeferred)::text FROM trg LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'trigger.constraint',
    COALESCE((SELECT (tgconstraint <> 0)::text FROM trg LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'trigger.reads_live_row',
    COALESCE((SELECT (def LIKE '%SELECT * INTO v_order FROM public.orders%' AND def LIKE '%order_history_item_snapshot%')::text FROM insert_def), 'missing'),
    'true'
  UNION ALL SELECT 'create_log.has_items_and_total',
    COALESCE((SELECT (def LIKE '%total_sum%' AND def LIKE '%items%' AND def LIKE '%payment_type%')::text FROM insert_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.unchanged_insert_zero',
    COALESCE((SELECT (def LIKE '%INSERT INTO orders%' AND def LIKE '%UPDATE orders SET total_sum = v_total%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.no_action_logs',
    COALESCE((SELECT (def NOT LIKE '%action_logs%' AND def NOT LIKE '%log_order_action%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'fulfill.logs_total',
    COALESCE((SELECT (def LIKE '%preorder_fulfill%' AND def LIKE '%total_sum%' AND def LIKE '%items%')::text FROM fn WHERE proname = 'fulfill_preorder' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'debt_pay.logs_total',
    COALESCE((SELECT (def LIKE '%debt_pay%' AND def LIKE '%total_sum%' AND def LIKE '%payment_method%' AND def LIKE '%items%')::text FROM fn WHERE proname = 'mark_debt_paid' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'cancel.report_not_rewritten',
    COALESCE((SELECT (def NOT LIKE '%order_cancel_already%')::text FROM fn WHERE proname = 'apply_order_cancel_report' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'no_log_row_updates',
    COALESCE((SELECT (def NOT LIKE '%UPDATE public.action_logs%' AND def NOT LIKE '%DELETE FROM public.action_logs%')::text FROM log_def), 'missing'),
    'true'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
