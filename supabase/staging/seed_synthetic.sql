-- Synthetic staging seed. No production phones, names, or orders.
-- Requires auth users (create in Staging Authentication first):
--   staging-admin@example.test
--   staging-manager@example.test
--   staging-manager-b@example.test
--   staging-seller@example.test
--   staging-seller-b@example.test
-- Run AFTER schema + run_*.sql on STAGING only.

DO $$
DECLARE
  v_admin uuid;
  v_manager uuid;
  v_manager_b uuid;
  v_seller uuid;
  v_seller_b uuid;
  v_city uuid;
  v_city_b uuid;
  v_powder uuid;
  v_powder_kid uuid;
  v_tea uuid;
  v_draje uuid;
  v_orders bigint;
BEGIN
  SELECT COUNT(*) INTO v_orders FROM public.orders;
  IF v_orders > 20 THEN
    RAISE EXCEPTION 'seed refused: orders=% looks like production', v_orders;
  END IF;

  SELECT id INTO v_admin FROM auth.users WHERE email = 'staging-admin@example.test';
  SELECT id INTO v_manager FROM auth.users WHERE email = 'staging-manager@example.test';
  SELECT id INTO v_manager_b FROM auth.users WHERE email = 'staging-manager-b@example.test';
  SELECT id INTO v_seller FROM auth.users WHERE email = 'staging-seller@example.test';
  SELECT id INTO v_seller_b FROM auth.users WHERE email = 'staging-seller-b@example.test';

  IF v_admin IS NULL OR v_manager IS NULL OR v_manager_b IS NULL OR v_seller IS NULL OR v_seller_b IS NULL THEN
    RAISE EXCEPTION 'Create staging auth users with the five staging-*@example.test emails first';
  END IF;

  INSERT INTO public.cities (name, address, is_active)
  VALUES ('STAGING City', 'test only', true)
  ON CONFLICT (name) DO UPDATE SET is_active = true, address = EXCLUDED.address
  RETURNING id INTO v_city;

  INSERT INTO public.cities (name, address, is_active)
  VALUES ('STAGING City B', 'test only B', true)
  ON CONFLICT (name) DO UPDATE SET is_active = true, address = EXCLUDED.address
  RETURNING id INTO v_city_b;

  INSERT INTO public.profiles (id, display_name, role, city_id, is_active)
  VALUES
    (v_admin, 'Staging Admin', 'admin', v_city, true),
    (v_manager, 'Staging Manager', 'manager', v_city, true),
    (v_manager_b, 'Staging Manager B', 'manager', v_city, true),
    (v_seller, 'Айгүл', 'seller', v_city, true),
    (v_seller_b, 'Айгүл', 'seller', v_city_b, true)
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        role = EXCLUDED.role,
        city_id = EXCLUDED.city_id,
        is_active = true;

  SELECT id INTO v_powder FROM public.products WHERE name = 'Порошок' LIMIT 1;
  IF v_powder IS NULL THEN
    INSERT INTO public.products (name, category, unit, price_retail, is_active, sort_order)
    VALUES ('Порошок', 'test', 'pcs', 1000, true, 1)
    RETURNING id INTO v_powder;
  ELSE
    UPDATE public.products SET price_retail = 1000, is_active = true WHERE id = v_powder;
  END IF;

  SELECT id INTO v_powder_kid FROM public.products WHERE name = 'Порошок детский' LIMIT 1;
  IF v_powder_kid IS NULL THEN
    INSERT INTO public.products (name, category, unit, price_retail, is_active, sort_order)
    VALUES ('Порошок детский', 'test', 'pcs', 800, true, 2)
    RETURNING id INTO v_powder_kid;
  END IF;

  SELECT id INTO v_tea FROM public.products WHERE name = 'Чай' LIMIT 1;
  IF v_tea IS NULL THEN
    INSERT INTO public.products (name, category, unit, price_retail, is_active, sort_order)
    VALUES ('Чай', 'test', 'pcs', 500, true, 3)
    RETURNING id INTO v_tea;
  ELSE
    UPDATE public.products SET price_retail = 500, is_active = true WHERE id = v_tea;
  END IF;

  SELECT id INTO v_draje FROM public.products WHERE name = 'Драже' LIMIT 1;
  IF v_draje IS NULL THEN
    INSERT INTO public.products (name, category, unit, price_retail, is_active, sort_order)
    VALUES ('Драже', 'test', 'pcs', 300, true, 4)
    RETURNING id INTO v_draje;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE name = 'STAGING Last Unit') THEN
    INSERT INTO public.products (name, category, unit, price_retail, is_active, sort_order)
    VALUES ('STAGING Last Unit', 'test', 'pcs', 500, true, 9);
  END IF;

  INSERT INTO public.inventory (city_id, product_id, qty_on_hand, low_stock_threshold)
  VALUES
    (v_city, v_powder, 20, 1),
    (v_city, v_powder_kid, 5, 1),
    (v_city, v_tea, 20, 1),
    (v_city, v_draje, 20, 1),
    (v_city_b, v_powder, 5, 1),
    (v_city_b, v_tea, 5, 1),
    (v_city, (SELECT id FROM public.products WHERE name = 'STAGING Last Unit' LIMIT 1), 1, 1)
  ON CONFLICT (city_id, product_id) DO UPDATE
    SET qty_on_hand = EXCLUDED.qty_on_hand;

  RAISE NOTICE 'staging seed ok city=% cityB=% admin=% manager=% seller=%',
    v_city, v_city_b, v_admin, v_manager, v_seller;
END $$;
