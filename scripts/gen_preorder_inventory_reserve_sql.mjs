import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const dump = readFileSync(
  join(root, 'supabase/prod/_generated/20261111-131616/public_schema.sql'),
  'utf8',
);
const helpers = readFileSync(join(root, 'supabase/migrations/_preorder_reserve_helpers.sql'), 'utf8');
const footer = readFileSync(join(root, 'supabase/migrations/_preorder_reserve_footer.sql'), 'utf8');

function extract(name) {
  const re = new RegExp(
    `CREATE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;\\n`,
  );
  const m = dump.match(re);
  if (!m) throw new Error(`function not found: ${name}`);
  return m[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
}

function mustInclude(fn, needle, label) {
  if (!fn.includes(needle)) throw new Error(`${label}: missing ${needle.slice(0, 80)}`);
}

let confirm = extract('confirm_order__session_body');
mustInclude(confirm, 'IF NOT v_is_preorder THEN', 'confirm skip stock');
confirm = confirm.replace(
  `  IF NOT v_is_preorder THEN
    FOR v_pid, v_need IN
      SELECT (e->>'product_id')::uuid, SUM((e->>'qty')::numeric)
      FROM jsonb_array_elements(v_items) e
      GROUP BY 1
      ORDER BY 1
    LOOP
      PERFORM 1 FROM inventory
      WHERE city_id = v_city_id AND product_id = v_pid
      FOR UPDATE;

      UPDATE inventory
      SET qty_on_hand = qty_on_hand - v_need
      WHERE city_id = v_city_id
        AND product_id = v_pid
        AND qty_on_hand >= v_need;
      GET DIAGNOSTICS v_upd = ROW_COUNT;
      IF v_upd = 0 THEN
        RAISE EXCEPTION 'Insufficient stock for product %', v_pid;
      END IF;
    END LOOP;
  END IF;`,
  `  FOR v_pid IN
    SELECT DISTINCT (e->>'product_id')::uuid
    FROM jsonb_array_elements(v_items) e
    ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(v_city_id, v_pid);
  END LOOP;

  IF NOT v_is_preorder THEN
    FOR v_pid, v_need IN
      SELECT (e->>'product_id')::uuid, SUM((e->>'qty')::numeric)
      FROM jsonb_array_elements(v_items) e
      GROUP BY 1
      ORDER BY 1
    LOOP
      PERFORM public.inventory_deduct_available(v_city_id, v_pid, v_need);
    END LOOP;
  END IF;`,
);
mustInclude(confirm, 'inventory_lock_sku', 'confirm lock');
confirm = confirm.replace(
  /v_is_preorder := \(payload->>'is_preorder' = 'true' OR \(payload->'is_preorder'\)::text = 'true'\);/,
  "v_is_preorder := COALESCE((payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true'), false);",
);
confirm = confirm.replace(
  `    IF NOT v_is_preorder THEN
      INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_city_id, (v_item->>'product_id')::uuid, 'sale', -v_qty, v_order_id, v_actor_id);
    END IF;
  END LOOP;

  UPDATE orders SET total_sum = v_total WHERE id = v_order_id;`,
  `    IF NOT v_is_preorder THEN
      INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_city_id, (v_item->>'product_id')::uuid, 'sale', -v_qty, v_order_id, v_actor_id);
    END IF;
  END LOOP;

  IF v_is_preorder THEN
    UPDATE public.order_items oi
    SET qty_reserved = public.inventory_reserve_up_to(v_city_id, oi.product_id, oi.qty)
    WHERE oi.order_id = v_order_id;
  END IF;

  UPDATE orders SET total_sum = v_total WHERE id = v_order_id;`,
);
mustInclude(confirm, 'inventory_reserve_up_to', 'confirm reserve');

let fulfill = extract('fulfill_preorder__session_body');
if (!fulfill.includes('qty_on_hand = qty_on_hand - v_need')) {
  throw new Error('fulfill extract missing stock update\n' + fulfill.slice(fulfill.indexOf('FOR v_pid'), fulfill.indexOf('FOR v_pid') + 900));
}
fulfill = fulfill.replace(
  /  FOR v_pid, v_need IN[\s\S]*?RAISE EXCEPTION 'Insufficient stock';\s*END IF;\s*END LOOP;/,
  `  FOR v_pid IN
    SELECT DISTINCT product_id
    FROM public.order_items
    WHERE order_id = p_order_id
    ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(v_order.city_id, v_pid);
  END LOOP;

  FOR v_item IN
    SELECT product_id,
           SUM(qty) AS qty,
           SUM(COALESCE(qty_reserved, 0)) AS qty_reserved
    FROM public.order_items
    WHERE order_id = p_order_id
    GROUP BY 1
    ORDER BY 1
  LOOP
    PERFORM public.inventory_fulfill_sku(
      v_order.city_id,
      v_item.product_id,
      v_item.qty,
      v_item.qty_reserved
    );
  END LOOP;

  UPDATE public.order_items
  SET qty_reserved = 0
  WHERE order_id = p_order_id;`,
);
mustInclude(fulfill, 'inventory_fulfill_sku', 'fulfill');

let cancel = extract('apply_order_cancel_report');
if (!/v_should_return\s*:=/.test(cancel)) {
  throw new Error('cancel extract missing v_should_return, len=' + cancel.length + ' head=' + cancel.slice(0, 200));
}
cancel = cancel.replace(
  /  v_should_return :=\s*\(NOT v_order\.is_preorder\)\s*OR \(v_order\.preorder_status = 'fulfilled'\);/,
  `  v_should_return :=
    (NOT v_order.is_preorder)
    OR (v_order.preorder_status = 'fulfilled');

  FOR v_pid IN
    SELECT DISTINCT product_id FROM public.order_items WHERE order_id = p_order_id ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(v_order.city_id, v_pid);
  END LOOP;

  IF v_order.is_preorder AND v_order.preorder_status IS DISTINCT FROM 'fulfilled' THEN
    FOR v_item IN
      SELECT product_id, COALESCE(qty_reserved, 0) AS qty_reserved
      FROM public.order_items
      WHERE order_id = p_order_id
      ORDER BY product_id, id
    LOOP
      PERFORM public.inventory_release_reserve(v_order.city_id, v_item.product_id, v_item.qty_reserved);
    END LOOP;
    UPDATE public.order_items SET qty_reserved = 0 WHERE order_id = p_order_id;
  END IF;`,
);
cancel = cancel.replace(
  /INSERT INTO public\.inventory \(city_id, product_id, qty_on_hand, updated_at\)\s*VALUES \(v_order\.city_id, v_pid, v_need, now\(\)\)\s*ON CONFLICT \(city_id, product_id\) DO UPDATE\s*SET qty_on_hand = public\.inventory\.qty_on_hand \+ EXCLUDED\.qty_on_hand,\s*updated_at = now\(\);/,
  `PERFORM public.inventory_add_physical(v_order.city_id, v_pid, v_need);`,
);
mustInclude(cancel, 'inventory_release_reserve', 'cancel release');
mustInclude(cancel, 'inventory_add_physical', 'cancel restock');

function patchOrThrow(src, re, repl, label) {
  const next = src.replace(re, repl);
  if (next === src) throw new Error(`patch failed: ${label}`);
  return next;
}

let adjust = extract('apply_inventory_adjust__session_body');
adjust = patchOrThrow(
  adjust,
  /PERFORM pg_advisory_xact_lock\(hashtext\('inv:' \|\| p_city_id::text\), hashtext\(p_product_id::text\)\);/,
  `PERFORM public.inventory_lock_sku(p_city_id, p_product_id);`,
  'adjust lock',
);
adjust = patchOrThrow(
  adjust,
  /UPDATE public\.inventory\s+SET qty_on_hand = v_new, updated_at = now\(\)\s+WHERE city_id = p_city_id AND product_id = p_product_id;/,
  `PERFORM public.inventory_set_physical(p_city_id, p_product_id, v_new);`,
  'adjust set',
);
mustInclude(adjust, 'inventory_set_physical', 'adjust');

let restock = extract('apply_inventory_restock__session_body');
restock = patchOrThrow(
  restock,
  /PERFORM pg_advisory_xact_lock\(hashtext\('inv:' \|\| p_city_id::text\), hashtext\(p_product_id::text\)\);/,
  `PERFORM public.inventory_lock_sku(p_city_id, p_product_id);`,
  'restock lock',
);
restock = patchOrThrow(
  restock,
  /PERFORM 1 FROM public\.inventory\s+WHERE city_id = p_city_id AND product_id = p_product_id\s+FOR UPDATE;\s+INSERT INTO public\.inventory \(city_id, product_id, qty_on_hand, updated_at\)\s+VALUES \(p_city_id, p_product_id, v_qty, now\(\)\)\s+ON CONFLICT \(city_id, product_id\) DO UPDATE\s+SET qty_on_hand = public\.inventory\.qty_on_hand \+ EXCLUDED\.qty_on_hand,\s+updated_at = now\(\)\s+RETURNING qty_on_hand INTO v_new_qty;/,
  `PERFORM public.inventory_add_physical(p_city_id, p_product_id, v_qty);
  SELECT qty_on_hand INTO v_new_qty
  FROM public.inventory
  WHERE city_id = p_city_id AND product_id = p_product_id;`,
  'restock add',
);
mustInclude(restock, 'inventory_add_physical', 'restock');

let createTr = extract('create_stock_transfer__session_body');
createTr = patchOrThrow(
  createTr,
  /PERFORM pg_advisory_xact_lock\(hashtext\('inv:' \|\| p_from_city_id::text\), hashtext\(v_pid::text\)\);\s+PERFORM 1 FROM public\.inventory\s+WHERE city_id = p_from_city_id AND product_id = v_pid\s+FOR UPDATE;/,
  `PERFORM public.inventory_lock_sku(p_from_city_id, v_pid);`,
  'transfer lock',
);
createTr = patchOrThrow(
  createTr,
  /UPDATE public\.inventory\s+SET qty_on_hand = qty_on_hand - v_need, updated_at = now\(\)\s+WHERE city_id = p_from_city_id AND product_id = v_pid AND qty_on_hand >= v_need;\s+GET DIAGNOSTICS v_upd = ROW_COUNT;\s+IF v_upd = 0 THEN\s+RAISE EXCEPTION 'Insufficient stock';\s+END IF;/,
  `PERFORM public.inventory_deduct_available(p_from_city_id, v_pid, v_need);`,
  'transfer deduct',
);
mustInclude(createTr, 'inventory_deduct_available', 'transfer out');

let receive = extract('receive_stock_transfer__session_body');
receive = patchOrThrow(
  receive,
  /PERFORM pg_advisory_xact_lock\(hashtext\('inv:' \|\| v_tr\.to_city_id::text\), hashtext\(v_pid::text\)\);\s+PERFORM 1 FROM public\.inventory\s+WHERE city_id = v_tr\.to_city_id AND product_id = v_pid\s+FOR UPDATE;/,
  `PERFORM public.inventory_lock_sku(v_tr.to_city_id, v_pid);`,
  'receive lock',
);
receive = patchOrThrow(
  receive,
  /INSERT INTO public\.inventory \(city_id, product_id, qty_on_hand, updated_at\)\s+VALUES \(v_tr\.to_city_id, v_pid, v_inc, now\(\)\)\s+ON CONFLICT \(city_id, product_id\) DO UPDATE\s+SET qty_on_hand = public\.inventory\.qty_on_hand \+ EXCLUDED\.qty_on_hand,\s+updated_at = now\(\);/,
  `PERFORM public.inventory_add_physical(v_tr.to_city_id, v_pid, v_inc);`,
  'receive add',
);
mustInclude(receive, 'inventory_add_physical', 'receive');
if (/fulfill_preorder|preorder_status = 'fulfilled'/.test(receive)) {
  throw new Error('receive must not fulfill preorders');
}

let cancelTr = extract('cancel_stock_transfer__session_body');
cancelTr = patchOrThrow(
  cancelTr,
  /PERFORM pg_advisory_xact_lock\(hashtext\('inv:' \|\| v_tr\.from_city_id::text\), hashtext\(v_pid::text\)\);\s+PERFORM 1 FROM public\.inventory\s+WHERE city_id = v_tr\.from_city_id AND product_id = v_pid\s+FOR UPDATE;/,
  `PERFORM public.inventory_lock_sku(v_tr.from_city_id, v_pid);`,
  'cancel transfer lock',
);
cancelTr = patchOrThrow(
  cancelTr,
  /INSERT INTO public\.inventory \(city_id, product_id, qty_on_hand, updated_at\)\s+VALUES \(v_tr\.from_city_id, v_pid, v_remain, now\(\)\)\s+ON CONFLICT \(city_id, product_id\) DO UPDATE\s+SET qty_on_hand = public\.inventory\.qty_on_hand \+ EXCLUDED\.qty_on_hand,\s+updated_at = now\(\);/,
  `PERFORM public.inventory_add_physical(v_tr.from_city_id, v_pid, v_remain);`,
  'cancel transfer add',
);
mustInclude(cancelTr, 'inventory_add_physical', 'cancel transfer');

let goods = extract('admin_seller_goods_issue_post');
goods = patchOrThrow(
  goods,
  /PERFORM pg_advisory_xact_lock\(hashtext\('inv:' \|\| p_city_id::text\), hashtext\(v_pid::text\)\);/,
  `PERFORM public.inventory_lock_sku(p_city_id, v_pid);`,
  'goods lock',
);
goods = patchOrThrow(
  goods,
  /UPDATE public\.inventory\s+SET qty_on_hand = qty_on_hand - v_qty,\s+updated_at = now\(\)\s+WHERE city_id = p_city_id\s+AND product_id = v_pid\s+AND qty_on_hand >= v_qty;\s+GET DIAGNOSTICS v_upd = ROW_COUNT;\s+IF v_upd = 0 THEN\s+RAISE EXCEPTION 'Insufficient stock for product %', v_pid;\s+END IF;/,
  `PERFORM public.inventory_deduct_available(p_city_id, v_pid, v_qty);`,
  'goods deduct',
);
mustInclude(goods, 'inventory_deduct_available', 'goods out');

let goodsRet = extract('admin_seller_goods_return__session_body');
goodsRet = patchOrThrow(
  goodsRet,
  /INSERT INTO public\.inventory \(city_id, product_id, qty_on_hand, updated_at\)\s+VALUES \(v_orig\.city_id, v_pid, 0, now\(\)\)\s+ON CONFLICT \(city_id, product_id\) DO NOTHING;\s+UPDATE public\.inventory\s+SET qty_on_hand = qty_on_hand \+ v_qty,\s+updated_at = now\(\)\s+WHERE city_id = v_orig\.city_id AND product_id = v_pid;/,
  `PERFORM public.inventory_lock_sku(v_orig.city_id, v_pid);
    PERFORM public.inventory_add_physical(v_orig.city_id, v_pid, v_qty);`,
  'goods return',
);
mustInclude(goodsRet, 'inventory_add_physical', 'goods in');

const fns = [confirm, fulfill, cancel, adjust, restock, createTr, receive, cancelTr, goods, goodsRet];
for (const fn of fns) {
  if (!fn.includes('CREATE OR REPLACE FUNCTION')) throw new Error('expected replace');
  if (fn.includes('auth_session_guard_apply')) throw new Error('must not re-wrap phase 2');
}

const header = `-- 5.20.2B Preorder physical vs reserved stock.
-- Local apply only until Production is explicitly allowed. Do not weaken Phase 2 / P0.

BEGIN;

`;

writeFileSync(
  join(root, 'supabase/migrations/20261111120000_preorder_inventory_reserve.sql'),
  `${header}${helpers}\n${fns.join('\n\n')}\n\n${footer}\nCOMMIT;\n`,
  'utf8',
);
console.log('wrote migration', fns.length, 'functions');
