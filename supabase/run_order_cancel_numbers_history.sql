-- Block 2: идемпотентная отмена, безопасная выдача предзаказа,
-- номера N000001, история action_logs из RPC.
-- Не применять к production без явного разрешения.
-- Не трогает cities.is_active. Нет DROP TABLE / TRUNCATE / DELETE строк заказов.

BEGIN;

-- ---------------------------------------------------------------------------
-- Номера заказов
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.orders_order_number_seq;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_number text;

CREATE OR REPLACE FUNCTION public.format_order_number(p_n bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'N' || CASE
    WHEN length(p_n::text) >= 6 THEN p_n::text
    ELSE lpad(p_n::text, 6, '0')
  END;
$$;

UPDATE public.orders o
SET order_number = public.format_order_number(s.rn)
FROM (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM public.orders
  WHERE order_number IS NULL
) s
WHERE o.id = s.id
  AND o.order_number IS NULL;

SELECT setval(
  'public.orders_order_number_seq',
  GREATEST(
    1,
    COALESCE((
      SELECT MAX(NULLIF(regexp_replace(order_number, '\D', '', 'g'), '')::bigint)
      FROM public.orders
    ), 0)
  ),
  (SELECT COALESCE(MAX(NULLIF(regexp_replace(order_number, '\D', '', 'g'), '')::bigint), 0) FROM public.orders) > 0
);

CREATE OR REPLACE FUNCTION public.orders_assign_order_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.order_number IS NULL OR btrim(NEW.order_number) = '' THEN
    NEW.order_number := public.format_order_number(nextval('public.orders_order_number_seq'));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_assign_order_number_trg ON public.orders;
CREATE TRIGGER orders_assign_order_number_trg
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_assign_order_number();

ALTER TABLE public.orders
  ALTER COLUMN order_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_uidx
  ON public.orders (order_number);

REVOKE ALL ON SEQUENCE public.orders_order_number_seq FROM PUBLIC;
GRANT USAGE, SELECT ON SEQUENCE public.orders_order_number_seq TO postgres, service_role;

-- ---------------------------------------------------------------------------
-- История: запись из SQL (DEFINER обходит RLS). Клиентский INSERT policy
-- оставлен без изменений (authenticated INSERT / admin SELECT).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_order_action(p_action text, p_order_id uuid, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

CREATE OR REPLACE FUNCTION public.orders_log_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
BEGIN
  v_action := CASE
    WHEN COALESCE(NEW.is_debt, false) THEN 'debt_create'
    WHEN COALESCE(NEW.is_preorder, false) THEN 'preorder_create'
    ELSE 'order_create'
  END;
  PERFORM public.log_order_action(
    v_action,
    NEW.id,
    jsonb_build_object(
      'order_number', NEW.order_number,
      'total_sum', NEW.total_sum,
      'seller_id', NEW.seller_id,
      'city_id', NEW.city_id
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_log_insert_trg ON public.orders;
CREATE TRIGGER orders_log_insert_trg
  AFTER INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_log_insert();

-- ---------------------------------------------------------------------------
-- Отмена: общая реализация. Сигнатуры cancel_order / admin_cancel_order сохранены.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_order_cancel(p_order_id uuid, p_reason text DEFAULT NULL)
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
  v_should_return boolean;
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

  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role = 'admin' THEN
    NULL;
  ELSIF v_role = 'seller' AND v_order.seller_id = v_uid THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Not allowed to cancel this order';
  END IF;

  IF v_order.status IN ('canceled', 'cancelled') THEN
    RETURN;
  END IF;

  IF v_order.is_preorder AND v_order.preorder_status = 'cancelled' THEN
    UPDATE public.orders
    SET status = 'canceled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
    WHERE id = p_order_id AND status IS DISTINCT FROM 'canceled';
    RETURN;
  END IF;

  IF v_role = 'seller' AND v_order.created_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Cannot cancel order after 10 minutes';
  END IF;

  -- Возврат только если товар уже был списан: обычный заказ или выданный предзаказ.
  v_should_return :=
    (NOT v_order.is_preorder)
    OR (v_order.preorder_status = 'fulfilled');

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
      'was_fulfilled', v_order.preorder_status = 'fulfilled'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_order_cancel(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_order_cancel(uuid, text) TO postgres;

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

GRANT EXECUTE ON FUNCTION public.cancel_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_order(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Выдача предзаказа
-- ---------------------------------------------------------------------------
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
    jsonb_build_object('order_number', v_order.order_number)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fulfill_preorder(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Оплата долга + лог (идемпотентный paid без повторного лога)
-- ---------------------------------------------------------------------------
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
      'payment_method', v_method
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_debt_paid(uuid, text) TO authenticated;

COMMIT;
