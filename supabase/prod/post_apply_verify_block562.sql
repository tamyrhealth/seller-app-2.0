-- Read-only verify AFTER 5.6.2 SQL. One result set. No DDL/DML. Does not UPDATE orders.

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
guc AS (
  SELECT p.proname, c AS cfg
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c ON true
  WHERE n.nspname = 'public'
    AND p.proname IN ('confirm_order', 'find_similar_orders', 'kz_normalize_customer_phone')
),
priv_fn AS (
  SELECT p.proname, r.rolname AS grantee, pr.privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) pr ON true
  JOIN pg_roles r ON r.oid = pr.grantee
  WHERE n.nspname = 'public'
    AND p.proname IN ('confirm_order', 'find_similar_orders', 'kz_normalize_customer_phone')
),
cols AS (
  SELECT a.attname, a.attnotnull
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'orders'
    AND a.attnum > 0
    AND NOT a.attisdropped
),
pol AS (
  SELECT pol.polname
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'orders'
),
confirm_def AS (
  SELECT def FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1
),
similar_def AS (
  SELECT def FROM fn WHERE proname = 'find_similar_orders' AND args = 'p jsonb' LIMIT 1
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'customer_name.present'::text,
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'customer_name') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'customer_phone.present',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'customer_phone') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'customer_phone_canon.present',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'customer_phone_canon') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'customer_name.nullable',
    COALESCE((SELECT (NOT attnotnull)::text FROM cols WHERE attname = 'customer_name'), 'missing'),
    'true'
  UNION ALL SELECT 'customer_phone.nullable',
    COALESCE((SELECT (NOT attnotnull)::text FROM cols WHERE attname = 'customer_phone'), 'missing'),
    'true'
  UNION ALL SELECT 'customer_phone_canon.nullable',
    COALESCE((SELECT (NOT attnotnull)::text FROM cols WHERE attname = 'customer_phone_canon'), 'missing'),
    'true'
  UNION ALL SELECT 'kz_normalize.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'kz_normalize_customer_phone' AND args = 'p_raw text') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'kz_normalize.authenticated_execute',
    CASE WHEN to_regprocedure('public.kz_normalize_customer_phone(text)') IS NULL THEN 'missing'
         ELSE has_function_privilege('authenticated', 'public.kz_normalize_customer_phone(text)', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'kz_normalize.anon_execute',
    CASE WHEN to_regprocedure('public.kz_normalize_customer_phone(text)') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.kz_normalize_customer_phone(text)', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'kz_normalize.service_role_execute',
    CASE WHEN to_regprocedure('public.kz_normalize_customer_phone(text)') IS NULL THEN 'missing'
         ELSE has_function_privilege('service_role', 'public.kz_normalize_customer_phone(text)', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'kz_normalize.8_to_plus7',
    COALESCE(public.kz_normalize_customer_phone('87771234567'), 'null'),
    '+77771234567'
  UNION ALL SELECT 'kz_normalize.plus7',
    COALESCE(public.kz_normalize_customer_phone('+77771234567'), 'null'),
    '+77771234567'
  UNION ALL SELECT 'kz_normalize.10_digit',
    COALESCE(public.kz_normalize_customer_phone('7771234567'), 'null'),
    '+77771234567'
  UNION ALL SELECT 'kz_normalize.invalid_null',
    CASE WHEN public.kz_normalize_customer_phone('12345') IS NULL THEN 'null' ELSE 'value' END,
    'null'
  UNION ALL SELECT 'kz_normalize.letters_null',
    CASE WHEN public.kz_normalize_customer_phone('abc87771234567') IS NULL THEN 'null' ELSE 'value' END,
    'null'
  UNION ALL SELECT 'kz_normalize.ndc72_null',
    CASE WHEN public.kz_normalize_customer_phone('77271234567') IS NULL THEN 'null' ELSE 'value' END,
    'null'
  UNION ALL SELECT 'confirm_order.security_definer',
    COALESCE((SELECT prosecdef::text FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.auth_execute',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'missing'
         ELSE has_function_privilege('authenticated', 'public.confirm_order(jsonb)', 'EXECUTE')::text
    END,
    'true'
  UNION ALL SELECT 'confirm_order.anon_execute',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.confirm_order(jsonb)', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'confirm_order.has_customer_canon',
    COALESCE((SELECT (def LIKE '%customer_phone_canon%' AND def LIKE '%kz_normalize_customer_phone%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.stock_insufficient',
    COALESCE((SELECT (def LIKE '%Insufficient stock for product%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.stock_update',
    COALESCE((SELECT (def LIKE '%qty_on_hand = qty_on_hand - v_need%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.advisory_lock',
    COALESCE((SELECT (def LIKE '%pg_advisory_xact_lock%' AND def LIKE '%confirm_order:%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.gifts_zero',
    COALESCE((SELECT (def LIKE '%v_is_gift THEN%' AND def LIKE '%v_price := 0%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.preorder_skip_stock',
    COALESCE((SELECT (def LIKE '%IF NOT v_is_preorder THEN%' AND def LIKE '%inventory_movements%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.debt_phone_required',
    COALESCE((SELECT (def LIKE '%Phone required for debt orders%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.insert_zero_then_total',
    COALESCE((SELECT (def LIKE '%INSERT INTO orders%' AND def LIKE '%UPDATE orders SET total_sum = v_total%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.no_action_logs',
    COALESCE((SELECT (def NOT LIKE '%action_logs%' AND def NOT LIKE '%log_order_action%')::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.legacy_fp_keys',
    COALESCE((SELECT (
      def LIKE '%debt_customer_phone%'
      AND def LIKE '%NOT v_is_debt AND (v_cust_name IS NOT NULL OR v_cust_phone IS NOT NULL)%'
    )::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar.canon',
    COALESCE((SELECT (def LIKE '%kz_normalize_customer_phone%' AND def LIKE '%customer_phone_canon%' AND def LIKE '%debt_customer_phone%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar.window',
    COALESCE((SELECT (def LIKE '%interval ''15 minutes''%')::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar.no_name_match',
    COALESCE((SELECT (
      def LIKE '%kz_normalize_customer_phone%'
      AND def NOT LIKE '%o.customer_name%'
      AND def LIKE '%v_phone_canon IS NOT NULL%'
      AND def NOT LIKE '%length(v_phone_digits) >= 10%'
    )::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar.anon_canon_null',
    COALESCE((SELECT (
      def LIKE '%NOT v_has_identity%'
      AND def LIKE '%IS NULL%'
    )::text FROM similar_def), 'missing'),
    'true'
  UNION ALL SELECT 'find_similar.service_role_execute',
    CASE WHEN to_regprocedure('public.find_similar_orders(jsonb)') IS NULL THEN 'missing'
         ELSE has_function_privilege('service_role', 'public.find_similar_orders(jsonb)', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'find_similar.anon_execute',
    CASE WHEN to_regprocedure('public.find_similar_orders(jsonb)') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.find_similar_orders(jsonb)', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'find_similar.row_security_off',
    CASE WHEN EXISTS (SELECT 1 FROM guc WHERE proname = 'find_similar_orders' AND cfg = 'row_security=off') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'orders.rls',
    COALESCE((
      SELECT c.relrowsecurity::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orders'
    ), 'missing'),
    'true'
  UNION ALL SELECT 'orders.seller_select_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE polname IN ('orders_seller_select')) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'orders.staff_select_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE polname IN ('orders_staff_select')) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'orders.no_customer_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE polname ILIKE '%customer%') THEN 'present' ELSE 'absent' END,
    'absent'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
