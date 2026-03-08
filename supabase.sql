-- =============================================
-- MVP Sales & Inventory App - Supabase Migration
-- =============================================

-- 1) cities (must be first - referenced by profiles, inventory, orders)
CREATE TABLE IF NOT EXISTS cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  address text,
  created_at timestamptz DEFAULT now()
);

-- 2) profiles (references auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  role text NOT NULL CHECK (role IN ('admin', 'seller')),
  city_id uuid REFERENCES cities(id),
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 3) products
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  unit text NOT NULL DEFAULT 'pcs',
  price_retail numeric(12,2) NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 4) inventory
CREATE TABLE IF NOT EXISTS inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty_on_hand integer NOT NULL DEFAULT 0,
  low_stock_threshold integer NOT NULL DEFAULT 3,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(city_id, product_id)
);

-- 5) orders
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  cancelled_at timestamptz,
  seller_id uuid NOT NULL REFERENCES profiles(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'canceled')),
  payment_type text CHECK (payment_type IS NULL OR payment_type IN ('cash', 'kaspi', 'card', 'transfer', 'debt')),
  comment text,
  total_sum numeric(12,2) NOT NULL DEFAULT 0,
  is_preorder boolean NOT NULL DEFAULT false,
  preorder_status text NOT NULL DEFAULT 'pending' CHECK (preorder_status IN ('pending', 'fulfilled', 'cancelled')),
  pickup_date date,
  fulfilled_at timestamptz,
  is_debt boolean NOT NULL DEFAULT false,
  debt_status text NOT NULL DEFAULT 'none' CHECK (debt_status IN ('none', 'active', 'paid', 'written_off')),
  debt_due_at date,
  debt_paid_at timestamptz,
  debt_payment_method text,
  debt_customer_name text,
  debt_customer_phone text,
  debt_note text
);

-- 6) order_items
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  product_name_snapshot text NOT NULL,
  price numeric(12,2) NOT NULL,
  qty integer NOT NULL,
  line_sum numeric(12,2) NOT NULL
);

-- 7) inventory_movements
CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  city_id uuid NOT NULL REFERENCES cities(id),
  product_id uuid NOT NULL REFERENCES products(id),
  type text NOT NULL CHECK (type IN ('sale', 'cancel_sale', 'restock', 'adjust')),
  qty_delta integer NOT NULL,
  order_id uuid REFERENCES orders(id),
  note text,
  created_by uuid REFERENCES profiles(id)
);

-- Triggers
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_updated_at ON inventory;
CREATE TRIGGER inventory_updated_at
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_city ON profiles(city_id);
CREATE INDEX IF NOT EXISTS idx_inventory_city_product ON inventory(city_id, product_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_city ON orders(city_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_movements_city ON inventory_movements(city_id);

-- =============================================
-- RLS
-- =============================================
ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

-- Helper: get user role
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: get user city_id
CREATE OR REPLACE FUNCTION get_user_city_id()
RETURNS uuid AS $$
  SELECT city_id FROM profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- profiles
DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT
  USING (id = auth.uid() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE
  USING (id = auth.uid() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS "profiles_insert" ON profiles;
CREATE POLICY "profiles_insert" ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id OR get_user_role() = 'admin');

-- cities
DROP POLICY IF EXISTS "cities_select" ON cities;
CREATE POLICY "cities_select" ON cities FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "cities_insert_admin" ON cities;
CREATE POLICY "cities_insert_admin" ON cities FOR INSERT TO authenticated WITH CHECK (get_user_role() = 'admin');

DROP POLICY IF EXISTS "cities_update_admin" ON cities;
CREATE POLICY "cities_update_admin" ON cities FOR UPDATE TO authenticated USING (get_user_role() = 'admin');

DROP POLICY IF EXISTS "cities_delete_admin" ON cities;
CREATE POLICY "cities_delete_admin" ON cities FOR DELETE TO authenticated USING (get_user_role() = 'admin');

-- products
DROP POLICY IF EXISTS "products_select" ON products;
CREATE POLICY "products_select" ON products FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "products_all_admin" ON products;
CREATE POLICY "products_all_admin" ON products FOR ALL
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- inventory
DROP POLICY IF EXISTS "inventory_seller_select" ON inventory;
CREATE POLICY "inventory_seller_select" ON inventory FOR SELECT
  USING (city_id = get_user_city_id() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS "inventory_admin_all" ON inventory;
CREATE POLICY "inventory_admin_all" ON inventory FOR ALL
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- Продавец может обновлять остатки только в своём городе (для выдачи предзаказа)
DROP POLICY IF EXISTS "inventory_seller_update" ON inventory;
CREATE POLICY "inventory_seller_update" ON inventory FOR UPDATE
  USING (city_id = get_user_city_id())
  WITH CHECK (city_id = get_user_city_id());

-- orders
DROP POLICY IF EXISTS "orders_seller_select" ON orders;
CREATE POLICY "orders_seller_select" ON orders FOR SELECT
  USING (seller_id = auth.uid() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS "orders_seller_insert" ON orders;
CREATE POLICY "orders_seller_insert" ON orders FOR INSERT
  WITH CHECK (seller_id = auth.uid() AND city_id = get_user_city_id() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS "orders_update" ON orders;
CREATE POLICY "orders_update" ON orders FOR UPDATE
  USING (seller_id = auth.uid() OR get_user_role() = 'admin')
  WITH CHECK (true);

DROP POLICY IF EXISTS "orders_admin_all" ON orders;
CREATE POLICY "orders_admin_delete" ON orders FOR DELETE
  USING (get_user_role() = 'admin');

-- order_items
DROP POLICY IF EXISTS "order_items_select" ON order_items;
CREATE POLICY "order_items_select" ON order_items FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND (o.seller_id = auth.uid() OR get_user_role() = 'admin'))
  );

DROP POLICY IF EXISTS "order_items_insert" ON order_items;
CREATE POLICY "order_items_insert" ON order_items FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND (o.seller_id = auth.uid() OR get_user_role() = 'admin'))
  );

DROP POLICY IF EXISTS "order_items_admin" ON order_items;
CREATE POLICY "order_items_admin" ON order_items FOR ALL
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- inventory_movements
DROP POLICY IF EXISTS "movements_seller_select" ON inventory_movements;
CREATE POLICY "movements_seller_select" ON inventory_movements FOR SELECT
  USING (city_id = get_user_city_id() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS "movements_insert" ON inventory_movements;
CREATE POLICY "movements_insert" ON inventory_movements FOR INSERT
  WITH CHECK (city_id = get_user_city_id() AND created_by = auth.uid() OR get_user_role() = 'admin');

DROP POLICY IF EXISTS "movements_admin" ON inventory_movements;
CREATE POLICY "movements_admin" ON inventory_movements FOR ALL
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- =============================================
-- RPC: confirm_order (SECURITY DEFINER)
-- =============================================
CREATE OR REPLACE FUNCTION confirm_order(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seller_id uuid;
  v_city_id uuid;
  v_role text;
  v_order_id uuid;
  v_items jsonb;
  v_item jsonb;
  v_total numeric := 0;
  v_product_name text;
  v_price numeric;
  v_qty int;
  v_line_sum numeric;
  v_current_qty int;
  v_is_debt boolean;
BEGIN
  v_seller_id := auth.uid();
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, city_id INTO v_role, v_city_id FROM profiles WHERE id = v_seller_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF v_role = 'admin' THEN
    v_city_id := (payload->>'city_id')::uuid;
    v_seller_id := (payload->>'seller_id')::uuid;
    IF v_city_id IS NULL OR v_seller_id IS NULL THEN
      RAISE EXCEPTION 'Admin must provide city_id and seller_id';
    END IF;
  ELSIF v_role = 'seller' THEN
    IF v_city_id IS NULL THEN
      RAISE EXCEPTION 'Seller has no city assigned';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid role';
  END IF;

  v_items := payload->'items';
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'No items in order';
  END IF;

  -- Preorder: do not check stock and do not deduct at creation. Debt and ordinary: check and deduct.
  IF NOT (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      SELECT qty_on_hand INTO v_current_qty FROM inventory
      WHERE city_id = v_city_id AND product_id = (v_item->>'product_id')::uuid;
      IF v_current_qty IS NULL OR v_current_qty < (v_item->>'qty')::int THEN
        RAISE EXCEPTION 'Insufficient stock for product %', v_item->>'product_id';
      END IF;
    END LOOP;
  END IF;

  v_is_debt := (payload->>'is_debt' = 'true' OR (payload->'is_debt')::text = 'true');
  IF v_is_debt AND (NULLIF(trim(COALESCE(payload->>'debt_customer_phone', '')), '') IS NULL) THEN
    RAISE EXCEPTION 'Phone required for debt orders';
  END IF;

  INSERT INTO orders (
    seller_id, city_id, status, payment_type, comment, total_sum,
    is_preorder, preorder_status, pickup_date,
    is_debt, debt_status, debt_due_at, debt_customer_name, debt_customer_phone, debt_note
  )
  VALUES (
    v_seller_id,
    v_city_id,
    'confirmed',
    CASE WHEN v_is_debt THEN 'debt' ELSE NULLIF(payload->>'payment_type', '')::text END,
    NULLIF(payload->>'comment', '')::text,
    0,
    (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true'),
    CASE WHEN (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN 'pending' ELSE 'pending' END,
    CASE
      WHEN (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN COALESCE(
        NULLIF(trim(COALESCE(payload->>'pickup_date', '')), '')::date,
        current_date
      )
      ELSE NULL
    END,
    v_is_debt,
    CASE WHEN v_is_debt THEN 'active' ELSE 'none' END,
    CASE WHEN v_is_debt THEN NULLIF(trim(COALESCE(payload->>'debt_due_at', '')), '')::date ELSE NULL END,
    CASE WHEN v_is_debt THEN NULLIF(trim(payload->>'debt_customer_name'), '') ELSE NULL END,
    CASE WHEN v_is_debt THEN NULLIF(trim(payload->>'debt_customer_phone'), '') ELSE NULL END,
    CASE WHEN v_is_debt THEN NULLIF(trim(payload->>'debt_note'), '') ELSE NULL END
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    SELECT name, price_retail INTO v_product_name, v_price
    FROM products WHERE id = (v_item->>'product_id')::uuid;

    v_qty := (v_item->>'qty')::int;
    IF (v_item->>'price') IS NOT NULL AND (v_item->>'price') != '' THEN
      v_price := (v_item->>'price')::numeric;
    END IF;
    v_line_sum := v_price * v_qty;
    v_total := v_total + v_line_sum;

    INSERT INTO order_items (order_id, product_id, product_name_snapshot, price, qty, line_sum)
    VALUES (v_order_id, (v_item->>'product_id')::uuid, v_product_name, v_price, v_qty, v_line_sum);

    IF NOT (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN
      UPDATE inventory SET qty_on_hand = qty_on_hand - v_qty
      WHERE city_id = v_city_id AND product_id = (v_item->>'product_id')::uuid;

      INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_city_id, (v_item->>'product_id')::uuid, 'sale', -v_qty, v_order_id, auth.uid());
    END IF;
  END LOOP;

  UPDATE orders SET total_sum = v_total WHERE id = v_order_id;

  RETURN v_order_id;
END;
$$;

-- Add cancelled_at if table already exists without it
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_preorder boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preorder_status text NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_date date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_preorder_status_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_preorder_status_check CHECK (preorder_status IN ('pending', 'fulfilled', 'cancelled'));
  END IF;
END $$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_debt boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_status text NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_due_at date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_paid_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_payment_method text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_customer_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_customer_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_note text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_debt_status_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_debt_status_check CHECK (debt_status IN ('none', 'active', 'paid', 'written_off'));
  END IF;
END $$;

-- =============================================
-- RPC: fulfill_preorder (SECURITY DEFINER) - deduct inventory and mark fulfilled
-- =============================================
CREATE OR REPLACE FUNCTION fulfill_preorder(p_order_id uuid)
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
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, city_id, seller_id, is_preorder, preorder_status
  INTO v_order_rec
  FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT COALESCE(v_order_rec.is_preorder, false) THEN
    RAISE EXCEPTION 'Order is not a preorder';
  END IF;
  IF v_order_rec.preorder_status != 'pending' THEN
    RAISE EXCEPTION 'Preorder is not pending (already fulfilled or cancelled)';
  END IF;
  IF v_role = 'seller' AND v_order_rec.seller_id != v_uid THEN
    RAISE EXCEPTION 'Seller can only fulfill own preorders';
  END IF;

  -- Check stock for all order items
  FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
  LOOP
    SELECT qty_on_hand INTO v_current_qty FROM inventory
    WHERE city_id = v_order_rec.city_id AND product_id = v_item.product_id;
    IF v_current_qty IS NULL OR v_current_qty < v_item.qty THEN
      RAISE EXCEPTION 'Insufficient stock on warehouse for one or more products';
    END IF;
  END LOOP;

  -- Deduct inventory and create movements
  FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
  LOOP
    UPDATE inventory SET qty_on_hand = qty_on_hand - v_item.qty, updated_at = now()
    WHERE city_id = v_order_rec.city_id AND product_id = v_item.product_id;

    INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
    VALUES (v_order_rec.city_id, v_item.product_id, 'sale', -v_item.qty, p_order_id, v_uid);
  END LOOP;

  -- Вариант A: после выдачи считаем обычным заказом (попадает в "Все заказы" и в суммы)
  UPDATE orders
  SET preorder_status = 'fulfilled',
      fulfilled_at = now(),
      status = 'confirmed',
      is_preorder = false,
      updated_at = now()
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fulfill_preorder(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_preorder(uuid) TO service_role;

-- =============================================
-- RPC: cancel_preorder (SECURITY DEFINER) - only set preorder_status, no inventory
-- =============================================
CREATE OR REPLACE FUNCTION cancel_preorder(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_role text;
  v_order_rec record;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role != 'admin' AND v_role != 'seller' THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, is_preorder, preorder_status INTO v_order_rec FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT COALESCE(v_order_rec.is_preorder, false) THEN
    RAISE EXCEPTION 'Order is not a preorder';
  END IF;
  IF v_order_rec.preorder_status != 'pending' THEN
    RAISE EXCEPTION 'Preorder is already fulfilled or cancelled';
  END IF;

  UPDATE orders SET preorder_status = 'cancelled', updated_at = now() WHERE id = p_order_id;
END;
$$;

-- =============================================
-- RPC: mark_debt_paid (SECURITY DEFINER) - долг погашен, выручка учитывается по paid_at
-- =============================================
CREATE OR REPLACE FUNCTION public.mark_debt_paid(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_role text;
  v_order_rec record;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, seller_id, is_debt, debt_status
  INTO v_order_rec
  FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT COALESCE(v_order_rec.is_debt, false) THEN
    RAISE EXCEPTION 'Order is not a debt';
  END IF;
  IF v_role = 'seller' AND v_order_rec.seller_id != v_uid THEN
    RAISE EXCEPTION 'Seller can only mark own debts as paid';
  END IF;

  IF v_order_rec.debt_status = 'paid' THEN
    RETURN;
  END IF;

  UPDATE orders
  SET debt_status = 'paid',
      debt_paid_at = now(),
      debt_payment_method = NULLIF(trim(COALESCE(p_payment_method, '')), '')::text,
      updated_at = now()
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_debt_paid(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_debt_paid(uuid, text) TO service_role;

-- =============================================
-- RPC: cancel_order (SECURITY DEFINER) - idempotent
-- =============================================
CREATE OR REPLACE FUNCTION cancel_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_role text;
  v_city_id uuid;
  v_seller_id uuid;
  v_created_at timestamptz;
  v_current_status text;
  v_is_preorder boolean;
  v_preorder_status text;
  v_item record;
  v_can_cancel boolean := false;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, city_id INTO v_role, v_city_id FROM profiles WHERE id = v_uid;

  -- Lock order row first, check status (idempotent: already cancelled = no-op)
  SELECT seller_id, city_id, created_at, status, is_preorder, preorder_status
  INTO v_seller_id, v_city_id, v_created_at, v_current_status, v_is_preorder, v_preorder_status
  FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_seller_id IS NULL THEN
    RETURN jsonb_build_object('order_id', p_order_id, 'status', null, 'cancelled', false, 'reason', 'Order not found');
  END IF;

  -- Already cancelled: safe return without touching inventory
  IF v_current_status = 'canceled' THEN
    RETURN jsonb_build_object('order_id', p_order_id, 'status', 'canceled', 'cancelled', false, 'reason', 'Already cancelled');
  END IF;

  -- Pending preorder: only set preorder_status to cancelled, do not touch inventory
  IF COALESCE(v_is_preorder, false) AND v_preorder_status = 'pending' THEN
    IF v_role != 'admin' AND (v_role != 'seller' OR v_seller_id != v_uid) THEN
      RAISE EXCEPTION 'Not allowed to cancel this preorder';
    END IF;
    IF v_role = 'seller' AND v_created_at < now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'Cannot cancel preorder after 10 minutes';
    END IF;
    UPDATE orders SET preorder_status = 'cancelled', updated_at = now() WHERE id = p_order_id;
    RETURN jsonb_build_object('order_id', p_order_id, 'status', 'confirmed', 'cancelled', true, 'reason', 'Preorder cancelled');
  END IF;

  IF v_role = 'admin' THEN
    v_can_cancel := true;
  ELSIF v_role = 'seller' AND v_seller_id = v_uid THEN
    IF v_created_at >= now() - interval '10 minutes' THEN
      v_can_cancel := true;
    ELSE
      RAISE EXCEPTION 'Cannot cancel order after 10 minutes';
    END IF;
  ELSE
    RAISE EXCEPTION 'Not allowed to cancel this order';
  END IF;

  IF NOT v_can_cancel THEN
    RAISE EXCEPTION 'Cannot cancel order';
  END IF;

  -- Return inventory and create movements (lock inventory rows)
  FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
  LOOP
    UPDATE inventory SET qty_on_hand = qty_on_hand + v_item.qty, updated_at = now()
    WHERE city_id = v_city_id AND product_id = v_item.product_id;

    INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
    VALUES (v_city_id, v_item.product_id, 'cancel_sale', v_item.qty, p_order_id, v_uid);
  END LOOP;

  UPDATE orders SET status = 'canceled', cancelled_at = now(), updated_at = now() WHERE id = p_order_id;

  RETURN jsonb_build_object('order_id', p_order_id, 'status', 'canceled', 'cancelled', true, 'reason', 'OK');
END;
$$;
