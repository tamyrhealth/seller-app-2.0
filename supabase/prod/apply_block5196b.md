# Внедрение 5.19.6B — двухфазная защита Auth-сессий

Не запускать этот SQL на Production без отдельного разрешения. Не менять заказы, тарифы, остатки. Не backfill. Не переписывать тела confirm_order / склада / комиссий. Не удалять `auth.sessions` / `auth.refresh_tokens`.

Отзыв чужих refresh — только `supabase.auth.signOut({ scope: 'others' })` после **allowed** claim. Не вызывать при UNKNOWN и при сетевой ошибке. Текущую сессию это не завершает (`others`, не `global`).

## Зачем две фазы

Одновременный wrap RPC + новый клиент останавливает продажи: старый клиент не делает claim, новый клиент падает, если RPC ещё нет.

1. **Фаза 1 (additive):** `claim` / `check` / `assert`, колонка `auth_session_id`. Старый клиент по-прежнему пишет `device_id` и вызывает незащищённые RPC. Новый клиент: нет RPC → check=allowed (продажи идут), claim=unknown (без signOut / без others).
2. **Клиент:** деплой с await claim. Дождаться, что сотрудники открыли приложение (повторный вход не обязателен, пока фаза 2 не включена).
3. **Фаза 2 (enforce):** wrapper RPC, revoke write на `user_active_sessions`, триггеры. Старый клиент без claim больше не проводит мутации. Новый клиент уже claim’ит.

## Порядок после отдельного разрешения

1. Уведомить сотрудников: после фазы 2 второй браузер будет вытесняться; при ошибке «Active session required» обновить страницу / войти снова. Не останавливать точки заранее.
2. Backup Production.
3. `supabase/prod/pre_apply_inspect_block5196a.sql` — все PASS.
4. Фаза 1: `supabase/run_assert_active_auth_session.sql`. Reload PostgREST (`claim_active_auth_session`, `check_active_auth_session`).
5. Postflight фазы 1: `supabase/prod/post_apply_verify_block5196c_phase1.sql` — все PASS. Не использовать старый phase-2 verifier до enforce.
6. Задеплоить клиент. Авторизованный smoke: вход admin/seller, claim проходит, заказ/остатки ещё работают на старом RPC.
7. Фаза 2: `supabase/run_assert_active_auth_session_enforce.sql`. Reload PostgREST.
8. Postflight фазы 2: `supabase/prod/post_apply_verify_block5196c_phase2.sql` — все PASS, плюс `SELECT * FROM public.auth_session_guard_integrity();` без FAIL.
9. Авторизованный smoke (без выдуманных денег в отчёте, но с реальной сессией):
   - первый вход / уже открытая вкладка;
   - две вкладки того же браузера;
   - второй браузер → UI denied, RPC старого JWT отказ;
   - сеть offline → нет signOut;
   - admin правка товара после claim.
10. Критерии немедленного rollback фазы 2: массовые `Active session required` у сотрудников на актуальном клиенте; нельзя войти; обёртка сняла тело RPC (integrity FAIL и заказы не создаются).

## Rollback

Немедленный: `supabase/prod/rollback_block5196a.sql` — снимает wrapper/триггеры, возвращает INSERT/UPDATE (не DELETE) на `user_active_sessions`, дропает claim (полный откат к клиенту до 5.19.6). После rollback нужен клиент, который снова умеет upsert `device_id`, либо повторно накатить фазу 1+клиент.

Колонку `auth_session_id` не удаляет.
