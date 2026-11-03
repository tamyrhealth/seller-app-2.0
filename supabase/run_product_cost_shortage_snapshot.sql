-- Block 4.2: product cost_price + snapshot cost on transfer shortage events.
-- Does not rewrite T000001/T000002. Does not DELETE. Does not change cities.is_active.
-- Shortage still does not touch inventory / inventory_movements.
-- Do not apply until explicitly allowed.

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS cost_price numeric(12,2);

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_cost_price_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_cost_price_check CHECK (cost_price IS NULL OR cost_price >= 0);

-- Table-level GRANT ALL would otherwise expose the new column via SELECT *.
-- Sellers and anon keep catalog columns; they cannot SELECT cost_price.
-- Admin writes cost_price via existing products_all_admin RLS + column UPDATE.
-- Admin reads cost_price only through admin_product_costs() (SECURITY DEFINER).
REVOKE ALL ON COLUMN public.products.cost_price FROM PUBLIC, anon, authenticated;
GRANT INSERT, UPDATE ON COLUMN public.products.cost_price TO authenticated;
GRANT ALL ON COLUMN public.products.cost_price TO service_role;

CREATE OR REPLACE FUNCTION public.admin_product_costs()
RETURNS TABLE(id uuid, cost_price numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admin can read product cost';
  END IF;
  RETURN QUERY SELECT p.id, p.cost_price FROM public.products p;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_product_costs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_product_costs() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.write_off_stock_transfer_shortage(
  p_operation_id uuid,
  p_transfer_id uuid,
  p_items jsonb,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_existing jsonb;
  v_fp text;
  v_tr record;
  v_payload jsonb;
  v_snapshot jsonb;
  v_pid uuid;
  v_add numeric;
  v_remain numeric;
  v_reason text;
  v_status text;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin can write off transfer shortage'; END IF;
  IF p_operation_id IS NULL OR p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'Invalid write-off payload';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Shortage reason is required'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id,
           'qty', s.qty
         ) ORDER BY s.product_id), '[]'::jsonb)
    INTO v_payload
  FROM (
    SELECT (e->>'product_id')::uuid AS product_id,
           round(SUM(COALESCE(
             NULLIF(e->>'qty', '')::numeric,
             NULLIF(e->>'qty_lost', '')::numeric,
             0
           )), 3) AS qty
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) e
    GROUP BY 1
  ) s
  WHERE s.qty > 0;

  IF v_payload IS NULL OR v_payload = '[]'::jsonb THEN
    RAISE EXCEPTION 'No items in write-off';
  END IF;

  v_fp := public.stock_transfer_fingerprint(
    'shortage',
    jsonb_build_object('transfer_id', p_transfer_id, 'reason', v_reason, 'items', v_payload)
  );

  PERFORM pg_advisory_xact_lock(hashtext('client_op:' || v_uid::text), hashtext(p_operation_id::text));

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'fingerprint' IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_tr FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_tr.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  PERFORM 1 FROM public.stock_transfer_items WHERE transfer_id = p_transfer_id ORDER BY product_id FOR UPDATE;
  IF v_tr.status = 'cancelled' THEN RAISE EXCEPTION 'Transfer is cancelled'; END IF;

  SELECT COALESCE(SUM(public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)), 0)
    INTO v_remain
  FROM public.stock_transfer_items
  WHERE transfer_id = p_transfer_id;
  IF v_remain <= 0 THEN
    RAISE EXCEPTION 'No remaining quantity to write off';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload) e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.stock_transfer_items i
      WHERE i.transfer_id = p_transfer_id AND i.product_id = (e->>'product_id')::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Unknown product in write-off payload';
  END IF;

  FOR v_pid, v_add IN
    SELECT (e->>'product_id')::uuid, (e->>'qty')::numeric
    FROM jsonb_array_elements(v_payload) e
    ORDER BY 1
  LOOP
    SELECT public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)
      INTO v_remain
    FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;
    IF v_add IS NULL OR v_add <= 0 THEN RAISE EXCEPTION 'Invalid qty'; END IF;
    IF v_add > v_remain THEN RAISE EXCEPTION 'Write-off qty exceeds remaining in transit'; END IF;
    UPDATE public.stock_transfer_items
    SET qty_lost = qty_lost + v_add
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', (e->>'product_id')::uuid,
           'qty', (e->>'qty')::numeric,
           'unit_cost', to_jsonb(p.cost_price)
         ) ORDER BY (e->>'product_id')), '[]'::jsonb)
    INTO v_snapshot
  FROM jsonb_array_elements(v_payload) e
  LEFT JOIN public.products p ON p.id = (e->>'product_id')::uuid;

  v_status := public.stock_transfer_close_status(p_transfer_id);
  UPDATE public.stock_transfers
  SET status = v_status, updated_at = now()
  WHERE id = p_transfer_id;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (
    p_transfer_id,
    'shortage',
    v_uid,
    jsonb_build_object('items', v_snapshot, 'reason', v_reason, 'status', v_status)
  );

  v_result := jsonb_build_object(
    'id', p_transfer_id,
    'transfer_number', v_tr.transfer_number,
    'status', v_status,
    'fingerprint', v_fp
  );
  INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
  VALUES (v_uid, p_operation_id, 'stock_transfer_shortage', 'stock_transfer', p_transfer_id::text, v_result)
  ON CONFLICT (actor_id, operation_id) DO NOTHING;
  SELECT result INTO v_existing FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  RETURN v_existing;
END;
$$;

REVOKE ALL ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) TO authenticated, service_role;

COMMIT;
