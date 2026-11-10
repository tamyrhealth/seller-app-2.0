-- Extra local stubs for 5.17.6B. Not for production.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS cost_price numeric(12,2);

INSERT INTO public.products (id, name, cost_price) VALUES
  ('88888888-8888-4888-8888-888888888888', 'Filter', 25)
ON CONFLICT (id) DO UPDATE SET cost_price = EXCLUDED.cost_price, name = EXCLUDED.name;

INSERT INTO public.products (id, name) VALUES
  ('77777777-7777-4777-8777-777777777777', 'NoCost')
ON CONFLICT (id) DO NOTHING;

UPDATE public.products
SET cost_price = 40
WHERE id = '99999999-9999-4999-8999-999999999999' AND cost_price IS NULL;

CREATE TABLE IF NOT EXISTS public.inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES public.cities(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  qty_on_hand numeric(12,3) NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (city_id, product_id)
);
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  city_id uuid NOT NULL REFERENCES public.cities(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  type text NOT NULL,
  qty_delta numeric(12,3) NOT NULL,
  order_id uuid,
  note text,
  created_by uuid
);

CREATE TABLE IF NOT EXISTS public.finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount numeric(12,2) NOT NULL
);

INSERT INTO public.inventory (city_id, product_id, qty_on_hand) VALUES
  ('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999', 20),
  ('11111111-1111-4111-8111-111111111111', '88888888-8888-4888-8888-888888888888', 10)
ON CONFLICT (city_id, product_id) DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand;
