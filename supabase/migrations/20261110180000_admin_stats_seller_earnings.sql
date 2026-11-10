-- 5.18 read-only per-seller commission aggregates for /admin/stats ranking.
-- Does not rewrite confirm_order, accrual hooks, finance P&L, inventory, or balances.
-- Does not backfill. Do not apply until explicitly allowed.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_stats_seller_earnings(p_from date, p_to date)
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
  v_sellers jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Stats period is required';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'Stats period is invalid';
  END IF;

  v_from := p_from::timestamp AT TIME ZONE 'Asia/Almaty';
  v_to_excl := (p_to + 1)::timestamp AT TIME ZONE 'Asia/Almaty';

  SELECT COALESCE(
    jsonb_agg(s.row ORDER BY s.seller_id),
    '[]'::jsonb
  )
    INTO v_sellers
  FROM (
    SELECT
      l.seller_id,
      jsonb_build_object(
        'seller_id', l.seller_id,
        'accrued', COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'accrual' AND NOT COALESCE(l.missing_rate, false)), 0)::numeric(12,2),
        'reversed', COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'reversal'), 0)::numeric(12,2),
        'earned', (
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'accrual' AND NOT COALESCE(l.missing_rate, false)), 0)
          + COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'reversal'), 0)
        )::numeric(12,2),
        'missing_rate_count', COALESCE(COUNT(*) FILTER (WHERE l.entry_type = 'accrual' AND l.missing_rate), 0)::integer,
        'items', COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'order_item_id', i.order_item_id,
                'product_id', i.product_id,
                'accrued', i.accrued,
                'reversed', i.reversed,
                'missing_rate', i.missing_rate
              )
              ORDER BY i.order_item_id
            )
            FROM (
              SELECT
                x.order_item_id,
                x.product_id,
                COALESCE(SUM(x.amount) FILTER (WHERE x.entry_type = 'accrual' AND NOT COALESCE(x.missing_rate, false)), 0)::numeric(12,2) AS accrued,
                COALESCE(-SUM(x.amount) FILTER (WHERE x.entry_type = 'reversal'), 0)::numeric(12,2) AS reversed,
                BOOL_OR(x.entry_type = 'accrual' AND COALESCE(x.missing_rate, false)) AS missing_rate
              FROM public.seller_ledger x
              WHERE x.seller_id = l.seller_id
                AND x.accrued_at >= v_from
                AND x.accrued_at < v_to_excl
                AND x.entry_type IN ('accrual', 'reversal')
              GROUP BY x.order_item_id, x.product_id
            ) i
          ),
          '[]'::jsonb
        )
      ) AS row
    FROM public.seller_ledger l
    WHERE l.accrued_at >= v_from
      AND l.accrued_at < v_to_excl
      AND l.entry_type IN ('accrual', 'reversal')
    GROUP BY l.seller_id
  ) s;

  RETURN jsonb_build_object(
    'actor_id', v_uid,
    'period', jsonb_build_object(
      'from', to_jsonb(p_from),
      'to', to_jsonb(p_to),
      'timezone', 'Asia/Almaty'
    ),
    'sellers', v_sellers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_stats_seller_earnings(date, date)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_stats_seller_earnings(date, date) TO authenticated;

COMMIT;
