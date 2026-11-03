# Staging для этапа 5.2.2

Изолировано от production: отдельный проект Supabase, отдельные URL/ключи, синтетические пользователи. **Не применять эти SQL к production.**

## Минимум ручных шагов

1. Создать проект Supabase `seller-app-staging` (другой ref, не production).
2. Скопировать `.env.staging.example` → `.env.staging`, заполнить **только** ключи staging.
3. Authentication → Users: пять email из seed (`staging-*-@example.test`), пароли только в `.env.staging`.
4. Schema-only restore **на staging** (читает prod-схему, **не пишет в prod**), затем `apply_run_sql.ps1`.
5. SQL Editor staging: `assert_is_staging.sql`, затем `seed_synthetic.sql`, затем `verify_after_blocks.sql`.
6. Vercel: переменные Preview = staging URL/keys; Production **не трогать**. Либо локально `scripts/dev-staging.ps1` (:3001).
7. Войти как `staging-manager@example.test` и пройти сценарии ниже.

Автоматически: `npx tsx scripts/staging-env-guard.ts` и `npx tsx scripts/staging-assistant-smoke.ts`.

---

## Почему не «пустой» проект с одними migrations

Файлы в `supabase/migrations` — это дельты поверх уже существующей схемы (`cities`, `orders`, `confirm_order`, …). Пустой Supabase ими не поднимется. Базовая схема staging берётся **schema-only dump** (без строк таблиц, без телефонов). Блоки 5.1–5.2.2 накатываются `run_*.sql`.

## Защита от production

| Механизм | Что делает |
|---|---|
| `assert_is_staging.sql` | Стоп, если `orders > 20` |
| `seed_synthetic.sql` | То же + только email `staging-*@example.test` |
| `apply_run_sql.ps1` / `restore_public_schema.ps1` | URI обязан содержать `STAGING_PROJECT_REF`; отказ, если URI = prod |
| `staging-env-guard.ts` | Staging URL ≠ `.env.local`; service_role ≠ prod |
| Vercel Preview | Отдельные env, **не** All Environments для Supabase |

`.env.local` (prod) **не переписывать**. Локальный staging: `scripts/dev-staging.ps1` (порт 3001, переменные из `.env.staging` перекрывают shell).

---

## Шаг 1. Проект Supabase

Dashboard → New project → имя `seller-app-staging`.

Скопировать в `.env.staging`:

- Project ref
- Project URL
- `anon` `public`
- `service_role` (**staging**, не production)
- Direct/session URI для `psql` (порт 5432)

Auth → Providers → Email включён. Confirm email можно выключить для тестовых ящиков.

Создать пользователей (Add user, auto-confirm):

| Email | Роль после seed |
|---|---|
| `staging-admin@example.test` | admin |
| `staging-manager@example.test` | manager |
| `staging-manager-b@example.test` | manager (чужой черновик) |
| `staging-seller@example.test` | seller «Айгүл», STAGING City |
| `staging-seller-b@example.test` | seller «Айгүл», STAGING City B |

Пароли не из production.

## Шаг 2. Схема

Нужны клиенты `pg_dump` и `psql`. **Только в текущем окне PowerShell:**

```powershell
$env:PROD_PROJECT_REF = "<prod-ref>"          # чтобы скрипт отказал, если URI перепутан
$env:PROD_DB_URI = "postgresql://postgres:<urlencoded-password>@db.<prod-ref>.supabase.co:5432/postgres"
$env:STAGING_PROJECT_REF = "<staging-ref>"
$env:STAGING_DB_URI = "postgresql://postgres:<urlencoded-password>@db.<staging-ref>.supabase.co:5432/postgres"

# 1) Чтение схемы prod, запись ТОЛЬКО в staging (без COPY данных)
.\supabase\staging\restore_public_schema.ps1

# 2) 5.1, 5.1.1 hotfix, 5.2.1, 5.2.2 и предшествующие run_*.sql
.\supabase\staging\apply_run_sql.ps1
```

`pg_dump --schema-only` не копирует заказы и телефоны. Скрипт обрывается, если в дампе вдруг есть `COPY public.orders`.

Если staging **уже** был восстановлен ранее — restore можно пропустить, выполнить только `apply_run_sql.ps1` (идемпотентно).

## Шаг 3. Проверка и seed

В SQL Editor **staging** (не production), по очереди:

1. `supabase/staging/assert_is_staging.sql`
2. `supabase/staging/seed_synthetic.sql`
3. `supabase/staging/verify_after_blocks.sql`

Ожидание verify: `auth_insert_drafts = false`, есть `assistant_order_drafts`, `confirm_order` EXECUTE у authenticated, `orders_must_stay_low` маленький.

Дополнительно (SELECT-only):  
`post_apply_verify_block51.sql`, `...511.sql`, `...511_hotfix.sql`, `...521.sql`, `...522.sql`.

## Шаг 4. Приложение

### Вариант A — локально, без Vercel

```powershell
.\scripts\dev-staging.ps1
```

Открыть http://localhost:3001 → `/manager/assistant`.  
`OPENAI_API_KEY` в `.env.staging` (можно тот же ключ OpenAI; **не** production `service_role`).

### Вариант B — Vercel Preview (ещё без commit)

Пока commit/push не делаем. Когда будете готовы: Preview env **отдельно** от Production.

В Vercel → Project → Settings → Environment Variables:

| Variable | Production | Preview / Development |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | prod URL, env **Production only** | staging URL, **Preview only** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | prod anon, Production only | staging anon, Preview only |
| `SUPABASE_SERVICE_ROLE_KEY` | prod service, Production only | **staging** service, Preview only |
| `OPENAI_API_KEY` | как есть | можно тот же OpenAI |

Если сейчас URL стоит на **All Environments** — Preview ходит в production. Перед первым Preview-деплоем сузить Production-only и добавить Preview-only staging. **Значения Production не менять**, только Environment scope и новые Preview-строки.

Проверка: открыть Preview, в DevTools Network любой REST — хост `*.supabase.co` = staging ref, не prod.

## Шаг 5. Сценарии 5.2.2

Войти **manager** `staging-manager@example.test`.

Тестовый телефон только синтетический: `77001112233` (не из клиентской базы).

### Обычный заказ

```
Айгүл
2 Чай
1 Драже
Kaspi
```

Ожидание: карточка, город STAGING City, цены 500 и 300, сумма 1300, «Подтвердить заказ» активно. После подтверждения `Заказ N…`, остаток чая 18, драже 19.

Не использовать «2 порошок» в счастливом пути: в seed есть и «Порошок», и «Порошок детский».

### Неоднозначность

- `2 порошок` → подтверждение заблокировано, два товара.
- `Айгүл` без города → два продавца, заблокировано. С `STAGING City` — один.

### Недостаток остатка

`25 Чай` в STAGING City → блок, остаток 20.

### Смена цены до подтверждения

Черновик с Чай → в SQL staging: `UPDATE products SET price_retail = 999 WHERE name = 'Чай';` → «Подтвердить» → 409, заказ не создан. Вернуть `500` перед другими тестами.

### Дубль / две вкладки / timeout

Один подтверждённый черновик: второе нажатие и вторая вкладка — тот же номер, одно списание. Chrome DevTools → Slow 3G: 202 затем автоповтор 2 с или повтор кнопки — тот же N.

После успеха сменить цену и снова нажать «Подтвердить» на **той же** карточке — снова тот же номер, не 409.

### Чужой доступ

- Manager B: `POST /api/assistant/orders/confirm` с `draftId` первого → 403.
- Admin `/admin/assistant` аудит: кнопок нет; тот же POST → 403.
- Seller: `/api/assistant/chat` и `/confirm` → 403.
- Тело `{ draftId, seller_id, city_id, total_sum }` с чужими UUID — берутся только поля черновика.

### Совместимость UI

`/manager/new-order` на Айгүл / STAGING City — обычный заказ, нумерация N продолжается, остатки сходятся.

---

## Что вручную / что скриптом

| Действие | Кто |
|---|---|
| Создать проект, users, Vercel Preview env | вы |
| `restore_public_schema.ps1`, `apply_run_sql.ps1` | вы (скрипт пишет только в staging) |
| `assert` / `seed` / `verify` в SQL Editor staging | вы |
| `staging-env-guard.ts`, `staging-assistant-smoke.ts` | скрипт (без создания заказов) |
| Карточка, timeout, две вкладки, Slow 3G | вы в UI |
| `staging-confirm-order-tests.ts` | опционально, создаёт заказ на «STAGING Last Unit» (qty=1) |

Не использовать production `service_role` в `.env.staging` и в Vercel Preview.
