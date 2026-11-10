-- 5.17.7B admin finance seller commission aggregates.
-- Read-only RPC. Does not rewrite confirm_order, ledger posts, goods RPCs, or P&L UI.
-- Does not backfill. Does not UPDATE/DELETE finance_expenses.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_finance_seller_pnl(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_from timestamptz;
  v_to_excl timestamptz;
  v_accrued numeric(12,2) := 0;
  v_reversed_signed numeric(12,2) := 0;
  v_missing_rate_count integer := 0;
  v_unpaid_debt numeric(12,2) := 0;
  v_adj_signed numeric(12,2) := 0;
  v_adj_positive numeric(12,2) := 0;
  v_adj_negative numeric(12,2) := 0;
  v_adj_count integer := 0;
  v_cash_payout numeric(12,2) := 0;
  v_cash_advance numeric(12,2) := 0;
  v_ledger_goods numeric(12,2) := 0;
  v_balance_end numeric(12,2) := 0;
  v_goods_credit numeric(12,2) := 0;
  v_goods_cogs numeric(12,2) := 0;
  v_goods_issue_count integer := 0;
  v_goods_return_count integer := 0;
  v_goods_unknown integer := 0;
  v_goods_zero_cost_lines integer := 0;
  v_settlement_credit numeric(12,2) := 0;
  v_advance_credit numeric(12,2) := 0;
  v_payout_manual numeric(12,2) := 0;
  v_payout_manual_count integer := 0;
  v_payout_legacy numeric(12,2) := 0;
  v_payout_legacy_count integer := 0;
  v_payout_dup numeric(12,2) := 0;
  v_payout_dup_count integer := 0;
  v_payout_unclass numeric(12,2) := 0;
  v_payout_unclass_count integer := 0;
  v_cutover date;
  v_ledger_delta numeric(12,2) := 0;
  v_goods_consistent boolean := true;
  v_reversed_abs numeric(12,2) := 0;
  v_commission_net numeric(12,2) := 0;
BEGIN
  v_uid := public.finance_require_active_admin();
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Finance period is required';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'Finance period is invalid';
  END IF;

  v_from := p_from::timestamp AT TIME ZONE 'Asia/Almaty';
  v_to_excl := (p_to + 1)::timestamp AT TIME ZONE 'Asia/Almaty';

  SELECT
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'accrual'), 0)::numeric(12,2),
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'reversal'), 0)::numeric(12,2),
    COALESCE(COUNT(*) FILTER (WHERE l.entry_type = 'accrual' AND l.missing_rate), 0)::integer,
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment'), 0)::numeric(12,2),
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment' AND l.amount > 0), 0)::numeric(12,2),
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment' AND l.amount < 0), 0)::numeric(12,2),
    COALESCE(COUNT(*) FILTER (WHERE l.entry_type = 'adjustment'), 0)::integer,
    COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'cash_payout'), 0)::numeric(12,2),
    COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'cash_advance'), 0)::numeric(12,2),
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type IN ('goods_issue', 'goods_reversal')), 0)::numeric(12,2)
    INTO
      v_accrued,
      v_reversed_signed,
      v_missing_rate_count,
      v_adj_signed,
      v_adj_positive,
      v_adj_negative,
      v_adj_count,
      v_cash_payout,
      v_cash_advance,
      v_ledger_goods
  FROM public.seller_ledger l
  WHERE l.accrued_at >= v_from
    AND l.accrued_at < v_to_excl;

  SELECT COALESCE(SUM(l.amount), 0)::numeric(12,2)
    INTO v_balance_end
  FROM public.seller_ledger l
  WHERE l.accrued_at < v_to_excl;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'orders' AND c.column_name = 'is_debt'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'orders' AND c.column_name = 'debt_status'
  ) THEN
    SELECT COALESCE(SUM(l.amount), 0)::numeric(12,2)
      INTO v_unpaid_debt
    FROM public.seller_ledger l
    JOIN public.orders o ON o.id = l.order_id
    WHERE l.entry_type = 'accrual'
      AND l.accrued_at >= v_from
      AND l.accrued_at < v_to_excl
      AND COALESCE(o.is_debt, false)
      AND COALESCE(o.debt_status, '') IS DISTINCT FROM 'paid';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'orders' AND c.column_name = 'is_debt'
  ) THEN
    SELECT COALESCE(SUM(l.amount), 0)::numeric(12,2)
      INTO v_unpaid_debt
    FROM public.seller_ledger l
    JOIN public.orders o ON o.id = l.order_id
    WHERE l.entry_type = 'accrual'
      AND l.accrued_at >= v_from
      AND l.accrued_at < v_to_excl
      AND COALESCE(o.is_debt, false);
  END IF;

  SELECT
    COALESCE(SUM(
      CASE WHEN g.reversal_of IS NULL THEN g.credit_amount ELSE -g.credit_amount END
    ), 0)::numeric(12,2),
    COALESCE(SUM(
      CASE
        WHEN g.reversal_of IS NULL THEN COALESCE(x.cogs_known, 0)
        ELSE -COALESCE(x.cogs_known, 0)
      END
    ), 0)::numeric(12,2),
    COALESCE(COUNT(*) FILTER (WHERE g.reversal_of IS NULL), 0)::integer,
    COALESCE(COUNT(*) FILTER (WHERE g.reversal_of IS NOT NULL), 0)::integer,
    COALESCE(SUM(x.unknown_lines), 0)::integer,
    COALESCE(SUM(x.zero_cost_lines), 0)::integer,
    COALESCE(SUM(
      CASE
        WHEN g.reversal_of IS NULL AND COALESCE(g.issue_kind, 'settlement') IS DISTINCT FROM 'advance'
          THEN g.credit_amount
        WHEN g.reversal_of IS NOT NULL AND COALESCE(g.issue_kind, 'settlement') IS DISTINCT FROM 'advance'
          THEN -g.credit_amount
        ELSE 0
      END
    ), 0)::numeric(12,2),
    COALESCE(SUM(
      CASE
        WHEN g.reversal_of IS NULL AND g.issue_kind = 'advance' THEN g.credit_amount
        WHEN g.reversal_of IS NOT NULL AND g.issue_kind = 'advance' THEN -g.credit_amount
        ELSE 0
      END
    ), 0)::numeric(12,2)
    INTO
      v_goods_credit,
      v_goods_cogs,
      v_goods_issue_count,
      v_goods_return_count,
      v_goods_unknown,
      v_goods_zero_cost_lines,
      v_settlement_credit,
      v_advance_credit
  FROM public.seller_goods_issues g
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(round(i.qty * i.cost_price_snapshot, 2)) FILTER (WHERE i.cost_price_snapshot IS NOT NULL), 0)::numeric(12,2)
        AS cogs_known,
      COUNT(*) FILTER (WHERE i.cost_price_snapshot IS NULL)::integer AS unknown_lines,
      COUNT(*) FILTER (WHERE i.cost_price_snapshot IS NOT NULL AND i.cost_price_snapshot = 0)::integer AS zero_cost_lines
    FROM public.seller_goods_issue_items i
    WHERE i.issue_id = g.id
  ) x ON true
  WHERE g.created_at >= v_from
    AND g.created_at < v_to_excl;

  v_ledger_delta := round((v_goods_credit + v_ledger_goods)::numeric, 2);
  v_goods_consistent := abs(v_ledger_delta) < 0.005;

  SELECT (MIN(l.accrued_at) AT TIME ZONE 'Asia/Almaty')::date
    INTO v_cutover
  FROM public.seller_ledger l;

  IF to_regclass('public.finance_expenses') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'finance_expenses' AND c.column_name = 'category'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'finance_expenses' AND c.column_name = 'expense_date'
     ) THEN
    SELECT
      COALESCE(SUM(x.amount), 0)::numeric(12,2),
      COALESCE(COUNT(*), 0)::integer,
      COALESCE(SUM(x.amount) FILTER (WHERE x.class = 'legacy_opex'), 0)::numeric(12,2),
      COALESCE(COUNT(*) FILTER (WHERE x.class = 'legacy_opex'), 0)::integer,
      COALESCE(SUM(x.amount) FILTER (WHERE x.class = 'settlement_duplicate'), 0)::numeric(12,2),
      COALESCE(COUNT(*) FILTER (WHERE x.class = 'settlement_duplicate'), 0)::integer,
      COALESCE(SUM(x.amount) FILTER (WHERE x.class = 'unclassified'), 0)::numeric(12,2),
      COALESCE(COUNT(*) FILTER (WHERE x.class = 'unclassified'), 0)::integer
      INTO
        v_payout_manual,
        v_payout_manual_count,
        v_payout_legacy,
        v_payout_legacy_count,
        v_payout_dup,
        v_payout_dup_count,
        v_payout_unclass,
        v_payout_unclass_count
    FROM (
      SELECT e.amount::numeric(12,2) AS amount,
             CASE
               WHEN e.operation_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.seller_ledger l
                 WHERE l.operation_id = e.operation_id
                   AND l.entry_type IN ('cash_payout', 'cash_advance')
               ) THEN 'settlement_duplicate'
               WHEN e.comment IS NOT NULL AND e.comment ILIKE '%[ledger-settlement]%' THEN 'settlement_duplicate'
               WHEN v_cutover IS NULL OR e.expense_date < v_cutover THEN 'legacy_opex'
               ELSE 'unclassified'
             END AS class
      FROM public.finance_expenses e
      WHERE e.category = 'seller_payout'
        AND e.expense_date >= p_from
        AND e.expense_date <= p_to
        AND (
          NOT EXISTS (
            SELECT 1 FROM information_schema.columns d
            WHERE d.table_schema = 'public'
              AND d.table_name = 'finance_expenses'
              AND d.column_name = 'deleted_at'
          )
          OR e.deleted_at IS NULL
        )
    ) x;
  END IF;

  v_reversed_abs := round((-v_reversed_signed)::numeric, 2);
  v_commission_net := round((v_accrued - v_reversed_abs)::numeric, 2);

  RETURN jsonb_build_object(
    'actor_id', v_uid,
    'period', jsonb_build_object(
      'from', to_jsonb(p_from),
      'to', to_jsonb(p_to),
      'timezone', 'Asia/Almaty',
      'from_ts', to_jsonb(v_from),
      'to_exclusive_ts', to_jsonb(v_to_excl)
    ),
    'commissions', jsonb_build_object(
      'accrued', v_accrued,
      'reversed', v_reversed_abs,
      'reversed_signed', v_reversed_signed,
      'net_expense', v_commission_net,
      'missing_rate_count', v_missing_rate_count,
      'unpaid_debt_accrued', v_unpaid_debt
    ),
    'adjustments', jsonb_build_object(
      'signed', v_adj_signed,
      'positive', v_adj_positive,
      'negative', v_adj_negative,
      'count', v_adj_count,
      'classified', false,
      'include_in_commission_expense', false
    ),
    'goods', jsonb_build_object(
      'credit', v_goods_credit,
      'cogs', v_goods_cogs,
      'cogs_complete', v_goods_unknown = 0,
      'unknown_cost_line_count', v_goods_unknown,
      'zero_cost_line_count', v_goods_zero_cost_lines,
      'issue_count', v_goods_issue_count,
      'return_count', v_goods_return_count,
      'settlement_credit', v_settlement_credit,
      'advance_credit', v_advance_credit,
      'credit_is_revenue', false,
      'ledger_goods_signed', v_ledger_goods,
      'ledger_delta', v_ledger_delta,
      'ledger_consistent', v_goods_consistent
    ),
    'cash', jsonb_build_object(
      'payout', v_cash_payout,
      'advance', v_cash_advance,
      'include_in_pnl', false
    ),
    'liability', jsonb_build_object(
      'balance_end', v_balance_end
    ),
    'manual_seller_payout', jsonb_build_object(
      'amount', v_payout_manual,
      'count', v_payout_manual_count,
      'legacy_opex_amount', v_payout_legacy,
      'legacy_opex_count', v_payout_legacy_count,
      'settlement_duplicate_amount', v_payout_dup,
      'settlement_duplicate_count', v_payout_dup_count,
      'unclassified_amount', v_payout_unclass,
      'unclassified_count', v_payout_unclass_count,
      'cutover_date', to_jsonb(v_cutover)
    ),
    'pnl', jsonb_build_object(
      'commission_accrued', v_accrued,
      'commission_reversed', v_reversed_abs,
      'goods_cogs', v_goods_cogs,
      'goods_credit', v_goods_credit,
      'seller_compensation_net', round((v_commission_net + v_goods_cogs - v_goods_credit)::numeric, 2),
      'adjustments_excluded_signed', v_adj_signed,
      'cash_excluded', true,
      'goods_credit_is_not_revenue', true
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_finance_seller_pnl(date, date)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_finance_seller_pnl(date, date) TO authenticated;

COMMIT;
