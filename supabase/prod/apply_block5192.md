# Внедрение 5.19.2 — hardening привилегий склада

Не запускать этот SQL на Production без отдельного разрешения. Не менять остатки, движения, заказы, тарифы и начисления. Не backfill. Не переписывать RPC.

Только table GRANT/REVOKE на `public.inventory` и `public.inventory_movements`. RLS и функции не меняются. SECURITY DEFINER пишет от имени владельца функции, клиенту достаточно SELECT.

## Порядок после отдельного разрешения

1. Backup Production.
2. `supabase/prod/pre_apply_inspect_block5192.sql` — все строки PASS (TRUNCATE/UPDATE у authenticated ещё true, INSERT движений уже false после 5.17.6D).
3. Apply одним файлом: `supabase/run_harden_inventory_table_privileges.sql`.
4. `supabase/prod/post_apply_verify_block5192.sql` — все строки PASS.
5. Reload schema cache не обязателен (это не RPC). Можно обновить PostgREST cache.

## Rollback (только по отдельной команде)

Восстановить ACL как после 5.17.6D, не как GRANT ALL на движения:

```sql
BEGIN;
GRANT ALL ON TABLE public.inventory TO anon, authenticated;
GRANT SELECT, REFERENCES, DELETE, TRIGGER, TRUNCATE, MAINTAIN, UPDATE
  ON TABLE public.inventory_movements TO anon, authenticated;
COMMIT;
```

## Комиссии (не входит в этот SQL)

Хуки по-прежнему `RAISE WARNING` и не откатывают заказ. Детект без двойного начисления:

1. `admin_seller_missing_accruals_list` — позиции без ledger.
2. Retry только `admin_seller_accrual_retry_item` (уникальный `operation_id`, `missing_rate` не переписывать).
3. Не включать EXCEPTION в confirm-хук без отдельного решения: иначе касса встанет при сбое тарифа.

## Файлы

- runner: `supabase/run_harden_inventory_table_privileges.sql`
- migration: `supabase/migrations/20261110190000_harden_inventory_table_privileges.sql`
- preflight: `supabase/prod/pre_apply_inspect_block5192.sql`
- postflight: `supabase/prod/post_apply_verify_block5192.sql`
