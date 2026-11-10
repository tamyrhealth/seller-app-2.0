-- Read-only verify AFTER 5.17.3A SQL. One result set. No DDL/DML.

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
rpc AS (
  SELECT * FROM fn
  WHERE proname IN (
    'admin_seller_cash_payout',
    'admin_seller_cash_advance',
    'admin_seller_cash_post',
    'seller_commission_require_active_admin',
    'seller_ledger_post_internal',
    'seller_ledger_post_accrual_internal',
    'confirm_order',
    'fulfill_preorder',
    'cancel_order',
    'admin_cancel_order'
  )
),
guc AS (
  SELECT p.proname, c AS cfg
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c ON true
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'admin_seller_cash_payout',
      'admin_seller_cash_advance',
      'seller_commission_require_active_admin'
    )
),
tab_priv AS (
  SELECT c.relname,
         CASE WHEN a.grantee = 0 THEN 'public' ELSE r.rolname END AS grantee,
         a.privilege_type::text AS privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) a ON true
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'seller_ledger',
      'seller_tariff_plans',
      'seller_tariff_rates',
      'seller_tariff_assignments',
      'seller_rate_overrides',
      'seller_goods_issues',
      'seller_goods_issue_items'
    )
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
      'admin_seller_cash_payout',
      'admin_seller_cash_advance',
      'admin_seller_cash_post',
      'seller_commission_require_active_admin',
      'seller_ledger_post_internal',
      'seller_ledger_post_accrual_internal'
    )
),
idx AS (
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'seller_ledger'
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'seller_ledger.present'::text AS check_name,
         CASE WHEN to_regclass('public.seller_ledger') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'authenticated.seller_ledger.select',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'seller_ledger' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.seller_ledger.insert',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'seller_ledger' AND grantee = 'authenticated' AND privilege_type = 'INSERT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'service_role.seller_ledger.insert',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'seller_ledger' AND grantee = 'service_role' AND privilege_type = 'INSERT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.seller_tariff_assignments.select',
    CASE WHEN EXISTS (
      SELECT 1 FROM tab_priv
      WHERE relname = 'seller_tariff_assignments' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'payout.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_seller_cash_payout' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'payout.service_role_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_seller_cash_payout' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'helper.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'seller_commission_require_active_admin' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'internal_post.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'seller_ledger_post_internal' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'accrual_internal.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'seller_ledger_post_accrual_internal' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'cash_post.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn_priv
      WHERE proname = 'admin_seller_cash_post' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'accrual_item_unique',
    CASE WHEN EXISTS (
      SELECT 1 FROM idx
      WHERE indexname = 'seller_ledger_accrual_item_uidx'
        AND indexdef LIKE '%order_item_id%'
        AND indexdef LIKE '%accrual%'
        AND indexdef NOT LIKE '%reversed%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'operation_id_unique',
    CASE WHEN EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.seller_ledger'::regclass
        AND conname = 'seller_ledger_operation_id_key'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'create.row_security_off',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc
      WHERE proname = 'admin_seller_cash_payout' AND cfg = 'row_security=off'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'create.search_path',
    CASE WHEN EXISTS (
      SELECT 1 FROM guc
      WHERE proname = 'admin_seller_cash_payout' AND cfg LIKE 'search_path=%public%'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'payout.security_definer',
    CASE WHEN COALESCE((SELECT prosecdef FROM rpc WHERE proname = 'admin_seller_cash_payout' LIMIT 1), false) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.untouched',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1), '')
           NOT LIKE '%seller_ledger%'
         AND COALESCE((SELECT def FROM rpc WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1), '')
           NOT LIKE '%seller_ledger_post_accrual%'
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'fulfill_preorder.untouched',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'fulfill_preorder' LIMIT 1), '')
           NOT LIKE '%seller_ledger%'
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'cancel_order.untouched',
    CASE WHEN COALESCE((SELECT def FROM rpc WHERE proname = 'cancel_order' LIMIT 1), '')
           NOT LIKE '%seller_ledger%'
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'seller_ledger.force_rls',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'seller_ledger' AND c.relforcerowsecurity
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rates_open_unique',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'seller_tariff_rates_open_uidx'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'assignments_open_unique',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'seller_tariff_assignments_open_uidx'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'plans_seeded',
    CASE WHEN (
      SELECT COUNT(*) FROM public.seller_tariff_plans WHERE code IN ('A', 'B')
    ) = 2 THEN 'true' ELSE 'false' END,
    'true'
) s
ORDER BY check_name;
