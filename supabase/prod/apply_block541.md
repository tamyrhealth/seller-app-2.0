# Внедрение 5.4.1 — поиск похожих заказов (без отдельного staging)

Не выполнять, пока нет явного подтверждения. Env production не менять. SQL к production из этой сессии не применялся.

## SQL

Файл: `supabase/run_find_similar_orders.sql` (тот же текст, что миграция `20261107120000_find_similar_orders.sql`).

Добавляет read-only RPC `find_similar_orders(p jsonb)` и индекс по `orders(seller_id, city_id, created_at)`. Не трогает `confirm_order`, идемпотентность, списание, `action_logs`, права 5.2.6, глобальные unique по составу.

## Резервная копия

Перед SQL снять свежий дамп:

```powershell
$env:PROD_DB_URI = "postgresql://postgres.vkdoosnksmezigdrqsxx:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
.\supabase\prod\backup_main.ps1
```

Скрипт только читает. URI не коммитить.

## Порядок после подтверждения

1. Свежий `backup_main.ps1`, файлы в `supabase/prod/_generated/<stamp>/` не пустые, в `public_full.list.txt` есть `orders`, `order_items`, `confirm_order`.
2. SQL Editor, **этот** проект: `pre_apply_inspect_block541.sql`.  
   Ожидание: `confirm_order_present` PASS, `find_similar_orders_absent_before_apply` PASS.
3. SQL Editor: весь `run_find_similar_orders.sql` одним запуском (`BEGIN`…`COMMIT`).
4. SQL Editor: `post_apply_verify_block541.sql`.  
   Ожидание: все PASS, особенно `service_role_execute=false`, `no_writes=true`, `confirm_order.still_present`.  
   `search_path` и `row_security_off` читаются из `pg_proc.proconfig`, не из текста `CREATE` в `pg_get_functiondef` (`SET ... TO '...'`).
5. Commit + push приложения **после** SQL (Vercel Production). Env не трогать.
6. Дождаться зелёного деплоя. Затем проверка в UI: форма продавца, форма admin/manager, ИИ-карточка.

Повторный запуск `run_find_similar_orders.sql` безопасен: `CREATE OR REPLACE` + `CREATE INDEX IF NOT EXISTS` + повторные GRANT/REVOKE, без DROP рабочих таблиц. Preflight `find_similar_orders_absent_before_apply` — только для **первого** применения; при повторном прогоне этот check будет FAIL, остальные preflight и сам SQL можно выполнять.

Если SQL прошёл, а деплоя нет: старый UI жив, RPC никто не вызывает.  
Если деплой раньше SQL: подтверждение остановится с явной ошибкой «Сначала примените SQL этапа 5.4.1».

Откат кода: revert commit. Откат SQL: `DROP FUNCTION public.find_similar_orders(jsonb);` и при необходимости `DROP INDEX IF EXISTS orders_find_similar_seller_city_created_idx;` — только по явной команде (сейчас не выполнять).
