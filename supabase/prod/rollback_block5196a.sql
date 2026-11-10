-- 5.19.6A rollback. Do not run on Production without an explicit command.
-- Restores RPC names by renaming __session_body back. Does not rewrite business logic.
-- Does not DELETE auth.sessions. Does not drop auth_session_id column.

BEGIN;

DROP TRIGGER IF EXISTS auth_session_guard_products ON public.products;
DROP TRIGGER IF EXISTS auth_session_guard_profiles ON public.profiles;
DROP TRIGGER IF EXISTS auth_session_guard_cities ON public.cities;
DROP TRIGGER IF EXISTS auth_session_guard_action_logs ON public.action_logs;
DROP TRIGGER IF EXISTS auth_session_guard_finance_expenses ON public.finance_expenses;
DROP TRIGGER IF EXISTS auth_session_guard_assistant_chats ON public.assistant_chats;
DROP TRIGGER IF EXISTS auth_session_guard_assistant_messages ON public.assistant_messages;

DROP FUNCTION IF EXISTS public.auth_session_guard_write_trigger();

DO $$
DECLARE
  v_fn text;
  v_name text;
  v_nsp text := 'public';
  v_body text;
  v_src text;
  v_reg regprocedure;
  v_argtypes oidvector;
  v_body_oid oid;
  v_wrap_oid oid;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
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
  ]
  LOOP
    v_reg := to_regprocedure(v_fn);
    IF v_reg IS NULL THEN
      CONTINUE;
    END IF;
    v_src := pg_get_functiondef(v_reg);
    IF v_src NOT LIKE '%PERFORM public.assert_active_auth_session()%' THEN
      CONTINUE;
    END IF;
    SELECT p.proname, p.proargtypes INTO v_name, v_argtypes
    FROM pg_proc p WHERE p.oid = v_reg::oid;
    v_body := v_name || '__session_body';
    SELECT p.oid INTO v_body_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = v_nsp AND p.proname = v_body AND p.proargtypes = v_argtypes;
    IF v_body_oid IS NULL THEN
      CONTINUE;
    END IF;
    v_wrap_oid := v_reg::oid;
    EXECUTE 'DROP FUNCTION ' || v_wrap_oid::regprocedure;
    EXECUTE 'ALTER FUNCTION ' || v_body_oid::regprocedure || ' RENAME TO ' || quote_ident(v_name);
    SELECT p.oid INTO v_wrap_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = v_nsp AND p.proname = v_name AND p.proargtypes = v_argtypes;
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_wrap_oid::regprocedure || ' TO authenticated, service_role';
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.auth_session_guard_wrap(regprocedure);
DROP FUNCTION IF EXISTS public.assert_active_auth_session();
DROP FUNCTION IF EXISTS public.claim_active_auth_session();
DROP FUNCTION IF EXISTS public.check_active_auth_session();
DROP FUNCTION IF EXISTS public.auth_session_read_jwt_sid();
DROP FUNCTION IF EXISTS public.auth_session_role();

REVOKE DELETE, TRUNCATE ON TABLE public.user_active_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_active_sessions TO authenticated;
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

COMMIT;
