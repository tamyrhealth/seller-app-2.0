# Внедрение 5.17.4 — автоначисления вознаграждений

Production: хуки начисления применены (postflight 10/10 PASS). Не запускать этот SQL повторно на Production. Env production не менять. Старые заказы не бэкфиллятся.

Требует уже применённый фундамент 5.17.3A (`seller_ledger` и тарифные RPC). Не переписывает `confirm_order`, `fulfill_preorder`, `cancel_order`. Хуки — AFTER INSERT `order_items` и AFTER UPDATE `orders`. Старые заказы не бэкфиллятся.

Файл: `supabase/run_seller_commission_accrual_hooks.sql`.

Политика ошибок: сбой **начисления** не откатывает заказ (WARNING). Сбой **сторно** откатывает отмену — повтор cancel безопаснее, чем выплата после отмены. Позиции с ledger нельзя менять/удалять (FK RESTRICT + триггер). `missing_rate` не переписывается; точечный retry только если строки начисления нет.

После отдельного разрешения: backup → `pre_apply_inspect_block5174.sql` → apply одним файлом → `post_apply_verify_block5174.sql`.
