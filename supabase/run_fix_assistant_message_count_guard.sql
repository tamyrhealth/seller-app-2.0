-- Hotfix 5.1.1: saving a message must not roll back because message_count
-- is updated from AFTER INSERT. Do not apply until explicitly allowed.
-- Does not delete/archive messages or change chat ownership.

BEGIN;

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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assistant_messages_touch_chat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
SET row_security = off
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

-- Table-level UPDATE would let authenticated write message_count.
-- Keep rename/archive; block count/number/owner from the client role.
REVOKE UPDATE ON TABLE public.assistant_chats FROM authenticated;
GRANT UPDATE (title, archived_at, updated_at) ON TABLE public.assistant_chats TO authenticated;

COMMIT;
