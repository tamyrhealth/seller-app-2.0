-- Local 5.17.6B tests. No COMMIT.

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.seller_goods_issues', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT seller_goods_issues';
  END IF;
  IF has_table_privilege('authenticated', 'public.seller_goods_issue_items', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT seller_goods_issue_items';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.admin_seller_goods_issue_post(uuid, uuid, uuid, jsonb, text, text, timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE admin_seller_goods_issue_post';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.admin_seller_goods_issue(uuid, uuid, uuid, jsonb, text, timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must EXECUTE admin_seller_goods_issue';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.seller_my_goods_issues()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must EXECUTE seller_my_goods_issues';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6010',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'adjustment',
    500,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL, TIMESTAMPTZ '2026-05-01 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'seed goods payable'
  );
END $$;

DO $$
DECLARE
  v_issue jsonb;
  v_again jsonb;
  v_adv jsonb;
  v_ret jsonb;
  v_ret2 jsonb;
  v_list jsonb;
  v_oil numeric;
  v_filter numeric;
  v_orders integer;
  v_exp integer;
  v_mov_out integer;
  v_mov_in integer;
  v_bal numeric;
  v_items jsonb := jsonb_build_array(
    jsonb_build_object(
      'product_id', '99999999-9999-4999-8999-999999999999',
      'qty', 2,
      'unit_credit_amount', 80
    ),
    jsonb_build_object(
      'product_id', '88888888-8888-4888-8888-888888888888',
      'qty', 1,
      'unit_credit_amount', 40
    )
  );
BEGIN
  SELECT count(*) INTO v_orders FROM public.orders;
  SELECT count(*) INTO v_exp FROM public.finance_expenses;

  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;

  v_issue := public.admin_seller_goods_issue(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    v_items,
    'multi issue',
    TIMESTAMPTZ '2026-05-10 00:00:00+05'
  );
  IF (v_issue->>'issue_number') IS DISTINCT FROM 'GI000001' THEN
    RAISE EXCEPTION 'issue number %', v_issue->>'issue_number';
  END IF;
  IF (v_issue->>'issue_kind') IS DISTINCT FROM 'settlement' THEN
    RAISE EXCEPTION 'kind settlement';
  END IF;
  IF (v_issue->>'credit_amount')::numeric IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'credit 2*80+40 expected 200 got %', v_issue->>'credit_amount';
  END IF;
  IF (v_issue->>'cost_total')::numeric IS DISTINCT FROM 105 THEN
    RAISE EXCEPTION 'cost 2*40+25 expected 105 got %', v_issue->>'cost_total';
  END IF;
  IF (v_issue->>'status') IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'status issued';
  END IF;
  IF jsonb_array_length(v_issue->'items') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'two items';
  END IF;
  RESET ROLE;

  SELECT qty_on_hand INTO v_oil FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '99999999-9999-4999-8999-999999999999';
  SELECT qty_on_hand INTO v_filter FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '88888888-8888-4888-8888-888888888888';
  IF v_oil IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'oil stock expected 18 got %', v_oil;
  END IF;
  IF v_filter IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'filter stock expected 9 got %', v_filter;
  END IF;

  SELECT count(*) INTO v_mov_out FROM public.inventory_movements WHERE type = 'seller_goods_out';
  IF v_mov_out IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'two seller_goods_out movements';
  END IF;

  SET ROLE authenticated;
  v_again := public.admin_seller_goods_issue(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    v_items,
    'multi issue',
    TIMESTAMPTZ '2026-05-10 00:00:00+05'
  );
  IF (v_again->>'id') IS DISTINCT FROM (v_issue->>'id') THEN
    RAISE EXCEPTION 'same payload must be idempotent';
  END IF;
  RESET ROLE;
  SELECT qty_on_hand INTO v_oil FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '99999999-9999-4999-8999-999999999999';
  IF v_oil IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'idempotent must not double-deduct stock';
  END IF;

  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_goods_issue(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      v_items,
      'changed comment',
      TIMESTAMPTZ '2026-05-10 00:00:00+05'
    );
    RAISE EXCEPTION 'different payload must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Idempotency key reused with a different payload%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;

  v_bal := public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF v_bal IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'balance after settlement 500-200 expected 300 got %', v_bal;
  END IF;

  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_goods_issue(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6002',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', 1,
        'unit_credit_amount', 400
      )),
      'too much',
      NULL
    );
    RAISE EXCEPTION 'settlement must not exceed positive balance';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Goods issue exceeds available balance%' THEN
        RAISE;
      END IF;
  END;

  v_adv := public.admin_seller_goods_advance(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6003',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    jsonb_build_array(jsonb_build_object(
      'product_id', '88888888-8888-4888-8888-888888888888',
      'qty', 1,
      'unit_credit_amount', 350
    )),
    'advance goods',
    TIMESTAMPTZ '2026-05-11 00:00:00+05'
  );
  IF (v_adv->>'issue_kind') IS DISTINCT FROM 'advance' THEN
    RAISE EXCEPTION 'advance kind';
  END IF;
  IF (v_adv->>'issue_number') IS DISTINCT FROM 'GI000002' THEN
    RAISE EXCEPTION 'second number %', v_adv->>'issue_number';
  END IF;
  RESET ROLE;
  v_bal := public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF v_bal IS DISTINCT FROM -50 THEN
    RAISE EXCEPTION 'advance must allow negative balance, got %', v_bal;
  END IF;

  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_goods_advance(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6004',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', 99,
        'unit_credit_amount', 1
      )),
      'no stock',
      NULL
    );
    RAISE EXCEPTION 'insufficient stock must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Insufficient stock%' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.admin_seller_goods_advance(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6005',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '77777777-7777-4777-8777-777777777777',
        'qty', 1,
        'unit_credit_amount', 10
      )),
      'no cost',
      NULL
    );
    RAISE EXCEPTION 'missing cost must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Product cost is required%' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.admin_seller_goods_return(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6099',
      (v_issue->>'id')::uuid,
      false,
      'no physical'
    );
    RAISE EXCEPTION 'return without physical receipt must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Physical receipt must be confirmed%' THEN
        RAISE;
      END IF;
  END;

  v_ret := public.admin_seller_goods_return(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6006',
    (v_issue->>'id')::uuid,
    true,
    'full return'
  );
  IF (v_ret->>'status') IS DISTINCT FROM 'return' THEN
    RAISE EXCEPTION 'return status';
  END IF;
  IF (v_ret->>'reversal_of') IS DISTINCT FROM (v_issue->>'id') THEN
    RAISE EXCEPTION 'reversal_of original';
  END IF;
  RESET ROLE;
  IF (SELECT reversed_at IS NULL FROM public.seller_goods_issues WHERE id = (v_issue->>'id')::uuid) THEN
    RAISE EXCEPTION 'original must be marked returned';
  END IF;

  SELECT qty_on_hand INTO v_oil FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '99999999-9999-4999-8999-999999999999';
  SELECT qty_on_hand INTO v_filter FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '88888888-8888-4888-8888-888888888888';
  IF v_oil IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'oil restored expected 20 got %', v_oil;
  END IF;
  IF v_filter IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'filter after advance+return original expected 9 got %', v_filter;
  END IF;

  SELECT count(*) INTO v_mov_in FROM public.inventory_movements WHERE type = 'seller_goods_in';
  IF v_mov_in IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'two seller_goods_in movements';
  END IF;

  v_bal := public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF v_bal IS DISTINCT FROM 150 THEN
    RAISE EXCEPTION 'balance after return  -50+200 expected 150 got %', v_bal;
  END IF;

  SET ROLE authenticated;
  v_ret2 := public.admin_seller_goods_return(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6006',
    (v_issue->>'id')::uuid,
    true,
    'full return'
  );
  IF (v_ret2->>'id') IS DISTINCT FROM (v_ret->>'id') THEN
    RAISE EXCEPTION 'return idempotent';
  END IF;

  BEGIN
    PERFORM public.admin_seller_goods_return(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6007',
      (v_issue->>'id')::uuid,
      true,
      'second return'
    );
    RAISE EXCEPTION 'repeat reverse must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%already returned%' THEN
        RAISE;
      END IF;
  END;

  v_list := public.admin_seller_goods_issues_list(NULL);
  IF jsonb_array_length(v_list->'items') < 3 THEN
    RAISE EXCEPTION 'staff list must include issues and return';
  END IF;
  RESET ROLE;

  IF (SELECT count(*) FROM public.orders) IS DISTINCT FROM v_orders THEN
    RAISE EXCEPTION 'must not change orders';
  END IF;
  IF (SELECT count(*) FROM public.finance_expenses) IS DISTINCT FROM v_exp THEN
    RAISE EXCEPTION 'must not write finance_expenses';
  END IF;

  RESET ROLE;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_goods_issues_list(NULL);
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.admin_seller_goods_issues_list(NULL)->'items') e
    WHERE e ? 'cost_total'
  ) THEN
    RAISE EXCEPTION 'manager list must not include cost_total';
  END IF;
  BEGIN
    PERFORM public.admin_seller_goods_issue(
      'cccccccc-cccc-4ccc-8ccc-cccccccc6001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', 1,
        'unit_credit_amount', 10
      )),
      'manager',
      NULL
    );
    RAISE EXCEPTION 'manager must not create goods issue';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM public.admin_seller_goods_return(
      'cccccccc-cccc-4ccc-8ccc-cccccccc6002',
      '12121212-1212-4112-8112-121212121212',
      true,
      'manager return'
    );
    RAISE EXCEPTION 'manager must not return goods';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_mine jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
  SET ROLE authenticated;
  v_mine := public.seller_my_goods_issues();
  IF jsonb_array_length(v_mine->'items') < 1 THEN
    RAISE EXCEPTION 'seller must see own goods issues';
  END IF;
  IF (v_mine->'items'->0 ? 'cost_total') THEN
    RAISE EXCEPTION 'seller list must not include cost_total';
  END IF;
  IF (v_mine->'items'->0->'items'->0 ? 'cost_price_snapshot') THEN
    RAISE EXCEPTION 'seller list must not include cost snapshot';
  END IF;
  BEGIN
    PERFORM public.admin_seller_goods_issues_list(NULL);
    RAISE EXCEPTION 'seller must not list all goods issues';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM public.admin_seller_goods_advance(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb6090',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', 1,
        'unit_credit_amount', 10
      )),
      'seller',
      NULL
    );
    RAISE EXCEPTION 'seller must not create goods issue';
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
  PERFORM set_config('request.jwt.claim.sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_goods_issue(
      'dddddddd-dddd-4ddd-8ddd-dddddddd6001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', 1,
        'unit_credit_amount', 10
      )),
      'inactive',
      NULL
    );
    RAISE EXCEPTION 'inactive admin must not create goods issue';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Account is inactive%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_issue jsonb;
  v_ret jsonb;
  v_bal numeric;
  v_sum numeric;
  v_oil numeric;
  v_filter numeric;
  v_rev integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_goods_advance(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6101',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', 0,
        'unit_credit_amount', 10
      )),
      'zero',
      NULL
    );
    RAISE EXCEPTION 'zero qty must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Invalid qty%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM public.admin_seller_goods_advance(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6102',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', -1,
        'unit_credit_amount', 10
      )),
      'neg',
      NULL
    );
    RAISE EXCEPTION 'negative qty must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Invalid qty%' THEN
        RAISE;
      END IF;
  END;

  v_issue := public.admin_seller_goods_advance(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6103',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '11111111-1111-4111-8111-111111111111',
    jsonb_build_array(
      jsonb_build_object(
        'product_id', '88888888-8888-4888-8888-888888888888',
        'qty', 1,
        'unit_credit_amount', 15
      ),
      jsonb_build_object(
        'product_id', '99999999-9999-4999-8999-999999999999',
        'qty', 1,
        'unit_credit_amount', 20
      )
    ),
    'reverse order',
    NULL
  );
  IF (v_issue->>'credit_amount')::numeric IS DISTINCT FROM 35 THEN
    RAISE EXCEPTION 'reverse order credit %', v_issue->>'credit_amount';
  END IF;
  IF (v_issue->>'city_id') IS DISTINCT FROM '11111111-1111-4111-8111-111111111111' THEN
    RAISE EXCEPTION 'issue city must be selected warehouse';
  END IF;

  v_ret := public.admin_seller_goods_return(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6104',
    (v_issue->>'id')::uuid,
    true,
    'return advance'
  );
  IF (v_ret->>'city_id') IS DISTINCT FROM (v_issue->>'city_id') THEN
    RAISE EXCEPTION 'return must restore original city';
  END IF;
  RESET ROLE;

  SELECT count(*) INTO v_rev
  FROM public.seller_goods_issues
  WHERE reversal_of = (v_issue->>'id')::uuid;
  IF v_rev IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'reversal_of must be unique, got %', v_rev;
  END IF;

  SELECT qty_on_hand INTO v_oil FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '99999999-9999-4999-8999-999999999999';
  SELECT qty_on_hand INTO v_filter FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '88888888-8888-4888-8888-888888888888';
  IF v_oil < 0 OR v_filter < 0 THEN
    RAISE EXCEPTION 'stock must not go negative';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_sum
  FROM public.seller_ledger
  WHERE seller_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_bal := public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF v_bal IS DISTINCT FROM v_sum THEN
    RAISE EXCEPTION 'balance must equal SUM(ledger.amount) % vs %', v_bal, v_sum;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('confirm_order', 'cancel_order', 'fulfill_preorder')
      AND pg_get_functiondef(p.oid) LIKE '%admin_seller_goods_issue%'
  ) THEN
    RAISE EXCEPTION 'order RPCs must not call goods issue';
  END IF;
END $$;
