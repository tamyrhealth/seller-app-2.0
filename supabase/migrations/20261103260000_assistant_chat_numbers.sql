-- Block 5.1.1: unique chat numbers C000001 and one empty chat per owner.
-- Does not rewrite order/inventory/profile/product rows or message history.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.assistant_chats_chat_number_seq;

ALTER TABLE public.assistant_chats
  ADD COLUMN IF NOT EXISTS chat_number text;

ALTER TABLE public.assistant_chats
  ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.format_chat_number(p_n bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'C' || CASE
    WHEN length(p_n::text) >= 6 THEN p_n::text
    ELSE lpad(p_n::text, 6, '0')
  END;
$$;

UPDATE public.assistant_chats c
SET message_count = s.cnt
FROM (
  SELECT c2.id, COUNT(m.id)::int AS cnt
  FROM public.assistant_chats c2
  LEFT JOIN public.assistant_messages m ON m.chat_id = c2.id
  GROUP BY c2.id
) s
WHERE c.id = s.id
  AND c.message_count IS DISTINCT FROM s.cnt;

-- Extra empty chats have no history; keep the oldest per owner, archive the rest
-- so the unique empty-chat index can be created safely.
UPDATE public.assistant_chats c
SET archived_at = now()
FROM (
  SELECT id,
         row_number() OVER (PARTITION BY owner_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.assistant_chats
  WHERE archived_at IS NULL
    AND message_count = 0
) d
WHERE c.id = d.id
  AND d.rn > 1
  AND c.archived_at IS NULL;

UPDATE public.assistant_chats o
SET chat_number = public.format_chat_number(s.rn)
FROM (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM public.assistant_chats
  WHERE chat_number IS NULL
) s
WHERE o.id = s.id
  AND o.chat_number IS NULL;

SELECT setval(
  'public.assistant_chats_chat_number_seq',
  GREATEST(
    1,
    COALESCE((
      SELECT MAX(NULLIF(regexp_replace(chat_number, '\D', '', 'g'), '')::bigint)
      FROM public.assistant_chats
    ), 0)
  ),
  (SELECT COALESCE(MAX(NULLIF(regexp_replace(chat_number, '\D', '', 'g'), '')::bigint), 0) FROM public.assistant_chats) > 0
);

CREATE OR REPLACE FUNCTION public.assistant_chats_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.chat_number := public.format_chat_number(nextval('public.assistant_chats_chat_number_seq'));
  NEW.message_count := 0;
  IF NEW.title IS NULL OR btrim(NEW.title) = '' OR btrim(NEW.title) = 'Новый диалог' THEN
    NEW.title := 'Диалог ' || NEW.chat_number;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assistant_chats_assign_number_trg ON public.assistant_chats;
CREATE TRIGGER assistant_chats_assign_number_trg
  BEFORE INSERT ON public.assistant_chats
  FOR EACH ROW
  EXECUTE FUNCTION public.assistant_chats_assign_number();

ALTER TABLE public.assistant_chats
  ALTER COLUMN chat_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS assistant_chats_chat_number_uidx
  ON public.assistant_chats (chat_number);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_chats_one_empty_per_owner_uidx
  ON public.assistant_chats (owner_id)
  WHERE archived_at IS NULL AND message_count = 0;

CREATE OR REPLACE FUNCTION public.assistant_chats_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Cannot reassign chat owner';
  END IF;
  IF NEW.chat_number IS DISTINCT FROM OLD.chat_number THEN
    RAISE EXCEPTION 'Cannot change chat number';
  END IF;
  -- Client UPDATE must not fake empty/filled chats. Nested trigger from
  -- assistant_messages_touch_chat (pg_trigger_depth >= 2) may increment.
  IF NEW.message_count IS DISTINCT FROM OLD.message_count AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Cannot change message_count';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assistant_chats_guard ON public.assistant_chats;
CREATE TRIGGER assistant_chats_guard
  BEFORE UPDATE ON public.assistant_chats
  FOR EACH ROW
  EXECUTE FUNCTION public.assistant_chats_guard();

CREATE OR REPLACE FUNCTION public.assistant_messages_touch_chat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.assistant_chats
    SET message_count = message_count + 1,
        updated_at = now()
    WHERE id = NEW.chat_id;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE public.assistant_chats
    SET message_count = GREATEST(message_count - 1, 0)
    WHERE id = OLD.chat_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS assistant_messages_touch_chat_ins ON public.assistant_messages;
CREATE TRIGGER assistant_messages_touch_chat_ins
  AFTER INSERT ON public.assistant_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.assistant_messages_touch_chat();

DROP TRIGGER IF EXISTS assistant_messages_touch_chat_del ON public.assistant_messages;
CREATE TRIGGER assistant_messages_touch_chat_del
  AFTER DELETE ON public.assistant_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.assistant_messages_touch_chat();

CREATE OR REPLACE FUNCTION public.open_empty_assistant_chat()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_assistant_user() THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('assistant_empty:' || v_uid::text));

  SELECT id INTO v_id
  FROM public.assistant_chats
  WHERE owner_id = v_uid
    AND archived_at IS NULL
    AND message_count = 0
  ORDER BY created_at ASC, id ASC
  LIMIT 1
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  BEGIN
    INSERT INTO public.assistant_chats (owner_id, title)
    VALUES (v_uid, 'Новый диалог')
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT id INTO v_id
      FROM public.assistant_chats
      WHERE owner_id = v_uid
        AND archived_at IS NULL
        AND message_count = 0
      ORDER BY created_at ASC, id ASC
      LIMIT 1;
      IF v_id IS NULL THEN
        RAISE;
      END IF;
  END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.format_chat_number(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.format_chat_number(bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.open_empty_assistant_chat() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_empty_assistant_chat() TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.assistant_chats_chat_number_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.assistant_chats_chat_number_seq TO postgres, service_role;

COMMIT;
