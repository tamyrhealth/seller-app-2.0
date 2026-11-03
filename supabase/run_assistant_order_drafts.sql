-- Block 5.2.2: assistant order drafts, confirmation lock, and audit.
-- Identical to supabase/migrations/20261103290000_assistant_order_drafts.sql
-- Does not rewrite confirm_order, cancel_order, inventory, gifts, debts, or order numbers.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.assistant_order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.assistant_chats(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  user_message_id uuid REFERENCES public.assistant_messages(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES public.assistant_messages(id) ON DELETE SET NULL,
  status text NOT NULL,
  can_confirm boolean NOT NULL DEFAULT false,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_phone text,
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  order_number text,
  confirmed_by uuid REFERENCES public.profiles(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_order_drafts_status_check
    CHECK (status = ANY (ARRAY['preview'::text, 'blocked'::text, 'confirming'::text, 'confirmed'::text, 'cancelled'::text]))
);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_order_drafts_idempotency_uidx
  ON public.assistant_order_drafts (idempotency_key);

CREATE INDEX IF NOT EXISTS assistant_order_drafts_chat_idx
  ON public.assistant_order_drafts (chat_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_order_drafts_message_uidx
  ON public.assistant_order_drafts (assistant_message_id)
  WHERE assistant_message_id IS NOT NULL;

ALTER TABLE public.assistant_order_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_order_drafts_select ON public.assistant_order_drafts;
CREATE POLICY assistant_order_drafts_select ON public.assistant_order_drafts
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin());

REVOKE ALL ON TABLE public.assistant_order_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.assistant_order_drafts TO authenticated;
GRANT ALL ON TABLE public.assistant_order_drafts TO service_role;

CREATE OR REPLACE FUNCTION public.save_assistant_order_draft(
  p_id uuid,
  p_chat_id uuid,
  p_owner_id uuid,
  p_created_by uuid,
  p_user_message_id uuid,
  p_status text,
  p_can_confirm boolean,
  p_warnings jsonb,
  p_errors jsonb,
  p_resolved jsonb,
  p_preview jsonb,
  p_customer_phone text,
  p_idempotency_key uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_id IS NULL OR p_chat_id IS NULL OR p_owner_id IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  IF p_created_by IS DISTINCT FROM p_owner_id THEN
    RAISE EXCEPTION 'created_by_mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.assistant_chats c
    WHERE c.id = p_chat_id AND c.owner_id = p_owner_id
  ) THEN
    RAISE EXCEPTION 'chat_owner_mismatch';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('preview', 'blocked') THEN
    RAISE EXCEPTION 'invalid_draft_status';
  END IF;

  INSERT INTO public.assistant_order_drafts (
    id, chat_id, owner_id, created_by, user_message_id, status, can_confirm,
    warnings, errors, resolved, preview, customer_phone, idempotency_key
  ) VALUES (
    p_id,
    p_chat_id,
    p_owner_id,
    p_created_by,
    p_user_message_id,
    p_status,
    COALESCE(p_can_confirm, false),
    COALESCE(p_warnings, '[]'::jsonb),
    COALESCE(p_errors, '[]'::jsonb),
    COALESCE(p_resolved, '{}'::jsonb),
    COALESCE(p_preview, '{}'::jsonb),
    NULLIF(btrim(COALESCE(p_customer_phone, '')), ''),
    COALESCE(p_idempotency_key, gen_random_uuid())
  )
  ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status,
        can_confirm = EXCLUDED.can_confirm,
        warnings = EXCLUDED.warnings,
        errors = EXCLUDED.errors,
        resolved = EXCLUDED.resolved,
        preview = EXCLUDED.preview,
        customer_phone = EXCLUDED.customer_phone,
        user_message_id = COALESCE(EXCLUDED.user_message_id, public.assistant_order_drafts.user_message_id),
        updated_at = now()
    WHERE public.assistant_order_drafts.status IN ('preview', 'blocked')
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'draft_not_writable';
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_assistant_order_draft_message(
  p_id uuid,
  p_assistant_message_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_id IS NULL OR p_assistant_message_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.assistant_order_drafts
  SET assistant_message_id = p_assistant_message_id,
      updated_at = now()
  WHERE id = p_id
    AND assistant_message_id IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_assistant_order_draft(
  p_id uuid,
  p_owner_id uuid,
  p_order_id uuid,
  p_order_number text,
  p_confirmed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_id IS NULL OR p_owner_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  UPDATE public.assistant_order_drafts
  SET status = 'confirmed',
      can_confirm = false,
      order_id = p_order_id,
      order_number = NULLIF(btrim(COALESCE(p_order_number, '')), ''),
      confirmed_by = p_confirmed_by,
      confirmed_at = COALESCE(confirmed_at, now()),
      updated_at = now()
  WHERE id = p_id
    AND owner_id = p_owner_id
    AND status IN ('preview', 'blocked', 'confirming', 'confirmed');
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_assistant_order_confirm(
  p_id uuid,
  p_owner_id uuid,
  p_errors jsonb,
  p_can_confirm boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_id IS NULL OR p_owner_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.assistant_order_drafts
  SET status = CASE WHEN COALESCE(p_can_confirm, false) THEN 'preview' ELSE 'blocked' END,
      can_confirm = COALESCE(p_can_confirm, false),
      errors = COALESCE(p_errors, errors),
      updated_at = now()
  WHERE id = p_id
    AND owner_id = p_owner_id
    AND status = 'confirming';
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_assistant_order_confirm(p_draft_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_row public.assistant_order_drafts%ROWTYPE;
  v_existing uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_assistant_user() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_draft_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;

  SELECT * INTO v_row
  FROM public.assistant_order_drafts
  WHERE id = p_draft_id
    AND owner_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.assistant_order_drafts d WHERE d.id = p_draft_id) THEN
      RAISE EXCEPTION 'not_draft_owner';
    END IF;
    RAISE EXCEPTION 'draft_not_found';
  END IF;

  SELECT o.id INTO v_existing
  FROM public.orders o
  WHERE o.idempotency_key = v_row.idempotency_key::text
    AND o.idempotency_actor_id = v_uid
  LIMIT 1;

  IF v_row.status = 'confirmed' OR v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_confirmed',
      'order_id', COALESCE(v_row.order_id, v_existing),
      'order_number', v_row.order_number
    );
  END IF;
  IF v_row.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft_cancelled';
  END IF;
  IF v_row.status = 'confirming' THEN
    RETURN jsonb_build_object('status', 'confirming', 'draft_id', v_row.id);
  END IF;
  IF v_row.status <> 'preview' OR v_row.can_confirm IS NOT TRUE THEN
    RAISE EXCEPTION 'draft_not_confirmable';
  END IF;

  UPDATE public.assistant_order_drafts
  SET status = 'confirming',
      updated_at = now()
  WHERE id = v_row.id
    AND owner_id = v_uid
    AND status = 'preview'
    AND can_confirm = true;

  RETURN jsonb_build_object('status', 'confirming', 'draft_id', v_row.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_assistant_order_draft(p_draft_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_row public.assistant_order_drafts%ROWTYPE;
  v_existing uuid;
  v_number text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_assistant_user() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_row
  FROM public.assistant_order_drafts
  WHERE id = p_draft_id
    AND owner_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.assistant_order_drafts d WHERE d.id = p_draft_id) THEN
      RAISE EXCEPTION 'not_draft_owner';
    END IF;
    RAISE EXCEPTION 'draft_not_found';
  END IF;

  SELECT o.id, o.order_number INTO v_existing, v_number
  FROM public.orders o
  WHERE o.idempotency_key = v_row.idempotency_key::text
    AND o.idempotency_actor_id = v_uid
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.assistant_order_drafts
    SET status = 'confirmed',
        can_confirm = false,
        order_id = COALESCE(order_id, v_existing),
        order_number = COALESCE(order_number, v_number),
        confirmed_by = COALESCE(confirmed_by, v_uid),
        confirmed_at = COALESCE(confirmed_at, now()),
        updated_at = now()
    WHERE id = v_row.id;
    RETURN jsonb_build_object('status', 'already_confirmed', 'order_id', v_existing, 'order_number', v_number);
  END IF;

  IF v_row.status = 'confirmed' THEN
    RETURN jsonb_build_object('status', 'already_confirmed', 'order_id', v_row.order_id, 'order_number', v_row.order_number);
  END IF;
  IF v_row.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'cancelled');
  END IF;

  UPDATE public.assistant_order_drafts
  SET status = 'cancelled',
      can_confirm = false,
      updated_at = now()
  WHERE id = v_row.id
    AND owner_id = v_uid
    AND status IN ('preview', 'blocked', 'confirming');

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;

REVOKE ALL ON FUNCTION public.save_assistant_order_draft(uuid, uuid, uuid, uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_assistant_order_draft_message(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_assistant_order_draft(uuid, uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_assistant_order_confirm(uuid, uuid, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_assistant_order_confirm(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_assistant_order_draft(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_assistant_order_draft(uuid, uuid, uuid, uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_assistant_order_draft_message(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_assistant_order_draft(uuid, uuid, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_assistant_order_confirm(uuid, uuid, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_assistant_order_confirm(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_assistant_order_draft(uuid) TO authenticated;

COMMIT;
