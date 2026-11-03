-- Block 5.2.2b: update existing assistant order drafts without changing idempotency_key.
-- Does not rewrite confirm_order, orders, or inventory.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_assistant_order_draft_content(
  p_id uuid,
  p_owner_id uuid,
  p_status text,
  p_can_confirm boolean,
  p_warnings jsonb,
  p_errors jsonb,
  p_resolved jsonb,
  p_preview jsonb,
  p_customer_phone text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_row public.assistant_order_drafts%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('preview', 'blocked') THEN
    RAISE EXCEPTION 'invalid_draft_status';
  END IF;

  SELECT * INTO v_row
  FROM public.assistant_order_drafts
  WHERE id = p_id
    AND owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.assistant_order_drafts d WHERE d.id = p_id) THEN
      RAISE EXCEPTION 'not_draft_owner';
    END IF;
    RAISE EXCEPTION 'draft_not_found';
  END IF;
  IF v_row.status NOT IN ('preview', 'blocked') THEN
    RAISE EXCEPTION 'draft_not_editable';
  END IF;

  UPDATE public.assistant_order_drafts
  SET status = p_status,
      can_confirm = COALESCE(p_can_confirm, false),
      warnings = COALESCE(p_warnings, '[]'::jsonb),
      errors = COALESCE(p_errors, '[]'::jsonb),
      resolved = COALESCE(p_resolved, '{}'::jsonb),
      preview = COALESCE(p_preview, '{}'::jsonb),
      customer_phone = COALESCE(NULLIF(btrim(COALESCE(p_customer_phone, '')), ''), customer_phone),
      updated_at = now()
  WHERE id = p_id
    AND owner_id = p_owner_id
    AND status IN ('preview', 'blocked');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft_not_editable';
  END IF;
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_assistant_order_draft_content(uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_assistant_order_draft_content(uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb, text)
  TO service_role;

COMMIT;
