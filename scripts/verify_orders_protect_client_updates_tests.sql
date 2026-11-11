-- Local/staging asserts after 5.20.1 apply. Prefer wrapping in BEGIN/ROLLBACK.
-- Not for Production. Privilege checks always run; DML bypass needs a row.

DO $$
BEGIN
  IF to_regprocedure('public.orders_block_client_write()') IS NULL THEN
    RAISE EXCEPTION 'block function missing';
  END IF;
  IF to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION 'complete_seller_debt_pay missing';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
     NOT LIKE '%PERFORM public.assert_active_auth_session()%' THEN
    RAISE EXCEPTION 'complete_seller_debt_pay must assert session';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
     NOT LIKE '%Debt is already paid%' THEN
    RAISE EXCEPTION 'complete_seller_debt_pay must reject already paid';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
     NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'complete_seller_debt_pay must lock the row';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
     NOT LIKE '%PERFORM public.mark_debt_paid(%' THEN
    RAISE EXCEPTION 'complete_seller_debt_pay must call mark_debt_paid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'orders' AND t.tgname = 'zz_orders_block_client_write'
  ) THEN
    RAISE EXCEPTION 'orders write trigger missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'order_items' AND t.tgname = 'zz_order_items_block_client_write'
  ) THEN
    RAISE EXCEPTION 'order_items write trigger missing';
  END IF;
  IF has_table_privilege('authenticated', 'public.orders', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'authenticated must SELECT orders';
  END IF;
  IF has_table_privilege('authenticated', 'public.orders', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT orders';
  END IF;
  IF has_table_privilege('authenticated', 'public.orders', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated must not UPDATE orders';
  END IF;
  IF has_table_privilege('authenticated', 'public.orders', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated must not DELETE orders';
  END IF;
  IF has_table_privilege('anon', 'public.orders', 'UPDATE') THEN
    RAISE EXCEPTION 'anon must not UPDATE orders';
  END IF;
  IF has_column_privilege('authenticated', 'public.orders', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated must not UPDATE orders.status';
  END IF;
  IF has_column_privilege('authenticated', 'public.orders', 'total_sum', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated must not UPDATE orders.total_sum';
  END IF;
  IF has_column_privilege('authenticated', 'public.orders', 'is_debt', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated must not UPDATE orders.is_debt';
  END IF;
  IF has_table_privilege('authenticated', 'public.order_items', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT order_items';
  END IF;
  IF has_column_privilege('authenticated', 'public.order_items', 'qty', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT order_items.qty';
  END IF;
  IF has_column_privilege('authenticated', 'public.order_items', 'qty', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'authenticated must SELECT order_items.qty';
  END IF;
  IF has_function_privilege('authenticated', 'public.complete_seller_debt_pay(uuid, text, text)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'authenticated must EXECUTE complete_seller_debt_pay';
  END IF;
  IF has_function_privilege('anon', 'public.complete_seller_debt_pay(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not EXECUTE complete_seller_debt_pay';
  END IF;
END $$;

DO $$
DECLARE
  v_id uuid;
  v_denied boolean;
BEGIN
  SELECT id INTO v_id FROM public.orders LIMIT 1;
  IF v_id IS NULL THEN
    RAISE NOTICE 'skip live DML bypass: no orders row';
    RETURN;
  END IF;

  v_denied := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.orders SET status = 'canceled' WHERE id = v_id;
    RESET ROLE;
    RAISE EXCEPTION 'JWT must not UPDATE status';
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true; RESET ROLE;
    WHEN others THEN
      RESET ROLE;
      IF SQLERRM LIKE '%Direct order table writes are not allowed%' THEN
        v_denied := true;
      ELSE
        RAISE;
      END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'expected denial on status update';
  END IF;

  v_denied := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.orders (id) VALUES (gen_random_uuid());
    RESET ROLE;
    RAISE EXCEPTION 'JWT must not INSERT orders';
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true; RESET ROLE;
    WHEN others THEN
      RESET ROLE;
      IF SQLERRM LIKE '%Direct order table writes are not allowed%' THEN
        v_denied := true;
      ELSE
        RAISE;
      END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'expected denial on orders insert';
  END IF;

  v_denied := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.order_items (order_id, qty, price) VALUES (v_id, 1, 1);
    RESET ROLE;
    RAISE EXCEPTION 'JWT must not INSERT order_items';
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true; RESET ROLE;
    WHEN undefined_column THEN v_denied := true; RESET ROLE;
    WHEN others THEN
      RESET ROLE;
      IF SQLERRM LIKE '%Direct order table writes are not allowed%'
         OR SQLERRM LIKE '%null value%' THEN
        v_denied := true;
      ELSE
        RAISE;
      END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'expected denial on order_items insert';
  END IF;
END $$;
