-- Local asserts for 5.19.2. Must run inside a transaction that rolls back.

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.inventory', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'authenticated must SELECT inventory';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT inventory';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated must not UPDATE inventory';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated must not DELETE inventory';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated must not TRUNCATE inventory';
  END IF;
  IF has_table_privilege('anon', 'public.inventory', 'TRUNCATE') THEN
    RAISE EXCEPTION 'anon must not TRUNCATE inventory';
  END IF;
  IF has_table_privilege('anon', 'public.inventory', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not SELECT inventory';
  END IF;

  IF has_table_privilege('authenticated', 'public.inventory_movements', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'authenticated must SELECT inventory_movements';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must not INSERT inventory_movements';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory_movements', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated must not UPDATE inventory_movements';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory_movements', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated must not DELETE inventory_movements';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory_movements', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated must not TRUNCATE inventory_movements';
  END IF;
  IF has_table_privilege('anon', 'public.inventory_movements', 'TRUNCATE') THEN
    RAISE EXCEPTION 'anon must not TRUNCATE inventory_movements';
  END IF;
  IF has_table_privilege('service_role', 'public.inventory_movements', 'INSERT') IS NOT TRUE THEN
    RAISE EXCEPTION 'service_role must keep INSERT inventory_movements';
  END IF;
END $$;

DO $$
DECLARE
  v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  BEGIN
    EXECUTE 'TRUNCATE public.inventory';
    RAISE EXCEPTION 'admin jwt must not TRUNCATE inventory';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
    WHEN others THEN
      IF SQLERRM LIKE '%TRUNCATE inventory%' THEN RAISE; END IF;
      v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'expected privilege denial on TRUNCATE inventory';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
  SET ROLE authenticated;
  BEGIN
    UPDATE public.inventory SET qty_on_hand = 999
    WHERE city_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'seller jwt must not UPDATE inventory';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
    WHEN others THEN
      IF SQLERRM LIKE '%seller jwt must not UPDATE%' THEN RAISE; END IF;
      v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'expected privilege denial on seller UPDATE inventory';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
  SET ROLE authenticated;
  BEGIN
    INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta)
    VALUES (
      '11111111-1111-4111-8111-111111111111',
      '99999999-9999-4999-8999-999999999999',
      'restock',
      1
    );
    RAISE EXCEPTION 'manager jwt must not INSERT inventory_movements';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
    WHEN others THEN
      IF SQLERRM LIKE '%manager jwt must not INSERT%' THEN RAISE; END IF;
      v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'expected privilege denial on manager INSERT movements';
  END IF;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  BEGIN
    DELETE FROM public.inventory_movements;
    RAISE EXCEPTION 'admin jwt must not DELETE inventory_movements';
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;
    WHEN others THEN
      IF SQLERRM LIKE '%admin jwt must not DELETE%' THEN RAISE; END IF;
      v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'expected privilege denial on DELETE movements';
  END IF;

  PERFORM 1 FROM public.inventory LIMIT 1;
  PERFORM 1 FROM public.inventory_movements LIMIT 1;
  RESET ROLE;
END $$;

DO $$
DECLARE
  v_qty numeric;
  v_before numeric;
BEGIN
  SELECT qty_on_hand INTO v_before FROM public.inventory
  WHERE city_id = '11111111-1111-4111-8111-111111111111'
    AND product_id = '99999999-9999-4999-8999-999999999999';

  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  SET ROLE authenticated;
  v_qty := public.audit_inventory_definer_bump(
    '11111111-1111-4111-8111-111111111111'::uuid,
    '99999999-9999-4999-8999-999999999999'::uuid
  );
  RESET ROLE;

  IF v_qty IS DISTINCT FROM v_before + 1 THEN
    RAISE EXCEPTION 'SECURITY DEFINER stock bump failed % vs %', v_qty, v_before;
  END IF;
END $$;
