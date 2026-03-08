-- =============================================================================
-- Один скрипт для Supabase SQL Editor: колонки отмены + admin_cancel_order
-- с возвратом остатков и обновлением preorder/debt полей.
-- Запустить один раз в Supabase → SQL Editor → New query → Run.
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

DROP FUNCTION IF EXISTS public.admin_cancel_order(uuid, text);
DROP FUNCTION IF EXISTS public.admin_cancel_order(uuid);

CREATE OR REPLACE FUNCTION public.admin_cancel_order(p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_rec record;
  v_item record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Only admin can cancel orders';
  END IF;

  SELECT id, city_id, status, is_preorder, preorder_status
  INTO v_order_rec FROM public.orders WHERE id = p_order_id FOR UPDATE;

  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  IF v_order_rec.status = 'canceled' THEN
    RETURN;
  END IF;

  -- Возврат остатков: если товар был списан (fulfilled preorder или обычный заказ)
  IF v_order_rec.preorder_status = 'fulfilled' OR NOT COALESCE(v_order_rec.is_preorder, false) THEN
    FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
    LOOP
      UPDATE inventory SET qty_on_hand = qty_on_hand + v_item.qty, updated_at = now()
      WHERE city_id = v_order_rec.city_id AND product_id = v_item.product_id;
      INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_order_rec.city_id, v_item.product_id, 'cancel_sale', v_item.qty, p_order_id, auth.uid());
    END LOOP;
  END IF;

  UPDATE public.orders
  SET status = 'canceled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      updated_at = now(),
      preorder_status = CASE WHEN COALESCE(is_preorder, false) THEN 'cancelled' ELSE preorder_status END,
      fulfilled_at = CASE WHEN COALESCE(is_preorder, false) THEN NULL ELSE fulfilled_at END,
      debt_paid_at = CASE WHEN COALESCE(is_debt, false) THEN NULL ELSE debt_paid_at END
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_cancel_order(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_order(uuid, text) TO service_role;
