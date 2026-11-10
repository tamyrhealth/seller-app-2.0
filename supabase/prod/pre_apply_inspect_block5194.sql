-- 5.19.4 preflight. SELECT-only. Do not run writes.

SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'seller_ledger_present'::text AS check_name,
         CASE WHEN to_regclass('public.seller_ledger') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'accrual_retry_present',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'admin_seller_accrual_retry_item'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'unaccrued_list_absent_before_apply',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'admin_seller_unaccrued_items_list'
    ) THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'consistency_summary_absent_before_apply',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'admin_seller_accrual_consistency_summary'
    ) THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'confirm_order_present',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'confirm_order'
    ) THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
