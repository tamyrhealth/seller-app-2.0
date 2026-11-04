-- Block 5.2.3: manager cancel via can_cancel_orders + jsonb report for AI.
-- Existing cancel_order / admin_cancel_order / apply_order_cancel stay RETURNS void.
-- No DROP FUNCTION. CREATE OR REPLACE keeps production signatures.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_order_cancel_report(p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_can_cancel_orders boolean := false;
  v_order record;
  v_item record;
  v_pid uuid;
  v_need numeric;
  v_should_return boolean;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT
    id, city_id, status, seller_id, order_number, created_at,
    COALESCE(is_preorder, false) AS is_preorder,
    COALESCE(is_debt, false) AS is_debt,
    preorder_status,
    fulfilled_at
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  SELECT role, COALESCE(can_cancel_orders, false)
    INTO v_role, v_can_cancel_orders
  FROM public.profiles
  WHERE id = v_uid;

  IF v_role = 'admin' THEN
    NULL;
  ELSIF v_role = 'manager' THEN
    -- Flag allows cancel of any existing order id. Client cannot pass seller_id.
    IF v_can_cancel_orders IS NOT TRUE THEN
      RAISE EXCEPTION 'Cancel permission denied';
    END IF;
  ELSIF v_role = 'seller' AND v_order.seller_id = v_uid THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Not allowed to cancel this order';
  END IF;

  IF v_order.status IN ('canceled', 'cancelled') THEN
    PERFORM public.log_order_action(
      'order_cancel',
      p_order_id,
      jsonb_build_object(
        'order_number', v_order.order_number,
        'already_canceled', true,
        'returned_stock', false,
        'actor_role', v_role
      )
    );
    RETURN jsonb_build_object(
      'ok', true,
      'already_canceled', true,
      'returned_stock', false,
      'order_number', v_order.order_number
    );
  END IF;

  IF v_order.is_preorder AND v_order.preorder_status = 'cancelled' THEN
    UPDATE public.orders
    SET status = 'canceled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
    WHERE id = p_order_id AND status IS DISTINCT FROM 'canceled';
    PERFORM public.log_order_action(
      'order_cancel',
      p_order_id,
      jsonb_build_object(
        'order_number', v_order.order_number,
        'already_canceled', true,
        'returned_stock', false,
        'actor_role', v_role,
        'was_preorder', true
      )
    );
    RETURN jsonb_build_object(
      'ok', true,
      'already_canceled', true,
      'returned_stock', false,
      'order_number', v_order.order_number
    );
  END IF;

  IF v_role = 'seller' AND v_order.created_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Cannot cancel order after 10 minutes';
  END IF;

  v_should_return :=
    (NOT v_order.is_preorder)
    OR (v_order.preorder_status = 'fulfilled');

  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'product_id', product_id,
      'qty', qty,
      'name', product_name_snapshot
    )),
    '[]'::jsonb
  )
  INTO v_items
  FROM public.order_items
  WHERE order_id = p_order_id;

  IF v_should_return THEN
    FOR v_pid, v_need IN
      SELECT product_id, SUM(qty)
      FROM public.order_items
      WHERE order_id = p_order_id
      GROUP BY 1
      ORDER BY 1
    LOOP
      PERFORM 1 FROM public.inventory
      WHERE city_id = v_order.city_id AND product_id = v_pid
      FOR UPDATE;

      INSERT INTO public.inventory (city_id, product_id, qty_on_hand, updated_at)
      VALUES (v_order.city_id, v_pid, v_need, now())
      ON CONFLICT (city_id, product_id) DO UPDATE
        SET qty_on_hand = public.inventory.qty_on_hand + EXCLUDED.qty_on_hand,
            updated_at = now();
    END LOOP;

    FOR v_item IN
      SELECT product_id, qty FROM public.order_items WHERE order_id = p_order_id
    LOOP
      INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_order.city_id, v_item.product_id, 'cancel_sale', v_item.qty, p_order_id, auth.uid());
    END LOOP;
  END IF;

  UPDATE public.orders
  SET
    status = 'canceled',
    cancelled_at = now(),
    cancelled_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
    updated_at = now(),
    preorder_status = CASE WHEN v_order.is_preorder THEN 'cancelled' ELSE preorder_status END,
    fulfilled_at = CASE WHEN v_order.is_preorder THEN NULL ELSE fulfilled_at END,
    debt_paid_at = CASE WHEN v_order.is_debt THEN NULL ELSE debt_paid_at END
  WHERE id = p_order_id;

  PERFORM public.log_order_action(
    'order_cancel',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),
      'returned_stock', v_should_return,
      'was_preorder', v_order.is_preorder,
      'was_fulfilled', v_order.preorder_status = 'fulfilled',
      'actor_role', v_role,
      'items', v_items
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'already_canceled', false,
    'returned_stock', v_should_return,
    'order_number', v_order.order_number
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_order_cancel(p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.apply_order_cancel_report(p_order_id, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  PERFORM public.apply_order_cancel(p_order_id, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_cancel_order(p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admin can cancel orders';
  END IF;
  PERFORM public.apply_order_cancel(p_order_id, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_order_report(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  RETURN public.apply_order_cancel_report(p_order_id, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_cancel_order_report(p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admin can cancel orders';
  END IF;
  RETURN public.apply_order_cancel_report(p_order_id, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_order_cancel_report(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_order_cancel_report(uuid, text) TO postgres;

REVOKE ALL ON FUNCTION public.apply_order_cancel(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_order_cancel(uuid, text) TO postgres;

REVOKE ALL ON FUNCTION public.cancel_order(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_cancel_order(uuid, text) FROM PUBLIC, anon, service_role;
GRANT ALL ON FUNCTION public.cancel_order(uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_cancel_order(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.cancel_order_report(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_cancel_order_report(uuid, text) FROM PUBLIC, anon, service_role;
GRANT ALL ON FUNCTION public.cancel_order_report(uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_cancel_order_report(uuid, text) TO authenticated;

COMMIT;
