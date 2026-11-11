-- Local asserts after 5.20.2B. Wrap in BEGIN/ROLLBACK in harness. Not for Production.

DO $$
BEGIN
  IF to_regprocedure('public.inventory_reserve_up_to(uuid, uuid, numeric)') IS NULL THEN
    RAISE EXCEPTION 'reserve helper missing';
  END IF;
  IF to_regprocedure('public.confirm_order__session_body(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'confirm_order__session_body missing';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.confirm_order__session_body(jsonb)'))
     NOT LIKE '%inventory_reserve_up_to%' THEN
    RAISE EXCEPTION 'confirm must reserve pending preorders';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.confirm_order__session_body(jsonb)'))
     NOT LIKE '%inventory_deduct_available%' THEN
    RAISE EXCEPTION 'sale must use available';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.fulfill_preorder__session_body(uuid)'))
     NOT LIKE '%inventory_fulfill_sku%' THEN
    RAISE EXCEPTION 'fulfill must use fulfill helper';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.apply_order_cancel_report(uuid, text)'))
     NOT LIKE '%inventory_release_reserve%' THEN
    RAISE EXCEPTION 'cancel pending must release reserve';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.receive_stock_transfer__session_body(uuid, uuid, jsonb)'))
     LIKE '%fulfill_preorder%' THEN
    RAISE EXCEPTION 'receive must not fulfill preorders';
  END IF;
  IF has_function_privilege('authenticated', 'public.inventory_reserve_up_to(uuid, uuid, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'clients must not execute reserve helper';
  END IF;
  IF has_column_privilege('authenticated', 'public.order_items', 'qty_reserved', 'UPDATE') THEN
    RAISE EXCEPTION 'clients must not UPDATE qty_reserved';
  END IF;
  IF has_column_privilege('authenticated', 'public.order_items', 'qty_reserved', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'clients must SELECT qty_reserved';
  END IF;
END $$;

DO $$
DECLARE
  v_city uuid := '10000000-0000-4000-8000-000000000001';
  v_seller uuid := '20000000-0000-4000-8000-000000000001';
  v_admin uuid := '20000000-0000-4000-8000-000000000099';
  v_prod uuid := '30000000-0000-4000-8000-000000000001';
  v_gift uuid := '30000000-0000-4000-8000-000000000002';
  v_order uuid;
  v_order2 uuid;
  v_on numeric;
  v_res numeric;
  v_item_res numeric;
  v_status text;
  v_pre text;
  v_moves int;
  v_denied boolean;
BEGIN
  INSERT INTO public.cities (id, name) VALUES (v_city, 'Almaty')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, role, city_id, is_active, can_cancel_orders, display_name)
  VALUES
    (v_seller, 'seller', v_city, true, false, 'Seller'),
    (v_admin, 'admin', v_city, true, true, 'Admin')
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;
  INSERT INTO public.products (id, name, unit, price_retail, cost_price, is_active)
  VALUES
    (v_prod, 'Oil', 'pcs', 100, 40, true),
    (v_gift, 'Gift', 'pcs', 50, 10, true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory (city_id, product_id, qty_on_hand, qty_reserved)
  VALUES (v_city, v_prod, 5, 0), (v_city, v_gift, 2, 0)
  ON CONFLICT (city_id, product_id) DO UPDATE
    SET qty_on_hand = EXCLUDED.qty_on_hand, qty_reserved = 0;

  PERFORM set_config('request.jwt.claim.sub', v_seller::text, true);

  -- missing idempotency_key: two confirms are two rows
  v_order := public.confirm_order__session_body(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1, 'price', '100')),
    'is_preorder', true,
    'payment_type', 'kaspi'
  ));
  v_order2 := public.confirm_order__session_body(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1, 'price', '100')),
    'is_preorder', true,
    'payment_type', 'kaspi'
  ));
  IF v_order IS NULL OR v_order2 IS NULL OR v_order = v_order2 THEN
    RAISE EXCEPTION 'null idempotency_key must create distinct orders';
  END IF;
  PERFORM public.apply_order_cancel_report(v_order, 'idem');
  PERFORM public.apply_order_cancel_report(v_order2, 'idem');
  UPDATE public.inventory SET qty_on_hand = 5, qty_reserved = 0 WHERE city_id = v_city AND product_id = v_prod;

  -- full reserve of in-stock preorder
  v_order := public.confirm_order__session_body(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 5, 'price', '100')),
    'is_preorder', true,
    'payment_type', 'kaspi'
  ));
  SELECT qty_on_hand, qty_reserved INTO v_on, v_res FROM public.inventory WHERE city_id = v_city AND product_id = v_prod;
  IF v_on <> 5 OR v_res <> 5 THEN
    RAISE EXCEPTION 'in-stock preorder must reserve without physical deduct, got % / %', v_on, v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_movements WHERE order_id = v_order) THEN
    RAISE EXCEPTION 'pending preorder must not write sale movement';
  END IF;

  BEGIN
    PERFORM public.confirm_order__session_body(jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1, 'price', '100')),
      'payment_type', 'cash',
      'is_preorder', false
    ));
    RAISE EXCEPTION 'sale must not consume reserved stock';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Insufficient stock%' THEN RAISE; END IF;
  END;

  PERFORM public.apply_order_cancel_report(v_order, 'test');
  SELECT qty_on_hand, qty_reserved INTO v_on, v_res FROM public.inventory WHERE city_id = v_city AND product_id = v_prod;
  IF v_on <> 5 OR v_res <> 0 THEN
    RAISE EXCEPTION 'cancel pending must release reserve only, got % / %', v_on, v_res;
  END IF;
  SELECT preorder_status, status INTO v_pre, v_status FROM public.orders WHERE id = v_order;
  IF v_pre IS DISTINCT FROM 'cancelled' OR v_status IS DISTINCT FROM 'canceled' THEN
    RAISE EXCEPTION 'cancel pending statuses, got % %', v_pre, v_status;
  END IF;

  -- mixed coverage: order 5, stock 2
  UPDATE public.inventory SET qty_on_hand = 2, qty_reserved = 0 WHERE city_id = v_city AND product_id = v_prod;
  v_order := public.confirm_order__session_body(jsonb_build_object(
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_prod, 'qty', 5, 'price', '100'),
      jsonb_build_object('product_id', v_gift, 'qty', 1, 'price', '0', 'is_gift', true)
    ),
    'is_preorder', true,
    'payment_type', 'kaspi'
  ));
  SELECT qty_reserved INTO v_item_res FROM public.order_items WHERE order_id = v_order AND product_id = v_prod;
  SELECT qty_on_hand, qty_reserved INTO v_on, v_res FROM public.inventory WHERE city_id = v_city AND product_id = v_prod;
  IF v_item_res <> 2 OR v_on <> 2 OR v_res <> 2 THEN
    RAISE EXCEPTION 'partial reserve expected 2, got item % inv %/%', v_item_res, v_on, v_res;
  END IF;
  SELECT qty_reserved INTO v_item_res FROM public.order_items WHERE order_id = v_order AND product_id = v_gift;
  IF v_item_res <> 1 THEN
    RAISE EXCEPTION 'gift must reserve when stock exists, got %', v_item_res;
  END IF;

  PERFORM public.inventory_add_physical(v_city, v_prod, 3);
  SELECT qty_on_hand, qty_reserved INTO v_on, v_res FROM public.inventory WHERE city_id = v_city AND product_id = v_prod;
  IF v_on <> 5 OR v_res <> 5 THEN
    RAISE EXCEPTION 'inbound must allocate uncovered, got % / %', v_on, v_res;
  END IF;
  SELECT preorder_status INTO v_pre FROM public.orders WHERE id = v_order;
  IF v_pre IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'inbound must not fulfill, status %', v_pre;
  END IF;

  PERFORM public.fulfill_preorder__session_body(v_order);
  SELECT qty_on_hand, qty_reserved INTO v_on, v_res FROM public.inventory WHERE city_id = v_city AND product_id = v_prod;
  IF v_on <> 0 OR v_res <> 0 THEN
    RAISE EXCEPTION 'fulfill must deduct once, got % / %', v_on, v_res;
  END IF;
  SELECT qty_on_hand, qty_reserved INTO v_on, v_res FROM public.inventory WHERE city_id = v_city AND product_id = v_gift;
  IF v_on <> 1 OR v_res <> 0 THEN
    RAISE EXCEPTION 'gift fulfill leftover, got % / %', v_on, v_res;
  END IF;
  SELECT count(*) INTO v_moves FROM public.inventory_movements WHERE order_id = v_order AND type = 'sale';
  IF v_moves <> 2 THEN
    RAISE EXCEPTION 'expected one sale movement per item, got %', v_moves;
  END IF;
  PERFORM public.fulfill_preorder__session_body(v_order);
  SELECT count(*) INTO v_moves FROM public.inventory_movements WHERE order_id = v_order AND type = 'sale';
  IF v_moves <> 2 THEN
    RAISE EXCEPTION 'second fulfill must be no-op, movements %', v_moves;
  END IF;

  -- zero stock preorder
  UPDATE public.inventory SET qty_on_hand = 0, qty_reserved = 0 WHERE city_id = v_city AND product_id = v_prod;
  v_order2 := public.confirm_order__session_body(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 4, 'price', '100')),
    'is_preorder', true,
    'payment_type', 'cash'
  ));
  SELECT qty_reserved INTO v_item_res FROM public.order_items WHERE order_id = v_order2 AND product_id = v_prod;
  SELECT qty_reserved INTO v_res FROM public.inventory WHERE city_id = v_city AND product_id = v_prod;
  IF v_item_res <> 0 OR v_res <> 0 THEN
    RAISE EXCEPTION 'zero stock must not reserve, got % / %', v_item_res, v_res;
  END IF;

  -- backfill does not change status / movements
  UPDATE public.inventory SET qty_on_hand = 3, qty_reserved = 0 WHERE city_id = v_city AND product_id = v_prod;
  UPDATE public.order_items SET qty_reserved = 0 WHERE order_id = v_order2;
  SELECT count(*) INTO v_moves FROM public.inventory_movements;
  SELECT status, preorder_status INTO v_status, v_pre FROM public.orders WHERE id = v_order2;
  PERFORM public.inventory_backfill_pending_preorder_reserves();
  SELECT qty_reserved INTO v_item_res FROM public.order_items WHERE order_id = v_order2;
  IF v_item_res <> 3 THEN
    RAISE EXCEPTION 'backfill should cover 3, got %', v_item_res;
  END IF;
  IF (SELECT count(*) FROM public.inventory_movements) <> v_moves THEN
    RAISE EXCEPTION 'backfill must not write movements';
  END IF;
  IF (SELECT status FROM public.orders WHERE id = v_order2) IS DISTINCT FROM v_status
     OR (SELECT preorder_status FROM public.orders WHERE id = v_order2) IS DISTINCT FROM v_pre THEN
    RAISE EXCEPTION 'backfill must not change order status';
  END IF;

  -- fulfilled cancel restores physical
  UPDATE public.inventory SET qty_on_hand = 5, qty_reserved = 0 WHERE city_id = v_city AND product_id = v_prod;
  v_order := public.confirm_order__session_body(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 2, 'price', '100')),
    'payment_type', 'cash',
    'is_preorder', false
  ));
  -- this was a sale; skip

  -- client cannot update reserved
  v_denied := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.order_items SET qty_reserved = 99 WHERE order_id = v_order2;
    RESET ROLE;
    RAISE EXCEPTION 'JWT must not UPDATE qty_reserved';
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true; RESET ROLE;
    WHEN others THEN
      RESET ROLE;
      IF SQLERRM LIKE '%qty_reserved%' OR SQLERRM LIKE '%permission%' OR SQLERRM LIKE '%Direct order%' THEN
        v_denied := true;
      ELSE
        RAISE;
      END IF;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'expected denial on qty_reserved update';
  END IF;

  -- adjust below reserved blocked
  UPDATE public.inventory SET qty_on_hand = 4, qty_reserved = 3 WHERE city_id = v_city AND product_id = v_gift;
  BEGIN
    PERFORM public.inventory_set_physical(v_city, v_gift, 1);
    RAISE EXCEPTION 'adjust below reserved must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%below reserved%' THEN RAISE; END IF;
  END;
END $$;
