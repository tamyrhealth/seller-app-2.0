# Внедрение 5.17.5 — RPC балансов и даты денежных операций

Production: RPC балансов применены (postflight 9/9 PASS, PostgREST schema cache обновлён). Не запускать этот SQL повторно на Production. Env production не менять.

Не создаёт таблиц. Не переписывает `confirm_order`, хуки начисления, `finance_expenses`. Дата операции = `seller_ledger.accrued_at`; время регистрации = `created_at` (DEFAULT now()). ALTER TABLE не нужен.

Файл: `supabase/run_seller_commission_balance_rpcs.sql`.

После отдельного разрешения: backup → `pre_apply_inspect_block5175.sql` → apply одним файлом → `post_apply_verify_block5175.sql`. Не backfill. Не менять существующие строки ledger вручную.

После apply на Supabase перезагрузить schema cache PostgREST (Dashboard → API → Reload, либо wait). Одна сигнатура `admin_seller_cash_payout` с DEFAULT `p_accrued_at`; вызов без даты остаётся валидным.
