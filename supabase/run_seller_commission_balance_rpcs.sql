-- 5.17.5B seller cash balances RPCs (no new tables).
-- accrued_at = business operation time; created_at = registration time (table default).
-- Does not rewrite confirm_order, finance_expenses, inventory, or accrual hooks.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE OR REPLACE FUNCTION public.seller_ledger_breakdown(p_seller_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT jsonb_build_object(
    'seller_id', p_seller_id,
    'accrued', COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'accrual'), 0)::numeric(12,2),
    'reversed', COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'reversal'), 0)::numeric(12,2),
    'paid', COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'cash_payout'), 0)::numeric(12,2),
    'advances', COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'cash_advance'), 0)::numeric(12,2),
    'goods', COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type IN ('goods_issue', 'goods_reversal')), 0)::numeric(12,2),
    'adjustments', COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment'), 0)::numeric(12,2),
    'balance', COALESCE(SUM(l.amount), 0)::numeric(12,2)
  )
  FROM public.seller_ledger l
  WHERE l.seller_id = p_seller_id;
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
  RETURN public.seller_ledger_breakdown(p_seller_id) || jsonb_build_object('actor_id', v_uid);
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
  RETURN public.seller_ledger_breakdown(v_uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_balances_list()
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
      public.seller_ledger_breakdown(p.id)
        || jsonb_build_object(
          'display_name', p.display_name,
          'is_active', COALESCE(p.is_active, true)
        )
      ORDER BY p.display_name, p.id
    ),
    '[]'::jsonb
  )
    INTO v_rows
  FROM public.profiles p
  WHERE p.role = 'seller';
  RETURN jsonb_build_object('items', v_rows, 'actor_id', v_uid);
END;
$$;

DROP FUNCTION IF EXISTS public.admin_seller_cash_payout(uuid, uuid, numeric, text);
DROP FUNCTION IF EXISTS public.admin_seller_cash_advance(uuid, uuid, numeric, text);
DROP FUNCTION IF EXISTS public.admin_seller_cash_post(uuid, uuid, numeric, text, text);

CREATE OR REPLACE FUNCTION public.admin_seller_cash_post(
  p_operation_id uuid,
  p_seller_id uuid,
  p_amount numeric,
  p_comment text,
  p_entry_type text,
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
  v_amount numeric(12,2);
  v_signed numeric(12,2);
  v_comment text;
  v_existing public.seller_ledger%ROWTYPE;
  v_row public.seller_ledger%ROWTYPE;
  v_balance numeric(12,2);
  v_role text;
  v_at timestamptz;
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

  IF p_accrued_at IS NOT NULL AND p_accrued_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Operation date cannot be in the future';
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
    IF p_accrued_at IS NOT NULL AND v_existing.accrued_at IS DISTINCT FROM p_accrued_at THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN public.seller_ledger_to_json(v_existing);
  END IF;

  v_at := COALESCE(p_accrued_at, clock_timestamp());
  IF v_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Operation date cannot be in the future';
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
    false, NULL, NULL, v_at, v_uid, v_comment
  );
  RETURN public.seller_ledger_to_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_cash_payout(
  p_operation_id uuid,
  p_seller_id uuid,
  p_amount numeric,
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
  RETURN public.admin_seller_cash_post(
    p_operation_id, p_seller_id, p_amount, p_comment, 'cash_payout', p_accrued_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_seller_cash_advance(
  p_operation_id uuid,
  p_seller_id uuid,
  p_amount numeric,
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
  RETURN public.admin_seller_cash_post(
    p_operation_id, p_seller_id, p_amount, p_comment, 'cash_advance', p_accrued_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.seller_ledger_breakdown(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_cash_post(uuid, uuid, numeric, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_balance(uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.seller_my_balance()
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_balances_list()
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_cash_payout(uuid, uuid, numeric, text, timestamptz)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_seller_cash_advance(uuid, uuid, numeric, text, timestamptz)
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.admin_seller_balance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seller_my_balance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_balances_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_cash_payout(uuid, uuid, numeric, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seller_cash_advance(uuid, uuid, numeric, text, timestamptz) TO authenticated;

COMMIT;
