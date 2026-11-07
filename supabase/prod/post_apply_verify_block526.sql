-- Read-only verify AFTER 5.2.6 SQL. One result set. No DDL/DML.

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
priv AS (
  SELECT p.proname,
         CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
         a.privilege_type::text AS privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'stock_transfer_require',
      'create_stock_transfer',
      'receive_stock_transfer',
      'cancel_stock_transfer',
      'write_off_stock_transfer_shortage',
      'apply_inventory_restock'
    )
),
pol AS (
  SELECT policyname, tablename, cmd, qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('stock_transfers', 'stock_transfer_items', 'stock_transfer_events')
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'profiles.can_manage_transfers'::text,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_manage_transfers'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'profiles.can_manage_transfers.default_false',
    COALESCE((
      SELECT column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_manage_transfers'
    ), 'missing'),
    'false'
  UNION ALL SELECT 'require.security_definer',
    COALESCE((SELECT prosecdef::text FROM fn WHERE proname = 'stock_transfer_require' LIMIT 1), 'missing'), 'true'
  UNION ALL SELECT 'require.signature',
    COALESCE((SELECT args FROM fn WHERE proname = 'stock_transfer_require' LIMIT 1), 'missing'),
    'p_need_manage boolean'
  UNION ALL SELECT 'require.checks_is_active',
    COALESCE((SELECT (def LIKE '%is_active%' AND def LIKE '%Account is inactive%' AND def LIKE '%auth.uid()%')::text FROM fn WHERE proname = 'stock_transfer_require' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'require.no_client_user_id',
    COALESCE((SELECT (args LIKE '%user_id%' OR def LIKE '%p_user_id%')::text FROM fn WHERE proname = 'stock_transfer_require' LIMIT 1), 'missing'),
    'false'
  UNION ALL SELECT 'require.auth_execute_false',
    CASE WHEN EXISTS (
      SELECT 1 FROM priv WHERE proname = 'stock_transfer_require' AND grantee IN ('authenticated', 'anon', 'public') AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'create.uses_require',
    COALESCE((SELECT (def LIKE '%stock_transfer_require(false)%')::text FROM fn WHERE proname = 'create_stock_transfer' AND args LIKE '%p_comment%' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'receive.uses_require',
    COALESCE((SELECT (def LIKE '%stock_transfer_require(true)%')::text FROM fn WHERE proname = 'receive_stock_transfer' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'cancel.uses_require',
    COALESCE((SELECT (def LIKE '%stock_transfer_require(true)%')::text FROM fn WHERE proname = 'cancel_stock_transfer' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'write_off.uses_require',
    COALESCE((SELECT (def LIKE '%stock_transfer_require(true)%')::text FROM fn WHERE proname = 'write_off_stock_transfer_shortage' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'receive.actor_id_event',
    COALESCE((SELECT (def LIKE '%INSERT INTO public.stock_transfer_events%actor_id%')::text FROM fn WHERE proname = 'receive_stock_transfer' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'cancel.actor_id_event',
    COALESCE((SELECT (def LIKE '%INSERT INTO public.stock_transfer_events%actor_id%')::text FROM fn WHERE proname = 'cancel_stock_transfer' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'write_off.actor_id_event',
    COALESCE((SELECT (def LIKE '%INSERT INTO public.stock_transfer_events%actor_id%')::text FROM fn WHERE proname = 'write_off_stock_transfer_shortage' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'create.actor_id_event',
    COALESCE((SELECT (def LIKE '%INSERT INTO public.stock_transfer_events%actor_id%')::text FROM fn WHERE proname = 'create_stock_transfer' AND args LIKE '%p_comment%' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'receive.not_admin_only',
    COALESCE((SELECT (def LIKE '%Only admin can receive transfers%')::text FROM fn WHERE proname = 'receive_stock_transfer' LIMIT 1), 'missing'),
    'false'
  UNION ALL SELECT 'rls.manage_select',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol WHERE tablename = 'stock_transfers' AND policyname = 'stock_transfers_select' AND qual LIKE '%can_manage_transfers%'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'trigger.blocks_can_manage_transfers',
    COALESCE((SELECT (def LIKE '%can_manage_transfers%' AND def LIKE '%TG_OP = ''INSERT''%')::text FROM fn WHERE proname = 'profiles_prevent_privilege_escalation' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'trigger.insert_or_update',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'profiles'
        AND t.tgname = 'profiles_prevent_privilege_escalation'
        AND (t.tgtype & 4) = 4
        AND (t.tgtype & 16) = 16
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rls.write_policies_absent',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol WHERE cmd IN ('INSERT', 'UPDATE', 'DELETE')
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'receive.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM priv WHERE proname = 'receive_stock_transfer' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'restock.untouched_admin',
    COALESCE((SELECT (def LIKE '%Only admin%' OR def LIKE '%is_admin%')::text FROM fn WHERE proname = 'apply_inventory_restock' LIMIT 1), 'missing'),
    'true'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
