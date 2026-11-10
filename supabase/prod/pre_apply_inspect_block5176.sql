-- Read-only preflight BEFORE 5.17.6B SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
cols AS (
  SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
  FROM information_schema.columns
  WHERE table_schema = 'public'
),
chk AS (
  SELECT pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'inventory_movements' AND c.conname = 'inventory_movements_type_check'
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'seller_goods_issues_present'::text AS check_name,
         CASE WHEN to_regclass('public.seller_goods_issues') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'inventory_present',
    CASE WHEN to_regclass('public.inventory') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'inventory_movements_present',
    CASE WHEN to_regclass('public.inventory_movements') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'inventory.qty_on_hand.type',
    COALESCE((
      SELECT numeric_precision::text || ',' || numeric_scale::text
      FROM cols WHERE table_name = 'inventory' AND column_name = 'qty_on_hand'
    ), 'missing'),
    '12,3'
  UNION ALL SELECT 'inventory_movements.qty_delta.type',
    COALESCE((
      SELECT numeric_precision::text || ',' || numeric_scale::text
      FROM cols WHERE table_name = 'inventory_movements' AND column_name = 'qty_delta'
    ), 'missing'),
    '12,3'
  UNION ALL SELECT 'order_items.qty.type',
    COALESCE((
      SELECT numeric_precision::text || ',' || numeric_scale::text
      FROM cols WHERE table_name = 'order_items' AND column_name = 'qty'
    ), 'missing'),
    '12,3'
  UNION ALL SELECT 'goods_issue_rpc_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_goods_issue') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'issue_number.absent_before_apply',
    CASE WHEN EXISTS (
      SELECT 1 FROM cols WHERE table_name = 'seller_goods_issues' AND column_name = 'issue_number'
    ) THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'movement_type_check.before',
    CASE WHEN (SELECT def FROM chk LIMIT 1) LIKE '%seller_goods_out%' THEN 'extended' ELSE 'base' END,
    'base'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cancel_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'cancel_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'fulfill_preorder.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'fulfill_preorder') THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
