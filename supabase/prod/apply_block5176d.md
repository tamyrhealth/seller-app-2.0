# 5.17.6D — REVOKE INSERT на inventory_movements для browser-ролей

Не запускать без отдельного разрешения. Не повторять миграцию 5.17.6. Не менять остатки, движения, балансы и заказы.

Причина FAIL 5.17.6 postflight: табличное `GRANT ALL` на `inventory_movements` для `authenticated` (и `anon`) было в Production **до** 5.17.6. Миграция 5.17.6 меняла только CHECK `type`, не GRANT. INSERT-политики RLS нет, прямая запись клиента блокируется RLS; RPC пишут через SECURITY DEFINER.

Файл: `supabase/run_revoke_inventory_movements_client_insert.sql`.

После разрешения:

1. Backup.
2. `pre_apply_inspect_block5176d.sql` — ожидается `authenticated.inventory_movements.insert = true`.
3. Применить **одним файлом** `run_revoke_inventory_movements_client_insert.sql`.
4. `post_apply_verify_block5176d.sql` — INSERT у authenticated/anon = false, SELECT остаётся, service_role INSERT остаётся.
5. Повторно `post_apply_verify_block5176.sql` — ожидается 23/23, в том числе `authenticated.inventory_movements.insert = false`.

Не backfill. PostgREST reload не обязателен (это table GRANT, не RPC), но можно обновить cache.
