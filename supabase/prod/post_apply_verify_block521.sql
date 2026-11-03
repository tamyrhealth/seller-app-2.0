-- Read-only checks AFTER assistant AI generation SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'assistant_generations';

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'assistant_generations_one_running_per_chat_uidx',
    'assistant_messages_assistant_request_uidx'
  )
ORDER BY indexname;

SELECT p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'claim_assistant_generation',
    'complete_assistant_generation',
    'fail_assistant_generation'
  )
ORDER BY p.proname;

SELECT has_table_privilege('authenticated', 'public.assistant_generations', 'SELECT') AS auth_select_generations,
       has_table_privilege('authenticated', 'public.assistant_generations', 'INSERT') AS auth_insert_generations,
       has_table_privilege('authenticated', 'public.assistant_messages', 'INSERT') AS auth_msg_insert;

SELECT pg_get_functiondef(p.oid) LIKE '%lease_id%' AS uses_lease,
       pg_get_functiondef(p.oid) LIKE '%user_message_mismatch%' AS checks_user_message,
       pg_get_functiondef(p.oid) LIKE '%pg_trigger_depth%' AS uses_trigger_depth
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'claim_assistant_generation';

SELECT pg_get_functiondef(p.oid) LIKE '%stale_lease%' AS complete_rejects_stale_lease
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'complete_assistant_generation';

SELECT pg_get_functiondef(p.oid) LIKE '%pg_trigger_depth%' AS guard_uses_trigger_depth
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'assistant_chats_guard';

SELECT policyname, tablename, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('assistant_chats', 'assistant_messages', 'assistant_generations')
ORDER BY tablename, policyname;

SELECT COUNT(*) AS existing_messages
FROM public.assistant_messages;
