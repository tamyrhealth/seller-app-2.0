-- Read-only verify AFTER 5.13.2 SQL. One result set. No DDL/DML.
-- Does not UPDATE orders, order_items, or inventory. Does not create test orders.

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
cols AS (
  SELECT a.attname, a.attnotnull, format_type(a.atttypid, a.atttypmod) AS typ
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'order_items'
    AND a.attnum > 0
    AND NOT a.attisdropped
),
chk AS (
  SELECT con.conname, pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'order_items' AND con.contype = 'c'
),
confirm_def AS (
  SELECT def, prosecdef FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb' LIMIT 1
),
rpc_def AS (
  SELECT def, prosecdef FROM fn WHERE proname = 'admin_order_item_cost_snapshots' AND args = 'p_ids uuid[]' LIMIT 1
),
hist_def AS (
  SELECT def FROM fn WHERE proname = 'order_history_item_snapshot' LIMIT 1
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'cost_price_snapshot.present'::text,
    CASE WHEN EXISTS (SELECT 1 FROM cols WHERE attname = 'cost_price_snapshot') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cost_price_snapshot.type',
    COALESCE((SELECT typ FROM cols WHERE attname = 'cost_price_snapshot'), 'missing'),
    'numeric(12,2)'
  UNION ALL SELECT 'cost_price_snapshot.nullable',
    COALESCE((SELECT (NOT attnotnull)::text FROM cols WHERE attname = 'cost_price_snapshot'), 'missing'),
    'true'
  UNION ALL SELECT 'cost_price_snapshot.check',
    CASE WHEN EXISTS (
      SELECT 1 FROM chk
      WHERE def ILIKE '%cost_price_snapshot IS NULL OR cost_price_snapshot >= 0%'
         OR def ILIKE '%(cost_price_snapshot IS NULL) OR (cost_price_snapshot >= (0)::numeric)%'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.security_definer',
    COALESCE((SELECT prosecdef::text FROM confirm_def), 'missing'),
    'true'
  UNION ALL SELECT 'confirm_order.writes_snapshot',
    CASE WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%cost_price_snapshot%'
          AND COALESCE((SELECT def FROM confirm_def), '') LIKE '%v_cost%'
         THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.fingerprint_omits_cost',
    CASE
      WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%md5(v_fp_obj::text)%'
       AND COALESCE((SELECT def FROM confirm_def), '') LIKE '%''product_id''%'
       AND COALESCE((SELECT def FROM confirm_def), '') NOT LIKE '%''cost_price''%'
      THEN 'true' ELSE 'false'
    END,
    'true'
  UNION ALL SELECT 'confirm_order.stock_update',
    CASE WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%qty_on_hand = qty_on_hand - v_need%' THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.advisory_lock',
    CASE WHEN COALESCE((SELECT def FROM confirm_def), '') LIKE '%pg_advisory_xact_lock%' THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.anon_execute',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.confirm_order(jsonb)', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'confirm_order.authenticated_execute',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'missing'
         ELSE has_function_privilege('authenticated', 'public.confirm_order(jsonb)', 'EXECUTE')::text
    END,
    'true'
  UNION ALL SELECT 'rpc.present',
    CASE WHEN EXISTS (SELECT 1 FROM rpc_def) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'rpc.security_definer',
    COALESCE((SELECT prosecdef::text FROM rpc_def), 'missing'),
    'true'
  UNION ALL SELECT 'rpc.search_path',
    CASE WHEN COALESCE((SELECT def FROM rpc_def), '') LIKE '%search_path%public%' THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rpc.admin_gate',
    CASE WHEN COALESCE((SELECT def FROM rpc_def), '') LIKE '%Only admin can read product cost%'
          AND COALESCE((SELECT def FROM rpc_def), '') LIKE '%Account is inactive%'
          AND COALESCE((SELECT def FROM rpc_def), '') LIKE '%Not authenticated%'
         THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rpc.empty_and_cap',
    CASE WHEN COALESCE((SELECT def FROM rpc_def), '') LIKE '%cardinality(p_ids) = 0%'
          AND COALESCE((SELECT def FROM rpc_def), '') LIKE '%cardinality(p_ids) > 20000%'
         THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rpc.anon_execute',
    CASE WHEN to_regprocedure('public.admin_order_item_cost_snapshots(uuid[])') IS NULL THEN 'missing'
         ELSE has_function_privilege('anon', 'public.admin_order_item_cost_snapshots(uuid[])', 'EXECUTE')::text
    END,
    'false'
  UNION ALL SELECT 'rpc.authenticated_execute',
    CASE WHEN to_regprocedure('public.admin_order_item_cost_snapshots(uuid[])') IS NULL THEN 'missing'
         ELSE has_function_privilege('authenticated', 'public.admin_order_item_cost_snapshots(uuid[])', 'EXECUTE')::text
    END,
    'true'
  UNION ALL SELECT 'authenticated.select_snapshot_column',
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM cols WHERE attname = 'cost_price_snapshot') THEN 'missing'
      ELSE has_column_privilege('authenticated', 'public.order_items', 'cost_price_snapshot', 'SELECT')::text
    END,
    'false'
  UNION ALL SELECT 'anon.select_snapshot_column',
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM cols WHERE attname = 'cost_price_snapshot') THEN 'missing'
      ELSE has_column_privilege('anon', 'public.order_items', 'cost_price_snapshot', 'SELECT')::text
    END,
    'false'
  UNION ALL SELECT 'authenticated.select_order_item_id',
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM cols WHERE attname = 'id') THEN 'missing'
      ELSE has_column_privilege('authenticated', 'public.order_items', 'id', 'SELECT')::text
    END,
    'true'
  UNION ALL SELECT 'authenticated.select_qty',
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM cols WHERE attname = 'qty') THEN 'missing'
      ELSE has_column_privilege('authenticated', 'public.order_items', 'qty', 'SELECT')::text
    END,
    'true'
  UNION ALL SELECT 'authenticated.insert_snapshot_column',
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM cols WHERE attname = 'cost_price_snapshot') THEN 'missing'
      ELSE has_column_privilege('authenticated', 'public.order_items', 'cost_price_snapshot', 'INSERT')::text
    END,
    'false'
  UNION ALL SELECT 'history.no_cost',
    CASE
      WHEN COALESCE((SELECT def FROM hist_def), '') = '' THEN 'missing_fn'
      WHEN COALESCE((SELECT def FROM hist_def), '') LIKE '%cost_price%' THEN 'leaks'
      ELSE 'ok'
    END,
    'ok'
)
SELECT check_name, actual_value, expected_value,
       (actual_value = expected_value) AS pass
FROM checks
ORDER BY check_name;
