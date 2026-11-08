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

type Lang = 'ru' | 'kz';

export default function AdminKazakhstanMap({
  markers,
  selection,
  onSelection,
  lang,
  t,
}: {
  markers: MapGeoMarker[];
  selection: MapSelection;
  onSelection: (next: MapSelection) => void;
  lang: Lang;
  t: (key: string) => string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [spiderOn, setSpiderOn] = useState(false);
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

  useEffect(() => {
    setSpiderOn(false);
    if (!selection.expandedGeoId) return;
    const id = requestAnimationFrame(() => setSpiderOn(true));
    return () => cancelAnimationFrame(id);
  }, [selection.expandedGeoId]);

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
      const t = e.touches[0];
      const dx = t.clientX - d.x;
      const dy = t.clientY - d.y;
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

  return (
    <div className="relative h-full min-h-[22rem] overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
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
          {markers.map((marker) => {
            const isOpen = selection.expandedGeoId === marker.geoId && marker.sellers.length > 1;
            const selectedHere = marker.sellers.some((s) => s.cityId === selection.selectedCityId);
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
