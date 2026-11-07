# Внедрение 5.4.2 — защита action_logs и история заказов

Не выполнять, пока нет явного подтверждения. Env production не менять. SQL к production из этой сессии не применялся.

Не трогает `confirm_order` (списание и идемпотентность как есть). Не UPDATE/DELETE строк `action_logs`. Не трогает 5.2.6 и 5.4.1. **Не заменяет `apply_order_cancel_report`** — отмена остаётся production-функцией 5.2.3. Повторная отмена в UI читается из `details.already_canceled`.

## SQL

Файл: `supabase/run_action_logs_protect_and_order_history.sql` (тот же текст, что `supabase/migrations/20261107200000_action_logs_protect_and_order_history.sql`).

Создание заказа логируется отложенным CONSTRAINT TRIGGER в конце той же транзакции, после `INSERT total_sum=0`, позиций и `UPDATE total_sum`. Повтор `confirm_order` с тем же ключом не делает второй INSERT — второго события создания нет.

## Резервная копия

```powershell
$env:PROD_DB_URI = "postgresql://postgres.vkdoosnksmezigdrqsxx:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
.\supabase\prod\backup_main.ps1
```

URI не коммитить.

## Порядок после подтверждения

1. Свежий `backup_main.ps1`, в дампе есть `orders`, `action_logs`, `confirm_order`, `log_order_action`.
2. SQL Editor: `pre_apply_inspect_block542.sql`.  
   Ожидание: INSERT-политика ещё есть, `order_history_item_snapshot` отсутствует, `confirm_order` и `find_similar_orders` на месте.  
   По желанию read-only `inspect_block542_cancel_def.sql`: `has_new_already_action` должен быть false (функцию 5.4.2 не переписывает).
3. SQL Editor: весь `run_action_logs_protect_and_order_history.sql` одним запуском (`BEGIN`…`COMMIT`).
4. SQL Editor: `post_apply_verify_block542.sql`.  
   Все PASS, особенно `authenticated.insert=false`, `trigger.deferred=true`, `confirm_order.unchanged_insert_zero=true`.
5. Commit + push приложения после SQL. Env не трогать.
6. Проверка UI карточки заказа admin: создание с суммой и составом, отмена, повторная отмена, выдача, долг.

Откат кода: revert commit. Откат SQL — только по явной команде (восстановить INSERT-политику опасно; функцию лога можно вернуть из backup).
