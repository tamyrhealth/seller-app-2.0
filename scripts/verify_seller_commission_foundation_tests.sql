-- Local asserts for 5.17.3A. Must run inside a transaction that rolls back.

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.seller_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT seller_ledger';
  END IF;
  IF has_table_privilege('authenticated', 'public.seller_ledger', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT seller_ledger';
  END IF;
  IF has_table_privilege('anon', 'public.seller_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not SELECT seller_ledger';
  END IF;
  IF has_function_privilege('authenticated', 'public.seller_commission_require_active_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE seller_commission_require_active_admin';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.seller_ledger_post_internal(uuid, uuid, text, numeric, uuid, uuid, uuid, numeric, numeric, uuid, boolean, uuid, uuid, timestamptz, uuid, text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE seller_ledger_post_internal';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.seller_ledger_post_accrual_internal(uuid, uuid, uuid, uuid, uuid, numeric, timestamptz, uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE seller_ledger_post_accrual_internal';
  END IF;
  IF has_function_privilege('authenticated', 'public.admin_seller_cash_post(uuid, uuid, numeric, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE admin_seller_cash_post';
  END IF;
  IF has_table_privilege('service_role', 'public.seller_ledger', 'INSERT') THEN
    RAISE EXCEPTION 'service_role must not INSERT seller_ledger';
  END IF;
  IF has_table_privilege('service_role', 'public.seller_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'service_role must not SELECT seller_ledger';
  END IF;
  IF has_function_privilege('service_role', 'public.admin_seller_cash_payout(uuid, uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must not EXECUTE payout RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_seller_cash_payout(uuid, uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must EXECUTE payout RPC';
  END IF;
END $$;

DO $$
DECLARE
  v_plan uuid;
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'A';
  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'plan A must be seeded';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_tariff_rate_set(
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    150,
    TIMESTAMPTZ '2026-01-01 00:00:00+00'
  );
  BEGIN
    PERFORM public.admin_seller_tariff_rate_set(
      v_plan,
      '99999999-9999-4999-8999-999999999999',
      NULL,
      TIMESTAMPTZ '2026-02-01 00:00:00+00'
    );
    RAISE EXCEPTION 'NULL rate must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Tariff rate cannot be NULL%' THEN
        RAISE;
      END IF;
  END;
  PERFORM public.admin_seller_tariff_rate_set(
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    0,
    TIMESTAMPTZ '2026-02-01 00:00:00+00'
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
  v_plan uuid;
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'A';
  BEGIN
    INSERT INTO public.seller_tariff_rates (plan_id, product_id, amount_kzt, effective_from, effective_to)
    VALUES (
      v_plan,
      '99999999-9999-4999-8999-999999999999',
      10,
      TIMESTAMPTZ '2026-01-15 00:00:00+00',
      TIMESTAMPTZ '2026-01-20 00:00:00+00'
    );
    RAISE EXCEPTION 'overlapping rate must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%periods overlap%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    INSERT INTO public.seller_tariff_assignments (seller_id, plan_id, effective_from, effective_to)
    VALUES (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      v_plan,
      TIMESTAMPTZ '2026-01-10 00:00:00+00',
      TIMESTAMPTZ '2026-01-20 00:00:00+00'
    );
    RAISE EXCEPTION 'overlapping assignment must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%periods overlap%' THEN
        RAISE;
      END IF;
  END;
END $$;

DO $$
DECLARE
  v_plan uuid;
  v_first uuid;
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'B';
  INSERT INTO public.seller_tariff_rates (plan_id, product_id, amount_kzt, effective_from, effective_to)
  VALUES (
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    10,
    TIMESTAMPTZ '2026-01-01 00:00:00+00',
    TIMESTAMPTZ '2026-02-01 00:00:00+00'
  )
  RETURNING id INTO v_first;
  INSERT INTO public.seller_tariff_rates (plan_id, product_id, amount_kzt, effective_from, effective_to)
  VALUES (
    v_plan,
    '99999999-9999-4999-8999-999999999999',
    20,
    TIMESTAMPTZ '2026-02-01 00:00:00+00',
    TIMESTAMPTZ '2026-03-01 00:00:00+00'
  );
  BEGIN
    INSERT INTO public.seller_tariff_rates (plan_id, product_id, amount_kzt, effective_from, effective_to)
    VALUES (
      v_plan,
      '99999999-9999-4999-8999-999999999999',
      15,
      TIMESTAMPTZ '2026-01-15 00:00:00+00',
      TIMESTAMPTZ '2026-01-20 00:00:00+00'
    );
    RAISE EXCEPTION 'closed interval overlap must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%periods overlap%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    UPDATE public.seller_tariff_rates SET effective_to = TIMESTAMPTZ '2026-04-01 00:00:00+00' WHERE id = v_first;
    RAISE EXCEPTION 'closed rate period must be immutable';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%period is closed%' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO public.seller_tariff_assignments (seller_id, plan_id, effective_from, effective_to)
  VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    v_plan,
    TIMESTAMPTZ '2026-01-01 00:00:00+00',
    TIMESTAMPTZ '2026-02-01 00:00:00+00'
  );
  INSERT INTO public.seller_tariff_assignments (seller_id, plan_id, effective_from, effective_to)
  VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    v_plan,
    TIMESTAMPTZ '2026-02-01 00:00:00+00',
    TIMESTAMPTZ '2026-03-01 00:00:00+00'
  );
  BEGIN
    INSERT INTO public.seller_tariff_assignments (seller_id, plan_id, effective_from, effective_to)
    VALUES (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      v_plan,
      TIMESTAMPTZ '2026-01-10 00:00:00+00',
      TIMESTAMPTZ '2026-01-20 00:00:00+00'
    );
    RAISE EXCEPTION 'closed assignment overlap must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%periods overlap%' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO public.seller_rate_overrides (seller_id, product_id, amount_kzt, effective_from, effective_to)
  VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '99999999-9999-4999-8999-999999999999',
    5,
    TIMESTAMPTZ '2026-01-01 00:00:00+00',
    TIMESTAMPTZ '2026-02-01 00:00:00+00'
  );
  INSERT INTO public.seller_rate_overrides (seller_id, product_id, amount_kzt, effective_from, effective_to)
  VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '99999999-9999-4999-8999-999999999999',
    7,
    TIMESTAMPTZ '2026-02-01 00:00:00+00',
    TIMESTAMPTZ '2026-03-01 00:00:00+00'
  );
  BEGIN
    INSERT INTO public.seller_rate_overrides (seller_id, product_id, amount_kzt, effective_from, effective_to)
    VALUES (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '99999999-9999-4999-8999-999999999999',
      6,
      TIMESTAMPTZ '2026-01-10 00:00:00+00',
      TIMESTAMPTZ '2026-02-01 00:00:00+00'
    );
    RAISE EXCEPTION 'closed override overlap must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%periods overlap%' THEN
        RAISE;
      END IF;
  END;
END $$;

DO $$
DECLARE
  v_acc public.seller_ledger%ROWTYPE;
  v_zero public.seller_ledger%ROWTYPE;
  v_plan uuid;
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'A';
  v_acc := public.seller_ledger_post_accrual_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '12121212-1212-4112-8112-121212121212',
    '13131313-1313-4131-8131-131313131313',
    '99999999-9999-4999-8999-999999999999',
    2,
    TIMESTAMPTZ '2026-01-10 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  IF v_acc.amount IS DISTINCT FROM 300 OR v_acc.missing_rate OR v_acc.unit_rate_snapshot IS DISTINCT FROM 150 THEN
    RAISE EXCEPTION 'accrual snapshot mismatch';
  END IF;
  BEGIN
    PERFORM public.seller_ledger_post_accrual_internal(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '12121212-1212-4112-8112-121212121212',
      '13131313-1313-4131-8131-131313131313',
      '99999999-9999-4999-8999-999999999999',
      2,
      TIMESTAMPTZ '2026-01-10 00:00:00+00',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'double accrual must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%already exists for order item%' THEN
        RAISE;
      END IF;
  END;
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'reversal',
    -300,
    '12121212-1212-4112-8112-121212121212',
    '13131313-1313-4131-8131-131313131313',
    '99999999-9999-4999-8999-999999999999',
    2,
    150,
    v_plan,
    false,
    v_acc.id,
    NULL,
    TIMESTAMPTZ '2026-01-11 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cancel'
  );
  BEGIN
    PERFORM public.seller_ledger_post_accrual_internal(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0004',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '12121212-1212-4112-8112-121212121212',
      '13131313-1313-4131-8131-131313131313',
      '99999999-9999-4999-8999-999999999999',
      2,
      TIMESTAMPTZ '2026-01-12 00:00:00+00',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 're-accrual after reversal must be rejected';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%already exists for order item%' THEN
        RAISE;
      END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.seller_ledger
    WHERE id = v_acc.id AND entry_type = 'accrual' AND amount = 300
  ) THEN
    RAISE EXCEPTION 'original accrual must remain after reversal';
  END IF;
  IF public.seller_ledger_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'reversal must return running balance to 0';
  END IF;
  BEGIN
    PERFORM public.seller_ledger_post_internal(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'accrual',
      300,
      '12121212-1212-4112-8112-121212121212',
      '13131313-1313-4131-8131-131313131313',
      '99999999-9999-4999-8999-999999999999',
      2,
      150,
      v_plan,
      false,
      NULL,
      NULL,
      TIMESTAMPTZ '2026-01-10 00:00:00+00',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'tampered'
    );
    RAISE EXCEPTION 'same operation_id different comment must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Idempotency key reused with a different payload%' THEN
        RAISE;
      END IF;
  END;
  v_zero := public.seller_ledger_post_accrual_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0005',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '12121212-1212-4112-8112-121212121212',
    '14141414-1414-4141-8141-141414141414',
    '99999999-9999-4999-8999-999999999999',
    1,
    TIMESTAMPTZ '2026-03-01 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  IF v_zero.missing_rate OR v_zero.amount IS DISTINCT FROM 0 OR v_zero.unit_rate_snapshot IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'known zero rate must not be missing_rate';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    PERFORM public.seller_ledger_post_accrual_internal(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0006',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '12121212-1212-4112-8112-121212121212',
      '14141414-1414-4141-8141-141414141414',
      '99999999-9999-4999-8999-999999999999',
      1,
      TIMESTAMPTZ '2026-03-01 00:00:00+00',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'second seller cannot reuse same order_item unique';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM LIKE '%second seller cannot reuse%' THEN
        RAISE EXCEPTION 'accrual unique must be global per order_item';
      END IF;
      IF SQLERRM NOT LIKE '%already exists for order item%' THEN
        RAISE;
      END IF;
  END;
END $$;

DO $$
DECLARE
  v_item uuid := '15151515-1515-4151-8151-151515151515';
  v_row public.seller_ledger%ROWTYPE;
BEGIN
  INSERT INTO public.order_items (id, order_id, product_id) VALUES
    (v_item, '12121212-1212-4112-8112-121212121212', '99999999-9999-4999-8999-999999999999');
  v_row := public.seller_ledger_post_accrual_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0007',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '12121212-1212-4112-8112-121212121212',
    v_item,
    '99999999-9999-4999-8999-999999999999',
    3,
    TIMESTAMPTZ '2026-03-01 00:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  IF NOT v_row.missing_rate OR v_row.amount IS DISTINCT FROM 0 OR v_row.unit_rate_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'missing_rate must store unknown zero, not a known 0 snapshot';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.seller_ledger_post_internal(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'adjustment',
      400,
      NULL, NULL, NULL, NULL, NULL, NULL,
      false, NULL, NULL, now(),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'seed payable'
    );
    RAISE EXCEPTION 'authenticated must not call seller_ledger_post_internal';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN others THEN
      IF SQLERRM LIKE '%authenticated must not call%' THEN
        RAISE;
      END IF;
      RAISE;
  END;
  RESET ROLE;
END $$;

DO $$
BEGIN
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0010',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'adjustment',
    400,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL, now(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'seed payable'
  );
END $$;

DO $$
DECLARE
  v_pay jsonb;
  v_pay2 jsonb;
  v_adv jsonb;
  v_bal numeric;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v_pay := public.admin_seller_cash_payout(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    100,
    'payout'
  );
  IF (v_pay->>'amount')::numeric IS DISTINCT FROM -100 THEN
    RAISE EXCEPTION 'payout must store negative amount';
  END IF;
  IF v_pay->>'actor_id' IS DISTINCT FROM 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'payout actor_id must be auth.uid';
  END IF;
  v_pay2 := public.admin_seller_cash_payout(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    100,
    'payout'
  );
  IF v_pay2->>'id' IS DISTINCT FROM v_pay->>'id' THEN
    RAISE EXCEPTION 'double payout with same operation_id must be idempotent';
  END IF;
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      80,
      'payout'
    );
    RAISE EXCEPTION 'payload mismatch must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Idempotency key reused with a different payload%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      100,
      'payout'
    );
    RAISE EXCEPTION 'same operation_id different actor must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Idempotency key reused with a different payload%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      0,
      'zero'
    );
    RAISE EXCEPTION 'zero payout must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Amount must be greater than 0%' THEN
        RAISE;
      END IF;
  END;
  v_bal := (public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->>'balance')::numeric;
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0003',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      v_bal + 1,
      'too much'
    );
    RAISE EXCEPTION 'payout over balance must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Payout exceeds available balance%' THEN
        RAISE;
      END IF;
  END;
  v_adv := public.admin_seller_cash_advance(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0004',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    v_bal + 50,
    'advance'
  );
  IF v_adv->>'entry_type' IS DISTINCT FROM 'cash_advance' THEN
    RAISE EXCEPTION 'advance type mismatch';
  END IF;
  v_bal := (public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->>'balance')::numeric;
  IF v_bal >= 0 THEN
    RAISE EXCEPTION 'explicit advance must allow negative balance';
  END IF;
  -- sequential "concurrent" payouts: lock is per-xact; second sees updated balance
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_plan uuid;
BEGIN
  SELECT id INTO v_plan FROM public.seller_tariff_plans WHERE code = 'B';
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
  SET ROLE authenticated;
  PERFORM public.admin_seller_tariff_plans_list();
  PERFORM public.admin_seller_balance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  BEGIN
    PERFORM public.admin_seller_tariff_rate_set(
      v_plan,
      '99999999-9999-4999-8999-999999999999',
      10,
      now()
    );
    RAISE EXCEPTION 'manager must not set rates';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'cccccccc-cccc-4ccc-8ccc-cccccccc0001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1,
      'mgr'
    );
    RAISE EXCEPTION 'manager must not create payout';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM * FROM public.seller_ledger;
    RAISE EXCEPTION 'manager direct SELECT must fail';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
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
  PERFORM public.seller_my_ledger(TIMESTAMPTZ '2026-01-01 00:00:00+00', TIMESTAMPTZ '2026-12-31 00:00:00+00');
  BEGIN
    PERFORM public.admin_seller_balance('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    RAISE EXCEPTION 'seller must not read others via admin RPC';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0099',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1,
      'self'
    );
    RAISE EXCEPTION 'seller must not create payout';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  BEGIN
    PERFORM * FROM public.seller_ledger;
    RAISE EXCEPTION 'seller direct SELECT must fail';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
  RESET ROLE;
END $$;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_seller_cash_payout(
      'dddddddd-dddd-4ddd-8ddd-dddddddd0001',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      1,
      'inactive'
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
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  BEGIN
    INSERT INTO public.seller_ledger (
      seller_id, operation_id, entry_type, amount
    ) VALUES (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0099',
      'adjustment',
      1
    );
    RAISE EXCEPTION 'authenticated must not insert seller_ledger';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
  RESET ROLE;
END $$;

DO $$
BEGIN
  UPDATE public.seller_ledger SET comment = 'mut' WHERE entry_type = 'accrual';
  RAISE EXCEPTION 'ledger must be append-only';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN
      RAISE;
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
