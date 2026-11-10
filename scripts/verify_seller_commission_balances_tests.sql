-- Local 5.17.5B tests. No COMMIT.

DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'admin_seller_cash_payout';
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'cash_payout must have exactly one overload, got %', v_n;
  END IF;
  SELECT p.pronargs INTO v_n FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'admin_seller_cash_payout';
  IF v_n IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'cash_payout must be 5-arg with default date, got %', v_n;
  END IF;
END $$;

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.seller_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT seller_ledger';
  END IF;
  IF has_function_privilege('authenticated', 'public.admin_seller_cash_post(uuid, uuid, numeric, text, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE admin_seller_cash_post';
  END IF;
  IF has_function_privilege('authenticated', 'public.seller_ledger_breakdown(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE seller_ledger_breakdown';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_seller_balances_list()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must EXECUTE admin_seller_balances_list';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_seller_cash_payout(uuid, uuid, numeric, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must EXECUTE 5-arg cash_payout';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa5010',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'adjustment',
    400,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL, TIMESTAMPTZ '2026-03-01 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'seed payable'
  );
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa5011',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'accrual',
    200,
    '12121212-1212-4112-8112-121212121212',
    '13131313-1313-4131-8131-131313131313',
    '99999999-9999-4999-8999-999999999999',
    1, 200, NULL, false, NULL, NULL,
    TIMESTAMPTZ '2026-03-02 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    NULL
  );
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa5012',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'reversal',
    -50,
    '12121212-1212-4112-8112-121212121212',
    '13131313-1313-4131-8131-131313131313',
    '99999999-9999-4999-8999-999999999999',
    1, 50, NULL, false,
    (SELECT id FROM public.seller_ledger WHERE operation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa5011'),
    NULL,
    TIMESTAMPTZ '2026-03-03 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    NULL
  );
END $$;

DO $$
DECLARE
  v_bal jsonb;
  v_pay jsonb;
  v_pay2 jsonb;
  v_adv jsonb;
  v_list jsonb;
  v_row jsonb;
  v_created timestamptz;
  v_plan uuid;
  v_op timestamptz := TIMESTAMPTZ '2026-04-01 00:00:00+05';
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'A';
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_tariff_rate_set(
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    80,
    TIMESTAMPTZ '2026-01-01 00:00:00+00'
  );
  PERFORM public.admin_seller_tariff_assign(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    v_plan,
    TIMESTAMPTZ '2026-01-01 00:00:00+00'
  );
  v_bal := public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF (v_bal->>'balance') IS NULL THEN
    RAISE EXCEPTION 'balance key must remain';
  END IF;
  IF (v_bal->>'accrued')::numeric IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'accrued mismatch %', v_bal;
  END IF;
  IF (v_bal->>'reversed')::numeric IS DISTINCT FROM -50 THEN
    RAISE EXCEPTION 'reversed mismatch %', v_bal;
  END IF;
  IF (v_bal->>'paid')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'paid should start 0';
  END IF;
  IF (v_bal->>'balance')::numeric IS DISTINCT FROM 550 THEN
    RAISE EXCEPTION 'opening balance mismatch %', v_bal;
  END IF;

  v_list := public.admin_seller_balances_list();
  IF jsonb_array_length(v_list->'items') < 3 THEN
    RAISE EXCEPTION 'list must include all sellers including zero/inactive';
  END IF;
  SELECT value INTO v_row
  FROM jsonb_array_elements(v_list->'items') value
  WHERE value->>'seller_id' = 'abababab-abab-4aba-8aba-abababababab';
  IF v_row IS NULL OR (v_row->>'is_active')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'inactive seller must be listed';
  END IF;
  IF (v_row->>'balance')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'inactive seller zero balance';
  END IF;

  v_pay := public.admin_seller_cash_payout(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    100,
    'payout april',
    v_op
  );
  IF (v_pay->>'entry_type') IS DISTINCT FROM 'cash_payout' THEN
    RAISE EXCEPTION 'payout type';
  END IF;
  IF (v_pay->>'amount')::numeric IS DISTINCT FROM -100 THEN
    RAISE EXCEPTION 'payout stores negative amount';
  END IF;
  IF (v_pay->>'accrued_at')::timestamptz IS DISTINCT FROM v_op THEN
    RAISE EXCEPTION 'operation date must be accrued_at %', v_pay;
  END IF;
  v_created := (v_pay->>'created_at')::timestamptz;
  IF v_created IS NULL OR v_created < v_op THEN
    RAISE EXCEPTION 'created_at must be registration time';
  END IF;

  v_pay2 := public.admin_seller_cash_payout(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    100,
    'payout april',
    v_op
  );
  IF v_pay2->>'id' IS DISTINCT FROM v_pay->>'id' THEN
    RAISE EXCEPTION 'same payload must be idempotent';
  END IF;

  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      100,
      'payout april',
      TIMESTAMPTZ '2026-04-02 00:00:00+05'
    );
    RAISE EXCEPTION 'different date must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Idempotency key reused with a different payload%' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5002',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      100,
      'future',
      clock_timestamp() + interval '2 days'
    );
    RAISE EXCEPTION 'future date must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Operation date cannot be in the future%' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5003',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      0,
      'zero',
      v_op
    );
    RAISE EXCEPTION 'zero payout must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Amount must be greater than 0%' THEN
        RAISE;
      END IF;
  END;

  v_bal := public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF (v_bal->>'paid')::numeric IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'paid after payout %', v_bal;
  END IF;
  IF (v_bal->>'balance')::numeric IS DISTINCT FROM 450 THEN
    RAISE EXCEPTION 'balance after payout %', v_bal;
  END IF;

  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5004',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      451,
      'too much',
      v_op
    );
    RAISE EXCEPTION 'payout over balance must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Payout exceeds available balance%' THEN
        RAISE;
      END IF;
  END;

  v_adv := public.admin_seller_cash_advance(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5005',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    500,
    'advance',
    v_op
  );
  IF v_adv->>'entry_type' IS DISTINCT FROM 'cash_advance' THEN
    RAISE EXCEPTION 'advance type';
  END IF;
  v_bal := public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF (v_bal->>'advances')::numeric IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'advances %', v_bal;
  END IF;
  IF (v_bal->>'balance')::numeric IS DISTINCT FROM -50 THEN
    RAISE EXCEPTION 'advance must allow negative balance %', v_bal;
  END IF;

  -- 4-arg compatibility (null date = now)
  PERFORM public.admin_seller_cash_advance(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5006',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    10,
    'compat'
  );

  v_bal := public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF (
    (v_bal->>'accrued')::numeric
    + (v_bal->>'reversed')::numeric
    - (v_bal->>'paid')::numeric
    - (v_bal->>'advances')::numeric
    + (v_bal->>'goods')::numeric
    + (v_bal->>'adjustments')::numeric
  ) IS DISTINCT FROM (v_bal->>'balance')::numeric THEN
    RAISE EXCEPTION 'breakdown must equal balance %', v_bal;
  END IF;
  RESET ROLE;
  IF (v_bal->>'balance')::numeric IS DISTINCT FROM public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') THEN
    RAISE EXCEPTION 'json balance must equal SUM(amount)';
  END IF;
END $$;

DO $$
DECLARE
  v_acc public.seller_ledger%ROWTYPE;
  v_bal numeric;
BEGIN
  v_acc := public.seller_ledger_post_accrual_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa5020',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '12121212-1212-4112-8112-121212121212',
    '14141414-1414-4141-8141-141414141414',
    '99999999-9999-4999-8999-999999999999',
    1,
    TIMESTAMPTZ '2026-04-10 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  v_bal := public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  IF v_bal <= -50 THEN
    RAISE EXCEPTION 'later accrual must reduce negative balance, got % amount %', v_bal, v_acc.amount;
  END IF;
END $$;

DO $$
DECLARE
  v_json jsonb;
  v_hist jsonb;
  v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v_json := public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  v_hist := public.admin_seller_ledger_list(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    TIMESTAMPTZ '2026-01-01 00:00:00+00',
    TIMESTAMPTZ '2026-01-02 00:00:00+00'
  );
  v_n := jsonb_array_length(v_hist->'items');
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'narrow history must not be used as balance, got % items', v_n;
  END IF;
  RESET ROLE;
  IF (v_json->>'balance')::numeric IS DISTINCT FROM public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') THEN
    RAISE EXCEPTION 'history filter must not change all-time balance';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  IF (v_json->>'balance')::numeric >= 1 THEN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5007',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1,
      'four-arg'
    );
  END IF;
  RESET ROLE;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_balances_list();
  PERFORM public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  PERFORM public.admin_seller_ledger_list(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    TIMESTAMPTZ '2026-01-01 00:00:00+00',
    TIMESTAMPTZ '2026-12-31 00:00:00+00'
  );
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'cccccccc-cccc-4ccc-8ccc-cccccccc5001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1,
      'mgr',
      TIMESTAMPTZ '2026-04-01 00:00:00+05'
    );
    RAISE EXCEPTION 'manager must not create payout';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM public.admin_seller_cash_advance(
      'cccccccc-cccc-4ccc-8ccc-cccccccc5002',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1,
      'mgr',
      TIMESTAMPTZ '2026-04-01 00:00:00+05'
    );
    RAISE EXCEPTION 'manager must not create advance';
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
  IF (public.seller_my_balance()->>'seller_id') IS DISTINCT FROM 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' THEN
    RAISE EXCEPTION 'seller my_balance must be self';
  END IF;
  IF (public.seller_my_balance()->>'paid') IS NULL THEN
    RAISE EXCEPTION 'seller my_balance must include paid';
  END IF;
  PERFORM public.seller_my_ledger(TIMESTAMPTZ '2026-01-01 00:00:00+00', TIMESTAMPTZ '2026-12-31 00:00:00+00');
  BEGIN
    PERFORM public.admin_seller_balances_list();
    RAISE EXCEPTION 'seller must not list all balances';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM public.admin_seller_balance('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    RAISE EXCEPTION 'seller must not read others';
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
    PERFORM public.admin_seller_cash_payout(
      'dddddddd-dddd-4ddd-8ddd-dddddddd5001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1,
      'inactive',
      TIMESTAMPTZ '2026-04-01 00:00:00+05'
    );
    RAISE EXCEPTION 'inactive admin must not create payout';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Account is inactive%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;

DO $$
BEGIN
  IF to_regclass('public.finance_expenses') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.finance_expenses) THEN
      RAISE EXCEPTION 'must not write finance_expenses';
    END IF;
  END IF;
END $$;
