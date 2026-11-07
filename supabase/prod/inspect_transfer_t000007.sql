-- Read-only inspection for T000007 after assistant receive confirm.
-- SELECT only. Do not INSERT/UPDATE/DELETE. Do not receive again.

SELECT t.id,
       t.transfer_number,
       t.status,
       t.from_city_id,
       t.to_city_id,
       t.created_by,
       t.received_by,
       t.received_at,
       t.cancelled_by,
       t.cancelled_at,
       t.updated_at
FROM public.stock_transfers t
WHERE t.transfer_number = 'T000007';

SELECT t.transfer_number,
       p.name AS product_name,
       i.product_id,
       i.qty_sent,
       COALESCE(i.qty_received, 0) AS qty_received,
       COALESCE(i.qty_lost, 0) AS qty_lost,
       COALESCE(i.qty_returned, 0) AS qty_returned,
       public.stock_transfer_remaining(
         i.qty_sent,
         i.qty_received,
         COALESCE(i.qty_lost, 0),
         COALESCE(i.qty_returned, 0)
       ) AS qty_in_transit
FROM public.stock_transfers t
JOIN public.stock_transfer_items i ON i.transfer_id = t.id
JOIN public.products p ON p.id = i.product_id
WHERE t.transfer_number = 'T000007'
ORDER BY p.name;

SELECT e.created_at,
       e.action,
       e.actor_id,
       pr.display_name AS actor_name,
       e.details
FROM public.stock_transfers t
JOIN public.stock_transfer_events e ON e.transfer_id = t.id
LEFT JOIN public.profiles pr ON pr.id = e.actor_id
WHERE t.transfer_number = 'T000007'
ORDER BY e.created_at;

SELECT m.created_at,
       c.name AS city,
       p.name AS product,
       m.type,
       m.qty_delta,
       m.note
FROM public.inventory_movements m
JOIN public.stock_transfers t ON t.id = m.transfer_id
JOIN public.cities c ON c.id = m.city_id
JOIN public.products p ON p.id = m.product_id
WHERE t.transfer_number = 'T000007'
ORDER BY m.created_at;

SELECT c.created_at,
       c.actor_id,
       c.operation_id,
       c.operation_type,
       c.entity_id,
       c.result
FROM public.client_operations c
JOIN public.stock_transfers t ON t.id::text = c.entity_id
WHERE t.transfer_number = 'T000007'
ORDER BY c.created_at;

SELECT m.created_at,
       m.id AS message_id,
       m.metadata->>'state' AS card_state,
       m.metadata->'preview'->>'status' AS preview_status,
       m.metadata->'preview'->>'remaining' AS preview_remaining,
       m.metadata->'preview'->>'transfer_number' AS preview_number,
       m.metadata->'preview'->'items' AS preview_items,
       m.metadata->'preview'->'events' AS preview_events
FROM public.assistant_messages m
WHERE m.metadata->>'kind' = 'transfer_manage'
  AND (
    m.metadata->'preview'->>'transfer_number' = 'T000007'
    OR COALESCE(m.content, '') ILIKE '%T000007%'
  )
ORDER BY m.created_at;
