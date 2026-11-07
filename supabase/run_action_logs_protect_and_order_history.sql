-- 5.4.2 protect action_logs and complete order-create history.
-- Does not rewrite confirm_order, inventory deduction, 5.2.6, or 5.4.1.
-- Does not UPDATE/DELETE existing action_logs rows.
-- Do not apply until explicitly allowed.

BEGIN;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.action_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.action_logs TO authenticated;

DROP POLICY IF EXISTS "action_logs_insert_authenticated" ON public.action_logs;

CREATE OR REPLACE FUNCTION public.log_order_action(p_action text, p_order_id uuid, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_role text;
BEGIN
  IF p_action IS NULL OR p_order_id IS NULL THEN
    RETURN;
  END IF;
  IF v_uid IS NOT NULL THEN
    SELECT display_name, role INTO v_name, v_role FROM public.profiles WHERE id = v_uid;
  END IF;
  INSERT INTO public.action_logs (user_id, user_name, user_role, action, entity_type, entity_id, details)
  VALUES (
    v_uid,
    v_name,
    v_role,
    p_action,
    'order',
    p_order_id::text,
    COALESCE(p_details, '{}'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_order_action(text, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.log_order_action(text, uuid, jsonb) TO postgres;

CREATE OR REPLACE FUNCTION public.order_history_item_snapshot(p_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', oi.product_id,
        'name', oi.product_name_snapshot,
        'qty', oi.qty,
        'price', oi.price,
        'line_sum', oi.line_sum,
        'is_gift', COALESCE(oi.is_gift, false)
      )
      ORDER BY oi.product_id, COALESCE(oi.is_gift, false)
    ),
    '[]'::jsonb
  )
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id;
$$;

REVOKE ALL ON FUNCTION public.order_history_item_snapshot(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.order_history_item_snapshot(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.orders_log_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_action text;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  v_action := CASE
    WHEN COALESCE(v_order.is_debt, false) THEN 'debt_create'
    WHEN COALESCE(v_order.is_preorder, false) THEN 'preorder_create'
    ELSE 'order_create'
  END;
  PERFORM public.log_order_action(
    v_action,
    v_order.id,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'total_sum', v_order.total_sum,
      'seller_id', v_order.seller_id,
      'city_id', v_order.city_id,
      'payment_type', v_order.payment_type,
      'items', public.order_history_item_snapshot(v_order.id)
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_log_insert_trg ON public.orders;
CREATE CONSTRAINT TRIGGER orders_log_insert_trg
  AFTER INSERT ON public.orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_log_insert();

CREATE OR REPLACE FUNCTION public.fulfill_preorder(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_order record;
  v_item record;
  v_pid uuid;
  v_need numeric;
  v_upd int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, city_id, seller_id, is_preorder, preorder_status, status, order_number
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status IN ('canceled', 'cancelled') THEN
    RAISE EXCEPTION 'Order is canceled';
  END IF;
  IF NOT COALESCE(v_order.is_preorder, false) THEN
    RAISE EXCEPTION 'Order is not a preorder';
  END IF;
  IF v_order.preorder_status = 'fulfilled' THEN
    RETURN;
  END IF;
  IF v_order.preorder_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Preorder is not pending';
  END IF;
  IF v_role = 'seller' AND v_order.seller_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Seller can only fulfill own preorders';
  END IF;

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

    UPDATE public.inventory
    SET qty_on_hand = qty_on_hand - v_need, updated_at = now()
    WHERE city_id = v_order.city_id
      AND product_id = v_pid
      AND qty_on_hand >= v_need;
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    IF v_upd = 0 THEN
      RAISE EXCEPTION 'Insufficient stock';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT product_id, qty FROM public.order_items WHERE order_id = p_order_id
  LOOP
    INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
    VALUES (v_order.city_id, v_item.product_id, 'sale', -v_item.qty, p_order_id, v_uid);
  END LOOP;

  UPDATE public.orders
  SET preorder_status = 'fulfilled',
      fulfilled_at = now(),
      status = 'confirmed',
      updated_at = now()
  WHERE id = p_order_id;

  PERFORM public.log_order_action(
    'preorder_fulfill',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'total_sum', (SELECT o.total_sum FROM public.orders o WHERE o.id = p_order_id),
      'items', public.order_history_item_snapshot(p_order_id)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fulfill_preorder(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_debt_paid(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_order_rec record;
  v_method text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, seller_id, is_debt, debt_status, order_number
    INTO v_order_rec
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT COALESCE(v_order_rec.is_debt, false) THEN
    RAISE EXCEPTION 'Order is not a debt';
  END IF;
  IF v_role = 'seller' AND v_order_rec.seller_id <> v_uid THEN
    RAISE EXCEPTION 'Seller can only mark own debts as paid';
  END IF;
  IF v_order_rec.debt_status = 'paid' THEN
    RETURN;
  END IF;

  v_method := NULLIF(trim(COALESCE(p_payment_method, '')), '');

  UPDATE public.orders
  SET
    debt_status = 'paid',
    debt_paid_at = now(),
    debt_payment_method = v_method,
    payment_type = CASE
      WHEN v_method IN ('cash', 'kaspi') THEN v_method
      ELSE payment_type
    END,
    updated_at = now()
  WHERE id = p_order_id;

  PERFORM public.log_order_action(
    'debt_pay',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order_rec.order_number,
      'payment_method', v_method,
      'total_sum', (SELECT o.total_sum FROM public.orders o WHERE o.id = p_order_id),
      'items', public.order_history_item_snapshot(p_order_id)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_debt_paid(uuid, text) TO authenticated;

COMMIT;
