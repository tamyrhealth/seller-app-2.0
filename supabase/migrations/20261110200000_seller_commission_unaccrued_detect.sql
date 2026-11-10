-- 5.19.4 Detect hook-skipped commission lines. Safe per-item retry guard.
-- Does not rewrite confirm_order, fulfill_preorder, cancel RPCs, or RAISE WARNING policy.
-- Does not backfill, rewrite missing_rate snapshots, tariffs, or ledger history.
-- Retry is allowed only if the winning tariff/override/assignment row was recorded
-- (immutable created_at) at or before sale time — not a backdated effective_from.

BEGIN;

CREATE OR REPLACE FUNCTION public.seller_commission_tariff_recorded_by_sale(
  p_seller_id uuid,
  p_product_id uuid,
  p_at timestamptz
)
RETURNS TABLE(allowed boolean, refuse_reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_ov public.seller_rate_overrides%ROWTYPE;
  v_asg public.seller_tariff_assignments%ROWTYPE;
  v_rt public.seller_tariff_rates%ROWTYPE;
BEGIN
  IF p_seller_id IS NULL OR p_product_id IS NULL OR p_at IS NULL THEN
    allowed := false;
    refuse_reason := 'no_tariff_at_sale';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT *
    INTO v_ov
  FROM public.seller_rate_overrides o
  WHERE o.seller_id = p_seller_id
    AND o.product_id = p_product_id
    AND o.effective_from <= p_at
    AND (o.effective_to IS NULL OR o.effective_to > p_at)
  ORDER BY o.effective_from DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_ov.created_at > p_at THEN
      allowed := false;
      refuse_reason := 'backdated_tariff';
      RETURN NEXT;
      RETURN;
    END IF;
    allowed := true;
    refuse_reason := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT *
    INTO v_asg
  FROM public.seller_tariff_assignments a
  WHERE a.seller_id = p_seller_id
    AND a.effective_from <= p_at
    AND (a.effective_to IS NULL OR a.effective_to > p_at)
  ORDER BY a.effective_from DESC
  LIMIT 1;
  IF NOT FOUND THEN
    allowed := false;
    refuse_reason := 'no_tariff_at_sale';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_asg.created_at > p_at THEN
    allowed := false;
    refuse_reason := 'backdated_tariff';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT *
    INTO v_rt
  FROM public.seller_tariff_rates r
  WHERE r.plan_id = v_asg.plan_id
    AND r.product_id = p_product_id
    AND r.effective_from <= p_at
    AND (r.effective_to IS NULL OR r.effective_to > p_at)
  ORDER BY r.effective_from DESC
  LIMIT 1;
  IF NOT FOUND THEN
    allowed := false;
    refuse_reason := 'no_tariff_at_sale';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_rt.created_at > p_at THEN
    allowed := false;
    refuse_reason := 'backdated_tariff';
    RETURN NEXT;
    RETURN;
  END IF;

  allowed := true;
  refuse_reason := NULL;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_unaccrued_items_list(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_limit integer;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, 100), 200));
  SELECT COALESCE(jsonb_agg(q.row ORDER BY q.sale_at DESC, q.order_item_id), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT
      jsonb_build_object(
        'order_item_id', oi.id,
        'order_id', o.id,
        'order_number', CASE
          WHEN to_jsonb(o) ? 'order_number' THEN to_jsonb(o) ->> 'order_number'
          ELSE NULL
        END,
        'seller_id', o.seller_id,
        'seller_name', p.display_name,
        'product_id', oi.product_id,
        'product_name', pr.name,
        'qty', oi.qty,
        'sale_at', t.sale_at,
        'reason', CASE
          WHEN chk.refuse_reason = 'no_tariff_at_sale' THEN 'no_tariff_at_sale'
          WHEN chk.refuse_reason = 'backdated_tariff' THEN 'backdated_tariff'
          ELSE 'hook_skip'
        END,
        'retryable', COALESCE(chk.allowed, false),
        'status', 'unaccrued'
      ) AS row,
      t.sale_at,
      oi.id AS order_item_id
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    LEFT JOIN public.seller_ledger l
      ON l.order_item_id = oi.id AND l.entry_type = 'accrual'
    LEFT JOIN public.profiles p ON p.id = o.seller_id
    LEFT JOIN public.products pr ON pr.id = oi.product_id
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN COALESCE(o.is_preorder, false) THEN COALESCE(o.fulfilled_at, o.created_at, now())
        ELSE COALESCE(o.created_at, now())
      END AS sale_at
    ) t
    LEFT JOIN LATERAL public.seller_commission_tariff_recorded_by_sale(
      o.seller_id, oi.product_id, t.sale_at
    ) chk ON TRUE
    WHERE l.id IS NULL
      AND NOT COALESCE(oi.is_gift, false)
      AND oi.qty > 0
      AND o.status IS DISTINCT FROM 'canceled'
      AND o.status IS DISTINCT FROM 'cancelled'
      AND (
        NOT COALESCE(o.is_preorder, false)
        OR o.preorder_status = 'fulfilled'
      )
    ORDER BY t.sale_at DESC, oi.id
    LIMIT v_limit
  ) q;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_accrual_consistency_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_eligible integer := 0;
  v_accrued integer := 0;
  v_missing_rate integer := 0;
  v_reversed integer := 0;
  v_hook_skip integer := 0;
  v_no_tariff integer := 0;
  v_backdated integer := 0;
  v_gifts integer := 0;
  v_pending_preorders integer := 0;
  v_canceled_without_accrual integer := 0;
BEGIN
  v_uid := public.seller_commission_require_active_staff();

  SELECT COUNT(*)::integer INTO v_gifts
  FROM public.order_items oi
  WHERE COALESCE(oi.is_gift, false);

  SELECT COUNT(*)::integer INTO v_pending_preorders
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE COALESCE(o.is_preorder, false)
    AND o.preorder_status IS DISTINCT FROM 'fulfilled'
    AND o.status IS DISTINCT FROM 'canceled'
    AND o.status IS DISTINCT FROM 'cancelled'
    AND NOT COALESCE(oi.is_gift, false)
    AND oi.qty > 0;

  SELECT COUNT(*)::integer INTO v_canceled_without_accrual
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  LEFT JOIN public.seller_ledger l
    ON l.order_item_id = oi.id AND l.entry_type = 'accrual'
  WHERE o.status IN ('canceled', 'cancelled')
    AND l.id IS NULL
    AND NOT COALESCE(oi.is_gift, false)
    AND oi.qty > 0;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE acc.id IS NOT NULL)::integer,
    COUNT(*) FILTER (WHERE acc.missing_rate)::integer,
    COUNT(*) FILTER (WHERE acc.id IS NOT NULL AND rev.id IS NOT NULL)::integer,
    COUNT(*) FILTER (WHERE acc.id IS NULL AND COALESCE(chk.allowed, false))::integer,
    COUNT(*) FILTER (
      WHERE acc.id IS NULL AND chk.refuse_reason = 'no_tariff_at_sale'
    )::integer,
    COUNT(*) FILTER (
      WHERE acc.id IS NULL AND chk.refuse_reason = 'backdated_tariff'
    )::integer
  INTO v_eligible, v_accrued, v_missing_rate, v_reversed, v_hook_skip, v_no_tariff, v_backdated
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  LEFT JOIN public.seller_ledger acc
    ON acc.order_item_id = oi.id AND acc.entry_type = 'accrual'
  LEFT JOIN public.seller_ledger rev
    ON rev.entry_type = 'reversal' AND rev.reversal_of = acc.id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN COALESCE(o.is_preorder, false) THEN COALESCE(o.fulfilled_at, o.created_at, now())
      ELSE COALESCE(o.created_at, now())
    END AS sale_at
  ) t
  LEFT JOIN LATERAL public.seller_commission_tariff_recorded_by_sale(
    o.seller_id, oi.product_id, t.sale_at
  ) chk ON TRUE
  WHERE NOT COALESCE(oi.is_gift, false)
    AND oi.qty > 0
    AND o.status IS DISTINCT FROM 'canceled'
    AND o.status IS DISTINCT FROM 'cancelled'
    AND (
      NOT COALESCE(o.is_preorder, false)
      OR o.preorder_status = 'fulfilled'
    );

  RETURN jsonb_build_object(
    'actor_id', v_uid,
    'eligible_sale_lines', v_eligible,
    'accrued', v_accrued,
    'missing_rate', v_missing_rate,
    'reversed', v_reversed,
    'unaccrued_hook_skip', v_hook_skip,
    'unaccrued_no_tariff', v_no_tariff,
    'unaccrued_backdated', v_backdated,
    'gifts', v_gifts,
    'pending_preorders', v_pending_preorders,
    'canceled_without_accrual', v_canceled_without_accrual,
    'auto_recalc', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_accrual_retry_item(p_order_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_item record;
  v_existing public.seller_ledger%ROWTYPE;
  v_at timestamptz;
  v_chk record;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_order_item_id IS NULL THEN
    RAISE EXCEPTION 'Order item is required';
  END IF;

  SELECT oi.id, oi.order_id, oi.product_id, oi.qty, COALESCE(oi.is_gift, false) AS is_gift,
         o.seller_id, o.status, COALESCE(o.is_preorder, false) AS is_preorder,
         o.preorder_status, o.created_at, o.fulfilled_at
    INTO v_item
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Order item not found';
  END IF;
  IF v_item.is_gift THEN
    RAISE EXCEPTION 'Gift items are not accrued';
  END IF;
  IF v_item.status IN ('canceled', 'cancelled') THEN
    RAISE EXCEPTION 'Canceled orders are not accrued';
  END IF;
  IF v_item.is_preorder AND v_item.preorder_status IS DISTINCT FROM 'fulfilled' THEN
    RAISE EXCEPTION 'Preorder is not fulfilled';
  END IF;

  SELECT * INTO v_existing
  FROM public.seller_ledger
  WHERE order_item_id = p_order_item_id
    AND entry_type = 'accrual';
  IF FOUND THEN
    IF v_existing.missing_rate THEN
      RAISE EXCEPTION 'Historical missing_rate snapshot is immutable';
    END IF;
    RAISE EXCEPTION 'Seller accrual already exists for order item';
  END IF;

  v_at := CASE
    WHEN v_item.is_preorder THEN COALESCE(v_item.fulfilled_at, now())
    ELSE COALESCE(v_item.created_at, now())
  END;
  SELECT chk.allowed, chk.refuse_reason
    INTO v_chk
  FROM public.seller_commission_tariff_recorded_by_sale(
    v_item.seller_id, v_item.product_id, v_at
  ) chk;
  IF NOT COALESCE(v_chk.allowed, false) THEN
    IF v_chk.refuse_reason = 'backdated_tariff' THEN
      RAISE EXCEPTION 'Retry refused: tariff was recorded after the sale';
    END IF;
    RAISE EXCEPTION 'Retry refused: no tariff at sale time (will not write missing_rate snapshot)';
  END IF;

  PERFORM public.seller_commission_accrue_item_internal(
    v_item.order_id,
    v_item.id,
    v_item.seller_id,
    v_item.product_id,
    v_item.qty,
    v_at,
    v_uid
  );
  SELECT * INTO v_existing
  FROM public.seller_ledger
  WHERE order_item_id = p_order_item_id
    AND entry_type = 'accrual';
  RETURN public.seller_ledger_to_json(v_existing);
END;
$$;

REVOKE ALL ON FUNCTION public.seller_commission_tariff_recorded_by_sale(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_unaccrued_items_list(integer)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_accrual_consistency_summary()
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_accrual_retry_item(uuid)
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.admin_seller_unaccrued_items_list(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_accrual_consistency_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_accrual_retry_item(uuid) TO authenticated;

COMMIT;
