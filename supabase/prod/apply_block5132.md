# Внедрение 5.13.2 — снимок себестоимости на новых order_items

Не выполнять, пока нет явного подтверждения. Env production не менять. SQL к production из этой сессии не применялся.

Не UPDATE старых `order_items`. Не меняет fingerprint, idempotency key, списание склада, блокировки, роли, cancel/debt/preorder RPC. Пишет `cost_price_snapshot` только в **новых** INSERT через `confirm_order`. NULL, если в каталоге нет себестоимости.

## Обязательный порядок приложения и SQL

`SELECT *` / `order_items(*)` после колоночных GRANT без snapshot ломается (PostgreSQL требует SELECT на все колонки). Поэтому:

1. Сначала выкатить приложение с `ORDER_ITEMS_PUBLIC_SELECT` (явный список колонок). Это работает на **старой** схеме.
2. Затем SQL-миграция.
3. Финансовый COGS по snapshot — **не** этот этап (остаётся `admin_product_costs`).

Порядок из постановки «SQL → потом приложение» для этих трёх экранов (`admin/orders`, `seller/debts`, `seller/preorders`) **небезопасен**. Не применять SQL, пока в production ещё есть `order_items(*)`.

## SQL

Файл: `supabase/run_order_item_cost_snapshot.sql` (тот же текст, что `supabase/migrations/20261108220000_order_item_cost_snapshot.sql`).

`confirm_order` взят из `20261108180000_order_customer_fields.sql` (production после блока 562). Изменения: `v_cost`, чтение `products.cost_price`, INSERT `cost_price_snapshot`.

## Резервная копия

```powershell
$env:PROD_DB_URI = "postgresql://postgres.vkdoosnksmezigdrqsxx:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
.\supabase\prod\backup_main.ps1
```

URI не коммитить.

## Порядок после подтверждения

1. Свежий `backup_main.ps1`. Это меняет только локальный/storage backup, не заказы.
2. SQL Editor: `pre_apply_inspect_block5132.sql`.  
   Ожидание: `confirm_order` с `v_cust_canon`; колонка snapshot и RPC **absent**. Если snapshot already present — SQL уже применяли, не повторять blindly; сразу postflight.
3. Проверка GRANT (тот же preflight): `authenticated.select_order_items_table_or_columns=true`, `anon.select_order_items=false`.
4. **Приложение уже с явным select.** Затем SQL Editor: весь `run_order_item_cost_snapshot.sql` одним запуском (`BEGIN`…`COMMIT`).
5. SQL Editor: `post_apply_verify_block5132.sql`. Все PASS, особенно:
   - snapshot nullable numeric(12,2)
   - `existing_rows.not_backfilled_required=all_null` (если в момент apply ещё не было новых заказов)
   - `authenticated.select_snapshot_column=false`
   - `authenticated.select_order_item_id=true` / `qty=true`
   - `rpc.anon_execute=false`, `rpc.admin_gate=true`
   - `confirm_order.fingerprint_omits_cost=true`
   - `confirm_order.stock_update=true`
   - `history.no_cost=ok`
6. Создание заказов: **не создавать тестовые заказы в Production и не трогать остатки.** Проверка — исходник функции + postflight. Сценарии 1–13 — только staging / `scripts/verify_order_item_cost_snapshot.sql`.
7. Если приложение ещё не выкатили — выкатить после SQL нельзя как первый шаг; см. обязательный порядок выше.
8. Post-deploy: повтор `post_apply_verify_block5132.sql`; локально `npx tsx scripts/check-order-cost-snapshot.ts`.

Повторный запуск безопасен (`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`). Строки старых заказов не переписываются.

## Откат

Файл-заготовка: `supabase/prod/rollback_block5132.sql`. Не выполнять без отдельной команды.

1. Вернуть `confirm_order` из backup / `20261108180000` (без snapshot write).
2. `DROP FUNCTION public.admin_order_item_cost_snapshots(uuid[])`.
3. `DROP COLUMN cost_price_snapshot` — заказы и остатки не удаляются.
4. Не `GRANT SELECT ON TABLE order_items`, пока колонка snapshot ещё есть.

Приложение с явным select остаётся совместимым и со старой, и с новой схемой.
