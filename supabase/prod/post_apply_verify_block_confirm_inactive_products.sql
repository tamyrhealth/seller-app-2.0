-- Read-only checks AFTER confirm_order inactive-product SQL.

SELECT current_database() AS db;

SELECT
  pg_get_functiondef(p.oid) LIKE '%Product is not available%' AS rejects_inactive_products,
  pg_get_functiondef(p.oid) LIKE '%FOR UPDATE%' AS locks_product_rows,
  position('RETURN v_order_id' in pg_get_functiondef(p.oid))
    < position('Product is not available' in pg_get_functiondef(p.oid)) AS idempotent_return_before_inactive_check,
  pg_get_functiondef(p.oid) LIKE '%orders_idempotency_actor_key_uidx%' AS keeps_idempotency_conflict,
  pg_get_functiondef(p.oid) LIKE '%qty_on_hand >= v_need%' AS keeps_stock_guard,
  pg_get_functiondef(p.oid) LIKE '%Admin or manager must provide city_id and seller_id%' AS keeps_staff_seller_city,
  pg_get_functiondef(p.oid) LIKE '%SECURITY DEFINER%' AS security_definer,
  pg_get_functiondef(p.oid) LIKE '%search_path%' AS search_path_set
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'confirm_order';

SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'confirm_order';
