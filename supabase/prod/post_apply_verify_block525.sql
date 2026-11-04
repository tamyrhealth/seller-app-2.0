-- Read-only verify AFTER 5.2.5 SQL. One result set. No DDL/DML.

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
      'begin_assistant_stock_transfer_confirm',
      'save_assistant_stock_transfer_draft',
      'receive_stock_transfer',
      'cancel_stock_transfer',
      'write_off_stock_transfer_shortage'
    )
),
pol AS (
  SELECT policyname, tablename, cmd, qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'stock_transfers',
      'stock_transfer_items',
      'stock_transfer_events',
      'assistant_stock_transfer_drafts'
    )
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'database'::text, current_database()::text, current_database()::text
  UNION ALL SELECT 'profiles.can_create_transfers',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_create_transfers'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'profiles.can_create_transfers.default_false',
    CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_create_transfers'
      ) THEN 'missing'
      WHEN (
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_create_transfers'
      ) ILIKE '%false%' THEN 'false'
      ELSE COALESCE((
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_create_transfers'
      ), 'null')
    END,
    'false'
  UNION ALL SELECT 'table.assistant_stock_transfer_drafts',
    CASE WHEN to_regclass('public.assistant_stock_transfer_drafts') IS NULL THEN 'absent' ELSE 'present' END,
    'present'
  UNION ALL SELECT 'create_stock_transfer.signature',
    COALESCE((SELECT args || ' -> ' || result_type FROM create_fn), 'missing'),
    'p_operation_id uuid, p_from_city_id uuid, p_to_city_id uuid, p_items jsonb, p_comment text -> jsonb'
  UNION ALL SELECT 'create_stock_transfer.security_definer',
    COALESCE((SELECT prosecdef::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.flag_denied',
    COALESCE((SELECT (def LIKE '%Transfer permission denied%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.mentions_flag',
    COALESCE((SELECT (def LIKE '%can_create_transfers%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.admin_still_allowed',
    COALESCE((SELECT (def LIKE '%v_role IS DISTINCT FROM ''admin''%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.city_not_found_kept',
    COALESCE((SELECT (def LIKE '%Source city not found%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.city_active',
    COALESCE((SELECT (def LIKE '%Source city is inactive%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.inactive_product',
    COALESCE((SELECT (def LIKE '%Inactive product%')::text FROM create_fn), 'missing'), 'true'
  UNION ALL SELECT 'create_stock_transfer.unit_from_products',
    COALESCE((SELECT (def LIKE '%IS DISTINCT FROM ''kg''%')::text FROM create_fn), 'missing'), 'true'
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
  UNION ALL SELECT 'receive_stock_transfer.no_create_flag',
    COALESCE((SELECT (def LIKE '%can_create_transfers%')::text FROM fn WHERE proname = 'receive_stock_transfer' LIMIT 1), 'missing'), 'false'
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
  UNION ALL SELECT 'trigger.blocks_can_create_transfers',
    COALESCE((
      SELECT (def LIKE '%can_create_transfers%')::text
      FROM fn WHERE proname = 'profiles_prevent_privilege_escalation' LIMIT 1
    ), 'missing'), 'true'
  UNION ALL SELECT 'rls.stock_transfers_select_own_or_admin',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'stock_transfers'
        AND policyname = 'stock_transfers_select'
        AND cmd = 'SELECT'
        AND qual LIKE '%created_by = auth.uid()%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'rls.items_own_or_admin',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'stock_transfer_items'
        AND policyname = 'stock_transfer_items_select'
        AND cmd = 'SELECT'
        AND COALESCE(qual, '') LIKE '%created_by = auth.uid()%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'rls.events_own_or_admin',
    CASE WHEN EXISTS (
      SELECT 1 FROM pol
      WHERE tablename = 'stock_transfer_events'
        AND policyname = 'stock_transfer_events_select'
        AND cmd = 'SELECT'
        AND COALESCE(qual, '') LIKE '%created_by = auth.uid()%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'index.drafts_idempotency',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'assistant_stock_transfer_drafts'
        AND indexname = 'assistant_stock_transfer_drafts_idempotency_uidx'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'grant.create.authenticated_execute',
    COALESCE((
      SELECT bool_or(grantee = 'authenticated' AND privilege_type = 'EXECUTE')::text
      FROM priv WHERE proname = 'create_stock_transfer'
    ), 'false'), 'true'
  UNION ALL SELECT 'grant.create.anon_or_public_execute',
    COALESCE((
      SELECT bool_or(grantee IN ('anon', 'public') AND privilege_type = 'EXECUTE')::text
      FROM priv WHERE proname = 'create_stock_transfer'
    ), 'false'), 'false'
  UNION ALL SELECT 'exec.anon.create_stock_transfer',
    CASE WHEN to_regprocedure('public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)', 'EXECUTE')::text
    END, 'false'
  UNION ALL SELECT 'exec.authenticated.create_stock_transfer',
    CASE WHEN to_regprocedure('public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)') IS NULL THEN 'missing'
         ELSE has_function_privilege('authenticated', 'public.create_stock_transfer(uuid,uuid,uuid,jsonb,text)', 'EXECUTE')::text
    END, 'true'
  UNION ALL SELECT 'exec.authenticated.begin_confirm',
    CASE WHEN to_regprocedure('public.begin_assistant_stock_transfer_confirm(uuid)') IS NULL THEN 'missing'
         ELSE has_function_privilege('authenticated', 'public.begin_assistant_stock_transfer_confirm(uuid)', 'EXECUTE')::text
    END, 'true'
  UNION ALL SELECT 'auth_save_must_be_false',
    CASE WHEN to_regprocedure('public.save_assistant_stock_transfer_draft(uuid,uuid,uuid,uuid,uuid,text,boolean,jsonb,jsonb,jsonb,jsonb,uuid)') IS NULL THEN 'missing'
         ELSE has_function_privilege(
           'authenticated',
           'public.save_assistant_stock_transfer_draft(uuid,uuid,uuid,uuid,uuid,text,boolean,jsonb,jsonb,jsonb,jsonb,uuid)',
           'EXECUTE'
         )::text
    END, 'false'
)
SELECT check_name,
       actual_value,
       expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY CASE WHEN actual_value = expected_value THEN 1 ELSE 0 END, check_name;
