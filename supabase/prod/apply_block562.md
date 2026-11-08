# Внедрение 5.6.2 — клиент на всех новых заказах

Не выполнять, пока нет явного подтверждения. Env production не менять. SQL к production из этой сессии не применялся.

Не UPDATE старых заказов. Не меняет списание склада, подарки, предзаказ, отмены, признание выручки, RLS/GRANT `orders`. Добавляет nullable `customer_name` / `customer_phone` / `customer_phone_canon` и пишет их только в **новых** `INSERT` через `confirm_order`.

## Идемпотентность (не bump v3 → v4)

Клиентский `localStorage` ключ остаётся `seller-app:order-idempotency:v3`. SQL fingerprint для обычного заказа **без** имени/телефона совпадает с текущим production (те же jsonb-ключи). Extra-ключи `customer_name`/`customer_phone` добавляются только если в новом обычном/предзаказе есть имя или телефон.

Смена store на v4 **запрещена**: pending-ключи после обновления приложения были бы брошены, повтор с новым uuid мог создать дубль.

Старый payload без `customer_*` принимается. Повтор с тем же ключом и тем же составом возвращает существующий id. Тот же ключ с другим клиентом → `Idempotency key reused with a different order payload` (клиент инвалидирует ключ).

## SQL

Файл: `supabase/run_order_customer_fields.sql` (тот же текст, что `supabase/migrations/20261108180000_order_customer_fields.sql`).

`confirm_order` взят из дампа `supabase/prod/_generated/20261108-153703/confirm_order_before.sql`. Изменена только клиентская запись и условный fingerprint.

## Резервная копия

```powershell
$env:PROD_DB_URI = "postgresql://postgres.vkdoosnksmezigdrqsxx:<URL-ENCODED-PASSWORD>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
.\supabase\prod\backup_main.ps1
```

URI не коммитить.

## Порядок после подтверждения

1. Свежий `backup_main.ps1`.
2. SQL Editor: `pre_apply_inspect_block562.sql`.  
   Ожидание: `confirm_order`/`find_similar_orders` present; колонки клиента и `kz_normalize_customer_phone` **absent**. Если колонки уже present — SQL уже применяли, не повторять blindly; сразу postflight.
3. SQL Editor: весь `run_order_customer_fields.sql` одним запуском (`BEGIN`…`COMMIT`).
4. SQL Editor: `post_apply_verify_block562.sql`.  
   Все PASS, особенно:
   - колонки nullable
   - `kz_normalize.authenticated_execute=false` и `kz_normalize.anon_execute=false`
   - `confirm_order.anon_execute=false`
   - `confirm_order.stock_update=true`
   - `confirm_order.legacy_fp_keys=true`
   - `find_similar.no_name_match=true` (не по имени)
   - `find_similar.service_role_execute=false`
   - `orders.seller_select_policy` / `orders.staff_select_policy` present
5. Локально: `npx tsx scripts/check-order-customer.ts`; `npx tsx scripts/check-customer-phone.ts`. Опционально (не production): `scripts/verify_kz_normalize_customer_phone.sql`.
6. Commit/push приложения — только после отдельного разрешения.

Повторный запуск безопасен (`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`). Строки старых заказов не переписываются.

## Откат

Откат кода: не требуется, если SQL не применён.  
Откат SQL — только по явной команде: вернуть предыдущий `confirm_order`/`find_similar_orders` из backup; `DROP FUNCTION public.kz_normalize_customer_phone(text)`; колонки можно оставить nullable. Не DROP `confirm_order`. Не UPDATE существующих заказов «очисткой» телефонов без отдельного разрешения.
