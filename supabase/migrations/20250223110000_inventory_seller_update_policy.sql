-- Разрешить продавцу обновлять остатки в своём городе (для выдачи предзаказа без RPC)
DROP POLICY IF EXISTS "inventory_seller_update" ON inventory;
CREATE POLICY "inventory_seller_update" ON inventory FOR UPDATE
  USING (city_id = get_user_city_id())
  WITH CHECK (city_id = get_user_city_id());
