-- Local schema for 5.20.2B. Not for Production.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOINHERIT;
  END IF;
END $$;

CREATE TABLE public.cities (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  is_active boolean DEFAULT true
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  city_id uuid,
  is_active boolean DEFAULT true,
  can_cancel_orders boolean DEFAULT false,
  display_name text
);

CREATE TABLE public.products (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  unit text DEFAULT 'pcs',
  price_retail numeric(12,2) DEFAULT 0,
  cost_price numeric(12,2) DEFAULT 0,
  is_active boolean DEFAULT true,
  sort_order int
);

CREATE TABLE public.inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES public.cities(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  qty_on_hand numeric(12,3) NOT NULL DEFAULT 0,
  low_stock_threshold int NOT NULL DEFAULT 3,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (city_id, product_id)
);

CREATE TABLE public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  city_id uuid NOT NULL,
  product_id uuid NOT NULL,
  type text NOT NULL,
  qty_delta numeric(12,3) NOT NULL,
  order_id uuid,
  note text,
  created_by uuid,
  transfer_id uuid,
  CONSTRAINT inventory_movements_type_check CHECK ((type = ANY (ARRAY['sale'::text, 'cancel_sale'::text, 'restock'::text, 'adjust'::text, 'transfer_out'::text, 'transfer_in'::text, 'transfer_cancel'::text, 'seller_goods_out'::text, 'seller_goods_in'::text])))
);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid,
  city_id uuid,
  status text NOT NULL DEFAULT 'confirmed',
  payment_type text,
  comment text,
  total_sum numeric(12,2) DEFAULT 0,
  is_preorder boolean DEFAULT false,
  preorder_status text DEFAULT 'pending',
  pickup_date date,
  is_debt boolean DEFAULT false,
  debt_status text DEFAULT 'none',
  debt_due_at date,
  debt_customer_name text,
  debt_customer_phone text,
  debt_note text,
  customer_name text,
  customer_phone text,
  customer_phone_canon text,
  order_number text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  fulfilled_at timestamptz,
  debt_paid_at timestamptz,
  cancelled_at timestamptz,
  cancelled_reason text,
  idempotency_key text,
  idempotency_fingerprint text,
  idempotency_actor_id uuid
);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id),
  product_id uuid NOT NULL,
  product_name_snapshot text NOT NULL,
  price numeric(12,2) NOT NULL DEFAULT 0,
  qty numeric(12,3) NOT NULL,
  line_sum numeric(12,2) DEFAULT 0 NOT NULL,
  is_gift boolean DEFAULT false NOT NULL,
  unit_price numeric(12,2) DEFAULT 0,
  cost_price_snapshot numeric(12,2)
);

CREATE TABLE public.client_operations (
  actor_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  operation_type text,
  entity_type text,
  entity_id text,
  result jsonb,
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION public.kz_normalize_customer_phone(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(btrim(COALESCE(p, '')), '') $$;

CREATE OR REPLACE FUNCTION public.log_order_action(p_action text, p_order_id uuid, p_payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;

CREATE OR REPLACE FUNCTION public.order_history_item_snapshot(p_order_id uuid)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '[]'::jsonb $$;

CREATE OR REPLACE FUNCTION public.assert_active_auth_session()
RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;

CREATE TABLE public.seller_goods_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid UNIQUE,
  seller_id uuid,
  city_id uuid,
  credit_amount numeric(12,2),
  actor_id uuid,
  comment text,
  issue_kind text,
  reversal_of uuid,
  ledger_id uuid,
  issue_number text
);
CREATE TABLE public.seller_goods_issue_items (
  issue_id uuid,
  product_id uuid,
  qty numeric(12,3),
  unit_credit_amount numeric(12,2),
  line_credit_amount numeric(12,2),
  cost_price_snapshot numeric(12,2)
);
CREATE TABLE public.seller_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accrued_at timestamptz
);
CREATE TABLE public.stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_city_id uuid,
  to_city_id uuid,
  status text,
  comment text,
  created_by uuid,
  transfer_number text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancelled_reason text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.stock_transfer_items (
  transfer_id uuid,
  product_id uuid,
  qty_sent numeric(12,3) DEFAULT 0,
  qty_received numeric(12,3) DEFAULT 0,
  qty_lost numeric(12,3) DEFAULT 0,
  qty_returned numeric(12,3) DEFAULT 0
);
CREATE TABLE public.stock_transfer_events (
  transfer_id uuid,
  action text,
  actor_id uuid,
  details jsonb
);

CREATE OR REPLACE FUNCTION public.stock_transfer_require(p boolean)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;
CREATE OR REPLACE FUNCTION public.stock_transfer_fingerprint(p text, p2 jsonb)
RETURNS text LANGUAGE sql AS $$ SELECT md5(COALESCE(p2::text, '')); $$;
CREATE OR REPLACE FUNCTION public.stock_transfer_remaining(a numeric, b numeric, c numeric, d numeric)
RETURNS numeric LANGUAGE sql AS $$ SELECT GREATEST(COALESCE(a,0)-COALESCE(b,0)-COALESCE(c,0)-COALESCE(d,0), 0); $$;
CREATE OR REPLACE FUNCTION public.stock_transfer_close_status(p uuid)
RETURNS text LANGUAGE sql AS $$ SELECT 'cancelled'; $$;
CREATE OR REPLACE FUNCTION public.seller_commission_require_active_admin()
RETURNS uuid LANGUAGE sql AS $$ SELECT auth.uid(); $$;
CREATE OR REPLACE FUNCTION public.seller_ledger_balance(p uuid)
RETURNS numeric LANGUAGE sql AS $$ SELECT 0; $$;
CREATE OR REPLACE FUNCTION public.seller_ledger_post_internal(
  a uuid, b uuid, c text, d numeric, e uuid, f uuid, g uuid, h uuid, i uuid, j uuid, k boolean, l uuid, m uuid, n timestamptz, o uuid, p text
) RETURNS public.seller_ledger LANGUAGE plpgsql AS $$
DECLARE r public.seller_ledger%ROWTYPE;
BEGIN RETURN r; END; $$;
CREATE OR REPLACE FUNCTION public.seller_goods_issue_payload_matches(
  a uuid, b uuid, c uuid, d text, e text, f uuid, g numeric, h jsonb
) RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;
CREATE OR REPLACE FUNCTION public.seller_goods_issue_to_json(p uuid, q boolean DEFAULT true)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb; $$;

GRANT SELECT ON TABLE public.inventory TO authenticated;
GRANT SELECT ON TABLE public.orders TO authenticated;
REVOKE ALL ON TABLE public.order_items FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, order_id, product_id, product_name_snapshot, price, qty, line_sum, is_gift, unit_price)
  ON TABLE public.order_items TO authenticated;
