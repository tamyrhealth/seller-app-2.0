-- 5.17.6D: drop leftover table INSERT on inventory_movements for browser roles.
-- Does not change RLS, CHECK types, RPCs, or stock data.
-- Restock/adjust/orders/transfers/goods issues stay SECURITY DEFINER.

BEGIN;

REVOKE INSERT ON TABLE public.inventory_movements FROM PUBLIC;
REVOKE INSERT ON TABLE public.inventory_movements FROM anon;
REVOKE INSERT ON TABLE public.inventory_movements FROM authenticated;

COMMIT;
