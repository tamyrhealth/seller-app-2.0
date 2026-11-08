'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  geoMarkerLabel,
  kzOutlinePath,
  MAP_VB_H,
  MAP_VB_W,
  reduceMapClick,
  spiderfyOffsetsForOrigin,
  type MapGeoMarker,
  type MapSelection,
  type MapSeller,
} from '@/lib/adminMap';
import { MAP_TRUCK_DURATION_SEC, transferRouteArc, type MapTransferGroup } from '@/lib/adminMapTransfers';

type Lang = 'ru' | 'kz';

function routePathId(groupId: string) {
  return `map-arc-${groupId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function truckPhaseSec(groupId: string) {
  let h = 0;
  for (let i = 0; i < groupId.length; i += 1) h = (h * 31 + groupId.charCodeAt(i)) >>> 0;
  return h % MAP_TRUCK_DURATION_SEC;
}

function TransferTruckIcon({ fill }: { fill: string }) {
  return (
    <g transform="translate(-8 -5)">
      <rect x="0.5" y="1.5" width="10.5" height="6.2" rx="1.2" fill={fill} stroke="#fff" strokeWidth={0.8} />
      <rect x="11" y="3" width="4.2" height="4.7" rx="0.9" fill="#0f172a" stroke="#fff" strokeWidth={0.7} />
      <circle cx="4.2" cy="8.4" r="1.5" fill="#1e293b" stroke="#fff" strokeWidth={0.5} />
      <circle cx="12.6" cy="8.4" r="1.5" fill="#1e293b" stroke="#fff" strokeWidth={0.5} />
    </g>
  );
}

export default function AdminKazakhstanMap({
  markers,
  selection,
  onSelection,
  onSelectTransfer,
  routes,
  localGroups,
  showWarehouses,
  showTransfers,
  onToggleWarehouses,
  onToggleTransfers,
  lang,
  t,
}: {
  markers: MapGeoMarker[];
  selection: MapSelection;
  onSelection: (next: MapSelection) => void;
  onSelectTransfer: (groupId: string) => void;
  routes: MapTransferGroup[];
  localGroups: MapTransferGroup[];
  showWarehouses: boolean;
  showTransfers: boolean;
  onToggleWarehouses: (next: boolean) => void;
  onToggleTransfers: (next: boolean) => void;
  lang: Lang;
  t: (key: string) => string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [spiderOn, setSpiderOn] = useState(false);
  const [hoveredRouteId, setHoveredRouteId] = useState<string | null>(null);
  const [animateTrucks, setAnimateTrucks] = useState(true);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    viewX: number;
    viewY: number;
    moved: boolean;
    pinching: boolean;
    startDist: number;
    startScale: number;
    startMid: { x: number; y: number } | null;
  } | null>(null);

  const outline = useMemo(() => kzOutlinePath(), []);
  const byId = useMemo(() => new Map(markers.map((m) => [m.geoId, m])), [markers]);
  const expanded = selection.expandedGeoId ? byId.get(selection.expandedGeoId) || null : null;
  const offsets = expanded ? spiderfyOffsetsForOrigin(expanded.sellers.length, { x: expanded.x, y: expanded.y }) : [];
  const localByGeo = useMemo(() => new Map(localGroups.map((g) => [g.from.geoId, g])), [localGroups]);

  const routeArcs = useMemo(() => {
    return routes
      .map((group) => {
        const from = group.from.geoId ? byId.get(group.from.geoId) : null;
        const to = group.to.geoId ? byId.get(group.to.geoId) : null;
        if (!from || !to) return null;
        const arc = transferRouteArc({ x: from.x, y: from.y }, { x: to.x, y: to.y });
        if (!arc) return null;
        return { group, arc };
      })
      .filter((row): row is { group: MapTransferGroup; arc: NonNullable<ReturnType<typeof transferRouteArc>> } => !!row);
  }, [routes, byId]);

  useEffect(() => {
    setSpiderOn(false);
    if (!selection.expandedGeoId) return;
    const id = requestAnimationFrame(() => setSpiderOn(true));
    return () => cancelAnimationFrame(id);
  }, [selection.expandedGeoId]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      if (mq.matches) setAnimateTrucks(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  function clampScale(s: number) {
    return Math.min(7, Math.max(0.85, s));
  }

  function zoomAt(clientX: number, clientY: number, nextScale: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const p = pt.matrixTransform(ctm.inverse());
    const current = viewRef.current;
    const k = clampScale(nextScale);
    const mx = (p.x - current.x) / current.scale;
    const my = (p.y - current.y) / current.scale;
    const next = { scale: k, x: p.x - mx * k, y: p.y - my * k };
    viewRef.current = next;
    setView(next);
  }

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.11;
      zoomAt(e.clientX, e.clientY, viewRef.current.scale * factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function touchDist(touches: React.TouchList) {
    const a = touches[0];
    const b = touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchMid(touches: React.TouchList) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === 'touch') return;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      viewX: view.x,
      viewY: view.y,
      moved: false,
      pinching: false,
      startDist: 0,
      startScale: view.scale,
      startMid: null,
    };
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d || d.pinching || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) > 4) d.moved = true;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = MAP_VB_W / rect.width;
    const sy = MAP_VB_H / rect.height;
    setView((v) => ({ ...v, x: d.viewX + dx * sx, y: d.viewY + dy * sy }));
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const moved = d.moved;
    drag.current = null;
    if (moved) return;
    if ((e.target as Element).closest('[data-map-hit]')) return;
    onSelection(reduceMapClick(selection, { type: 'background' }));
  }

  function onTouchStart(e: React.TouchEvent<SVGSVGElement>) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const mid = touchMid(e.touches);
      drag.current = {
        pointerId: -1,
        x: mid.x,
        y: mid.y,
        viewX: view.x,
        viewY: view.y,
        moved: true,
        pinching: true,
        startDist: touchDist(e.touches),
        startScale: view.scale,
        startMid: mid,
      };
    } else if (e.touches.length === 1) {
      drag.current = {
        pointerId: -1,
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        viewX: view.x,
        viewY: view.y,
        moved: false,
        pinching: false,
        startDist: 0,
        startScale: view.scale,
        startMid: null,
      };
    }
  }

  function onTouchMove(e: React.TouchEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    if (d.pinching && e.touches.length === 2) {
      e.preventDefault();
      const dist = touchDist(e.touches);
      const mid = touchMid(e.touches);
      if (d.startDist > 0) zoomAt(mid.x, mid.y, d.startScale * (dist / d.startDist));
      return;
    }
    if (e.touches.length === 1 && !d.pinching) {
      const touch = e.touches[0];
      const dx = touch.clientX - d.x;
      const dy = touch.clientY - d.y;
      if (Math.hypot(dx, dy) > 6) d.moved = true;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      setView((v) => ({
        ...v,
        x: d.viewX + dx * (MAP_VB_W / rect.width),
        y: d.viewY + dy * (MAP_VB_H / rect.height),
      }));
    }
  }

  function onTouchEnd(e: React.TouchEvent<SVGSVGElement>) {
    const d = drag.current;
    if (e.touches.length === 0) {
      const moved = d?.moved;
      drag.current = null;
      if (moved) return;
      if ((e.target as Element).closest('[data-map-hit]')) return;
      onSelection(reduceMapClick(selection, { type: 'background' }));
    }
  }

  function clickGeo(marker: MapGeoMarker, e: React.MouseEvent | React.PointerEvent) {
    e.stopPropagation();
    if (drag.current?.moved) return;
    onSelection(reduceMapClick(selection, { type: 'geo', geoId: marker.geoId }, marker));
  }

  function clickSeller(marker: MapGeoMarker, seller: MapSeller, e: React.MouseEvent) {
    e.stopPropagation();
    onSelection(reduceMapClick(selection, { type: 'seller', geoId: marker.geoId, cityId: seller.cityId }, marker));
  }

  function clickTransfer(groupId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (drag.current?.moved) return;
    onSelectTransfer(groupId);
  }

  return (
    <div className="relative h-full min-h-[22rem] overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-xl border border-slate-200 bg-white/95 p-2 text-xs shadow-sm">
        <label className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-slate-700">
          <input
            type="checkbox"
            checked={showWarehouses}
            onChange={(e) => onToggleWarehouses(e.target.checked)}
          />
          {t('map.layerWarehouses')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-slate-700">
          <input type="checkbox" checked={showTransfers} onChange={(e) => onToggleTransfers(e.target.checked)} />
          {t('map.layerTransfers')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-slate-700">
          <input
            type="checkbox"
            checked={animateTrucks}
            disabled={!showTransfers}
            onChange={(e) => setAnimateTrucks(e.target.checked)}
          />
          {t('map.layerAnimation')}
        </label>
        <p className="max-w-[11rem] px-1 pt-0.5 leading-snug text-slate-500">{t('map.animationHint')}</p>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${MAP_VB_W} ${MAP_VB_H}`}
        className="h-full w-full touch-none select-none"
        role="img"
        aria-label={t('map.title')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <rect width={MAP_VB_W} height={MAP_VB_H} fill="#f8fafc" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          <path d={outline} fill="#dbeafe" stroke="#93c5fd" strokeWidth={1.4} strokeLinejoin="round" />
          {showTransfers
            ? routeArcs.map(({ group, arc }) => {
                const selected = selection.selectedTransferGroupId === group.id;
                const hovered = hoveredRouteId === group.id;
                const stroke = selected ? '#1d4ed8' : hovered ? '#0f766e' : '#0369a1';
                const pathId = routePathId(group.id);
                const phase = truckPhaseSec(group.id);
                return (
                  <g
                    key={group.id}
                    data-map-hit="route"
                    className="cursor-pointer"
                    onClick={(e) => clickTransfer(group.id, e)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseEnter={() => setHoveredRouteId(group.id)}
                    onMouseLeave={() => setHoveredRouteId((id) => (id === group.id ? null : id))}
                  >
                    <path d={arc.d} fill="none" stroke="transparent" strokeWidth={18} strokeLinecap="round" />
                    <path
                      id={pathId}
                      d={arc.d}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={selected ? 3.2 : 2.2}
                      strokeLinecap="round"
                    />
                    <g transform={`translate(${arc.ax} ${arc.ay}) rotate(${arc.angleDeg})`}>
                      <polygon points="0,0 -11,-4.5 -11,4.5" fill={stroke} />
                    </g>
                    {group.documentCount > 1 ? (
                      <g transform={`translate(${arc.bx} ${arc.by})`} className="pointer-events-none">
                        <circle r={9} fill="#fff" stroke={stroke} strokeWidth={1.6} />
                        <text y={3.2} textAnchor="middle" fill="#0f172a" fontSize={9} fontWeight={700}>
                          {group.documentCount}
                        </text>
                      </g>
                    ) : null}
                    {animateTrucks ? (
                      <g data-map-hit="truck">
                        <animateMotion
                          dur={`${MAP_TRUCK_DURATION_SEC}s`}
                          repeatCount="indefinite"
                          rotate="auto"
                          begin={`-${phase}s`}
                        >
                          <mpath href={`#${pathId}`} />
                        </animateMotion>
                        <animate
                          attributeName="opacity"
                          values="0;1;1;0"
                          keyTimes="0;0.07;0.93;1"
                          dur={`${MAP_TRUCK_DURATION_SEC}s`}
                          repeatCount="indefinite"
                          begin={`-${phase}s`}
                        />
                        <circle r={11} fill="transparent" />
                        <TransferTruckIcon fill={stroke} />
                      </g>
                    ) : (
                      <g
                        data-map-hit="truck"
                        transform={`translate(${arc.mx} ${arc.my}) rotate(${arc.midAngleDeg})`}
                      >
                        <circle r={11} fill="transparent" />
                        <TransferTruckIcon fill={stroke} />
                      </g>
                    )}
                  </g>
                );
              })
            : null}
          {markers.map((marker) => {
            const isOpen = showWarehouses && selection.expandedGeoId === marker.geoId && marker.sellers.length > 1;
            const selectedHere = marker.sellers.some((s) => s.cityId === selection.selectedCityId);
            const local = showTransfers ? localByGeo.get(marker.geoId) : undefined;
            const localSelected = local && selection.selectedTransferGroupId === local.id;
            return (
              <g key={marker.geoId}>
                {isOpen
                  ? marker.sellers.map((seller, i) => {
                      const off = offsets[i] || { dx: 0, dy: 0 };
                      const dx = spiderOn ? off.dx : 0;
                      const dy = spiderOn ? off.dy : 0;
                      const selected = seller.cityId === selection.selectedCityId;
                      const len = Math.hypot(off.dx, off.dy) || 1;
                      const labelX = (off.dx / len) * 15;
                      const labelY = (off.dy / len) * 15 + (off.dy >= 0 ? 11 : -6);
                      return (
                        <g
                          key={seller.cityId}
                          transform={`translate(${marker.x + dx} ${marker.y + dy})`}
                          className="cursor-pointer"
                          style={{ transition: 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                          data-map-hit="seller"
                          onClick={(e) => clickSeller(marker, seller, e)}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <line
                            x1={-dx}
                            y1={-dy}
                            x2={0}
                            y2={0}
                            stroke="#64748b"
                            strokeWidth={1.2}
                            opacity={spiderOn ? 0.7 : 0}
                          />
                          <circle r={22} fill="transparent" />
                          <circle
                            r={10}
                            fill={selected ? '#1d4ed8' : '#0f766e'}
                            stroke="#fff"
                            strokeWidth={2.2}
                          />
                          <text
                            x={labelX}
                            y={labelY}
                            textAnchor="middle"
                            className="pointer-events-none"
                            fill="#0f172a"
                            fontSize={10}
                            fontWeight={700}
                          >
                            {seller.name.length > 20 ? `${seller.name.slice(0, 18)}…` : seller.name}
                          </text>
                        </g>
                      );
                    })
                  : null}
                {showWarehouses ? (
                  <g
                    transform={`translate(${marker.x} ${marker.y})`}
                    className="cursor-pointer"
                    data-map-hit="geo"
                    onClick={(e) => clickGeo(marker, e)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <circle r={22} fill="transparent" />
                    <circle
                      r={isOpen ? 7 : 11}
                      fill={selectedHere ? '#1d4ed8' : '#2563eb'}
                      stroke="#fff"
                      strokeWidth={2.4}
                      opacity={isOpen ? 0.55 : 1}
                    />
                    {marker.sellers.length > 1 && !isOpen ? (
                      <circle cx={10} cy={-10} r={8} fill="#0f172a" stroke="#fff" strokeWidth={1.5} />
                    ) : null}
                    {marker.sellers.length > 1 && !isOpen ? (
                      <text
                        x={10}
                        y={-7}
                        textAnchor="middle"
                        fill="#fff"
                        fontSize={8}
                        fontWeight={700}
                        className="pointer-events-none"
                      >
                        {marker.sellers.length}
                      </text>
                    ) : null}
                    {!isOpen ? (
                      <text
                        y={-16}
                        textAnchor="middle"
                        fill="#0f172a"
                        fontSize={11}
                        fontWeight={700}
                        className="pointer-events-none"
                      >
                        {geoMarkerLabel(marker, lang)}
                      </text>
                    ) : null}
                  </g>
                ) : null}
                {local ? (
                  <g
                    transform={`translate(${marker.x} ${marker.y})`}
                    className="cursor-pointer"
                    data-map-hit="local-transfer"
                    onClick={(e) => clickTransfer(local.id, e)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <circle
                      cx={-11}
                      cy={11}
                      r={8}
                      fill={localSelected ? '#c2410c' : '#ea580c'}
                      stroke="#fff"
                      strokeWidth={1.5}
                    />
                    <text
                      x={-11}
                      y={14}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={8}
                      fontWeight={700}
                      className="pointer-events-none"
                    >
                      {local.documentCount}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <button
          type="button"
          className="px-3 py-2 text-lg text-slate-700 hover:bg-slate-50"
          onClick={() => setView((v) => ({ ...v, scale: clampScale(v.scale * 1.2) }))}
          aria-label={t('map.zoomIn')}
        >
          +
        </button>
        <button
          type="button"
          className="border-t border-slate-200 px-3 py-2 text-lg text-slate-700 hover:bg-slate-50"
          onClick={() => setView((v) => ({ ...v, scale: clampScale(v.scale / 1.2) }))}
          aria-label={t('map.zoomOut')}
        >
          −
        </button>
      </div>
    </div>
  );
}
