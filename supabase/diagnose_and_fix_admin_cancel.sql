-- =============================================================================
-- ШАГ 2. ДИАГНОСТИКА — выполни в Supabase SQL Editor и пришли результат.
-- =============================================================================

-- 2.1 Все функции с именем admin_cancel_order или cancel_preorder во всех схемах
SELECT n.nspname AS schema, p.proname, oidvectortypes(p.proargtypes) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname IN ('admin_cancel_order', 'cancel_preorder');

-- 2.2 Наличие и права для public.admin_cancel_order
SELECT
  n.nspname AS schema,
  p.proname,
  oidvectortypes(p.proargtypes) AS args,
  has_function_privilege('authenticated', p.oid, 'execute') AS auth_can_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'admin_cancel_order';


-- =============================================================================
-- ШАГ 3. ФИНАЛЬНЫЙ ФИКС — выполни этот блок целиком в том же проекте Supabase.
-- Удаляет все перегрузки, создаёт одну функцию, даёт права.
-- =============================================================================

-- Колонка для причины отмены (если ещё нет)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

-- Удалить все возможные варианты функции (по сигнатуре)
DROP FUNCTION IF EXISTS public.admin_cancel_order(uuid, text);
DROP FUNCTION IF EXISTS public.admin_cancel_order(uuid);

-- Создать ровно одну функцию
CREATE OR REPLACE FUNCTION public.admin_cancel_order(p_order_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admin can cancel orders';
  END IF;

  UPDATE public.orders
  SET
    status = 'canceled',
    cancelled_at = now(),
    cancelled_reason = p_reason,
    updated_at = now()
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_cancel_order(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_order(uuid, text) TO service_role;


-- =============================================================================
-- После выполнения фикса — проверка (должна вернуть ровно одну строку):
--   public | admin_cancel_order | uuid, text | t
-- =============================================================================
SELECT
  n.nspname AS schema,
  p.proname,
  oidvectortypes(p.proargtypes) AS args,
  has_function_privilege('authenticated', p.oid, 'execute') AS auth_can_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'admin_cancel_order';
