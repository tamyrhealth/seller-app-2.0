-- Read-only checks AFTER partial-receive SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'stock_transfer_items'
  AND column_name IN ('qty_sent', 'qty_received', 'qty_lost', 'qty_returned')
ORDER BY 1;

SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'public.stock_transfer_items'::regclass
  AND conname IN (
    'stock_transfer_items_qty_lost_check',
    'stock_transfer_items_qty_returned_check',
    'stock_transfer_items_qty_balance_check'
  )
ORDER BY 1;

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) LIKE '%Only admin%' AS checks_admin,
       pg_get_functiondef(p.oid) LIKE '%different payload%' AS rejects_payload_mismatch,
       pg_get_functiondef(p.oid) LIKE '%remaining in transit%' AS uses_remaining,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'receive_stock_transfer',
    'cancel_stock_transfer',
    'write_off_stock_transfer_shortage',
    'stock_transfer_remaining',
    'stock_transfer_close_status'
  )
ORDER BY 1, 2;

SELECT t.transfer_number,
       t.status,
       i.product_id,
       i.qty_sent,
       i.qty_received,
       i.qty_lost,
       i.qty_returned,
       public.stock_transfer_remaining(i.qty_sent, i.qty_received, i.qty_lost, i.qty_returned) AS qty_in_transit
FROM public.stock_transfers t
JOIN public.stock_transfer_items i ON i.transfer_id = t.id
WHERE t.transfer_number IN ('T000001', 'T000002')
ORDER BY t.transfer_number, i.product_id;
