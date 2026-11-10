-- 5.17.6B: seller goods issues against commission (local apply only).
-- Additive columns/constraints/RPCs on existing tables. No new tables.
-- Does not rewrite confirm_order, fulfill_preorder, cancel_order, finance_expenses, or P&L.

BEGIN;

ALTER TABLE public.seller_goods_issues
  ADD COLUMN IF NOT EXISTS issue_number text;
ALTER TABLE public.seller_goods_issues
  ADD COLUMN IF NOT EXISTS issue_kind text;

UPDATE public.seller_goods_issues
SET issue_kind = 'settlement'
WHERE issue_kind IS NULL;

ALTER TABLE public.seller_goods_issues
  ALTER COLUMN issue_kind SET DEFAULT 'settlement';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.seller_goods_issues WHERE issue_kind IS NULL
  ) THEN
    ALTER TABLE public.seller_goods_issues
      ALTER COLUMN issue_kind SET NOT NULL;
  END IF;
END $$;

ALTER TABLE public.seller_goods_issues
  DROP CONSTRAINT IF EXISTS seller_goods_issues_kind_check;
ALTER TABLE public.seller_goods_issues
  ADD CONSTRAINT seller_goods_issues_kind_check
  CHECK (issue_kind = ANY (ARRAY['settlement'::text, 'advance'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS seller_goods_issues_issue_number_uidx
  ON public.seller_goods_issues (issue_number);

CREATE UNIQUE INDEX IF NOT EXISTS seller_goods_issues_reversal_of_uidx
  ON public.seller_goods_issues (reversal_of)
  WHERE reversal_of IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS seller_goods_issue_items_issue_product_uidx
  ON public.seller_goods_issue_items (issue_id, product_id);

CREATE UNIQUE INDEX IF NOT EXISTS seller_ledger_goods_reversal_of_uidx
  ON public.seller_ledger (reversal_of)
  WHERE entry_type = 'goods_reversal';

CREATE SEQUENCE IF NOT EXISTS public.seller_goods_issues_number_seq;

CREATE OR REPLACE FUNCTION public.format_goods_issue_number(p_n bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT 'GI' || lpad(p_n::text, 6, '0');
$$;

CREATE OR REPLACE FUNCTION public.seller_goods_issues_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NEW.issue_number IS NULL OR btrim(NEW.issue_number) = '' THEN
    NEW.issue_number := public.format_goods_issue_number(
      nextval('public.seller_goods_issues_number_seq')
    );
  END IF;
  IF NEW.issue_kind IS NULL THEN
    NEW.issue_kind := 'settlement';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seller_goods_issues_assign_number_trg ON public.seller_goods_issues;
CREATE TRIGGER seller_goods_issues_assign_number_trg
  BEFORE INSERT ON public.seller_goods_issues
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_goods_issues_assign_number();

ALTER TABLE public.inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_type_check;
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_type_check CHECK (type = ANY (ARRAY[
    'sale'::text, 'cancel_sale'::text, 'restock'::text, 'adjust'::text,
    'transfer_out'::text, 'transfer_in'::text, 'transfer_cancel'::text,
    'seller_goods_out'::text, 'seller_goods_in'::text
  ]));

CREATE OR REPLACE FUNCTION public.seller_goods_issues_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Seller goods issues cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
       OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
       OR NEW.city_id IS DISTINCT FROM OLD.city_id
       OR NEW.credit_amount IS DISTINCT FROM OLD.credit_amount
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.reversal_of IS DISTINCT FROM OLD.reversal_of
       OR NEW.comment IS DISTINCT FROM OLD.comment
       OR NEW.issue_number IS DISTINCT FROM OLD.issue_number
       OR NEW.issue_kind IS DISTINCT FROM OLD.issue_kind THEN
      RAISE EXCEPTION 'Seller goods issue identity is immutable';
    END IF;
    IF NEW.ledger_id IS NOT NULL
       AND OLD.ledger_id IS NULL
       AND NEW.reversed_at IS NOT DISTINCT FROM OLD.reversed_at THEN
      RETURN NEW;
    END IF;
    IF NEW.reversed_at IS NOT NULL
       AND OLD.reversed_at IS NULL
       AND NEW.ledger_id IS NOT DISTINCT FROM OLD.ledger_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Seller goods issue identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.seller_goods_issue_to_json(uuid);
CREATE OR REPLACE FUNCTION public.seller_goods_issue_to_json(p_id uuid, p_include_cost boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_issue public.seller_goods_issues%ROWTYPE;
  v_items jsonb;
  v_cost numeric(12,2);
  v_seller text;
  v_city text;
  v_json jsonb;
BEGIN
  SELECT * INTO v_issue FROM public.seller_goods_issues WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT p.display_name INTO v_seller FROM public.profiles p WHERE p.id = v_issue.seller_id;
  SELECT c.name INTO v_city FROM public.cities c WHERE c.id = v_issue.city_id;
  SELECT COALESCE(jsonb_agg(
           CASE WHEN COALESCE(p_include_cost, false) THEN
             jsonb_build_object(
               'id', i.id,
               'product_id', i.product_id,
               'product_name', pr.name,
               'qty', i.qty,
               'unit_credit_amount', i.unit_credit_amount,
               'line_credit_amount', i.line_credit_amount,
               'cost_price_snapshot', i.cost_price_snapshot,
               'line_cost_amount', round(i.qty * i.cost_price_snapshot, 2)
             )
           ELSE
             jsonb_build_object(
               'id', i.id,
               'product_id', i.product_id,
               'product_name', pr.name,
               'qty', i.qty,
               'unit_credit_amount', i.unit_credit_amount,
               'line_credit_amount', i.line_credit_amount
             )
           END
           ORDER BY i.product_id
         ), '[]'::jsonb),
         COALESCE(SUM(round(i.qty * i.cost_price_snapshot, 2)), 0)
    INTO v_items, v_cost
  FROM public.seller_goods_issue_items i
  JOIN public.products pr ON pr.id = i.product_id
  WHERE i.issue_id = p_id;
  v_json := jsonb_build_object(
    'id', v_issue.id,
    'issue_number', v_issue.issue_number,
    'operation_id', v_issue.operation_id,
    'seller_id', v_issue.seller_id,
    'seller_name', v_seller,
    'city_id', v_issue.city_id,
    'city_name', v_city,
    'credit_amount', v_issue.credit_amount,
    'issue_kind', v_issue.issue_kind,
    'ledger_id', v_issue.ledger_id,
    'reversed_at', v_issue.reversed_at,
    'reversal_of', v_issue.reversal_of,
    'actor_id', v_issue.actor_id,
    'comment', v_issue.comment,
    'created_at', v_issue.created_at,
    'status', CASE
      WHEN v_issue.reversal_of IS NOT NULL THEN 'return'
      WHEN v_issue.reversed_at IS NOT NULL THEN 'returned'
      ELSE 'issued'
    END,
    'items', v_items
  );
  IF COALESCE(p_include_cost, false) THEN
    v_json := v_json || jsonb_build_object('cost_total', v_cost);
  END IF;
  RETURN v_json;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_goods_issue_payload_matches(
  p_issue_id uuid,
  p_seller_id uuid,
  p_city_id uuid,
  p_issue_kind text,
  p_comment text,
  p_actor_id uuid,
  p_credit numeric,
  p_items jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_issue public.seller_goods_issues%ROWTYPE;
  v_existing jsonb;
  v_want jsonb;
BEGIN
  SELECT * INTO v_issue FROM public.seller_goods_issues WHERE id = p_issue_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_issue.seller_id IS DISTINCT FROM p_seller_id
     OR v_issue.city_id IS DISTINCT FROM p_city_id
     OR v_issue.issue_kind IS DISTINCT FROM p_issue_kind
     OR v_issue.comment IS DISTINCT FROM p_comment
     OR v_issue.actor_id IS DISTINCT FROM p_actor_id
     OR v_issue.credit_amount IS DISTINCT FROM p_credit THEN
    RETURN false;
  END IF;
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'product_id', i.product_id,
             'qty', i.qty,
             'unit_credit_amount', i.unit_credit_amount
           )
           ORDER BY i.product_id
         ), '[]'::jsonb)
    INTO v_existing
  FROM public.seller_goods_issue_items i
  WHERE i.issue_id = p_issue_id;
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'product_id', x.product_id,
             'qty', x.qty,
             'unit_credit_amount', x.unit_credit
           )
           ORDER BY x.product_id
         ), '[]'::jsonb)
    INTO v_want
  FROM (
    SELECT (e->>'product_id')::uuid AS product_id,
           round((e->>'qty')::numeric, 3) AS qty,
           round((e->>'unit_credit_amount')::numeric, 2) AS unit_credit
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) e
  ) x;
  RETURN v_existing IS NOT DISTINCT FROM v_want;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_goods_issue_post(
  p_operation_id uuid,
  p_seller_id uuid,
  p_city_id uuid,
  p_items jsonb,
  p_comment text,
  p_issue_kind text,
  p_accrued_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_comment text;
  v_kind text;
  v_role text;
  v_existing public.seller_goods_issues%ROWTYPE;
  v_issue_id uuid;
  v_ledger public.seller_ledger%ROWTYPE;
  v_balance numeric(12,2);
  v_credit numeric(12,2) := 0;
  v_at timestamptz;
  v_pid uuid;
  v_qty numeric(12,3);
  v_unit numeric(12,2);
  v_line numeric(12,2);
  v_cost numeric(12,2);
  v_upd integer;
  v_n integer;
  v_dup integer;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_operation_id IS NULL OR p_seller_id IS NULL OR p_city_id IS NULL THEN
    RAISE EXCEPTION 'Invalid seller goods payload';
  END IF;
  v_kind := btrim(COALESCE(p_issue_kind, ''));
  IF v_kind IS DISTINCT FROM 'settlement' AND v_kind IS DISTINCT FROM 'advance' THEN
    RAISE EXCEPTION 'Invalid seller goods payload';
  END IF;
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_seller_id;
  IF v_role IS DISTINCT FROM 'seller' THEN
    RAISE EXCEPTION 'Seller not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cities c WHERE c.id = p_city_id) THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;
  IF p_accrued_at IS NOT NULL AND p_accrued_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Operation date cannot be in the future';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) < 1 THEN
    RAISE EXCEPTION 'Goods issue requires at least one item';
  END IF;

  SELECT count(*), count(DISTINCT (e->>'product_id'))
    INTO v_n, v_dup
  FROM jsonb_array_elements(p_items) e;
  IF v_n IS DISTINCT FROM v_dup THEN
    RAISE EXCEPTION 'Duplicate product in goods issue';
  END IF;

  PERFORM pg_advisory_xact_lock(51730611, hashtext(p_operation_id::text));
  PERFORM pg_advisory_xact_lock(51730312, hashtext(p_seller_id::text));

  SELECT * INTO v_existing
  FROM public.seller_goods_issues
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.reversal_of IS NOT NULL THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    v_credit := v_existing.credit_amount;
    IF NOT public.seller_goods_issue_payload_matches(
         v_existing.id, p_seller_id, p_city_id, v_kind, v_comment, v_uid, v_credit, p_items
       ) THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    IF p_accrued_at IS NOT NULL THEN
      SELECT l.accrued_at INTO v_at FROM public.seller_ledger l WHERE l.id = v_existing.ledger_id;
      IF v_at IS DISTINCT FROM p_accrued_at THEN
        RAISE EXCEPTION 'Idempotency key reused with a different payload';
      END IF;
    END IF;
    RETURN public.seller_goods_issue_to_json(v_existing.id);
  END IF;

  FOR v_pid IN
    SELECT (e->>'product_id')::uuid
    FROM jsonb_array_elements(p_items) e
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || p_city_id::text), hashtext(v_pid::text));
  END LOOP;

  v_at := COALESCE(p_accrued_at, clock_timestamp());
  IF v_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Operation date cannot be in the future';
  END IF;

  FOR v_pid, v_qty, v_unit IN
    SELECT (e->>'product_id')::uuid,
           round((e->>'qty')::numeric, 3),
           round((e->>'unit_credit_amount')::numeric, 2)
    FROM jsonb_array_elements(p_items) e
    ORDER BY 1
  LOOP
    IF v_pid IS NULL THEN
      RAISE EXCEPTION 'Invalid goods issue item';
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid qty for product %', v_pid;
    END IF;
    IF v_unit IS NULL OR v_unit < 0 THEN
      RAISE EXCEPTION 'Invalid unit credit for product %', v_pid;
    END IF;
    v_line := round(v_qty * v_unit, 2);
    v_credit := v_credit + v_line;
    SELECT pr.cost_price INTO v_cost
    FROM public.products pr
    WHERE pr.id = v_pid
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found %', v_pid;
    END IF;
    IF v_cost IS NULL THEN
      RAISE EXCEPTION 'Product cost is required';
    END IF;
    PERFORM 1 FROM public.inventory
    WHERE city_id = p_city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  IF v_credit <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be greater than 0';
  END IF;

  v_balance := public.seller_ledger_balance(p_seller_id);
  IF v_kind = 'settlement' AND v_balance < v_credit THEN
    RAISE EXCEPTION 'Goods issue exceeds available balance';
  END IF;

  BEGIN
    INSERT INTO public.seller_goods_issues (
      operation_id, seller_id, city_id, credit_amount, actor_id, comment, issue_kind
    ) VALUES (
      p_operation_id, p_seller_id, p_city_id, v_credit, v_uid, v_comment, v_kind
    )
    RETURNING id INTO v_issue_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_existing
      FROM public.seller_goods_issues
      WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF v_existing.reversal_of IS NOT NULL THEN
          RAISE EXCEPTION 'Idempotency key reused with a different payload';
        END IF;
        IF NOT public.seller_goods_issue_payload_matches(
             v_existing.id, p_seller_id, p_city_id, v_kind, v_comment, v_uid, v_existing.credit_amount, p_items
           ) THEN
          RAISE EXCEPTION 'Idempotency key reused with a different payload';
        END IF;
        RETURN public.seller_goods_issue_to_json(v_existing.id, true);
      END IF;
      RAISE;
  END;

  FOR v_pid, v_qty, v_unit IN
    SELECT (e->>'product_id')::uuid,
           round((e->>'qty')::numeric, 3),
           round((e->>'unit_credit_amount')::numeric, 2)
    FROM jsonb_array_elements(p_items) e
    ORDER BY 1
  LOOP
    SELECT pr.cost_price INTO v_cost FROM public.products pr WHERE pr.id = v_pid;
    v_line := round(v_qty * v_unit, 2);
    INSERT INTO public.seller_goods_issue_items (
      issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
    ) VALUES (
      v_issue_id, v_pid, v_qty, v_unit, v_line, v_cost
    );
    UPDATE public.inventory
    SET qty_on_hand = qty_on_hand - v_qty,
        updated_at = now()
    WHERE city_id = p_city_id
      AND product_id = v_pid
      AND qty_on_hand >= v_qty;
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    IF v_upd = 0 THEN
      RAISE EXCEPTION 'Insufficient stock for product %', v_pid;
    END IF;
    INSERT INTO public.inventory_movements (
      city_id, product_id, type, qty_delta, created_by, note
    ) VALUES (
      p_city_id, v_pid, 'seller_goods_out', -v_qty, v_uid,
      (SELECT issue_number FROM public.seller_goods_issues WHERE id = v_issue_id)
    );
  END LOOP;

  v_ledger := public.seller_ledger_post_internal(
    p_operation_id,
    p_seller_id,
    'goods_issue',
    -v_credit,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, v_issue_id, v_at, v_uid, v_comment
  );

  UPDATE public.seller_goods_issues
  SET ledger_id = v_ledger.id
  WHERE id = v_issue_id
    AND ledger_id IS NULL;

  RETURN public.seller_goods_issue_to_json(v_issue_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_goods_issue(
  p_operation_id uuid,
  p_seller_id uuid,
  p_city_id uuid,
  p_items jsonb,
  p_comment text DEFAULT NULL,
  p_accrued_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  RETURN public.admin_seller_goods_issue_post(
    p_operation_id, p_seller_id, p_city_id, p_items, p_comment, 'settlement', p_accrued_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_goods_advance(
  p_operation_id uuid,
  p_seller_id uuid,
  p_city_id uuid,
  p_items jsonb,
  p_comment text DEFAULT NULL,
  p_accrued_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  RETURN public.admin_seller_goods_issue_post(
    p_operation_id, p_seller_id, p_city_id, p_items, p_comment, 'advance', p_accrued_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_goods_return(
  p_operation_id uuid,
  p_issue_id uuid,
  p_received boolean,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_comment text;
  v_orig public.seller_goods_issues%ROWTYPE;
  v_existing public.seller_goods_issues%ROWTYPE;
  v_return_id uuid;
  v_ledger public.seller_ledger%ROWTYPE;
  v_pid uuid;
  v_qty numeric(12,3);
  v_unit numeric(12,2);
  v_line numeric(12,2);
  v_cost numeric(12,2);
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_operation_id IS NULL OR p_issue_id IS NULL THEN
    RAISE EXCEPTION 'Invalid seller goods return payload';
  END IF;
  IF p_received IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Physical receipt must be confirmed';
  END IF;
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');

  PERFORM pg_advisory_xact_lock(51730611, hashtext(p_operation_id::text));

  SELECT * INTO v_orig FROM public.seller_goods_issues WHERE id = p_issue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods issue not found';
  END IF;
  PERFORM pg_advisory_xact_lock(51730312, hashtext(v_orig.seller_id::text));

  SELECT * INTO v_orig
  FROM public.seller_goods_issues
  WHERE id = p_issue_id
  FOR UPDATE;

  SELECT * INTO v_existing
  FROM public.seller_goods_issues
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.reversal_of IS DISTINCT FROM p_issue_id
       OR v_existing.actor_id IS DISTINCT FROM v_uid
       OR v_existing.comment IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN public.seller_goods_issue_to_json(v_existing.id);
  END IF;

  IF v_orig.reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot return a goods return document';
  END IF;
  IF v_orig.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Goods issue already returned';
  END IF;
  IF v_orig.ledger_id IS NULL THEN
    RAISE EXCEPTION 'Goods issue ledger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.seller_goods_issue_items WHERE issue_id = p_issue_id) THEN
    RAISE EXCEPTION 'Goods issue has no items to return';
  END IF;

  FOR v_pid IN
    SELECT i.product_id FROM public.seller_goods_issue_items i
    WHERE i.issue_id = p_issue_id
    ORDER BY i.product_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || v_orig.city_id::text), hashtext(v_pid::text));
  END LOOP;

  FOR v_pid IN
    SELECT i.product_id FROM public.seller_goods_issue_items i
    WHERE i.issue_id = p_issue_id
    ORDER BY i.product_id
  LOOP
    PERFORM 1 FROM public.inventory
    WHERE city_id = v_orig.city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  BEGIN
    INSERT INTO public.seller_goods_issues (
      operation_id, seller_id, city_id, credit_amount, actor_id, comment,
      issue_kind, reversal_of
    ) VALUES (
      p_operation_id, v_orig.seller_id, v_orig.city_id, v_orig.credit_amount, v_uid, v_comment,
      v_orig.issue_kind, p_issue_id
    )
    RETURNING id INTO v_return_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_existing
      FROM public.seller_goods_issues
      WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF v_existing.reversal_of IS DISTINCT FROM p_issue_id
           OR v_existing.actor_id IS DISTINCT FROM v_uid
           OR v_existing.comment IS DISTINCT FROM v_comment THEN
          RAISE EXCEPTION 'Idempotency key reused with a different payload';
        END IF;
        RETURN public.seller_goods_issue_to_json(v_existing.id, true);
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.seller_goods_issues WHERE reversal_of = p_issue_id
      ) THEN
        RAISE EXCEPTION 'Goods issue already returned';
      END IF;
      RAISE;
  END;

  FOR v_pid, v_qty, v_unit, v_line, v_cost IN
    SELECT i.product_id, i.qty, i.unit_credit_amount, i.line_credit_amount, i.cost_price_snapshot
    FROM public.seller_goods_issue_items i
    WHERE i.issue_id = p_issue_id
    ORDER BY i.product_id
  LOOP
    INSERT INTO public.seller_goods_issue_items (
      issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
    ) VALUES (
      v_return_id, v_pid, v_qty, v_unit, v_line, v_cost
    );
    INSERT INTO public.inventory (city_id, product_id, qty_on_hand, updated_at)
    VALUES (v_orig.city_id, v_pid, 0, now())
    ON CONFLICT (city_id, product_id) DO NOTHING;
    UPDATE public.inventory
    SET qty_on_hand = qty_on_hand + v_qty,
        updated_at = now()
    WHERE city_id = v_orig.city_id AND product_id = v_pid;
    INSERT INTO public.inventory_movements (
      city_id, product_id, type, qty_delta, created_by, note
    ) VALUES (
      v_orig.city_id, v_pid, 'seller_goods_in', v_qty, v_uid,
      (SELECT issue_number FROM public.seller_goods_issues WHERE id = v_return_id)
    );
  END LOOP;

  v_ledger := public.seller_ledger_post_internal(
    p_operation_id,
    v_orig.seller_id,
    'goods_reversal',
    v_orig.credit_amount,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, v_orig.ledger_id, v_return_id, clock_timestamp(), v_uid, v_comment
  );

  UPDATE public.seller_goods_issues
  SET ledger_id = v_ledger.id
  WHERE id = v_return_id
    AND ledger_id IS NULL;

  UPDATE public.seller_goods_issues
  SET reversed_at = clock_timestamp()
  WHERE id = p_issue_id
    AND reversed_at IS NULL;

  RETURN public.seller_goods_issue_to_json(v_return_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_goods_issues_list(p_seller_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
  v_include_cost boolean := false;
  v_role text;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_uid;
  v_include_cost := v_role IS NOT DISTINCT FROM 'admin';
  SELECT COALESCE(jsonb_agg(public.seller_goods_issue_to_json(g.id, v_include_cost) ORDER BY g.created_at DESC, g.issue_number DESC), '[]'::jsonb)
    INTO v_rows
  FROM public.seller_goods_issues g
  WHERE p_seller_id IS NULL OR g.seller_id = p_seller_id;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_my_goods_issues()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_self();
  SELECT COALESCE(jsonb_agg(public.seller_goods_issue_to_json(g.id, false) ORDER BY g.created_at DESC, g.issue_number DESC), '[]'::jsonb)
    INTO v_rows
  FROM public.seller_goods_issues g
  WHERE g.seller_id = v_uid;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.format_goods_issue_number(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_goods_issues_assign_number()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_goods_issue_to_json(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_goods_issue_payload_matches(uuid, uuid, uuid, text, text, uuid, numeric, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_goods_issue_post(uuid, uuid, uuid, jsonb, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_goods_issue(uuid, uuid, uuid, jsonb, text, timestamptz)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_goods_advance(uuid, uuid, uuid, jsonb, text, timestamptz)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_goods_return(uuid, uuid, boolean, text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_goods_issues_list(uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.seller_my_goods_issues()
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.admin_seller_goods_issue(uuid, uuid, uuid, jsonb, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_goods_advance(uuid, uuid, uuid, jsonb, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_goods_return(uuid, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_goods_issues_list(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seller_my_goods_issues() TO authenticated;

COMMIT;
