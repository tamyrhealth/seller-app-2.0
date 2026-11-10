# Внедрение 5.19.4 — обнаружение пропущенных начислений

Не запускать этот SQL на Production без отдельного разрешения. Не менять заказы, тарифы, остатки и существующие строки seller_ledger. Не backfill. Не переписывать confirm_order.

SQL только:

- список позиций без начисления (`admin_seller_unaccrued_items_list`);
- SELECT-only сводка расхождений (`admin_seller_accrual_consistency_summary`);
- ужесточение `admin_seller_accrual_retry_item`: не создавать missing_rate-снимок; ставка на момент продажи; **запрет Retry, если winning assignment/rate/override имеет `created_at` позже продажи** (задний `effective_from`).

Хуки по-прежнему `RAISE WARNING` и не откатывают заказ. Это согласовано отдельно.

## Порядок после отдельного разрешения

1. Backup Production.
2. `supabase/prod/pre_apply_inspect_block5194.sql` — все строки PASS.
3. Apply одним файлом: `supabase/run_seller_commission_unaccrued_detect.sql`.
4. `supabase/prod/post_apply_verify_block5194.sql` — все строки PASS.
5. Reload PostgREST schema cache (новые RPC).

## Как исправляет администратор

1. `/admin/seller-tariffs`: блок «Сбои начисления» — только `hook_skip` (тариф на дату продажи есть, строки ledger нет).
2. Кнопка «Досчитать» вызывает существующий `admin_seller_accrual_retry_item` по одной позиции.
3. `missing_rate` (ставка не была задана) остаётся отдельным списком и не переписывается.
4. `no_tariff_at_sale` и `backdated_tariff` — без Retry. Не назначать тариф задним числом ради досчёта.

## Rollback (только по отдельной команде)

Вернуть предыдущее тело `admin_seller_accrual_retry_item` из `run_seller_commission_accrual_hooks.sql`.  
`DROP FUNCTION` list/summary и `seller_commission_tariff_recorded_by_sale`. Хуки заказа не трогать.
