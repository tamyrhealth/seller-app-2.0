-- Read-only checks AFTER manager / assistant-chat SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.profiles'::regclass
  AND conname = 'profiles_role_check';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'profiles'
  AND column_name = 'can_cancel_orders';

SELECT to_regclass('public.assistant_chats') AS assistant_chats,
       to_regclass('public.assistant_messages') AS assistant_messages;

SELECT polname, tablename, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    (tablename IN ('orders', 'inventory', 'profiles', 'order_items') AND polname LIKE '%staff%')
    OR tablename IN ('assistant_chats', 'assistant_messages')
  )
ORDER BY tablename, polname;

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) LIKE '%manager%' AS mentions_manager,
       pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%' AS advisory_lock,
       pg_get_functiondef(p.oid) LIKE '%qty_on_hand >= v_need%' AS stock_guard,
       pg_get_functiondef(p.oid) LIKE '%s.city_id = v_city_id%' AS seller_city_match
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('confirm_order', 'is_admin', 'is_manager', 'is_assistant_user', 'apply_order_cancel')
ORDER BY 1;

SELECT
  has_table_privilege('anon', 'public.assistant_chats', 'SELECT') AS anon_chats_select,
  has_table_privilege('authenticated', 'public.assistant_chats', 'SELECT') AS auth_chats_select,
  has_table_privilege('authenticated', 'public.assistant_chats', 'DELETE') AS auth_chats_delete,
  has_table_privilege('authenticated', 'public.assistant_messages', 'INSERT') AS auth_msg_insert,
  has_table_privilege('authenticated', 'public.assistant_messages', 'UPDATE') AS auth_msg_update,
  has_table_privilege('authenticated', 'public.assistant_messages', 'DELETE') AS auth_msg_delete;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'assistant_messages_client_id_uidx';

SELECT tgname, tgrelid::regclass
FROM pg_trigger
WHERE tgname IN ('assistant_chats_guard', 'profiles_prevent_privilege_escalation')
  AND NOT tgisinternal
ORDER BY 1;

SELECT p.proname,
       pg_get_functiondef(p.oid) LIKE '%Not allowed to cancel this order%' AS denies_non_owner,
       pg_get_functiondef(p.oid) LIKE '%manager%' AS mentions_manager
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'apply_order_cancel';

SELECT has_function_privilege('authenticated', 'public.cancel_order(uuid)', 'EXECUTE') AS auth_cancel_exec,
       has_function_privilege('authenticated', 'public.admin_cancel_order(uuid, text)', 'EXECUTE') AS auth_admin_cancel_exec;

SELECT count(*) AS existing_profiles
FROM public.profiles;
