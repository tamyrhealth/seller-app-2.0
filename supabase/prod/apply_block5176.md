# Внедрение 5.17.6C — выдача товаров продавцам в счёт вознаграждения

Не запускать этот SQL на Production без отдельного разрешения. Env production не менять. Не backfill. Не создавать реальные выдачи и возвраты.

Не создаёт таблиц. Добавляет `issue_number` / `issue_kind`, уникальный полный возврат, одноразовое заполнение `ledger_id`, типы движений `seller_goods_out` / `seller_goods_in`, RPC выдачи и возврата. Не переписывает `confirm_order`, хуки начисления, `finance_expenses`, P&L.

Файл: `supabase/run_seller_goods_issue_rpcs.sql`.

После отдельного разрешения: backup → `pre_apply_inspect_block5176.sql` → apply одним файлом → `post_apply_verify_block5176.sql`. После apply на Supabase перезагрузить schema cache PostgREST.
