# Внедрение 5.17.3A/B — SQL-фундамент вознаграждений продавцов

Production: фундамент применён (postflight 23/23 PASS). Не запускать этот SQL повторно на Production. Env production не менять.

Не трогает `confirm_order`, `fulfill_preorder`, `cancel_order`, `finance_expenses`, склад и `buildAdminFinance`. Автоначисления не подключены. Выплаты через RPC ничего не создают, пока их не вызвать.

`pre_apply_inspect` и `post_apply_verify` — только SELECT/`pg_catalog`. Их можно выполнять на Production с правами чтения. Файл `run_seller_commission_foundation.sql` пишет данные — его запускать только после отдельного разрешения.

## SQL

Файл: `supabase/run_seller_commission_foundation.sql` (тот же текст, что `supabase/migrations/20261109010000_seller_commission_foundation.sql`).

Доступ: прямых GRANT на таблицы у `anon`/`authenticated`/`service_role` нет. Мутации тарифов и денег — только активный `admin` через RPC. Manager может читать тарифы/баланс/историю. Seller — только `seller_my_balance` / `seller_my_ledger`.

## Точные команды (после отдельного разрешения на apply)

В PowerShell, URI только в переменной сессии (не в чат, не в git):

```powershell
$env:PROD_DB_URI = "postgresql://postgres.<project>:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
```

1. Backup (только dump, без restore):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "supabase\prod\backup_main.ps1"
```

2. Preflight (SELECT-only, безопасно):

```powershell
psql $env:PROD_DB_URI -v ON_ERROR_STOP=1 -f "supabase\prod\pre_apply_inspect_block5173a.sql"
```

Ожидание: заказы/`confirm_order`/`cancel_order`/`finance_expenses` present; `seller_ledger` и payout RPC **absent**. Все строки `PASS`.

3. Apply (пишет схему — **не запускать без отдельного разрешения**). Весь файл одним запуском:

```powershell
psql $env:PROD_DB_URI -v ON_ERROR_STOP=1 -f "supabase\run_seller_commission_foundation.sql"
```

Либо SQL Editor: вставить целиком `run_seller_commission_foundation.sql` (`BEGIN`…`COMMIT`).

4. Postflight (SELECT-only, безопасно):

```powershell
psql $env:PROD_DB_URI -v ON_ERROR_STOP=1 -f "supabase\prod\post_apply_verify_block5173a.sql"
```

Все PASS, особенно:

- `authenticated.seller_ledger.select/insert=false`
- `service_role.seller_ledger.insert=false`
- `payout.service_role_execute=false`
- `helper.authenticated_execute=false`
- `accrual_item_unique=present`
- `assignments_open_unique=present`
- `confirm_order.untouched=true`
- `cancel_order.untouched=true`

5. Локально (не Production):

```powershell
npx tsx scripts/check-seller-commission-foundation.ts
```

6. Commit/push/UI — только после отдельного разрешения. Этот этап UI не содержит.

## Откат

Откат кода: не требуется, если SQL не применён.  
Если `BEGIN`…`COMMIT` оборвался ошибкой — транзакция откатывается целиком, объектов не остаётся.  
Повторный запуск после успешного COMMIT безопасен (`IF NOT EXISTS` / `CREATE OR REPLACE`).  
Откат уже закоммиченного SQL — только по явной команде: DROP RPC, затем DROP таблиц `seller_goods_issue_items`, `seller_goods_issues`, `seller_ledger`, `seller_rate_overrides`, `seller_tariff_assignments`, `seller_tariff_rates`, `seller_tariff_plans`. Не DROP `confirm_order`. Не выдавать GRANT INSERT authenticated/`service_role` на ledger.
