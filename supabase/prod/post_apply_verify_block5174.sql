-- Read-only verify AFTER 5.17.4 SQL. One result set. No DDL/DML.

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
trg AS (
  SELECT t.tgname, c.relname
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
),
fn_priv AS (
  SELECT p.proname,
         CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
         a.privilege_type::text AS privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'seller_commission_accrue_order_internal',
      'seller_commission_reverse_order_internal',
      'seller_commission_accrue_item_internal',
      'admin_seller_missing_accruals_list',
      'admin_seller_accrual_retry_item'
    )
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'accrual_item_trigger'::text AS check_name,
         CASE WHEN EXISTS (SELECT 1 FROM trg WHERE tgname = 'seller_commission_order_items_ai_trg' AND relname = 'order_items') THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'accrual_order_trigger',
    CASE WHEN EXISTS (SELECT 1 FROM trg WHERE tgname = 'seller_commission_orders_au_trg' AND relname = 'orders') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'accrue.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'seller_commission_accrue_order_internal'
        AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'reverse.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'seller_commission_reverse_order_internal'
        AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'confirm_order.not_replaced',
    CASE WHEN COALESCE((SELECT def FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1), '')
           LIKE '%cost_price_snapshot%'
         AND COALESCE((SELECT def FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1), '')
           NOT LIKE '%seller_commission_accrue%'
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'fulfill_preorder.not_replaced',
    CASE WHEN COALESCE((SELECT def FROM fn WHERE proname = 'fulfill_preorder' LIMIT 1), '')
           NOT LIKE '%seller_commission_accrue%'
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'missing_list.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_seller_missing_accruals_list'
        AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'retry.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_seller_accrual_retry_item'
        AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'item_protect_trigger',
    CASE WHEN EXISTS (SELECT 1 FROM trg WHERE tgname = 'seller_commission_order_items_protect_trg' AND relname = 'order_items') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'accrue.security_definer',
    CASE WHEN COALESCE((SELECT prosecdef FROM fn WHERE proname = 'seller_commission_accrue_order_internal' LIMIT 1), false) THEN 'true' ELSE 'false' END,
    'true'
) s
ORDER BY check_name;
