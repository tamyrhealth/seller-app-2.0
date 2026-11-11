-- 5.20.4B: composition is not unique; null idempotency_key still allowed; actor+key unique.
BEGIN;

CREATE TEMP TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text,
  idempotency_fingerprint text,
  idempotency_actor_id uuid
);

CREATE UNIQUE INDEX orders_idempotency_actor_key_uidx
  ON orders (idempotency_actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

INSERT INTO orders (idempotency_key, idempotency_fingerprint, idempotency_actor_id)
VALUES
  ('k1', 'fp-same', '11111111-1111-1111-1111-111111111111'),
  ('k2', 'fp-same', '11111111-1111-1111-1111-111111111111');

INSERT INTO orders (idempotency_key, idempotency_fingerprint, idempotency_actor_id)
VALUES
  (NULL, 'fp-null', '11111111-1111-1111-1111-111111111111'),
  (NULL, 'fp-null', '11111111-1111-1111-1111-111111111111');

DO $$
BEGIN
  BEGIN
    INSERT INTO orders (idempotency_key, idempotency_fingerprint, idempotency_actor_id)
    VALUES ('k1', 'fp-other', '11111111-1111-1111-1111-111111111111');
    RAISE EXCEPTION 'same actor+key must be unique';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

CREATE TEMP TABLE assistant_order_drafts (
  id uuid PRIMARY KEY,
  chat_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  status text NOT NULL,
  idempotency_key uuid NOT NULL,
  resolved jsonb NOT NULL
);
CREATE UNIQUE INDEX assistant_order_drafts_idempotency_uidx
  ON assistant_order_drafts (idempotency_key);

INSERT INTO assistant_order_drafts
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'preview',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '{"seller_id":"s1"}'::jsonb);

DO $$
BEGIN
  BEGIN
    INSERT INTO assistant_order_drafts
    VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'preview',
       'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '{"seller_id":"s1"}'::jsonb);
    RAISE EXCEPTION 'draft idempotency_key must stay unique';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

SELECT 'pg_invoice_draft_reuse_ok';

ROLLBACK;
