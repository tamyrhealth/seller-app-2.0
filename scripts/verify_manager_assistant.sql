-- Local PostgreSQL 17 security harness for Block 5.1. Not for production.
BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text,
  role text NOT NULL,
  city_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'seller'::text])))
);

ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'seller'::text, 'manager'::text]));
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS can_cancel_orders boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.get_user_role() = 'admin';
$$;
CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.get_user_role() = 'manager';
$$;
CREATE OR REPLACE FUNCTION public.is_assistant_user()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.get_user_role() IN ('admin', 'manager');
$$;

CREATE TABLE public.assistant_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id),
  title text NOT NULL DEFAULT 'Новый диалог',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_chats_title_check CHECK (char_length(btrim(title)) > 0 AND char_length(title) <= 120)
);
CREATE TABLE public.assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.assistant_chats(id) ON DELETE CASCADE,
  author_id uuid REFERENCES public.profiles(id),
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  client_message_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_messages_role_check CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text]))
);
CREATE UNIQUE INDEX assistant_messages_client_id_uidx
  ON public.assistant_messages (chat_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

ALTER TABLE public.assistant_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY assistant_chats_select ON public.assistant_chats
  FOR SELECT TO PUBLIC
  USING (public.is_admin() OR (public.is_assistant_user() AND owner_id = auth.uid()));
CREATE POLICY assistant_chats_insert ON public.assistant_chats
  FOR INSERT TO PUBLIC
  WITH CHECK (owner_id = auth.uid() AND public.is_assistant_user());
CREATE POLICY assistant_chats_update ON public.assistant_chats
  FOR UPDATE TO PUBLIC
  USING (owner_id = auth.uid() AND public.is_assistant_user())
  WITH CHECK (owner_id = auth.uid() AND public.is_assistant_user());
CREATE POLICY assistant_messages_select ON public.assistant_messages
  FOR SELECT TO PUBLIC
  USING (
    public.is_admin()
    OR (
      public.is_assistant_user()
      AND EXISTS (
        SELECT 1 FROM public.assistant_chats c
        WHERE c.id = assistant_messages.chat_id AND c.owner_id = auth.uid()
      )
    )
  );
CREATE POLICY assistant_messages_insert ON public.assistant_messages
  FOR INSERT TO PUBLIC
  WITH CHECK (
    public.is_assistant_user()
    AND author_id = auth.uid()
    AND role = 'user'
    AND EXISTS (
      SELECT 1 FROM public.assistant_chats c
      WHERE c.id = assistant_messages.chat_id AND c.owner_id = auth.uid()
    )
  );
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO PUBLIC
  USING (id = auth.uid() OR public.is_admin());
CREATE POLICY profiles_staff_select ON public.profiles
  FOR SELECT TO PUBLIC
  USING (public.is_manager() AND role = 'seller');
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO PUBLIC
  USING (id = auth.uid() OR public.is_admin());

CREATE OR REPLACE FUNCTION public.assistant_chats_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Cannot reassign chat owner';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assistant_chats_guard
  BEFORE UPDATE ON public.assistant_chats
  FOR EACH ROW EXECUTE FUNCTION public.assistant_chats_guard();

CREATE OR REPLACE FUNCTION public.profiles_prevent_privilege_escalation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Not allowed to change role';
  END IF;
  IF NEW.can_cancel_orders IS DISTINCT FROM OLD.can_cancel_orders THEN
    RAISE EXCEPTION 'Not allowed to change cancel permission';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profiles_prevent_privilege_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_prevent_privilege_escalation();

INSERT INTO public.profiles (id, display_name, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Admin', 'admin'),
  ('22222222-2222-2222-2222-222222222222', 'Manager', 'manager'),
  ('33333333-3333-3333-3333-333333333333', 'OtherMgr', 'manager'),
  ('44444444-4444-4444-4444-444444444444', 'Seller', 'seller');

INSERT INTO public.assistant_chats (id, owner_id, title) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Mgr chat'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'Other chat');

INSERT INTO public.assistant_messages (chat_id, author_id, role, content, client_message_id)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '22222222-2222-2222-2222-222222222222',
  'user',
  'hello',
  '99999999-9999-9999-9999-999999999999'
);

DO $$
BEGIN
  INSERT INTO public.profiles (display_name, role) VALUES ('bad', 'bot');
  RAISE EXCEPTION 'role check must reject unknown roles';
EXCEPTION
  WHEN check_violation THEN NULL;
END $$;

DO $$
BEGIN
  INSERT INTO public.assistant_messages (chat_id, author_id, role, content, client_message_id)
  VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '22222222-2222-2222-2222-222222222222',
    'user',
    'dup',
    '99999999-9999-9999-9999-999999999999'
  );
  RAISE EXCEPTION 'duplicate client_message_id must fail';
EXCEPTION
  WHEN unique_violation THEN NULL;
END $$;

DO $$
BEGIN
  UPDATE public.assistant_chats
  SET owner_id = '33333333-3333-3333-3333-333333333333'
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  RAISE EXCEPTION 'owner reassignment must fail';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Cannot reassign chat owner%' THEN RAISE; END IF;
END $$;

SET LOCAL ROLE NONE;
SELECT set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
SET LOCAL row_security = on;

DO $$
BEGIN
  UPDATE public.profiles
  SET role = 'admin'
  WHERE id = '44444444-4444-4444-4444-444444444444';
  RAISE EXCEPTION 'seller self-promotion must fail';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Not allowed to change role%' THEN RAISE; END IF;
END $$;

DROP ROLE IF EXISTS rls_probe;
CREATE ROLE rls_probe LOGIN;
GRANT USAGE ON SCHEMA public, auth TO rls_probe;
GRANT SELECT, INSERT, UPDATE ON public.assistant_chats TO rls_probe;
GRANT SELECT, INSERT ON public.assistant_messages TO rls_probe;
GRANT SELECT, UPDATE ON public.profiles TO rls_probe;

SET LOCAL ROLE rls_probe;
SELECT set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.assistant_chats;
  IF n <> 1 THEN RAISE EXCEPTION 'manager must see only own chats, got %', n; END IF;
  SELECT count(*) INTO n FROM public.assistant_messages;
  IF n <> 1 THEN RAISE EXCEPTION 'manager must see only own messages, got %', n; END IF;
  SELECT count(*) INTO n FROM public.profiles WHERE role = 'seller';
  IF n <> 1 THEN RAISE EXCEPTION 'manager must see sellers, got %', n; END IF;
  SELECT count(*) INTO n FROM public.profiles WHERE role = 'admin';
  IF n <> 0 THEN RAISE EXCEPTION 'manager must not see admin profiles'; END IF;
END $$;

DO $$
BEGIN
  INSERT INTO public.assistant_messages (chat_id, author_id, role, content)
  VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '22222222-2222-2222-2222-222222222222',
    'assistant',
    'forged'
  );
  RAISE EXCEPTION 'forged assistant message must fail';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'forged assistant message must fail%' THEN RAISE; END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.assistant_chats;
  IF n <> 0 THEN RAISE EXCEPTION 'seller must not read chats'; END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.assistant_chats;
  IF n <> 2 THEN RAISE EXCEPTION 'admin must audit all chats, got %', n; END IF;
END $$;

DO $$
BEGIN
  INSERT INTO public.assistant_messages (chat_id, author_id, role, content)
  VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    'user',
    'admin write'
  );
  RAISE EXCEPTION 'admin must not write into manager chats';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'admin must not write into manager chats%' THEN RAISE; END IF;
END $$;

RESET ROLE;
DROP ROLE rls_probe;

SELECT 'manager assistant security ok' AS status;
COMMIT;
