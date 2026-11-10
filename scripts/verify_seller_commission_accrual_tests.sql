-- Local asserts for 5.17.4. Must run inside a transaction that rolls back.

DO $$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.seller_commission_accrue_order_internal(uuid, uuid, timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE accrue_order_internal';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.seller_commission_reverse_order_internal(uuid, uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE reverse_order_internal';
  END IF;
END $$;

DO $$
DECLARE
  v_plan uuid;
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'A';
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_tariff_rate_set(
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    200,
    TIMESTAMPTZ '2026-01-01 00:00:00+00'
  );
  PERFORM public.admin_seller_tariff_assign(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    v_plan,
    TIMESTAMPTZ '2026-01-01 00:00:00+00'
  );
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202001';
  v_item uuid := '21212121-2121-4212-8212-212121212001';
  v_row public.seller_ledger%ROWTYPE;
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, is_debt)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false, false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 2, false);
  SELECT * INTO v_row FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual';
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ordinary order must accrue';
  END IF;
  IF v_row.amount IS DISTINCT FROM 400 OR v_row.missing_rate OR v_row.unit_rate_snapshot IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'ordinary accrual qty*rate mismatch';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202002';
  v_item uuid := '21212121-2121-4212-8212-212121212002';
  v_row public.seller_ledger%ROWTYPE;
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, is_debt)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false, true);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  SELECT * INTO v_row FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual';
  IF v_row.amount IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'debt must accrue on confirm, not on payment';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202003';
  v_item uuid := '21212121-2121-4212-8212-212121212003';
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, preorder_status)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', true, 'pending');
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  IF EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_item_id = v_item) THEN
    RAISE EXCEPTION 'pending preorder must not accrue';
  END IF;
  UPDATE public.orders
  SET preorder_status = 'fulfilled', fulfilled_at = now(), status = 'confirmed'
  WHERE id = v_order;
  IF NOT EXISTS (
    SELECT 1 FROM public.seller_ledger
    WHERE order_item_id = v_item AND entry_type = 'accrual' AND amount = 200
  ) THEN
    RAISE EXCEPTION 'fulfilled preorder must accrue';
  END IF;
  UPDATE public.orders
  SET preorder_status = 'fulfilled', fulfilled_at = now()
  WHERE id = v_order;
  IF (
    SELECT count(*) FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'repeat fulfill must not double accrue';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202004';
  v_sale uuid := '21212121-2121-4212-8212-212121212004';
  v_gift uuid := '21212121-2121-4212-8212-212121212014';
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES
    (v_sale, v_order, '99999999-9999-4999-8999-999999999999', 1, false),
    (v_gift, v_order, '99999999-9999-4999-8999-999999999999', 1, true);
  IF EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_item_id = v_gift) THEN
    RAISE EXCEPTION 'gift must not accrue';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_item_id = v_sale AND amount = 200) THEN
    RAISE EXCEPTION 'non-gift line on mixed order must accrue';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202005';
  v_item uuid := '21212121-2121-4212-8212-212121212005';
  v_acc uuid;
  v_bal numeric;
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  SELECT id INTO v_acc FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual';
  UPDATE public.orders SET status = 'canceled', cancelled_at = now() WHERE id = v_order;
  IF NOT EXISTS (
    SELECT 1 FROM public.seller_ledger
    WHERE entry_type = 'reversal' AND reversal_of = v_acc AND amount = -200
  ) THEN
    RAISE EXCEPTION 'cancel must reverse accrual';
  END IF;
  UPDATE public.orders SET status = 'canceled' WHERE id = v_order;
  IF (
    SELECT count(*) FROM public.seller_ledger WHERE reversal_of = v_acc AND entry_type = 'reversal'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'repeat cancel must not double reverse';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.seller_ledger
    WHERE order_item_id = v_item AND entry_type = 'accrual' AND id <> v_acc
  ) THEN
    RAISE EXCEPTION 'cancel must not create a new accrual';
  END IF;
  v_bal := public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF v_bal IS NULL THEN
    RAISE EXCEPTION 'balance missing after cancel';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202006';
  v_item uuid := '21212121-2121-4212-8212-212121212006';
  v_plan uuid;
  v_old numeric;
BEGIN
  SELECT amount INTO v_old
  FROM public.seller_ledger
  WHERE order_item_id = '21212121-2121-4212-8212-212121212001' AND entry_type = 'accrual';
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'A';
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_tariff_rate_set(
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    350,
    TIMESTAMPTZ '2026-06-01 00:00:00+00'
  );
  RESET ROLE;
  IF v_old IS DISTINCT FROM 400 THEN
    RAISE EXCEPTION 'changing tariff must not rewrite old accrual';
  END IF;
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  IF NOT EXISTS (
    SELECT 1 FROM public.seller_ledger
    WHERE order_item_id = v_item AND entry_type = 'accrual' AND amount = 350 AND unit_rate_snapshot = 350
  ) THEN
    RAISE EXCEPTION 'new order must use new rate';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202007';
  v_item uuid := '21212121-2121-4212-8212-212121212007';
  v_row public.seller_ledger%ROWTYPE;
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder)
  VALUES (v_order, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 2, false);
  SELECT * INTO v_row FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual';
  IF NOT v_row.missing_rate OR v_row.amount IS DISTINCT FROM 0 OR v_row.unit_rate_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'missing assignment must be explicit missing_rate, not a fake zero snapshot';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202008';
  v_item uuid := '21212121-2121-4212-8212-212121212008';
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  PERFORM public.seller_commission_accrue_order_internal(v_order, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now());
  IF (
    SELECT count(*) FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'repeat accrue RPC must be idempotent';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202009';
  v_item uuid := '21212121-2121-4212-8212-212121212009';
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, preorder_status)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', true, 'pending');
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  UPDATE public.orders SET status = 'canceled', cancelled_at = now(), preorder_status = 'cancelled' WHERE id = v_order;
  IF EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_id = v_order) THEN
    RAISE EXCEPTION 'cancel pending preorder must not create commission';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202010';
  v_item uuid := '21212121-2121-4212-8212-212121212010';
  v_acc uuid;
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, preorder_status)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', true, 'pending');
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  UPDATE public.orders
  SET preorder_status = 'fulfilled', fulfilled_at = now(), status = 'confirmed'
  WHERE id = v_order;
  SELECT id INTO v_acc FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual';
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'fulfilled preorder before cancel must accrue';
  END IF;
  UPDATE public.orders SET status = 'canceled', cancelled_at = now(), preorder_status = 'cancelled' WHERE id = v_order;
  IF NOT EXISTS (
    SELECT 1 FROM public.seller_ledger WHERE reversal_of = v_acc AND entry_type = 'reversal'
  ) THEN
    RAISE EXCEPTION 'cancel after fulfill must reverse';
  END IF;
END $$;

DO $$
DECLARE
  v_item uuid := '21212121-2121-4212-8212-212121212001';
BEGIN
  BEGIN
    UPDATE public.order_items SET qty = 9 WHERE id = v_item;
    RAISE EXCEPTION 'qty update must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%immutable%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    DELETE FROM public.order_items WHERE id = v_item;
    RAISE EXCEPTION 'delete with commission must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%cannot be deleted%' THEN
        RAISE;
      END IF;
  END;
END $$;

DO $$
DECLARE
  v_item uuid := '21212121-2121-4212-8212-212121212007';
  v_list jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v_list := public.admin_seller_missing_accruals_list(50);
  IF jsonb_array_length(v_list->'items') < 1 THEN
    RAISE EXCEPTION 'missing_rate list must be visible to admin';
  END IF;
  BEGIN
    PERFORM public.admin_seller_accrual_retry_item(v_item);
    RAISE EXCEPTION 'missing_rate snapshot must stay immutable';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%immutable%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_accrual_retry_item('21212121-2121-4212-8212-212121212007');
    RAISE EXCEPTION 'manager must not retry accrual';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  PERFORM public.admin_seller_missing_accruals_list(10);
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_order uuid := '20202020-2020-4200-8200-202020202011';
  v_item uuid := '21212121-2121-4212-8212-212121212011';
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 0, false);
  IF EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_item_id = v_item) THEN
    RAISE EXCEPTION 'zero qty must not accrue';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.finance_expenses') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.finance_expenses) THEN
      RAISE EXCEPTION 'must not write finance_expenses';
    END IF;
  END IF;
  IF to_regclass('public.inventory') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.inventory) THEN
      RAISE EXCEPTION 'must not write inventory';
    END IF;
  END IF;
END $$;
