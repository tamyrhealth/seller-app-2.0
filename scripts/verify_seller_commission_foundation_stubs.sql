-- Local PostgreSQL stubs for 5.17.3A. Not for production.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  display_name text,
  role text NOT NULL,
  is_active boolean DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'P',
  unit text NOT NULL DEFAULT 'pcs',
  price_retail numeric(12,2) NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.profiles(id),
  city_id uuid NOT NULL REFERENCES public.cities(id)
);
CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id),
  product_id uuid NOT NULL REFERENCES public.products(id)
);

INSERT INTO public.cities (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Atyrau')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, display_name, role, is_active) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Admin', 'admin', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Seller', 'seller', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Manager', 'manager', true),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Inactive', 'admin', false),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Seller2', 'seller', true),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Admin2', 'admin', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.products (id, name) VALUES
  ('99999999-9999-4999-8999-999999999999', 'Oil')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orders (id, seller_id, city_id) VALUES
  ('12121212-1212-4112-8112-121212121212', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.order_items (id, order_id, product_id) VALUES
  ('13131313-1313-4131-8131-131313131313', '12121212-1212-4112-8112-121212121212', '99999999-9999-4999-8999-999999999999'),
  ('14141414-1414-4141-8141-141414141414', '12121212-1212-4112-8112-121212121212', '99999999-9999-4999-8999-999999999999')
ON CONFLICT (id) DO NOTHING;
