-- Read-only. Run BEFORE 5.2.2 on the current Seller App database.
-- Does not INSERT/UPDATE/DELETE. Confirms 5.1 / 5.2.1 objects that 5.2.2 needs.

SELECT current_database() AS db;

SELECT to_regclass('public.assistant_chats') AS assistant_chats,
       to_regclass('public.assistant_messages') AS assistant_messages,
       to_regclass('public.assistant_generations') AS assistant_generations,
       to_regclass('public.assistant_order_drafts') AS drafts_must_be_null_before_apply;

SELECT to_regclass('public.orders') AS orders,
       to_regclass('public.inventory') AS inventory,
       to_regclass('public.profiles') AS profiles;

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders'
  AND column_name IN ('idempotency_key', 'idempotency_actor_id', 'idempotency_fingerprint')
ORDER BY 1;

SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'confirm_order',
    'is_admin',
    'is_assistant_user',
    'claim_assistant_generation',
    'complete_assistant_generation'
  )
ORDER BY 1;

SELECT COUNT(*) AS orders_count FROM public.orders;
SELECT COUNT(*) AS inventory_rows FROM public.inventory;
SELECT COUNT(*) AS profiles_count FROM public.profiles;
SELECT COUNT(*) AS assistant_chats_count FROM public.assistant_chats;
SELECT COUNT(*) AS assistant_messages_count FROM public.assistant_messages;
