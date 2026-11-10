-- 5.19.6B phase 2. Enforce: wrap mutating RPCs, revoke session-table writes, write triggers.
-- Apply only after the new client is deployed and claiming.
-- Does not rewrite confirm_order / inventory / commission bodies.
-- Does not DELETE auth.sessions / auth.refresh_tokens.

BEGIN;

CREATE OR REPLACE FUNCTION public.auth_session_guard_targets()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY[
    'public.confirm_order(jsonb)',
    'public.cancel_order(uuid)',
    'public.admin_cancel_order(uuid, text)',
    'public.cancel_order_report(uuid)',
    'public.admin_cancel_order_report(uuid, text)',
    'public.fulfill_preorder(uuid)',
    'public.mark_debt_paid(uuid, text)',
    'public.apply_inventory_restock(uuid, uuid, uuid, numeric)',
    'public.apply_inventory_adjust(uuid, uuid, uuid, numeric)',
    'public.create_stock_transfer(uuid, uuid, uuid, jsonb, text)',
    'public.receive_stock_transfer(uuid, uuid, jsonb)',
    'public.cancel_stock_transfer(uuid, uuid, text)',
    'public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text)',
    'public.admin_seller_goods_issue(uuid, uuid, uuid, jsonb, text, timestamp with time zone)',
    'public.admin_seller_goods_advance(uuid, uuid, uuid, jsonb, text, timestamp with time zone)',
    'public.admin_seller_goods_return(uuid, uuid, boolean, text)',
    'public.admin_seller_cash_payout(uuid, uuid, numeric, text, timestamp with time zone)',
    'public.admin_seller_cash_advance(uuid, uuid, numeric, text, timestamp with time zone)',
    'public.admin_seller_tariff_plan_upsert(uuid, text, text, boolean)',
    'public.admin_seller_tariff_rate_set(uuid, uuid, numeric, timestamp with time zone)',
    'public.admin_seller_tariff_assign(uuid, uuid, timestamp with time zone)',
    'public.admin_seller_rate_override_set(uuid, uuid, numeric, timestamp with time zone)',
    'public.admin_seller_accrual_retry_item(uuid)',
    'public.admin_finance_expense_create(uuid, date, text, numeric, uuid, text)',
    'public.admin_finance_expense_update(uuid, date, text, numeric, uuid, text)',
    'public.admin_finance_expense_delete(uuid)',
    'public.begin_assistant_order_confirm(uuid)',
    'public.cancel_assistant_order_draft(uuid)',
    'public.begin_assistant_stock_transfer_confirm(uuid)',
    'public.cancel_assistant_stock_transfer_draft(uuid)',
    'public.open_empty_assistant_chat()'
  ];
$$;

CREATE OR REPLACE FUNCTION public.auth_session_guard_wrap(p_fn regprocedure)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_nsp text;
  v_name text;
  v_args text;
  v_result text;
  v_src text;
  v_body text;
  v_call text;
  v_names text[];
  v_nargs int;
  v_argtypes oidvector;
  v_body_oid oid;
  v_wrap_oid oid;
  v_sql text;
BEGIN
  SELECT n.nspname, p.proname,
         pg_get_function_arguments(p.oid),
         pg_get_function_result(p.oid),
         p.proargnames,
         p.pronargs,
         p.proargtypes
    INTO v_nsp, v_name, v_args, v_result, v_names, v_nargs, v_argtypes
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.oid = p_fn::oid;

  IF v_name IS NULL THEN
    RETURN;
  END IF;
  IF v_name LIKE '%session_body' THEN
    RETURN;
  END IF;

  v_src := pg_get_functiondef(p_fn);
  IF v_src LIKE '%PERFORM public.assert_active_auth_session()%' THEN
    RETURN;
  END IF;

  v_body := v_name || '__session_body';
  IF v_nargs = 0 THEN
    v_call := '';
  ELSIF v_names IS NULL THEN
    SELECT string_agg('$' || i::text, ', ' ORDER BY i) INTO v_call
    FROM generate_series(1, v_nargs) AS i;
  ELSE
    SELECT string_agg(quote_ident(x.n), ', ' ORDER BY x.ord) INTO v_call
    FROM unnest(v_names) WITH ORDINALITY AS x(n, ord)
    WHERE x.n IS NOT NULL AND x.n <> '';
    IF v_call IS NULL OR v_call = '' THEN
      SELECT string_agg('$' || i::text, ', ' ORDER BY i) INTO v_call
      FROM generate_series(1, v_nargs) AS i;
    END IF;
  END IF;

  SELECT p.oid INTO v_body_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = v_nsp AND p.proname = v_body AND p.proargtypes = v_argtypes;
  IF v_body_oid IS NOT NULL THEN
    EXECUTE 'DROP FUNCTION ' || v_body_oid::regprocedure;
  END IF;
  EXECUTE 'ALTER FUNCTION ' || p_fn::text || ' RENAME TO ' || quote_ident(v_body);

  IF v_result = 'void' THEN
    v_sql := format(
      'CREATE OR REPLACE FUNCTION %I.%I(%s) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$ BEGIN PERFORM public.assert_active_auth_session(); PERFORM %I.%I(%s); END; $fn$;',
      v_nsp, v_name, v_args, v_nsp, v_body, v_call
    );
  ELSE
    v_sql := format(
      'CREATE OR REPLACE FUNCTION %I.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$ BEGIN PERFORM public.assert_active_auth_session(); RETURN %I.%I(%s); END; $fn$;',
      v_nsp, v_name, v_args, v_result, v_nsp, v_body, v_call
    );
  END IF;
  EXECUTE v_sql;

  SELECT p.oid INTO v_body_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = v_nsp AND p.proname = v_body AND p.proargtypes = v_argtypes;
  SELECT p.oid INTO v_wrap_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = v_nsp AND p.proname = v_name AND p.proargtypes = v_argtypes;

  EXECUTE 'REVOKE ALL ON FUNCTION ' || v_body_oid::regprocedure || ' FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_body_oid::regprocedure || ' TO postgres, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION ' || v_wrap_oid::regprocedure || ' FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_wrap_oid::regprocedure || ' TO authenticated, service_role';
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_session_guard_apply()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fn text;
  v_reg regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY public.auth_session_guard_targets()
  LOOP
    v_reg := to_regprocedure(v_fn);
    IF v_reg IS NOT NULL THEN
      PERFORM public.auth_session_guard_wrap(v_reg);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_session_guard_integrity()
RETURNS TABLE (check_name text, actual_value text, expected_value text, status text)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_fn text;
  v_reg regprocedure;
  v_src text;
  v_body_oid oid;
  v_argtypes oidvector;
  v_name text;
  v_nsp text;
  v_ok boolean;
BEGIN
  FOREACH v_fn IN ARRAY public.auth_session_guard_targets()
  LOOP
    v_reg := to_regprocedure(v_fn);
    IF v_reg IS NULL THEN
      check_name := v_fn || '.present';
      actual_value := 'absent';
      expected_value := 'absent_ok';
      status := 'PASS';
      RETURN NEXT;
      CONTINUE;
    END IF;
    v_src := pg_get_functiondef(v_reg);
    v_ok := v_src LIKE '%PERFORM public.assert_active_auth_session()%';
    check_name := v_fn || '.assert';
    actual_value := CASE WHEN v_ok THEN 'wrapped' ELSE 'missing_assert' END;
    expected_value := 'wrapped';
    status := CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;

    SELECT n.nspname, p.proname, p.proargtypes
      INTO v_nsp, v_name, v_argtypes
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = v_reg::oid;
    SELECT p.oid INTO v_body_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = v_nsp AND p.proname = v_name || '__session_body' AND p.proargtypes = v_argtypes;
    check_name := v_fn || '.body_hidden';
    IF v_body_oid IS NULL THEN
      actual_value := 'no_body';
      expected_value := 'no_authenticated_execute';
      status := 'FAIL';
    ELSIF has_function_privilege('authenticated', v_body_oid, 'EXECUTE') THEN
      actual_value := 'authenticated_execute';
      expected_value := 'no_authenticated_execute';
      status := 'FAIL';
    ELSIF has_function_privilege('anon', v_body_oid, 'EXECUTE') THEN
      actual_value := 'anon_execute';
      expected_value := 'no_authenticated_execute';
      status := 'FAIL';
    ELSE
      actual_value := 'no_authenticated_execute';
      expected_value := 'no_authenticated_execute';
      status := 'PASS';
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

DO $$
BEGIN
  PERFORM public.auth_session_guard_apply();
END;
$$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.user_active_sessions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_active_sessions TO authenticated;
DROP POLICY IF EXISTS "user_active_sessions_insert_own" ON public.user_active_sessions;
DROP POLICY IF EXISTS "user_active_sessions_update_own" ON public.user_active_sessions;

CREATE OR REPLACE FUNCTION public.auth_session_guard_write_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.auth_session_role() = 'service_role' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  PERFORM public.assert_active_auth_session();
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_session_guard_products ON public.products;
DROP TRIGGER IF EXISTS auth_session_guard_profiles ON public.profiles;
DROP TRIGGER IF EXISTS auth_session_guard_cities ON public.cities;
DROP TRIGGER IF EXISTS auth_session_guard_action_logs ON public.action_logs;
DROP TRIGGER IF EXISTS auth_session_guard_finance_expenses ON public.finance_expenses;
DROP TRIGGER IF EXISTS auth_session_guard_assistant_chats ON public.assistant_chats;
DROP TRIGGER IF EXISTS auth_session_guard_assistant_messages ON public.assistant_messages;

DO $$
BEGIN
  IF to_regclass('public.products') IS NOT NULL THEN
    EXECUTE $t$CREATE TRIGGER auth_session_guard_products
      BEFORE INSERT OR UPDATE OR DELETE ON public.products
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_guard_write_trigger()$t$;
  END IF;
  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE $t$CREATE TRIGGER auth_session_guard_profiles
      BEFORE INSERT OR UPDATE OR DELETE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_guard_write_trigger()$t$;
  END IF;
  IF to_regclass('public.cities') IS NOT NULL THEN
    EXECUTE $t$CREATE TRIGGER auth_session_guard_cities
      BEFORE INSERT OR UPDATE OR DELETE ON public.cities
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_guard_write_trigger()$t$;
  END IF;
  IF to_regclass('public.action_logs') IS NOT NULL THEN
    EXECUTE $t$CREATE TRIGGER auth_session_guard_action_logs
      BEFORE INSERT OR UPDATE OR DELETE ON public.action_logs
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_guard_write_trigger()$t$;
  END IF;
  IF to_regclass('public.finance_expenses') IS NOT NULL THEN
    EXECUTE $t$CREATE TRIGGER auth_session_guard_finance_expenses
      BEFORE INSERT OR UPDATE OR DELETE ON public.finance_expenses
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_guard_write_trigger()$t$;
  END IF;
  IF to_regclass('public.assistant_chats') IS NOT NULL THEN
    EXECUTE $t$CREATE TRIGGER auth_session_guard_assistant_chats
      BEFORE INSERT OR UPDATE OR DELETE ON public.assistant_chats
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_guard_write_trigger()$t$;
  END IF;
  IF to_regclass('public.assistant_messages') IS NOT NULL THEN
    EXECUTE $t$CREATE TRIGGER auth_session_guard_assistant_messages
      BEFORE INSERT OR UPDATE OR DELETE ON public.assistant_messages
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_guard_write_trigger()$t$;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_session_guard_wrap(regprocedure) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_session_guard_apply() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_session_guard_targets() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_session_guard_integrity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_session_guard_write_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_session_guard_wrap(regprocedure) TO postgres;
GRANT EXECUTE ON FUNCTION public.auth_session_guard_apply() TO postgres;
GRANT EXECUTE ON FUNCTION public.auth_session_guard_targets() TO postgres;
GRANT EXECUTE ON FUNCTION public.auth_session_guard_integrity() TO postgres;

COMMIT;
