-- Read-only. Run on staging after apply_run_sql.ps1.
-- Expect: assistant tables present, drafts RLS on, confirm_order exists,
-- authenticated cannot INSERT drafts.

SELECT current_database() AS db;

SELECT to_regclass('public.assistant_chats') AS chats,
       to_regclass('public.assistant_messages') AS messages,
       to_regclass('public.assistant_generations') AS generations,
       to_regclass('public.assistant_order_drafts') AS drafts;

SELECT con.conname
FROM pg_constraint con
WHERE con.conrelid = 'public.profiles'::regclass
  AND con.conname = 'profiles_role_check';

SELECT p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'confirm_order',
    'save_assistant_order_draft',
    'begin_assistant_order_confirm',
    'claim_assistant_generation',
    'open_empty_assistant_chat'
  )
ORDER BY 1;

SELECT has_table_privilege('authenticated', 'public.assistant_order_drafts', 'SELECT') AS auth_select_drafts,
       has_table_privilege('authenticated', 'public.assistant_order_drafts', 'INSERT') AS auth_insert_drafts,
       has_table_privilege('authenticated', 'public.assistant_order_drafts', 'UPDATE') AS auth_update_drafts;

SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('assistant_chats', 'assistant_order_drafts', 'assistant_generations');

SELECT COUNT(*) AS orders_must_stay_low FROM public.orders;
