-- 5.17.3A seller commission foundation (tariffs, ledger, goods-issue schema, cash RPCs).
-- Does not rewrite confirm_order, fulfill_preorder, cancel_order, finance_expenses, or inventory.
-- Does not accrue from orders. Do not apply until explicitly allowed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.seller_tariff_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_tariff_plans_code_key UNIQUE (code),
  CONSTRAINT seller_tariff_plans_code_check CHECK (code = ANY (ARRAY['A'::text, 'B'::text])),
  CONSTRAINT seller_tariff_plans_name_check CHECK (length(btrim(name)) > 0)
);

INSERT INTO public.seller_tariff_plans (code, name, is_active) VALUES
  ('A', 'Тариф A', true),
  ('B', 'Тариф B', true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.seller_tariff_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.seller_tariff_plans(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  amount_kzt numeric(12,2) NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_tariff_rates_amount_check CHECK (amount_kzt >= 0),
  CONSTRAINT seller_tariff_rates_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS seller_tariff_rates_plan_product_idx
  ON public.seller_tariff_rates (plan_id, product_id, effective_from);

CREATE UNIQUE INDEX IF NOT EXISTS seller_tariff_rates_open_uidx
  ON public.seller_tariff_rates (plan_id, product_id)
  WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS public.seller_tariff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES public.seller_tariff_plans(id) ON DELETE RESTRICT,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_tariff_assignments_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS seller_tariff_assignments_seller_idx
  ON public.seller_tariff_assignments (seller_id, effective_from);

CREATE UNIQUE INDEX IF NOT EXISTS seller_tariff_assignments_open_uidx
  ON public.seller_tariff_assignments (seller_id)
  WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS public.seller_rate_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  amount_kzt numeric(12,2) NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_rate_overrides_amount_check CHECK (amount_kzt >= 0),
  CONSTRAINT seller_rate_overrides_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS seller_rate_overrides_seller_product_idx
  ON public.seller_rate_overrides (seller_id, product_id, effective_from);

CREATE UNIQUE INDEX IF NOT EXISTS seller_rate_overrides_open_uidx
  ON public.seller_rate_overrides (seller_id, product_id)
  WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS public.seller_goods_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  city_id uuid NOT NULL REFERENCES public.cities(id) ON DELETE RESTRICT,
  credit_amount numeric(12,2) NOT NULL,
  ledger_id uuid,
  reversed_at timestamptz,
  reversal_of uuid REFERENCES public.seller_goods_issues(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_goods_issues_operation_id_key UNIQUE (operation_id),
  CONSTRAINT seller_goods_issues_credit_check CHECK (credit_amount > 0)
);

CREATE TABLE IF NOT EXISTS public.seller_goods_issue_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES public.seller_goods_issues(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  qty numeric(12,3) NOT NULL,
  unit_credit_amount numeric(12,2) NOT NULL,
  line_credit_amount numeric(12,2) NOT NULL,
  cost_price_snapshot numeric(12,2),
  CONSTRAINT seller_goods_issue_items_qty_check CHECK (qty > 0),
  CONSTRAINT seller_goods_issue_items_unit_credit_check CHECK (unit_credit_amount >= 0),
  CONSTRAINT seller_goods_issue_items_line_credit_check CHECK (line_credit_amount >= 0),
  CONSTRAINT seller_goods_issue_items_cost_check CHECK (cost_price_snapshot IS NULL OR cost_price_snapshot >= 0)
);

CREATE INDEX IF NOT EXISTS seller_goods_issue_items_issue_idx
  ON public.seller_goods_issue_items (issue_id);

CREATE TABLE IF NOT EXISTS public.seller_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  entry_type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id uuid REFERENCES public.order_items(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  qty numeric(12,3),
  unit_rate_snapshot numeric(12,2),
  plan_id uuid REFERENCES public.seller_tariff_plans(id) ON DELETE RESTRICT,
  missing_rate boolean NOT NULL DEFAULT false,
  reversal_of uuid REFERENCES public.seller_ledger(id) ON DELETE RESTRICT,
  goods_issue_id uuid REFERENCES public.seller_goods_issues(id) ON DELETE RESTRICT,
  accrued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  comment text,
  CONSTRAINT seller_ledger_operation_id_key UNIQUE (operation_id),
  CONSTRAINT seller_ledger_type_check CHECK (entry_type = ANY (ARRAY[
    'accrual'::text,
    'reversal'::text,
    'cash_payout'::text,
    'cash_advance'::text,
    'goods_issue'::text,
    'goods_reversal'::text,
    'adjustment'::text
  ])),
  CONSTRAINT seller_ledger_missing_rate_check CHECK (
    (NOT missing_rate)
    OR (amount = 0 AND unit_rate_snapshot IS NULL)
  ),
  CONSTRAINT seller_ledger_accrual_check CHECK (
    entry_type <> 'accrual'
    OR (
      amount >= 0
      AND order_id IS NOT NULL
      AND order_item_id IS NOT NULL
      AND product_id IS NOT NULL
      AND qty IS NOT NULL
      AND qty > 0
      AND reversal_of IS NULL
      AND (
        (missing_rate AND unit_rate_snapshot IS NULL AND amount = 0)
        OR (NOT missing_rate AND unit_rate_snapshot IS NOT NULL AND amount = round(qty * unit_rate_snapshot, 2))
      )
    )
  ),
  CONSTRAINT seller_ledger_reversal_check CHECK (
    entry_type <> 'reversal'
    OR (amount <= 0 AND reversal_of IS NOT NULL AND order_item_id IS NOT NULL)
  ),
  CONSTRAINT seller_ledger_cash_payout_check CHECK (
    entry_type <> 'cash_payout'
    OR (amount < 0 AND order_item_id IS NULL AND NOT missing_rate AND reversal_of IS NULL)
  ),
  CONSTRAINT seller_ledger_cash_advance_check CHECK (
    entry_type <> 'cash_advance'
    OR (amount < 0 AND order_item_id IS NULL AND NOT missing_rate AND reversal_of IS NULL)
  ),
  CONSTRAINT seller_ledger_goods_issue_check CHECK (
    entry_type <> 'goods_issue'
    OR (amount < 0 AND goods_issue_id IS NOT NULL AND NOT missing_rate)
  ),
  CONSTRAINT seller_ledger_goods_reversal_check CHECK (
    entry_type <> 'goods_reversal'
    OR (amount > 0 AND goods_issue_id IS NOT NULL AND reversal_of IS NOT NULL AND NOT missing_rate)
  ),
  CONSTRAINT seller_ledger_adjustment_check CHECK (
    entry_type <> 'adjustment'
    OR (amount <> 0 AND NOT missing_rate)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS seller_ledger_accrual_item_uidx
  ON public.seller_ledger (order_item_id)
  WHERE entry_type = 'accrual';

CREATE UNIQUE INDEX IF NOT EXISTS seller_ledger_reversal_of_uidx
  ON public.seller_ledger (reversal_of)
  WHERE entry_type = 'reversal';

CREATE INDEX IF NOT EXISTS seller_ledger_seller_accrued_idx
  ON public.seller_ledger (seller_id, accrued_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS seller_ledger_order_idx
  ON public.seller_ledger (order_id);

ALTER TABLE public.seller_goods_issues
  DROP CONSTRAINT IF EXISTS seller_goods_issues_ledger_id_fkey;
ALTER TABLE public.seller_goods_issues
  ADD CONSTRAINT seller_goods_issues_ledger_id_fkey
  FOREIGN KEY (ledger_id) REFERENCES public.seller_ledger(id) ON DELETE RESTRICT;

ALTER TABLE public.seller_tariff_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_tariff_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.seller_tariff_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_tariff_rates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.seller_tariff_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_tariff_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.seller_rate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_rate_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE public.seller_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE public.seller_goods_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_goods_issues FORCE ROW LEVEL SECURITY;
ALTER TABLE public.seller_goods_issue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_goods_issue_items FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.seller_tariff_plans FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.seller_tariff_rates FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.seller_tariff_assignments FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.seller_rate_overrides FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.seller_ledger FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.seller_goods_issues FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.seller_goods_issue_items FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.seller_periods_overlap(
  p_a_from timestamptz,
  p_a_to timestamptz,
  p_b_from timestamptz,
  p_b_to timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT tstzrange(p_a_from, COALESCE(p_a_to, 'infinity'::timestamptz), '[)')
     && tstzrange(p_b_from, COALESCE(p_b_to, 'infinity'::timestamptz), '[)');
$$;

CREATE OR REPLACE FUNCTION public.seller_tariff_rates_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Seller tariff rates cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.amount_kzt IS DISTINCT FROM OLD.amount_kzt
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Seller tariff rate identity is immutable';
    END IF;
    IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
      RAISE EXCEPTION 'Seller tariff rate period is closed';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.seller_tariff_rates r
    WHERE r.plan_id = NEW.plan_id
      AND r.product_id = NEW.product_id
      AND r.id IS DISTINCT FROM NEW.id
      AND public.seller_periods_overlap(r.effective_from, r.effective_to, NEW.effective_from, NEW.effective_to)
  ) THEN
    RAISE EXCEPTION 'Seller tariff rate periods overlap';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_tariff_assignments_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Seller tariff assignments cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Seller tariff assignment identity is immutable';
    END IF;
    IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
      RAISE EXCEPTION 'Seller tariff assignment period is closed';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.seller_tariff_assignments a
    WHERE a.seller_id = NEW.seller_id
      AND a.id IS DISTINCT FROM NEW.id
      AND public.seller_periods_overlap(a.effective_from, a.effective_to, NEW.effective_from, NEW.effective_to)
  ) THEN
    RAISE EXCEPTION 'Seller tariff assignment periods overlap';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_rate_overrides_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Seller rate overrides cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.amount_kzt IS DISTINCT FROM OLD.amount_kzt
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Seller rate override identity is immutable';
    END IF;
    IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
      RAISE EXCEPTION 'Seller rate override period is closed';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.seller_rate_overrides o
    WHERE o.seller_id = NEW.seller_id
      AND o.product_id = NEW.product_id
      AND o.id IS DISTINCT FROM NEW.id
      AND public.seller_periods_overlap(o.effective_from, o.effective_to, NEW.effective_from, NEW.effective_to)
  ) THEN
    RAISE EXCEPTION 'Seller rate override periods overlap';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_ledger_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  RAISE EXCEPTION 'Seller ledger is append-only';
END;
$$;

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
    IF NEW.reversed_at IS NOT NULL
       AND OLD.reversed_at IS NULL
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id
       AND NEW.seller_id IS NOT DISTINCT FROM OLD.seller_id
       AND NEW.city_id IS NOT DISTINCT FROM OLD.city_id
       AND NEW.credit_amount IS NOT DISTINCT FROM OLD.credit_amount
       AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Seller goods issue identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_goods_issue_items_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  RAISE EXCEPTION 'Seller goods issue items are immutable';
END;
$$;

DROP TRIGGER IF EXISTS seller_tariff_rates_protect_trg ON public.seller_tariff_rates;
CREATE TRIGGER seller_tariff_rates_protect_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.seller_tariff_rates
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_tariff_rates_protect();

DROP TRIGGER IF EXISTS seller_tariff_assignments_protect_trg ON public.seller_tariff_assignments;
CREATE TRIGGER seller_tariff_assignments_protect_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.seller_tariff_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_tariff_assignments_protect();

DROP TRIGGER IF EXISTS seller_rate_overrides_protect_trg ON public.seller_rate_overrides;
CREATE TRIGGER seller_rate_overrides_protect_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.seller_rate_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_rate_overrides_protect();

DROP TRIGGER IF EXISTS seller_ledger_protect_trg ON public.seller_ledger;
CREATE TRIGGER seller_ledger_protect_trg
  BEFORE UPDATE OR DELETE ON public.seller_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_ledger_protect();

DROP TRIGGER IF EXISTS seller_goods_issues_protect_trg ON public.seller_goods_issues;
CREATE TRIGGER seller_goods_issues_protect_trg
  BEFORE UPDATE OR DELETE ON public.seller_goods_issues
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_goods_issues_protect();

DROP TRIGGER IF EXISTS seller_goods_issue_items_protect_trg ON public.seller_goods_issue_items;
CREATE TRIGGER seller_goods_issue_items_protect_trg
  BEFORE UPDATE OR DELETE ON public.seller_goods_issue_items
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_goods_issue_items_protect();

CREATE OR REPLACE FUNCTION public.seller_commission_require_active_admin()
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
    RAISE EXCEPTION 'Seller commission permission denied';
  END IF;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Account is inactive';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_require_active_staff()
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
  IF v_role IS DISTINCT FROM 'admin' AND v_role IS DISTINCT FROM 'manager' THEN
    RAISE EXCEPTION 'Seller commission permission denied';
  END IF;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Account is inactive';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_require_active_self()
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
  IF v_role IS DISTINCT FROM 'seller' THEN
    RAISE EXCEPTION 'Seller commission permission denied';
  END IF;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Account is inactive';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_resolve_unit_rate(
  p_seller_id uuid,
  p_product_id uuid,
  p_at timestamptz
)
RETURNS TABLE(unit_rate numeric, plan_id uuid, missing_rate boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_rate numeric(12,2);
  v_plan uuid;
BEGIN
  SELECT o.amount_kzt
    INTO v_rate
  FROM public.seller_rate_overrides o
  WHERE o.seller_id = p_seller_id
    AND o.product_id = p_product_id
    AND o.effective_from <= p_at
    AND (o.effective_to IS NULL OR o.effective_to > p_at)
  ORDER BY o.effective_from DESC
  LIMIT 1;
  IF FOUND THEN
    unit_rate := v_rate;
    plan_id := NULL;
    missing_rate := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT a.plan_id
    INTO v_plan
  FROM public.seller_tariff_assignments a
  WHERE a.seller_id = p_seller_id
    AND a.effective_from <= p_at
    AND (a.effective_to IS NULL OR a.effective_to > p_at)
  ORDER BY a.effective_from DESC
  LIMIT 1;

  IF v_plan IS NULL THEN
    unit_rate := NULL;
    plan_id := NULL;
    missing_rate := true;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT r.amount_kzt
    INTO v_rate
  FROM public.seller_tariff_rates r
  WHERE r.plan_id = v_plan
    AND r.product_id = p_product_id
    AND r.effective_from <= p_at
    AND (r.effective_to IS NULL OR r.effective_to > p_at)
  ORDER BY r.effective_from DESC
  LIMIT 1;
  IF NOT FOUND THEN
    unit_rate := NULL;
    plan_id := v_plan;
    missing_rate := true;
    RETURN NEXT;
    RETURN;
  END IF;

  unit_rate := v_rate;
  plan_id := v_plan;
  missing_rate := false;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_ledger_balance(p_seller_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT COALESCE(SUM(l.amount), 0)::numeric(12,2)
  FROM public.seller_ledger l
  WHERE l.seller_id = p_seller_id;
$$;

CREATE OR REPLACE FUNCTION public.seller_ledger_to_json(p_row public.seller_ledger)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT jsonb_build_object(
    'id', p_row.id,
    'seller_id', p_row.seller_id,
    'operation_id', p_row.operation_id,
    'entry_type', p_row.entry_type,
    'amount', p_row.amount,
    'order_id', p_row.order_id,
    'order_item_id', p_row.order_item_id,
    'product_id', p_row.product_id,
    'qty', p_row.qty,
    'unit_rate_snapshot', p_row.unit_rate_snapshot,
    'plan_id', p_row.plan_id,
    'missing_rate', p_row.missing_rate,
    'reversal_of', p_row.reversal_of,
    'goods_issue_id', p_row.goods_issue_id,
    'accrued_at', p_row.accrued_at,
    'created_at', p_row.created_at,
    'actor_id', p_row.actor_id,
    'comment', p_row.comment
  );
$$;

CREATE OR REPLACE FUNCTION public.seller_ledger_post_internal(
  p_operation_id uuid,
  p_seller_id uuid,
  p_entry_type text,
  p_amount numeric,
  p_order_id uuid DEFAULT NULL,
  p_order_item_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_qty numeric DEFAULT NULL,
  p_unit_rate_snapshot numeric DEFAULT NULL,
  p_plan_id uuid DEFAULT NULL,
  p_missing_rate boolean DEFAULT false,
  p_reversal_of uuid DEFAULT NULL,
  p_goods_issue_id uuid DEFAULT NULL,
  p_accrued_at timestamptz DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS public.seller_ledger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_row public.seller_ledger%ROWTYPE;
  v_existing public.seller_ledger%ROWTYPE;
  v_amount numeric(12,2);
  v_comment text;
BEGIN
  IF p_operation_id IS NULL OR p_seller_id IS NULL OR p_entry_type IS NULL THEN
    RAISE EXCEPTION 'Invalid seller ledger payload';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_seller_id) THEN
    RAISE EXCEPTION 'Seller not found';
  END IF;
  v_amount := round(p_amount, 2);
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');

  INSERT INTO public.seller_ledger (
    seller_id, operation_id, entry_type, amount,
    order_id, order_item_id, product_id, qty,
    unit_rate_snapshot, plan_id, missing_rate, reversal_of, goods_issue_id,
    accrued_at, actor_id, comment
  ) VALUES (
    p_seller_id, p_operation_id, p_entry_type, v_amount,
    p_order_id, p_order_item_id, p_product_id, p_qty,
    p_unit_rate_snapshot, p_plan_id, COALESCE(p_missing_rate, false), p_reversal_of, p_goods_issue_id,
    COALESCE(p_accrued_at, now()), p_actor_id, v_comment
  )
  RETURNING * INTO v_row;
  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.seller_ledger
    WHERE operation_id = p_operation_id;
    IF NOT FOUND THEN
      IF p_entry_type = 'accrual' AND p_order_item_id IS NOT NULL THEN
        RAISE EXCEPTION 'Seller accrual already exists for order item';
      END IF;
      RAISE EXCEPTION 'Seller ledger unique conflict';
    END IF;
    IF v_existing.seller_id IS DISTINCT FROM p_seller_id
       OR v_existing.entry_type IS DISTINCT FROM p_entry_type
       OR v_existing.amount IS DISTINCT FROM v_amount
       OR v_existing.order_id IS DISTINCT FROM p_order_id
       OR v_existing.order_item_id IS DISTINCT FROM p_order_item_id
       OR v_existing.product_id IS DISTINCT FROM p_product_id
       OR v_existing.qty IS DISTINCT FROM p_qty
       OR v_existing.unit_rate_snapshot IS DISTINCT FROM p_unit_rate_snapshot
       OR v_existing.plan_id IS DISTINCT FROM p_plan_id
       OR v_existing.missing_rate IS DISTINCT FROM COALESCE(p_missing_rate, false)
       OR v_existing.reversal_of IS DISTINCT FROM p_reversal_of
       OR v_existing.goods_issue_id IS DISTINCT FROM p_goods_issue_id
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.comment IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN v_existing;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_ledger_post_accrual_internal(
  p_operation_id uuid,
  p_seller_id uuid,
  p_order_id uuid,
  p_order_item_id uuid,
  p_product_id uuid,
  p_qty numeric,
  p_accrued_at timestamptz,
  p_actor_id uuid DEFAULT NULL
)
RETURNS public.seller_ledger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_rate numeric;
  v_plan uuid;
  v_missing boolean;
  v_qty numeric(12,3);
  v_amount numeric(12,2);
  v_at timestamptz;
BEGIN
  v_qty := p_qty;
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RAISE EXCEPTION 'Accrual qty must be greater than 0';
  END IF;
  v_at := COALESCE(p_accrued_at, now());
  SELECT r.unit_rate, r.plan_id, r.missing_rate
    INTO v_rate, v_plan, v_missing
  FROM public.seller_resolve_unit_rate(p_seller_id, p_product_id, v_at) r;
  IF COALESCE(v_missing, true) THEN
    v_amount := 0;
    v_rate := NULL;
  ELSE
    v_amount := round(v_qty * v_rate, 2);
  END IF;
  RETURN public.seller_ledger_post_internal(
    p_operation_id,
    p_seller_id,
    'accrual',
    v_amount,
    p_order_id,
    p_order_item_id,
    p_product_id,
    v_qty,
    v_rate,
    v_plan,
    COALESCE(v_missing, true),
    NULL,
    NULL,
    v_at,
    p_actor_id,
    NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_tariff_plans_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'code', p.code,
        'name', p.name,
        'is_active', p.is_active,
        'created_at', p.created_at,
        'updated_at', p.updated_at
      )
      ORDER BY p.code
    ),
    '[]'::jsonb
  )
    INTO v_rows
  FROM public.seller_tariff_plans p;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_tariff_plan_upsert(
  p_id uuid,
  p_code text,
  p_name text,
  p_is_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_row public.seller_tariff_plans%ROWTYPE;
  v_code text;
  v_name text;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  v_code := upper(btrim(COALESCE(p_code, '')));
  v_name := btrim(COALESCE(p_name, ''));
  IF v_code NOT IN ('A', 'B') OR v_name = '' THEN
    RAISE EXCEPTION 'Invalid seller tariff plan';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.seller_tariff_plans (code, name, is_active)
    VALUES (v_code, v_name, COALESCE(p_is_active, true))
    ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name,
          is_active = EXCLUDED.is_active,
          updated_at = now()
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.seller_tariff_plans
    SET name = v_name,
        is_active = COALESCE(p_is_active, is_active),
        updated_at = now()
    WHERE id = p_id
      AND code = v_code
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Seller tariff plan not found';
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'id', v_row.id,
    'code', v_row.code,
    'name', v_row.name,
    'is_active', v_row.is_active,
    'actor_id', v_uid
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_tariff_rates_list(p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'Tariff plan is required';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'plan_id', r.plan_id,
        'product_id', r.product_id,
        'amount_kzt', r.amount_kzt,
        'effective_from', r.effective_from,
        'effective_to', r.effective_to
      )
      ORDER BY r.product_id, r.effective_from
    ),
    '[]'::jsonb
  )
    INTO v_rows
  FROM public.seller_tariff_rates r
  WHERE r.plan_id = p_plan_id;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_tariff_rate_set(
  p_plan_id uuid,
  p_product_id uuid,
  p_amount_kzt numeric,
  p_effective_from timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_amount numeric(12,2);
  v_from timestamptz;
  v_open public.seller_tariff_rates%ROWTYPE;
  v_row public.seller_tariff_rates%ROWTYPE;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_plan_id IS NULL OR p_product_id IS NULL OR p_effective_from IS NULL THEN
    RAISE EXCEPTION 'Invalid seller tariff rate payload';
  END IF;
  IF p_amount_kzt IS NULL THEN
    RAISE EXCEPTION 'Tariff rate cannot be NULL';
  END IF;
  v_amount := round(p_amount_kzt, 2);
  IF v_amount < 0 THEN
    RAISE EXCEPTION 'Tariff rate must be >= 0';
  END IF;
  v_from := p_effective_from;
  IF NOT EXISTS (SELECT 1 FROM public.seller_tariff_plans p WHERE p.id = p_plan_id) THEN
    RAISE EXCEPTION 'Seller tariff plan not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = p_product_id) THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  PERFORM pg_advisory_xact_lock(51730303, hashtext(p_plan_id::text || chr(31) || p_product_id::text));

  SELECT * INTO v_open
  FROM public.seller_tariff_rates r
  WHERE r.plan_id = p_plan_id
    AND r.product_id = p_product_id
    AND r.effective_to IS NULL
  FOR UPDATE;
  IF FOUND THEN
    IF v_open.effective_from = v_from THEN
      IF v_open.amount_kzt = v_amount THEN
        RETURN jsonb_build_object(
          'id', v_open.id,
          'plan_id', v_open.plan_id,
          'product_id', v_open.product_id,
          'amount_kzt', v_open.amount_kzt,
          'effective_from', v_open.effective_from,
          'effective_to', v_open.effective_to,
          'actor_id', v_uid
        );
      END IF;
      RAISE EXCEPTION 'Seller tariff rate identity is immutable';
    END IF;
    IF v_open.effective_from > v_from THEN
      RAISE EXCEPTION 'Seller tariff rate periods overlap';
    END IF;
    UPDATE public.seller_tariff_rates
    SET effective_to = v_from
    WHERE id = v_open.id;
  END IF;

  INSERT INTO public.seller_tariff_rates (
    plan_id, product_id, amount_kzt, effective_from
  ) VALUES (
    p_plan_id, p_product_id, v_amount, v_from
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'plan_id', v_row.plan_id,
    'product_id', v_row.product_id,
    'amount_kzt', v_row.amount_kzt,
    'effective_from', v_row.effective_from,
    'effective_to', v_row.effective_to,
    'actor_id', v_uid
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_tariff_assignments_list(p_seller_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  IF p_seller_id IS NULL THEN
    RAISE EXCEPTION 'Seller is required';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'seller_id', a.seller_id,
        'plan_id', a.plan_id,
        'effective_from', a.effective_from,
        'effective_to', a.effective_to
      )
      ORDER BY a.effective_from
    ),
    '[]'::jsonb
  )
    INTO v_rows
  FROM public.seller_tariff_assignments a
  WHERE a.seller_id = p_seller_id;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_tariff_assign(
  p_seller_id uuid,
  p_plan_id uuid,
  p_effective_from timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_from timestamptz;
  v_open public.seller_tariff_assignments%ROWTYPE;
  v_row public.seller_tariff_assignments%ROWTYPE;
  v_role text;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_seller_id IS NULL OR p_plan_id IS NULL OR p_effective_from IS NULL THEN
    RAISE EXCEPTION 'Invalid seller tariff assignment payload';
  END IF;
  v_from := p_effective_from;
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_seller_id;
  IF v_role IS DISTINCT FROM 'seller' THEN
    RAISE EXCEPTION 'Tariff can be assigned only to a seller';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.seller_tariff_plans p WHERE p.id = p_plan_id AND p.is_active) THEN
    RAISE EXCEPTION 'Seller tariff plan not found';
  END IF;

  PERFORM pg_advisory_xact_lock(51730304, hashtext(p_seller_id::text));

  SELECT * INTO v_open
  FROM public.seller_tariff_assignments a
  WHERE a.seller_id = p_seller_id
    AND a.effective_to IS NULL
  FOR UPDATE;
  IF FOUND THEN
    IF v_open.effective_from = v_from THEN
      IF v_open.plan_id = p_plan_id THEN
        RETURN jsonb_build_object(
          'id', v_open.id,
          'seller_id', v_open.seller_id,
          'plan_id', v_open.plan_id,
          'effective_from', v_open.effective_from,
          'effective_to', v_open.effective_to,
          'actor_id', v_uid
        );
      END IF;
      RAISE EXCEPTION 'Seller tariff assignment identity is immutable';
    END IF;
    IF v_open.effective_from > v_from THEN
      RAISE EXCEPTION 'Seller tariff assignment periods overlap';
    END IF;
    UPDATE public.seller_tariff_assignments
    SET effective_to = v_from
    WHERE id = v_open.id;
  END IF;

  INSERT INTO public.seller_tariff_assignments (seller_id, plan_id, effective_from)
  VALUES (p_seller_id, p_plan_id, v_from)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'seller_id', v_row.seller_id,
    'plan_id', v_row.plan_id,
    'effective_from', v_row.effective_from,
    'effective_to', v_row.effective_to,
    'actor_id', v_uid
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_rate_overrides_list(p_seller_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  IF p_seller_id IS NULL THEN
    RAISE EXCEPTION 'Seller is required';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', o.id,
        'seller_id', o.seller_id,
        'product_id', o.product_id,
        'amount_kzt', o.amount_kzt,
        'effective_from', o.effective_from,
        'effective_to', o.effective_to
      )
      ORDER BY o.product_id, o.effective_from
    ),
    '[]'::jsonb
  )
    INTO v_rows
  FROM public.seller_rate_overrides o
  WHERE o.seller_id = p_seller_id;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_rate_override_set(
  p_seller_id uuid,
  p_product_id uuid,
  p_amount_kzt numeric,
  p_effective_from timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_amount numeric(12,2);
  v_from timestamptz;
  v_open public.seller_rate_overrides%ROWTYPE;
  v_row public.seller_rate_overrides%ROWTYPE;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_seller_id IS NULL OR p_product_id IS NULL OR p_effective_from IS NULL THEN
    RAISE EXCEPTION 'Invalid seller rate override payload';
  END IF;
  IF p_amount_kzt IS NULL THEN
    RAISE EXCEPTION 'Tariff rate cannot be NULL';
  END IF;
  v_amount := round(p_amount_kzt, 2);
  IF v_amount < 0 THEN
    RAISE EXCEPTION 'Tariff rate must be >= 0';
  END IF;
  v_from := p_effective_from;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_seller_id AND p.role = 'seller') THEN
    RAISE EXCEPTION 'Seller not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = p_product_id) THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  PERFORM pg_advisory_xact_lock(51730305, hashtext(p_seller_id::text || chr(31) || p_product_id::text));

  SELECT * INTO v_open
  FROM public.seller_rate_overrides o
  WHERE o.seller_id = p_seller_id
    AND o.product_id = p_product_id
    AND o.effective_to IS NULL
  FOR UPDATE;
  IF FOUND THEN
    IF v_open.effective_from = v_from THEN
      IF v_open.amount_kzt = v_amount THEN
        RETURN jsonb_build_object(
          'id', v_open.id,
          'seller_id', v_open.seller_id,
          'product_id', v_open.product_id,
          'amount_kzt', v_open.amount_kzt,
          'effective_from', v_open.effective_from,
          'effective_to', v_open.effective_to,
          'actor_id', v_uid
        );
      END IF;
      RAISE EXCEPTION 'Seller rate override identity is immutable';
    END IF;
    IF v_open.effective_from > v_from THEN
      RAISE EXCEPTION 'Seller rate override periods overlap';
    END IF;
    UPDATE public.seller_rate_overrides
    SET effective_to = v_from
    WHERE id = v_open.id;
  END IF;

  INSERT INTO public.seller_rate_overrides (
    seller_id, product_id, amount_kzt, effective_from
  ) VALUES (
    p_seller_id, p_product_id, v_amount, v_from
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'seller_id', v_row.seller_id,
    'product_id', v_row.product_id,
    'amount_kzt', v_row.amount_kzt,
    'effective_from', v_row.effective_from,
    'effective_to', v_row.effective_to,
    'actor_id', v_uid
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_balance(p_seller_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  IF p_seller_id IS NULL THEN
    RAISE EXCEPTION 'Seller is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_seller_id) THEN
    RAISE EXCEPTION 'Seller not found';
  END IF;
  RETURN jsonb_build_object(
    'seller_id', p_seller_id,
    'balance', public.seller_ledger_balance(p_seller_id),
    'actor_id', v_uid
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_ledger_list(
  p_seller_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_staff();
  IF p_seller_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Seller ledger period is required';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'Seller ledger period is invalid';
  END IF;
  SELECT COALESCE(
    jsonb_agg(public.seller_ledger_to_json(l) ORDER BY l.accrued_at DESC, l.created_at DESC),
    '[]'::jsonb
  )
    INTO v_rows
  FROM public.seller_ledger l
  WHERE l.seller_id = p_seller_id
    AND l.accrued_at >= p_from
    AND l.accrued_at <= p_to;
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_my_balance()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := public.seller_commission_require_active_self();
  RETURN jsonb_build_object(
    'seller_id', v_uid,
    'balance', public.seller_ledger_balance(v_uid)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_my_ledger(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  v_uid := public.seller_commission_require_active_self();
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Seller ledger period is required';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'Seller ledger period is invalid';
  END IF;
  SELECT COALESCE(
    jsonb_agg(public.seller_ledger_to_json(l) ORDER BY l.accrued_at DESC, l.created_at DESC),
    '[]'::jsonb
  )
    INTO v_rows
  FROM public.seller_ledger l
  WHERE l.seller_id = v_uid
    AND l.accrued_at >= p_from
    AND l.accrued_at <= p_to;
  RETURN jsonb_build_object('items', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_cash_post(
  p_operation_id uuid,
  p_seller_id uuid,
  p_amount numeric,
  p_comment text,
  p_entry_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_amount numeric(12,2);
  v_signed numeric(12,2);
  v_comment text;
  v_existing public.seller_ledger%ROWTYPE;
  v_row public.seller_ledger%ROWTYPE;
  v_balance numeric(12,2);
  v_role text;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_operation_id IS NULL OR p_seller_id IS NULL OR p_entry_type IS NULL THEN
    RAISE EXCEPTION 'Invalid seller cash payload';
  END IF;
  IF p_entry_type IS DISTINCT FROM 'cash_payout' AND p_entry_type IS DISTINCT FROM 'cash_advance' THEN
    RAISE EXCEPTION 'Invalid seller cash payload';
  END IF;
  v_amount := round(COALESCE(p_amount, 0), 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than 0';
  END IF;
  v_signed := -v_amount;
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_seller_id;
  IF v_role IS DISTINCT FROM 'seller' THEN
    RAISE EXCEPTION 'Seller not found';
  END IF;

  PERFORM pg_advisory_xact_lock(51730311, hashtext(p_operation_id::text));
  PERFORM pg_advisory_xact_lock(51730312, hashtext(p_seller_id::text));

  SELECT * INTO v_existing
  FROM public.seller_ledger
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.seller_id IS DISTINCT FROM p_seller_id
       OR v_existing.entry_type IS DISTINCT FROM p_entry_type
       OR v_existing.amount IS DISTINCT FROM v_signed
       OR v_existing.actor_id IS DISTINCT FROM v_uid
       OR v_existing.comment IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN public.seller_ledger_to_json(v_existing);
  END IF;

  v_balance := public.seller_ledger_balance(p_seller_id);
  IF p_entry_type = 'cash_payout' AND v_balance < v_amount THEN
    RAISE EXCEPTION 'Payout exceeds available balance';
  END IF;

  v_row := public.seller_ledger_post_internal(
    p_operation_id,
    p_seller_id,
    p_entry_type,
    v_signed,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, NULL, now(), v_uid, v_comment
  );
  RETURN public.seller_ledger_to_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_cash_payout(
  p_operation_id uuid,
  p_seller_id uuid,
  p_amount numeric,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  RETURN public.admin_seller_cash_post(p_operation_id, p_seller_id, p_amount, p_comment, 'cash_payout');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_cash_advance(
  p_operation_id uuid,
  p_seller_id uuid,
  p_amount numeric,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  RETURN public.admin_seller_cash_post(p_operation_id, p_seller_id, p_amount, p_comment, 'cash_advance');
END;
$$;

REVOKE ALL ON FUNCTION public.seller_periods_overlap(timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_tariff_rates_protect() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_tariff_assignments_protect() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_rate_overrides_protect() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_ledger_protect() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_goods_issues_protect() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_goods_issue_items_protect() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_require_active_admin() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_require_active_staff() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_commission_require_active_self() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_resolve_unit_rate(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_ledger_balance(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_ledger_to_json(public.seller_ledger) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_ledger_post_internal(uuid, uuid, text, numeric, uuid, uuid, uuid, numeric, numeric, uuid, boolean, uuid, uuid, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seller_ledger_post_accrual_internal(uuid, uuid, uuid, uuid, uuid, numeric, timestamptz, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_cash_post(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_seller_tariff_plans_list() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_tariff_plan_upsert(uuid, text, text, boolean) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_tariff_rates_list(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_tariff_rate_set(uuid, uuid, numeric, timestamptz) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_tariff_assignments_list(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_tariff_assign(uuid, uuid, timestamptz) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_rate_overrides_list(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_rate_override_set(uuid, uuid, numeric, timestamptz) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_balance(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_ledger_list(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.seller_my_balance() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.seller_my_ledger(timestamptz, timestamptz) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_cash_payout(uuid, uuid, numeric, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_cash_advance(uuid, uuid, numeric, text) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.admin_seller_tariff_plans_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_tariff_plan_upsert(uuid, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_tariff_rates_list(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_tariff_rate_set(uuid, uuid, numeric, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_tariff_assignments_list(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_tariff_assign(uuid, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_rate_overrides_list(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_rate_override_set(uuid, uuid, numeric, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_balance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_ledger_list(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seller_my_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.seller_my_ledger(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_cash_payout(uuid, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_cash_advance(uuid, uuid, numeric, text) TO authenticated;

COMMIT;
