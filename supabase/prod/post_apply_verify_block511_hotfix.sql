-- Read-only checks AFTER message-count guard hotfix.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT pg_get_functiondef(p.oid) LIKE '%pg_trigger_depth%' AS guard_uses_trigger_depth,
       pg_get_functiondef(p.oid) LIKE '%Cannot change message_count%' AS guard_blocks_count,
       pg_get_functiondef(p.oid) LIKE '%Cannot change chat number%' AS guard_blocks_number
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'assistant_chats_guard';

SELECT pg_get_functiondef(p.oid) LIKE '%row_security%' AS touch_sets_row_security
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'assistant_messages_touch_chat';

SELECT
  has_column_privilege('authenticated', 'public.assistant_chats', 'title', 'UPDATE') AS auth_update_title,
  has_column_privilege('authenticated', 'public.assistant_chats', 'message_count', 'UPDATE') AS auth_update_message_count,
  has_column_privilege('authenticated', 'public.assistant_chats', 'chat_number', 'UPDATE') AS auth_update_chat_number,
  has_column_privilege('authenticated', 'public.assistant_chats', 'owner_id', 'UPDATE') AS auth_update_owner_id,
  has_table_privilege('authenticated', 'public.assistant_messages', 'INSERT') AS auth_msg_insert;

SELECT policyname, tablename, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('assistant_chats', 'assistant_messages')
ORDER BY tablename, policyname;

SELECT COUNT(*) AS existing_messages
FROM public.assistant_messages;
