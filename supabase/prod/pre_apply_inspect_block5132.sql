-- Read-only preflight BEFORE 5.13.2 SQL. One result set. No DDL/DML.
-- Does not UPDATE orders, order_items, or inventory.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_functiondef(p.oid) AS def
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
    AND c.relname = 'order_items'
    AND a.attnum > 0
    AND NOT a.attisdropped
),
confirm_def AS (
  SELECT def FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'order_items.present'::text,
    CASE WHEN to_regclass('public.order_items') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cost_price_snapshot.absent_before_first_apply',
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'cost_price_snapshot') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.has_customer_fields',
    CASE WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%v_cust_canon%' THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.no_snapshot_write_yet',
    CASE WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%cost_price_snapshot%' THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'confirm_order.fingerprint_no_cost',
    CASE
      WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%md5(v_fp_obj::text)%'
       AND COALESCE((SELECT def FROM confirm_def), '') LIKE '%''is_gift''%'
       AND COALESCE((SELECT def FROM confirm_def), '') NOT LIKE '%cost_price_snapshot%'
      THEN 'true' ELSE 'false'
    END,
    'true'
  UNION ALL SELECT 'admin_order_item_cost_snapshots.absent_before_first_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_order_item_cost_snapshots') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'products.cost_price.present',
    CASE WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'cost_price'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'admin_product_costs.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_product_costs') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'is_active_admin.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'is_active_admin') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'authenticated.select_order_items_table_or_columns',
    CASE
      WHEN to_regclass('public.order_items') IS NULL THEN 'missing'
      ELSE has_table_privilege('authenticated', 'public.order_items', 'SELECT')::text
    END,
    'true'
  UNION ALL SELECT 'anon.select_order_items',
    CASE
      WHEN to_regclass('public.order_items') IS NULL THEN 'missing'
      ELSE has_table_privilege('anon', 'public.order_items', 'SELECT')::text
    END,
    'false'
)
SELECT check_name, actual_value, expected_value,
       (actual_value = expected_value) AS pass
FROM checks
ORDER BY check_name;
