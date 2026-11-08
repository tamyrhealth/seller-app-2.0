import { MAP_PAD, MAP_VB_H, MAP_VB_W, projectKz } from '@/lib/adminMap';
import { findKzGeoCity, type KzGeoCity } from '@/lib/kzCityCoords';
import {
  transferDisplayStatus,
  transferLineQtys,
  transferRemaining,
  transferTotals,
  type TransferStatus,
} from '@/lib/stockTransfer';

export type MapTransferWarehouse = {
  id: string;
  name: string;
};

export type MapTransferProduct = {
  id: string;
  name: string;
  unit?: string | null;
};

export type MapTransferItemInput = {
  product_id: string;
  qty_sent: number;
  qty_received?: number | null;
  qty_lost?: number | null;
  qty_returned?: number | null;
};

export type MapTransferInput = {
  id: string;
  transfer_number: string;
  from_city_id: string;
  to_city_id: string;
  status: string;
  created_at: string;
  items?: MapTransferItemInput[] | null;
  stock_transfer_items?: MapTransferItemInput[] | null;
};

export type MapTransferLine = {
  productId: string;
  name: string;
  unit: string;
  sent: number;
  received: number;
  lost: number;
  returned: number;
  remaining: number;
};

export type MapTransferDocument = {
  id: string;
  transferNumber: string;
  status: string;
  displayStatus: string;
  createdAt: string;
  fromCityId: string;
  fromWarehouseName: string;
  toCityId: string;
  toWarehouseName: string;
  fromGeoId: string | null;
  toGeoId: string | null;
  sent: number;
  received: number;
  lost: number;
  returned: number;
  remaining: number;
  items: MapTransferLine[];
};

export type MapTransferEndpoint = {
  geoId: string | null;
  nameRu: string | null;
  nameKz: string | null;
  lat: number | null;
  lng: number | null;
  x: number | null;
  y: number | null;
};

export type MapTransferGroupKind = 'route' | 'local' | 'unknown';

export type MapTransferGroup = {
  id: string;
  kind: MapTransferGroupKind;
  direction: string;
  from: MapTransferEndpoint;
  to: MapTransferEndpoint;
  documentCount: number;
  remaining: number;
  intraCity: boolean;
  missingCoords: boolean;
  hasLine: boolean;
  documents: MapTransferDocument[];
};

export type AdminMapTransfersReport = {
  groups: MapTransferGroup[];
  routes: MapTransferGroup[];
  local: MapTransferGroup[];
  unknown: MapTransferGroup[];
  activeCount: number;
  documentCount: number;
  itemCount: number;
};

function qty3(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/** Same remaining as forecast inbound, with floor at 0. */
export function mapTransferLineRemaining(
  sent: number,
  received?: number | null,
  lost?: number | null,
  returned?: number | null
): number {
  return qty3(Math.max(0, transferRemaining(sent, received, lost, returned)));
}

export function isActiveMapTransfer(status: string, remaining: number): boolean {
  return status === 'in_transit' && remaining > 0;
}

function itemsOf(transfer: MapTransferInput): MapTransferItemInput[] {
  return transfer.items || transfer.stock_transfer_items || [];
}

function warehouseName(warehouses: MapTransferWarehouse[], cityId: string): string {
  return warehouses.find((w) => w.id === cityId)?.name || cityId;
}

function productMeta(
  products: MapTransferProduct[] | undefined,
  productId: string
): { name: string; unit: string } {
  const p = products?.find((row) => row.id === productId);
  return { name: p?.name || productId, unit: p?.unit || '' };
}

function geoEndpoint(geo: KzGeoCity | null): MapTransferEndpoint {
  if (!geo) {
    return { geoId: null, nameRu: null, nameKz: null, lat: null, lng: null, x: null, y: null };
  }
  const { x, y } = projectKz(geo.lng, geo.lat);
  return {
    geoId: geo.id,
    nameRu: geo.nameRu,
    nameKz: geo.nameKz,
    lat: geo.lat,
    lng: geo.lng,
    x,
    y,
  };
}

function emptyEndpoint(): MapTransferEndpoint {
  return { geoId: null, nameRu: null, nameKz: null, lat: null, lng: null, x: null, y: null };
}

export function mapTransferDocument(
  transfer: MapTransferInput,
  warehouses: MapTransferWarehouse[],
  products?: MapTransferProduct[]
): MapTransferDocument {
  const lines = itemsOf(transfer);
  const items: MapTransferLine[] = lines.map((item) => {
    const q = transferLineQtys(item);
    const meta = productMeta(products, item.product_id);
    return {
      productId: item.product_id,
      name: meta.name,
      unit: meta.unit,
      sent: q.sent,
      received: q.received,
      lost: q.lost,
      returned: q.returned,
      remaining: mapTransferLineRemaining(q.sent, q.received, q.lost, q.returned),
    };
  });
  const totals = transferTotals(lines);
  const remaining = qty3(items.reduce((sum, item) => sum + item.remaining, 0));
  const fromName = warehouseName(warehouses, transfer.from_city_id);
  const toName = warehouseName(warehouses, transfer.to_city_id);
  return {
    id: transfer.id,
    transferNumber: transfer.transfer_number,
    status: transfer.status,
    displayStatus: transferDisplayStatus({
      status: transfer.status,
      remaining,
      received: totals.received,
      lost: totals.lost,
    }),
    createdAt: transfer.created_at,
    fromCityId: transfer.from_city_id,
    fromWarehouseName: fromName,
    toCityId: transfer.to_city_id,
    toWarehouseName: toName,
    fromGeoId: findKzGeoCity(fromName)?.id ?? null,
    toGeoId: findKzGeoCity(toName)?.id ?? null,
    sent: qty3(totals.sent),
    received: qty3(totals.received),
    lost: qty3(totals.lost),
    returned: qty3(totals.returned),
    remaining,
    items,
  };
}

function groupKind(doc: MapTransferDocument): MapTransferGroupKind {
  if (!doc.fromGeoId || !doc.toGeoId) return 'unknown';
  if (doc.fromGeoId === doc.toGeoId) return 'local';
  return 'route';
}

function groupId(kind: MapTransferGroupKind, doc: MapTransferDocument): string {
  if (kind === 'unknown') return 'unknown';
  if (kind === 'local') return `local:${doc.fromGeoId}`;
  return `route:${doc.fromGeoId}->${doc.toGeoId}`;
}

function directionLabel(kind: MapTransferGroupKind, from: MapTransferEndpoint, to: MapTransferEndpoint): string {
  if (kind === 'unknown') return 'unknown';
  if (kind === 'local') return `${from.geoId}->${from.geoId}`;
  return `${from.geoId}->${to.geoId}`;
}

function sortDocuments(a: MapTransferDocument, b: MapTransferDocument): number {
  const t = a.createdAt.localeCompare(b.createdAt);
  if (t) return t;
  const n = a.transferNumber.localeCompare(b.transferNumber);
  if (n) return n;
  return a.id.localeCompare(b.id);
}

function sortGroups(a: MapTransferGroup, b: MapTransferGroup): number {
  const order: Record<MapTransferGroupKind, number> = { route: 0, local: 1, unknown: 2 };
  const k = order[a.kind] - order[b.kind];
  if (k) return k;
  return a.id.localeCompare(b.id);
}

export function buildAdminMapTransfers(opts: {
  transfers: MapTransferInput[];
  warehouses: MapTransferWarehouse[];
  products?: MapTransferProduct[];
}): AdminMapTransfersReport {
  const active: MapTransferDocument[] = [];
  for (const transfer of opts.transfers) {
    const doc = mapTransferDocument(transfer, opts.warehouses, opts.products);
    if (!isActiveMapTransfer(doc.status, doc.remaining)) continue;
    active.push(doc);
  }

  const buckets = new Map<string, MapTransferGroup>();
  for (const doc of active) {
    const kind = groupKind(doc);
    const id = groupId(kind, doc);
    let group = buckets.get(id);
    if (!group) {
      const fromGeo = doc.fromGeoId ? findKzGeoCity(doc.fromWarehouseName) : null;
      const toGeo = doc.toGeoId ? findKzGeoCity(doc.toWarehouseName) : null;
      const from = kind === 'unknown' ? emptyEndpoint() : geoEndpoint(fromGeo);
      const to = kind === 'unknown' ? emptyEndpoint() : geoEndpoint(toGeo);
      const intraCity = kind === 'local';
      const missingCoords = kind === 'unknown';
      group = {
        id,
        kind,
        direction: directionLabel(kind, from, to),
        from,
        to,
        documentCount: 0,
        remaining: 0,
        intraCity,
        missingCoords,
        hasLine: kind === 'route',
        documents: [],
      };
      buckets.set(id, group);
    }
    group.documents.push(doc);
  }

  const groups = Array.from(buckets.values()).map((group) => {
    const documents = [...group.documents].sort(sortDocuments);
    return {
      ...group,
      documents,
      documentCount: documents.length,
      remaining: qty3(documents.reduce((sum, doc) => sum + doc.remaining, 0)),
    };
  });
  groups.sort(sortGroups);

  const routes = groups.filter((g) => g.kind === 'route');
  const local = groups.filter((g) => g.kind === 'local');
  const unknown = groups.filter((g) => g.kind === 'unknown');

  return {
    groups,
    routes,
    local,
    unknown,
    activeCount: active.length,
    documentCount: active.length,
    itemCount: active.reduce((sum, doc) => sum + doc.items.length, 0),
  };
}

const EMPTY_MAP_TRANSFERS: AdminMapTransfersReport = {
  groups: [],
  routes: [],
  local: [],
  unknown: [],
  activeCount: 0,
  documentCount: 0,
  itemCount: 0,
};

/** Incomplete or failed loads must not be drawn as if they were the full picture. */
export function mapTransfersForDisplay(
  report: AdminMapTransfersReport,
  source: { error?: string | null; truncated?: boolean }
): AdminMapTransfersReport {
  if (source.error || source.truncated) return EMPTY_MAP_TRANSFERS;
  return report;
}

export const MAP_TRANSFER_ACTIVE_STATUS: TransferStatus = 'in_transit';
export const MAP_TRANSFER_PAGE = 1000;
export const MAP_TRANSFER_MAX = 8000;

export const MAP_TRUCK_DURATION_SEC = 11;

export type TransferRouteArc = {
  d: string;
  mx: number;
  my: number;
  bx: number;
  by: number;
  ax: number;
  ay: number;
  angleDeg: number;
  midAngleDeg: number;
};

function clampMap(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function quadPoint(
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  x2: number,
  y2: number,
  t: number
): { x: number; y: number } {
  const omt = 1 - t;
  return {
    x: omt * omt * x1 + 2 * omt * t * cx + t * t * x2,
    y: omt * omt * y1 + 2 * omt * t * cy + t * t * y2,
  };
}

/** Left-of-travel quadratic. Reverse direction bends the other way. Curve stays in the map viewBox. */
export function transferRouteArc(from: { x: number; y: number }, to: { x: number; y: number }): TransferRouteArc | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 24) return null;
  const ux = dx / dist;
  const uy = dy / dist;
  const px = -uy;
  const py = ux;
  const inset = Math.min(26, dist * 0.16);
  const x1 = from.x + ux * inset;
  const y1 = from.y + uy * inset;
  const x2 = to.x - ux * inset;
  const y2 = to.y - uy * inset;
  const bend = Math.min(72, Math.max(22, dist * 0.16));
  const cx = clampMap((x1 + x2) / 2 + px * bend, MAP_PAD, MAP_VB_W - MAP_PAD);
  const cy = clampMap((y1 + y2) / 2 + py * bend, MAP_PAD, MAP_VB_H - MAP_PAD);
  const mid = quadPoint(x1, y1, cx, cy, x2, y2, 0.5);
  const tip = quadPoint(x1, y1, cx, cy, x2, y2, 0.88);
  const tan = (t: number) => {
    const omt = 1 - t;
    return {
      x: 2 * omt * (cx - x1) + 2 * t * (x2 - cx),
      y: 2 * omt * (cy - y1) + 2 * t * (y2 - cy),
    };
  };
  const tipTan = tan(0.88);
  const midTan = tan(0.5);
  return {
    d: `M ${x1.toFixed(2)} ${y1.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    mx: mid.x,
    my: mid.y,
    bx: clampMap(mid.x + px * 16, MAP_PAD, MAP_VB_W - MAP_PAD),
    by: clampMap(mid.y + py * 16, MAP_PAD, MAP_VB_H - MAP_PAD),
    ax: tip.x,
    ay: tip.y,
    angleDeg: (Math.atan2(tipTan.y, tipTan.x) * 180) / Math.PI,
    midAngleDeg: (Math.atan2(midTan.y, midTan.x) * 180) / Math.PI,
  };
}
