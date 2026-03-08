-- Таблица логов действий пользователей
CREATE TABLE IF NOT EXISTS public.action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  user_id uuid NULL,
  user_name text NULL,
  user_role text NULL,
  action text NOT NULL,
  entity_type text NULL,
  entity_id text NULL,
  details jsonb DEFAULT '{}'::jsonb
);

-- Индекс для поиска по времени
CREATE INDEX IF NOT EXISTS idx_action_logs_created_at ON public.action_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_user_id ON public.action_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_action_logs_entity ON public.action_logs (entity_type, entity_id);

-- RLS: только чтение для admin, вставка для аутентифицированных
ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "action_logs_insert_authenticated"
  ON public.action_logs FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "action_logs_select_admin"
  ON public.action_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
