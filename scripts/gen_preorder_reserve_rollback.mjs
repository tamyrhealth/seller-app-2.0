import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const dump = readFileSync(
  join(root, 'supabase/prod/_generated/20261111-131616/public_schema.sql'),
  'utf8',
);

function extract(name) {
  const re = new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;\\n`);
  const m = dump.match(re);
  if (!m) throw new Error(`function not found: ${name}`);
  const body = m[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  if (body.includes('inventory_lock_sku') || body.includes('inventory_reserve_up_to')) {
    throw new Error(`${name} dump body already has reserve helpers`);
  }
  return body;
}

const names = [
  'confirm_order__session_body',
  'fulfill_preorder__session_body',
  'apply_order_cancel_report',
  'apply_inventory_adjust__session_body',
  'apply_inventory_restock__session_body',
  'create_stock_transfer__session_body',
  'receive_stock_transfer__session_body',
  'cancel_stock_transfer__session_body',
  'admin_seller_goods_issue_post',
  'admin_seller_goods_return__session_body',
];
const fns = names.map(extract);
for (const fn of fns) {
  if (fn.includes('CREATE OR REPLACE FUNCTION public.confirm_order(')) {
    throw new Error('must not replace confirm_order wrapper');
  }
}

const header = `-- Rollback 5.20.2B only. Restores Production dump 20261111-131616 session bodies.
-- Does not touch Phase 2 wrappers (assert_active_auth_session) or P0 5.20.1 triggers/grants.
-- Do not run on Production unless explicitly requested.

BEGIN;

UPDATE public.order_items SET qty_reserved = 0 WHERE qty_reserved IS DISTINCT FROM 0;
UPDATE public.inventory SET qty_reserved = 0 WHERE qty_reserved IS DISTINCT FROM 0;

ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_qty_reserved_chk;
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_qty_reserved_chk;

DROP FUNCTION IF EXISTS public.inventory_backfill_pending_preorder_reserves();
DROP FUNCTION IF EXISTS public.inventory_set_physical(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.inventory_add_physical(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.inventory_allocate_pending_preorders(uuid, uuid);
DROP FUNCTION IF EXISTS public.inventory_fulfill_sku(uuid, uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public.inventory_release_reserve(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.inventory_reserve_up_to(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.inventory_deduct_available(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.inventory_available_of(numeric, numeric);
DROP FUNCTION IF EXISTS public.inventory_lock_sku(uuid, uuid);

`;

const footer = `
ALTER TABLE public.inventory DROP COLUMN IF EXISTS qty_reserved;
ALTER TABLE public.order_items DROP COLUMN IF EXISTS qty_reserved;

COMMIT;
`;

writeFileSync(
  join(root, 'supabase/prod/rollback_block5202a.sql'),
  `${header}${fns.join('\n\n')}\n${footer}`,
  'utf8',
);
console.log('wrote rollback', names.length, 'functions');
