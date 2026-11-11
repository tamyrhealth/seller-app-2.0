-- Isolated PostgreSQL harness for 5.20.1. Not Production.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$ SELECT NULL::uuid $$;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  role text
);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  seller_id uuid,
  city_id uuid,
  status text,
  payment_type text,
  comment text,
  total_sum numeric,
  is_preorder boolean,
  preorder_status text,
  is_debt boolean,
  debt_status text,
  debt_paid_at timestamptz,
  debt_customer_phone text,
  order_number text,
  idempotency_key text
);

CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid,
  product_id uuid,
  qty numeric,
  price numeric
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.assert_active_auth_session()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_debt_paid(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.orders
  SET
    is_debt = false,
    debt_status = 'paid',
    payment_type = COALESCE(p_payment_method, payment_type),
    updated_at = now()
  WHERE id = p_order_id;
END;
$$;

INSERT INTO public.orders (seller_id, status, payment_type, total_sum, is_debt, debt_status)
SELECT gen_random_uuid(), 'confirmed', 'debt', 100, true, 'active'
WHERE NOT EXISTS (SELECT 1 FROM public.orders LIMIT 1);
