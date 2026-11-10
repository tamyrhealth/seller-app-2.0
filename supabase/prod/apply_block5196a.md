# Внедрение 5.19.6A — серверная защита Auth-сессий

Не запускать этот SQL на Production без отдельного разрешения. Не менять заказы, тарифы, остатки и существующие строки seller_ledger. Не backfill. Не переписывать тела confirm_order / складских / комиссионных RPC.

Не удалять `auth.sessions` и `auth.refresh_tokens` напрямую. Отзыв чужих refresh — только официальный `supabase.auth.signOut({ scope: 'others' })` на клиенте после успешного claim. Немедленный отказ старого access token даёт `assert_active_auth_session` (сравнение `session_id` из JWT с серверной строкой).

## Что меняет SQL

- колонка `user_active_sessions.auth_session_id`;
- `claim_active_auth_session` / `check_active_auth_session` / `assert_active_auth_session`;
- отзыв клиентских INSERT/UPDATE `user_active_sessions`;
- тонкие wrapper’ы мутационных RPC (`confirm_order` и др.) без изменения `__session_body`;
- BEFORE-триггеры на прямые записи `products`, `profiles`, `cities`, `action_logs`, `finance_expenses`, `assistant_chats`, `assistant_messages`.

## Порядок после отдельного разрешения

1. Сообщить сотрудникам: будет повторный вход (JWT без `session_id` или старое устройство). Не backfill.
2. Backup Production.
3. `supabase/prod/pre_apply_inspect_block5196a.sql` — все строки PASS.
4. Apply фазы 1: `supabase/run_assert_active_auth_session.sql` (не wrap RPC, не revoke INSERT).
5. Postflight фазы 1: `supabase/prod/post_apply_verify_block5196a.sql` (или `post_apply_verify_block5196c_phase1.sql`) — все строки PASS. Не ожидать `__session_body`. Фаза 2 и `post_apply_verify_block5196c_phase2.sql` — отдельно.
6. Reload PostgREST schema cache (`claim_active_auth_session`, `check_active_auth_session`).
7. Задеплоить клиент, который await’ит claim после входа и вызывает `signOut({ scope: 'others' })`.
8. Сотрудники открывают приложение: первый claim на живой JWT проходит; второй браузер вытесняется только более новой GoTrue-сессией.

## Rollback (только по отдельной команде)

`supabase/prod/rollback_block5196a.sql` — снимает wrapper’ы, триггеры, claim/assert, возвращает клиентский write на `user_active_sessions`. Колонку `auth_session_id` не удаляет.
