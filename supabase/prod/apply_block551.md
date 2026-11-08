# Внедрение 5.5.1 — журнал финансовых расходов

Не выполнять, пока нет явного подтверждения. Env production не менять. SQL к production из этой сессии не применялся.

Не трогает `confirm_order`, склад, `cost_price`, выплаты продавцам и P&L. Расходы только записываются. Общие расходы не распределяются по городам автоматически. Жёсткого DELETE нет — только soft delete и таблица событий.

## SQL

Файл: `supabase/run_finance_expenses.sql` (тот же текст, что `supabase/migrations/20261108140000_finance_expenses.sql`).

Доступ: прямых GRANT на таблицы у `anon`/`authenticated` нет. Операции только через RPC под активным `admin`. `created_by` всегда `auth.uid()`. Повтор того же `operation_id` с тем же payload возвращает существующую строку.

## Резервная копия

```powershell
$env:PROD_DB_URI = "postgresql://postgres.vkdoosnksmezigdrqsxx:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
.\supabase\prod\backup_main.ps1
```

URI не коммитить.

## Порядок после подтверждения

1. Свежий `backup_main.ps1`.
2. SQL Editor: `pre_apply_inspect_block551.sql`.  
   Ожидание: `cities`/`profiles`/`confirm_order` present; таблицы и RPC финансов **absent**.
3. SQL Editor: весь `run_finance_expenses.sql` одним запуском (`BEGIN`…`COMMIT`).
4. SQL Editor: `post_apply_verify_block551.sql`.  
   Все PASS, особенно:
   - `authenticated.finance_expenses.select/insert/update/delete=false`
   - `create.service_role_execute=false`
   - `helper.authenticated_execute=false`
   - `operation_id_unique=present`
   - `soft_delete.not_hard=true`
5. Локально: `npx tsx scripts/check-finance-expenses.ts`. При наличии локального Postgres: `scripts/verify_finance_expenses.sql` (не на production).
6. Commit/push приложения — только после отдельного разрешения. UI финансов в этом этапе нет.

## Откат

Откат кода: не требуется, если SQL не применён.  
Откат SQL — только по явной команде: DROP RPC; `DROP TRIGGER finance_expense_events_protect_trg` затем DROP таблиц `finance_expense_events`, `finance_expenses`, `finance_expense_categories`; затем `is_active_admin`, если больше нигде не используется. Не DROP `confirm_order`. Не восстанавливать GRANT SELECT authenticated на расходы. Не выдавать UPDATE/DELETE на audit events.
