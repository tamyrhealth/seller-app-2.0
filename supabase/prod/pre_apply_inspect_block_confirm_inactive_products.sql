-- Read-only. Run BEFORE confirm_order inactive-product SQL.

SELECT current_database() AS db;

SELECT to_regclass('public.products') AS products,
       to_regclass('public.orders') AS orders,
       to_regclass('public.order_items') AS order_items,
       to_regclass('public.inventory') AS inventory;

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active';

SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'confirm_order';
