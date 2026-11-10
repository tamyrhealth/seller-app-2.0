-- 5.19.2 Harden table ACLs on inventory and inventory_movements.
-- Does not rewrite RPCs, RLS, triggers, sequences, stock rows, orders, or movements.
-- Client pages only SELECT. Mutations stay SECURITY DEFINER (function owner).

BEGIN;

REVOKE ALL ON TABLE public.inventory FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory FROM anon;
REVOKE ALL ON TABLE public.inventory FROM authenticated;
GRANT SELECT ON TABLE public.inventory TO authenticated;

REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_movements FROM anon;
REVOKE ALL ON TABLE public.inventory_movements FROM authenticated;
GRANT SELECT ON TABLE public.inventory_movements TO authenticated;

COMMIT;
