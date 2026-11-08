import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const src = readFileSync(join(root, 'supabase/migrations/20261108180000_order_customer_fields.sql'), 'utf8');
const start = src.indexOf('CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)');
const end = src.indexOf('REVOKE ALL ON FUNCTION public.confirm_order(jsonb) FROM PUBLIC;');
if (start < 0 || end < 0) throw new Error('confirm_order slice not found');
let fn = src.slice(start, end).replace(/\r\n/g, '\n');
if (!fn.includes('v_cust_canon')) throw new Error('source confirm_order is not the production customer-fields version');
if (fn.includes('cost_price_snapshot')) throw new Error('source already has snapshot');
if (!fn.includes('  v_price numeric;\n')) throw new Error('v_price declare not found');
fn = fn.replace('  v_price numeric;\n', '  v_price numeric;\n  v_cost numeric;\n');

const oldSelect =
  "    SELECT name, price_retail INTO v_product_name, v_price\n" +
  "    FROM products WHERE id = (v_item->>'product_id')::uuid;";
const newSelect =
  "    SELECT name, price_retail, cost_price INTO v_product_name, v_price, v_cost\n" +
  "    FROM products WHERE id = (v_item->>'product_id')::uuid;";
if (!fn.includes(oldSelect)) throw new Error('product select not found');
fn = fn.replace(oldSelect, newSelect);

const oldInsert =
  '    INSERT INTO order_items (order_id, product_id, product_name_snapshot, price, qty, line_sum, is_gift)\n' +
  '    VALUES (\n' +
  '      v_order_id,\n' +
  "      (v_item->>'product_id')::uuid,\n" +
  '      v_product_name,\n' +
  '      v_price,\n' +
  '      v_qty,\n' +
  '      v_line_sum,\n' +
  '      COALESCE(v_is_gift, false)\n' +
  '    );';
const newInsert =
  '    INSERT INTO order_items (order_id, product_id, product_name_snapshot, price, qty, line_sum, is_gift, cost_price_snapshot)\n' +
  '    VALUES (\n' +
  '      v_order_id,\n' +
  "      (v_item->>'product_id')::uuid,\n" +
  '      v_product_name,\n' +
  '      v_price,\n' +
  '      v_qty,\n' +
  '      v_line_sum,\n' +
  '      COALESCE(v_is_gift, false),\n' +
  '      v_cost\n' +
  '    );';
if (!fn.includes(oldInsert)) throw new Error('item insert not found');
fn = fn.replace(oldInsert, newInsert);

const prefix = [
  '-- 5.13.2 historical COGS snapshot on new order_items.',
  '-- Source confirm_order: supabase/migrations/20261108180000_order_customer_fields.sql',
  '-- (production confirm_order after customer fields / block 562).',
  '-- Adds nullable order_items.cost_price_snapshot, writes catalog cost at INSERT,',
  '-- hides the column from authenticated/anon SELECT, admin-only RPC read.',
  '-- Does not UPDATE existing order_items. Does not change fingerprint/idempotency.',
  '-- Does not change stock locks, qty checks, roles, or cancel/debt/preorder RPCs.',
  '-- Do not apply until explicitly allowed.',
  '',
  'BEGIN;',
  '',
  'ALTER TABLE public.order_items',
  '  ADD COLUMN IF NOT EXISTS cost_price_snapshot numeric(12,2);',
  '',
  'ALTER TABLE public.order_items',
  '  DROP CONSTRAINT IF EXISTS order_items_cost_price_snapshot_check;',
  'ALTER TABLE public.order_items',
  '  ADD CONSTRAINT order_items_cost_price_snapshot_check',
  '  CHECK (cost_price_snapshot IS NULL OR cost_price_snapshot >= 0);',
  '',
  '-- Table-level GRANT SELECT/ALL includes future columns, so a new snapshot',
  '-- column would leak through seller/manager order_items(*). Replace with',
  '-- column lists that omit cost_price_snapshot. confirm_order is SECURITY',
  '-- DEFINER (table owner) and can still INSERT the hidden column.',
  'REVOKE ALL ON TABLE public.order_items FROM PUBLIC;',
  'REVOKE ALL ON TABLE public.order_items FROM anon;',
  'REVOKE ALL ON TABLE public.order_items FROM authenticated;',
  '',
  'DO $grant$',
  'DECLARE',
  '  v_select text;',
  'BEGIN',
  '  SELECT string_agg(format(\'%I\', c.column_name), \', \' ORDER BY c.ordinal_position)',
  '    INTO v_select',
  '  FROM information_schema.columns c',
  '  WHERE c.table_schema = \'public\'',
  '    AND c.table_name = \'order_items\'',
  '    AND c.column_name IS DISTINCT FROM \'cost_price_snapshot\';',
  '  IF v_select IS NULL OR v_select = \'\' THEN',
  '    RAISE EXCEPTION \'order_items public columns missing\';',
  '  END IF;',
  '  EXECUTE format(\'GRANT SELECT (%s) ON TABLE public.order_items TO authenticated\', v_select);',
  '  EXECUTE format(\'GRANT INSERT (%s) ON TABLE public.order_items TO authenticated\', v_select);',
  '  EXECUTE format(\'GRANT UPDATE (%s) ON TABLE public.order_items TO authenticated\', v_select);',
  '  EXECUTE \'GRANT DELETE ON TABLE public.order_items TO authenticated\';',
  'END',
  '$grant$;',
  '',
  'GRANT ALL ON TABLE public.order_items TO service_role;',
  '',
  '',
].join('\n');

const suffix = [
  'REVOKE ALL ON FUNCTION public.confirm_order(jsonb) FROM PUBLIC;',
  'GRANT ALL ON FUNCTION public.confirm_order(jsonb) TO authenticated;',
  'GRANT ALL ON FUNCTION public.confirm_order(jsonb) TO service_role;',
  '',
  'CREATE OR REPLACE FUNCTION public.admin_order_item_cost_snapshots(p_ids uuid[])',
  'RETURNS TABLE(id uuid, cost_price_snapshot numeric)',
  'LANGUAGE plpgsql',
  'SECURITY DEFINER',
  'SET search_path = public',
  'SET row_security = off',
  'AS $rpc$',
  'DECLARE',
  '  v_uid uuid := auth.uid();',
  '  v_role text;',
  '  v_active boolean;',
  'BEGIN',
  '  IF v_uid IS NULL THEN',
  '    RAISE EXCEPTION \'Not authenticated\';',
  '  END IF;',
  '  SELECT p.role, COALESCE(p.is_active, true)',
  '    INTO v_role, v_active',
  '  FROM public.profiles p',
  '  WHERE p.id = v_uid;',
  '  IF v_role IS DISTINCT FROM \'admin\' THEN',
  '    RAISE EXCEPTION \'Only admin can read product cost\';',
  '  END IF;',
  '  IF v_active IS NOT TRUE THEN',
  '    RAISE EXCEPTION \'Account is inactive\';',
  '  END IF;',
  '  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN',
  '    RETURN;',
  '  END IF;',
  '  IF cardinality(p_ids) > 20000 THEN',
  '    RAISE EXCEPTION \'Too many order item ids\';',
  '  END IF;',
  '  RETURN QUERY',
  '  SELECT oi.id, oi.cost_price_snapshot',
  '  FROM public.order_items oi',
  '  WHERE oi.id = ANY (p_ids);',
  'END;',
  '$rpc$;',
  '',
  'REVOKE ALL ON FUNCTION public.admin_order_item_cost_snapshots(uuid[]) FROM PUBLIC, anon;',
  'GRANT EXECUTE ON FUNCTION public.admin_order_item_cost_snapshots(uuid[]) TO authenticated, service_role;',
  '',
  'COMMIT;',
  '',
].join('\n');

const out = prefix + fn + suffix;
writeFileSync(join(root, 'supabase/migrations/20261108220000_order_item_cost_snapshot.sql'), out);
writeFileSync(join(root, 'supabase/run_order_item_cost_snapshot.sql'), out);
console.log('wrote bytes', out.length);
