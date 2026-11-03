-- Local PostgreSQL harness. Not for production.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  unit text NOT NULL DEFAULT 'pcs',
  price_retail numeric(12,2) NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  sort_order integer DEFAULT 999
);

GRANT ALL ON TABLE public.products TO anon;
GRANT ALL ON TABLE public.products TO authenticated;
GRANT ALL ON TABLE public.products TO service_role;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS cost_price numeric(12,2);
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_cost_price_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_cost_price_check CHECK (cost_price IS NULL OR cost_price >= 0);

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON COLUMN public.products.cost_price FROM authenticated';
  RAISE EXCEPTION 'expected 42601 for REVOKE ALL ON COLUMN';
EXCEPTION
  WHEN syntax_error THEN
    NULL;
END $$;

REVOKE ALL ON TABLE public.products FROM PUBLIC;
REVOKE ALL ON TABLE public.products FROM anon;
REVOKE ALL ON TABLE public.products FROM authenticated;

GRANT SELECT (
  id, name, category, unit, price_retail, is_active, created_at, sort_order
) ON TABLE public.products TO anon, authenticated;

GRANT INSERT (
  id, name, category, unit, price_retail, is_active, created_at, sort_order, cost_price
) ON TABLE public.products TO authenticated;

GRANT UPDATE (
  id, name, category, unit, price_retail, is_active, created_at, sort_order, cost_price
) ON TABLE public.products TO authenticated;

GRANT DELETE ON TABLE public.products TO authenticated;
GRANT ALL ON TABLE public.products TO service_role;

INSERT INTO public.products (name, price_retail, cost_price) VALUES ('tea', 1000, 400);

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.products', 'SELECT') THEN
    RAISE EXCEPTION 'table-level SELECT must be gone';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.products', 'name', 'SELECT') THEN
    RAISE EXCEPTION 'catalog name must stay readable';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.products', 'price_retail', 'SELECT') THEN
    RAISE EXCEPTION 'retail price must stay readable';
  END IF;
  IF has_column_privilege('authenticated', 'public.products', 'cost_price', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT cost_price';
  END IF;
  IF has_column_privilege('anon', 'public.products', 'cost_price', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not SELECT cost_price';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.products', 'cost_price', 'UPDATE') THEN
    RAISE EXCEPTION 'admin authenticated must be able to UPDATE cost_price (RLS still applies)';
  END IF;
  IF has_column_privilege('anon', 'public.products', 'cost_price', 'UPDATE') THEN
    RAISE EXCEPTION 'anon must not UPDATE cost_price';
  END IF;
END $$;

SET ROLE authenticated;
SELECT name, price_retail FROM public.products;
DO $$
BEGIN
  PERFORM cost_price FROM public.products;
  RAISE EXCEPTION 'SELECT cost_price as authenticated must fail';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
DO $$
BEGIN
  PERFORM * FROM public.products;
  RAISE EXCEPTION 'SELECT * as authenticated must fail';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
RESET ROLE;

SELECT 'privilege model ok' AS status;
