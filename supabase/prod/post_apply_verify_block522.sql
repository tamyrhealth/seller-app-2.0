-- Read-only checks AFTER assistant order drafts SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'assistant_order_drafts';

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'assistant_order_drafts_idempotency_uidx',
    'assistant_order_drafts_message_uidx'
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
    'save_assistant_order_draft',
    'attach_assistant_order_draft_message',
    'finalize_assistant_order_draft',
    'fail_assistant_order_confirm',
    'begin_assistant_order_confirm',
    'cancel_assistant_order_draft',
    'confirm_order'
  )
ORDER BY p.proname;

SELECT has_table_privilege('authenticated', 'public.assistant_order_drafts', 'SELECT') AS auth_select_drafts,
       has_table_privilege('authenticated', 'public.assistant_order_drafts', 'INSERT') AS auth_insert_drafts,
       has_table_privilege('authenticated', 'public.assistant_order_drafts', 'UPDATE') AS auth_update_drafts,
       has_table_privilege('authenticated', 'public.assistant_order_drafts', 'DELETE') AS auth_delete_drafts;

SELECT pg_get_functiondef(p.oid) LIKE '%not_draft_owner%' AS begin_checks_owner,
       pg_get_functiondef(p.oid) LIKE '%row_security = off%' AS begin_row_security_off,
       pg_get_functiondef(p.oid) LIKE '%owner_id = v_uid%' AS begin_locks_own_row
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'begin_assistant_order_confirm';

SELECT pg_get_functiondef(p.oid) LIKE '%chat_owner_mismatch%' AS save_checks_chat_owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'save_assistant_order_draft';

SELECT pg_get_functiondef(p.oid) LIKE '%confirm_order%' AS drafts_call_confirm_order
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'save_assistant_order_draft',
  'begin_assistant_order_confirm',
  'finalize_assistant_order_draft'
);

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'assistant_order_drafts'
ORDER BY policyname;

SELECT COUNT(*) AS existing_drafts
FROM public.assistant_order_drafts;
