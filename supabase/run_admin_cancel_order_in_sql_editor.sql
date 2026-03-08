-- Скопируй и выполни весь блок в Supabase → SQL Editor → New query → Run.
-- После выполнения проверь (отдельным запросом):
--   SELECT n.nspname, p.proname, oidvectortypes(p.proargtypes) AS args
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'admin_cancel_order';
-- Ожидается: public | admin_cancel_order | uuid, text

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

CREATE OR REPLACE FUNCTION public.admin_cancel_order(p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_role text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role IS NULL OR v_role != 'admin' THEN RAISE EXCEPTION 'not allowed'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = p_order_id) THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  UPDATE public.orders
  SET status = 'canceled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      updated_at = now()
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_cancel_order(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_order(uuid, text) TO service_role;
