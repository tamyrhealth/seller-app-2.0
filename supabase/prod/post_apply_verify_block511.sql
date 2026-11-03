-- Read-only checks AFTER assistant chat numbering SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT to_regclass('public.assistant_chats') AS assistant_chats,
       to_regclass('public.assistant_messages') AS assistant_messages;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'assistant_chats'
  AND column_name IN ('chat_number', 'message_count')
ORDER BY 1;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'assistant_chats_chat_number_uidx',
    'assistant_chats_one_empty_per_owner_uidx',
    'assistant_messages_client_id_uidx'
  )
ORDER BY 1;

SELECT policyname, tablename, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('assistant_chats', 'assistant_messages')
ORDER BY tablename, policyname;

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%' AS advisory_lock,
       pg_get_functiondef(p.oid) LIKE '%is_assistant_user%' AS checks_assistant
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('open_empty_assistant_chat', 'format_chat_number', 'apply_order_cancel')
ORDER BY 1;

SELECT
  has_function_privilege('authenticated', 'public.open_empty_assistant_chat()', 'EXECUTE') AS auth_open_empty,
  has_function_privilege('anon', 'public.open_empty_assistant_chat()', 'EXECUTE') AS anon_open_empty,
  has_table_privilege('authenticated', 'public.assistant_messages', 'UPDATE') AS auth_msg_update,
  has_table_privilege('authenticated', 'public.assistant_messages', 'DELETE') AS auth_msg_delete;

SELECT COUNT(*) AS chats_without_number
FROM public.assistant_chats
WHERE chat_number IS NULL OR btrim(chat_number) = '';

SELECT owner_id, COUNT(*) AS empty_chats
FROM public.assistant_chats
WHERE archived_at IS NULL AND message_count = 0
GROUP BY owner_id
HAVING COUNT(*) > 1;

SELECT COUNT(*) AS existing_messages
FROM public.assistant_messages;
