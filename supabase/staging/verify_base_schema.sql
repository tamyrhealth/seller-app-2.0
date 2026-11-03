-- Проверка базовой схемы staging ДО миграции идемпотентности.
-- Ожидание: confirm_order есть, колонок idempotency_* ещё нет.

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'cities', 'profiles', 'products', 'inventory',
    'orders', 'order_items', 'inventory_movements'
  )
ORDER BY 1;

SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'confirm_order', 'fulfill_preorder', 'cancel_order', 'cancel_preorder',
    'admin_cancel_order', 'mark_debt_paid', 'get_user_role', 'get_user_city_id',
    'orders_sync_debt_fields', 'set_updated_at'
  )
ORDER BY 1;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'inventory' AND column_name = 'qty_on_hand')
    OR (table_name = 'inventory_movements' AND column_name = 'qty_delta')
    OR (table_name = 'order_items' AND column_name IN ('qty', 'is_gift'))
    OR (table_name = 'orders' AND column_name LIKE 'idempotency%')
    OR (table_name = 'orders' AND column_name IN (
      'is_debt', 'debt_status', 'debt_customer_phone', 'is_preorder', 'pickup_date'
    ))
    OR (table_name = 'cities' AND column_name = 'is_active')
  )
ORDER BY table_name, column_name;

SELECT tgname, rel.relname AS table_name
FROM pg_trigger t
JOIN pg_class rel ON rel.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
  AND tgname IN ('orders_sync_debt_trigger', 'inventory_updated_at', 'orders_updated_at')
ORDER BY 1;

SELECT id, email FROM auth.users
WHERE email LIKE 'staging-%@example.test'
ORDER BY email;
