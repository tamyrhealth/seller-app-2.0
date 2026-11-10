# Внедрение 5.18 — рейтинг продавцов и комиссии на /admin/stats

Не запускать этот SQL на Production без отдельного разрешения. Env production не менять. Не backfill. Не создавать выплаты и начисления. Не менять `seller_ledger`, тарифы, `admin_finance_seller_pnl`, складские RPC и `confirm_order` / `cancel_order` / `fulfill_preorder`.

Только читающая RPC `admin_stats_seller_earnings(p_from date, p_to date)`.

UI `/admin/stats` без этой RPC всё равно показывает выручку и штуки; комиссия тогда «недостаточно данных», не 0 ₸.

## Порядок после отдельного разрешения

1. Backup Production.
2. `supabase/prod/pre_apply_inspect_block518.sql` — все строки PASS, RPC ещё отсутствует.
3. Apply одним файлом: `supabase/run_admin_stats_seller_earnings.sql` (копия `supabase/migrations/20261110180000_admin_stats_seller_earnings.sql`).
4. `supabase/prod/post_apply_verify_block518.sql` — все строки PASS.
5. Reload schema cache PostgREST.
6. Не деплоить и не коммитить из этой задачи.

## Файлы SQL

- runner: `supabase/run_admin_stats_seller_earnings.sql`
- migration: `supabase/migrations/20261110180000_admin_stats_seller_earnings.sql`
- preflight: `supabase/prod/pre_apply_inspect_block518.sql`
- postflight: `supabase/prod/post_apply_verify_block518.sql`
