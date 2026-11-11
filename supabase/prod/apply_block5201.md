# 5.20.1 / 5.20.1B — совместный выпуск SQL + клиента

Не запускать без отдельного разрешения.
Phase 2 уже на Production — этот шаг его не повторяет.
Не переписывать confirm_order / cancel / mark_debt_paid / fulfill_preorder.
Не удалять и не создавать тестовые заказы/оплаты.

SQL и клиент с `complete_seller_debt_pay` выпускаются в одном окне.
Текущий Production-клиент пишет `orders` напрямую; после SQL это сломает `/seller/debts`.
Новый клиент без SQL получит отсутствующий RPC.

## Порядок

1. Backup
2. Read-only inspect + preflight (все PASS, иначе STOP)
3. Apply SQL (одна транзакция)
4. Postflight (все PASS) + reload PostgREST
5. Сразу выложить клиент с `app/seller/debts/page.tsx` → `complete_seller_debt_pay`
6. Smoke без новых заказов: SELECT долгов; погашение только на реальном активном долге по бизнесу, либо отложить. Прямой table update должен получить отказ.

## Команды

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "supabase\prod\backup_main.ps1"
psql $env:PROD_DB_URI -X -v ON_ERROR_STOP=1 -f "supabase\prod\inspect_block5201_orders_readonly.sql"
psql $env:PROD_DB_URI -X -v ON_ERROR_STOP=1 -f "supabase\prod\pre_apply_inspect_block5201.sql"
psql $env:PROD_DB_URI -X -v ON_ERROR_STOP=1 -f "supabase\run_orders_protect_client_updates.sql"
psql $env:PROD_DB_URI -X -v ON_ERROR_STOP=1 -f "supabase\prod\post_apply_verify_block5201.sql"
```

Затем reload schema cache PostgREST, затем commit/push клиента (отдельное разрешение).

## Откат при ошибке

Если postflight FAIL — не выкладывать клиент:

```powershell
psql $env:PROD_DB_URI -X -v ON_ERROR_STOP=1 -f "supabase\prod\rollback_block5201.sql"
```

Если клиент уже выложен, а SQL откатили: вернуть предыдущий Vercel deployment (страница долгов снова table UPDATE + `mark_debt_paid`).

Phase 2 этим rollback не снимать.
Rollback `order_items` возвращает column-level INSERT/UPDATE (5.13.2), без table-level INSERT.
