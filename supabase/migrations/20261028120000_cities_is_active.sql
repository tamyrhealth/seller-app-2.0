-- Скрытие городов без удаления. Запускать вручную (см. также supabase/run_cities_is_active.sql).

ALTER TABLE public.cities
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
