-- Local asserts for 5.19.4. Must run inside a transaction that rolls back.

DO $$
BEGIN
  IF NOT has_function_privilege(
    'authenticated',
    'public.admin_seller_unaccrued_items_list(integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must EXECUTE unaccrued list';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.admin_seller_unaccrued_items_list(integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon must not EXECUTE unaccrued list';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '30303030-3030-4300-8300-303030303001';
  v_item uuid := '31313131-3131-4313-8313-313131313001';
  v_list jsonb;
  v_sum jsonb;
  v_row jsonb;
  v_acc public.seller_ledger%ROWTYPE;
  v_before integer;
BEGIN
  ALTER TABLE public.order_items DISABLE TRIGGER seller_commission_order_items_ai_trg;
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, created_at)
  VALUES (
    v_order,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'confirmed',
    false,
    now()
  );
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 2, false);
  ALTER TABLE public.order_items ENABLE TRIGGER seller_commission_order_items_ai_trg;

  IF EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_item_id = v_item) THEN
    RAISE EXCEPTION 'disabled trigger must skip accrual';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v_list := public.admin_seller_unaccrued_items_list(50);
  v_sum := public.admin_seller_accrual_consistency_summary();
  RESET ROLE;

  SELECT value INTO v_row
  FROM jsonb_array_elements(v_list->'items') e
  WHERE e.value->>'order_item_id' = v_item::text;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'hook skip must appear in unaccrued list';
  END IF;
  IF v_row->>'reason' IS DISTINCT FROM 'hook_skip' OR (v_row->>'retryable')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'hook skip classification %', v_row;
  END IF;
  IF (v_sum->>'unaccrued_hook_skip')::int < 1 THEN
    RAISE EXCEPTION 'summary hook_skip %', v_sum;
  END IF;
  IF (v_sum->>'auto_recalc')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'summary must not auto-recalc';
  END IF;

  SELECT COUNT(*)::int INTO v_before FROM public.seller_ledger WHERE entry_type = 'accrual';
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_accrual_retry_item(v_item);
  BEGIN
    PERFORM public.admin_seller_accrual_retry_item(v_item);
    RAISE EXCEPTION 'repeat retry must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%already exists%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;

  SELECT * INTO v_acc FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual';
  IF v_acc.amount IS DISTINCT FROM 700 OR v_acc.unit_rate_snapshot IS DISTINCT FROM 350 OR v_acc.missing_rate THEN
    RAISE EXCEPTION 'retry must use sale-time rate, got amount=% rate=%', v_acc.amount, v_acc.unit_rate_snapshot;
  END IF;
  IF (
    SELECT COUNT(*) FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'retry must not double ledger';
  END IF;
  IF (SELECT COUNT(*)::int FROM public.seller_ledger WHERE entry_type = 'accrual') IS DISTINCT FROM v_before + 1 THEN
    RAISE EXCEPTION 'retry must add exactly one accrual';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '30303030-3030-4300-8300-303030303002';
  v_item uuid := '31313131-3131-4313-8313-313131313002';
  v_plan uuid;
  v_acc public.seller_ledger%ROWTYPE;
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'A';
  ALTER TABLE public.order_items DISABLE TRIGGER seller_commission_order_items_ai_trg;
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, created_at)
  VALUES (
    v_order,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'confirmed',
    false,
    now()
  );
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  ALTER TABLE public.order_items ENABLE TRIGGER seller_commission_order_items_ai_trg;

  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_tariff_rate_set(
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    900,
    now() + interval '1 day'
  );
  PERFORM public.admin_seller_accrual_retry_item(v_item);
  RESET ROLE;

  SELECT * INTO v_acc FROM public.seller_ledger WHERE order_item_id = v_item AND entry_type = 'accrual';
  IF v_acc.unit_rate_snapshot IS DISTINCT FROM 350 OR v_acc.amount IS DISTINCT FROM 350 THEN
    RAISE EXCEPTION 'retry must not use later current tariff %', v_acc.unit_rate_snapshot;
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '30303030-3030-4300-8300-303030303012';
  v_item uuid := '31313131-3131-4313-8313-313131313012';
  v_row jsonb;
BEGIN
  ALTER TABLE public.order_items DISABLE TRIGGER seller_commission_order_items_ai_trg;
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, created_at)
  VALUES (
    v_order,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'confirmed',
    false,
    now() - interval '1 day'
  );
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  ALTER TABLE public.order_items ENABLE TRIGGER seller_commission_order_items_ai_trg;

  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  SELECT value INTO v_row
  FROM jsonb_array_elements(public.admin_seller_unaccrued_items_list(50)->'items') e
  WHERE e.value->>'order_item_id' = v_item::text;
  IF v_row->>'reason' IS DISTINCT FROM 'backdated_tariff' OR (v_row->>'retryable')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'backdated tariff must not be retryable %', v_row;
  END IF;
  BEGIN
    PERFORM public.admin_seller_accrual_retry_item(v_item);
    RAISE EXCEPTION 'backdated retry must be refused';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%recorded after the sale%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_item_id = v_item) THEN
    RAISE EXCEPTION 'backdated retry must not write ledger';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '30303030-3030-4300-8300-303030303003';
  v_item uuid := '31313131-3131-4313-8313-313131313003';
  v_row jsonb;
BEGIN
  ALTER TABLE public.order_items DISABLE TRIGGER seller_commission_order_items_ai_trg;
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, created_at)
  VALUES (
    v_order,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '11111111-1111-4111-8111-111111111111',
    'confirmed',
    false,
    TIMESTAMPTZ '2026-03-01 00:00:00+00'
  );
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  ALTER TABLE public.order_items ENABLE TRIGGER seller_commission_order_items_ai_trg;

  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  SELECT value INTO v_row
  FROM jsonb_array_elements(public.admin_seller_unaccrued_items_list(50)->'items') e
  WHERE e.value->>'order_item_id' = v_item::text;
  IF v_row->>'reason' IS DISTINCT FROM 'no_tariff_at_sale' OR (v_row->>'retryable')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'no tariff must not be retryable %', v_row;
  END IF;
  BEGIN
    PERFORM public.admin_seller_accrual_retry_item(v_item);
    RAISE EXCEPTION 'retry without tariff must be refused';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%no tariff at sale time%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.seller_ledger WHERE order_item_id = v_item) THEN
    RAISE EXCEPTION 'refused retry must not write missing_rate';
  END IF;
END $$;

DO $$
DECLARE
  v_order uuid := '30303030-3030-4300-8300-303030303004';
  v_item uuid := '31313131-3131-4313-8313-313131313004';
BEGIN
  ALTER TABLE public.order_items DISABLE TRIGGER seller_commission_order_items_ai_trg;
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, created_at)
  VALUES (
    v_order,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'confirmed',
    false,
    now()
  );
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  ALTER TABLE public.order_items ENABLE TRIGGER seller_commission_order_items_ai_trg;
  UPDATE public.orders SET status = 'canceled', cancelled_at = now() WHERE id = v_order;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.admin_seller_unaccrued_items_list(50)->'items') e
    WHERE e.value->>'order_item_id' = v_item::text
  ) THEN
    RAISE EXCEPTION 'canceled without accrual must not be a retry candidate';
  END IF;
  BEGIN
    PERFORM public.admin_seller_accrual_retry_item(v_item);
    RAISE EXCEPTION 'canceled retry must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Canceled orders%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_order uuid := '30303030-3030-4300-8300-303030303005';
  v_sale uuid := '31313131-3131-4313-8313-313131313005';
  v_gift uuid := '31313131-3131-4313-8313-313131313015';
BEGIN
  ALTER TABLE public.order_items DISABLE TRIGGER seller_commission_order_items_ai_trg;
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES
    (v_sale, v_order, '99999999-9999-4999-8999-999999999999', 1, false),
    (v_gift, v_order, '99999999-9999-4999-8999-999999999999', 1, true);
  ALTER TABLE public.order_items ENABLE TRIGGER seller_commission_order_items_ai_trg;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.admin_seller_unaccrued_items_list(50)->'items') e
    WHERE e.value->>'order_item_id' = v_gift::text
  ) THEN
    RAISE EXCEPTION 'gift must not appear as unaccrued';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_order uuid := '30303030-3030-4300-8300-303030303006';
  v_item uuid := '31313131-3131-4313-8313-313131313006';
BEGIN
  INSERT INTO public.orders (id, seller_id, city_id, status, is_preorder, preorder_status)
  VALUES (v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'confirmed', true, 'pending');
  INSERT INTO public.order_items (id, order_id, product_id, qty, is_gift)
  VALUES (v_item, v_order, '99999999-9999-4999-8999-999999999999', 1, false);
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.admin_seller_unaccrued_items_list(50)->'items') e
    WHERE e.value->>'order_item_id' = v_item::text
  ) THEN
    RAISE EXCEPTION 'pending preorder must not be unaccrued candidate';
  END IF;
  RESET ROLE;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_unaccrued_items_list(5);
  PERFORM public.admin_seller_accrual_consistency_summary();
  BEGIN
    PERFORM public.admin_seller_accrual_retry_item('31313131-3131-4313-8313-313131313001');
    RAISE EXCEPTION 'manager must not retry';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_unaccrued_items_list(5);
    RAISE EXCEPTION 'seller must not list unaccrued';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;
