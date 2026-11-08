import { readFileSync } from 'fs';
import { join } from 'path';
import { buildAdminForecast } from '../lib/adminForecast';
import {
  buildAdminMapTransfers,
  isActiveMapTransfer,
  mapTransferLineRemaining,
  mapTransfersForDisplay,
  MAP_TRANSFER_MAX,
  MAP_TRANSFER_PAGE,
  MAP_TRUCK_DURATION_SEC,
  transferRouteArc,
} from '../lib/adminMapTransfers';
import { MAP_PAD, MAP_VB_H, MAP_VB_W, projectKz } from '../lib/adminMap';
import { transferRemaining } from '../lib/stockTransfer';

function fail(msg: string): never {
  console.error('FAIL', msg);
  process.exit(1);
}

function read(rel: string) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

const warehouses = [
  { id: 'c-atyrau', name: 'Атырау' },
  { id: 'c-office', name: 'Алматы-Офис' },
  { id: 'c-galia', name: 'Алматы-Ғалия' },
  { id: 'c-sklad', name: 'SKLAD' },
  { id: 'c-west', name: 'Склад Запад 12' },
];

const products = [
  { id: 'p1', name: 'Мука', unit: 'kg' },
  { id: 'p2', name: 'Коробка', unit: 'pcs' },
];

function transfer(
  partial: {
    id: string;
    transfer_number: string;
    from_city_id: string;
    to_city_id: string;
    status: string;
    created_at?: string;
    items: Array<{
      product_id: string;
      qty_sent: number;
      qty_received?: number | null;
      qty_lost?: number | null;
      qty_returned?: number | null;
    }>;
  }
) {
  return {
    created_at: '2026-11-01T06:00:00.000Z',
    ...partial,
  };
}

const ordinary = transfer({
  id: 't1',
  transfer_number: 'T00001',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-office',
  status: 'in_transit',
  items: [{ product_id: 'p1', qty_sent: 10, qty_received: 0, qty_lost: 0, qty_returned: 0 }],
});

const partial = transfer({
  id: 't2',
  transfer_number: 'T00002',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-office',
  status: 'in_transit',
  created_at: '2026-11-02T06:00:00.000Z',
  items: [{ product_id: 'p1', qty_sent: 20, qty_received: 8, qty_lost: 0, qty_returned: 0 }],
});

const received = transfer({
  id: 't3',
  transfer_number: 'T00003',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-office',
  status: 'received',
  items: [{ product_id: 'p1', qty_sent: 5, qty_received: 5, qty_lost: 0, qty_returned: 0 }],
});

const cancelled = transfer({
  id: 't4',
  transfer_number: 'T00004',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-office',
  status: 'cancelled',
  items: [{ product_id: 'p1', qty_sent: 7, qty_received: 0, qty_lost: 0, qty_returned: 0 }],
});

const shortageClosed = transfer({
  id: 't5',
  transfer_number: 'T00005',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-office',
  status: 'received_with_variance',
  items: [{ product_id: 'p1', qty_sent: 10, qty_received: 7, qty_lost: 3, qty_returned: 0 }],
});

const remainingZero = transfer({
  id: 't6',
  transfer_number: 'T00006',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-office',
  status: 'in_transit',
  items: [{ product_id: 'p1', qty_sent: 4, qty_received: 4, qty_lost: 0, qty_returned: 0 }],
});

const reverse = transfer({
  id: 't7',
  transfer_number: 'T00007',
  from_city_id: 'c-office',
  to_city_id: 'c-atyrau',
  status: 'in_transit',
  items: [{ product_id: 'p2', qty_sent: 3, qty_received: 0 }],
});

const almatyLocal = transfer({
  id: 't8',
  transfer_number: 'T00008',
  from_city_id: 'c-office',
  to_city_id: 'c-galia',
  status: 'in_transit',
  items: [{ product_id: 'p1', qty_sent: 2.5, qty_received: 0 }],
});

const skladLocal = transfer({
  id: 't9',
  transfer_number: 'T00009',
  from_city_id: 'c-sklad',
  to_city_id: 'c-office',
  status: 'in_transit',
  items: [{ product_id: 'p2', qty_sent: 1, qty_received: 0 }],
});

const unknownCity = transfer({
  id: 't10',
  transfer_number: 'T00010',
  from_city_id: 'c-west',
  to_city_id: 'c-office',
  status: 'in_transit',
  items: [{ product_id: 'p1', qty_sent: 6, qty_received: 1, qty_lost: 0, qty_returned: 0 }],
});

const fractional = transfer({
  id: 't11',
  transfer_number: 'T00011',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-galia',
  status: 'in_transit',
  created_at: '2026-11-03T06:00:00.000Z',
  items: [
    { product_id: 'p1', qty_sent: 1.255, qty_received: 0.25, qty_lost: 0, qty_returned: 0 },
    { product_id: 'p2', qty_sent: 2, qty_received: 0, qty_lost: 0, qty_returned: 0 },
  ],
});

const shortageStillOpen = transfer({
  id: 't12',
  transfer_number: 'T00012',
  from_city_id: 'c-atyrau',
  to_city_id: 'c-office',
  status: 'in_transit',
  created_at: '2026-11-04T06:00:00.000Z',
  items: [{ product_id: 'p1', qty_sent: 10, qty_received: 4, qty_lost: 2, qty_returned: 0 }],
});

if (isActiveMapTransfer('in_transit', 0)) fail('remaining 0 is not active');
if (isActiveMapTransfer('received', 1)) fail('received is not active');
if (isActiveMapTransfer('received_with_variance', 1)) fail('variance is not active');
if (isActiveMapTransfer('cancelled', 9)) fail('cancelled is not active');
if (!isActiveMapTransfer('in_transit', 0.001)) fail('tiny remaining stays active');

const expectedPartialRemain = mapTransferLineRemaining(20, 8, 0, 0);
if (expectedPartialRemain !== 12) fail(`partial remaining ${expectedPartialRemain}`);
if (mapTransferLineRemaining(10, 7, 3, 0) !== 0) fail('closed shortage remaining');
if (mapTransferLineRemaining(1.255, 0.25, 0, 0) !== 1.005) fail('fraction remaining');
if (mapTransferLineRemaining(5, 8, 0, 0) !== 0) fail('over-receive floors at 0');

const report = buildAdminMapTransfers({
  transfers: [
    ordinary,
    partial,
    received,
    cancelled,
    shortageClosed,
    remainingZero,
    reverse,
    almatyLocal,
    skladLocal,
    unknownCity,
    fractional,
    shortageStillOpen,
  ],
  warehouses,
  products,
});

const ids = report.groups.flatMap((g) => g.documents.map((d) => d.id)).sort();
const expectedIds = ['t1', 't2', 't7', 't8', 't9', 't10', 't11', 't12'].sort();
if (ids.join(',') !== expectedIds.join(',')) fail(`active ids ${ids.join(',')}`);
if (report.activeCount !== 8) fail(`activeCount ${report.activeCount}`);
if (new Set(ids).size !== ids.length) fail('duplicate documents');
if (report.documentCount !== report.activeCount) fail('documentCount mismatch');

const atyrauAlmaty = report.routes.find((g) => g.id === 'route:atyrau->almaty');
if (!atyrauAlmaty) fail('Atyrau→Almaty group');
if (atyrauAlmaty.documentCount !== 4) fail(`Atyrau→Almaty count ${atyrauAlmaty.documentCount}`);
if (atyrauAlmaty.intraCity || atyrauAlmaty.missingCoords || !atyrauAlmaty.hasLine) {
  fail('intercity must have a line and coords');
}
if (atyrauAlmaty.documents.map((d) => d.transferNumber).join(',') !== 'T00001,T00002,T00011,T00012') {
  fail('same-direction docs stay listed separately');
}
const t2 = atyrauAlmaty.documents.find((d) => d.id === 't2');
if (!t2 || t2.remaining !== 12 || t2.displayStatus !== 'В пути (частично получено)') fail('partial receive');
const t12 = atyrauAlmaty.documents.find((d) => d.id === 't12');
if (!t12 || t12.remaining !== 4 || t12.lost !== 2) fail('open shortage keeps remaining');
const t11 = atyrauAlmaty.documents.find((d) => d.id === 't11');
if (!t11 || t11.items.length !== 2 || t11.remaining !== 3.005) fail('fractional two lines');
if (t11.items[0].name !== 'Мука' || t11.items[1].name !== 'Коробка') fail('product names');

const almatyAtyrau = report.routes.find((g) => g.id === 'route:almaty->atyrau');
if (!almatyAtyrau || almatyAtyrau.documentCount !== 1 || almatyAtyrau.documents[0].id !== 't7') {
  fail('reverse direction is a separate group');
}

const pAlmaty = projectKz(76.8897, 43.2389);
const pAtyrau = projectKz(51.9238, 47.0945);
if (atyrauAlmaty.from.geoId !== 'atyrau' || atyrauAlmaty.to.geoId !== 'almaty') fail('geo endpoints');
if (atyrauAlmaty.from.x !== pAtyrau.x || atyrauAlmaty.to.x !== pAlmaty.x) fail('projected coords');
if (almatyAtyrau.from.geoId !== 'almaty' || almatyAtyrau.to.geoId !== 'atyrau') fail('reverse endpoints');

const local = report.local.find((g) => g.id === 'local:almaty');
if (!local) fail('Almaty intra-city group');
if (local.hasLine) fail('intra-city must not request an intercity line');
if (!local.intraCity || local.missingCoords) fail('intra-city flags');
if (local.documentCount !== 2) fail(`local count ${local.documentCount}`);
const localNums = local.documents.map((d) => d.transferNumber).sort().join(',');
if (localNums !== 'T00008,T00009') fail(`local docs ${localNums}`);
if (local.documents.some((d) => d.fromWarehouseName === d.toWarehouseName)) fail('local keeps distinct warehouses');
if (local.from.geoId !== 'almaty' || local.to.geoId !== 'almaty') fail('SKLAD maps to Almaty');
if (local.from.lat !== local.to.lat) fail('same-city coords');

const unknown = report.unknown[0];
if (!unknown || unknown.documentCount !== 1 || unknown.documents[0].id !== 't10') fail('unknown city group');
if (unknown.hasLine || !unknown.missingCoords || unknown.intraCity) fail('unknown must not draw a line');
if (unknown.from.lat != null || unknown.to.lng != null) fail('must not invent coords for unknown');
if (unknown.documents[0].remaining !== 5) fail('unknown remaining');
if (unknown.documents[0].fromWarehouseName !== 'Склад Запад 12') fail('unknown warehouse name kept');

if (report.groups.some((g) => g.documents.some((d) => ['t3', 't4', 't5', 't6'].includes(d.id)))) {
  fail('closed transfers leaked onto the map');
}

const itemIds = report.groups.flatMap((g) => g.documents.flatMap((d) => d.items.map((i) => `${d.id}:${i.productId}`)));
if (new Set(itemIds).size !== itemIds.length) fail('duplicate line items');
if (report.itemCount !== itemIds.length) fail('itemCount');

const routeRemain = atyrauAlmaty.remaining;
const sumDocs = atyrauAlmaty.documents.reduce((s, d) => s + d.remaining, 0);
if (Math.abs(routeRemain - sumDocs) > 1e-9) fail('group remaining is sum of documents, not double-counted items');

const forecast = buildAdminForecast({
  todayYmd: '2026-11-08',
  window: 30,
  complete: true,
  params: { leadDays: 20, safetyDays: 10, targetDays: 40 },
  catalog: [{ id: 'p1', name: 'Мука', unit: 'kg', isActive: true }],
  cities: [
    { id: 'c-office', name: 'Алматы-Офис' },
    { id: 'c-atyrau', name: 'Атырау' },
  ],
  inventory: [{ city_id: 'c-office', product_id: 'p1', qty_on_hand: 0 }],
  orders: [],
  transfers: [
    {
      id: 't2',
      status: 'in_transit',
      from_city_id: 'c-atyrau',
      to_city_id: 'c-office',
      stock_transfer_items: [{ product_id: 'p1', qty_sent: 20, qty_received: 8, qty_lost: 0, qty_returned: 0 }],
    },
    {
      id: 't4',
      status: 'cancelled',
      from_city_id: 'c-atyrau',
      to_city_id: 'c-office',
      stock_transfer_items: [{ product_id: 'p1', qty_sent: 7, qty_received: 0, qty_lost: 0, qty_returned: 0 }],
    },
    {
      id: 't5',
      status: 'received_with_variance',
      from_city_id: 'c-atyrau',
      to_city_id: 'c-office',
      stock_transfer_items: [{ product_id: 'p1', qty_sent: 10, qty_received: 7, qty_lost: 3, qty_returned: 0 }],
    },
  ],
});
const flour = forecast.cityRows.find((r) => r.productId === 'p1' && r.cityId === 'c-office');
if (!flour) fail('forecast row');
if (flour.inbound !== 12) fail(`forecast inbound must stay 12, got ${flour.inbound}`);
if (t2.remaining !== flour.inbound) fail('map remaining must match forecast inbound for the same lines');
if (mapTransferLineRemaining(20, 8, 0, 0) !== Math.max(0, transferRemaining(20, 8, 0, 0))) {
  fail('map remaining must reuse transferRemaining');
}

const layer = read('lib/adminMapTransfers.ts');
const forecastSrc = read('lib/adminForecast.ts');
const fetchSrc = read('lib/fetchAdminMapTransfers.ts');
const page = read('app/admin/map/page.tsx');
const map = read('components/AdminKazakhstanMap.tsx');
if (!layer.includes("from '@/lib/stockTransfer'")) fail('must reuse stockTransfer remaining');
if (layer.includes('function transferRemaining')) fail('do not duplicate remaining');
if (forecastSrc.includes('adminMapTransfers')) fail('forecast must not depend on map transfers');
if (!map.includes('animateMotion') || !map.includes('TransferTruckIcon')) fail('intercity truck icon');
if (MAP_TRUCK_DURATION_SEC < 10 || MAP_TRUCK_DURATION_SEC > 12) fail('truck cycle must be 10–12s');
if (page.includes('create_stock_transfer')) fail('read-only');
if (MAP_TRANSFER_PAGE !== 1000 || MAP_TRANSFER_MAX < MAP_TRANSFER_PAGE) fail('transfer page size');
if (!fetchSrc.includes(".eq('status', 'in_transit')") || !fetchSrc.includes('.range(')) fail('paged in_transit select');
if (page.includes('create_stock_transfer') || page.includes('.insert(') || page.includes('.update(')) {
  fail('map transfers are read-only');
}

const aToB = transferRouteArc(pAtyrau, pAlmaty);
const bToA = transferRouteArc(pAlmaty, pAtyrau);
if (!aToB || !bToA) fail('intercity arcs');
if (aToB.d === bToA.d) fail('reverse direction must be a separate arc');
if (aToB.midAngleDeg === bToA.midAngleDeg) fail('paused trucks face opposite directions');
if (!Number.isFinite(aToB.midAngleDeg) || !Number.isFinite(bToA.bx)) fail('midpoint pose for reduced-motion');
function side(from: { x: number; y: number }, to: { x: number; y: number }, p: { x: number; y: number }) {
  return (to.x - from.x) * (p.y - from.y) - (to.y - from.y) * (p.x - from.x);
}
if (side(pAtyrau, pAlmaty, { x: aToB.mx, y: aToB.my }) * side(pAtyrau, pAlmaty, { x: bToA.mx, y: bToA.my }) >= 0) {
  fail('opposite directions must bend apart');
}
for (const arc of [aToB, bToA]) {
  for (const p of [
    { x: arc.mx, y: arc.my },
    { x: arc.ax, y: arc.ay },
  ]) {
    if (p.x < MAP_PAD || p.y < MAP_PAD || p.x > MAP_VB_W - MAP_PAD || p.y > MAP_VB_H - MAP_PAD) {
      fail('arc must stay inside map viewBox');
    }
  }
}
if (atyrauAlmaty.hasLine !== true || local.hasLine !== false || unknown.hasLine !== false) {
  fail('only intercity groups request a line');
}

const hiddenError = mapTransfersForDisplay(report, { error: 'fail' });
const hiddenTrunc = mapTransfersForDisplay(report, { truncated: true });
const shown = mapTransfersForDisplay(report, { error: null, truncated: false });
if (hiddenError.routes.length || hiddenError.local.length || hiddenError.unknown.length || hiddenError.activeCount) {
  fail('failed transfer load must not draw a partial map');
}
if (hiddenTrunc.routes.length || hiddenTrunc.activeCount !== 0) fail('truncated in_transit list must not be drawn as complete');
if (shown.routes.length !== report.routes.length || shown.activeCount !== report.activeCount) {
  fail('complete load must keep transfer overlay');
}
if (!page.includes('mapTransfersForDisplay')) fail('page must hide unreliable transfer overlay');

console.log('admin-map-transfers checks ok');
console.log(
  `active=${report.activeCount} routes=${report.routes.length} local=${report.local.length} unknown=${report.unknown.length} items=${report.itemCount}`
);
