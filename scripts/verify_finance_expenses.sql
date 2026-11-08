-- Local PostgreSQL security harness for 5.5.1. Not for production.
-- Generated from stubs + migration + asserts. Do not apply on production.

-- Local PostgreSQL security harness for 5.5.1. Not for production.

BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  display_name text,
  role text NOT NULL,
  is_active boolean DEFAULT true
);

INSERT INTO public.cities (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Atyrau')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, display_name, role, is_active) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Admin', 'admin', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Seller', 'seller', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Manager', 'manager', true),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Inactive', 'admin', false)
ON CONFLICT (id) DO NOTHING;

-- 5.5.1 finance_expenses journal (admin-only, idempotent, soft-delete + audit).
-- Does not rewrite confirm_order, inventory, cost_price, payouts, or P&L allocation.
-- Do not apply until explicitly allowed.


CREATE TABLE IF NOT EXISTS public.finance_expense_categories (
  code text PRIMARY KEY,
  sort_order integer NOT NULL DEFAULT 100
);

INSERT INTO public.finance_expense_categories (code, sort_order) VALUES
  ('logistics', 10),
  ('cargo_customs', 20),
  ('ads', 30),
  ('rent', 40),
  ('tax', 50),
  ('salary', 60),
  ('seller_payout', 70),
  ('bonus', 80),
  ('other', 90)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL,
  category text NOT NULL REFERENCES public.finance_expense_categories(code),
  amount numeric(12,2) NOT NULL,
  city_id uuid REFERENCES public.cities(id) ON DELETE RESTRICT,
  comment text,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  operation_id uuid NOT NULL,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  CONSTRAINT finance_expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT finance_expenses_operation_id_key UNIQUE (operation_id)
);

CREATE INDEX IF NOT EXISTS finance_expenses_date_idx
  ON public.finance_expenses (expense_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS finance_expenses_city_idx
  ON public.finance_expenses (city_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS finance_expenses_alive_date_idx
  ON public.finance_expenses (expense_date DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.finance_expense_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES public.finance_expenses(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text])),
  actor_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  before_row jsonb,
  after_row jsonb
);

CREATE INDEX IF NOT EXISTS finance_expense_events_expense_idx
  ON public.finance_expense_events (expense_id, created_at);

ALTER TABLE public.finance_expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_expense_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.finance_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_expenses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.finance_expense_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_expense_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.finance_expense_categories FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.finance_expenses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.finance_expense_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.finance_expense_categories TO service_role;
GRANT ALL ON TABLE public.finance_expenses TO service_role;
REVOKE ALL ON TABLE public.finance_expense_events FROM service_role;
GRANT SELECT, INSERT ON TABLE public.finance_expense_events TO service_role;

CREATE OR REPLACE FUNCTION public.is_active_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
      AND COALESCE(p.is_active, true)
  );
$$;

REVOKE ALL ON FUNCTION public.is_active_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO authenticated, service_role;

DROP POLICY IF EXISTS finance_expense_categories_admin_select ON public.finance_expense_categories;
CREATE POLICY finance_expense_categories_admin_select ON public.finance_expense_categories
  FOR SELECT TO authenticated
  USING (public.is_active_admin());

DROP POLICY IF EXISTS finance_expenses_admin_select ON public.finance_expenses;
CREATE POLICY finance_expenses_admin_select ON public.finance_expenses
  FOR SELECT TO authenticated
  USING (public.is_active_admin());

DROP POLICY IF EXISTS finance_expenses_admin_insert ON public.finance_expenses;
CREATE POLICY finance_expenses_admin_insert ON public.finance_expenses
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_admin() AND created_by = auth.uid());

DROP POLICY IF EXISTS finance_expenses_admin_update ON public.finance_expenses;
CREATE POLICY finance_expenses_admin_update ON public.finance_expenses
  FOR UPDATE TO authenticated
  USING (public.is_active_admin())
  WITH CHECK (public.is_active_admin());

DROP POLICY IF EXISTS finance_expenses_admin_delete ON public.finance_expenses;
CREATE POLICY finance_expenses_admin_delete ON public.finance_expenses
  FOR DELETE TO authenticated
  USING (false);

DROP POLICY IF EXISTS finance_expense_categories_deny_insert ON public.finance_expense_categories;
CREATE POLICY finance_expense_categories_deny_insert ON public.finance_expense_categories
  FOR INSERT TO authenticated
  WITH CHECK (false);
DROP POLICY IF EXISTS finance_expense_categories_deny_update ON public.finance_expense_categories;
CREATE POLICY finance_expense_categories_deny_update ON public.finance_expense_categories
  FOR UPDATE TO authenticated
  USING (false);
DROP POLICY IF EXISTS finance_expense_categories_deny_delete ON public.finance_expense_categories;
CREATE POLICY finance_expense_categories_deny_delete ON public.finance_expense_categories
  FOR DELETE TO authenticated
  USING (false);

DROP POLICY IF EXISTS finance_expense_events_admin_select ON public.finance_expense_events;
CREATE POLICY finance_expense_events_admin_select ON public.finance_expense_events
  FOR SELECT TO authenticated
  USING (public.is_active_admin());
DROP POLICY IF EXISTS finance_expense_events_deny_insert ON public.finance_expense_events;
CREATE POLICY finance_expense_events_deny_insert ON public.finance_expense_events
  FOR INSERT TO authenticated
  WITH CHECK (false);
DROP POLICY IF EXISTS finance_expense_events_deny_update ON public.finance_expense_events;
CREATE POLICY finance_expense_events_deny_update ON public.finance_expense_events
  FOR UPDATE TO authenticated
  USING (false);
DROP POLICY IF EXISTS finance_expense_events_deny_delete ON public.finance_expense_events;
CREATE POLICY finance_expense_events_deny_delete ON public.finance_expense_events
  FOR DELETE TO authenticated
  USING (false);

CREATE OR REPLACE FUNCTION public.finance_expense_to_json(p_row public.finance_expenses)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT jsonb_build_object(
    'id', p_row.id,
    'expense_date', p_row.expense_date,
    'category', p_row.category,
    'amount', p_row.amount,
    'city_id', p_row.city_id,
    'comment', p_row.comment,
    'created_by', p_row.created_by,
    'created_at', p_row.created_at,
    'updated_at', p_row.updated_at,
    'operation_id', p_row.operation_id,
    'deleted_at', p_row.deleted_at,
    'deleted_by', p_row.deleted_by
  );
$$;

REVOKE ALL ON FUNCTION public.finance_expense_to_json(public.finance_expenses) FROM PUBLIC, anon, authenticated, service_role;

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

REVOKE ALL ON FUNCTION public.finance_require_active_admin() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finance_expenses_protect_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Finance expenses cannot be hard-deleted';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Finance expense is deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
    RAISE EXCEPTION 'Finance expense identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS finance_expenses_protect_identity_trg ON public.finance_expenses;
CREATE TRIGGER finance_expenses_protect_identity_trg
  BEFORE UPDATE OR DELETE ON public.finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.finance_expenses_protect_identity();

CREATE OR REPLACE FUNCTION public.finance_expense_events_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  RAISE EXCEPTION 'Finance expense events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS finance_expense_events_protect_trg ON public.finance_expense_events;
CREATE TRIGGER finance_expense_events_protect_trg
  BEFORE UPDATE OR DELETE ON public.finance_expense_events
  FOR EACH ROW
  EXECUTE FUNCTION public.finance_expense_events_protect();

REVOKE ALL ON FUNCTION public.finance_expenses_protect_identity() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finance_expense_events_protect() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_finance_expense_create(
  p_operation_id uuid,
  p_expense_date date,
  p_category text,
  p_amount numeric,
  p_city_id uuid DEFAULT NULL,
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
  v_existing public.finance_expenses%ROWTYPE;
  v_row public.finance_expenses%ROWTYPE;
  v_comment text;
  v_amount numeric(12,2);
BEGIN
  v_uid := public.finance_require_active_admin();
  IF p_operation_id IS NULL OR p_expense_date IS NULL OR p_category IS NULL THEN
    RAISE EXCEPTION 'Invalid finance expense payload';
  END IF;
  v_amount := round(COALESCE(p_amount, 0), 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than 0';
  END IF;
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expense_categories c WHERE c.code = p_category
  ) THEN
    RAISE EXCEPTION 'Unknown finance expense category';
  END IF;
  IF p_city_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cities c WHERE c.id = p_city_id
  ) THEN
    RAISE EXCEPTION 'City not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('finance_expense'), hashtext(p_operation_id::text));

  SELECT * INTO v_existing
  FROM public.finance_expenses
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.created_by IS DISTINCT FROM v_uid
       OR v_existing.expense_date IS DISTINCT FROM p_expense_date
       OR v_existing.category IS DISTINCT FROM p_category
       OR v_existing.amount IS DISTINCT FROM v_amount
       OR v_existing.city_id IS DISTINCT FROM p_city_id
       OR v_existing.comment IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN public.finance_expense_to_json(v_existing);
  END IF;

  BEGIN
    INSERT INTO public.finance_expenses (
      expense_date, category, amount, city_id, comment, created_by, operation_id
    ) VALUES (
      p_expense_date, p_category, v_amount, p_city_id, v_comment, v_uid, p_operation_id
    )
    RETURNING * INTO v_row;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_existing
      FROM public.finance_expenses
      WHERE operation_id = p_operation_id;
      IF NOT FOUND
         OR v_existing.created_by IS DISTINCT FROM v_uid
         OR v_existing.expense_date IS DISTINCT FROM p_expense_date
         OR v_existing.category IS DISTINCT FROM p_category
         OR v_existing.amount IS DISTINCT FROM v_amount
         OR v_existing.city_id IS DISTINCT FROM p_city_id
         OR v_existing.comment IS DISTINCT FROM v_comment THEN
        RAISE EXCEPTION 'Idempotency key reused with a different payload';
      END IF;
      RETURN public.finance_expense_to_json(v_existing);
  END;

  INSERT INTO public.finance_expense_events (expense_id, action, actor_id, before_row, after_row)
  VALUES (v_row.id, 'create', v_uid, NULL, public.finance_expense_to_json(v_row));

  RETURN public.finance_expense_to_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_finance_expenses_list(
  p_from date,
  p_to date,
  p_city_id uuid DEFAULT NULL,
  p_include_deleted boolean DEFAULT false
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
  v_uid := public.finance_require_active_admin();
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Finance period is required';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'Finance period is invalid';
  END IF;

  SELECT COALESCE(jsonb_agg(public.finance_expense_to_json(e) ORDER BY e.expense_date DESC, e.created_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM public.finance_expenses e
  WHERE e.expense_date >= p_from
    AND e.expense_date <= p_to
    AND (p_city_id IS NULL OR e.city_id = p_city_id)
    AND (COALESCE(p_include_deleted, false) OR e.deleted_at IS NULL);

  RETURN jsonb_build_object('items', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_finance_expense_update(
  p_id uuid,
  p_expense_date date,
  p_category text,
  p_amount numeric,
  p_city_id uuid DEFAULT NULL,
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
  v_before public.finance_expenses%ROWTYPE;
  v_row public.finance_expenses%ROWTYPE;
  v_comment text;
  v_amount numeric(12,2);
BEGIN
  v_uid := public.finance_require_active_admin();
  IF p_id IS NULL OR p_expense_date IS NULL OR p_category IS NULL THEN
    RAISE EXCEPTION 'Invalid finance expense payload';
  END IF;
  v_amount := round(COALESCE(p_amount, 0), 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than 0';
  END IF;
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expense_categories c WHERE c.code = p_category
  ) THEN
    RAISE EXCEPTION 'Unknown finance expense category';
  END IF;
  IF p_city_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cities c WHERE c.id = p_city_id
  ) THEN
    RAISE EXCEPTION 'City not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('finance_expense_row'), hashtext(p_id::text));

  SELECT * INTO v_before
  FROM public.finance_expenses
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finance expense not found';
  END IF;
  IF v_before.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Finance expense is deleted';
  END IF;

  UPDATE public.finance_expenses
  SET expense_date = p_expense_date,
      category = p_category,
      amount = v_amount,
      city_id = p_city_id,
      comment = v_comment,
      updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_row;

  INSERT INTO public.finance_expense_events (expense_id, action, actor_id, before_row, after_row)
  VALUES (v_row.id, 'update', v_uid, public.finance_expense_to_json(v_before), public.finance_expense_to_json(v_row));

  RETURN public.finance_expense_to_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_finance_expense_delete(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_before public.finance_expenses%ROWTYPE;
  v_row public.finance_expenses%ROWTYPE;
BEGIN
  v_uid := public.finance_require_active_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Invalid finance expense payload';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('finance_expense_row'), hashtext(p_id::text));

  SELECT * INTO v_before
  FROM public.finance_expenses
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finance expense not found';
  END IF;
  IF v_before.deleted_at IS NOT NULL THEN
    RETURN public.finance_expense_to_json(v_before);
  END IF;

  UPDATE public.finance_expenses
  SET deleted_at = now(),
      deleted_by = v_uid,
      updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_row;

  INSERT INTO public.finance_expense_events (expense_id, action, actor_id, before_row, after_row)
  VALUES (v_row.id, 'delete', v_uid, public.finance_expense_to_json(v_before), public.finance_expense_to_json(v_row));

  RETURN public.finance_expense_to_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_finance_expense_events(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_items jsonb;
BEGIN
  v_uid := public.finance_require_active_admin();
  IF p_expense_id IS NULL THEN
    RAISE EXCEPTION 'Invalid finance expense payload';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_expenses e WHERE e.id = p_expense_id) THEN
    RAISE EXCEPTION 'Finance expense not found';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', ev.id,
        'expense_id', ev.expense_id,
        'action', ev.action,
        'actor_id', ev.actor_id,
        'created_at', ev.created_at,
        'before_row', ev.before_row,
        'after_row', ev.after_row
      )
      ORDER BY ev.created_at, ev.id
    ),
    '[]'::jsonb
  )
    INTO v_items
  FROM public.finance_expense_events ev
  WHERE ev.expense_id = p_expense_id;

  RETURN jsonb_build_object('items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_finance_expense_create(uuid, date, text, numeric, uuid, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_finance_expenses_list(date, date, uuid, boolean) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_finance_expense_update(uuid, date, text, numeric, uuid, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_finance_expense_delete(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.admin_finance_expense_events(uuid) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.admin_finance_expense_create(uuid, date, text, numeric, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finance_expenses_list(date, date, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finance_expense_update(uuid, date, text, numeric, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finance_expense_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finance_expense_events(uuid) TO authenticated;


DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.finance_expenses', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT finance_expenses';
  END IF;
  IF has_table_privilege('authenticated', 'public.finance_expenses', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT finance_expenses';
  END IF;
  IF has_table_privilege('anon', 'public.finance_expenses', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not SELECT finance_expenses';
  END IF;
  IF has_table_privilege('authenticated', 'public.finance_expense_events', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not SELECT finance_expense_events';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.admin_finance_expense_create(uuid, date, text, numeric, uuid, text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must EXECUTE create RPC';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.finance_require_active_admin()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not EXECUTE finance_require_active_admin';
  END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.admin_finance_expense_create(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeee0001',
    DATE '2026-11-08',
    'logistics',
    35000,
    '11111111-1111-4111-8111-111111111111',
    'seller'
  );
  RAISE EXCEPTION 'seller must not create finance expense';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%Finance permission denied%' THEN
      RAISE;
    END IF;
END $$;
DO $$
BEGIN
  PERFORM * FROM public.finance_expenses;
  RAISE EXCEPTION 'seller direct SELECT must fail';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.admin_finance_expenses_list(DATE '2026-11-01', DATE '2026-11-30', NULL, false);
  RAISE EXCEPTION 'manager must not list finance expenses';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%Finance permission denied%' THEN
      RAISE;
    END IF;
END $$;
DO $$
BEGIN
  PERFORM public.admin_finance_expense_update(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeee0001',
    DATE '2026-11-08',
    'ads',
    1000,
    NULL,
    'x'
  );
  RAISE EXCEPTION 'manager must not update finance expense';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%Finance permission denied%' THEN
      RAISE;
    END IF;
END $$;
DO $$
BEGIN
  PERFORM public.admin_finance_expense_delete('eeeeeeee-eeee-4eee-8eee-eeeeeeee0001');
  RAISE EXCEPTION 'manager must not delete finance expense';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%Finance permission denied%' THEN
      RAISE;
    END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true);
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.admin_finance_expense_create(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeee0002',
    DATE '2026-11-08',
    'tax',
    1,
    NULL,
    NULL
  );
  RAISE EXCEPTION 'inactive admin must not create finance expense';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%Account is inactive%' THEN
      RAISE;
    END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SET ROLE authenticated;

DO $$
DECLARE
  v1 jsonb;
  v2 jsonb;
BEGIN
  v1 := public.admin_finance_expense_create(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeee0003',
    DATE '2026-11-08',
    'logistics',
    35000,
    '11111111-1111-4111-8111-111111111111',
    'Доставка партии'
  );
  v2 := public.admin_finance_expense_create(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeee0003',
    DATE '2026-11-08',
    'logistics',
    35000,
    '11111111-1111-4111-8111-111111111111',
    'Доставка партии'
  );
  IF v1->>'id' IS DISTINCT FROM v2->>'id' THEN
    RAISE EXCEPTION 'idempotent create must return the same row';
  END IF;
  IF (v1->>'created_by') IS DISTINCT FROM 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'created_by must be auth.uid';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM public.admin_finance_expense_create(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeee0003',
    DATE '2026-11-08',
    'ads',
    35000,
    '11111111-1111-4111-8111-111111111111',
    'Доставка партии'
  );
  RAISE EXCEPTION 'conflicting operation_id must fail';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%Idempotency key reused with a different payload%' THEN
      RAISE;
    END IF;
END $$;

DO $$
DECLARE
  v_id uuid;
  v_upd jsonb;
  v_del jsonb;
  v_list jsonb;
  v_events jsonb;
BEGIN
  SELECT (public.admin_finance_expense_create(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeee0004',
    DATE '2026-11-08',
    'other',
    100,
    NULL,
    'general'
  )->>'id')::uuid INTO v_id;

  v_upd := public.admin_finance_expense_update(
    v_id,
    DATE '2026-11-09',
    'rent',
    200,
    NULL,
    'updated'
  );
  IF v_upd->>'operation_id' IS DISTINCT FROM 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0004' THEN
    RAISE EXCEPTION 'update must not change operation_id';
  END IF;
  IF (v_upd->>'amount')::numeric IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'update amount';
  END IF;

  v_list := public.admin_finance_expenses_list(DATE '2026-11-01', DATE '2026-11-30', NULL, false);
  IF jsonb_array_length(v_list->'items') < 1 THEN
    RAISE EXCEPTION 'list must return live rows';
  END IF;

  v_del := public.admin_finance_expense_delete(v_id);
  IF v_del->>'deleted_at' IS NULL THEN
    RAISE EXCEPTION 'soft delete must set deleted_at';
  END IF;

  v_list := public.admin_finance_expenses_list(DATE '2026-11-01', DATE '2026-11-30', NULL, false);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_list->'items') x WHERE x->>'id' = v_id::text
  ) THEN
    RAISE EXCEPTION 'live list must hide soft-deleted rows';
  END IF;

  v_events := public.admin_finance_expense_events(v_id);
  IF jsonb_array_length(v_events->'items') < 3 THEN
    RAISE EXCEPTION 'audit must keep create/update/delete';
  END IF;
END $$;

RESET ROLE;

DO $$
BEGIN
  UPDATE public.finance_expense_events SET action = 'update';
  RAISE EXCEPTION 'events must be immutable';
EXCEPTION
  WHEN others THEN
    IF SQLERRM NOT LIKE '%Finance expense events are immutable%' THEN
      RAISE;
    END IF;
END;
$$;

SELECT 'finance expenses security harness ok' AS status;

ROLLBACK;
