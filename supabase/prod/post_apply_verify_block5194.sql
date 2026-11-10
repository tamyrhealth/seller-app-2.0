-- 5.19.4 postflight. SELECT-only. Do not run writes.

WITH fn AS (
  SELECT p.proname, p.prosecdef, p.provolatile
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'unaccrued_list.present'::text AS check_name,
         CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_unaccrued_items_list')
           THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'consistency_summary.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_accrual_consistency_summary')
      THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'unaccrued_list.authenticated_execute',
    CASE WHEN has_function_privilege('authenticated', 'public.admin_seller_unaccrued_items_list(integer)', 'EXECUTE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'unaccrued_list.anon_execute',
    CASE WHEN has_function_privilege('anon', 'public.admin_seller_unaccrued_items_list(integer)', 'EXECUTE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'retry.authenticated_execute',
    CASE WHEN has_function_privilege('authenticated', 'public.admin_seller_accrual_retry_item(uuid)', 'EXECUTE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'consistency.stable',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_accrual_consistency_summary' AND provolatile = 's')
      THEN 'stable' ELSE 'other' END,
    'stable'
  UNION ALL SELECT 'unaccrued.stable',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_unaccrued_items_list' AND provolatile = 's')
      THEN 'stable' ELSE 'other' END,
    'stable'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'missing_list.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_missing_accruals_list') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'recorded_by_sale.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'seller_commission_tariff_recorded_by_sale')
      THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'recorded_by_sale.authenticated_execute',
    CASE WHEN has_function_privilege(
      'authenticated',
      'public.seller_commission_tariff_recorded_by_sale(uuid, uuid, timestamp with time zone)',
      'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'accrual_item_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'order_items'
        AND t.tgname = 'seller_commission_order_items_ai_trg' AND NOT t.tgisinternal
    ) THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
