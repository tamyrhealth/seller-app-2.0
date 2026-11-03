-- Read-only checks AFTER confirm_order idempotency SQL on MAIN db.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db,
       inet_server_addr() AS server_addr;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders'
  AND column_name IN ('idempotency_key', 'idempotency_fingerprint', 'idempotency_actor_id')
ORDER BY 1;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'orders_idempotency_actor_key_uidx';

SELECT pg_get_functiondef(p.oid) LIKE '%idempotency_key%' AS confirm_order_has_idempotency,
       pg_get_functiondef(p.oid) LIKE '%SUM((e%qty%' AS deducts_sum_by_product
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_order'
  AND pg_get_function_identity_arguments(p.oid) = 'payload jsonb';

SELECT
  (SELECT count(*) FROM public.cities) AS cities,
  (SELECT count(*) FROM public.profiles) AS profiles,
  (SELECT count(*) FROM public.products) AS products,
  (SELECT count(*) FROM public.orders) AS orders,
  (SELECT count(*) FROM public.inventory) AS inventory_rows;
