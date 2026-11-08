import { findKzGeoCity, type KzGeoCity } from '@/lib/kzCityCoords';
import { KZ_OUTLINE } from '@/lib/kzMapOutline';

export const MAP_VB_W = 1000;
export const MAP_VB_H = 640;
export const MAP_PAD = 36;
export const SPIDERFY_MIN_SEP = 88;
export const MARKER_MIN_SEP = 34;

export type MapCityInput = {
  id: string;
  name: string;
  address?: string | null;
  is_active?: boolean | null;
};

export type MapInventoryInput = {
  city_id: string;
  product_id: string;
  qty_on_hand: number | string | null;
};

export type MapProductInput = {
  id: string;
  name: string;
  unit: string;
  is_active?: boolean | null;
};

export type MapStockRow = {
  productId: string;
  name: string;
  unit: string;
  qtyOnHand: number;
};

export type MapSeller = {
  cityId: string;
  name: string;
  address: string | null;
  isActive: boolean;
  stocks: MapStockRow[];
  negativeCount: number;
};

export type MapGeoMarker = {
  geoId: string;
  nameRu: string;
  nameKz: string;
  lat: number;
  lng: number;
  x: number;
  y: number;
  sellers: MapSeller[];
};

export type AdminMapReport = {
  markers: MapGeoMarker[];
  unknown: MapSeller[];
};

export type MapSelection = {
  expandedGeoId: string | null;
  selectedCityId: string | null;
  selectedTransferGroupId: string | null;
};

export type MapClickTarget =
  | { type: 'background' }
  | { type: 'geo'; geoId: string }
  | { type: 'seller'; geoId: string; cityId: string };

type Bounds = { minLon: number; maxLon: number; minLat: number; maxLat: number };

function qty3(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function outlineBounds(): Bounds {
  let minLon = 180;
  let maxLon = -180;
  let minLat = 90;
  let maxLat = -90;
  for (const [lon, lat] of KZ_OUTLINE) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

const BOUNDS = outlineBounds();

export function projectKz(
  lon: number,
  lat: number,
  width = MAP_VB_W,
  height = MAP_VB_H,
  pad = MAP_PAD
): { x: number; y: number } {
  const x = pad + ((lon - BOUNDS.minLon) / (BOUNDS.maxLon - BOUNDS.minLon)) * (width - 2 * pad);
  const y = pad + ((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * (height - 2 * pad);
  return { x, y };
}

export function kzOutlinePath(width = MAP_VB_W, height = MAP_VB_H, pad = MAP_PAD): string {
  return KZ_OUTLINE.map(([lon, lat], i) => {
    const { x, y } = projectKz(lon, lat, width, height, pad);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ') + ' Z';
}

export function pointInKzOutline(lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = KZ_OUTLINE.length - 1; i < KZ_OUTLINE.length; j = i++) {
    const [xi, yi] = KZ_OUTLINE[i];
    const [xj, yj] = KZ_OUTLINE[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function spiderfyOffsets(
  count: number,
  minSep = SPIDERFY_MIN_SEP
): Array<{ dx: number; dy: number }> {
  if (count <= 1) return [];
  const radius = Math.max(minSep, minSep / (2 * Math.sin(Math.PI / count)));
  const start = -Math.PI / 2;
  const out: Array<{ dx: number; dy: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const angle = start + (2 * Math.PI * i) / count;
    out.push({ dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius });
  }
  return out;
}

export function spiderfyOffsetsForOrigin(
  count: number,
  origin: { x: number; y: number },
  minSep = SPIDERFY_MIN_SEP
): Array<{ dx: number; dy: number }> {
  const offsets = spiderfyOffsets(count, minSep);
  if (!offsets.length) return offsets;
  const margin = 30;
  let shiftX = 0;
  let shiftY = 0;
  for (const off of offsets) {
    const x = origin.x + off.dx;
    const y = origin.y + off.dy;
    if (x < margin) shiftX = Math.max(shiftX, margin - x);
    if (x > MAP_VB_W - margin) shiftX = Math.min(shiftX, MAP_VB_W - margin - x);
    if (y < margin) shiftY = Math.max(shiftY, margin - y);
    if (y > MAP_VB_H - margin) shiftY = Math.min(shiftY, MAP_VB_H - margin - y);
  }
  return offsets.map((off) => ({ dx: off.dx + shiftX, dy: off.dy + shiftY }));
}

function separateCloseMarkers(markers: MapGeoMarker[], minSep = MARKER_MIN_SEP) {
  for (let iter = 0; iter < 10; iter += 1) {
    let moved = false;
    for (let i = 0; i < markers.length; i += 1) {
      for (let j = i + 1; j < markers.length; j += 1) {
        const a = markers[i];
        const b = markers[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        if (dist >= minSep) continue;
        const push = (minSep - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        a.x = Math.min(MAP_VB_W - MAP_PAD, Math.max(MAP_PAD, a.x));
        a.y = Math.min(MAP_VB_H - MAP_PAD, Math.max(MAP_PAD, a.y));
        b.x = Math.min(MAP_VB_W - MAP_PAD, Math.max(MAP_PAD, b.x));
        b.y = Math.min(MAP_VB_H - MAP_PAD, Math.max(MAP_PAD, b.y));
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function pairMinDistance(points: Array<{ dx: number; dy: number }>): number {
  let min = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const d = Math.hypot(points[i].dx - points[j].dx, points[i].dy - points[j].dy);
      if (d < min) min = d;
    }
  }
  return min;
}

export function spiderfyMinDistance(count: number, minSep = SPIDERFY_MIN_SEP): number {
  return pairMinDistance(spiderfyOffsets(count, minSep));
}

function buildSeller(
  city: MapCityInput,
  stocksByCity: Map<string, MapStockRow[]>
): MapSeller {
  const stocks = (stocksByCity.get(city.id) || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return {
    cityId: city.id,
    name: city.name,
    address: city.address?.trim() ? city.address.trim() : null,
    isActive: city.is_active !== false,
    stocks,
    negativeCount: stocks.filter((s) => s.qtyOnHand < 0).length,
  };
}

export function buildAdminMap(input: {
  cities: MapCityInput[];
  inventory: MapInventoryInput[];
  products: MapProductInput[];
}): AdminMapReport {
  const catalog = new Map(input.products.map((p) => [p.id, p]));
  const stocksByCity = new Map<string, MapStockRow[]>();
  for (const row of input.inventory) {
    if (!row.city_id || !row.product_id) continue;
    const product = catalog.get(row.product_id);
    const qty = qty3(Number(row.qty_on_hand || 0));
    if (!product) continue;
    if (product.is_active === false && !(Math.abs(qty) > 0)) continue;
    const list = stocksByCity.get(row.city_id) || [];
    list.push({
      productId: product.id,
      name: product.name,
      unit: product.unit || 'pcs',
      qtyOnHand: qty,
    });
    stocksByCity.set(row.city_id, list);
  }

  const grouped = new Map<string, { geo: KzGeoCity; sellers: MapSeller[] }>();
  const unknown: MapSeller[] = [];

  for (const city of input.cities) {
    if (!city.id) continue;
    const seller = buildSeller(city, stocksByCity);
    const geo = findKzGeoCity(city.name);
    if (!geo) {
      unknown.push(seller);
      continue;
    }
    const bucket = grouped.get(geo.id) || { geo, sellers: [] };
    bucket.sellers.push(seller);
    grouped.set(geo.id, bucket);
  }

  const markers: MapGeoMarker[] = [];
  for (const { geo, sellers } of grouped.values()) {
    sellers.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const { x, y } = projectKz(geo.lng, geo.lat);
    markers.push({
      geoId: geo.id,
      nameRu: geo.nameRu,
      nameKz: geo.nameKz,
      lat: geo.lat,
      lng: geo.lng,
      x,
      y,
      sellers,
    });
  }
  separateCloseMarkers(markers);
  markers.sort((a, b) => a.nameRu.localeCompare(b.nameRu, 'ru'));
  unknown.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { markers, unknown };
}

export function reduceMapClick(state: MapSelection, target: MapClickTarget, marker?: MapGeoMarker | null): MapSelection {
  if (target.type === 'background') {
    return { expandedGeoId: null, selectedCityId: null, selectedTransferGroupId: null };
  }
  if (target.type === 'seller') {
    return { expandedGeoId: target.geoId, selectedCityId: target.cityId, selectedTransferGroupId: null };
  }
  const sellers = marker?.sellers || [];
  if (sellers.length <= 1) {
    return { expandedGeoId: null, selectedCityId: sellers[0]?.cityId || null, selectedTransferGroupId: null };
  }
  if (state.expandedGeoId === target.geoId) {
    return { expandedGeoId: null, selectedCityId: null, selectedTransferGroupId: null };
  }
  return { expandedGeoId: target.geoId, selectedCityId: null, selectedTransferGroupId: null };
}

export function geoMarkerLabel(marker: MapGeoMarker, lang: 'ru' | 'kz'): string {
  const name = lang === 'kz' ? marker.nameKz : marker.nameRu;
  if (marker.sellers.length > 1) return `${name} (${marker.sellers.length})`;
  return name;
}
