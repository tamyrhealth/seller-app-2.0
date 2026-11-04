-- LOCAL / STAGING ONLY. Transactional. Rolls back.
-- Do NOT run against production. Do NOT leave leftover stock changes.

BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_stock_transfer'
  LIMIT 1;
  IF v_def IS NULL OR v_def NOT LIKE '%Transfer permission denied%' THEN
    RAISE EXCEPTION 'create_stock_transfer missing manager flag guard';
  END IF;
  IF v_def NOT LIKE '%can_create_transfers%' THEN
    RAISE EXCEPTION 'create_stock_transfer missing can_create_transfers';
  END IF;
  IF v_def NOT LIKE '%Inactive product%' OR v_def NOT LIKE '%Source city is inactive%' THEN
    RAISE EXCEPTION 'create_stock_transfer missing is_active checks';
  END IF;
  IF v_def NOT LIKE '%client_operations%' OR v_def NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'idempotency/locks missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'receive_stock_transfer' LIMIT 1;
  IF v_def NOT LIKE '%Only admin can receive transfers%' THEN
    RAISE EXCEPTION 'receive must stay admin-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'cancel_stock_transfer' LIMIT 1;
  IF v_def NOT LIKE '%Only admin can cancel transfers%' THEN
    RAISE EXCEPTION 'cancel must stay admin-only';
  END IF;
END $$;

-- Runtime permission/qty tests require SET LOCAL request.jwt.claim.sub which
-- this repo does not inject here, to avoid mutating real inventory.
-- After staging apply, verify with a disposable manager JWT:
-- 1) can_create_transfers=false -> create_stock_transfer raises Transfer permission denied
-- 2) flag true, same operation_id twice -> one stock_transfers row
-- 3) kg qty 1.250 allowed; pcs 1.5 Invalid qty
-- 4) inactive city/product rejected
-- 5) two concurrent confirms with one operation_id -> one transfer

ROLLBACK;
