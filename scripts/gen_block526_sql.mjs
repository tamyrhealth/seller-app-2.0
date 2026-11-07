import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

function extract(file, name) {
  const s = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const start = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing ${name} in ${file}`);
  const endMarker = '\n$$;';
  const end = s.indexOf(endMarker, start);
  if (end < 0) throw new Error(`end missing ${name}`);
  return s.slice(start, end + endMarker.length);
}

let createFn = extract(
  'supabase/migrations/20261104220000_assistant_stock_transfers.sql',
  'create_stock_transfer'
);
let receiveFn = extract(
  'supabase/migrations/20261103230000_stock_transfer_partial_receive.sql',
  'receive_stock_transfer'
);
let cancelFn = extract(
  'supabase/migrations/20261103230000_stock_transfer_partial_receive.sql',
  'cancel_stock_transfer'
);
let writeFn = extract(
  'supabase/migrations/20261103240000_product_cost_shortage_snapshot.sql',
  'write_off_stock_transfer_shortage'
);

const createOld = `  SELECT role, COALESCE(can_create_transfers, false)
    INTO v_role, v_can_create
  FROM public.profiles
  WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN
    IF v_role IS DISTINCT FROM 'manager' OR v_can_create IS NOT TRUE THEN
      RAISE EXCEPTION 'Transfer permission denied';
    END IF;
  END IF;`;
if (!createFn.includes(createOld)) throw new Error('create permission block mismatch');
createFn = createFn.replace(createOld, '  PERFORM public.stock_transfer_require(false);');

function patchAdmin(fn, needle) {
  const old = `  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;\n  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION '${needle}'; END IF;`;
  if (!fn.includes(old)) throw new Error(`admin block mismatch for ${needle}:\n${fn.slice(fn.indexOf('BEGIN'), fn.indexOf('BEGIN') + 400)}`);
  return fn.replace(old, '  PERFORM public.stock_transfer_require(true);');
}

receiveFn = patchAdmin(receiveFn, 'Only admin can receive transfers');
cancelFn = patchAdmin(cancelFn, 'Only admin can cancel transfers');
writeFn = patchAdmin(writeFn, 'Only admin can write off transfer shortage');

const header = `-- Block 5.2.6: manager can_manage_transfers + receive/cancel/shortage via existing RPCs.
-- Does not rewrite restock/adjust, confirm_order, or transfer numbering.
-- Do not apply until explicitly allowed.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_transfers boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.profiles_prevent_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS DISTINCT FROM 'seller' THEN
      RAISE EXCEPTION 'Not allowed to change role';
    END IF;
    IF COALESCE(NEW.can_cancel_orders, false) IS TRUE THEN
      RAISE EXCEPTION 'Not allowed to change cancel permission';
    END IF;
    IF COALESCE(NEW.can_create_transfers, false) IS TRUE THEN
      RAISE EXCEPTION 'Not allowed to change transfer permission';
    END IF;
    IF COALESCE(NEW.can_manage_transfers, false) IS TRUE THEN
      RAISE EXCEPTION 'Not allowed to change transfer manage permission';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Not allowed to change role';
  END IF;
  IF NEW.can_cancel_orders IS DISTINCT FROM OLD.can_cancel_orders THEN
    RAISE EXCEPTION 'Not allowed to change cancel permission';
  END IF;
  IF NEW.can_create_transfers IS DISTINCT FROM OLD.can_create_transfers THEN
    RAISE EXCEPTION 'Not allowed to change transfer permission';
  END IF;
  IF NEW.can_manage_transfers IS DISTINCT FROM OLD.can_manage_transfers THEN
    RAISE EXCEPTION 'Not allowed to change transfer manage permission';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_privilege_escalation ON public.profiles;
CREATE TRIGGER profiles_prevent_privilege_escalation
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_prevent_privilege_escalation();

CREATE OR REPLACE FUNCTION public.stock_transfer_require(p_need_manage boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_active boolean := false;
  v_create boolean := false;
  v_manage boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT p.role, COALESCE(p.is_active, false), COALESCE(p.can_create_transfers, false), COALESCE(p.can_manage_transfers, false)
    INTO v_role, v_active, v_create, v_manage
  FROM public.profiles p
  WHERE p.id = v_uid;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Account is inactive';
  END IF;
  IF v_role = 'admin' THEN
    RETURN;
  END IF;
  IF v_role IS DISTINCT FROM 'manager' THEN
    RAISE EXCEPTION 'Transfer permission denied';
  END IF;
  IF p_need_manage THEN
    IF v_manage IS NOT TRUE THEN
      RAISE EXCEPTION 'Transfer manage permission denied';
    END IF;
  ELSIF v_create IS NOT TRUE AND v_manage IS NOT TRUE THEN
    RAISE EXCEPTION 'Transfer permission denied';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_transfer_require(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_transfer_require(boolean) TO postgres, service_role;

DROP POLICY IF EXISTS stock_transfers_select ON public.stock_transfers;
CREATE POLICY stock_transfers_select ON public.stock_transfers
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = 'admin'
    OR created_by = auth.uid()
    OR (
      public.get_user_role() = 'manager'
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND COALESCE(p.can_manage_transfers, false) IS TRUE
      )
    )
  );

DROP POLICY IF EXISTS stock_transfer_items_select ON public.stock_transfer_items;
CREATE POLICY stock_transfer_items_select ON public.stock_transfer_items
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_items.transfer_id
        AND t.created_by = auth.uid()
    )
    OR (
      public.get_user_role() = 'manager'
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND COALESCE(p.can_manage_transfers, false) IS TRUE
      )
    )
  );

DROP POLICY IF EXISTS stock_transfer_events_select ON public.stock_transfer_events;
CREATE POLICY stock_transfer_events_select ON public.stock_transfer_events
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_events.transfer_id
        AND t.created_by = auth.uid()
    )
    OR (
      public.get_user_role() = 'manager'
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND COALESCE(p.can_manage_transfers, false) IS TRUE
      )
    )
  );

`;

const grants = `

REVOKE ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_stock_transfer(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_stock_transfer(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_stock_transfer(uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_stock_transfer(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) TO authenticated, service_role;

COMMIT;
`;

const out = `${header}${createFn}\n\n${receiveFn}\n\n${writeFn}\n\n${cancelFn}${grants}`;
writeFileSync(join(root, 'supabase/migrations/20261105010000_assistant_stock_transfer_manage.sql'), out);
writeFileSync(join(root, 'supabase/run_assistant_stock_transfer_manage.sql'), out);
if (!out.includes('PERFORM public.stock_transfer_require(false);')) throw new Error('create not patched');
if ((out.match(/PERFORM public\.stock_transfer_require\(true\);/g) || []).length !== 3) {
  throw new Error('expected 3 manage RPC patches');
}
if (out.includes('Only admin can receive transfers')) throw new Error('stale receive admin-only');
console.log('wrote', out.length, 'bytes');
