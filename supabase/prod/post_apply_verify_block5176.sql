-- Read-only postflight AFTER 5.17.6B SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosecdef,
         COALESCE(p.proconfig, ARRAY[]::text[]) AS cfg
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
g AS (
  SELECT p.proname, r.rolname AS grantee, priv.privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) priv ON true
  JOIN pg_roles r ON r.oid = priv.grantee
  WHERE n.nspname = 'public'
),
cols AS (
  SELECT table_name, column_name, numeric_precision, numeric_scale
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
  SELECT 'goods_issue.present'::text AS check_name,
         CASE WHEN EXISTS (
           SELECT 1 FROM fn
           WHERE proname = 'admin_seller_goods_issue'
             AND args = 'p_operation_id uuid, p_seller_id uuid, p_city_id uuid, p_items jsonb, p_comment text, p_accrued_at timestamp with time zone'
         ) THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'goods_advance.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_goods_advance') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'goods_return.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_goods_return') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'goods_post.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_seller_goods_issue_post' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'goods_to_json.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'seller_goods_issue_to_json' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'goods_issue.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_seller_goods_issue' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'goods_return.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_seller_goods_return' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'goods_list.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_seller_goods_issues_list' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'my_goods.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'seller_my_goods_issues' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'issue.row_security_off',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn WHERE proname = 'admin_seller_goods_issue' AND EXISTS (
        SELECT 1 FROM unnest(cfg) c WHERE c = 'row_security=off'
      )
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'issue.search_path_public',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn WHERE proname = 'admin_seller_goods_issue' AND EXISTS (
        SELECT 1 FROM unnest(cfg) c WHERE c LIKE 'search_path=%public%'
      )
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'issue.security_definer',
    CASE WHEN COALESCE((SELECT prosecdef FROM fn WHERE proname = 'admin_seller_goods_issue' LIMIT 1), false)
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'issue_number.present',
    CASE WHEN EXISTS (
      SELECT 1 FROM cols WHERE table_name = 'seller_goods_issues' AND column_name = 'issue_number'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'issue_kind.present',
    CASE WHEN EXISTS (
      SELECT 1 FROM cols WHERE table_name = 'seller_goods_issues' AND column_name = 'issue_kind'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'movement_type_check.seller_goods_out',
    CASE WHEN (SELECT def FROM chk LIMIT 1) LIKE '%seller_goods_out%'
      AND (SELECT def FROM chk LIMIT 1) LIKE '%seller_goods_in%'
      AND (SELECT def FROM chk LIMIT 1) LIKE '%sale%'
      THEN 'extended' ELSE 'missing' END,
    'extended'
  UNION ALL SELECT 'inventory.qty_on_hand.unchanged',
    COALESCE((
      SELECT numeric_precision::text || ',' || numeric_scale::text
      FROM cols WHERE table_name = 'inventory' AND column_name = 'qty_on_hand'
    ), 'missing'),
    '12,3'
  UNION ALL SELECT 'inventory_movements.qty_delta.unchanged',
    COALESCE((
      SELECT numeric_precision::text || ',' || numeric_scale::text
      FROM cols WHERE table_name = 'inventory_movements' AND column_name = 'qty_delta'
    ), 'missing'),
    '12,3'
  UNION ALL SELECT 'confirm_order.not_replaced',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cancel_order.not_replaced',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'cancel_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'fulfill_preorder.not_replaced',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'fulfill_preorder') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'authenticated.goods_issues.select',
    CASE WHEN has_table_privilege('authenticated', 'public.seller_goods_issues', 'SELECT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.goods_issues.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.seller_goods_issues', 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory_movements.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
) s
ORDER BY check_name;
