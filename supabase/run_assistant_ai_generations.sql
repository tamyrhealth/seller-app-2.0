-- Block 5.2.1: server-side assistant replies and generation idempotency.
-- Does not rewrite chats, messages, orders, inventory, or profiles.
-- Does not restore pg_trigger_depth / message_count client guard.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.assistant_generations (
  request_id uuid PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES public.assistant_chats(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id),
  user_message_id uuid REFERENCES public.assistant_messages(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES public.assistant_messages(id) ON DELETE SET NULL,
  lease_id uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_generations_status_check
    CHECK (status = ANY (ARRAY['running'::text, 'done'::text, 'failed'::text]))
);

ALTER TABLE public.assistant_generations
  ADD COLUMN IF NOT EXISTS lease_id uuid;
ALTER TABLE public.assistant_generations
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE public.assistant_generations
SET lease_id = COALESCE(lease_id, gen_random_uuid()),
    lease_expires_at = COALESCE(lease_expires_at, now())
WHERE lease_id IS NULL OR lease_expires_at IS NULL;

ALTER TABLE public.assistant_generations
  ALTER COLUMN lease_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.assistant_generations
  ALTER COLUMN lease_expires_at SET DEFAULT now();
ALTER TABLE public.assistant_generations
  ALTER COLUMN lease_id SET NOT NULL;
ALTER TABLE public.assistant_generations
  ALTER COLUMN lease_expires_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS assistant_generations_one_running_per_chat_uidx
  ON public.assistant_generations (chat_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS assistant_generations_owner_created_idx
  ON public.assistant_generations (owner_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_messages_assistant_request_uidx
  ON public.assistant_messages (chat_id, ((metadata->>'request_id')))
  WHERE role = 'assistant' AND metadata->>'request_id' IS NOT NULL;

ALTER TABLE public.assistant_generations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.assistant_generations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.assistant_generations TO service_role;

DROP FUNCTION IF EXISTS public.complete_assistant_generation(uuid, text);
DROP FUNCTION IF EXISTS public.fail_assistant_generation(uuid, text);

CREATE OR REPLACE FUNCTION public.claim_assistant_generation(
  p_chat_id uuid,
  p_owner_id uuid,
  p_request_id uuid,
  p_user_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_existing public.assistant_generations%ROWTYPE;
  v_recent int;
  v_lease uuid;
  v_expires timestamptz;
BEGIN
  IF p_chat_id IS NULL OR p_owner_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('assistant-gen'), hashtext(p_chat_id::text));

  IF NOT EXISTS (
    SELECT 1
    FROM public.assistant_chats c
    WHERE c.id = p_chat_id
      AND c.owner_id = p_owner_id
      AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'chat_not_found';
  END IF;

  IF p_user_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.assistant_messages m
    WHERE m.id = p_user_message_id
      AND m.chat_id = p_chat_id
      AND m.author_id = p_owner_id
      AND m.role = 'user'
      AND m.client_message_id = p_request_id
  ) THEN
    RAISE EXCEPTION 'user_message_mismatch';
  END IF;

  -- Expire stale leases so a killed Vercel invocation cannot block the chat
  -- or complete after a newer generation has started.
  UPDATE public.assistant_generations
  SET status = 'failed',
      error_text = 'lease_expired',
      updated_at = now()
  WHERE chat_id = p_chat_id
    AND status = 'running'
    AND lease_expires_at <= now()
    AND request_id <> p_request_id;

  SELECT * INTO v_existing
  FROM public.assistant_generations
  WHERE request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.chat_id <> p_chat_id OR v_existing.owner_id <> p_owner_id THEN
      RAISE EXCEPTION 'request_mismatch';
    END IF;
    IF v_existing.status = 'done' AND v_existing.assistant_message_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'done',
        'assistant_message_id', v_existing.assistant_message_id
      );
    END IF;
    IF v_existing.status = 'running' AND v_existing.lease_expires_at > now() THEN
      RETURN jsonb_build_object('status', 'running');
    END IF;
    v_lease := gen_random_uuid();
    v_expires := now() + interval '90 seconds';
    BEGIN
      UPDATE public.assistant_generations
      SET status = 'running',
          error_text = NULL,
          user_message_id = COALESCE(p_user_message_id, user_message_id),
          lease_id = v_lease,
          lease_expires_at = v_expires,
          updated_at = now()
      WHERE request_id = p_request_id;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN jsonb_build_object('status', 'busy');
    END;
    RETURN jsonb_build_object('status', 'claimed', 'lease_id', v_lease);
  END IF;

  SELECT COUNT(*)::int INTO v_recent
  FROM public.assistant_generations g
  WHERE g.owner_id = p_owner_id
    AND g.created_at > now() - interval '10 minutes';
  IF v_recent >= 20 THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assistant_generations g
    WHERE g.chat_id = p_chat_id
      AND g.status = 'running'
      AND g.lease_expires_at > now()
  ) THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;

  v_lease := gen_random_uuid();
  v_expires := now() + interval '90 seconds';
  BEGIN
    INSERT INTO public.assistant_generations (
      request_id, chat_id, owner_id, user_message_id, status, lease_id, lease_expires_at
    ) VALUES (
      p_request_id, p_chat_id, p_owner_id, p_user_message_id, 'running', v_lease, v_expires
    );
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 'busy');
  END;

  RETURN jsonb_build_object('status', 'claimed', 'lease_id', v_lease);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_assistant_generation(
  p_request_id uuid,
  p_lease_id uuid,
  p_content text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_gen public.assistant_generations%ROWTYPE;
  v_msg_id uuid;
  v_body text;
BEGIN
  IF p_request_id IS NULL OR p_lease_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  v_body := btrim(COALESCE(p_content, ''));
  IF char_length(v_body) < 1 OR char_length(v_body) > 20000 THEN
    RAISE EXCEPTION 'invalid_content';
  END IF;

  SELECT * INTO v_gen
  FROM public.assistant_generations
  WHERE request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation_not_found';
  END IF;
  IF v_gen.status = 'done' AND v_gen.assistant_message_id IS NOT NULL THEN
    RETURN v_gen.assistant_message_id;
  END IF;
  IF v_gen.status <> 'running' OR v_gen.lease_id IS DISTINCT FROM p_lease_id THEN
    RAISE EXCEPTION 'stale_lease';
  END IF;
  IF v_gen.lease_expires_at <= now() THEN
    UPDATE public.assistant_generations
    SET status = 'failed',
        error_text = 'lease_expired',
        updated_at = now()
    WHERE request_id = p_request_id
      AND status = 'running'
      AND lease_id = p_lease_id;
    RAISE EXCEPTION 'lease_expired';
  END IF;

  BEGIN
    INSERT INTO public.assistant_messages (
      chat_id, author_id, role, content, metadata
    ) VALUES (
      v_gen.chat_id,
      NULL,
      'assistant',
      v_body,
      jsonb_build_object('source', 'openai', 'request_id', p_request_id::text)
    )
    RETURNING id INTO v_msg_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT m.id INTO v_msg_id
      FROM public.assistant_messages m
      WHERE m.chat_id = v_gen.chat_id
        AND m.role = 'assistant'
        AND m.metadata->>'request_id' = p_request_id::text
      ORDER BY m.created_at ASC
      LIMIT 1;
      IF v_msg_id IS NULL THEN
        RAISE;
      END IF;
  END;

  UPDATE public.assistant_generations
  SET status = 'done',
      assistant_message_id = v_msg_id,
      error_text = NULL,
      updated_at = now()
  WHERE request_id = p_request_id
    AND lease_id = p_lease_id
    AND status = 'running';

  RETURN v_msg_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_assistant_generation(
  p_request_id uuid,
  p_lease_id uuid,
  p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_request_id IS NULL OR p_lease_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.assistant_generations
  SET status = 'failed',
      error_text = left(COALESCE(p_error, 'error'), 500),
      updated_at = now()
  WHERE request_id = p_request_id
    AND lease_id = p_lease_id
    AND status = 'running';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_assistant_generation(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_assistant_generation(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_assistant_generation(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_assistant_generation(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_assistant_generation(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_assistant_generation(uuid, uuid, text) TO service_role;

COMMIT;
