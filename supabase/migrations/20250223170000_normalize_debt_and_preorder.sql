-- Нормализация debt/preorder и защита от загрязнения БД.
-- 1) fulfill_preorder: НЕ менять is_preorder (остаётся true)
-- 2) Нормализация debt: non-debt => debt_status NULL; debt => debt_status active/paid
-- 3) Предзаказы: is_preorder=true для fulfilled (раньше ставили false)
-- 4) Триггер: авто-синхронизация debt_status по payment_type/is_debt

-- 1) Исправить fulfill_preorder RPC: не ставить is_preorder=false
CREATE OR REPLACE FUNCTION public.fulfill_preorder(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_role text;
  v_order_rec record;
  v_item record;
  v_current_qty int;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN RAISE EXCEPTION 'Not allowed'; END IF;

  SELECT id, city_id, seller_id, is_preorder, preorder_status
  INTO v_order_rec FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order_rec.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT COALESCE(v_order_rec.is_preorder, false) THEN RAISE EXCEPTION 'Order is not a preorder'; END IF;
  IF v_order_rec.preorder_status != 'pending' THEN RAISE EXCEPTION 'Preorder is not pending'; END IF;
  IF v_role = 'seller' AND v_order_rec.seller_id != v_uid THEN RAISE EXCEPTION 'Seller can only fulfill own preorders'; END IF;

  FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
  LOOP
    SELECT qty_on_hand INTO v_current_qty FROM inventory WHERE city_id = v_order_rec.city_id AND product_id = v_item.product_id;
    IF v_current_qty IS NULL OR v_current_qty < v_item.qty THEN RAISE EXCEPTION 'Insufficient stock'; END IF;
  END LOOP;

  FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
  LOOP
    UPDATE inventory SET qty_on_hand = qty_on_hand - v_item.qty, updated_at = now()
    WHERE city_id = v_order_rec.city_id AND product_id = v_item.product_id;
    INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
    VALUES (v_order_rec.city_id, v_item.product_id, 'sale', -v_item.qty, p_order_id, v_uid);
  END LOOP;

  -- Предзаказ остаётся is_preorder=true, только меняем статус
  UPDATE orders
  SET preorder_status = 'fulfilled', fulfilled_at = now(), status = 'confirmed', updated_at = now()
  WHERE id = p_order_id;
END;
$$;

-- 2) Разрешить debt_status NULL для non-debt
ALTER TABLE orders ALTER COLUMN debt_status DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN debt_status DROP DEFAULT;

-- 3) Нормализация: НЕ-долговые заказы
UPDATE public.orders
SET debt_status = NULL, debt_paid_at = NULL, is_debt = false
WHERE (payment_type IS NULL OR payment_type != 'debt')
  AND COALESCE(is_debt, false) = false;

-- На случай старых данных: если payment_type!='debt' но debt_status заполнен — очищаем
UPDATE public.orders
SET debt_status = NULL, debt_paid_at = NULL, is_debt = false
WHERE (payment_type IS NULL OR payment_type != 'debt');

-- 4) Нормализация: долговые заказы
UPDATE public.orders
SET is_debt = true
WHERE payment_type = 'debt' AND COALESCE(is_debt, false) = false;

UPDATE public.orders
SET debt_status = CASE
  WHEN debt_paid_at IS NOT NULL THEN 'paid'
  WHEN debt_status IN ('active','paid') THEN debt_status
  ELSE 'active'
END,
debt_paid_at = CASE WHEN debt_status = 'paid' AND debt_paid_at IS NULL THEN now() ELSE debt_paid_at END
WHERE payment_type = 'debt' OR is_debt = true;

-- 5) Предзаказы: is_preorder=true для выданных (раньше ставили false)
UPDATE public.orders
SET is_preorder = true
WHERE preorder_status = 'fulfilled' OR fulfilled_at IS NOT NULL;

-- 6) Обновить CHECK (разрешить NULL)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_debt_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_debt_status_check
  CHECK (debt_status IS NULL OR debt_status IN ('active', 'paid', 'written_off'));

-- 7) Триггер: авто-синхронизация debt полей
CREATE OR REPLACE FUNCTION public.orders_sync_debt_fields()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_type = 'debt' OR COALESCE(NEW.is_debt, false) = true THEN
    NEW.is_debt := true;
    NEW.debt_status := COALESCE(NULLIF(TRIM(NEW.debt_status::text), ''), 'active');
    IF NEW.debt_paid_at IS NOT NULL THEN NEW.debt_status := 'paid'; END IF;
  ELSE
    NEW.is_debt := false;
    NEW.debt_status := NULL;
    NEW.debt_paid_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_sync_debt_trigger ON orders;
CREATE TRIGGER orders_sync_debt_trigger
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_sync_debt_fields();
