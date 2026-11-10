-- 5.19.6B phase 1. Additive only: claim/check/assert.
-- Does not wrap RPCs, revoke table writes, or install write triggers.
-- Does not DELETE auth.sessions / auth.refresh_tokens.
-- Do not apply to Production without a later explicit stage.

BEGIN;

ALTER TABLE public.user_active_sessions
  ADD COLUMN IF NOT EXISTS auth_session_id uuid;

CREATE OR REPLACE FUNCTION public.auth_session_read_jwt_sid()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_raw text;
  v_sid uuid;
BEGIN
  v_raw := nullif(current_setting('request.jwt.claim.session_id', true), '');
  IF v_raw IS NULL THEN
    BEGIN
      v_raw := nullif(auth.jwt()->>'session_id', '');
    EXCEPTION WHEN undefined_function THEN
      v_raw := NULL;
    WHEN others THEN
      RAISE EXCEPTION 'Active session required';
    END;
  END IF;
  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_sid := v_raw::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Active session required';
  END;
  RETURN v_sid;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_session_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  BEGIN
    v_role := auth.role();
  EXCEPTION WHEN undefined_function THEN
    v_role := NULL;
  END;
  IF v_role IS NULL OR v_role = '' THEN
    v_role := nullif(current_setting('request.jwt.claim.role', true), '');
  END IF;
  IF v_role IS NULL OR v_role = '' THEN
    v_role := current_user;
  END IF;
  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_active_auth_session()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_sid uuid;
  v_stored uuid;
  v_live_user uuid;
  v_not_after timestamptz;
BEGIN
  IF public.auth_session_role() = 'service_role' THEN
    RETURN 'allowed';
  END IF;

  BEGIN
    v_uid := auth.uid();
  EXCEPTION WHEN others THEN
    RETURN 'unknown';
  END;
  IF v_uid IS NULL THEN
    RETURN 'denied';
  END IF;

  BEGIN
    v_sid := public.auth_session_read_jwt_sid();
  EXCEPTION WHEN others THEN
    RETURN 'unknown';
  END;
  IF v_sid IS NULL THEN
    RETURN 'unknown';
  END IF;

  BEGIN
    SELECT s.user_id, s.not_after
      INTO v_live_user, v_not_after
    FROM auth.sessions s
    WHERE s.id = v_sid;
  EXCEPTION WHEN undefined_table THEN
    RETURN 'unknown';
  WHEN others THEN
    RETURN 'unknown';
  END;
  IF v_live_user IS NULL THEN
    RETURN 'denied';
  END IF;
  IF v_live_user IS DISTINCT FROM v_uid THEN
    RETURN 'denied';
  END IF;
  IF v_not_after IS NOT NULL AND v_not_after <= clock_timestamp() THEN
    RETURN 'denied';
  END IF;

  SELECT u.auth_session_id INTO v_stored
  FROM public.user_active_sessions u
  WHERE u.user_id = v_uid;

  IF v_stored IS NULL THEN
    RETURN 'unknown';
  END IF;
  IF v_stored IS DISTINCT FROM v_sid THEN
    RETURN 'denied';
  END IF;
  RETURN 'allowed';
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_active_auth_session()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_sid uuid;
  v_stored uuid;
  v_live_user uuid;
  v_live_created timestamptz;
  v_live_not_after timestamptz;
  v_stored_user uuid;
  v_stored_created timestamptz;
  v_stored_not_after timestamptz;
BEGIN
  IF public.auth_session_role() = 'service_role' THEN
    RETURN 'allowed';
  END IF;

  BEGIN
    v_uid := auth.uid();
  EXCEPTION WHEN others THEN
    RETURN 'unknown';
  END;
  IF v_uid IS NULL THEN
    RETURN 'denied';
  END IF;

  BEGIN
    v_sid := public.auth_session_read_jwt_sid();
  EXCEPTION WHEN others THEN
    RETURN 'unknown';
  END;
  IF v_sid IS NULL THEN
    RETURN 'unknown';
  END IF;

  BEGIN
    SELECT s.user_id, s.created_at, s.not_after
      INTO v_live_user, v_live_created, v_live_not_after
    FROM auth.sessions s
    WHERE s.id = v_sid;
  EXCEPTION WHEN undefined_table THEN
    RETURN 'unknown';
  WHEN others THEN
    RETURN 'unknown';
  END;
  IF v_live_user IS NULL OR v_live_user IS DISTINCT FROM v_uid THEN
    RETURN 'denied';
  END IF;
  IF v_live_not_after IS NOT NULL AND v_live_not_after <= clock_timestamp() THEN
    RETURN 'denied';
  END IF;
  IF v_live_created IS NULL THEN
    RETURN 'denied';
  END IF;

  INSERT INTO public.user_active_sessions (user_id, device_id, auth_session_id, last_seen_at, updated_at)
  VALUES (v_uid, 'auth-session', NULL, now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET last_seen_at = now();

  SELECT u.auth_session_id INTO v_stored
  FROM public.user_active_sessions u
  WHERE u.user_id = v_uid
  FOR UPDATE;

  IF v_stored IS NOT NULL AND v_stored IS DISTINCT FROM v_sid THEN
    v_stored_user := NULL;
    BEGIN
      SELECT s.user_id, s.created_at, s.not_after
        INTO v_stored_user, v_stored_created, v_stored_not_after
      FROM auth.sessions s
      WHERE s.id = v_stored;
    EXCEPTION WHEN others THEN
      RETURN 'unknown';
    END;
    IF v_stored_user IS NOT NULL
       AND v_stored_user = v_uid
       AND (v_stored_not_after IS NULL OR v_stored_not_after > clock_timestamp()) THEN
      IF v_stored_created IS NULL OR v_live_created <= v_stored_created THEN
        RETURN 'denied';
      END IF;
    END IF;
  END IF;

  UPDATE public.user_active_sessions
  SET auth_session_id = v_sid,
      last_seen_at = now(),
      updated_at = now()
  WHERE user_id = v_uid;

  RETURN 'allowed';
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_active_auth_session()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_uid uuid;
BEGIN
  v_status := public.check_active_auth_session();
  IF v_status IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'Active session required';
  END IF;
  v_uid := auth.uid();
  RETURN v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_session_read_jwt_sid() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_session_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_active_auth_session() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_active_auth_session() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.check_active_auth_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_active_auth_session() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_active_auth_session() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_active_auth_session() TO postgres, service_role;

COMMIT;