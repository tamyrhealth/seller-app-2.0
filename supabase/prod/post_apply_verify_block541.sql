-- Read-only verify AFTER 5.4.1 SQL. One result set. No DDL/DML.

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
    AND p.proname = 'find_similar_orders'
),
idx AS (
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'orders'
    AND indexname = 'orders_find_similar_seller_city_created_idx'
),
similar_def AS (
  SELECT def FROM fn WHERE proname = 'find_similar_orders' AND args = 'p jsonb' LIMIT 1
),
similar_cfg AS (
  SELECT p.proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'find_similar_orders'
    AND pg_get_function_identity_arguments(p.oid) = 'p jsonb'
  LIMIT 1
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'find_similar_orders.present'::text,
    CASE WHEN EXISTS (SELECT 1 FROM similar_def) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'find_similar_orders.security_definer',
    COALESCE((SELECT prosecdef::text FROM fn WHERE proname = 'find_similar_orders' AND args = 'p jsonb' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.auth_uid',
    COALESCE((SELECT (def LIKE '%auth.uid()%' AND def LIKE '%Not authenticated%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.is_active',
    COALESCE((SELECT (def LIKE '%is_active%' AND def LIKE '%Account is inactive%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.seller_lock',
    COALESCE((SELECT (def LIKE '%Similar-order lookup permission denied%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.window_15m',
    COALESCE((SELECT (def LIKE '%15 minutes%' AND def LIKE '%window_seconds%' AND def LIKE '%900%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.excludes_canceled',
    COALESCE((SELECT (def LIKE '%canceled%' AND def LIKE '%cancelled%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.phone_identity',
    COALESCE((SELECT (def LIKE '%debt_customer_phone%' AND def LIKE '%identity_kind%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.item_bag',
    COALESCE((SELECT (def LIKE '%is_gift%' AND def LIKE '%product_id%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.search_path',
    COALESCE((
      SELECT EXISTS (
        SELECT 1 FROM unnest(COALESCE(proconfig, ARRAY[]::text[])) c
        WHERE c = 'search_path=public'
      )::text
      FROM similar_cfg
    ), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.row_security_off',
    COALESCE((
      SELECT EXISTS (
        SELECT 1 FROM unnest(COALESCE(proconfig, ARRAY[]::text[])) c
        WHERE c = 'row_security=off'
      )::text
      FROM similar_cfg
    ), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.exclude_idempotency_key',
    COALESCE((SELECT (def LIKE '%exclude_idempotency_key%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.no_writes',
    COALESCE((
      SELECT (
        def NOT LIKE '%INSERT INTO%'
        AND def NOT LIKE '%UPDATE %'
        AND def NOT LIKE '%DELETE FROM%'
        AND def NOT LIKE '%action_logs%'
      )::text
      FROM similar_def
    ), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar_orders.auth_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM priv WHERE grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'find_similar_orders.anon_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM priv WHERE grantee IN ('anon', 'public') AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'find_similar_orders.service_role_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM priv WHERE grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'confirm_order.still_present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'lookup_index',
    CASE WHEN EXISTS (SELECT 1 FROM idx) THEN 'present' ELSE 'absent' END,
    'present'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
