-- Local stubs for 5.19.6A. Not for production.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    current_user
  );
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
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

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO postgres, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  not_after timestamptz
);

CREATE TABLE IF NOT EXISTS public.user_active_sessions (
  user_id uuid PRIMARY KEY,
  device_id text NOT NULL,
  last_seen_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.user_active_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_active_sessions_select_own" ON public.user_active_sessions;
CREATE POLICY "user_active_sessions_select_own"
  ON public.user_active_sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_active_sessions_insert_own" ON public.user_active_sessions;
CREATE POLICY "user_active_sessions_insert_own"
  ON public.user_active_sessions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_active_sessions_update_own" ON public.user_active_sessions;
CREATE POLICY "user_active_sessions_update_own"
  ON public.user_active_sessions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_active_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.sessions TO postgres;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  display_name text,
  role text NOT NULL,
  is_active boolean DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'P'
);
CREATE TABLE IF NOT EXISTS public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
GRANT SELECT ON TABLE public.user_active_sessions TO authenticated;

INSERT INTO public.profiles (id, display_name, role, is_active) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Admin', 'admin', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Seller', 'seller', true),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Manager', 'manager', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id, created_at, not_after) VALUES
  ('aaaaaaaa-0001-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-01-01', NULL),
  ('aaaaaaaa-0002-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-11-10', NULL),
  ('bbbbbbbb-0001-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-01-01', NULL),
  ('cccccccc-0001-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-01-01', NULL)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.session_probe_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note text
);
GRANT INSERT ON TABLE public.session_probe_orders TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.session_probe_orders(note) VALUES (payload->>'note') RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_order(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_seller_accrual_retry_item(p_order_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object('ok', true, 'id', p_order_item_id);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_seller_accrual_retry_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_seller_accrual_retry_item(uuid) TO authenticated;
