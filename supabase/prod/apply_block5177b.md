# Внедрение 5.17.7 — агрегаты комиссий и финансовый отчёт

Не запускать этот SQL на Production без отдельного разрешения. Env production не менять. Не backfill. Не создавать выдачи, выплаты и начисления. Не менять finance_expenses. Не переписывать `confirm_order`, `cancel_order`, `fulfill_preorder`, хуки начисления и складские RPC.

Только читающая RPC `admin_finance_seller_pnl(p_from date, p_to date)`.

## Порядок после отдельного разрешения

1. Backup Production.
2. `supabase/prod/pre_apply_inspect_block5177b.sql` — все строки PASS, RPC ещё отсутствует.
3. Apply одним файлом: `supabase/run_admin_finance_seller_pnl.sql` (копия `supabase/migrations/20261110160000_admin_finance_seller_pnl.sql`).
4. `supabase/prod/post_apply_verify_block5177b.sql` — все строки PASS.
5. Reload schema cache PostgREST (`NOTIFY pgrst, 'reload schema'` или restart API).
6. Только после PASS postflight и reload — публикация UI (`/admin/finance`). UI без применённого SQL покажет «Финансовый расчёт не полностью подключён» и не выдаст старую прибыль как окончательную.

Не деплоить UI до SQL. Не применять SQL из этого чата автоматически.

## Файлы SQL

- runner: `supabase/run_admin_finance_seller_pnl.sql`
- migration: `supabase/migrations/20261110160000_admin_finance_seller_pnl.sql`
- preflight: `supabase/prod/pre_apply_inspect_block5177b.sql`
- postflight: `supabase/prod/post_apply_verify_block5177b.sql`
