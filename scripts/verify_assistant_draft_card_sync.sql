-- 5.20.4D: two chat messages, one draft row; confirm updates both views. No confirm_order.
BEGIN;

CREATE TEMP TABLE assistant_order_drafts (
  id uuid PRIMARY KEY,
  assistant_message_id uuid,
  status text NOT NULL,
  can_confirm boolean NOT NULL,
  idempotency_key uuid NOT NULL,
  order_id uuid,
  order_number text
);

CREATE TEMP TABLE assistant_messages (
  id uuid PRIMARY KEY,
  draft_id uuid
);

INSERT INTO assistant_order_drafts
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  'preview',
  true,
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  NULL,
  NULL
);

INSERT INTO assistant_messages VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');

UPDATE assistant_order_drafts
SET status = 'confirmed',
    can_confirm = false,
    order_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    order_number = 'A-9'
WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

DO $$
DECLARE
  v_n int;
  v_orders int;
  v_keys int;
BEGIN
  SELECT COUNT(DISTINCT d.id), COUNT(DISTINCT d.order_id), COUNT(DISTINCT d.idempotency_key)
    INTO v_n, v_orders, v_keys
  FROM assistant_messages m
  JOIN assistant_order_drafts d ON d.id = m.draft_id;
  IF v_n <> 1 OR v_orders <> 1 OR v_keys <> 1 THEN
    RAISE EXCEPTION 'both cards must share one draft/order/key, got drafts=% orders=% keys=%', v_n, v_orders, v_keys;
  END IF;
  IF EXISTS (
    SELECT 1 FROM assistant_messages m
    JOIN assistant_order_drafts d ON d.id = m.draft_id
    WHERE d.status <> 'confirmed' OR d.can_confirm OR d.order_number IS DISTINCT FROM 'A-9'
  ) THEN
    RAISE EXCEPTION 'confirmed status must appear on every bound card';
  END IF;
END $$;

SELECT 'pg_draft_card_sync_ok';

ROLLBACK;
