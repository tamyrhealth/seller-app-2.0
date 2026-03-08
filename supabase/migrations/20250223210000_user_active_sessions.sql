-- Один активный device на пользователя
CREATE TABLE IF NOT EXISTS public.user_active_sessions (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  last_seen_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE public.user_active_sessions ENABLE ROW LEVEL SECURITY;

-- Пользователь может читать только свою запись
CREATE POLICY "user_active_sessions_select_own"
  ON public.user_active_sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Пользователь может вставить только свою запись
CREATE POLICY "user_active_sessions_insert_own"
  ON public.user_active_sessions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Пользователь может обновлять только свою запись
CREATE POLICY "user_active_sessions_update_own"
  ON public.user_active_sessions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Admin может читать все записи
CREATE POLICY "user_active_sessions_select_admin"
  ON public.user_active_sessions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
