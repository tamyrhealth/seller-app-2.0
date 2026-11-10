-- Read-only preflight BEFORE 5.17.4 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
trg AS (
  SELECT t.tgname
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'seller_ledger_present'::text AS check_name,
         CASE WHEN to_regclass('public.seller_ledger') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'fulfill_preorder.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'fulfill_preorder') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cancel_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'cancel_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'accrual_trigger_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM trg WHERE tgname = 'seller_commission_order_items_ai_trg') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'order_trigger_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM trg WHERE tgname = 'seller_commission_orders_au_trg') THEN 'present' ELSE 'absent' END,
    'absent'
) s
ORDER BY check_name;
