import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isMissingCostBackend,
  mergeProductCosts,
  productCatalogPayload,
} from '../lib/productCost';
import { transferDisplayStatus, transferLineQtys, transferRemaining } from '../lib/stockTransfer';
import { PRODUCT_CATALOG_SELECT } from '../lib/types';
import {
  expandShortageEvent,
  filterLossRows,
  lossKpis,
  parseShortageItems,
  shortageLineTotal,
} from '../lib/transferLoss';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const sql = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20261103240000_product_cost_shortage_snapshot.sql'),
  'utf8'
);
if (!sql.trim().startsWith('--') && !sql.includes('BEGIN;')) fail('migration must start a transaction');
if (!/^BEGIN;/m.test(sql) || !/^COMMIT;/m.test(sql)) fail('migration must be BEGIN/COMMIT');
if (!sql.includes('ADD COLUMN IF NOT EXISTS cost_price')) fail('migration must add products.cost_price');
if (!sql.includes('cost_price IS NULL OR cost_price >= 0')) fail('cost_price must allow NULL and reject negatives');
if (!sql.includes('REVOKE ALL ON COLUMN public.products.cost_price')) {
  fail('cost_price must be revoked from table-level GRANT ALL');
}
if (!sql.includes('admin_product_costs')) fail('admin must read cost via SECURITY DEFINER rpc');
if (!sql.includes('unit_cost')) fail('write-off must snapshot unit_cost');
if (!sql.includes('to_jsonb(p.cost_price)')) fail('unknown cost must snapshot as JSON null, not omitted');
if (!sql.includes('write_off_stock_transfer_shortage')) fail('must replace write_off');
if (!sql.includes('p_operation_id uuid')) fail('write-off signature must stay compatible');
if (!sql.includes('RETURN v_existing;')) fail('idempotent operation_id must return existing result');
if (/INSERT\s+INTO\s+public\.inventory/i.test(sql)) fail('shortage must not insert inventory');
if (/INSERT\s+INTO\s+public\.inventory_movements/i.test(sql)) {
  fail('shortage must not insert inventory_movements');
}
if (/UPDATE\s+public\.inventory/i.test(sql)) fail('shortage must not update inventory');
if (/UPDATE\s+public\.cities/i.test(sql)) fail('must not change cities');
if (/WHERE\s+transfer_number\s+IN/i.test(sql)) fail('must not rewrite T000001/T000002');
if (/DELETE\s+FROM\s+public\.(cities|inventory|orders|products|stock_transfers)/i.test(sql)) {
  fail('must not delete business rows');
}
if (/UPDATE\s+public\.products\s+SET/i.test(sql)) fail('must not rewrite product prices');

const verify = readFileSync(
  join(process.cwd(), 'supabase', 'prod', 'post_apply_verify_block42.sql'),
  'utf8'
);
const verifyBare = verify.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/im.test(verifyBare)) {
  fail('post_apply_verify_block42.sql must be SELECT-only');
}

if (transferDisplayStatus({ status: 'received_with_variance', remaining: 50, received: 25, lost: 0 }) !== 'В пути (частично получено)') {
  fail('legacy received_with_variance with in-transit must display as in transit');
}
if (transferDisplayStatus({ status: 'received_with_variance', remaining: 0, received: 25, lost: 25 }) !== 'Закрыто с недостачей') {
  fail('closed shortage must display Закрыто с недостачей');
}
if (transferDisplayStatus({ status: 'received_with_variance', remaining: 0, received: 50, lost: 0 }) !== 'Получено') {
  fail('closed variance without loss must not look like shortage');
}
if (transferDisplayStatus({ status: 'in_transit', remaining: 50, received: 0, lost: 0 }) !== 'В пути') {
  fail('plain in transit');
}

const line = transferLineQtys({ qty_sent: 50, qty_received: 25, qty_lost: 10, qty_returned: 5 });
if (line.remaining !== 10) fail('remaining after receive/return/lost');
if (line.lost !== 10) fail('lost qty must stay visible');
if (transferRemaining(50, 25, 10, 5) !== 10) fail('remaining helper');

const parsedUnknown = parseShortageItems({
  items: [{ product_id: 'p1', qty: 50 }],
  reason: 'потеря',
});
if (parsedUnknown[0].unit_cost !== null) fail('missing snapshot cost is unknown, not 0');
if (shortageLineTotal(parsedUnknown[0]) !== null) fail('unknown cost must not become 0 total');

const parsedKnown = parseShortageItems({
  items: [{ product_id: 'p1', qty: 2, unit_cost: 150.5 }],
});
if (shortageLineTotal(parsedKnown[0]) !== 301) fail('known cost total');
const parsedZero = parseShortageItems({ items: [{ product_id: 'p1', qty: 2, unit_cost: 0 }] });
if (parsedZero[0].unit_cost !== 0) fail('explicit zero cost is known, not unknown');
if (shortageLineTotal(parsedZero[0]) !== 0) fail('explicit zero cost totals 0');
const multi = expandShortageEvent({
  eventId: 'e-multi',
  createdAt: '2026-11-01T10:00:00+05:00',
  transferId: 't-multi',
  transferNumber: 'T000101',
  fromCityId: 'sklad',
  toCityId: 'almaty',
  actorId: 'u1',
  actorName: 'Admin',
  details: {
    reason: 'несколько',
    items: [
      { product_id: 'tea', qty: 2, unit_cost: 100 },
      { product_id: 'powder', qty: 3, unit_cost: 50 },
    ],
  },
  productName: (id) => id,
  productUnit: () => 'pcs',
});
if (multi[0].totalCost !== 200 || multi[1].totalCost !== 150) fail('multi-item shortage totals per line');
if (lossKpis(multi).knownValue !== 350) fail('multi-item KPI is sum of per-line totals');

const rows = expandShortageEvent({
  eventId: 'e1',
  createdAt: '2026-11-01T10:00:00+05:00',
  transferId: 't1',
  transferNumber: 'T000099',
  fromCityId: 'sklad',
  toCityId: 'almaty',
  actorId: 'u1',
  actorName: 'Admin',
  details: {
    reason: 'бой',
    items: [
      { product_id: 'tea', qty: 1, unit_cost: 100 },
      { product_id: 'powder', qty: 2 },
    ],
  },
  productName: (id) => (id === 'tea' ? 'Чай' : 'Порошок'),
  productUnit: (id) => (id === 'tea' ? 'pcs' : 'kg'),
});
if (rows.length !== 2) fail('one report row per product line');
const kpis = lossKpis(rows);
if (kpis.knownValue !== 100) fail('KPI must sum only known cost');
if (kpis.unknownLineCount !== 1) fail('unknown lines counted separately');
if (kpis.transferCount !== 1) fail('unique transfers');
if (kpis.qtyByUnit.length !== 2) fail('do not mix units into one number');
if (filterLossRows(rows, { cityId: 'almaty' }).length !== 2) fail('city filter to/from');
if (filterLossRows(rows, { productId: 'tea' }).length !== 1) fail('product filter');
if (filterLossRows(rows, { fromYmd: '2026-11-02' }).length !== 0) fail('period filter');
const utcEdge = expandShortageEvent({
  eventId: 'e2',
  createdAt: '2026-11-01T21:00:00.000Z',
  transferId: 't2',
  transferNumber: 'T000100',
  fromCityId: 'sklad',
  toCityId: 'almaty',
  actorId: 'u1',
  actorName: 'Admin',
  details: { reason: 'x', items: [{ product_id: 'tea', qty: 1, unit_cost: 10 }] },
  productName: () => 'Чай',
  productUnit: () => 'pcs',
});
if (filterLossRows(utcEdge, { fromYmd: '2026-11-02', toYmd: '2026-11-02' }).length !== 1) {
  fail('period filter must use Asia/Almaty date');
}

const sameEventAgain = expandShortageEvent({
  eventId: 'e1',
  createdAt: '2026-11-01T10:00:00+05:00',
  transferId: 't1',
  transferNumber: 'T000099',
  fromCityId: 'sklad',
  toCityId: 'almaty',
  actorId: 'u1',
  actorName: 'Admin',
  details: {
    reason: 'бой',
    items: [{ product_id: 'tea', qty: 1, unit_cost: 100 }],
  },
  productName: () => 'Чай',
  productUnit: () => 'pcs',
});
if (sameEventAgain.length !== 1) fail('reload of the same event must not invent extra loss rows');

if (
  !isMissingCostBackend('Could not find the function public.admin_product_costs without parameters in the schema cache')
) {
  fail('missing RPC must be treated as absent cost backend');
}
if (!isMissingCostBackend('column products.cost_price does not exist')) fail('missing column message');
const catalog = productCatalogPayload({
  name: 'Чай',
  category: null,
  unit: 'pcs',
  price_retail: 1000,
  is_active: true,
});
if ('cost_price' in catalog) fail('catalog payload must not include cost_price');
const merged = mergeProductCosts([{ id: 'p1', name: 'Чай' }], null);
if (merged[0].cost_price !== null) fail('absent RPC must not invent cost');
if (PRODUCT_CATALOG_SELECT.includes('cost_price')) fail('catalog select must not request cost_price');

console.log('OK');
