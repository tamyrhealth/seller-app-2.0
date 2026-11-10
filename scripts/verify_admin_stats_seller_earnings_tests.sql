-- Local asserts for 5.18. Must run inside a transaction that rolls back.

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.admin_stats_seller_earnings(date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not EXECUTE admin_stats_seller_earnings';
  END IF;
  IF has_function_privilege('service_role', 'public.admin_stats_seller_earnings(date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must not EXECUTE admin_stats_seller_earnings';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.admin_stats_seller_earnings(date, date)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must EXECUTE admin_stats_seller_earnings';
  END IF;
END $$;

DO $$
DECLARE
  v jsonb;
  v_empty jsonb;
  v_txt text;
  v_acc uuid;
BEGIN
  INSERT INTO public.order_items (id, order_id, product_id) VALUES
    ('15151515-1515-4151-8151-151515151515', '12121212-1212-4112-8112-121212121212', '99999999-9999-4999-8999-999999999999'),
    ('16161616-1616-4161-8161-161616161616', '12121212-1212-4112-8112-121212121212', '99999999-9999-4999-8999-999999999999')
  ON CONFLICT (id) DO NOTHING;

  v_acc := (public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa8101'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'accrual', 100, '12121212-1212-4112-8112-121212121212'::uuid,
    '13131313-1313-4131-8131-131313131313'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, 100, NULL, false, NULL, NULL,
    TIMESTAMPTZ '2026-11-01 00:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'nov accrual'
  )).id;

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa8102'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'accrual', 40, '12121212-1212-4112-8112-121212121212'::uuid,
    '14141414-1414-4141-8141-141414141414'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, 40, NULL, false, NULL, NULL,
    TIMESTAMPTZ '2026-11-01 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'nov second line'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa8103'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'reversal', -25, '12121212-1212-4112-8112-121212121212'::uuid,
    '13131313-1313-4131-8131-131313131313'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, 100, NULL, false, v_acc, NULL,
    TIMESTAMPTZ '2026-11-01 18:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'nov reversal'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa8104'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'accrual', 0, '12121212-1212-4112-8112-121212121212'::uuid,
    '15151515-1515-4151-8151-151515151515'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, NULL, NULL, true, NULL, NULL,
    TIMESTAMPTZ '2026-11-01 20:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'missing_rate count'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa8105'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'cash_payout', -50, NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL,
    TIMESTAMPTZ '2026-11-01 21:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'cash not earned'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa8106'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'accrual', 7, '12121212-1212-4112-8112-121212121212'::uuid,
    '16161616-1616-4161-8161-161616161616'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, 7, NULL, false, NULL, NULL,
    TIMESTAMPTZ '2026-11-02 00:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'next day excluded'
  );

  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;

  v_empty := public.admin_stats_seller_earnings(DATE '2026-12-01', DATE '2026-12-31');
  IF v_empty -> 'sellers' IS NULL OR jsonb_array_length(v_empty -> 'sellers') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'empty period must be zeros %', v_empty;
  END IF;

  v := public.admin_stats_seller_earnings(DATE '2026-11-01', DATE '2026-11-01');
  v_txt := v::text;
  IF v_txt ILIKE '%cost_price%' THEN
    RAISE EXCEPTION 'json must not leak cost_price_snapshot';
  END IF;
  IF (v #>> '{sellers,0,earned}')::numeric IS DISTINCT FROM 115 THEN
    RAISE EXCEPTION 'earned accrued-reversal excluding missing_rate and goods %', v #>> '{sellers,0,earned}';
  END IF;
  IF (v #>> '{sellers,0,missing_rate_count}')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'missing_rate count %', v #>> '{sellers,0,missing_rate_count}';
  END IF;
  IF jsonb_array_length(v -> 'sellers' -> 0 -> 'items') < 2 THEN
    RAISE EXCEPTION 'same product two order items must stay separate %', v -> 'sellers' -> 0 -> 'items';
  END IF;

  BEGIN
    PERFORM public.admin_stats_seller_earnings(DATE '2026-11-02', DATE '2026-11-01');
    RAISE EXCEPTION 'invalid period must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Stats period is invalid%' THEN
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
    PERFORM public.admin_stats_seller_earnings(DATE '2026-11-01', DATE '2026-11-01');
    RAISE EXCEPTION 'manager must not read stats earnings';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_stats_seller_earnings(DATE '2026-11-01', DATE '2026-11-01');
    RAISE EXCEPTION 'seller must not read stats earnings';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Seller commission permission denied%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;
