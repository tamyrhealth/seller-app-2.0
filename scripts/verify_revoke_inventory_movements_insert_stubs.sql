-- Local ACL/RLS probe for 5.17.6D. Not for production.

GRANT ALL ON TABLE public.inventory_movements TO anon, authenticated, service_role;

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS movements_admin_select ON public.inventory_movements;
CREATE POLICY movements_admin_select ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.audit_inventory_movement_definer_insert(
  p_city_id uuid,
  p_product_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, note)
  VALUES (p_city_id, p_product_id, 'restock', 1, '5176d definer probe')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_inventory_movement_definer_insert(uuid, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.audit_inventory_movement_definer_insert(uuid, uuid)
  TO authenticated;
