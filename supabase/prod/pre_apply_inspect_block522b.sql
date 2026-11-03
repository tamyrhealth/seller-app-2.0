-- Read-only. Run BEFORE 5.2.2b draft-update SQL.
-- Confirms 5.2.2 drafts exist and confirm_order is unchanged.

SELECT current_database() AS db;

SELECT to_regclass('public.assistant_order_drafts') AS drafts_table;

SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'confirm_order',
    'save_assistant_order_draft',
    'begin_assistant_order_confirm',
    'cancel_assistant_order_draft',
    'update_assistant_order_draft_content'
  )
ORDER BY 1;
