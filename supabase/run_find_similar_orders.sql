-- 5.4.1 similar-order lookup (read-only). Warn, do not unique-lock composition.
-- Does not replace confirm_order, cancel_order, inventory, action_logs, or 5.2.6.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE INDEX IF NOT EXISTS orders_find_similar_seller_city_created_idx
  ON public.orders (seller_id, city_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.find_similar_orders(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_actor_id uuid;
  v_role text;
  v_actor_city uuid;
  v_active boolean;
  v_seller_id uuid;
  v_city_id uuid;
  v_items jsonb;
  v_bag jsonb;
  v_phone_raw text;
  v_phone_digits text;
  v_has_identity boolean;
  v_exclude_key text;
  v_matches jsonb;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, city_id, COALESCE(is_active, true)
    INTO v_role, v_actor_city, v_active
  FROM public.profiles
  WHERE id = v_actor_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Account is inactive';
  END IF;

  BEGIN
    v_seller_id := NULLIF(p->>'seller_id', '')::uuid;
    v_city_id := NULLIF(p->>'city_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid similar-order payload';
  END;

  v_items := p->'items';
  IF v_seller_id IS NULL OR v_city_id IS NULL OR v_items IS NULL OR jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION 'Invalid similar-order payload';
  END IF;
  IF jsonb_array_length(v_items) = 0 OR jsonb_array_length(v_items) > 100 THEN
    RAISE EXCEPTION 'Invalid similar-order payload';
  END IF;

  IF v_role = 'seller' THEN
    IF v_actor_city IS NULL THEN
      RAISE EXCEPTION 'Seller has no city assigned';
    END IF;
    IF v_seller_id <> v_actor_id OR v_city_id <> v_actor_city THEN
      RAISE EXCEPTION 'Similar-order lookup permission denied';
    END IF;
  ELSIF v_role IN ('admin', 'manager') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles s
      WHERE s.id = v_seller_id
        AND s.role = 'seller'
        AND COALESCE(s.is_active, true)
        AND s.city_id IS NOT NULL
        AND s.city_id = v_city_id
    ) THEN
      RAISE EXCEPTION 'Seller not found';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid role';
  END IF;

  BEGIN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'product_id', x.product_id,
          'qty', x.qty,
          'is_gift', x.is_gift
        )
        ORDER BY x.product_id, x.is_gift
      ),
      '[]'::jsonb
    )
    INTO v_bag
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             round(sum((e->>'qty')::numeric), 3) AS qty,
             COALESCE((e->>'is_gift')::boolean, false) AS is_gift
      FROM jsonb_array_elements(v_items) e
      WHERE NULLIF(e->>'product_id', '') IS NOT NULL
        AND COALESCE((e->>'qty')::numeric, 0) > 0
      GROUP BY 1, 3
    ) x;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Invalid similar-order payload';
  END;

  IF v_bag IS NULL OR v_bag = '[]'::jsonb THEN
    RAISE EXCEPTION 'Invalid similar-order payload';
  END IF;

  v_phone_raw := COALESCE(p->>'customer_phone', '');
  v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
  v_has_identity := length(v_phone_digits) >= 10;
  IF NOT v_has_identity THEN
    v_phone_digits := NULL;
  END IF;

  v_exclude_key := NULLIF(btrim(COALESCE(p->>'exclude_idempotency_key', '')), '');

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'order_id', m.id,
        'order_number', m.order_number,
        'created_at', m.created_at,
        'status', m.status
      )
      ORDER BY m.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_matches
  FROM (
    SELECT o.id, o.order_number, o.created_at, o.status
    FROM public.orders o
    WHERE o.seller_id = v_seller_id
      AND o.city_id = v_city_id
      AND o.created_at >= (now() - interval '15 minutes')
      AND lower(COALESCE(o.status, '')) NOT IN ('canceled', 'cancelled')
      AND (v_exclude_key IS NULL OR o.idempotency_key IS DISTINCT FROM v_exclude_key)
      AND (
        (
          v_has_identity
          AND length(regexp_replace(COALESCE(o.debt_customer_phone, ''), '\D', '', 'g')) >= 10
          AND regexp_replace(COALESCE(o.debt_customer_phone, ''), '\D', '', 'g') = v_phone_digits
        )
        OR (
          NOT v_has_identity
          AND length(regexp_replace(COALESCE(o.debt_customer_phone, ''), '\D', '', 'g')) < 10
        )
      )
      AND (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'product_id', t.product_id,
              'qty', t.qty,
              'is_gift', t.is_gift
            )
            ORDER BY t.product_id, t.is_gift
          ),
          '[]'::jsonb
        )
        FROM (
          SELECT oi.product_id,
                 round(sum(oi.qty), 3) AS qty,
                 COALESCE(oi.is_gift, false) AS is_gift
          FROM public.order_items oi
          WHERE oi.order_id = o.id
          GROUP BY oi.product_id, COALESCE(oi.is_gift, false)
        ) t
      ) = v_bag
    ORDER BY o.created_at DESC
    LIMIT 20
  ) m;

  RETURN jsonb_build_object(
    'checked_at', now(),
    'window_seconds', 900,
    'identity_kind', CASE WHEN v_has_identity THEN 'phone' ELSE 'anonymous' END,
    'matches', COALESCE(v_matches, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.find_similar_orders(jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.find_similar_orders(jsonb) TO authenticated;

COMMIT;
