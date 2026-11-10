-- Local ACL probe for 5.19.2. Mirrors Production after 5.17.6D. Not for production.

GRANT ALL ON TABLE public.inventory TO anon, authenticated, service_role;

REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC, anon, authenticated;
GRANT SELECT, REFERENCES, DELETE, TRIGGER, TRUNCATE, MAINTAIN, UPDATE
  ON TABLE public.inventory_movements TO anon, authenticated;
GRANT ALL ON TABLE public.inventory_movements TO service_role;

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_admin_select ON public.inventory;
CREATE POLICY inventory_admin_select ON public.inventory
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS movements_admin_select ON public.inventory_movements;
CREATE POLICY movements_admin_select ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.audit_inventory_definer_bump(
  p_city_id uuid,
  p_product_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_qty numeric;
BEGIN
  UPDATE public.inventory
  SET qty_on_hand = qty_on_hand + 1, updated_at = now()
  WHERE city_id = p_city_id AND product_id = p_product_id
  RETURNING qty_on_hand INTO v_qty;
  INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, note)
  VALUES (p_city_id, p_product_id, 'restock', 1, '5192 definer probe');
  RETURN v_qty;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_inventory_definer_bump(uuid, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.audit_inventory_definer_bump(uuid, uuid)
  TO authenticated;
