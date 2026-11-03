-- SQL-тесты confirm_order на STAGING.
-- Требуется impersonation: auth.uid() должен быть staging seller.
-- В SQL Editor: Run as user = Staging Seller
-- или:
--   SELECT set_config('request.jwt.claims',
--     json_build_object('sub', '<seller-uuid>', 'role', 'authenticated')::text, true);

DO $$
DECLARE
  v_seller uuid;
  v_city uuid;
  v_p1 uuid;
  v_p2 uuid;
  v_ord uuid;
  v_ord2 uuid;
  v_stock numeric;
  v_key text := gen_random_uuid()::text;
  v_ok boolean;
BEGIN
  SELECT id, city_id INTO v_seller, v_city FROM public.profiles WHERE role = 'seller' AND display_name = 'Staging Seller';
  SELECT id INTO v_p1 FROM public.products WHERE name = 'STAGING Product A';
  SELECT id INTO v_p2 FROM public.products WHERE name = 'STAGING Product B';
  IF v_seller IS NULL OR v_p1 IS NULL OR v_p2 IS NULL THEN
    RAISE EXCEPTION 'Run seed_synthetic.sql first';
  END IF;
  IF auth.uid() IS DISTINCT FROM v_seller THEN
    RAISE EXCEPTION 'auth.uid()=% must equal seller % — impersonate Staging Seller', auth.uid(), v_seller;
  END IF;

  UPDATE public.inventory SET qty_on_hand = 10 WHERE city_id = v_city AND product_id = v_p1;
  UPDATE public.inventory SET qty_on_hand = 1 WHERE city_id = v_city AND product_id = v_p2;

  -- 1) Обычный заказ
  v_ord := public.confirm_order(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty', 2, 'price', '1000')),
    'payment_type', 'cash',
    'is_preorder', false,
    'idempotency_key', v_key
  ));
  SELECT qty_on_hand INTO v_stock FROM public.inventory WHERE city_id = v_city AND product_id = v_p1;
  IF v_stock <> 8 THEN RAISE EXCEPTION 'ordinary stock want 8 got %', v_stock; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = v_ord AND o.payment_type = 'cash' AND o.is_debt IS NOT TRUE
      AND o.is_preorder IS NOT TRUE AND o.debt_status IS NULL
  ) THEN
    RAISE EXCEPTION 'ordinary order fields mismatch';
  END IF;

  -- 2) Повтор того же ключа → тот же order_id, сток не трогать
  v_ord2 := public.confirm_order(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty', 2, 'price', '1000')),
    'payment_type', 'cash',
    'is_preorder', false,
    'idempotency_key', v_key
  ));
  IF v_ord2 <> v_ord THEN RAISE EXCEPTION 'idempotency must return same order_id'; END IF;
  SELECT qty_on_hand INTO v_stock FROM public.inventory WHERE city_id = v_city AND product_id = v_p1;
  IF v_stock <> 8 THEN RAISE EXCEPTION 'idempotent retry must not deduct again, stock=%', v_stock; END IF;

  -- 3) Долг
  v_ord := public.confirm_order(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty', 1, 'price', '1000')),
    'is_debt', true,
    'payment_type', 'debt',
    'debt_customer_phone', '77000000001',
    'debt_customer_name', 'Staging Client',
    'debt_due_at', '2026-12-01',
    'debt_note', 'test note',
    'idempotency_key', gen_random_uuid()::text
  ));
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = v_ord AND o.is_debt = true AND o.payment_type = 'debt'
      AND o.debt_status = 'active' AND o.debt_customer_phone = '77000000001'
      AND o.debt_customer_name = 'Staging Client'
  ) THEN
    RAISE EXCEPTION 'debt fields mismatch';
  END IF;
  SELECT qty_on_hand INTO v_stock FROM public.inventory WHERE city_id = v_city AND product_id = v_p1;
  IF v_stock <> 7 THEN RAISE EXCEPTION 'debt must deduct, stock=%', v_stock; END IF;

  -- 4) Предзаказ: сток не списывать
  SELECT qty_on_hand INTO v_stock FROM public.inventory WHERE city_id = v_city AND product_id = v_p1;
  v_ord := public.confirm_order(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty', 3, 'price', '1000')),
    'payment_type', 'kaspi',
    'is_preorder', true,
    'pickup_date', '2026-11-20',
    'comment', 'staging preorder',
    'idempotency_key', gen_random_uuid()::text
  ));
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = v_ord AND o.is_preorder = true AND o.preorder_status = 'pending'
      AND o.pickup_date = '2026-11-20' AND o.payment_type = 'kaspi'
  ) THEN
    RAISE EXCEPTION 'preorder fields mismatch';
  END IF;
  IF (SELECT qty_on_hand FROM public.inventory WHERE city_id = v_city AND product_id = v_p1) <> v_stock THEN
    RAISE EXCEPTION 'preorder must not deduct stock';
  END IF;

  -- 5) Две строки одного товара, остатка хватает
  v_ord := public.confirm_order(jsonb_build_object(
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'qty', 2, 'price', '1000'),
      jsonb_build_object('product_id', v_p1, 'qty', 1, 'price', '900')
    ),
    'payment_type', 'cash',
    'idempotency_key', gen_random_uuid()::text
  ));
  IF (SELECT count(*) FROM public.order_items WHERE order_id = v_ord) <> 2 THEN
    RAISE EXCEPTION 'expected 2 order_items';
  END IF;
  IF (SELECT qty_on_hand FROM public.inventory WHERE city_id = v_city AND product_id = v_p1) <> (v_stock - 3) THEN
    RAISE EXCEPTION 'duplicate product_id must deduct SUM qty';
  END IF;

  -- 6) Две строки одного товара, остатка не хватает на сумму
  UPDATE public.inventory SET qty_on_hand = 8 WHERE city_id = v_city AND product_id = v_p1;
  v_ok := false;
  BEGIN
    PERFORM public.confirm_order(jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('product_id', v_p1, 'qty', 5, 'price', '1000'),
        jsonb_build_object('product_id', v_p1, 'qty', 5, 'price', '1000')
      ),
      'payment_type', 'cash',
      'idempotency_key', gen_random_uuid()::text
    ));
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'Insufficient stock%' THEN v_ok := true; ELSE RAISE; END IF;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'expected insufficient stock for 5+5 vs 8'; END IF;
  IF (SELECT qty_on_hand FROM public.inventory WHERE city_id = v_city AND product_id = v_p1) <> 8 THEN
    RAISE EXCEPTION 'failed order must roll back stock';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_items i
    JOIN public.orders o ON o.id = i.order_id
    WHERE i.product_id = v_p1 AND i.qty = 5 AND o.seller_id = v_seller
      AND o.created_at > now() - interval '15 seconds'
  ) THEN
    RAISE EXCEPTION 'insufficient-stock order rows must not remain';
  END IF;

  RAISE NOTICE 'confirm_order sequential tests OK';
END $$;
