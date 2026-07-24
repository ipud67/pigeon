'use client';

// app/local/[slug]/LocalMap.tsx — the LOCAL atlas map. A client component over data BAKED at
// build time (scripts/build-local.mjs) from real free/PD sources. Two scales :
//
// COUNTY (e.g. San Diego) — atlas relief: a baked hillshade x hypsometric COMPOSITE raster
// (Census TIGERweb boundary + OpenTopoData ASTER DEM -> Horn's-method hillshade x the approved
// hypsometric ramp, one PNG per theme, embedded as a data URI — no runtime SVG filter, no CDN),
// clipped to the real boundary, with engraved contour lines, Natural-Earth rivers, real Census
// towns, named natural-feature labels (italic serif), an elevation legend, north arrow + scale.
//
// CITY (e.g. Virginia Beach) — street level: real TIGER/Line arteries (incl. I-264) + area water
// (Chesapeake Bay, Lynnhaven, Back Bay, the Atlantic edge) + curated district labels. The
// current-view (ink-red) mark sits on Town Center.
//
// INTERACTIVE ZOOM + PAN (iteration 6): the whole map is wrapped in a client-side SVG transform
// (useZoomPan — reusable, no map library, static-export safe). Mouse-wheel / pinch to zoom, drag to
// pan, +/-/Reset controls (keyboard-operable). The default framing is the clean overview (z=1,
// identity transform), so the SERVER-rendered overview is unchanged and readable with JS disabled.
// PROGRESSIVE DETAIL (LOD, R44/R48 "detail tightens as you zoom"): on the first zoom-in past the
// threshold the city map lazy-loads the fine local-street mesh (TIGER/Line S1400) from a separate
// static asset and reveals it — the overview DOM stays light (mesh is not mounted until zoomed).
//
// Calm in light + dark (all colours are theme CSS vars). No coordinates / FIPS / reference numbers
// are ever rendered . The elevation legend shows measured elevation (a legend, like the scale
// bar — not a coordinate).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LocalBoundary, LocalMapData } from '../../../lib/local';
import { useZoomPan } from './useZoomPan';

type Props = {
 boundary: LocalBoundary;
 centroid: [number, number];
 label: string; // primary city / area label (the current-view mark)
 kindLabel: string; // "County" | "Independent city"
 map: LocalMapData;
};

const W = 720;
const H = 520;
const PAD = 46;
const MINOR_ZOOM = 2.2; // zoom level at/above which the fine local-street mesh is revealed

type Projector = {
 project: (lon: number, lat: number) => [number, number];
 toPath: (pts: [number, number][], close?: boolean) => string;
 scale: number;
 k: number;
 offX: number;
 offY: number;
 pxMin: number;
 pyMin: number;
};

// Build the linear lon/lat -> viewBox projection for a boundary (equirectangular, latitude-
// compressed). Pure so it can be memoized and shared by the render + the LOD path builder.
function makeProjector(boundary: NonNullable<LocalBoundary>): Projector {
 const [minLon, minLat, maxLon, maxLat] = boundary.bbox;
 const meanLat = (minLat + maxLat) / 2;
 const k = Math.cos((meanLat * Math.PI) / 180);
 const pxMin = minLon * k;
 const pyMin = -maxLat;
 const spanX = maxLon * k - pxMin || 1;
 const spanY = -minLat - pyMin || 1;
 const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
 const offX = (W - spanX * scale) / 2;
 const offY = (H - spanY * scale) / 2;
 const project = (lon: number, lat: number): [number, number] => [
 offX + (lon * k - pxMin) * scale,
 offY + (-lat - pyMin) * scale,
 ];
 const toPath = (pts: [number, number][], close = false) =>
 pts
 .map(([lon, lat], i) => {
 const [x, y] = project(lon, lat);
 return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
 })
 .join(' ') + (close ? ' Z' : '');
 return { project, toPath, scale, k, offX, offY, pxMin, pyMin };
}

export function LocalMap({ boundary, centroid, label, kindLabel, map }: Props) {
 // Hooks first, unconditionally (before any early return) — React rules of hooks.
 const zp = useZoomPan({ W, H, maxZ: 8 });
 const [minor, setMinor] = useState<[number, number][][] | null>(null);
 const [loadingMinor, setLoadingMinor] = useState(false);
 const fetchStarted = useRef(false);
 const fine = map?.fine_streets ?? null;

 const proj = useMemo<Projector | null>(
 () => (boundary && boundary.rings.length ? makeProjector(boundary) : null),
 [boundary],
 );

 // Lazy-load the fine local-street mesh on the FIRST zoom past the LOD threshold. Fetched relative
 // to the current page URL, so it is basePath-agnostic (works under /pigeon and at root). Fails
 // soft to an empty mesh (never a retry loop). Once loaded it is cached in state for the session.
 useEffect(() => {
 // Fire exactly once, on the first zoom past the LOD threshold. A ref (not state) guards the
 // single fetch so the effect re-running on `loadingMinor`/zoom changes can't cancel its own
 // in-flight request. The map does not unmount during interaction, so no teardown is needed.
 if (!fine || fetchStarted.current) return;
 if (zp.vp.z < MINOR_ZOOM) return;
 fetchStarted.current = true;
 setLoadingMinor(true);
 const path = window.location.pathname;
 const base = path.endsWith('/') ? path : path + '/';
 fetch(base + fine.file)
 .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
 .then((d) => setMinor(Array.isArray(d) ? d : []))
 .catch(() => setMinor([]))
 .finally(() => setLoadingMinor(false));
 }, [fine, zp.vp.z]);

 // Fine-mesh batches — the S1400 segments, projected once and grouped into coarse spatial cells,
 // each pre-joined into ONE <path> d-string with its content-space bbox. Memoized so pan/zoom
 // re-renders never re-project thousands of segments; at render time only the cells intersecting
 // the visible viewport are mounted (viewport culling), so even ~9k segments stay smooth on mobile
 // and the overview DOM carries zero of them.
 const minorBatches = useMemo(() => {
 if (!proj || !minor || minor.length === 0) return [];
 const CELL = 120; // content-space px per batch cell (~30 cells over the 720x520 board)
 const cells = new Map<string, { d: string; x0: number; y0: number; x1: number; y1: number }>();
 for (const seg of minor) {
 let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
 let d = '';
 for (let i = 0; i < seg.length; i++) {
 const [x, y] = proj.project(seg[i][0], seg[i][1]);
 d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
 if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
 }
 const key = `${Math.floor((x0 + x1) / 2 / CELL)},${Math.floor((y0 + y1) / 2 / CELL)}`;
 let b = cells.get(key);
 if (!b) { b = { d: '', x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }; cells.set(key, b); }
 b.d += d;
 if (x0 < b.x0) b.x0 = x0; if (y0 < b.y0) b.y0 = y0; if (x1 > b.x1) b.x1 = x1; if (y1 > b.y1) b.y1 = y1;
 }
 return [...cells.values()];
 }, [proj, minor]);

 // No geometry -> a plain, honest locator with just the marker (never a fake shape). Zoom controls
 // are omitted here — there is nothing to zoom.
 if (!proj) {
 return (
 <div className="local-map" role="img" aria-label={`Locator map for ${label}`}>
 <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%">
 <circle cx={W / 2} cy={H / 2} r={5} className="lm-marker" />
 <text x={W / 2} y={H / 2 + 22} textAnchor="middle" className="lm-label">
 {label}
 </text>
 </svg>
 <div className="lm-caption">Boundary geometry not available — marker only.</div>
 </div>
 );
 }

 const { project, toPath } = proj;
 const { scale, k } = proj;
 const ringPaths = boundary!.rings.map((r) => toPath(r, true));

 // --- Non-scaling label overlay (Fix 1) --------------------------------------------------------
 // All TEXT labels + point-marks render in a SEPARATE, NON-transformed <g class="lm-labels">, not
 // inside the zoomed viewport group. `S` projects a geographic point to content space, then applies
 // the SAME pan/zoom transform by hand — so a label tracks its map location while its type stays a
 // constant on-screen size at every zoom (geometry scales; annotations do not). This is the general,
 // reusable fix for the map component, not a VB one-off. `onFrame` culls labels dragged out of view.
 const S = (lon: number, lat: number): [number, number] => {
 const [cx, cy] = project(lon, lat);
 return [zp.vp.tx + zp.vp.z * cx, zp.vp.ty + zp.vp.z * cy];
 };
 const onFrame = (x: number, y: number, m = 30) => x >= -m && x <= W + m && y >= -m && y <= H + m;

 // A place mark (a small dot + label, or the ink-red current-view mark if `primary`) in overlay
 // space. Shared by county towns and city districts. Fixed pixel radii/offsets → constant size.
 const placeMark = (
 name: string,
 lon: number,
 lat: number,
 primary: boolean | undefined,
 key: string,
 groupTestid: string,
 ): ReactNode => {
 const [dx, dy] = S(lon, lat);
 if (!onFrame(dx, dy)) return null;
 if (primary) {
 return (
 <g key={key} data-testid="lm-current-view">
 <circle cx={dx} cy={dy} r={16} className="lm-sel-halo" />
 <circle cx={dx} cy={dy} r={9} className="lm-sel-ring" />
 <circle cx={dx} cy={dy} r={4.5} className="lm-marker lm-sel-dot" />
 <text x={dx} y={dy - 20} textAnchor="middle" className="lm-sel-sub">CURRENT VIEW</text>
 <text x={dx} y={dy - 30} textAnchor="middle" className="lm-sel-label" data-testid="lm-town-label">
 {name.toUpperCase()}
 </text>
 </g>
 );
 }
 const anchor = townLabelAnchor(dx);
 const lx = anchor === 'end' ? dx - 7 : anchor === 'start' ? dx + 7 : dx;
 const ly = anchor === 'middle' ? dy - 8 : dy + 3.5;
 return (
 <g key={key} className="lm-town" data-testid={groupTestid}>
 <circle cx={dx} cy={dy} r={3.2} className="lm-town-dot" />
 <text x={lx} y={ly} textAnchor={anchor} className="lm-town-label" data-testid="lm-town-label">
 {name}
 </text>
 </g>
 );
 };

 // Ocean direction in screen space (y-down): east=+x, north=-y.
 const bear = map?.ocean_bearing;
 const hasOcean = bear != null;
 const ov: [number, number] = hasOcean
 ? [Math.sin((bear! * Math.PI) / 180), -Math.cos((bear! * Math.PI) / 180)]
 : [0, 0];

 // Scale bar: a real ground distance, sized to a nice pixel length. Inside the zoom viewport, so it
 // scales with the map and stays geometrically honest at any zoom.
 const pxPerKm = scale / 111.32;
 const miles = [2, 5, 10, 20, 25, 50, 100];
 let scMi = 20;
 for (const m of miles) {
 const px = m * 1.60934 * pxPerKm;
 if (px >= 58 && px <= 175) { scMi = m; break; }
 scMi = m;
 }
 const scPx = scMi * 1.60934 * pxPerKm;
 const scY = H - PAD + 16;
 const scX0 = PAD;

 const naX = W - PAD - 4;
 const naY = PAD + 4;

 const townLabelAnchor = (x: number): 'start' | 'end' | 'middle' =>
 x > W * 0.82 ? 'end' : x < W * 0.18 ? 'start' : 'middle';

 const isCity = map?.scale === 'city';

 // Zoom + pan control (HTML overlay over the SVG). Buttons are real <button>s → keyboard-operable;
 // the group also handles +/-/0/arrow keys when focused. Reusable across both map scales.
 const zoomControls = (
 <div
 className="lm-zoom"
 data-testid="lm-zoom"
 role="group"
 aria-label="Zoom and pan the map"
 onKeyDown={zp.onKeyDown}
 >
 <button type="button" className="lm-zoom-btn" onClick={zp.zoomIn} aria-label="Zoom in" title="Zoom in">+</button>
 <button type="button" className="lm-zoom-btn" onClick={zp.zoomOut} disabled={!zp.canZoomOut} aria-label="Zoom out" title="Zoom out">&#8722;</button>
 <button type="button" className="lm-zoom-btn lm-zoom-reset" onClick={zp.reset} disabled={!zp.canZoomOut} aria-label="Reset zoom">Reset</button>
 </div>
 );

 const svgInteraction = {
 ref: zp.ref,
 onPointerDown: zp.onPointerDown,
 onPointerMove: zp.onPointerMove,
 onPointerUp: zp.onPointerUp,
 onPointerLeave: zp.onPointerUp,
 onPointerCancel: zp.onPointerUp,
 };

 // Shared furniture (inside the viewport group so it scales/pans coherently with the map).
 const waterLabel = hasOcean && map?.water_label && (
 <text
 className="lm-water-label"
 x={ov[0] < -0.5 ? PAD - 8 : ov[0] > 0.5 ? W - PAD + 8 : W / 2}
 y={H / 2}
 textAnchor="middle"
 transform={`rotate(${ov[0] < -0.5 ? -90 : ov[0] > 0.5 ? 90 : 0} ${
 ov[0] < -0.5 ? PAD - 8 : ov[0] > 0.5 ? W - PAD + 8 : W / 2
 } ${H / 2})`}
 >
 {map.water_label}
 </text>
 );

 const scaleBar = (
 <g className="lm-scale">
 <path className="lm-scale-line" d={`M ${scX0} ${scY} L ${scX0 + scPx} ${scY}`} />
 <path className="lm-scale-line" d={`M ${scX0} ${scY - 4} L ${scX0} ${scY + 4}`} />
 <path className="lm-scale-line" d={`M ${scX0 + scPx} ${scY - 4} L ${scX0 + scPx} ${scY + 4}`} />
 <text className="lm-scale-lab" x={scX0} y={scY - 7} textAnchor="start">0</text>
 <text className="lm-scale-lab" x={scX0 + scPx} y={scY - 7} textAnchor="end">{scMi} mi</text>
 </g>
 );

 const northArrow = (
 <g className="lm-north">
 <path className="lm-north-arrow" d={`M ${naX} ${naY + 22} L ${naX} ${naY + 4}`} />
 <path className="lm-north-arrow" d={`M ${naX - 4} ${naY + 9} L ${naX} ${naY + 2} L ${naX + 4} ${naY + 9}`} />
 <text className="lm-north-lab" x={naX} y={naY + 34} textAnchor="middle">N</text>
 </g>
 );

 // Named natural-feature labels (italic serif — atlas convention). Rendered in the non-scaling
 // overlay (Fix 1): position tracks the map point, size stays constant.
 const features = (map?.features ?? []).map((f, i) => {
 const [fx, fy] = S(f.lon, f.lat);
 if (!onFrame(fx, fy)) return null;
 return (
 <text
 key={`feat${i}`}
 x={fx}
 y={fy}
 textAnchor="middle"
 className={`lm-feat lm-feat-${f.kind}`}
 data-testid="lm-feature"
 >
 {f.name}
 </text>
 );
 });

 // Progressive place-labels (labels-LOD) — finer real place names revealed as the reader zooms
 // in, atlas convention. SHARED across both scales (a county map benefits from the same "detail
 // tightens as you zoom" behaviour as a city map — previously this only rendered on city scale,
 // an inconsistency fixed in the 2026-07-15 local-map polish pass). Curated real-place point-
 // labels (flagged per-area in data_notes); coordinates position them and are never rendered .
 const progressiveLabels = (map?.labels ?? []).map((l, i) => {
 if (zp.vp.z < l.minZoom) return null;
 const [lx, ly] = S(l.lon, l.lat);
 if (!onFrame(lx, ly)) return null;
 return (
 <text
 key={`lod${i}`}
 x={lx}
 y={ly}
 textAnchor="middle"
 className={`lm-lod lm-lod-${l.style}`}
 data-testid="lm-lod-label"
 >
 {l.name}
 </text>
 );
 });

 // ---------------------------------------------------------------- CITY SCALE
 if (isCity) {
 const roads = map?.roads ?? [];
 const water = map?.water_areas ?? [];
 const districts = map?.districts ?? [];
 const ringsToPath = (rings: [number, number][][]) => rings.map((r) => toPath(r, true)).join(' ');
 const showMinor = zp.vp.z >= MINOR_ZOOM && minorBatches.length > 0;
 // Visible content-space rectangle (with margin), for viewport-culling the fine-mesh batches.
 const M = 60;
 const vx0 = -zp.vp.tx / zp.vp.z - M;
 const vx1 = (W - zp.vp.tx) / zp.vp.z + M;
 const vy0 = -zp.vp.ty / zp.vp.z - M;
 const vy1 = (H - zp.vp.ty) / zp.vp.z + M;
 const visibleMinor = showMinor
 ? minorBatches.filter((b) => b.x1 >= vx0 && b.x0 <= vx1 && b.y1 >= vy0 && b.y0 <= vy1)
 : [];

 return (
 <div className="local-map lm-city" role="img" aria-label={`Street map of ${label}, ${kindLabel}`}>
 {zoomControls}
 <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" className="lm-svg" {...svgInteraction}>
 <defs>
 <clipPath id="lm-clip">
 {ringPaths.map((d, i) => (
 <path key={i} d={d} />
 ))}
 </clipPath>
 </defs>

 <g className="lm-viewport" transform={zp.transform}>
 {/* land base */}
 {ringPaths.map((d, i) => (
 <path key={`fill${i}`} d={d} className="lm-fill" />
 ))}

 {/* water bodies (real TIGER/Line area water) */}
 {water.map((wa, i) => (
 <path key={`wa${i}`} d={ringsToPath(wa.rings)} className="lm-water-area" fillRule="evenodd" data-testid="lm-water" />
 ))}

 {/* streets, clipped to the city */}
 <g clipPath="url(#lm-clip)">
 {/* fine local-street mesh (S1400) — revealed only when zoomed in (LOD). Rendered as
 a few batched, viewport-culled <path>s (each many subpaths) so only the visible
 streets mount. */}
 {visibleMinor.map((b, i) => (
 <path key={`mb${i}`} d={b.d} className="lm-road lm-road-minor" data-testid="lm-road-minor" />
 ))}
 {/* arterials under interstates */}
 {roads
 .filter((r) => r.cls === 'arterial')
 .map((r, i) => (
 <path key={`ra${i}`} d={toPath(r.points)} className="lm-road lm-road-arterial" data-testid="lm-road" />
 ))}
 {roads
 .filter((r) => r.cls === 'interstate')
 .map((r, i) => (
 <path key={`ric${i}`} d={toPath(r.points)} className="lm-road-casing" />
 ))}
 {roads
 .filter((r) => r.cls === 'interstate')
 .map((r, i) => (
 <path key={`ri${i}`} d={toPath(r.points)} className="lm-road lm-road-interstate" data-testid="lm-road" />
 ))}
 </g>

 {/* city outline */}
 {ringPaths.map((d, i) => (
 <path key={`line${i}`} d={d} className="lm-shape" />
 ))}

 {/* scale bar stays IN the viewport — it must scale to stay geometrically honest */}
 {scaleBar}
 </g>

 {/* Non-scaling label overlay (Fix 1): water label, natural features, district marks +
 the ink-red current-view mark, the progressive place-labels (Fix 2), and the north
 arrow. NOT inside the zoomed group → text holds a constant on-screen size at any zoom. */}
 <g className="lm-labels">
 {waterLabel}
 {features}
 {districts.map((d, i) => placeMark(d.name, d.lon, d.lat, d.primary, `d${i}`, 'lm-district'))}
 {progressiveLabels}
 {northArrow}
 </g>
 </svg>

 {loadingMinor && <div className="lm-caption">Loading finer streets…</div>}

 <div className="lm-legend" data-testid="lm-legend">
 <span><i className="lg-sel" /> Current view</span>
 <span><i className="lg-town" /> District</span>
 <span><i className="lg-interstate" /> Freeway</span>
 <span><i className="lg-arterial" /> Arterial</span>
 {fine && <span><i className="lg-minor" /> Local streets (zoom in)</span>}
 {water.length > 0 && <span><i className="lg-water" /> {map?.water_label ? cap(map.water_label) : 'Water'}</span>}
 </div>
 </div>
 );
 }

 // -------------------------------------------------------------- COUNTY SCALE (atlas relief)
 const massifs = map?.massifs ?? [];
 const towns = map?.towns ?? [];
 const rivers = map?.rivers ?? [];
 const relief = map?.relief;
 const isDesert = map?.tint === 'coast_desert';

 // baked relief image placement: the raster covers relief.bbox; project its NW + SE corners.
 let reliefImg: ReactNode = null;
 if (relief) {
 const [rminLon, rminLat, rmaxLon, rmaxLat] = relief.bbox;
 const [ix0, iy0] = project(rminLon, rmaxLat); // NW
 const [ix1, iy1] = project(rmaxLon, rminLat); // SE
 reliefImg = (
 <>
 <image
 href={relief.light}
 x={ix0}
 y={iy0}
 width={ix1 - ix0}
 height={iy1 - iy0}
 preserveAspectRatio="none"
 className="lm-relief-img lm-relief-light"
 data-testid="lm-relief"
 />
 <image
 href={relief.dark}
 x={ix0}
 y={iy0}
 width={ix1 - ix0}
 height={iy1 - iy0}
 preserveAspectRatio="none"
 className="lm-relief-img lm-relief-dark"
 />
 </>
 );
 }

 // Offshore ripple lines (only when we have no relief image doing the heavy lifting — keep the
 // sheet from looking bare). Uses the ocean-facing coast arc.
 const largest = boundary!.rings.slice().sort((a, b) => b.length - a.length)[0] ?? [];
 const largestScreen = largest.map(([lon, lat]) => project(lon, lat));
 const [cx, cy] = project(centroid[0], centroid[1]);
 let shapeR = 1;
 for (const [x, y] of largestScreen) shapeR = Math.max(shapeR, Math.hypot(x - cx, y - cy));
 const coastArc: [number, number][] = [];
 if (hasOcean) {
 for (const [x, y] of largestScreen) {
 const d = (x - cx) * ov[0] + (y - cy) * ov[1];
 if (d > 0.12 * shapeR) coastArc.push([x, y]);
 }
 }
 const seaLines =
 coastArc.length > 3
 ? [1, 2, 3].map((n) =>
 coastArc.map(([x, y]) => `${(x + ov[0] * 6 * n).toFixed(1)},${(y + ov[1] * 6 * n).toFixed(1)}`).join(' L '),
 )
 : [];

 // Elevation-band wash fallback (only if the baked relief raster is unavailable).
 const g1: [number, number] = hasOcean ? [0.5 + 0.5 * ov[0], 0.5 + 0.5 * ov[1]] : [0, 0.5];
 const g2: [number, number] = hasOcean ? [0.5 - 0.5 * ov[0], 0.5 - 0.5 * ov[1]] : [1, 0.5];

 return (
 <div className="local-map lm-atlas" role="img" aria-label={`Relief atlas map of ${label}, ${kindLabel}`}>
 {zoomControls}
 <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" className="lm-svg" {...svgInteraction}>
 <defs>
 <clipPath id="lm-clip">
 {ringPaths.map((d, i) => (
 <path key={i} d={d} />
 ))}
 </clipPath>
 {!relief && (
 <linearGradient id="lm-wash" x1={g1[0]} y1={g1[1]} x2={g2[0]} y2={g2[1]}>
 <stop offset="0" stopColor="var(--t-coast)" stopOpacity="0.5" />
 <stop offset={isDesert ? '0.42' : '0.6'} stopColor="var(--t-coast)" stopOpacity="0.05" />
 {isDesert && <stop offset="0.6" stopColor="var(--t-desert)" stopOpacity="0.05" />}
 {isDesert && <stop offset="1" stopColor="var(--t-desert)" stopOpacity="0.48" />}
 {!isDesert && <stop offset="1" stopColor="var(--t-coast)" stopOpacity="0" />}
 </linearGradient>
 )}
 <radialGradient id="lm-massif">
 <stop offset="0" stopColor="var(--t-mtn)" stopOpacity="0.55" />
 <stop offset="0.6" stopColor="var(--t-mtn)" stopOpacity="0.24" />
 <stop offset="1" stopColor="var(--t-mtn)" stopOpacity="0" />
 </radialGradient>
 </defs>

 <g className="lm-viewport" transform={zp.transform}>
 {/* offshore ripple lines (in the water, outside the county) */}
 {seaLines.map((pts, i) => (
 <path key={`sea${i}`} className="lm-sea" style={{ opacity: 0.3 - i * 0.07 }} d={`M ${pts}`} />
 ))}

 {/* land base fill */}
 {ringPaths.map((d, i) => (
 <path key={`fill${i}`} d={d} className="lm-fill" />
 ))}

 {/* baked hillshade x hypsometric relief (clipped to the county) + engraving over it */}
 <g clipPath="url(#lm-clip)">
 {reliefImg}
 {!relief && <rect x={0} y={0} width={W} height={H} fill="url(#lm-wash)" />}
 {!relief &&
 massifs.map((m, i) => {
 const [mx, my] = project(m.lon, m.lat);
 return <ellipse key={`mtn${i}`} cx={mx} cy={my} rx={m.rx * k * scale} ry={m.ry * scale} fill="url(#lm-massif)" />;
 })}
 {(map?.contours ?? []).map((c, i) => (
 <path key={`ct${i}`} className="lm-contour" d={toPath(c.points)} />
 ))}
 {rivers.map((r, i) => (
 <path key={`rv${i}`} className="lm-river" d={toPath(r.points)} />
 ))}
 </g>

 {/* county outline (engraved edge) */}
 {ringPaths.map((d, i) => (
 <path key={`line${i}`} d={d} className="lm-shape" />
 ))}

 {/* scale bar stays IN the viewport — it must scale to stay geometrically honest */}
 {scaleBar}
 </g>

 {/* Non-scaling label overlay (Fix 1): water label, natural features, town marks + the
 ink-red current-view mark, and the north arrow. NOT inside the zoomed group → text holds
 a constant on-screen size at any zoom. */}
 <g className="lm-labels">
 {waterLabel}
 {features}
 {towns.map((t, i) => placeMark(t.name, t.lon, t.lat, t.primary, `town${i}`, 'lm-town'))}
 {progressiveLabels}
 {northArrow}
 </g>
 </svg>

 {/* elevation (hypsometric) legend — a legend of measured elevation, not a coordinate */}
 {relief && map?.elev && (
 <div className="lm-hypso" data-testid="lm-hypso-legend">
 <span className="lm-hypso-cap">Elevation</span>
 <span className="lm-hypso-lo">{Math.max(0, map.elev.min)} m</span>
 <span className="lm-hypso-bar" aria-hidden="true" />
 <span className="lm-hypso-hi">{fmtM(map.elev.max)} m</span>
 </div>
 )}

 <div className="lm-legend" data-testid="lm-legend">
 <span><i className="lg-sel" /> Current view</span>
 {towns.some((t) => !t.primary) && <span><i className="lg-town" /> Town</span>}
 {(map?.contours?.length ?? 0) > 0 && <span><i className="lg-relief" /> Relief</span>}
 {rivers.length > 0 && <span><i className="lg-river" /> River</span>}
 {hasOcean && <span><i className="lg-sea" /> {map?.water_label ? cap(map.water_label) : 'Water'}</span>}
 </div>
 </div>
 );
}

function cap(s: string) {
 return s.charAt(0) + s.slice(1).toLowerCase();
}
function fmtM(n: number) {
 return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
