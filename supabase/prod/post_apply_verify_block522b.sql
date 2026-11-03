-- Read-only checks AFTER assistant draft update SQL.

SELECT current_database() AS db;

SELECT p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'update_assistant_order_draft_content';

SELECT pg_get_functiondef(p.oid) NOT LIKE '%idempotency_key%' AS update_does_not_touch_idempotency_key,
       pg_get_functiondef(p.oid) LIKE '%draft_not_editable%' AS rejects_locked_status,
       pg_get_functiondef(p.oid) LIKE '%not_draft_owner%' AS checks_owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'update_assistant_order_draft_content';
