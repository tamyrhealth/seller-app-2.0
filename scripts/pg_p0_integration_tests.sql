-- Real PostgreSQL assertions after P0 apply. Not Production.

DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
  BEGIN
    INSERT INTO public.orders (seller_id, status, total_sum) VALUES (auth.uid(), 'confirmed', 1);
    RAISE EXCEPTION 'JWT INSERT orders must fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Direct order table writes are not allowed%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.orders SET status = 'canceled' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'JWT UPDATE orders must fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Direct order table writes are not allowed%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.orders WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'JWT DELETE orders must fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Direct order table writes are not allowed%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.order_items (order_id, qty, price)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, 1);
    RAISE EXCEPTION 'JWT INSERT order_items must fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Direct order table writes are not allowed%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.order_items SET qty = 9 WHERE false;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.order_items WHERE false;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.complete_seller_debt_pay(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'cash',
    '77011234567'
  );
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      AND debt_status = 'paid'
      AND payment_type = 'cash'
  ) THEN
    RAISE EXCEPTION 'own debt pay via complete_seller_debt_pay failed';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.complete_seller_debt_pay(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'cash',
      '77011234567'
    );
    RAISE EXCEPTION 'seller must not pay foreign debt via complete_seller_debt_pay';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller can only mark own debts as paid%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.mark_debt_paid('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cash');
    RAISE EXCEPTION 'seller must not pay foreign debt via mark_debt_paid';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller can only mark own debts as paid%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.complete_seller_debt_pay(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'kaspi',
      '77011234567'
    );
    RAISE EXCEPTION 'replay must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Debt is already paid%' THEN RAISE; END IF;
  END;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.mark_debt_paid('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'kaspi');
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND debt_status = 'paid'
  ) THEN
    RAISE EXCEPTION 'admin mark_debt_paid on any debt must still work';
  END IF;
END $$;

DO $$
DECLARE
  v_id uuid;
  v_status text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  SET LOCAL ROLE authenticated;
  v_id := public.confirm_order('{"payment_type":"cash"}'::jsonb);
  SELECT status INTO v_status FROM public.orders WHERE id = v_id;
  IF v_status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'confirm_order must insert as DEFINER after P0';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_id) THEN
    RAISE EXCEPTION 'confirm_order must insert order_items as DEFINER after P0';
  END IF;
  PERFORM public.cancel_order(v_id);
  SELECT status INTO v_status FROM public.orders WHERE id = v_id;
  IF v_status IS DISTINCT FROM 'canceled' THEN
    RAISE EXCEPTION 'cancel_order must update as DEFINER after P0';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'orders' AND t.tgname = 'seller_commission_orders_au_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'commission orders trigger missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'orders' AND t.tgname = 'orders_log_insert_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'audit insert trigger missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commission_hits WHERE kind = 'orders_au') THEN
    RAISE EXCEPTION 'commission AFTER UPDATE did not fire';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.action_logs WHERE kind IN ('order_insert', 'debt_pay')) THEN
    RAISE EXCEPTION 'audit log missing';
  END IF;
END $$;
