import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

function extract(file, name) {
  const s = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const start = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing ${name} in ${file}`);
  const end = s.indexOf('\n$$;', start);
  return s.slice(start, end + 4);
}

function normCreate(src) {
  return src
    .replace(
      `  SELECT role, COALESCE(can_create_transfers, false)
    INTO v_role, v_can_create
  FROM public.profiles
  WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN
    IF v_role IS DISTINCT FROM 'manager' OR v_can_create IS NOT TRUE THEN
      RAISE EXCEPTION 'Transfer permission denied';
    END IF;
  END IF;`,
      '  PERFORM public.stock_transfer_require(false);'
    )
    .replace('  PERFORM public.stock_transfer_require(false);', '  /*PERM*/');
}

function normAdmin(src, needle) {
  return src
    .replace(
      `  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;\n  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION '${needle}'; END IF;`,
      '  PERFORM public.stock_transfer_require(true);'
    )
    .replace('  PERFORM public.stock_transfer_require(true);', '  /*PERM*/');
}

function keys(body, name) {
  const needles = [
    'pg_advisory_xact_lock',
    'FOR UPDATE',
    'client_operations',
    'stock_transfer_fingerprint',
    'Idempotency key reused',
    'stock_transfer_remaining',
    'inventory_movements',
    'stock_transfer_events',
    'actor_id',
    'v_uid',
    'auth.uid()',
    'received_partial',
    'qty_lost',
    'qty_returned',
    'Shortage reason is required',
    'Received transfer cannot be cancelled',
    'stock_transfer_close_status',
  ];
  const missing = needles.filter((n) => !body.includes(n));
  return { name, missing: missing.filter((n) => {
    if (name === 'create_stock_transfer' && (n === 'stock_transfer_remaining' || n === 'received_partial' || n === 'qty_lost' || n === 'qty_returned' || n === 'Shortage reason is required' || n === 'Received transfer cannot be cancelled' || n === 'stock_transfer_close_status')) return false;
    if (name === 'receive_stock_transfer' && (n === 'Shortage reason is required' || n === 'Received transfer cannot be cancelled' || n === 'qty_lost' || n === 'qty_returned')) return false;
    if (name === 'write_off_stock_transfer_shortage' && (n === 'received_partial' || n === 'Received transfer cannot be cancelled' || n === 'qty_returned')) return false;
    if (name === 'cancel_stock_transfer' && (n === 'received_partial' || n === 'Shortage reason is required' || n === 'qty_lost')) return false;
    return true;
  }) };
}

const pairs = [
  [
    'create_stock_transfer',
    extract('supabase/migrations/20261104220000_assistant_stock_transfers.sql', 'create_stock_transfer'),
    extract('supabase/migrations/20261105010000_assistant_stock_transfer_manage.sql', 'create_stock_transfer'),
    (a) => normCreate(a),
    (b) => b.replace('  PERFORM public.stock_transfer_require(false);', '  /*PERM*/'),
  ],
  [
    'receive_stock_transfer',
    extract('supabase/migrations/20261103230000_stock_transfer_partial_receive.sql', 'receive_stock_transfer'),
    extract('supabase/migrations/20261105010000_assistant_stock_transfer_manage.sql', 'receive_stock_transfer'),
    (a) => normAdmin(a, 'Only admin can receive transfers'),
    (b) => b.replace('  PERFORM public.stock_transfer_require(true);', '  /*PERM*/'),
  ],
  [
    'cancel_stock_transfer',
    extract('supabase/migrations/20261103230000_stock_transfer_partial_receive.sql', 'cancel_stock_transfer'),
    extract('supabase/migrations/20261105010000_assistant_stock_transfer_manage.sql', 'cancel_stock_transfer'),
    (a) => normAdmin(a, 'Only admin can cancel transfers'),
    (b) => b.replace('  PERFORM public.stock_transfer_require(true);', '  /*PERM*/'),
  ],
  [
    'write_off_stock_transfer_shortage',
    extract('supabase/migrations/20261103240000_product_cost_shortage_snapshot.sql', 'write_off_stock_transfer_shortage'),
    extract('supabase/migrations/20261105010000_assistant_stock_transfer_manage.sql', 'write_off_stock_transfer_shortage'),
    (a) => normAdmin(a, 'Only admin can write off transfer shortage'),
    (b) => b.replace('  PERFORM public.stock_transfer_require(true);', '  /*PERM*/'),
  ],
];

let failed = false;
for (const [name, oldB, newB, normOld, normNew] of pairs) {
  const a = normOld(oldB);
  const b = normNew(newB);
  const same = a === b;
  console.log(`${name}: ${same ? 'IDENTICAL after permission swap' : 'DIFFERS'}`);
  if (!same) {
    failed = true;
    const min = Math.min(a.length, b.length);
    let i = 0;
    while (i < min && a[i] === b[i]) i++;
    console.log('  first diff at', i);
    console.log('  old:', JSON.stringify(a.slice(Math.max(0, i - 80), i + 120)));
    console.log('  new:', JSON.stringify(b.slice(Math.max(0, i - 80), i + 120)));
  }
  console.log('  markers', JSON.stringify(keys(newB, name)));
}
if (failed) process.exit(1);
