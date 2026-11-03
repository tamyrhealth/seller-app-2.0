-- Read-only inspection for T000001 / T000002 recovery.
-- Does not INSERT/UPDATE/DELETE. Do not restock until this is reviewed.

SELECT t.transfer_number,
       t.status,
       t.from_city_id,
       t.to_city_id,
       i.product_id,
       p.name AS product_name,
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
WHERE t.transfer_number IN ('T000001', 'T000002')
ORDER BY 1, p.name;

SELECT m.created_at,
       t.transfer_number,
       c.name AS city,
       p.name AS product,
       m.type,
       m.qty_delta,
       m.note
FROM public.inventory_movements m
JOIN public.stock_transfers t ON t.id = m.transfer_id
JOIN public.cities c ON c.id = m.city_id
JOIN public.products p ON p.id = m.product_id
WHERE t.transfer_number IN ('T000001', 'T000002')
ORDER BY m.created_at;
