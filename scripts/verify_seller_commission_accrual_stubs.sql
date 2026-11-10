-- Extra local columns for 5.17.4 trigger tests. Not for production.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'confirmed';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_preorder boolean DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS preorder_status text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_debt boolean DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS qty numeric(12,3) NOT NULL DEFAULT 1;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS is_gift boolean NOT NULL DEFAULT false;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_name_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price numeric(12,2) DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS line_sum numeric(12,2) DEFAULT 0;
