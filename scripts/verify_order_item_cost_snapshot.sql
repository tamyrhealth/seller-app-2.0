-- Local/staging harness for 5.13.2. Do NOT run against Production.
-- Does not INSERT live seller orders. Assertions are source/privilege checks
-- plus optional throwaway rows in a transaction that rolls back.
--
-- Scenario matrix (all must remain true after apply; exercise only on staging):
-- 1. Ordinary sale: INSERT snapshot = products.cost_price (or NULL).
-- 2. Debt sale: same snapshot write; debt fields unchanged.
-- 3. Preorder: snapshot written; inventory not decremented at confirm.
-- 4. Gift: price/line_sum 0; snapshot still catalog cost (or NULL).
-- 5. Cancel: cancel RPC does not UPDATE cost_price_snapshot.
-- 6. Repeat confirm with same idempotency key: same order id; items not rewritten.
-- 7. Change products.cost_price after confirm: snapshot stays the old value.
-- 8. NULL catalog cost → snapshot NULL; cost 0 → snapshot 0.
-- 9. Fractional qty still allowed; snapshot is unit cost not qty*cost.
-- 10. Inactive product: Product is not available; no item row.
-- 11. Missing product_id: statement error; transaction rolls back.
-- 12. Error after first item: unique/stock exception rolls back all items.
-- 13. Leak: authenticated SELECT cost_price_snapshot fails; SELECT * fails or omits;
--     admin_order_item_cost_snapshots denied for seller/manager/inactive;
--     anon has no EXECUTE; order history JSON has no cost.

BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'confirm_order'
    AND pg_get_function_identity_arguments(p.oid) = 'payload jsonb';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'confirm_order missing';
  END IF;
  IF v_def NOT LIKE '%cost_price_snapshot%' OR v_def NOT LIKE '%v_cost%' THEN
    RAISE EXCEPTION 'confirm_order does not write snapshot';
  END IF;
  IF v_def LIKE '%''cost_price''%' AND v_def LIKE '%v_fp_obj := jsonb_build_object%' THEN
    IF split_part(v_def, 'v_fp := md5', 1) LIKE '%cost_price_snapshot%' THEN
      RAISE EXCEPTION 'fingerprint includes snapshot';
    END IF;
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.order_items', 'qty', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on public order_items columns';
  END IF;
  IF has_column_privilege('authenticated', 'public.order_items', 'cost_price_snapshot', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated can SELECT snapshot';
  END IF;
  IF has_column_privilege('anon', 'public.order_items', 'cost_price_snapshot', 'SELECT') THEN
    RAISE EXCEPTION 'anon can SELECT snapshot';
  END IF;
  IF has_function_privilege('anon', 'public.admin_order_item_cost_snapshots(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute snapshot rpc';
  END IF;
END
$$;

ROLLBACK;
