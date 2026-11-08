-- Read-only preflight BEFORE 5.6.2 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
cols AS (
  SELECT a.attname
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
checks(check_name, actual_value, expected_value) AS (
  SELECT 'orders.present'::text,
    CASE WHEN to_regclass('public.orders') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'find_similar_orders.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'find_similar_orders' AND args = 'p jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'kz_normalize_customer_phone.absent_before_first_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'kz_normalize_customer_phone') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'customer_name.absent_before_first_apply',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'customer_name') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'customer_phone.absent_before_first_apply',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'customer_phone') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'customer_phone_canon.absent_before_first_apply',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'customer_phone_canon') THEN 'present' ELSE 'absent' END,
    'absent'
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
  UNION ALL SELECT 'confirm_order.anon_execute',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.confirm_order(jsonb)', 'EXECUTE')::text
    END,
    'false'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
