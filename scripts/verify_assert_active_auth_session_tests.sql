-- Local 5.19.6A tests. Must run inside an outer transaction that ROLLBACKs.
-- Do not COMMIT.

CREATE OR REPLACE FUNCTION public.auth_session_test_jwt(p_sub uuid, p_sid uuid, p_role text DEFAULT 'authenticated')
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);
  PERFORM set_config('request.jwt.claim.session_id', COALESCE(p_sid::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', p_role, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_sub, 'session_id', p_sid, 'role', p_role)::text,
    true
  );
END;
$$;

DO $$
DECLARE
  v_admin uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_seller uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_manager uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_old uuid := 'aaaaaaaa-0001-4000-8000-000000000001';
  v_new uuid := 'aaaaaaaa-0002-4000-8000-000000000002';
  v_seller_sid uuid := 'bbbbbbbb-0001-4000-8000-000000000001';
  v_manager_sid uuid := 'cccccccc-0001-4000-8000-000000000001';
  v_status text;
  v_id uuid;
  v_denied boolean;
BEGIN
  PERFORM public.auth_session_test_jwt(v_admin, v_old);
  v_status := public.claim_active_auth_session();
  IF v_status IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'first login must be allowed, got %', v_status;
  END IF;

  v_status := public.claim_active_auth_session();
  IF v_status IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'same session re-claim (two tabs) must be allowed, got %', v_status;
  END IF;
  IF public.check_active_auth_session() IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'claimed session must check allowed';
  END IF;

  PERFORM public.auth_session_test_jwt(v_admin, v_new);
  v_status := public.check_active_auth_session();
  IF v_status IS DISTINCT FROM 'denied' THEN
    RAISE EXCEPTION 'second browser before takeover must be denied, got %', v_status;
  END IF;
  BEGIN
    PERFORM public.assert_active_auth_session();
    RAISE EXCEPTION 'old leftover JWT must not mutate';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%Active session required%' THEN
      RAISE;
    END IF;
  END;

  v_status := public.claim_active_auth_session();
  IF v_status IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'newer login may take over, got %', v_status;
  END IF;

  PERFORM public.auth_session_test_jwt(v_admin, v_old);
  v_status := public.claim_active_auth_session();
  IF v_status IS DISTINCT FROM 'denied' THEN
    RAISE EXCEPTION 'older JWT must not steal claim, got %', v_status;
  END IF;
  v_status := public.check_active_auth_session();
  IF v_status IS DISTINCT FROM 'denied' THEN
    RAISE EXCEPTION 'older JWT check must stay denied, got %', v_status;
  END IF;

  PERFORM public.auth_session_test_jwt(v_admin, v_new);
  IF public.check_active_auth_session() IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'newer claimed session must remain allowed';
  END IF;

  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_status := public.claim_active_auth_session();
  IF v_status IS DISTINCT FROM 'unknown' THEN
    RAISE EXCEPTION 'claim without session_id must be unknown, got %', v_status;
  END IF;
  v_status := public.check_active_auth_session();
  IF v_status IS DISTINCT FROM 'unknown' THEN
    RAISE EXCEPTION 'check without session_id must be unknown, got %', v_status;
  END IF;
  BEGIN
    PERFORM public.assert_active_auth_session();
    RAISE EXCEPTION 'mutate without session_id must fail closed';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%Active session required%' THEN
      RAISE;
    END IF;
  END;

  PERFORM public.auth_session_test_jwt(v_admin, '99999999-9999-4999-8999-999999999999');
  v_status := public.claim_active_auth_session();
  IF v_status IS DISTINCT FROM 'denied' THEN
    RAISE EXCEPTION 'forged session_id must be denied, got %', v_status;
  END IF;

  PERFORM public.auth_session_test_jwt(v_seller, v_seller_sid);
  IF public.claim_active_auth_session() IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'seller first claim';
  END IF;
  PERFORM public.auth_session_test_jwt(v_manager, v_manager_sid);
  IF public.claim_active_auth_session() IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'manager first claim';
  END IF;

  PERFORM public.auth_session_test_jwt(v_admin, v_new);
  v_id := public.confirm_order(jsonb_build_object('note', 'ok'));
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'wrapped confirm_order must run after claim';
  END IF;

  PERFORM public.auth_session_test_jwt(v_admin, v_old);
  BEGIN
    PERFORM public.confirm_order(jsonb_build_object('note', 'stolen'));
    RAISE EXCEPTION 'direct RPC with old JWT must fail';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%Active session required%' THEN
      RAISE;
    END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'confirm_order__session_body'
  ) THEN
    RAISE EXCEPTION 'confirm_order body must be preserved under session_body';
  END IF;
  IF pg_get_functiondef('public.confirm_order(jsonb)'::regprocedure)
       NOT LIKE '%PERFORM public.assert_active_auth_session()%' THEN
    RAISE EXCEPTION 'wrapper must call assert';
  END IF;
  IF pg_get_functiondef('public.confirm_order__session_body(jsonb)'::regprocedure)
       LIKE '%PERFORM public.assert_active_auth_session()%' THEN
    RAISE EXCEPTION 'business body must not be rewritten with assert';
  END IF;

  PERFORM public.auth_session_test_jwt(v_admin, v_old);
  BEGIN
    INSERT INTO public.products(name) VALUES ('hijack');
    RAISE EXCEPTION 'direct product insert with old JWT must fail';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%Active session required%' THEN
      RAISE;
    END IF;
  END;

  PERFORM public.auth_session_test_jwt(v_admin, v_new);
  INSERT INTO public.products(name) VALUES ('ok-product');

  v_denied := false;
  BEGIN
    SET ROLE authenticated;
    PERFORM public.auth_session_test_jwt(v_admin, v_new);
    INSERT INTO public.user_active_sessions(user_id, device_id)
    VALUES (v_admin, 'forged-device');
  EXCEPTION WHEN others THEN
    v_denied := true;
  END;
  RESET ROLE;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'authenticated must not insert user_active_sessions';
  END IF;

  PERFORM public.auth_session_test_jwt(v_admin, v_new);
  IF public.admin_seller_accrual_retry_item('13131313-1313-4131-8131-131313131313')->>'ok' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'commission retry stub must still run after wrap';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  SET ROLE service_role;
  IF public.check_active_auth_session() IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'service_role check must pass';
  END IF;
  RESET ROLE;

  IF EXISTS (
    SELECT 1 FROM public.auth_session_guard_integrity() WHERE status = 'FAIL'
  ) THEN
    RAISE EXCEPTION 'integrity must PASS after wrap';
  END IF;

  v_denied := false;
  BEGIN
    SET ROLE authenticated;
    PERFORM public.confirm_order__session_body(jsonb_build_object('note', 'bypass'));
  EXCEPTION WHEN others THEN
    v_denied := true;
  END;
  RESET ROLE;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'authenticated must not execute confirm_order__session_body';
  END IF;

  CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $ung$
  DECLARE v_id uuid;
  BEGIN
    INSERT INTO public.session_probe_orders(note) VALUES (payload->>'note') RETURNING id INTO v_id;
    RETURN v_id;
  END;
  $ung$;
  IF NOT EXISTS (
    SELECT 1 FROM public.auth_session_guard_integrity()
    WHERE check_name LIKE 'public.confirm_order(jsonb).assert' AND status = 'FAIL'
  ) THEN
    RAISE EXCEPTION 'integrity must detect missing assert after CREATE OR REPLACE';
  END IF;
  PERFORM public.auth_session_guard_apply();
  IF EXISTS (
    SELECT 1 FROM public.auth_session_guard_integrity() WHERE status = 'FAIL'
  ) THEN
    RAISE EXCEPTION 'apply must restore wrappers after CREATE OR REPLACE';
  END IF;
END;
$$;
