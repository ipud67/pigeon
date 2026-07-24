'use client';

// useZoomPan — a reusable, dependency-free SVG pan/zoom controller for the local atlas maps.
// Client-side only; produces an SVG `transform` string for a <g> that wraps the map content, plus
// pointer/wheel/keyboard handlers and +/-/reset actions. Static-export safe (no map library, no
// CDN). Zoom is anchored on the cursor / pinch-midpoint; panning is clamped so the map cannot be
// dragged fully out of frame. At z=1 the transform is identity, so the server-rendered overview is
// pixel-identical with JS disabled — the interaction is progressive enhancement only.
//
// Coordinate spaces: the SVG's viewBox is 0..W x 0..H (userspace). getScreenCTM() maps that
// userspace to screen pixels (it does NOT include our <g> transform, since the ref is the <svg>),
// so we convert client points into viewBox coords once and do all math there. A content point c
// maps to viewBox point p via p = t + z*c; to keep a focal viewBox point fixed while scaling we
// solve t2 = f - z2*(f - t)/z.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
 RefObject,
 PointerEvent as ReactPointerEvent,
 KeyboardEvent as ReactKeyboardEvent,
} from 'react';

export type ZoomPanState = { z: number; tx: number; ty: number };

type Opts = { W: number; H: number; minZ?: number; maxZ?: number; wheelStep?: number };

export type ZoomPan = {
 ref: RefObject<SVGSVGElement | null>;
 vp: ZoomPanState;
 transform: string;
 zoomIn: () => void;
 zoomOut: () => void;
 reset: () => void;
 canZoomOut: boolean;
 onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
 onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
 onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void;
 onKeyDown: (e: ReactKeyboardEvent) => void;
};

export function useZoomPan({ W, H, minZ = 1, maxZ = 8, wheelStep = 1.18 }: Opts): ZoomPan {
 const ref = useRef<SVGSVGElement | null>(null);
 const [vp, setVp] = useState<ZoomPanState>({ z: 1, tx: 0, ty: 0 });

 // Active pointers (for pinch) + drag/pinch bookkeeping in refs (no re-render).
 const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
 const lastPan = useRef<{ x: number; y: number } | null>(null);
 const lastPinchDist = useRef<number | null>(null);

 const toUser = useCallback((clientX: number, clientY: number): [number, number] => {
 const svg = ref.current;
 const ctm = svg?.getScreenCTM();
 if (!ctm) return [W / 2, H / 2];
 const inv = ctm.inverse();
 return [inv.a * clientX + inv.c * clientY + inv.e, inv.b * clientX + inv.d * clientY + inv.f];
 }, [W, H]);

 const clampZ = useCallback((z: number) => Math.min(maxZ, Math.max(minZ, z)), [maxZ, minZ]);

 // Keep the map covering the viewport: on-screen the content spans [t, t + z*W]; require t<=0 and
 // t + z*W >= W. At z=1 this pins t to 0 (no pan at overview — overview framing never changes).
 const clampPan = useCallback((s: ZoomPanState): ZoomPanState => {
 const minTx = W * (1 - s.z);
 const minTy = H * (1 - s.z);
 return {
 z: s.z,
 tx: Math.min(0, Math.max(minTx, s.tx)),
 ty: Math.min(0, Math.max(minTy, s.ty)),
 };
 }, [W, H]);

 // Scale by `factor` about viewBox focal point (fx,fy).
 const zoomBy = useCallback((factor: number, fx: number, fy: number) => {
 setVp((s) => {
 const z2 = clampZ(s.z * factor);
 if (z2 === s.z) return s;
 const tx = fx - (z2 * (fx - s.tx)) / s.z;
 const ty = fy - (z2 * (fy - s.ty)) / s.z;
 return clampPan({ z: z2, tx, ty });
 });
 }, [clampZ, clampPan]);

 const panBy = useCallback((dx: number, dy: number) => {
 setVp((s) => clampPan({ z: s.z, tx: s.tx + dx, ty: s.ty + dy }));
 }, [clampPan]);

 const zoomIn = useCallback(() => zoomBy(1.4, W / 2, H / 2), [zoomBy, W, H]);
 const zoomOut = useCallback(() => zoomBy(1 / 1.4, W / 2, H / 2), [zoomBy, W, H]);
 const reset = useCallback(() => setVp({ z: 1, tx: 0, ty: 0 }), []);

 // Wheel must be a non-passive native listener so we can preventDefault the page scroll.
 useEffect(() => {
 const el = ref.current;
 if (!el) return;
 const onWheel = (e: WheelEvent) => {
 e.preventDefault();
 const [fx, fy] = toUser(e.clientX, e.clientY);
 zoomBy(e.deltaY < 0 ? wheelStep : 1 / wheelStep, fx, fy);
 };
 el.addEventListener('wheel', onWheel, { passive: false });
 return () => el.removeEventListener('wheel', onWheel);
 }, [toUser, zoomBy, wheelStep]);

 const onPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
 (e.target as Element).setPointerCapture?.(e.pointerId);
 pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
 if (pointers.current.size === 1) {
 lastPan.current = { x: e.clientX, y: e.clientY };
 } else if (pointers.current.size === 2) {
 const [a, b] = [...pointers.current.values()];
 lastPinchDist.current = Math.hypot(a.x - b.x, a.y - b.y);
 lastPan.current = null;
 }
 }, []);

 const onPointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
 if (!pointers.current.has(e.pointerId)) return;
 pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
 const n = pointers.current.size;
 if (n >= 2) {
 const [a, b] = [...pointers.current.values()];
 const dist = Math.hypot(a.x - b.x, a.y - b.y);
 if (lastPinchDist.current && dist > 0) {
 const [fx, fy] = toUser((a.x + b.x) / 2, (a.y + b.y) / 2);
 zoomBy(dist / lastPinchDist.current, fx, fy);
 }
 lastPinchDist.current = dist;
 } else if (n === 1 && lastPan.current) {
 // Screen delta -> viewBox delta via the current CTM scale (dividing by device pixel scale).
 const [ux, uy] = toUser(e.clientX, e.clientY);
 const [lx, ly] = toUser(lastPan.current.x, lastPan.current.y);
 panBy(ux - lx, uy - ly);
 lastPan.current = { x: e.clientX, y: e.clientY };
 }
 }, [toUser, zoomBy, panBy]);

 const onPointerUp = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
 pointers.current.delete(e.pointerId);
 if (pointers.current.size < 2) lastPinchDist.current = null;
 if (pointers.current.size === 1) {
 const [p] = [...pointers.current.values()];
 lastPan.current = { x: p.x, y: p.y };
 } else if (pointers.current.size === 0) {
 lastPan.current = null;
 }
 }, []);

 const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
 const step = 40;
 switch (e.key) {
 case '+':
 case '=': e.preventDefault(); zoomIn(); break;
 case '-':
 case '_': e.preventDefault(); zoomOut(); break;
 case '0': e.preventDefault(); reset(); break;
 case 'ArrowUp': e.preventDefault(); panBy(0, step); break;
 case 'ArrowDown': e.preventDefault(); panBy(0, -step); break;
 case 'ArrowLeft': e.preventDefault(); panBy(step, 0); break;
 case 'ArrowRight': e.preventDefault(); panBy(-step, 0); break;
 default: break;
 }
 }, [zoomIn, zoomOut, reset, panBy]);

 const transform = `translate(${vp.tx.toFixed(2)} ${vp.ty.toFixed(2)}) scale(${vp.z.toFixed(4)})`;

 return {
 ref,
 vp,
 transform,
 zoomIn,
 zoomOut,
 reset,
 canZoomOut: vp.z > minZ + 1e-3,
 onPointerDown,
 onPointerMove,
 onPointerUp,
 onKeyDown,
 };
}
