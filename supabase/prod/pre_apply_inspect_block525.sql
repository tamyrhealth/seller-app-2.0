-- Read-only preflight BEFORE 5.2.5 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid) AS result_type,
         p.prosecdef,
         pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
create_fn AS (
  SELECT *
  FROM fn
  WHERE proname = 'create_stock_transfer'
    AND args = 'p_operation_id uuid, p_from_city_id uuid, p_to_city_id uuid, p_items jsonb, p_comment text'
  LIMIT 1
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
      'create_stock_transfer',
      'receive_stock_transfer',
      'cancel_stock_transfer',
      'write_off_stock_transfer_shortage'
    )
),
pol AS (
  SELECT policyname, tablename, cmd, qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('stock_transfers', 'stock_transfer_items', 'stock_transfer_events')
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'database'::text, current_database()::text, current_database()::text
  UNION ALL SELECT 'table.stock_transfers',
    COALESCE(to_regclass('public.stock_transfers')::text, 'missing'), 'stock_transfers'
  UNION ALL SELECT 'table.stock_transfer_items',
    COALESCE(to_regclass('public.stock_transfer_items')::text, 'missing'), 'stock_transfer_items'
  UNION ALL SELECT 'table.stock_transfer_events',
    COALESCE(to_regclass('public.stock_transfer_events')::text, 'missing'), 'stock_transfer_events'
  UNION ALL SELECT 'table.inventory',
    COALESCE(to_regclass('public.inventory')::text, 'missing'), 'inventory'
  UNION ALL SELECT 'table.inventory_movements',
    COALESCE(to_regclass('public.inventory_movements')::text, 'missing'), 'inventory_movements'
  UNION ALL SELECT 'table.client_operations',
    COALESCE(to_regclass('public.client_operations')::text, 'missing'), 'client_operations'
  UNION ALL SELECT 'table.drafts_absent_before_apply',
    CASE WHEN to_regclass('public.assistant_stock_transfer_drafts') IS NULL THEN 'absent' ELSE 'present' END,
    'absent'
  UNION ALL SELECT 'profiles.can_cancel_orders',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_cancel_orders'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'profiles.can_create_transfers_absent_before_apply',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_create_transfers'
    ) THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'create_stock_transfer.signature',
    COALESCE((SELECT args || ' -> ' || result_type FROM create_fn), 'missing'),
    'p_operation_id uuid, p_from_city_id uuid, p_to_city_id uuid, p_items jsonb, p_comment text -> jsonb'
  UNION ALL SELECT 'create_stock_transfer.security_definer',
    COALESCE((SELECT prosecdef::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.search_path_public',
    COALESCE((SELECT (
      def ~* 'search_path\s*(to|=)\s*''?public'
    )::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.admin_only_before_apply',
    COALESCE((SELECT (def LIKE '%Only admin can transfer stock%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.flag_not_applied_yet',
    COALESCE((SELECT (def LIKE '%Transfer permission denied%')::text FROM create_fn), 'missing'), 'false'
  UNION ALL SELECT 'create_stock_transfer.client_operations',
    COALESCE((SELECT (def LIKE '%client_operations%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.advisory_lock',
    COALESCE((SELECT (def LIKE '%pg_advisory_xact_lock%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.stock_guard',
    COALESCE((SELECT (def LIKE '%qty_on_hand >= v_need%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.transfer_out',
    COALESCE((SELECT (def LIKE '%transfer_out%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.in_transit',
    COALESCE((SELECT (def LIKE '%in_transit%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.replay_guard',
    COALESCE((SELECT (def LIKE '%Idempotency key reused with a different payload%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'receive_stock_transfer.admin_only',
    COALESCE((SELECT (def LIKE '%Only admin can receive transfers%')::text FROM fn WHERE proname = 'receive_stock_transfer' LIMIT 1), 'missing'), 'true'
  UNION ALL SELECT 'cancel_stock_transfer.admin_only',
    COALESCE((SELECT (def LIKE '%Only admin can cancel transfers%')::text FROM fn WHERE proname = 'cancel_stock_transfer' LIMIT 1), 'missing'), 'true'
  UNION ALL SELECT 'write_off_shortage.admin_only',
    COALESCE((
      SELECT (def LIKE '%Only admin can write off transfer shortage%')::text
      FROM fn WHERE proname = 'write_off_stock_transfer_shortage' LIMIT 1
    ), 'missing'), 'true'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'privilege_trigger.present',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.profiles'::regclass
        AND tgname = 'profiles_prevent_privilege_escalation'
        AND NOT tgisinternal
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'rls.stock_transfers_admin_select',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'stock_transfers' AND policyname = 'stock_transfers_admin_select' AND cmd = 'SELECT'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'rls.stock_transfer_items_admin_select',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'stock_transfer_items' AND policyname = 'stock_transfer_items_admin_select' AND cmd = 'SELECT'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'rls.stock_transfer_events_admin_select',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'stock_transfer_events' AND policyname = 'stock_transfer_events_admin_select' AND cmd = 'SELECT'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'grant.create.authenticated_execute',
    COALESCE((
      SELECT bool_or(grantee = 'authenticated' AND privilege_type = 'EXECUTE')::text
      FROM priv WHERE proname = 'create_stock_transfer'
    ), 'false'), 'true'
  UNION ALL SELECT 'grant.create.anon_execute',
    COALESCE((
      SELECT bool_or(grantee IN ('anon', 'public') AND privilege_type = 'EXECUTE')::text
      FROM priv WHERE proname = 'create_stock_transfer'
    ), 'false'), 'false'
  UNION ALL SELECT 'grant.create.service_role_execute',
    COALESCE((
      SELECT bool_or(grantee = 'service_role' AND privilege_type = 'EXECUTE')::text
      FROM priv WHERE proname = 'create_stock_transfer'
    ), 'false'), 'true'
  UNION ALL SELECT 'exec.anon.create_stock_transfer',
    CASE WHEN to_regprocedure('public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)', 'EXECUTE')::text
    END, 'false'
  UNION ALL SELECT 'exec.authenticated.create_stock_transfer',
    CASE WHEN to_regprocedure('public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)') IS NULL THEN 'missing'
         ELSE has_function_privilege('authenticated', 'public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)', 'EXECUTE')::text
    END, 'true'
  UNION ALL SELECT 'seq.stock_transfers_number_seq',
    CASE WHEN to_regclass('public.stock_transfers_number_seq') IS NULL THEN 'missing' ELSE 'present' END,
    'present'
)
SELECT check_name,
       actual_value,
       expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY CASE WHEN actual_value = expected_value THEN 1 ELSE 0 END, check_name;
