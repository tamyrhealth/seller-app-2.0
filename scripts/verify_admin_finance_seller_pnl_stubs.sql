-- Extra local stubs for 5.17.7B. Not for production.

CREATE OR REPLACE FUNCTION public.finance_require_active_admin()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_active boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT p.role, COALESCE(p.is_active, true)
    INTO v_role, v_active
  FROM public.profiles p
  WHERE p.id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Finance permission denied';
  END IF;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Account is inactive';
  END IF;
  RETURN v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.finance_require_active_admin()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS expense_date date;
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS operation_id uuid;
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS comment text;

INSERT INTO public.orders (id, seller_id, city_id) VALUES
  ('21212121-2121-4121-8121-212121212121', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111'),
  ('31313131-3131-4131-8131-313131313131', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.order_items (id, order_id, product_id, qty) VALUES
  ('23232323-2323-4232-8232-232323232323', '21212121-2121-4121-8121-212121212121', '99999999-9999-4999-8999-999999999999', 2),
  ('24242424-2424-4242-8242-242424242424', '21212121-2121-4121-8121-212121212121', '99999999-9999-4999-8999-999999999999', 1),
  ('25252525-2525-4252-8252-252525252525', '31313131-3131-4131-8131-313131313131', '99999999-9999-4999-8999-999999999999', 1)
ON CONFLICT (id) DO NOTHING;
