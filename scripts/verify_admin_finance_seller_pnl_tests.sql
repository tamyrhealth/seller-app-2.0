-- Local asserts for 5.17.7B. Must run inside a transaction that rolls back.

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.seller_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT seller_ledger';
  END IF;
  IF has_table_privilege('authenticated', 'public.seller_goods_issue_items', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT seller_goods_issue_items';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.admin_finance_seller_pnl(date, date)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must EXECUTE admin_finance_seller_pnl';
  END IF;
  IF has_function_privilege('anon', 'public.admin_finance_seller_pnl(date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not EXECUTE admin_finance_seller_pnl';
  END IF;
  IF has_function_privilege('service_role', 'public.admin_finance_seller_pnl(date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must not EXECUTE admin_finance_seller_pnl';
  END IF;
END $$;

DO $$
DECLARE
  v_acc uuid;
  v_rev uuid;
  v_issue uuid := '61616161-6161-4161-8161-616161616161';
  v_ret uuid := '62626262-6262-4262-8262-626262626262';
  v_adv uuid := '63636363-6363-4363-8363-636363636363';
  v_zero uuid := '64646464-6464-4464-8464-646464646464';
  v_unk uuid := '65656565-6565-4565-8565-656565656565';
  v_orders integer;
  v_exp integer;
BEGIN
  SELECT count(*) INTO v_orders FROM public.orders;
  SELECT count(*) INTO v_exp FROM public.finance_expenses;

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7101'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'accrual', 1000, '21212121-2121-4121-8121-212121212121'::uuid,
    '23232323-2323-4232-8232-232323232323'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    2, 500, NULL, false, NULL, NULL,
    TIMESTAMPTZ '2026-01-10 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'jan accrual'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7102'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'cash_payout', -400, NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL,
    TIMESTAMPTZ '2026-01-12 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'jan payout'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7103'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'cash_advance', -200, NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL,
    TIMESTAMPTZ '2026-01-13 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'jan advance cash'
  );

  INSERT INTO public.seller_goods_issues (
    id, operation_id, seller_id, city_id, credit_amount, actor_id, issue_kind, created_at
  ) VALUES (
    v_issue, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7110'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    300, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'settlement',
    TIMESTAMPTZ '2026-01-20 12:00:00+05'
  );
  INSERT INTO public.seller_goods_issue_items (
    issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
  ) VALUES (
    v_issue, '99999999-9999-4999-8999-999999999999'::uuid, 2, 150, 300, 40
  );
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7111'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'goods_issue', -300, NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, v_issue,
    TIMESTAMPTZ '2026-01-20 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'jan goods'
  );

  INSERT INTO public.seller_goods_issues (
    id, operation_id, seller_id, city_id, credit_amount, actor_id, issue_kind, created_at
  ) VALUES (
    v_adv, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7112'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    80, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'advance',
    TIMESTAMPTZ '2026-01-22 12:00:00+05'
  );
  INSERT INTO public.seller_goods_issue_items (
    issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
  ) VALUES (
    v_adv, '88888888-8888-4888-8888-888888888888'::uuid, 1, 80, 80, 25
  );
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7113'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    'goods_issue', -80, NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, v_adv,
    TIMESTAMPTZ '2026-01-22 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'jan goods advance'
  );

  INSERT INTO public.seller_goods_issues (
    id, operation_id, seller_id, city_id, credit_amount, actor_id, issue_kind, reversal_of, created_at
  ) VALUES (
    v_ret, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7114'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    300, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'settlement', v_issue,
    TIMESTAMPTZ '2026-02-05 12:00:00+05'
  );
  INSERT INTO public.seller_goods_issue_items (
    issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
  ) VALUES (
    v_ret, '99999999-9999-4999-8999-999999999999'::uuid, 2, 150, 300, 40
  );
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7115'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'goods_reversal', 300, NULL, NULL, NULL, NULL, NULL, NULL,
    false,
    (SELECT id FROM public.seller_ledger WHERE operation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7111'),
    v_ret,
    TIMESTAMPTZ '2026-02-05 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'feb return'
  );

  SELECT id INTO v_acc
  FROM public.seller_ledger
  WHERE operation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7101';
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7104'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'reversal', -1000, '21212121-2121-4121-8121-212121212121'::uuid,
    '23232323-2323-4232-8232-232323232323'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    2, 500, NULL, false, v_acc, NULL,
    TIMESTAMPTZ '2026-03-01 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'mar reverse'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7105'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    'accrual', 0, '31313131-3131-4131-8131-313131313131'::uuid,
    '25252525-2525-4252-8252-252525252525'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, NULL, NULL, true, NULL, NULL,
    TIMESTAMPTZ '2026-01-15 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'missing rate'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7106'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    'adjustment', 50, NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL,
    TIMESTAMPTZ '2026-01-16 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'plus adj'
  );
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7107'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    'adjustment', -20, NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL,
    TIMESTAMPTZ '2026-01-17 12:00:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'minus adj'
  );

  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7108'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'accrual', 80, '12121212-1212-4112-8112-121212121212'::uuid,
    '13131313-1313-4131-8131-131313131313'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, 80, NULL, false, NULL, NULL,
    TIMESTAMPTZ '2026-01-31 23:30:00+05',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'almaty jan edge'
  );
  PERFORM public.seller_ledger_post_internal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7109'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'accrual', 15, '12121212-1212-4112-8112-121212121212'::uuid,
    '14141414-1414-4141-8141-141414141414'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid,
    1, 15, NULL, false, NULL, NULL,
    TIMESTAMPTZ '2026-01-31 19:00:00+00',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'almaty feb edge'
  );

  INSERT INTO public.seller_goods_issues (
    id, operation_id, seller_id, city_id, credit_amount, actor_id, issue_kind, created_at
  ) VALUES (
    v_zero, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7116'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    10, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'settlement',
    TIMESTAMPTZ '2026-04-02 12:00:00+05'
  );
  INSERT INTO public.seller_goods_issue_items (
    issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
  ) VALUES (
    v_zero, '99999999-9999-4999-8999-999999999999'::uuid, 1, 10, 10, 0
  );

  INSERT INTO public.seller_goods_issues (
    id, operation_id, seller_id, city_id, credit_amount, actor_id, issue_kind, created_at
  ) VALUES (
    v_unk, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7117'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    12, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'settlement',
    TIMESTAMPTZ '2026-04-03 12:00:00+05'
  );
  INSERT INTO public.seller_goods_issue_items (
    issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
  ) VALUES (
    v_unk, '77777777-7777-4777-8777-777777777777'::uuid, 1, 12, 12, NULL
  );

  INSERT INTO public.finance_expenses (amount, expense_date, category, deleted_at, operation_id, comment)
  VALUES
    (250, DATE '2026-01-18', 'seller_payout', NULL, NULL, 'manual mixed-month'),
    (400, DATE '2026-01-12', 'seller_payout', NULL, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa7102'::uuid, 'same op as cash payout'),
    (90, DATE '2025-06-10', 'seller_payout', NULL, NULL, 'legacy journal'),
    (40, DATE '2026-01-19', 'seller_payout', now(), NULL, 'deleted');

  IF (SELECT count(*) FROM public.orders) IS DISTINCT FROM v_orders THEN
    RAISE EXCEPTION 'seed must not add orders';
  END IF;
  IF (SELECT count(*) FROM public.finance_expenses) IS DISTINCT FROM v_exp + 4 THEN
    RAISE EXCEPTION 'unexpected finance_expenses seed count';
  END IF;
END $$;

DO $$
DECLARE
  v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v := public.admin_finance_seller_pnl(DATE '2026-01-01', DATE '2026-01-31');
  IF v #>> '{period,timezone}' IS DISTINCT FROM 'Asia/Almaty' THEN
    RAISE EXCEPTION 'timezone %', v #>> '{period,timezone}';
  END IF;
  IF (v #>> '{commissions,accrued}')::numeric IS DISTINCT FROM 1080 THEN
    RAISE EXCEPTION 'jan accrued expected 1080 got %', v #>> '{commissions,accrued}';
  END IF;
  IF (v #>> '{commissions,reversed}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'jan reversed %', v #>> '{commissions,reversed}';
  END IF;
  IF (v #>> '{commissions,missing_rate_count}')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'missing_rate count %', v #>> '{commissions,missing_rate_count}';
  END IF;
  IF v #>> '{commissions,unpaid_debt_accrued}' IS NULL THEN
    RAISE EXCEPTION 'unpaid_debt_accrued missing';
  END IF;
  IF (v #>> '{cash,payout}')::numeric IS DISTINCT FROM 400 THEN
    RAISE EXCEPTION 'payout %', v #>> '{cash,payout}';
  END IF;
  IF (v #>> '{cash,advance}')::numeric IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'advance %', v #>> '{cash,advance}';
  END IF;
  IF (v #>> '{cash,include_in_pnl}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'cash must stay out of pnl';
  END IF;
  IF (v #>> '{goods,credit}')::numeric IS DISTINCT FROM 380 THEN
    RAISE EXCEPTION 'jan goods credit %', v #>> '{goods,credit}';
  END IF;
  IF (v #>> '{goods,cogs}')::numeric IS DISTINCT FROM 105 THEN
    RAISE EXCEPTION 'jan goods cogs %', v #>> '{goods,cogs}';
  END IF;
  IF (v #>> '{goods,settlement_credit}')::numeric IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'settlement credit %', v #>> '{goods,settlement_credit}';
  END IF;
  IF (v #>> '{goods,advance_credit}')::numeric IS DISTINCT FROM 80 THEN
    RAISE EXCEPTION 'advance credit %', v #>> '{goods,advance_credit}';
  END IF;
  IF (v #>> '{goods,credit_is_revenue}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'credit must not be revenue';
  END IF;
  IF (v #>> '{goods,return_count}')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'jan must not include february return';
  END IF;
  IF (v #>> '{pnl,seller_compensation_net}')::numeric IS DISTINCT FROM 805 THEN
    RAISE EXCEPTION 'jan compensation %', v #>> '{pnl,seller_compensation_net}';
  END IF;
  IF (v #>> '{adjustments,signed}')::numeric IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'adj signed %', v #>> '{adjustments,signed}';
  END IF;
  IF (v #>> '{adjustments,include_in_commission_expense}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'adjustments must stay unclassified';
  END IF;
  IF (v #>> '{adjustments,classified}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'adjustments classified flag';
  END IF;
  IF (v #>> '{manual_seller_payout,amount}')::numeric IS DISTINCT FROM 650 THEN
    RAISE EXCEPTION 'manual payout live %', v #>> '{manual_seller_payout,amount}';
  END IF;
  IF (v #>> '{manual_seller_payout,unclassified_amount}')::numeric IS DISTINCT FROM 250 THEN
    RAISE EXCEPTION 'mixed month unclassified %', v #>> '{manual_seller_payout,unclassified_amount}';
  END IF;
  IF (v #>> '{manual_seller_payout,settlement_duplicate_amount}')::numeric IS DISTINCT FROM 400 THEN
    RAISE EXCEPTION 'duplicate matched by operation_id %', v #>> '{manual_seller_payout,settlement_duplicate_amount}';
  END IF;
  IF (v #>> '{manual_seller_payout,legacy_opex_amount}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'jan is not legacy';
  END IF;
  IF (v #>> '{goods,ledger_consistent}')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'jan goods must match ledger';
  END IF;
  IF v::text LIKE '%cost_price_snapshot%' THEN
    RAISE EXCEPTION 'json must not leak cost_price_snapshot';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v := public.admin_finance_seller_pnl(DATE '2026-02-01', DATE '2026-02-28');
  IF (v #>> '{commissions,accrued}')::numeric IS DISTINCT FROM 15 THEN
    RAISE EXCEPTION 'feb edge accrual %', v #>> '{commissions,accrued}';
  END IF;
  IF (v #>> '{goods,credit}')::numeric IS DISTINCT FROM -300 THEN
    RAISE EXCEPTION 'feb return credit %', v #>> '{goods,credit}';
  END IF;
  IF (v #>> '{goods,cogs}')::numeric IS DISTINCT FROM -80 THEN
    RAISE EXCEPTION 'feb return cogs %', v #>> '{goods,cogs}';
  END IF;
  IF (v #>> '{goods,return_count}')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'feb return count';
  END IF;
  IF (v #>> '{pnl,seller_compensation_net}')::numeric IS DISTINCT FROM 235 THEN
    RAISE EXCEPTION 'feb compensation %', v #>> '{pnl,seller_compensation_net}';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v := public.admin_finance_seller_pnl(DATE '2026-03-01', DATE '2026-03-31');
  IF (v #>> '{commissions,accrued}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'mar accrued';
  END IF;
  IF (v #>> '{commissions,reversed}')::numeric IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'mar reversed magnitude %', v #>> '{commissions,reversed}';
  END IF;
  IF (v #>> '{commissions,reversed_signed}')::numeric IS DISTINCT FROM -1000 THEN
    RAISE EXCEPTION 'mar reversed signed';
  END IF;
  IF (v #>> '{pnl,seller_compensation_net}')::numeric IS DISTINCT FROM -1000 THEN
    RAISE EXCEPTION 'mar net %', v #>> '{pnl,seller_compensation_net}';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v := public.admin_finance_seller_pnl(DATE '2026-04-01', DATE '2026-04-30');
  IF (v #>> '{goods,zero_cost_line_count}')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'zero cost lines';
  END IF;
  IF (v #>> '{goods,unknown_cost_line_count}')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'unknown cost lines';
  END IF;
  IF (v #>> '{goods,cogs_complete}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'april cogs must be incomplete';
  END IF;
  IF (v #>> '{goods,cogs}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'known april cogs %', v #>> '{goods,cogs}';
  END IF;
  IF (v #>> '{goods,credit}')::numeric IS DISTINCT FROM 22 THEN
    RAISE EXCEPTION 'april credit %', v #>> '{goods,credit}';
  END IF;
  IF (v #>> '{goods,ledger_consistent}')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'april documents without ledger must be inconsistent';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v jsonb;
  v_empty jsonb;
  v_end jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v_empty := public.admin_finance_seller_pnl(DATE '2024-01-01', DATE '2024-01-31');
  IF (v_empty #>> '{commissions,accrued}')::numeric IS DISTINCT FROM 0
     OR (v_empty #>> '{goods,credit}')::numeric IS DISTINCT FROM 0
     OR (v_empty #>> '{liability,balance_end}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'empty period must be zeros %', v_empty;
  END IF;
  IF (v_empty #>> '{manual_seller_payout,unclassified_amount}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'empty period payouts';
  END IF;

  v := public.admin_finance_seller_pnl(DATE '2025-06-01', DATE '2025-06-30');
  IF (v #>> '{manual_seller_payout,amount}')::numeric IS DISTINCT FROM 90 THEN
    RAISE EXCEPTION 'historical seller_payout %', v #>> '{manual_seller_payout,amount}';
  END IF;
  IF (v #>> '{manual_seller_payout,legacy_opex_amount}')::numeric IS DISTINCT FROM 90 THEN
    RAISE EXCEPTION 'historical month must keep seller_payout as legacy opex';
  END IF;
  IF (v #>> '{manual_seller_payout,unclassified_amount}')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'historical must not be unclassified';
  END IF;

  v_end := public.admin_finance_seller_pnl(DATE '2026-04-01', DATE '2026-04-30');
  IF (v_end #>> '{liability,balance_end}')::numeric IS DISTINCT FROM -555 THEN
    RAISE EXCEPTION 'negative/end balance %', v_end #>> '{liability,balance_end}';
  END IF;

  BEGIN
    PERFORM public.admin_finance_seller_pnl(DATE '2026-02-01', DATE '2026-01-01');
    RAISE EXCEPTION 'invalid period must fail';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Finance period is invalid%' THEN
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
    PERFORM public.admin_finance_seller_pnl(DATE '2026-01-01', DATE '2026-01-31');
    RAISE EXCEPTION 'manager must not read finance pnl';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Finance permission denied%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_finance_seller_pnl(DATE '2026-01-01', DATE '2026-01-31');
    RAISE EXCEPTION 'seller must not read finance pnl';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Finance permission denied%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true);
  SET ROLE authenticated;
  BEGIN
    PERFORM public.admin_finance_seller_pnl(DATE '2026-01-01', DATE '2026-01-31');
    RAISE EXCEPTION 'inactive admin must not read finance pnl';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM NOT LIKE '%Account is inactive%' THEN
        RAISE;
      END IF;
  END;
  RESET ROLE;
END $$;
