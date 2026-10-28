-- Ручной запуск в Supabase SQL Editor.
-- Скрытие городов без удаления истории заказов и складских операций.
-- Не удаляет города, заказы, inventory и inventory_movements.

ALTER TABLE public.cities
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

UPDATE public.cities
SET is_active = true
WHERE is_active IS NULL;
