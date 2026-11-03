-- Refuse to continue if this session looks like production.
-- Read-only except it does not write. Safe to run anywhere; it only RAISE EXCEPTION.

DO $$
DECLARE
  v_orders bigint;
  v_real_cities bigint;
BEGIN
  SELECT COUNT(*) INTO v_orders FROM public.orders;
  SELECT COUNT(*) INTO v_real_cities
  FROM public.cities
  WHERE name IS DISTINCT FROM '' AND name NOT ILIKE 'STAGING%';

  IF v_orders > 20 THEN
    RAISE EXCEPTION
      'assert_is_staging: orders=% — похоже на production. Остановлено.',
      v_orders;
  END IF;

  IF v_real_cities > 8 AND v_orders > 0 THEN
    RAISE EXCEPTION
      'assert_is_staging: non-STAGING cities=% and orders=% — похоже на production.',
      v_real_cities, v_orders;
  END IF;
END $$;

SELECT current_database() AS db,
       (SELECT COUNT(*) FROM public.orders) AS orders,
       (SELECT COUNT(*) FROM public.cities) AS cities;
