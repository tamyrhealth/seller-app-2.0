# Внедрение 5.2.2 в текущий проект (без отдельного staging)

Не выполнять, пока нет явного подтверждения. Env production не менять. Тестовые заказы — только после деплоя.

## SQL

Файл: `supabase/run_assistant_order_drafts.sql` (тот же текст, что миграция `20261103290000_assistant_order_drafts.sql`).

Добавляет пустую таблицу `assistant_order_drafts` и RPC. Не трогает `confirm_order`, `orders`, `inventory`, `profiles`, `products`. Нет `DELETE`/`TRUNCATE`/`DROP TABLE` рабочих таблиц.

Зависимости (уже должны быть после 5.1 / 5.2.1): `assistant_chats`, `assistant_messages`, `is_admin()`, `is_assistant_user()`, колонки `orders.idempotency_*`.

## Резервная копия

Локальный дамп `20261103-223102` **устарел** (нет `assistant_generations` / 5.2.1). Перед SQL снять новый:

```powershell
$env:PROD_DB_URI = "postgresql://postgres.vkdoosnksmezigdrqsxx:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
.\supabase\prod\backup_main.ps1
```

Скрипт только читает. URI не коммитить.

## Порядок после подтверждения

1. Свежий `backup_main.ps1`, файлы в `supabase/prod/_generated/<stamp>/` не пустые, в `public_full.list.txt` есть `orders`, `inventory`, `confirm_order`.
2. SQL Editor, **этот** проект: `pre_apply_inspect_block522.sql`.  
   Ожидание: чаты/сообщения/generations есть, `drafts_must_be_null_before_apply` пустой, `confirm_order` и `is_assistant_user` на месте.
3. SQL Editor: весь `run_assistant_order_drafts.sql` одним запуском (`BEGIN`…`COMMIT`).
4. SQL Editor: `post_apply_verify_block522.sql`.  
   Ожидание: RLS on; `auth_insert/update/delete` drafts = false; `save_*` EXECUTE только service_role; `begin_*` EXECUTE authenticated; `begin_checks_owner` true; `drafts_call_confirm_order` false; `existing_drafts` = 0.
5. Commit + push в `master` (Vercel Production). Env не трогать.
6. Дождаться зелёного деплоя. Затем проверка в UI. Заказы до деплоя не создавать.

Если SQL прошёл, а деплой ещё нет: старый UI чат жив; накладная напишет, что нужен SQL 5.2.2 (уже применён — после деплоя фраза пропадёт).  
Если деплой раньше SQL: Q&A работает, карточка заказа не сохранится, пока нет таблицы.

Откат кода: revert commit. Откат SQL: см. ограничения backup ниже, отдельный DROP таблицы только по явной команде (сейчас не выполнять).
