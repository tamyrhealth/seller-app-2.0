-- 5.17.4 automatic seller commission accruals/reversals.
-- Requires 20261109010000_seller_commission_foundation.sql.
-- Does not CREATE OR REPLACE confirm_order, fulfill_preorder, or cancel RPCs.
-- Does not backfill historical orders. Does not write finance_expenses or inventory.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE OR REPLACE FUNCTION public.seller_commission_operation_id(p_kind text, p_key uuid)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (
    substr(md5(p_kind || ':' || p_key::text), 1, 8) || '-' ||
    substr(md5(p_kind || ':' || p_key::text), 9, 4) || '-' ||
    '4' || substr(md5(p_kind || ':' || p_key::text), 14, 3) || '-' ||
    '8' || substr(md5(p_kind || ':' || p_key::text), 18, 3) || '-' ||
    substr(md5(p_kind || ':' || p_key::text), 21, 12)
  )::uuid;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_accrue_item_internal(
  p_order_id uuid,
  p_order_item_id uuid,
  p_seller_id uuid,
  p_product_id uuid,
  p_qty numeric,
  p_at timestamptz,
  p_actor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_order_id IS NULL OR p_order_item_id IS NULL OR p_seller_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Invalid seller commission accrual payload';
  END IF;
  PERFORM pg_advisory_xact_lock(51730401, hashtext(p_order_id::text));
  PERFORM public.seller_ledger_post_accrual_internal(
    public.seller_commission_operation_id('accrual', p_order_item_id),
    p_seller_id,
    p_order_id,
    p_order_item_id,
    p_product_id,
    p_qty,
    COALESCE(p_at, now()),
    p_actor_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_accrue_order_internal(
  p_order_id uuid,
  p_actor_id uuid,
  p_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_order record;
  v_item record;
  v_at timestamptz;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order is required';
  END IF;
  PERFORM pg_advisory_xact_lock(51730401, hashtext(p_order_id::text));

  SELECT o.id, o.seller_id, o.status,
         COALESCE(o.is_preorder, false) AS is_preorder,
         o.preorder_status
    INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status IN ('canceled', 'cancelled') THEN
    RETURN;
  END IF;
  IF v_order.is_preorder AND v_order.preorder_status IS DISTINCT FROM 'fulfilled' THEN
    RETURN;
  END IF;

  v_at := COALESCE(p_at, now());
  FOR v_item IN
    SELECT oi.id, oi.product_id, oi.qty, COALESCE(oi.is_gift, false) AS is_gift
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
    ORDER BY oi.id
  LOOP
    IF v_item.is_gift THEN
      CONTINUE;
    END IF;
    PERFORM public.seller_commission_accrue_item_internal(
      p_order_id,
      v_item.id,
      v_order.seller_id,
      v_item.product_id,
      v_item.qty,
      v_at,
      p_actor_id
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_reverse_order_internal(
  p_order_id uuid,
  p_actor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_acc public.seller_ledger%ROWTYPE;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order is required';
  END IF;
  PERFORM pg_advisory_xact_lock(51730401, hashtext(p_order_id::text));

  FOR v_acc IN
    SELECT l.*
    FROM public.seller_ledger l
    WHERE l.order_id = p_order_id
      AND l.entry_type = 'accrual'
    ORDER BY l.created_at, l.id
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.seller_ledger r
      WHERE r.entry_type = 'reversal'
        AND r.reversal_of = v_acc.id
    ) THEN
      CONTINUE;
    END IF;
    PERFORM public.seller_ledger_post_internal(
      public.seller_commission_operation_id('reversal', v_acc.id),
      v_acc.seller_id,
      'reversal',
      v_acc.amount * -1,
      v_acc.order_id,
      v_acc.order_item_id,
      v_acc.product_id,
      v_acc.qty,
      v_acc.unit_rate_snapshot,
      v_acc.plan_id,
      v_acc.missing_rate,
      v_acc.id,
      NULL,
      now(),
      p_actor_id,
      'order_cancel'
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_order_items_ai()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_order record;
BEGIN
  IF COALESCE(NEW.is_gift, false) THEN
    RETURN NEW;
  END IF;
  IF NEW.qty IS NULL OR NEW.qty <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT o.id, o.seller_id, o.status,
         COALESCE(o.is_preorder, false) AS is_preorder,
         o.preorder_status
    INTO v_order
  FROM public.orders o
  WHERE o.id = NEW.order_id;
  IF v_order.id IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_order.status IN ('canceled', 'cancelled') THEN
    RETURN NEW;
  END IF;
  IF v_order.is_preorder AND v_order.preorder_status IS DISTINCT FROM 'fulfilled' THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM public.seller_commission_accrue_item_internal(
      NEW.order_id,
      NEW.id,
      v_order.seller_id,
      NEW.product_id,
      NEW.qty,
      now(),
      auth.uid()
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'seller_commission accrue skipped for order_item %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_orders_au()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NEW.status IN ('canceled', 'cancelled')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.seller_commission_reverse_order_internal(NEW.id, auth.uid());
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_preorder, false)
     AND NEW.preorder_status = 'fulfilled'
     AND OLD.preorder_status IS DISTINCT FROM 'fulfilled'
     AND NEW.status IS DISTINCT FROM 'canceled'
     AND NEW.status IS DISTINCT FROM 'cancelled' THEN
    BEGIN
      PERFORM public.seller_commission_accrue_order_internal(
        NEW.id,
        auth.uid(),
        COALESCE(NEW.fulfilled_at, now())
      );
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'seller_commission accrue skipped for order %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_order_items_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.seller_ledger l WHERE l.order_item_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Order items with seller commission cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.qty IS DISTINCT FROM OLD.qty
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR COALESCE(NEW.is_gift, false) IS DISTINCT FROM COALESCE(OLD.is_gift, false) THEN
    RAISE EXCEPTION 'Order item identity is immutable after insert';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_missing_accruals_list(p_limit integer DEFAULT 100)
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
  SELECT COALESCE(
    jsonb_agg(public.seller_ledger_to_json(l) ORDER BY l.accrued_at DESC, l.created_at DESC),
    '[]'::jsonb
  )
    INTO v_rows
  FROM (
    SELECT *
    FROM public.seller_ledger
    WHERE entry_type = 'accrual'
      AND missing_rate
    ORDER BY accrued_at DESC, created_at DESC
    LIMIT v_limit
  ) l;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
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

DROP TRIGGER IF EXISTS seller_commission_order_items_ai_trg ON public.order_items;
CREATE TRIGGER seller_commission_order_items_ai_trg
  AFTER INSERT ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_commission_order_items_ai();

DROP TRIGGER IF EXISTS seller_commission_orders_au_trg ON public.orders;
CREATE TRIGGER seller_commission_orders_au_trg
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_commission_orders_au();

DROP TRIGGER IF EXISTS seller_commission_order_items_protect_trg ON public.order_items;
CREATE TRIGGER seller_commission_order_items_protect_trg
  BEFORE UPDATE OR DELETE ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_commission_order_items_protect();

REVOKE ALL ON FUNCTION public.seller_commission_operation_id(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_accrue_item_internal(uuid, uuid, uuid, uuid, numeric, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_accrue_order_internal(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_reverse_order_internal(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_order_items_ai()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_orders_au()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_order_items_protect()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_missing_accruals_list(integer)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_accrual_retry_item(uuid)
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.admin_seller_missing_accruals_list(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_accrual_retry_item(uuid) TO authenticated;

COMMIT;
