/* engine.js — Pigeon interactive World→Local globe engine, ported into the app from the
 * 2026-07-16 Matte Atlas mockup (mockups/globe-2026-07-16/interactive-worldtolocal/src/app.js).
 *
 * Phase 1 of the Globe Detail Build (the globe build spec §3):
 * - MATTE ATLAS ONLY. The mockup's Signal / Turning / Orbit skins stay behind in the mockup —
 * Timn locked Matte as THE skin (2026-07-16). All skin-switching machinery is removed.
 * - Data arrives via opts.data (fetched by the route from static /globe/data/*.json) instead of
 * inlined window.PG_* globals. The pack-loader (UX pack-loading spec + Design Spec D) lazily
 * fetches per-region detail packs (SD / VB exemplars for now; P3/P4 mass-produce more) with the
 * relief→water→roads→labels alpha fade-in and the honest #packstatus line. NAVIGATION NEVER
 * BLOCKS ON A PACK; a late pack for a non-current view only populates the cache (race gate).
 * - Everything else — the single orthographic projection state, frame-not-fill NAV, exhaustive
 * county/city hit-testing, city-identity boundary resolution (Phase 0), search combobox, feed
 * cards + add-to-newsfeed — is carried over at parity. The mockup's 55-check oracle runs
 * against this build (tests/globe-oracle.mjs).
 */
import {
 geoOrthographic,
 geoPath,
 geoGraticule,
 geoDistance,
 geoContains,
 geoCentroid,
 geoBounds,
} from 'd3-geo';
import { feature as topoFeature, mesh as topoMesh } from 'topojson-client';

export function initGlobe(opts) {
 'use strict';
 var G = {
 geoOrthographic: geoOrthographic,
 geoPath: geoPath,
 geoGraticule: geoGraticule,
 geoDistance: geoDistance,
 geoContains: geoContains,
 geoCentroid: geoCentroid,
 geoBounds: geoBounds,
 feature: topoFeature,
 mesh: topoMesh,
 };
 var root = opts.root;
 var WORLD = opts.data.world, TERRAIN = opts.data.terrain, US = opts.data.us;
 var CONTENT = opts.data.content;
 var PACK_BASE = opts.packBase || 'packs/';
 var destroyed = false;

 // ---------- geometry ----------
 var land = G.feature(WORLD, WORLD.objects.land);
 var countries = G.feature(WORLD, WORLD.objects.countries).features;
 // (Phase 2 — Design matte spec §2.5) interior political borders only (no coast double-strokes) —
 // the fine dashed linework that makes the matte plate read as a dense hand-made atlas.
 var countriesMesh = G.mesh(WORLD, WORLD.objects.countries, function (a, b) { return a !== b; });
 var lakes = G.feature(TERRAIN, TERRAIN.objects.lakes).features;
 var rivers = G.feature(TERRAIN, TERRAIN.objects.rivers).features;
 var ranges = G.feature(TERRAIN, TERRAIN.objects.ranges).features;
 ranges.forEach(function (f) { f.__c = G.geoCentroid(f); f.__r = angRadius(f, f.__c); }); // __r: angular radius, for per-massif relief highlights (matte atlas)
 lakes.forEach(function (f) { f.__c = G.geoCentroid(f); });
 countries.forEach(function (f) { f.__c = G.geoCentroid(f); });

 var usNation = G.feature(US, US.objects.nation);
 // CONUS-only silhouette (pre-merged by scripts/build-globe-data.mjs) for the cheap nation OUTLINE
 // stroke — falls back to the full nation feature if absent. Avoids stroking AK/HI/Pacific per frame.
 var usConus = opts.data.conus ? { type: 'Feature', geometry: opts.data.conus } : usNation;
 var usStates = G.feature(US, US.objects.states).features;
 var usStatesMesh = G.mesh(US, US.objects.states, function (a, b) { return a !== b; });
 var usCounties = G.feature(US, US.objects.counties).features;
 // full county mesh (shared interior boundaries only — single-path hairline layer for all counties, edit D).
 // The 10m mesh is too dense to path every frame (blows the 24ms budget at state zoom), so decimate its
 // vertices once at load with a running-distance filter — invisible on a faint hairline, ~half the points.
 function simplifyLine(line, minDeg) {
 if (!line || line.length < 3) return line;
 var out = [line[0]], last = line[0], m2 = minDeg * minDeg;
 for (var i = 1; i < line.length - 1; i++) { var dx = line[i][0] - last[0], dy = line[i][1] - last[1]; if (dx * dx + dy * dy >= m2) { out.push(line[i]); last = line[i]; } }
 out.push(line[line.length - 1]); return out;
 }
 // longitude helpers — antimeridian (±180°) crossers (Aleutians West 02016) report WRAPPED bounds
 // (east < west) from geoBounds. Sweeping a grid across the raw [w..e] then runs the WRONG way round the
 // globe (over Europe), never sampling the actual island chain. Unwrap by adding 360° to east, sweep in
 // that continuous space, and normalise each sample back to [-180,180]. General for any 180°-crossing feature.
 function normLon(l) { return ((l + 180) % 360 + 360) % 360 - 180; }
 function bboxDeg(b) { var w = b[0][0], e = b[1][0]; if (e < w) e += 360; return { w: w, e: e, s: b[0][1], n: b[1][1] }; }
 function bboxAreaDeg(b) { var d = bboxDeg(b); return Math.abs((d.e - d.w) * (d.n - d.s)); }
 // Interior anchor: a point GUARANTEED inside the feature (centroid for convex shapes; a bbox-grid
 // fallback for C-shaped/holey ones like Maryland or Louisiana, and antimeridian island chains). Used for
 // the container label AND for deterministic hover/hit — the geometric centroid of an odd or scattered
 // shape can fall outside it (in a hole, or in open water between islands) entirely.
 function interiorPoint(feat) {
 var c = G.geoCentroid(feat);
 if (c && G.geoContains(feat, c)) return c;
 var d = bboxDeg(G.geoBounds(feat)); // unwrapped: {w,e,s,n} with e>=w even across the antimeridian
 var N = 17; // denser than before so small islands / thin rings are not missed
 for (var gy = 1; gy < N; gy++) for (var gx = 1; gx < N; gx++) {
 var lon = normLon(d.w + (d.e - d.w) * gx / N), lat = d.s + (d.n - d.s) * gy / N;
 if (G.geoContains(feat, [lon, lat])) return [lon, lat];
 }
 return c;
 }
 // Per-state county meshes (decimated), so the all-county hairline layer can CULL to the near-side
 // states in view instead of pathing every CONUS county every frame — keeps state-zoom under budget.
 usStates.forEach(function (f) { f.__c = G.geoCentroid(f); f.__a = interiorPoint(f); });
 var countyMeshByState = {};
 usStates.forEach(function (st) {
 var fips = String(st.id);
 var m = G.mesh(US, US.objects.counties, function (a, b) { return a !== b && String(a.id).slice(0, 2) === fips && String(b.id).slice(0, 2) === fips; });
 countyMeshByState[fips] = { type: 'MultiLineString', coordinates: m.coordinates.map(function (l) { return simplifyLine(l, 0.17); }) };
 });

 // ---------- comprehensive US cities (USA full-detail build) — ~2,400 places, US Census 2023 Gazetteer
 // (Places) + SUB-EST2023 population estimates (BOTH US-government works, PUBLIC DOMAIN). Each place
 // carries {name, lon, lat, pop, state, county_fips, county_name, capital} — pop for LOD/search ranking,
 // county_fips + state for breadcrumb derivation (UX + Design data dependency). Built by gen-cities.mjs.
 var CITIES = (opts.data.cities || []).map(function (c, i) {
 return { id: 'city:' + i, name: c.n, state: c.s, c: [c.lon, c.lat], pop: c.pop | 0,
 cf: c.cf || '', cn: c.cn || '', capital: !!c.cap, g: c.g || '' };
 });
 CITIES.sort(function (a, b) { return b.pop - a.pop; });
 // (Phase 2 §3.3) tier by RANK — top 12 (or any capital) = A (circled-dot), next 40 = B, rest = C.
 CITIES.forEach(function (c, i) { c.tier = (i < 12 || c.capital) ? 'A' : (i < 52 ? 'B' : 'C'); });
 var sphere = { type: 'Sphere' };
 var graticule = G.geoGraticule().step([20, 20])();
 var graticuleFine = G.geoGraticule().step([10, 10])();

 // FIPS → state name (us-atlas states carry no name property; needed to label a generically-selected state)
 var FIPS_NAME = { '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa', '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine', '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota', '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska', '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York', '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont', '51': 'Virginia', '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming' };
 function stateName(feat) { return FIPS_NAME[String(feat.id)] || 'This state'; }
 function stateByFips(f) { for (var i = 0; i < usStates.length; i++) if (usStates[i].id === f) return usStates[i]; return null; }
 function countyByFips(f) { for (var i = 0; i < usCounties.length; i++) if (usCounties[i].id === f) return usCounties[i]; return null; }
 function countiesInState(f) { return countiesByStateFips[f] || []; }

 // reverse: state NAME -> FIPS (cities carry the state name; we need its FIPS for scoping/breadcrumbs)
 var NAME_FIPS = {}; Object.keys(FIPS_NAME).forEach(function (f) { NAME_FIPS[FIPS_NAME[f]] = f; });
 // precomputed indexes (avoid O(3142) filters per hit-test / render) — the full county mesh is dense.
 var countiesByStateFips = {}, countyById = {};
 usCounties.forEach(function (c) { var sf = String(c.id).slice(0, 2); (countiesByStateFips[sf] = countiesByStateFips[sf] || []).push(c); countyById[String(c.id)] = c; c.__c = G.geoCentroid(c); });
 // SINGLE-COUNTY STATES (District of Columbia — its one county == the whole district; any future federal-
 // district-like case generalises). Geometry quirk: the county's zoom-fit is not deeper than the state's,
 // so the level-2 "county container" NAV band is EMPTY — every in-district zoom is level 3 (city layer),
 // where the coincident capital-city dot would shadow the county on hover. Flag these so the resolver lets
 // the district county win over its coincident city dot and stays individually hover-highlightable.
 var singleCountyState = {}; Object.keys(countiesByStateFips).forEach(function (sf) { if (FIPS_NAME[sf] && countiesByStateFips[sf].length === 1) singleCountyState[sf] = true; });
 // TINY-COUNTY robustness. Two source-geometry hazards make ~40 counties fragile for point-in-polygon:
 // (a) DEGENERATE — a few VA/MO independent cities collapse to ~zero area at 10m (centroid not even
 // inside their own polygon), and some multipart counties (e.g. Island Co WA) have their bbox-centre
 // in open water outside any state polygon;
 // (b) SUB-PIXEL — small independent cities (Martinsville, Salem, Roanoke city…) are ~1px polygons whose
 // containment flips under the projection's floating-point round-trip, so the surrounding county
 // wins the strict test.
 // Fix: every degenerate OR small county gets a TIGHT proximity hit-zone (≈ its own footprint) in a
 // GLOBAL index; the resolver checks it FIRST (and recovers the state from the county), so EVERY county —
 // all 3,142 — stays individually hover/clickable. Tight zones never steal a neighbour's ground.
 // Two source-geometry hazards: (1) DOUGHNUT counties (VA counties ringing an independent city) have
 // their centroid in the HOLE (the enclosed city), so a centroid anchor + strict containment resolve to
 // the wrong feature; (2) tiny/zero-area independent cities are ~1px polygons whose containment flips
 // under the projection round-trip. Fix (1): give EVERY county an interior anchor guaranteed on its own
 // land (ring/island), via interiorPoint. Fix (2): give only genuinely SMALL counties a TIGHT proximity
 // hit-zone (≈ their own footprint) checked before containment. Together: all 3,142 stay pickable.
 var tinyCounties = [], degenList = [];
 // pass 1 — precompute bbox + area; small independent-city-scale counties get a TIGHT proximity zone;
 // every county gets a provisional interior anchor.
 usCounties.forEach(function (c) {
 var b = G.geoBounds(c); c.__b = b; c.__ba = bboxAreaDeg(b); // unwrapped area — antimeridian crossers must not report a globe-spanning bbox
 c.__a = interiorPoint(c);
 if (!G.geoContains(c, c.__c)) { c.__degen = true; degenList.push(String(c.id)); }
 if (c.__ba < 0.012) {
 var r = clamp(G.geoDistance([(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], b[0]) * 1.0, 0.0002, 0.0011);
 tinyCounties.push({ co: c, ctr: c.__a, r: r });
 }
 });
 // pass 2 — DOUGHNUT fix. At 10m the county polygons are FILLED (they include the enclosed independent
 // city), so a doughnut county's interior point lands INSIDE that city (or its proximity zone) and would
 // resolve to it. Use the ACTUAL runtime resolver (countyAt) as the test: if the anchor doesn't resolve
 // back to THIS county, hunt the bbox grid for a ring point that does. Guarantees every county self-resolves.
 usCounties.forEach(function (c) {
 var st = stateByFips(String(c.id).slice(0, 2));
 if (countyAt(c.__a, st) === c) return;
 var b = c.__b;
 for (var gy = 1; gy < 17; gy++) for (var gx = 1; gx < 17; gx++) {
 var p = [b[0][0] + (b[1][0] - b[0][0]) * gx / 17, b[0][1] + (b[1][1] - b[0][1]) * gy / 17];
 if (countyAt(p, st) === c) { c.__a = p; return; }
 }
 });
 function tinyCountyNear(geo) { if (!geo) return null; var best = null, bd = Infinity; for (var i = 0; i < tinyCounties.length; i++) { var t = tinyCounties[i], d = G.geoDistance(geo, t.ctr); if (d < t.r && d < bd) { bd = d; best = t.co; } } return best; }
 function countyName(feat) { return (feat && feat.properties && feat.properties.name) ? feat.properties.name + ' County' : 'This county'; }
 // cities indexed by state FIPS + county FIPS (for search scope + county-focus rendering + city pick)
 var citiesByStateFips = {}, citiesByCounty = {}, cityById = {}, cityByGeoid = {};
 CITIES.forEach(function (c) {
 cityById[c.id] = c;
 if (c.g) cityByGeoid[c.g] = c;
 var sf = NAME_FIPS[c.state]; c.sf = sf || '';
 if (sf) (citiesByStateFips[sf] = citiesByStateFips[sf] || []).push(c);
 if (c.cf) (citiesByCounty[c.cf] = citiesByCounty[c.cf] || []).push(c);
 });

 // ---------- city boundary hit-zones (Phase 0, GLOBE_DETAIL_BUILD §3 — the city-identity fix) ----------
 // Every city ≥100k pop carries a simplified Census PLACE polygon (cb_2023_us_place_500k, public
 // domain, baked by gen-city-polys.mjs — quantized delta-encoded rings + a guaranteed interior anchor).
 // Identity rule (mirrors the county layer's smallest-containing-wins, and fixes Timn's 2026-07-17
 // finding — SD clicks offering Coronado, LA clicks presenting Culver City):
 // 1. A point inside a city's real boundary belongs to THAT city; where boundaries nest, the
 // SMALLEST containing place wins. Enclave cities (Culver City, West Hollywood…) are HOLES in the
 // surrounding city's rings, so even-odd containment excludes them naturally.
 // 2. A city that HAS a polygon claims ground ONLY by containment — its dot never steals nearby
 // clicks (that was the bug, inverted). Dot-proximity picking remains for the <100k cities,
 // population-weighted so a bigger dot beats a smaller one on genuinely ambiguous clicks.
 var CITYPOLYS = (function () {
 var src = opts.data.citypolys, out = {};
 if (!src || !src.cities) return out;
 var q = src.q || 1000;
 Object.keys(src.cities).forEach(function (g) {
 var e = src.cities[g], rings = [];
 for (var ri = 0; ri < e.r.length; ri++) {
 var f = e.r[ri], ring = new Float64Array(f.length);
 var x = f[0], y = f[1]; ring[0] = x / q; ring[1] = y / q;
 for (var i = 2; i < f.length; i += 2) { x += f[i]; y += f[i + 1]; ring[i] = x / q; ring[i + 1] = y / q; }
 rings.push(ring);
 }
 out[g] = { rings: rings, b: [e.b[0] / q, e.b[1] / q, e.b[2] / q, e.b[3] / q],
 area: ((e.b[2] - e.b[0]) * (e.b[3] - e.b[1])) / (q * q), anchor: e.a };
 });
 return out;
 })();
 // planar even-odd point-in-rings — winding-agnostic, holes fall out naturally when ALL rings are
 // tested together. Cities are small and none crosses the antimeridian, so planar lon/lat is exact enough.
 function ringsContainPt(rings, lon, lat) {
 var inside = false;
 for (var r = 0; r < rings.length; r++) {
 var ring = rings[r], n = ring.length;
 for (var i = 0; i < n; i += 2) {
 var j = i === 0 ? n - 2 : i - 2;
 var xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
 if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
 }
 }
 return inside;
 }
 var polyCitiesAsc = []; // poly-carrying cities sorted by bbox area ASC → first containment hit = smallest place
 CITIES.forEach(function (c) { var p = c.g && CITYPOLYS[c.g]; if (p) { c.poly = p; polyCitiesAsc.push(c); } });
 polyCitiesAsc.sort(function (a, b) { return a.poly.area - b.poly.area; });
 function cityPolyAt(geo) {
 if (!geo) return null;
 var lon = geo[0], lat = geo[1];
 for (var i = 0; i < polyCitiesAsc.length; i++) {
 var b = polyCitiesAsc[i].poly.b;
 if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue; // bbox prefilter — containment only for candidates
 if (ringsContainPt(polyCitiesAsc[i].poly.rings, lon, lat)) return polyCitiesAsc[i];
 }
 return null;
 }
 // QC-only negative control (the oracle proves its own sweep can fail): true = pre-fix nearest-dot picking.
 var QC_LEGACY_CITYPICK = false;

 // ---------- county isolation register (Phase 3 — UX county-isolation spec + Design Spec B) ----------
 // When a county is COMMITTED (clicked at state depth, breadcrumb, search back-nav, or free-zoom
 // past the county band), the app enters the isolation register: the county is the container
 // (outline + name only, fillAlpha=0 — frame-not-fill), everything outside its rings is dimmed to
 // the page tone by ONE screen-space even-odd path per frame, and the county's Gazetteer places
 // (from the per-county detail pack) are the pickable children. Outside the boundary: zero labels,
 // zero dots, zero hover, clicks inert (one-time toast). UX §1 is the interaction floor.
 var MASK_ALPHA = 0.82; // T1: GHOST 0.82 (Design recommendation; product ruling pending — VOID = 0.97. ONE constant flips it.)
 var isoLatch = null; // committed county fips (the hysteresis latch — UX §3.2)
 var isoLatchEntry = 0; // scale at which isolation engaged (release sits ~10% beyond it)
 var isoLatchKind = 'click';// 'click' (explicit commit — deep release band) | 'free' (scroll-in — symmetric ±10%)
 // B1 (UX §5.1): an explicit county commit holds its isolation register UNCONDITIONALLY while its
 // inbound fly is still animating. The fly ramps scale up from the state register; the release
 // predicate `s >= rel` is a ZOOM-OUT detector, but during the ramp the transient low scale trips
 // it and releases a latch that was committed a frame earlier — after which the free path only
 // re-commits above fit×0.72, which the scale ceiling (countyScaleCeiling) forbids for the smaller
 // half of counties. Guarding the committed fips through its fly lets the mask engage on landing at
 // whatever scale the ceiling permits (the county renders <55% — fine per §5.1), for ALL counties.
 var isoFlyCommit = null; // fips whose inbound explicit-commit fly is in progress (guards the latch)
 var isoToasted = {}; // one-time "exits" toast per county visit (UX §1.2)
 var isoAnim = { alpha: 0, from: 0, target: 0, t0: 0 };
 var lastIsoFips = null; // county to render as SEL child right after a zoom-out release (UX §3.2.2)
 function isoCommit(fips, entryScale, kind) { if (isoLatch !== fips) { delete isoToasted[fips]; } isoLatch = fips; isoLatchEntry = entryScale; isoLatchKind = kind || 'click'; lastIsoFips = null; }
 // release threshold (UX §3.2 hysteresis, ~10% beyond entry). A CLICKED county keeps the deep
 // county-band release (min(fit×0.5, entry)×0.9); a FREE-scrolled entry releases symmetrically
 // (entry×0.9) — otherwise a near-state-sized county (Providence at Rhode Island's framing) would
 // trap the state view under its mask after one scroll past its band.
 function isoReleaseScale(lc) {
 return isoLatchKind === 'click' ? Math.min(countyFitOf(lc) * 0.5, isoLatchEntry) * 0.9 : isoLatchEntry * 0.9;
 }
 function isoReleaseLatch() { if (isoLatch) { lastIsoFips = isoLatch; delete isoToasted[isoLatch]; } isoLatch = null; }
 function isoActive() { return NAV.level === 3 && !!isoLatch; }
 // mask fade: in over ~300ms (lands WITH the fly), out over ~240ms — alpha ramp only (UX §3.1/§3.2)
 function isoAlphaNow() {
 var target = isoActive() ? 1 : 0;
 if (target !== isoAnim.target) { isoAnim.target = target; isoAnim.from = isoAnim.alpha; isoAnim.t0 = performance.now(); }
 var dur = target > 0 ? 300 : 240;
 var t = clamp((performance.now() - isoAnim.t0) / dur, 0, 1);
 isoAnim.alpha = isoAnim.from + (target - isoAnim.from) * (1 - Math.pow(1 - t, 2));
 if (t < 1) requestRender();
 return isoAnim.alpha;
 }
 // independent-city county-equivalents (Baltimore/St. Louis/Carson City + the VA independents) —
 // deterministic FIPS rule; honest titling before the pack's Gazetteer name arrives (UX §5.3)
 function isIndepFips(fips) { var sf = fips.slice(0, 2), cc = +fips.slice(2); return cc >= 510 && (sf === '51' || sf === '24' || sf === '29' || sf === '32'); }
 function countyDisplayName(co) {
 if (!co) return 'This county';
 var fips = String(co.id);
 var rec = packRecs['co' + fips];
 if (rec && rec.data && rec.data.name) return rec.data.name; // full Gazetteer name (…Parish/…Borough/…city)
 var nm = (co.properties && co.properties.name) || 'This';
 if (fips === '11001') return 'District of Columbia';
 if (isIndepFips(fips)) return nm + ' city';
 return nm + ' County';
 }
 function countyFeedTitle(co) {
 var fips = String(co.id), disp = countyDisplayName(co);
 if (isIndepFips(fips)) return disp.replace(/\s+city$/i, '') + ' (independent city)'; // UX §5.3 — honest class, no invented "County"
 return disp;
 }
 // scale ceiling (UX §5.1): never zoom past the city-register entry scale just to make a tiny
 // county hit the framing band — Kalawao renders smaller than 55%, and that is fine.
 function countyScaleCeiling() { return genFits().sLocal * 0.9; }
 // ×1.12 lands the county bbox in UX's §1.3 framing band (~55–80% of the working area's shorter
 // axis); the ceiling wins for tiny counties (they render smaller than 55% — by design)
 function countyTargetScale(co) { return clamp(Math.min(countyFitOf(co) * 1.12, countyScaleCeiling()), minScale, maxScale()); }
 // doughnut counties (UX §5.4): at 10m the county polygons are FILLED — a county that rings an
 // independent city carries NO hole ring, so the even-odd mask alone would leave the enclave
 // unmasked. The enclave counties themselves ARE in the dataset: any sibling county fully inside
 // this county's bbox whose anchor the county contains is a hole — its rings join the mask path
 // and its ground is mask-inert. Computed once per county, cached on the feature.
 function countyEnclaves(cc) {
 if (cc.__encl) return cc.__encl;
 var d = bboxDeg(cc.__b || (cc.__b = G.geoBounds(cc)));
 var out = [], sf = String(cc.id).slice(0, 2);
 (countiesByStateFips[sf] || []).forEach(function (o) {
 if (o === cc) return;
 var ob = bboxDeg(o.__b || (o.__b = G.geoBounds(o)));
 if (ob.w >= d.w - 0.002 && ob.e <= d.e + 0.002 && ob.s >= d.s - 0.002 && ob.n <= d.n + 0.002
 && G.geoContains(cc, countyAnchor(o))) out.push(o);
 });
 cc.__encl = out;
 return out;
 }
 // is any part of the county still near the viewport? (soft-clamp + latch guard; antimeridian-safe bbox)
 function countyOnScreen(co, marginFrac) {
 // deep inside a huge county every bbox corner is off-screen — the viewport centre being inside
 // the county is the strongest "still here" signal, so it short-circuits first
 var cg = centerCoord();
 if (G.geoContains(co, cg) || tinyCountyNear(cg) === co) return true;
 var d = bboxDeg(co.__b || (co.__b = G.geoBounds(co)));
 var m = marginFrac == null ? 0.6 : marginFrac;
 var pts = [countyAnchor(co), [normLon(d.w), d.s], [normLon(d.e), d.s], [normLon(d.w), d.n], [normLon(d.e), d.n], [normLon((d.w + d.e) / 2), (d.s + d.n) / 2]];
 for (var i = 0; i < pts.length; i++) {
 if (!visiblePt(pts[i], -0.2)) continue;
 var p = projection(pts[i]); if (!p) continue;
 if (p[0] > -W * m && p[0] < W * (1 + m) && p[1] > -H * m && p[1] < H * (1 + m)) return true;
 }
 return false;
 }

 // ---------- NAV — explicit container navigation (the frame-not-fill invariant driver) ----------
 // level 0 world · 1 nation(US) · 2 state · 3 county · 4 city/local. The DEEPEST set region is the
 // "container" (rendered as OUTLINE, never a flood); its direct children are the interactive fill layer.
 var NAV = { level: 0, stateFips: null, countyFips: null, cityId: null };
 function navReset() { NAV.level = 0; NAV.stateFips = NAV.countyFips = NAV.cityId = null; }

 // ---------- drill configs ----------
 // Built from the SLIM metadata baked into content.json (center/bbox/names) so the boot bundle can
 // compute every fit WITHOUT the detail packs — the packs themselves stay fully lazy (UX spec §1).
 var DRILL_META = CONTENT.drills || {};
 var LOCAL_SLUGS = CONTENT.localSlugs || { county: {}, city: {} };
 var DRILLS = {};
 Object.keys(DRILL_META).forEach(function (k) {
 var m = DRILL_META[k];
 DRILLS[k] = {
 key: k, name: m.name,
 stateFips: m.stateFips, stateName: m.stateName,
 regionFips: m.regionFips, regionName: m.regionName,
 center: m.center, bbox: m.bbox,
 stateFeature: stateByFips(m.stateFips),
 regionFeature: countyByFips(m.regionFips),
 stateCounties: countiesInState(m.stateFips),
 };
 });
 var DRILL_KEYS = Object.keys(DRILLS);

 // ---------- national + economic stories ----------
 var NAT = CONTENT.national || [];
 var ECON = CONTENT.economic || [];
 // pins = national stories that carry a hotspot
 var PINS = NAT.filter(function (s) { return s.hotspot; }).map(function (s) {
 return { id: s.id, c: [s.hotspot.lon, s.hotspot.lat], label: s.hotspot.label, theater: !!s.hotspot.theater, story: s };
 });
 // map every story with a hotspot to the country that contains it (all-nations-active)
 var countryStories = {};
 PINS.forEach(function (p) {
 for (var i = 0; i < countries.length; i++) {
 if (G.geoContains(countries[i], p.c)) { var nm = countries[i].properties.name; (countryStories[nm] = countryStories[nm] || []).push(p.story); break; }
 }
 });

 // ---------- canvas / projection ----------
 var canvas = root.querySelector('#globe');
 var stage = root.querySelector('#stage');
 var ctx = canvas.getContext('2d');
 var projection = G.geoOrthographic().clipAngle(90).precision(0.4).rotate([12, -28, 0]);
 var path = G.geoPath(projection, ctx);
 var W = 0, H = 0, dpr = 1, baseScale = 0, minScale = 1, firstFit = true;

 // ---------- pre-baked engraved-atlas texture tiles (Phase 2 — Design matte spec §2.0) ----------
 // Screen-fixed ink: paper grain, relief hachure, ocean paper-tooth. Baked ONCE at module load, then
 // reused as CanvasPatterns each frame (no per-frame allocation, no reprojection). This is the
 // "printed-plate" model — geographic tone moves with the globe, the plate's tooth stays put.
 function tileCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
 function grainTile(size) {
 var c = tileCanvas(size, size), g = c.getContext('2d');
 var id = g.createImageData(size, size), d = id.data;
 for (var i = 0; i < d.length; i += 4) { var v = 128 + (Math.random() - 0.5) * 46; d[i] = v + 6; d[i + 1] = v + 2; d[i + 2] = v - 6; d[i + 3] = 255; }
 g.putImageData(id, 0, 0); return c;
 }
 function hatchTile(px, col) {
 var c = tileCanvas(px, px), g = c.getContext('2d');
 g.strokeStyle = col; g.globalAlpha = 0.9; g.lineWidth = 0.8;
 g.beginPath(); g.moveTo(-1, px + 1); g.lineTo(px + 1, -1); g.moveTo(px * 0.5, px + 1); g.lineTo(px + 1, px * 0.5 - 1); g.stroke();
 return c;
 }
 function stippleTile(px, col) {
 var c = tileCanvas(px, px), g = c.getContext('2d');
 g.fillStyle = col; g.globalAlpha = 0.8; g.beginPath(); g.arc(px * 0.5, px * 0.5, 0.6, 0, 7); g.fill();
 return c;
 }
 // (Phase 2 physical — Design Spec A §0.1) physical-geography ink tiles, copied VERBATIM from his
 // reference render (physical-geo-reference.html). Tile ink at FULL alpha — the LAYER alpha
 // does the softening, never both (Design's double-softening lesson, spec A4). Deterministic RNG
 // (mulberry32) so every stipple is identical every render.
 function tileRNG(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
 function desertTile() { // 6px, one dot r0.7 hash-jittered, warm ink #a08b5f — hot-fine
 var c = tileCanvas(6, 6), g = c.getContext('2d'), r = tileRNG(21);
 g.fillStyle = '#a08b5f'; g.globalAlpha = 1; g.beginPath(); g.arc(1.5 + r() * 3, 1.5 + r() * 3, 0.7, 0, 7); g.fill(); return c;
 }
 function tundraTile() { // 8px, one dot r0.6, cool ink #8fa08f — cold-sparse
 var c = tileCanvas(8, 8), g = c.getContext('2d'), r = tileRNG(31);
 g.fillStyle = '#8fa08f'; g.globalAlpha = 1; g.beginPath(); g.arc(2 + r() * 4, 2 + r() * 4, 0.6, 0, 7); g.fill(); return c;
 }
 function forestTile() { // 9px bosk: two dots + crown-hint arc — round + clumpy, no moiré vs the 7px linear hachure
 var c = tileCanvas(9, 9), g = c.getContext('2d');
 g.globalAlpha = 1; g.fillStyle = '#77835f';
 g.beginPath(); g.arc(2.5, 3, 0.7, 0, 7); g.fill();
 g.beginPath(); g.arc(6, 6.5, 0.7, 0, 7); g.fill();
 g.strokeStyle = '#77835f'; g.lineWidth = 0.6; g.beginPath(); g.arc(4.5, 4, 1.5, 3.6, 5.8); g.stroke(); return c;
 }
 var GRAIN_TILE = grainTile(200), HATCH_TILE = hatchTile(7, '#6b5a3c'), STIPPLE_TILE = stippleTile(5, '#4d6b70');
 var DESERT_TILE = desertTile(), TUNDRA_TILE = tundraTile(), FOREST_TILE = forestTile();
 var GRAIN_PAT = null, HATCH_PAT = null, STIPPLE_PAT = null; // CanvasPatterns, created lazily against ctx
 var DESERT_PAT = null, TUNDRA_PAT = null, FOREST_PAT = null;
 var texturesBaked = false;
 function ensurePatterns() {
 if (GRAIN_PAT) return;
 GRAIN_PAT = ctx.createPattern(GRAIN_TILE, 'repeat');
 HATCH_PAT = ctx.createPattern(HATCH_TILE, 'repeat');
 STIPPLE_PAT = ctx.createPattern(STIPPLE_TILE, 'repeat');
 DESERT_PAT = ctx.createPattern(DESERT_TILE, 'repeat');
 TUNDRA_PAT = ctx.createPattern(TUNDRA_TILE, 'repeat');
 FOREST_PAT = ctx.createPattern(FOREST_TILE, 'repeat');
 texturesBaked = !!(GRAIN_PAT && HATCH_PAT && STIPPLE_PAT && DESERT_PAT && TUNDRA_PAT && FOREST_PAT);
 }
 // (Phase 2 §4) hover/selection fill strengths — LOCKED by Design, replacing the old 0.10 wash.
 var HOVER_FILL = 0.16, SEL_FILL = 0.24, HOVER_SOFT = 0.45, SEL_SOFT = 0.55;
 function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
 function band(x, a, b) { return clamp((x - a) / (b - a), 0, 1); }

 // ================== PHYSICAL GEOGRAPHY (Globe Detail Build Phase 2 — Design Spec A) ==================
 // Engraved rivers (class-weight batches + 3-seg taper), lakes (shore-lining + great-lakes stipple),
 // glaciers/ice + Antarctic shelves, desert + tundra stipple, MODIS-derived forest bosk — pre-merged
 // per register by scripts/build-globe-physical.mjs. THE PERF ARCHITECTURE (spec §0.3): each treatment
 // draws as ONE Path2D (culled members concatenated) → 1 clip + ≤2 fills per treatment per frame.
 // Path2Ds are cached per projection state, so at-rest frames (hover, fades) pay only raster cost.
 // Screen-fixed pattern ink + feather/lining strokes draw at REST only (the heavyTex precedent —
 // printed-plate ink freezes to the paper; geographic tone + waterlines keep moving with the globe).
 // The pack is lazily fetched AFTER first paint (base world+nation, then state detail) and fades in
 // over 400ms ease-out — the boot wave stays lean; failure leaves the honest base map (terrain-topo
 // rivers/lakes), never a blocker.
 var PHYS = null, PHYS_STATE_LOADED = false, physEnabled = true, physFetchState = 'idle';
 var physFadeStart = 0, physFetches = 0, physRetried = false;
 var pathD = G.geoPath(projection); // context-swappable twin of `path` for Path2D builds
 var DATA_BASE = opts.dataBase || 'data/';
 function physOn() { return !!PHYS && physEnabled; }
 function physAlphaNow() {
 if (!physFadeStart) return 1;
 var t = (performance.now() - physFadeStart) / 400;
 if (t >= 1) { physFadeStart = 0; return 1; }
 requestRender();
 return 1 - Math.pow(1 - clamp(t, 0, 1), 2); // ease-out ramp (Spec D vocabulary — alpha only)
 }
 function decodeMembers(list) {
 var out = [];
 for (var i = 0; i < (list || []).length; i++) {
 var m = list[i];
 out.push({ c: m.c, r: m.r, a: m.a || 0, gl: m.gl || 0, n: m.n || null, g: m.g, geo: { type: 'Polygon', coordinates: m.g } });
 }
 return out;
 }
 function decodeRivers(batches) {
 var out = {};
 Object.keys(batches || {}).forEach(function (bk) {
 out[bk] = batches[bk].map(function (l) {
 var segs;
 if (bk === 'W1' || bk === 'W2') { // 3-seg engraved taper (source→mouth), split indices baked
 segs = [
 { type: 'LineString', coordinates: l.p.slice(0, l.t[0] + 1) },
 { type: 'LineString', coordinates: l.p.slice(l.t[0], l.t[1] + 1) },
 { type: 'LineString', coordinates: l.p.slice(l.t[1]) },
 ];
 } else { // hairline batches draw single-pass — taper on a 0.5px line is sub-pixel
 segs = [{ type: 'LineString', coordinates: l.p }];
 }
 return { c: l.c, r: l.r, n: l.n || null, segs: segs };
 });
 });
 return out;
 }
 function physDecode(base, state) {
 var P = { reg: {}, shelves: decodeMembers(base.shelves), deserts: decodeMembers(base.deserts), tundra: decodeMembers(base.tundra), meta: base.meta || {} };
 ['world', 'nation'].forEach(function (rk) {
 P.reg[rk] = {
 rivers: decodeRivers(base.rivers[rk]),
 lakes: decodeMembers(base.lakes[rk]),
 ice: decodeMembers(base.ice[rk]),
 forest: { out: decodeMembers(base.forest[rk].out), inR: decodeMembers(base.forest[rk]['in']) },
 };
 });
 if (state) {
 P.reg.state = {
 rivers: decodeRivers(state.rivers.state),
 lakes: decodeMembers(state.lakes.state),
 ice: decodeMembers(state.ice.state),
 forest: { out: decodeMembers(state.forest.state.out), inR: decodeMembers(state.forest.state['in']) },
 };
 }
 return P;
 }
 function fetchPhysical() {
 if (destroyed || physFetchState === 'loading' || physFetchState === 'complete') return;
 physFetchState = 'loading'; physFetches++;
 fetch(DATA_BASE + 'physical.json', { cache: 'force-cache' })
 .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
 .then(function (base) {
 if (destroyed) return;
 PHYS = physDecode(base, null);
 physFetchState = 'complete';
 physFadeStart = performance.now();
 physCache = { key: '', p: {} }; physEpoch++;
 requestRender();
 // state-register detail follows once the base is on screen (never part of any boot wave)
 setTimeout(fetchPhysicalState, 400);
 })
 .catch(function () {
 if (destroyed) return;
 physFetchState = 'idle';
 if (!physRetried) { physRetried = true; setTimeout(fetchPhysical, 4000); } // one quiet retry
 else physFetchState = 'failed'; // base map (terrain rivers/lakes) remains — honest, not blank
 });
 }
 function fetchPhysicalState() {
 if (destroyed || !PHYS || PHYS_STATE_LOADED) return;
 fetch(DATA_BASE + 'physical-state.json', { cache: 'force-cache' })
 .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
 .then(function (state) {
 if (destroyed || !PHYS) return;
 PHYS.reg.state = {
 rivers: decodeRivers(state.rivers.state),
 lakes: decodeMembers(state.lakes.state),
 ice: decodeMembers(state.ice.state),
 forest: { out: decodeMembers(state.forest.state.out), inR: decodeMembers(state.forest.state['in']) },
 };
 PHYS_STATE_LOADED = true;
 physCache = { key: '', p: {} }; physEpoch++;
 requestRender();
 })
 .catch(function (e) { if (typeof console !== 'undefined') console.warn('physical-state pack unavailable — state register keeps nation geometry', e); });
 }
 // register pick (geometry) — alphas ramp continuously (nothing pops); geometry swaps at scales
 // where the tolerance delta is sub-pixel by construction (pipeline tolerances ≈ 1px at swap scale).
 function physRegKey() {
 var s = projection.scale(), f = genFits();
 if (s < f.sN * 1.05) return 'world'; // matches the lod() world band (< sN×1.05, Design A7)
 if (s < f.sState * 0.9 || !PHYS.reg.state) return 'nation';
 return 'state';
 }
 // continuous ramps keyed to the shipped lod() bands (Spec A7): rN world→nation, rS nation→state,
 // cf = county fade-OUT — every physical treatment tapers out toward the county register (county
 // interior detail is Phase 3's pack; SoT: "no world-register stipple at county zoom").
 // cf is FIT-RELATIVE (the resolver's own depth rule): the county band starts from the CURRENT
 // container's own fit, not the CONUS-calibrated sRegionRef — a small state's frame (WA, RI…)
 // lands deeper than sN×6.5 and must still carry full physical detail at its STATE register.
 function physRamps() {
 var s = projection.scale(), f = genFits();
 var ref = f.sRegion;
 var cc = containerCounty();
 if (cc) ref = Math.max(ref, countyFitOf(cc));
 else { var cs = containerState(); if (cs) ref = Math.max(ref, stateFitOf(cs) * 2.2); }
 return {
 rN: band(s, f.sN * 1.02, f.sN * 1.6),
 rS: band(s, f.sState * 0.72, f.sState * 1.05),
 cf: 1 - band(s, ref * 0.60, ref * 0.95), // fully out just before the county frame (fit×0.95)
 };
 }
 // Path2D cache — keyed on the full projection state + register; at rest every render() reuses the
 // built paths (raster cost only). Any rotate/zoom/resize invalidates.
 var physCache = { key: '', p: {} };
 function physPaths() {
 var r = projection.rotate();
 var key = r[0].toFixed(3) + ',' + r[1].toFixed(3) + ',' + projection.scale().toFixed(1) + ',' + W + 'x' + H + ',' + physRegKey();
 if (physCache.key !== key) physCache = { key: key, p: {} };
 return physCache.p;
 }
 function viewAng() { return Math.min(Math.PI / 2, 1.35 * (Math.hypot(W, H) / 2) / projection.scale() + 0.03); }
 function buildPolyPath(cache, id, members) {
 var e = cache[id];
 if (e) return e;
 var p2 = new Path2D(); pathD.context(p2);
 var cc = centerCoord(), vr = viewAng(), any = false;
 var s = projection.scale(), bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bbOK = true;
 for (var i = 0; i < members.length; i++) {
 var m = members[i];
 if (G.geoDistance(m.c, cc) >= Math.min(Math.PI / 2 + m.r, vr + m.r)) continue;
 pathD(m.geo); any = true;
 // approximate screen bbox of the treatment (member centres ± angular radius) — lets the fill
 // pass cover only the treatment's raster extent instead of the whole disc (perf: clipped
 // fillRects are area-bound; tundra/ice/desert occupy narrow bands of the world plate)
 var pc = projection(m.c);
 if (!pc) { bbOK = false; continue; }
 var ext = Math.min(Math.PI / 2, m.r) * s * 1.25 + 24;
 if (pc[0] - ext < bx0) bx0 = pc[0] - ext; if (pc[0] + ext > bx1) bx1 = pc[0] + ext;
 if (pc[1] - ext < by0) by0 = pc[1] - ext; if (pc[1] + ext > by1) by1 = pc[1] + ext;
 }
 e = { p: p2, any: any, bb: (any && bbOK && bx0 < bx1) ? [bx0, by0, bx1, by1] : null };
 cache[id] = e;
 return e;
 }
 // fill extent for a built treatment path: its screen bbox ∩ the pass rect (fallback = pass rect)
 function physRect(e, dr) {
 if (!e.bb) return dr;
 var x0 = Math.max(dr[0], e.bb[0]), y0 = Math.max(dr[1], e.bb[1]);
 var x1 = Math.min(dr[0] + dr[2], e.bb[2]), y1 = Math.min(dr[1] + dr[3], e.bb[3]);
 if (x1 <= x0 || y1 <= y0) return [0, 0, 0, 0];
 return [x0, y0, x1 - x0, y1 - y0];
 }
 function buildRiverPaths(cache, id, lines, nSegs) {
 var e = cache[id];
 if (e) return e;
 var paths = [], k;
 for (k = 0; k < nSegs; k++) { var p2 = new Path2D(); paths.push(p2); }
 var cc = centerCoord(), vr = viewAng(), any = false;
 for (var i = 0; i < lines.length; i++) {
 var l = lines[i];
 if (G.geoDistance(l.c, cc) >= Math.min(Math.PI / 2 + l.r, vr + l.r)) continue;
 any = true;
 for (k = 0; k < l.segs.length && k < nSegs; k++) { pathD.context(paths[k]); pathD(l.segs[k]); }
 }
 e = { paths: paths, any: any };
 cache[id] = e;
 return e;
 }
 // per-frame observability (the Spec-A budget caps as a code invariant — asserted by the oracle):
 // fills = clipped texture/tone fills (cap 14); lines = the Design-enumerated batched line passes
 // (river batches + double waterline + ice hairline + shelf dash — cap 12); extra = treatment-edge
 // strokes he spec'd but did not enumerate in the cap arithmetic (feathers, lake outline+lining).
 var PHYS_MAX_FILLS = 14, PHYS_MAX_LINES = 12;
 var physFrame = { fills: 0, lines: 0, extra: 0, linedLakes: 0, layers: {} };
 function physFrameReset() { physFrame = { fills: 0, lines: 0, extra: 0, linedLakes: 0, layers: {} }; }
 function pfFill(layer) { physFrame.fills++; physFrame.layers[layer] = true; }
 function pfLine(layer) { physFrame.lines++; physFrame.layers[layer] = true; }

 // -------- offscreen PLATE bake. The whole matte plate (ocean, land, relief, physical layers,
 // borders, coast, grain, form-shadow) is a pure function of (projection, pass alpha, rest-state,
 // physical epoch) — so at REST it renders ONCE into an offscreen canvas and every steady frame
 // composites it with a single drawImage (hover re-renders, fades, the perf gate). During motion
 // (drag/fly/inertia/auto-spin) the plate draws direct exactly as before — no behaviour change,
 // pixel-identical output. Physical-layer frame counters captured at bake replay on every
 // composite so the Spec-A invariant counts stay truthful per frame.
 var physTarget = null; // draw-target swap used by the plate bake (phys passes follow ctx swap)
 var plateBake = null, physEpoch = 0;
 function drawGlobeMattePlated(A) {
 var moving = dragging || flyRAF || inertiaRAF || autoOn;
 if (moving) { drawGlobeMatte(A); return; } // motion frames draw direct (bake would miss every frame)
 var r = projection.rotate();
 var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
 var key = r[0].toFixed(3) + ',' + r[1].toFixed(3) + ',' + projection.scale().toFixed(1) + ',' + pw + 'x' + ph + ',' + A.toFixed(2) + ',' + physEpoch + ',' + (physOn() ? physAlphaNow().toFixed(2) : 'off');
 if (!plateBake || plateBake.key !== key) {
 var cv = plateBake ? plateBake.cv : tileCanvas(pw, ph);
 if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
 var g = cv.getContext('2d');
 g.setTransform(dpr, 0, 0, dpr, 0, 0);
 g.clearRect(0, 0, W, H);
 var pre = { fills: physFrame.fills, lines: physFrame.lines, extra: physFrame.extra, layers: Object.keys(physFrame.layers) };
 var oc = ctx, op = path;
 ctx = g; path = G.geoPath(projection, g);
 try { drawGlobeMatte(A); } finally { ctx = oc; path = op; }
 plateBake = { cv: cv, key: key, counts: {
 fills: physFrame.fills - pre.fills, lines: physFrame.lines - pre.lines, extra: physFrame.extra - pre.extra,
 lined: physFrame.linedLakes,
 layers: Object.keys(physFrame.layers).filter(function (k) { return pre.layers.indexOf(k) < 0; }) } };
 } else { // cache hit — replay the logical physical pass counts for this frame
 var cnt = plateBake.counts;
 physFrame.fills += cnt.fills; physFrame.lines += cnt.lines; physFrame.extra += cnt.extra;
 if (cnt.lined) physFrame.linedLakes = cnt.lined;
 cnt.layers.forEach(function (k) { physFrame.layers[k] = true; });
 }
 ctx.drawImage(plateBake.cv, 0, 0, W, H);
 }
 // -------- draw passes. A = the pass alpha (globe o.world / flat underlay); rest = static-ink gate.
 // Climate fills + forest OUT-of-range — inside the land clip, BEFORE the ranges relief pass
 // (ink priority §0.4: desert/tundra → forest → relief hachure).
 function physClimateFills(A, dr, rest) {
 var c = physTarget || ctx;
 var rm = physRamps(), pA = A * physAlphaNow() * rm.cf;
 if (pA <= 0.01) return;
 var cache = physPaths(), reg = PHYS.reg[physRegKey()];
 // DESERT (A4): warm lift + feathered 2-stroke edge + 6px warm stipple (register-ramped alpha)
 var des = buildPolyPath(cache, 'deserts', PHYS.deserts);
 if (des.any) {
 var drD = physRect(des, dr);
 c.save(); c.clip(des.p);
 c.fillStyle = 'rgba(211,195,154,' + (0.22 * pA) + ')'; c.fillRect(drD[0], drD[1], drD[2], drD[3]); pfFill('desert');
 if (rest) { c.globalAlpha = (0.35 + 0.10 * rm.rN + 0.05 * rm.rS) * pA; c.fillStyle = DESERT_PAT; c.fillRect(drD[0], drD[1], drD[2], drD[3]); c.globalAlpha = 1; pfFill('desertStipple'); }
 c.restore();
 if (rest) { // two-step feather dissolves the generalized NE edge into the lowland — no blur (budget)
 c.lineWidth = 10; c.strokeStyle = 'rgba(211,195,154,' + (0.08 * pA) + ')'; c.stroke(des.p); physFrame.extra++;
 c.lineWidth = 5; c.strokeStyle = 'rgba(211,195,154,' + (0.10 * pA) + ')'; c.stroke(des.p); physFrame.extra++;
 }
 }
 // TUNDRA (A6): cool wash + sparse 8px cool stipple — cold-sparse vs hot-fine
 var tun = buildPolyPath(cache, 'tundra', PHYS.tundra);
 if (tun.any) {
 var drT = physRect(tun, dr);
 c.save(); c.clip(tun.p);
 c.fillStyle = 'rgba(207,211,196,' + (0.28 * pA) + ')'; c.fillRect(drT[0], drT[1], drT[2], drT[3]); pfFill('tundra');
 if (rest) { c.globalAlpha = 0.30 * pA; c.fillStyle = TUNDRA_PAT; c.fillRect(drT[0], drT[1], drT[2], drT[3]); c.globalAlpha = 1; pfFill('tundraStipple'); }
 c.restore();
 if (rest) {
 c.lineWidth = 10; c.strokeStyle = 'rgba(207,211,196,' + (0.08 * pA) + ')'; c.stroke(tun.p); physFrame.extra++;
 c.lineWidth = 5; c.strokeStyle = 'rgba(207,211,196,' + (0.10 * pA) + ')'; c.stroke(tun.p); physFrame.extra++;
 }
 }
 // FOREST out-of-range (A5): tint + 9px bosk
 var fo = buildPolyPath(cache, 'forestOut', reg.forest.out);
 if (fo.any) {
 var drF = physRect(fo, dr);
 c.save(); c.clip(fo.p);
 c.fillStyle = 'rgba(163,173,133,' + (0.35 * pA) + ')'; c.fillRect(drF[0], drF[1], drF[2], drF[3]); pfFill('forest');
 if (rest) { c.globalAlpha = 0.30 * pA; c.fillStyle = FOREST_PAT; c.fillRect(drF[0], drF[1], drF[2], drF[3]); c.globalAlpha = 1; pfFill('forestBosk'); }
 c.restore();
 }
 }
 // forest IN-range (bosk at HALF alpha — hachure owns the ink there) + land ice — AFTER the ranges
 // relief pass, still inside the land clip. Ice = palest tone + offset lee shadow, NO texture inside
 // (on an engraved plate, smooth = ice; §A0/A3). Ice covers hypsometry+hachure with its 0.92 fill.
 function physReliefOverlays(A, dr, rest, hasRelief) {
 var c = physTarget || ctx;
 var rm = physRamps(), pA = A * physAlphaNow() * rm.cf;
 if (pA <= 0.01) return;
 var cache = physPaths(), reg = PHYS.reg[physRegKey()];
 var fi = buildPolyPath(cache, 'forestIn', reg.forest.inR);
 if (fi.any) {
 // in-range bosk halves ONLY where relief hachure actually draws (the globe passes) — the rule's
 // premise is "hachure owns the ink there" (A5); the flat US-detail register draws no hachure,
 // so in-range forest keeps full treatment alphas there (most US-West forest is in-range).
 var tintA = (hasRelief ? 0.18 : 0.35) * pA, boskA = (hasRelief ? 0.15 : 0.30) * pA;
 var drI = physRect(fi, dr);
 c.save(); c.clip(fi.p);
 c.fillStyle = 'rgba(163,173,133,' + tintA + ')'; c.fillRect(drI[0], drI[1], drI[2], drI[3]); pfFill('forestInRange');
 if (rest) { c.globalAlpha = boskA; c.fillStyle = FOREST_PAT; c.fillRect(drI[0], drI[1], drI[2], drI[3]); c.globalAlpha = 1; pfFill('forestInBosk'); }
 c.restore();
 }
 var ice = buildPolyPath(cache, 'ice', reg.ice);
 if (ice.any) {
 var drC = physRect(ice, dr);
 c.save(); c.clip(ice.p);
 c.fillStyle = 'rgba(223,227,218,' + (0.92 * pA) + ')'; c.fillRect(drC[0], drC[1], drC[2], drC[3]); pfFill('ice');
 c.globalAlpha = 0.35 * pA; c.fillStyle = '#b8c4c2'; c.fillRect(drC[0] + 1.5, drC[1] + 2, drC[2], drC[3]); c.globalAlpha = 1; pfFill('iceShadow'); // offset lee shadow (down-right)
 c.restore();
 }
 }
 // ice hairline — cool grey-green ink, NOT blue — stroked outside the clip (reference order)
 function physIceInk(A) {
 var c = physTarget || ctx;
 var rm = physRamps(), pA = A * physAlphaNow() * rm.cf;
 if (pA <= 0.01) return;
 var cache = physPaths(), ice = buildPolyPath(cache, 'ice', PHYS.reg[physRegKey()].ice);
 if (!ice.any) return;
 c.lineWidth = 0.5; c.strokeStyle = 'rgba(143,163,161,' + (0.55 * pA) + ')'; c.stroke(ice.p); pfLine('iceInk');
 }
 // rivers (A1): batched engraved waterlines. W1 (sr≤2, w1.35) + W2 (sr3–5, w0.9) draw the 3-segment
 // taper (0.6/0.85/1.0×w, source→mouth); W3/W4 hairlines (w0.5) draw single-pass. One beginPath per
 // batch per segment — ≤8 strokes, + the state-register double waterline for W1 (translate trick).
 var RIVER_BATCHES = [
 { k: 'W1', w: 1.35, taper: true, ramp: null },
 { k: 'W2', w: 0.9, taper: true, ramp: null },
 { k: 'W3', w: 0.5, taper: false, ramp: 'rN' },
 { k: 'W4', w: 0.5, taper: false, ramp: 'rS' },
 ];
 var TAPER_K = [0.6, 0.85, 1.0];
 function physRivers(A) {
 var c = physTarget || ctx;
 var rm = physRamps(), pA = A * physAlphaNow() * rm.cf;
 if (pA <= 0.01) return;
 var cache = physPaths(), reg = PHYS.reg[physRegKey()];
 var aRiv = (0.6 + 0.15 * rm.rS) * pA;
 c.save(); c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = 'rgba(122,148,150,' + aRiv + ')';
 for (var bi = 0; bi < RIVER_BATCHES.length; bi++) {
 var B = RIVER_BATCHES[bi], lines = reg.rivers[B.k];
 if (!lines || !lines.length) continue;
 var ramp = B.ramp ? rm[B.ramp] : 1;
 if (ramp <= 0.02) continue;
 var built = buildRiverPaths(cache, 'riv' + B.k, lines, B.taper ? 3 : 1);
 if (!built.any) continue;
 if (B.ramp) c.strokeStyle = 'rgba(122,148,150,' + (aRiv * ramp) + ')';
 if (B.taper) {
 for (var si = 0; si < 3; si++) { c.lineWidth = B.w * TAPER_K[si]; c.stroke(built.paths[si]); pfLine('rivers'); }
 } else {
 c.lineWidth = B.w; c.stroke(built.paths[0]); pfLine('rivers');
 }
 if (B.k === 'W1') c.strokeStyle = 'rgba(122,148,150,' + aRiv + ')';
 }
 // double waterline — big-river emphasis, state register and deeper only, scalerank ≤2 only (A1)
 if (rm.rS > 0.05) {
 var w1 = buildRiverPaths(cache, 'rivW1', reg.rivers.W1 || [], 3);
 if (w1.any) {
 c.save(); c.translate(1.2, 1.2);
 c.lineWidth = 0.4; c.strokeStyle = 'rgba(122,148,150,' + (0.30 * rm.rS * pA) + ')';
 c.stroke(w1.paths[0]); c.stroke(w1.paths[1]); c.stroke(w1.paths[2]);
 c.restore(); pfLine('riverDouble');
 }
 }
 c.restore();
 }
 // lakes (A2): matte fill + ink ring + interior shore-lining (screen-area-gated) + great-lakes
 // ocean-tooth stipple. Drawn AFTER rivers so no river draws through a lake fill (QC probe).
 function physLakes(A, rest) {
 var c = physTarget || ctx;
 var rm = physRamps(), pA = A * physAlphaNow() * rm.cf;
 if (pA <= 0.01) return;
 var cache = physPaths(), reg = PHYS.reg[physRegKey()];
 var all = buildPolyPath(cache, 'lakes', reg.lakes);
 if (!all.any) return;
 c.fillStyle = 'rgba(92,125,132,' + (0.9 * pA) + ')'; c.fill(all.p); pfFill('lakes');
 c.lineWidth = 0.5; c.strokeStyle = 'rgba(63,58,44,' + (0.5 * pA) + ')'; c.stroke(all.p); physFrame.extra++;
 if (rest) {
 // shore lining: only lakes with projected screen area > 180 px² (lining a 6px lake = smudge).
 // screenPx² ≈ areaDeg² (cos-lat-corrected at bake) × (scale·π/180)²
 var k2 = Math.pow(projection.scale() * 0.017453, 2), lined = [], gl = [];
 var cc = centerCoord(), vr = viewAng();
 for (var i = 0; i < reg.lakes.length; i++) {
 var m = reg.lakes[i];
 if (G.geoDistance(m.c, cc) >= Math.min(Math.PI / 2 + m.r, vr + m.r)) continue;
 if (m.a * k2 > 180) lined.push(m);
 if (m.gl) gl.push(m);
 }
 physFrame.linedLakes = lined.length;
 if (lined.length) {
 var lp = cache.lakesLined || (function () { var p2 = new Path2D(); pathD.context(p2); lined.forEach(function (m) { pathD(m.geo); }); return (cache.lakesLined = { p: p2 }); })();
 c.save(); c.clip(lp.p); // clip keeps the inner half of each stroke = concentric shore lines
 c.lineWidth = 3; c.strokeStyle = 'rgba(169,182,172,' + (0.10 * pA) + ')'; c.stroke(lp.p); physFrame.extra++;
 c.lineWidth = 1.6; c.strokeStyle = 'rgba(169,182,172,' + (0.14 * pA) + ')'; c.stroke(lp.p); physFrame.extra++;
 if (gl.length) { // great-lakes class: ocean paper-tooth inside — big water reads as water
 var gp = cache.lakesGL || (function () { var p2 = new Path2D(); pathD.context(p2); gl.forEach(function (m) { pathD(m.geo); }); return (cache.lakesGL = { p: p2 }); })();
 var drG = physRect(all, [0, 0, W, H]);
 c.save(); c.clip(gp.p);
 c.globalAlpha = 0.15 * pA; c.fillStyle = STIPPLE_PAT; c.fillRect(drG[0], drG[1], drG[2], drG[3]); c.globalAlpha = 1;
 c.restore(); pfFill('greatLakesStipple');
 }
 c.restore();
 }
 }
 }
 // Antarctic ice shelves (A3): floating ice over ocean — a step cooler than land ice, DASHED seaward
 // edge (the classic atlas convention: the dash difference tells the reader "this edge floats").
 function physShelves(A) {
 var c = physTarget || ctx;
 var rm = physRamps(), pA = A * physAlphaNow() * rm.cf;
 if (pA <= 0.01) return;
 var cache = physPaths(), sh = buildPolyPath(cache, 'shelves', PHYS.shelves);
 if (!sh.any) return;
 c.fillStyle = 'rgba(213,220,216,' + (0.85 * pA) + ')'; c.fill(sh.p); pfFill('shelf');
 c.save(); c.setLineDash([2.2, 2]); c.lineWidth = 0.7; c.strokeStyle = 'rgba(111,139,140,' + (0.6 * pA) + ')'; c.stroke(sh.p); c.setLineDash([]); c.restore(); pfLine('shelfDash');
 }
 // flat-register pass (state/county zoom — the globe has handed off to the US-detail underlay).
 // Caller has us CLIPPED to the visible-states path, so physical tone never floats on the page
 // outside the drawn underlay. Same treatments, same cache, underlay alpha.
 function physFlat(underA, rest) {
 var dr = [0, 0, W, H];
 physClimateFills(underA, dr, rest);
 physReliefOverlays(underA, dr, rest, false);
 physIceInk(underA);
 physRivers(underA);
 physLakes(underA, rest);
 }
 // ================== end physical geography ==================

 // fit scale so a feature's angular radius fills ~fillFrac of the disc. Antimeridian-safe: a
 // ±180°-crossing feature (Aleutians West) reports WRAPPED geoBounds (east < west) — sweeping the
 // raw corners then measures the wrong way round the globe and returns a near-hemisphere radius
 // (the county framed at WORLD scale). Unwrap first; identical for every non-crossing feature.
 function angRadius(feat, center) {
 var d = bboxDeg(G.geoBounds(feat)); // {w,e,s,n} with e ≥ w
 var corners = [[normLon(d.w), d.s], [normLon(d.e), d.s], [normLon(d.w), d.n], [normLon(d.e), d.n],
 [normLon((d.w + d.e) / 2), d.s], [normLon((d.w + d.e) / 2), d.n]];
 var m = 0; for (var i = 0; i < corners.length; i++) m = Math.max(m, G.geoDistance(center, corners[i]));
 return m;
 }
 // fit scale from an explicit lon/lat bbox around a chosen center — reliable regardless of ring
 // winding (the local boundary polygons are wound for screen fill, which breaks spherical geoBounds).
 function angRadiusBBox(bbox, center) {
 var corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]],
 [(bbox[0] + bbox[2]) / 2, bbox[1]], [(bbox[0] + bbox[2]) / 2, bbox[3]]];
 var m = 0; for (var i = 0; i < corners.length; i++) m = Math.max(m, G.geoDistance(center, corners[i]));
 return m;
 }
 var fitScales = {}; // per level scale, computed on resize
 function computeFits() {
 var P = Math.min(W, H) * 0.42;
 function fit(feat, center, fill) { var A = angRadius(feat, center); A = Math.max(A, 0.0008); return (P * (fill || 1)) / Math.sin(Math.min(A, Math.PI / 2)); }
 function fitBox(bbox, center, fill) { var A = Math.max(angRadiusBBox(bbox, center), 0.0004); return (P * fill) / Math.sin(Math.min(A, Math.PI / 2)); }
 // contiguous US only — the us-atlas nation feature includes Alaska/Hawaii/Pacific territories,
 // whose span is nearly a hemisphere and would make "nation" fit *smaller* than the whole world.
 fitScales.nation = fitBox([-124.7, 24.5, -66.9, 49.4], [-96, 39.5], 0.9);
 DRILL_KEYS.forEach(function (k) {
 var d = DRILLS[k];
 d.cState = G.geoCentroid(d.stateFeature);
 d.cRegion = G.geoCentroid(d.regionFeature);
 d.sState = fit(d.stateFeature, d.cState, 0.82);
 d.sRegion = fit(d.regionFeature, d.cRegion, 0.52); // wider — shows the county/city in its region context
 d.sLocal = fitBox(d.bbox, d.center, 0.82); // from baked drill metadata bbox (winding-safe)
 });
 }

 function fit() {
 // W tracks the CANVAS box, not the raw viewport: in the docked-split band (721–1120px, feed open)
 // #stage reflows to the left remainder via CSS, so #stage.clientWidth < window.innerWidth. Sizing
 // the backing store + projection off the stage box makes the map re-frame into the visible column
 // (no squish, no occlusion) everywhere the canvas is used (matte texture, [W/2,H/2] centre, fits).
 W = (stage && stage.clientWidth) ? stage.clientWidth : window.innerWidth;
 H = window.innerHeight;
 dpr = Math.min(window.devicePixelRatio || 1, 2);
 canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
 ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
 var prevBase = baseScale;
 baseScale = Math.min(W, H) * 0.42;
 minScale = baseScale * 0.72;
 fitVer++; // invalidate cached per-region fits (they depend on W/H)
 computeFits();
 var target;
 if (firstFit) { target = baseScale; firstFit = false; }
 else { var r = prevBase > 0 ? projection.scale() / prevBase : 1; target = clamp(baseScale * r, minScale, maxScale()); }
 projection.scale(target).translate([W / 2, H / 2]);
 render();
 }

 // deepest allowed scale. Generic (no scripted drill) must reach county + city depth — the frame-not-fill
 // journey drills nation→state→county→city anywhere, so the ceiling is raised well past the old 8.5×.
 function maxScale() {
 var ad = activeDrill();
 var m = baseScale * 160;
 if (ad) m = Math.max(m, ad.sLocal * 1.55);
 // Phase 4: the street register's tier-3 depth is FIT-RELATIVE (2.6× the city-entry scale =
 // county-fit×~7) — tiny-county cities (VA independents, Baltimore…) would otherwise cap out
 // before their own street mesh resolves. The ceiling follows the committed county.
 var co = containerCounty();
 if (co) m = Math.max(m, countyFitOf(co) * 7.8);
 // at the city register the ceiling tracks the CITY's own entry (tier 3 = 2.6× entry must be
 // reachable for a small-bbox city whose fit far exceeds its county-derived band)
 if (NAV.level === 4 && NAV.cityId && cityById[NAV.cityId]) m = Math.max(m, cityEntryScale(cityById[NAV.cityId]) * 2.9);
 return m;
 }
 // fit scale to frame a single feature — clamped to the current zoom range (now deep enough for cities)
 function fitFeature(feat, center, fill) {
 var P = Math.min(W, H) * 0.42, A = Math.max(angRadius(feat, center), 0.0008);
 return clamp((P * (fill || 1)) / Math.sin(Math.min(A, Math.PI / 2)), minScale, maxScale());
 }
 function fitBoxFeature(bbox, center, fill) { // clamped fit from an explicit lon/lat bbox (winding-safe)
 var P = Math.min(W, H) * 0.42, A = Math.max(angRadiusBBox(bbox, center), 0.0004);
 return clamp((P * (fill || 1)) / Math.sin(Math.min(A, Math.PI / 2)), minScale, maxScale());
 }

 // (round2 A) planar ring area (shoelace on the outer ring) — a cheap proxy to pick the LARGEST
 // contiguous polygon of a multi-part country, so we frame the mainland, not the total span.
 function ringArea(ring) { var a = 0; for (var i = 0, n = ring.length, j = n - 1; i < n; j = i++) { a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]; } return Math.abs(a / 2); }
 function principalLandmass(feat) {
 var g = feat.geometry; if (!g) return feat;
 if (g.type === 'Polygon') return feat;
 if (g.type === 'MultiPolygon') {
 var best = null, bestA = -1;
 for (var i = 0; i < g.coordinates.length; i++) {
 var poly = g.coordinates[i], a = ringArea(poly[0]);
 if (a > bestA) { bestA = a; best = poly; }
 }
 if (best) return { type: 'Feature', properties: feat.properties, geometry: { type: 'Polygon', coordinates: best } };
 }
 return feat;
 }
 // (round2 A) frame a clicked country by its PRINCIPAL CONTIGUOUS landmass — never by its total
 // multi-part bounds. The US would otherwise span Alaska→Hawaii→Pacific ≈ a hemisphere and fit
 // *smaller* than the whole world (Timn's "click America zooms OUT"); reuse the CONUS box instead.
 function frameCountry(f, nm) {
 if (/United States/i.test(nm)) return { center: [-96, 39.5], scale: fitBoxFeature([-124.7, 24.5, -66.9, 49.4], [-96, 39.5], 0.9) };
 var main = principalLandmass(f), c = G.geoCentroid(main);
 return { center: c, scale: fitFeature(main, c, 0.86) };
 }

 // ---------- LOD state ----------
 function centerCoord() { var r = projection.rotate(); return [-r[0], -r[1]]; }
 function zoomRatio() { return projection.scale() / baseScale; }
 // which drill (if any) the current view is drilling into. Sticky to the user's chosen path
 // (currentDrillKey, set by the guided fly/jump) with hysteresis, so a mid-US framing during a
 // San Diego drill keeps highlighting California even though Virginia Beach's pin is geometrically
 // a touch closer to the country's centre. Free-zoom into the other region still switches over.
 function activeDrill() {
 if (zoomRatio() < 1.7) return null;
 var c = centerCoord(), best = null, bd = 0.7;
 DRILL_KEYS.forEach(function (k) {
 var d = DRILLS[k], dist = G.geoDistance(c, d.center);
 if (dist < bd) { bd = dist; best = d; }
 });
 if (!best) return null;
 var cur = DRILLS[currentDrillKey], curD = cur ? G.geoDistance(c, cur.center) : 9;
 if (cur && curD < 0.7 && curD < bd + 0.16) { currentDrillKey = cur.key; return cur; }
 currentDrillKey = best.key; return best;
 }
 // alpha of each layer at the current scale (continuous, so free-zoom reveals them too)
 function lod() {
 var s = projection.scale(), ad = activeDrill();
 var o = { world: 1, us: 0, county: 0, local: 0, usGrid: 0, allCounty: 0, cities: 0, drill: ad };
 var sN = fitScales.nation || baseScale * 2.2;
 // generic, DRILL-INDEPENDENT US-detail layers (all states + all counties + cities). Keyed to the
 // generic CONUS-fit references so full detail shows identically in every state — a scripted drill no
 // longer skews the county/city LOD (that caused cities to nearly vanish near SD/VB).
 var sStateRef = sN * 2.6, sRegionRef = sN * 6.5, sLocalRef = sN * 45;
 o.usGrid = band(s, sN * 1.02, sStateRef * 0.72);
 // county hairline mesh lives in the nation→state band; by county zoom the focus-county rim + cities
 // carry the read, so fade the full mesh OUT (also saves the frame).
 o.allCounty = band(s, sStateRef * 0.5, sStateRef * 0.92) * (1 - band(s, sRegionRef * 0.62, sRegionRef * 1.0));
 o.cities = band(s, sStateRef * 0.5, sStateRef * 1.6) * (1 - band(s, sLocalRef * 0.9, sLocalRef * 1.4));
 if (!ad) {
 // generic (no scripted drill): when engaged with the US, hand the globe OFF to the flat US detail
 // by state zoom (drawUSDetail draws a cheap land underlay) — this is the key state/county budget win.
 // NOT engaged → SPHERE FLOOR (F1 rule 2): the matte globe IS the ground register at every zoom
 // (mid-ocean, foreign land) — it never fades to bare page when nothing takes over.
 if (usEngaged()) o.world = 1 - band(s, sN * 1.15, sN * 2.2);
 else o.world = 1;
 return o;
 }
 var sS = ad.sState, sR = ad.sRegion, sL = ad.sLocal;
 // edit #6b/#7: the round topographic/Blue-Marble globe stays DOMINANT through the whole NATION
 // level — the flat US grid map only takes over as you pass into STATE zoom. So the world→US
 // crossover is pushed out from ~sN to the sN→sS band (nation stays a globe; state is the handoff).
 o.world = 1 - band(s, sN * 1.05, sS * 0.78);
 o.us = band(s, sN * 1.02, sS * 0.72) * (1 - band(s, sR * 0.7, sR * 1.02));
 o.county = band(s, sS * 0.78, sS * 1.05) * (1 - band(s, sL * 0.58, sL * 0.86));
 o.local = band(s, sL * 0.56, sL * 0.82);
 // PERF: activeDrill() claims most of CONUS (its 0.7-rad radius), so this drill branch runs at almost
 // every US zoom and its gentle globe fade kept the matte sphere drawing at ~0.23α through STATE zoom
 // (~6ms of hidden globe cost). Force the same generic hand-off used when no drill is active: the globe
 // is fully OFF by state zoom (drawUSDetail's land underlay takes over). Nation still keeps its globe.
 if (usEngaged()) { var wf = 1 - band(s, sN * 1.15, sN * 2.2); if (wf < o.world) o.world = wf; }
 else { o.world = 1; o.us = 0; o.county = 0; o.local = 0; } // F1 sphere floor: an un-engaged drill-lane
 // deep zoom (far offshore / across the border) keeps the sphere as ground — the flat layers and the
 // curated exemplar plate belong to an ENGAGED register, never to floating void.
 return o;
 }
 function ambient() { return Math.max(0.1, 1 - band(projection.scale(), baseScale * 1.7, baseScale * 4.2)); }

 // ---------- frame-not-fill: which layer is the interactive child at the current depth ----------
 function usUnderCenter() { return G.geoContains(usNation, centerCoord()); }
 // ---------- F1 ground-floor invariant (Design sign-off finding 1, 2026-07-17) ----------
 // A free-zoom centre over ocean/large water used to resolve NAV level 0/1 with no flat register
 // engaged — past the world band the sphere had faded out and the page went to bare void with
 // floating type (Design g1/h2/h3 evidence). Two rules restore the floor:
 // 1. NEAREST-LAND FALLBACK (here): an off-soil centre resolves to the nearest county's land
 // context (bounding-circle distance, two-stage state→county scan) whenever US land is near
 // the viewport — the flat register + Spec-B mask grammar persist over coastal water, sounds
 // and the Great Lakes exactly as over land.
 // 2. SPHERE FLOOR (lod()): the world matte never fades out unless the flat US register has
 // actually engaged — mid-ocean / foreign-land deep zoom keeps the engraved sphere as the
 // honest ground. At any zoom, a ground register always draws. The map NEVER goes to bare page.
 var waterCtxStamp = -1, waterCtxVal = null;
 function landSlack() { return viewAng() * 1.15 + 0.02; } // "US land near the viewport" criterion
 function featBoundRad(f) { return f.__wr != null ? f.__wr : (f.__wr = angRadius(f, f.__c || (f.__c = G.geoCentroid(f)))); }
 function nearestLandCounty(geo) {
 var slack = landSlack(), bestCo = null, bestD = Infinity;
 for (var si = 0; si < usStates.length; si++) {
 var st = usStates[si];
 if (G.geoDistance(geo, st.__c) - featBoundRad(st) > slack) continue; // state bounding circle too far — skip its counties
 var list = countiesByStateFips[String(st.id)] || [];
 for (var ki = 0; ki < list.length; ki++) {
 var co = list[ki];
 var d = G.geoDistance(geo, co.__c) - featBoundRad(co);
 if (d < bestD) { bestD = d; bestCo = co; }
 }
 }
 return bestD < slack ? bestCo : null;
 }
 function waterLandCtx() { // per-frame cached: the nearest-land county for an over-WATER centre (or null)
 if (waterCtxStamp === frameStamp) return waterCtxVal;
 waterCtxStamp = frameStamp;
 waterCtxVal = null;
 if (zoomRatio() > 1.55 && !usUnderCenter()) {
 var geo = centerCoord();
 // FOREIGN LAND is not water: over Mexico/Canada the honest ground is the sphere itself
 // (its terrain is the register) — the US fallback applies to ocean/sound/lake centres only.
 var ch = countryHit(geo);
 if (!ch || /United States/i.test(ch.country.properties.name)) waterCtxVal = nearestLandCounty(geo);
 }
 return waterCtxVal;
 }
 // US is "engaged" (draw its detail + suppress world-country flood over it) when we've entered it via
 // NAV, or free-zoomed into US soil past the nation band — or into US COASTAL WATER with land in
 // view (F1 rule 1: the register machine never abandons the ground at the water's edge).
 function usEngaged() { return NAV.level >= 1 || (zoomRatio() > 1.55 && (usUnderCenter() || !!waterLandCtx())); }
 function genFits() { var sN = fitScales.nation || baseScale * 2.2; return { sN: sN, sState: sN * 2.6, sRegion: sN * 6.5, sLocal: sN * 45 }; }
 // FIT-RELATIVE depth. A region's "own fit" (raw, unclamped) is the yardstick for whether you're inside
 // it — so tiny states (RI, DC), giant ones (TX, AK), and offshore Hawaii all work by the SAME rule
 // instead of a CONUS-calibrated global scale band. Fits are cached per resize (fitVer).
 var fitVer = 0;
 function fitRaw(feat, center, fill) { var P = Math.min(W, H) * 0.42, A = Math.max(angRadius(feat, center), 0.0004); return (P * (fill || 1)) / Math.sin(Math.min(A, Math.PI / 2)); }
 function stateFitOf(st) { if (st.__fitV !== fitVer) { st.__fit = fitRaw(st, st.__a || st.__c, 0.82); st.__fitV = fitVer; } return st.__fit; }
 function countyAnchor(co) { return co.__a || (co.__a = interiorPoint(co)); }
 function countyFitOf(co) { if (co.__fitV !== fitVer) { co.__fit = fitRaw(co, countyAnchor(co), 0.6); co.__fitV = fitVer; } return co.__fit; }
 // The ONE interactive layer at the current depth (UX §1.5) — derived from NAV.level so hit-testing,
 // rendering, and the container all agree.
 function childLayer() { if (NAV.level <= 0) return 'countries'; if (NAV.level === 1) return 'states'; if (NAV.level === 2) return 'counties'; return 'cities'; }
 function containerCounty() { return NAV.countyFips ? countyById[NAV.countyFips] : null; }
 function containerState() { return NAV.stateFips ? stateByFips(NAV.stateFips) : null; }

 // ---------- skin ----------
 // MATTE ATLAS ONLY (Timn lock 2026-07-16). The mockup's Signal/Turning/Orbit renderers stay behind
 // in the mockup; SKIN is a constant so shared LOD/hint code reads unchanged.
 var SKIN = 'globe';

 function visiblePt(coord, slack) { return G.geoDistance(coord, centerCoord()) < Math.PI / 2 - (slack || 0.008); }
 function nearSide(c, slack) { return G.geoDistance(c, centerCoord()) < Math.PI / 2 + (slack || 0.35); }

 // frameInfo kept for QC-hook surface parity (no Signal skin — always zeros)
 var frameInfo = { signalArcs: 0, signalGraticule: false };

 // Matte Atlas (Phase 2 — Design "printed-plate" spec §2): an engraved-atlas plate, not a glossy
 // ball. Geographic TONE (ocean/land/relief colour) is projected and moves with the globe; INK
 // TEXTURE (paper grain, ocean stipple, relief hachure) is screen-fixed — it belongs to the paper,
 // not the geography. Centered matte ocean (no off-axis gloss), hypsometric land, hachured relief,
 // dashed every-nation borders, multi-pass engraved coast, centered matte form-shadow (no highlight).
 // PERF: the screen-fixed tooth (grain/stipple/hatch/water-lining) is the added cost of this pass. It
 // only reads at rest, in the world/nation register — so it's gated OFF during any active motion
 // (drag/fly/inertia/auto-spin) and faded OUT as the sphere hands off to the flat map (texA). This
 // holds the < 24 ms budget AND resolves Design's flag-#1 drag-crawl (the tooth freezes to rest).
 function drawGlobeMatte(A) {
 var s = projection.scale(), cx = W / 2, cy = H / 2;
 ensurePatterns();
 var dr = [cx - s, cy - s, s * 2, s * 2]; // disc bbox — cheaper fillRect extent than the whole canvas
 // Screen-fixed ink (grain/stipple/hatch/water-lining) is the hero at the WORLD overview and its
 // cost (full-disc overlay + pattern fills) is the frame's dominant added term. It's tapered to the
 // world register — full at overview, faded before nation — so nation/state hold budget while the
 // atlas plate still reads on the money shot. texA also fades it as world hands off to the flat map.
 var zr = s / baseScale;
 var texA = clamp(band(A, 0.30, 0.62), 0, 1) * (1 - band(zr, 1.35, 1.85));
 var moving = dragging || flyRAF || inertiaRAF || autoOn;
 var heavyTex = texA > 0.03 && !moving; // screen-fixed ink at REST, world register only (perf + no crawl)
 // PERF LOD: past the nation register the whole-world detail passes (other-nation borders, rivers,
 // the coastline halo double-stroke) stop earning their cost — the US linework (drawUSMatte / US
 // detail) carries the read. Gating them off here is the single biggest nation-zoom budget win.
 var zi = zr > 1.9;

 // 2.1 Ocean — matte, CENTERED limb-darkening (kills the plastic hot-spot)
 ctx.beginPath(); path(sphere);
 var og = ctx.createRadialGradient(cx, cy, s * 0.18, cx, cy, s * 1.0);
 og.addColorStop(0, 'rgba(111,139,140,' + A + ')'); // #6f8b8c ocean base
 og.addColorStop(0.72, 'rgba(91,122,126,' + A + ')'); // #5b7a7e mid
 og.addColorStop(1, 'rgba(57,82,90,' + A + ')'); // #39525a abyss (limb)
 ctx.fillStyle = og; ctx.fill();
 // (PERF TRADE) The ocean paper-tooth stipple pass (§2.1 spec) is folded — a full-disc pattern fill
 // that read as near-invisible over the flat matte ocean. The whole-plate paper grain (2.7) carries
 // the plate tooth. STIPPLE_TILE/_PAT stay baked (QC + the ocean-abyss ink reads without it).

 // 2.2 Water-lining vignette — offset coast strokes over ocean (drawn before the land fill so they
 // survive only offshore, reading as engraved bathymetric contours parallel to shore).
 if (heavyTex) {
 // single soft offshore lining pass (spec's 3 → 1) — path(land) is a huge path, so each full-land
 // stroke is a real cost; one wide low-alpha stroke reads as the engraved offshore contour.
 ctx.beginPath(); path(land); ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(169,182,172,' + (0.07 * A * texA) + ')'; ctx.stroke();
 }

 // 2.3 LAND — hypsometric, clipped to the land silhouette
 ctx.save(); ctx.beginPath(); path(land); ctx.clip();
 ctx.fillStyle = 'rgba(185,190,147,' + A + ')'; ctx.fillRect(dr[0], dr[1], dr[2], dr[3]); // #b9be93 lowland base
 // coastal lowland lightening — paler toward the rim (coast reads paler)
 var cg = ctx.createRadialGradient(cx - s * 0.05, cy - s * 0.05, s * 0.15, cx, cy, s * 1.05);
 cg.addColorStop(0, 'rgba(201,203,162,0)'); cg.addColorStop(1, 'rgba(201,203,162,' + (0.40 * A) + ')'); // #c9cba2
 ctx.fillStyle = cg; ctx.fillRect(dr[0], dr[1], dr[2], dr[3]);
 // faint interior warmth so vast lowlands aren't dead-flat
 var hg = ctx.createRadialGradient(cx - s * 0.28, cy - s * 0.30, s * 0.08, cx, cy, s * 0.95);
 hg.addColorStop(0, 'rgba(194,171,126,' + (0.22 * A) + ')'); hg.addColorStop(1, 'rgba(194,171,126,0)'); // #c2ab7e
 ctx.fillStyle = hg; ctx.fillRect(dr[0], dr[1], dr[2], dr[3]);
 // (Phase 2 physical) climate treatments BEFORE relief — ink priority hachure > bosk > stipple (§0.4)
 if (physOn()) physClimateFills(A, dr, !moving);
 // mountain relief — flat upland + directional relief-shadow offset + engraved hachure + ridge line
 // (replaces the old per-massif "bruise" radial gradients).
 for (var ri = 0; ri < ranges.length; ri++) {
 var rg = ranges[ri]; if (!nearSide(rg.__c, 0.35)) continue;
 ctx.save(); ctx.beginPath(); path(rg); ctx.clip();
 ctx.fillStyle = 'rgba(194,171,126,' + A + ')'; ctx.fillRect(dr[0], dr[1], dr[2], dr[3]); // #c2ab7e upland base
 ctx.globalAlpha = 0.5 * A; ctx.fillStyle = 'rgba(177,143,99,1)'; ctx.fillRect(dr[0] + 2.5, dr[1] + 3, dr[2], dr[3]); // #b18f63 directional relief shadow (down-right)
 if (heavyTex) { ctx.globalAlpha = 0.42 * A * texA; ctx.fillStyle = HATCH_PAT; ctx.fillRect(dr[0], dr[1], dr[2], dr[3]); } // engraved hachure
 ctx.globalAlpha = 1; ctx.restore();
 ctx.beginPath(); path(rg); ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(107,90,60,' + (0.55 * A) + ')'; ctx.stroke(); // #6b5a3c ridge outline
 }
 // (Phase 2 physical) forest-in-range (half-alpha bosk over hachure) + land ice AFTER relief (§A3/A5)
 if (physOn()) physReliefOverlays(A, dr, !moving, true);
 // lakes (inside land clip so their shores read against terrain) — superseded by the NE-10m
 // physical lakes pass once the physical pack is live (honest base until it arrives)
 if (!physOn()) for (var li = 0; li < lakes.length; li++) { var lk = lakes[li]; if (!nearSide(lk.__c, 0.4)) continue; ctx.beginPath(); path(lk); ctx.fillStyle = 'rgba(92,125,132,' + A + ')'; ctx.fill(); ctx.strokeStyle = 'rgba(63,58,44,' + (0.5 * A) + ')'; ctx.lineWidth = 0.5; ctx.stroke(); } // #5c7d84 / #3f3a2c
 ctx.restore(); // unclip land

 // 2.4 Rivers — over land. Base terrain rivers until the physical pack lands; then the engraved
 // class-weighted NE-10m waterlines (batched taper strokes) + lakes + Antarctic shelves (Spec A).
 if (!physOn() && !zi) for (var vi = 0; vi < rivers.length; vi++) { if (!nearSide(G.geoCentroid(rivers[vi]), 0.5)) continue; ctx.beginPath(); path(rivers[vi]); ctx.strokeStyle = 'rgba(122,148,150,' + (0.6 * A) + ')'; ctx.lineWidth = 0.7; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); } // #7a9496
 if (physOn()) { physIceInk(A); physRivers(A); physLakes(A, !moving); physShelves(A); }

 // 2.5 Political borders — every nation (the density that sells "atlas"). Fine dashed engraved ink,
 // ramping toward solid + darker as you zoom past nation (§2.5). One mesh stroke. Skipped once
 // zoomed into the US (drawUSMatte carries the state linework) — a full-world mesh stroke is costly.
 if (A > 0.18 && !zi) {
 var solidify = band(s, baseScale * 2, baseScale * 4);
 ctx.save(); ctx.lineWidth = 0.7;
 ctx.strokeStyle = 'rgba(92,83,64,' + ((0.55 + 0.25 * solidify) * A) + ')'; // #5c5340
 if (solidify < 0.98) ctx.setLineDash([1.6 + 1.4 * solidify, Math.max(0.001, 2.4 * (1 - solidify))]);
 ctx.beginPath(); path(countriesMesh); ctx.stroke();
 ctx.setLineDash([]); ctx.restore();
 }

 // 2.6 Coastline — engraved. Crisp coast always; the halo + double-strike are world/nation flourishes
 // (each full-land stroke is a real cost — the halo is dropped once zoomed into the US).
 if (!zi) { ctx.beginPath(); path(land); ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(107,102,80,' + (0.35 * A) + ')'; ctx.stroke(); } // #6b6650 plate-impression halo
 ctx.beginPath(); path(land); ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(63,58,44,' + (0.90 * A) + ')'; ctx.stroke(); // #3f3a2c crisp coast
 if (heavyTex) { ctx.save(); ctx.translate(0.5, 0.4); ctx.beginPath(); path(land); ctx.lineWidth = 0.5; ctx.strokeStyle = 'rgba(107,102,80,' + (0.25 * A * texA) + ')'; ctx.stroke(); ctx.restore(); } // double-strike

 // US internal linework on the sphere (§3.1) — after the coast, before grain/pins
 drawUSMatte(A);

 // 2.7 Paper grain — engraved contrast tooth (screen-fixed, 'overlay' = no colour shift). Clipped to
 // LAND, not the whole disc: the 'overlay' composite is the frame's single most expensive op, and the
 // tooth reads on the engraved land (over the flat matte ocean it's near-invisible anyway). Clipping
 // to land shrinks the blended area to roughly a third of the disc — the biggest budget win here.
 if (heavyTex) {
 ctx.save(); ctx.beginPath(); path(land); ctx.clip();
 ctx.globalAlpha = 0.08 * texA; ctx.globalCompositeOperation = 'overlay';
 ctx.fillStyle = GRAIN_PAT; ctx.fillRect(dr[0], dr[1], dr[2], dr[3]);
 ctx.restore(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
 }

 // 2.8 Matte form-shadow (roundness without gloss) — CENTERED, NO highlight term. Limb-darkening
 // alone gives the round read; this single change removes the "plastic" look.
 ctx.beginPath(); path(sphere);
 var fg = ctx.createRadialGradient(cx, cy, s * 0.55, cx, cy, s);
 fg.addColorStop(0, 'rgba(0,0,0,0)'); fg.addColorStop(0.72, 'rgba(0,0,0,0)');
 fg.addColorStop(0.9, 'rgba(28,20,8,' + (0.30 * A) + ')'); fg.addColorStop(1, 'rgba(28,20,8,' + (0.55 * A) + ')'); // #1c1408
 ctx.fillStyle = fg; ctx.fill();
 }

 // (Phase 2 §3.1) US internal linework drawn ON the matte sphere — state borders fade in through
 // nation, county hairlines only once deeper. Warm atlas ink so the sphere→flat hand-off is seamless.
 function drawUSMatte(A) {
 var s = projection.scale();
 var usInView = G.geoDistance(centerCoord(), [-96, 39.5]) < 0.9;
 if (!usInView || s < baseScale * 1.6) return;
 var aUS = band(s, baseScale * 1.6, baseScale * 2.4) * A;
 if (aUS < 0.01) return;
 ctx.save();
 ctx.beginPath(); path(usStatesMesh); ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(92,83,64,' + (0.55 * aUS) + ')'; ctx.stroke(); // #5c5340 state borders
 var aCty = band(s, baseScale * 3.0, baseScale * 4.2) * A;
 if (aCty > 0.01) {
 ctx.beginPath();
 for (var si = 0; si < usStates.length; si++) { var st = usStates[si]; if (!nearSide(st.__c, 0.25)) continue; var cm = countyMeshByState[String(st.id)]; if (cm) path(cm); }
 ctx.lineWidth = 0.4; ctx.strokeStyle = 'rgba(107,102,80,' + (0.30 * aCty) + ')'; ctx.stroke(); // #6b6650 county hairlines
 }
 ctx.restore();
 }

 // (Phase 2 §4) two-tier warm-glow highlight: a clay fill + a clipped 'soft-light' warm lift (region
 // glows warm from within while its texture still reads) + a shadowBlur glow stroke. Static (no pulse).
 function softGlowRegion(feat, fillA, softA, strokeW, blur, selected) {
 ctx.save();
 ctx.beginPath(); path(feat); ctx.fillStyle = 'rgba(230,160,138,' + fillA + ')'; ctx.fill();
 ctx.save(); ctx.beginPath(); path(feat); ctx.clip();
 ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = 'rgba(255,220,196,' + softA + ')'; ctx.fillRect(0, 0, W, H);
 ctx.restore();
 ctx.lineJoin = 'round';
 if (selected) { ctx.beginPath(); path(feat); ctx.lineWidth = 3.0; ctx.strokeStyle = 'rgba(230,160,138,0.35)'; ctx.stroke(); } // outer glow ring
 ctx.beginPath(); path(feat);
 ctx.lineWidth = selected ? 1.4 : strokeW;
 ctx.strokeStyle = selected ? '#f0c9a8' : '#e6a08a';
 ctx.shadowColor = 'rgba(230,160,138,0.9)'; ctx.shadowBlur = blur; ctx.stroke(); ctx.shadowBlur = 0;
 ctx.restore();
 }
 // container centroid labels (nation / state / county) reserve their bbox each frame so the city-label
 // greedy declutter (drawCities) can dodge them — e.g. "Fresno" no longer overprints "FRESNO COUNTY" on a
 // searched-city fly-in (Design M1 / §4.4). Reset at the top of every render().
 var centroidLabelRects = [];
 // serif place label + clay underline rule (selected nation / state), Design §4.2
 function selectedLabel(text, x, y, noRule) {
 ctx.save(); ctx.font = "700 13px Georgia,serif"; ctx.textAlign = 'center';
 ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(12,13,16,0.75)'; ctx.lineWidth = 3.5;
 ctx.fillStyle = '#f4f1e8'; ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
 var clw = ctx.measureText(text).width; // record this label's screen bbox for city-label collision
 var rect = [x - clw / 2 - 2, y - 13, x + clw / 2 + 2, y + 4];
 centroidLabelRects.push(rect);
 if (!noRule) { // clay underline rule (state/nation) — counties stay calmer (no rule)
 ctx.strokeStyle = '#e6a08a'; ctx.lineWidth = 1.4;
 ctx.beginPath(); ctx.moveTo(x - 33, y + 8); ctx.lineTo(x + 33, y + 8); ctx.stroke();
 }
 ctx.restore();
 return rect;
 }

 // ---------- US detail — THE FRAME-NOT-FILL invariant (UX §1 / Design §0) ----------
 // The region you are INSIDE renders as an OUTLINE (never a flood). Its DIRECT CHILDREN are the
 // interactive fill layer; only ONE child fills at a time (it follows the cursor). This is what fixes
 // both round-2 bugs by construction: the nation never floods, and every county is individually pickable.

 // Nation = OUTLINE, not fill (Design §1) — engraved under-halo + clay lift + crisp line. The "glow"
 // is a WIDE low-alpha clay stroke, NOT shadowBlur: a shadowBlur on this huge multipolygon path is the
 // single most expensive op at nation zoom, and a widened stroke reads the same lift at a fraction of it.
 function drawNationOutline(a, withGlow) {
 if (a <= 0.01) return;
 ctx.save(); ctx.lineJoin = 'round';
 // pass 1 = wide clay lift (blur-free "glow") when top-level, else a dark under-halo — one stroke either way
 if (withGlow) { ctx.beginPath(); path(usConus); ctx.lineWidth = 3.6; ctx.strokeStyle = 'rgba(230,160,138,' + (0.26 * a) + ')'; ctx.stroke(); }
 else { ctx.beginPath(); path(usConus); ctx.lineWidth = 2.4; ctx.strokeStyle = 'rgba(63,58,44,' + (0.35 * a) + ')'; ctx.stroke(); }
 // pass 2 = crisp clay line on top
 ctx.beginPath(); path(usConus); ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(230,160,138,' + a + ')'; ctx.stroke(); // #e6a08a crisp
 ctx.restore(); // NO fill — oracle asserts nation fill alpha ≈ 0
 }
 // Container rim-light (Design §2.2 / §3.3): lights the perimeter INWARD so the interior stays readable
 // (you can see the children you're about to explore) — NEVER a flood. The inner-clip + feathered blur is
 // the "world-class" lit read. Restored to full quality now that the state-zoom budget has ~15ms headroom
 // (the real cost was a hidden globe, since fixed). lw = fat inner-clip stroke width (state 11 / county 9).
 function drawContainerRim(feat, a, lw, outlineW, blur) {
 if (a <= 0.01) return;
 ctx.save();
 ctx.save(); ctx.beginPath(); path(feat); ctx.clip();
 ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(230,160,138,' + (0.42 * a) + ')';
 ctx.shadowColor = 'rgba(230,160,138,0.80)'; ctx.shadowBlur = blur;
 ctx.beginPath(); path(feat); ctx.stroke(); // clip keeps only the inner half of the fat stroke = feathered rim
 ctx.restore();
 ctx.beginPath(); path(feat); ctx.lineWidth = outlineW + 0.9; ctx.strokeStyle = 'rgba(63,58,44,' + (0.35 * a) + ')'; ctx.stroke();
 ctx.beginPath(); path(feat); ctx.lineWidth = outlineW; ctx.strokeStyle = '#f0c9a8';
 ctx.shadowColor = 'rgba(230,160,138,0.90)'; ctx.shadowBlur = blur * 0.7; ctx.stroke(); ctx.shadowBlur = 0;
 ctx.restore(); // NO fill
 }
 // The US-detail orchestrator. Draws context linework, the committed container as outline+rim, and the
 // ONE hovered child (state or county) as a transient soft-light fill.
 function drawUSDetail(o) {
 if (!usEngaged()) return;
 var s = projection.scale(), f = genFits(), layer = childLayer();
 // tight viewport cull — at state/county zoom only a handful of states are actually visible, so cull
 // the underlay + county-mesh loops to states near the viewport centre (not the whole near hemisphere).
 var cc0 = centerCoord(), cullR = clamp(1.4 / Math.max(zoomRatio(), 0.001), 0.1, 0.28);
 function inView(c) { return G.geoDistance(c, cc0) < cullR; }
 // the county hairline mesh is the heaviest per-frame path at state zoom — cull it TIGHTER than the
 // land underlay (which must cover the viewport corners) so mainly the focus state + near neighbours pay.
 var meshR = Math.min(cullR, 0.2);
 function inMesh(c) { return G.geoDistance(c, cc0) < meshR; }
 // 0) engraved LAND UNDERLAY — as the globe hands off (o.world fades), keep the matte atlas read by
 // filling the VISIBLE states with the land tone. Far cheaper than the whole-world land path; drawn
 // only once the globe is fading out (Design §6 texture-hold). No grain-overlay here (too costly).
 var underA = clamp(1 - o.world / 0.85, 0, 1);
 if (underA > 0.02) {
 ctx.save();
 // visible-states silhouette as a Path2D so the fill, warmth clip, PHYSICAL pass, and border
 // stroke all reuse one path build (Phase 2: physical layers need a clip region on the flat map
 // so tone never floats on the page outside the drawn underlay).
 var vis = new Path2D(); pathD.context(vis);
 for (var pi = 0; pi < usStates.length; pi++) { var us2 = usStates[pi]; if (inView(us2.__c)) pathD(us2); }
 ctx.fillStyle = 'rgba(185,190,147,' + underA + ')'; ctx.fill(vis); // #b9be93 lowland base
 var dr = [W / 2 - s, H / 2 - s, s * 2, s * 2];
 ctx.save(); ctx.clip(vis);
 ctx.fillStyle = 'rgba(194,171,126,' + (0.16 * underA) + ')'; ctx.fillRect(dr[0], dr[1], dr[2], dr[3]); // faint interior warmth
 // (Phase 2 physical) full treatment stack on the flat register — same cached paths as the globe
 if (physOn()) physFlat(underA, !(dragging || flyRAF || inertiaRAF || autoOn));
 ctx.restore();
 // state borders — from the SAME culled visible-state path (replaces the full-US mesh stroke; when
 // the globe is on it's drawUSMatte's job, so this only runs once the globe has faded → no double).
 // Drawn AFTER the physical tint fills so border ink keeps full contrast.
 ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(92,83,64,' + (0.55 * underA) + ')'; ctx.stroke(vis); // #5c5340
 ctx.restore();
 }
 // 1) county hairline mesh — context, non-interactive (visible states only, one stroke)
 if (o.allCounty > 0.02) {
 ctx.save(); ctx.globalAlpha = o.allCounty; ctx.strokeStyle = 'rgba(107,102,80,0.32)'; ctx.lineWidth = 0.5; // #6b6650
 ctx.beginPath();
 for (var si = 0; si < usStates.length; si++) { var st = usStates[si]; if (!inMesh(st.__c)) continue; var cm = countyMeshByState[String(st.id)]; if (cm) path(cm); }
 ctx.stroke(); ctx.restore();
 }
 // 3) nation OUTLINE (never fill). Fades OUT by state zoom (the state rim becomes the frame there);
 // 3 huge US-path strokes at state zoom were a big cost. Wide clay lift only while nation is top container.
 var aNat = clamp(band(s, f.sN * 0.9, f.sN * 1.12), 0, 1) * (1 - band(s, f.sN * 1.7, f.sN * 2.5));
 drawNationOutline(aNat, NAV.level <= 1);
 // 4) committed container rim-light (county wins over state — deepest is the frame). Both are OUTLINE-only.
 // Under ISOLATION (Phase 3) the county rim + name are drawn by drawCountyRegister ABOVE the
 // mask — drawing them here too would double the glow, so the county branch is skipped there.
 var cc = containerCounty(), cs = containerState();
 var isoA = isoAnim.alpha;
 if (cc && isoA <= 0.01) {
 if (cs) { ctx.save(); ctx.beginPath(); path(cs); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(240,201,168,0.45)'; ctx.stroke(); ctx.restore(); } // containing state, thin
 drawContainerRim(cc, 1, 9, 1.3, 8);
 var rp = projection(cc.__c || G.geoCentroid(cc)); if (rp) selectedLabel(countyDisplayName(cc).toUpperCase(), rp[0], rp[1] - 6, true);
 } else if (!cc && cs) {
 drawContainerRim(cs, 1, 11, 1.5, 13);
 var sp = projection(cs.__c || G.geoCentroid(cs)); if (sp) selectedLabel(stateName(cs).toUpperCase(), sp[0], sp[1]);
 // just-released isolation county renders as the SELECTED child so the reader sees where they
 // were (UX §3.2.2 zoom-out continuity)
 if (lastIsoFips && layer === 'counties') {
 var li = countyById[lastIsoFips];
 if (li && String(li.id).slice(0, 2) === String(cs.id) && li !== hoverCounty) softGlowRegion(li, SEL_FILL, SEL_SOFT, 0, 6, true);
 }
 }
 // 5) hovered child — ONE at a time (the interactive layer). Hover reads lighter than the rim.
 if (layer === 'states' && hoverState && hoverState !== cs) softGlowRegion(hoverState, HOVER_FILL, HOVER_SOFT, 1.6, 8, false);
 else if (layer === 'counties' && hoverCounty && hoverCounty !== cc) softGlowRegion(hoverCounty, HOVER_FILL + 0.04, HOVER_SOFT + 0.05, 1.4, 6, false);
 }
 // (Phase 2 §3.2/§3.3) major-city marks + labels, tiered by population so the map never turns to soup.
 // Tier A fades in through nation, B toward state, C only at state/county. Capitals get the circled
 // dot. Atlas ink dots (#3f3a2c) with a thin paper edge so they read on the dark map; labels are ink
 // on a paper halo. Continuous band alphas — never a hard pop.
 // (Design §4) city marks + labels at full density (~2,400), LOD tiers + greedy collision de-clutter.
 // Tier A fades in through nation, B toward state, C only inside the focused state/county. The hovered
 // city (point pick) enlarges + promotes its label. Capitals get the circled-dot. Only the drawn count
 // is bounded (LOD + collision), so the 2,400-row dataset never becomes soup.
 function drawCities(alpha) {
 if (alpha <= 0.02 || !CITIES.length) return;
 var zr = zoomRatio();
 var aA = band(zr, 1.6, 2.4), aB = band(zr, 2.4, 3.4), aC = band(zr, 4.2, 5.2);
 if (aA <= 0.02) return;
 // seed the reservation with this frame's container centroid labels (FRESNO COUNTY / CALIFORNIA …) so a
 // colliding, non-hovered city label drops rather than overprinting the frame label (Design M1 fix).
 var focusCf = NAV.countyFips, focusSf = NAV.stateFips, reserved = centroidLabelRects.slice();
 function overlaps(x0, y0, x1, y1) { for (var r = 0; r < reserved.length; r++) { var b = reserved[r]; if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return true; } return false; }
 ctx.save(); ctx.textAlign = 'left'; ctx.lineJoin = 'round';
 for (var i = 0; i < CITIES.length; i++) {
 var ci = CITIES[i]; if (!visiblePt(ci.c)) continue;
 var ta = ci.tier === 'A' ? aA : ci.tier === 'B' ? aB : aC;
 if (ta <= 0.02) continue;
 var p = projection(ci.c); if (!p) continue;
 var hov = ci === hoverCity;
 ctx.globalAlpha = alpha * ta;
 if (ci.capital) { // classic capital symbol — filled dot + ring
 ctx.beginPath(); ctx.arc(p[0], p[1], hov ? 2.9 : 2.2, 0, 7); ctx.fillStyle = hov ? '#f0c9a8' : '#3f3a2c'; ctx.fill();
 ctx.beginPath(); ctx.arc(p[0], p[1], hov ? 5.6 : 4.8, 0, 7); ctx.strokeStyle = hov ? 'rgba(230,160,138,0.95)' : 'rgba(63,58,44,0.8)'; ctx.lineWidth = 1; ctx.stroke();
 } else {
 var r = (ci.tier === 'A' ? 2.0 : ci.tier === 'B' ? 1.6 : 1.1) + (hov ? 2.0 : 0);
 ctx.beginPath(); ctx.arc(p[0], p[1], r + 0.6, 0, 7); ctx.strokeStyle = 'rgba(244,241,232,0.7)'; ctx.lineWidth = 0.8; ctx.stroke(); // paper edge (reads on dark)
 ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fillStyle = hov ? '#f0c9a8' : '#3f3a2c'; ctx.fill();
 }
 // label gating: Tier C only inside the focused county/state (or when no focus at deep zoom).
 var cAllowed = zr > 4.2 && (!focusSf ? true : (ci.cf === focusCf || ci.sf === focusSf));
 var showLabel = hov || ci.tier === 'A' || (ci.tier === 'B' && zr > 2.4) || (ci.tier === 'C' && cAllowed);
 if (showLabel) {
 ctx.font = ((hov ? "700 " : "600 ") + (ci.tier === 'A' ? "11px " : hov ? "10.5px " : "10px ")) + "'Inter',system-ui,sans-serif";
 var lx = p[0] + 7, ly = p[1] + 3, w = ctx.measureText(ci.name).width, x0 = lx - 1, y0 = ly - 9, x1 = lx + w + 1, y1 = ly + 3;
 if (hov || !overlaps(x0, y0, x1, y1)) { // hovered city always wins its space (Design §4.4)
 reserved.push([x0, y0, x1, y1]);
 ctx.strokeStyle = 'rgba(244,241,232,0.85)'; ctx.lineWidth = 3; ctx.strokeText(ci.name, lx, ly);
 ctx.fillStyle = hov ? '#1c1408' : '#2c281c'; ctx.fillText(ci.name, lx, ly);
 }
 }
 }
 ctx.globalAlpha = 1; ctx.restore();
 }

 // ---------- pack loader (UX pack-loading spec 2026-07-17 + Design Spec D) ----------
 // Per-region detail packs are static JSON fetched lazily. THE GOVERNING RULE: navigation never
 // blocks on a pack. Every register renders a valid interactive map from boot geometry (BASE);
 // packs are progressive enhancement, fading in relief→water→roads→labels, alpha-only. A late pack
 // for a region that is no longer current only populates the cache (race gate — UX §4). Failure is
 // ALWAYS honest: persistent #packstatus message + Retry, never a silent flat map (UX §3.4).
 var PACKS = {};
 DRILL_KEYS.forEach(function (k) { PACKS[k] = { url: PACK_BASE + k + '.json', kind: 'city' }; });
 // county detail packs (Phase 3): every county-equivalent has a pipeline-generated pack at
 // packs/county/<fips>.json (scripts/build-county-packs.mjs). Registered lazily on first request —
 // 3,142 static entries would be waste; the key encodes the fips.
 function ensureCountyPack(key) {
 if (PACKS[key] || !/^co\d{5}$/.test(key)) return PACKS[key];
 PACKS[key] = { url: PACK_BASE + 'county/' + key.slice(2) + '.json', kind: 'county3' };
 return PACKS[key];
 }
 var packRecs = {}; // key -> record
 // B3 (UX sign-off): the city-pack namespace is exactly the 2,402 geoids in packs/city-index.json
 // (333 Class-F + 2,069 Class-L). County packs also carry small CDP/CENSUS places (Harbison Canyon,
 // Spring Valley, …) that have NO street pack. Requesting one 404s → a FALSE "couldn't load street
 // detail" for a place that structurally has no map, plus console-404 noise. The manifest (lazy,
 // ~25KB gz, post-boot) is the authority: a geoid not in it is a NO-PACK place — no fetch, honest
 // base register, no failure chrome. Class-F/L cities keep loading their real on-disk pack.
 var cityPackSet = null; // Set of pack-carrying geoids once the manifest resolves (null = pending)
 var cityIndexState = 'idle';
 function fetchCityIndex() {
 if (destroyed || cityIndexState === 'loading' || cityIndexState === 'complete') return;
 cityIndexState = 'loading';
 fetch(PACK_BASE + 'city-index.json', { cache: 'force-cache' })
 .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
 .then(function (j) {
 if (destroyed) return;
 cityPackSet = new Set(Object.keys((j && j.cities) || {}));
 cityIndexState = 'complete';
 })
 .catch(function () { if (!destroyed) cityIndexState = 'idle'; }); // absent manifest → 404-catch path still degrades to nopack
 }
 // a city pack is known-absent when the manifest has resolved and doesn't list the geoid. Before the
 // manifest resolves this returns false (the fetch proceeds; a 404 then degrades to nopack honestly).
 function cityPackKnownAbsent(key) {
 return cityPackSet && /^ci\d{7}$/.test(key) && !cityPackSet.has(key.slice(2));
 }
 var packAutoFetch = true; // QC valve: the exhaustive 3,142-county sweep must not fetch 3,142 packs
 var packRaceBlocked = 0; // QC observability: late arrivals that were cache-only'd
 var packFetches = {}; // key -> fetch count (back-nav must NOT refetch — UX §5)
 var PACK_LRU_MAX = 24; // UX §5 starting point (2 packs today; pipeline packs land in P3/P4)
 var packLRU = [];
 function packRec(key) {
 if (!packRecs[key]) packRecs[key] = { key: key, state: 'idle', data: null, reliefImg: null, fadeStart: 0, animDone: false, autoRetried: false, escalated: false, offline: false, startedAt: 0 };
 return packRecs[key];
 }
 function packTouch(key) {
 var i = packLRU.indexOf(key); if (i >= 0) packLRU.splice(i, 1);
 packLRU.push(key);
 while (packLRU.length > PACK_LRU_MAX) { var ev = packLRU.shift(); if (packRecs[ev] && packRecs[ev].state !== 'loading') { packRecs[ev].data = null; packRecs[ev].reliefImg = null; packRecs[ev].cdec = null; packRecs[ev].ydec = null; packRecs[ev].state = 'idle'; packRecs[ev].animDone = false; } }
 }
 // cubic-bezier solver (Design easings are exact params, not approximations)
 function cubicBezier(x1, y1, x2, y2) {
 function sample(t, a, b) { return ((1 - 3 * b + 3 * a) * t * t * t) + ((3 * b - 6 * a) * t * t) + (3 * a * t); }
 return function (x) {
 if (x <= 0) return 0; if (x >= 1) return 1;
 var t = x;
 for (var i = 0; i < 6; i++) { var xt = sample(t, x1, x2) - x; var dx = 3 * (1 - 3 * x2 + 3 * x1) * t * t + 2 * (3 * x2 - 6 * x1) * t + 3 * x1; if (Math.abs(dx) < 1e-6) break; t -= xt / dx; t = clamp(t, 0, 1); }
 return sample(t, y1, y2);
 };
 }
 var EASE_RELIEF = cubicBezier(0, 0, 0.3, 1); // ease-out — ground arrives gently ()
 var EASE_STD = cubicBezier(0.25, 0.1, 0.25, 1); // standard — water/roads/labels
 // timing: relief 400ms from t=0; water/roads/labels 320/320/240ms, each starting ≥140ms after
 // the previous layer STARTS (stagger floor 140; fixed apply order regardless of decode order).
 var PACK_LAYERS = [
 { k: 'relief', dur: 400, at: 0, ease: EASE_RELIEF },
 { k: 'water', dur: 320, at: 140, ease: EASE_STD },
 { k: 'roads', dur: 320, at: 280, ease: EASE_STD },
 { k: 'labels', dur: 240, at: 420, ease: EASE_STD },
 ];
 var PACK_ALL_ON = { relief: 1, water: 1, roads: 1, labels: 1, done: true };
 function packLayerAlphas(key) {
 var r = packRecs[key];
 if (!r || !r.data) return null;
 if (r.animDone) return PACK_ALL_ON;
 var now = performance.now(), out = { done: true };
 for (var i = 0; i < PACK_LAYERS.length; i++) {
 var L = PACK_LAYERS[i], t = (now - r.fadeStart - L.at) / L.dur;
 var a = t <= 0 ? 0 : t >= 1 ? 1 : L.ease(t);
 if (a < 1) out.done = false;
 out[L.k] = a;
 }
 if (out.done) r.animDone = true;
 return out;
 }
 // which region's pack drives the status line + fade gate: the drill whose LOCAL register is
 // currently on screen (the same o.local band drawLocal renders from). NOT keyed to NAV.level —
 // Virginia Beach's city boundary IS its county-equivalent, so its deepest drill stop classifies
 // as NAV level 3 (verified mockup-parity behavior); its local register must still get honest
 // status + in-register fades.
 function currentPackKey() {
 var o = lod();
 // exemplar drill packs keep priority in their LOCAL register (VB's deepest stop is NAV-3 —
 // city == county-equivalent — and its curated city pack must keep driving status + fades).
 // Guard: the drill must actually be OUR register (activeDrill claims a 0.7-rad radius, which
 // would let SD's pack drive the status line at an isolated Denver).
 if (o.local > 0.01 && o.drill && PACKS[o.drill.key] && NAV.countyFips === o.drill.regionFips) return o.drill.key;
 // city register (Phase 4) → the city's own street pack
 if (NAV.level === 4 && NAV.cityId) { var ck4 = cityKeyOf(cityById[NAV.cityId]); if (ck4) return ck4; }
 // county isolation register → the county's own detail pack (Phase 3)
 if (NAV.level === 3 && NAV.countyFips) return 'co' + NAV.countyFips;
 return null;
 }
 function requestPack(key, isManualRetry) {
 var p = PACKS[key] || ensureCountyPack(key) || ensureCityPack(key); if (!p || destroyed) return;
 var r = packRec(key);
 // B3: a known-absent city pack (CDP / not in the manifest) never fetches — it is a NO-PACK place,
 // a terminal honest state (no 404, no failure chrome; the base register is the honest surface).
 if (r.state === 'nopack') return;
 if (cityPackKnownAbsent(key)) { r.state = 'nopack'; syncPackStatus(); return; }
 // FAILED is sticky: only the Retry affordance (or the online event) re-arms it — the render
 // loop re-invoking this every frame must never turn failure into an invisible retry storm.
 if (r.state === 'loading' || r.state === 'failed' || r.data) return;
 r.state = 'loading'; r.offline = false; r.startedAt = performance.now();
 if (isManualRetry) { r.autoRetried = false; r.escalated = false; }
 packFetches[key] = (packFetches[key] || 0) + 1;
 packTouch(key);
 var ctrl = new AbortController(); r.abort = ctrl;
 r.timeoutT = setTimeout(function () { if (r.state === 'loading') ctrl.abort(); }, 12000); // UX §2 failure timeout
 fetch(p.url, { signal: ctrl.signal, cache: 'force-cache' })
 .then(function (res) { if (!res.ok) { var e = new Error('http ' + res.status); e.http = res.status; throw e; } return res.json(); })
 .then(function (json) {
 clearTimeout(r.timeoutT);
 if (destroyed) return;
 r.data = json; r.state = 'complete';
 var m = json.area && json.area.map;
 if (m && m.relief && m.relief.dark) { var im = new Image(); im.onload = function () { requestRender(); }; im.src = m.relief.dark; r.reliefImg = im; }
 if (p.kind === 'county3') { // county pack: decode delta-encoded geometry + bake-in relief raster + merge places
 r.cdec = decodeCountyPack(json);
 if (json.relief && json.relief.png) { var cim = new Image(); cim.onload = function () { requestRender(); }; cim.src = json.relief.png; r.reliefImg = cim; }
 mergePackPlaces(json);
 // the pack carries the honest Gazetteer county-equivalent name (Parish/Borough/Census
 // Area) — refresh chrome opened pre-arrival with the heuristic name
 if (NAV.countyFips === json.fips) {
 var coF = countyById[json.fips];
 var afBtn = cardBody.querySelector('.addfeed[data-pid="county:' + json.fips + '"]');
 if (coF && card.classList.contains('on') && afBtn) {
 // the card opened pre-arrival with the heuristic name — refresh title + add-feed label
 var freshT = countyFeedTitle(coF);
 cardTitle.textContent = freshT;
 afBtn.setAttribute('data-label', freshT);
 afBtn.innerHTML = addFeedInner(!!pinnedFeeds['county:' + json.fips], freshT);
 }
 hintKey = '__stale__'; // force the .hint copy to re-render with the Gazetteer name
 }
 }
 if (p.kind === 'city4') r.ydec = decodeCityPack(json); // city pack: decode + build planar Path2Ds once
 // development plays on first arrival in-register (). A city pack arriving while ITS city
 // is the live register also plays — even when an exemplar drill key owns the status line.
 var inCityReg = p.kind === 'city4' && NAV.level === 4 && NAV.cityId && cityKeyOf(cityById[NAV.cityId]) === key;
 if (currentPackKey() === key || inCityReg) { r.fadeStart = performance.now(); r.animDone = false; }
 else { r.animDone = true; packRaceBlocked++; } // race gate: cache only — never mutate a non-current view
 syncPackStatus(); requestRender();
 })
 .catch(function (err) {
 clearTimeout(r.timeoutT);
 if (destroyed) return;
 var is404 = err && err.http === 404;
 r.offline = typeof navigator !== 'undefined' && navigator.onLine === false;
 if (is404 && /^ci\d{7}$/.test(key)) {
 // B3: a city pack 404 on the static export = the place structurally has no street map (a
 // CDP the manifest gate didn't yet know about). Terminal NO-PACK, honest base register —
 // NOT a "couldn't load, Retry" failure. (County packs all exist; a co* 404 stays a failure.)
 r.state = 'nopack';
 } else if (!is404 && !r.autoRetried && !r.offline) {
 // ONE silent auto-retry on network error (not 404); escalation copy shows immediately (UX §2)
 r.autoRetried = true; r.escalated = true; r.state = 'idle';
 requestPack(key);
 } else {
 r.state = 'failed';
 }
 syncPackStatus();
 });
 syncPackStatus();
 }
 function retryPack(key) { var r = packRec(key); if (r.state !== 'failed') return; r.state = 'idle'; requestPack(key, true); syncPackStatus(); }
 function onlineListener() { var k = currentPackKey(); if (k) { var r = packRec(k); if (r.state === 'failed' && r.offline) retryPack(k); } }
 window.addEventListener('online', onlineListener);
 // ---- #packstatus — one line, honest copy, Design styling (pulse dot = working, clay square =
 // stopped, Retry the sole affordance). Mounted under the localtitle block; reserves its line height.
 var packStatusEl = root.querySelector('#packstatus');
 var psTxt = packStatusEl ? packStatusEl.querySelector('.ps-txt') : null;
 var psRetry = packStatusEl ? packStatusEl.querySelector('.ps-retry') : null;
 if (psRetry) psRetry.addEventListener('click', function () { var k = currentPackKey(); if (k) retryPack(k); });
 var psTimer = setInterval(function () { if (!destroyed) syncPackStatus(); }, 250); // catches the 400ms/2.5s thresholds while idle
 function packStatusFor(key) {
 var r = packRecs[key];
 if (!r) return null;
 var isCounty = /^co\d{5}$/.test(key);
 var isCity = /^ci\d{7}$/.test(key);
 var ci = NAV.cityId ? cityById[NAV.cityId] : null;
 var place = isCounty ? countyDisplayName(countyById[key.slice(2)])
 : isCity ? ((cityByGeoid[key.slice(2)] && cityByGeoid[key.slice(2)].name) || (ci ? ci.name : 'this place'))
 : (ci ? ci.name : (DRILLS[key] ? DRILLS[key].name : 'this place'));
 if (r.state === 'loading') {
 var waited = performance.now() - r.startedAt;
 if (waited < 400 && !r.escalated) return null; // fast connections never see a status flash (UX §2)
 if (waited >= 2500 || r.escalated) return { cls: 'on', txt: 'Still loading detail — slow connection. Everything on screen works.', retry: false };
 return { cls: 'on', txt: isCounty ? 'Loading county detail — map is usable now.' : 'Loading street detail — map is usable now.', retry: false };
 }
 if (r.state === 'failed') {
 if (r.offline) return { cls: 'on failed', txt: 'You’re offline — showing the base map for ' + place + '.', retry: true };
 if (isCounty) return { cls: 'on failed', txt: 'Couldn’t load county detail for ' + place + '. Showing boundaries and main features only.', retry: true };
 return { cls: 'on failed', txt: 'Couldn’t load street-level detail for ' + place + '. Showing boundaries and main features only.', retry: true };
 }
 return null; // idle/complete → no line
 }
 var psKey = '';
 function syncPackStatus() {
 if (!packStatusEl) return;
 var k = currentPackKey();
 var st = k ? packStatusFor(k) : null;
 var sig = st ? st.cls + '|' + st.txt + '|' + st.retry : '';
 if (sig === psKey) return;
 psKey = sig;
 // ps-on lifts the title-block container into view for the status line even when the city
 // title itself is absent (VB: city==county ⇒ no NAV-4 localtitle, but the register is live).
 if (ltOuter) ltOuter.classList.toggle('ps-on', !!st);
 if (!st) { packStatusEl.className = ''; if (psRetry) psRetry.hidden = true; if (psTxt) psTxt.textContent = ''; return; }
 packStatusEl.className = st.cls;
 if (psTxt) psTxt.textContent = st.txt;
 if (psRetry) psRetry.hidden = !st.retry;
 }

 // ---------- county register drawing (Phase 3 — Design Spec B) ----------
 // Pack geometry is quantized + delta-encoded (scripts/build-county-packs.mjs) → decoded once on
 // arrival into flat lon/lat Float64Array pair-lists.
 function decodeCountyPack(j) {
 var q = j.q || 10000;
 function dl(enc) {
 var pts = new Float64Array(enc.length);
 var x = enc[0], y = enc[1]; pts[0] = x / q; pts[1] = y / q; var k = 2;
 for (var i = 2; i < enc.length; i += 2) { x += enc[i]; y += enc[i + 1]; pts[k++] = x / q; pts[k++] = y / q; }
 return pts;
 }
 return {
 contours: (j.contours || []).map(dl),
 waterA: ((j.water && j.water.a) || []).map(function (rings) { return rings.map(dl); }),
 waterL: ((j.water && j.water.l) || []).map(dl),
 roads: { i: ((j.roads && j.roads.i) || []).map(dl), p: ((j.roads && j.roads.p) || []).map(dl), s: ((j.roads && j.roads.s) || []).map(dl) },
 };
 }
 // pack places merge into the live city index: every Gazetteer place becomes a first-class,
 // NAV-resolvable city object (identity: tiny places resolve to THEMSELVES, never to the nearest
 // big dot). ≥100k places already exist from boot (and keep their boundary polys).
 var countyPlaceList = {}; // fips -> pack place city objects, pop-desc (stable draw/collision order)
 function mergePackPlaces(j) {
 var sf = String(j.fips).slice(0, 2), stName = FIPS_NAME[sf] || '';
 var fips = String(j.fips);
 var list = [];
 (j.places || []).forEach(function (p) {
 // F2 spillover entries (p.x): the place's HOME county is p.hc, not this pack's — a multi-
 // county city (New York in each borough pack) or a line-straddling town (Emporia inside
 // Greensville's doughnut). The shared city object keeps its canonical identity + home; THIS
 // county's list gets a per-county VIEW carrying the pack's in-county anchor, so the label
 // lands inside this county and a later pack merge never relocates it.
 var home = p.x && p.hc ? String(p.hc) : fips;
 var ex = cityByGeoid[p.g];
 if (!ex) {
 var homeCo = countyById[home];
 ex = { id: 'plc:' + p.g, name: p.n, state: stName, c: [p.lon, p.lat], pop: p.pop, capital: false,
 g: p.g, tier: 'C', sf: sf, cf: home,
 cn: homeCo && homeCo.properties && homeCo.properties.name ? homeCo.properties.name
 : (j.name || '').replace(/\s+(County|Parish|Borough|Census Area|Municipality|city|City and Borough|Planning Region)$/i, ''),
 pk: p };
 CITIES.push(ex); cityById[ex.id] = ex; cityByGeoid[p.g] = ex;
 (citiesByStateFips[sf] = citiesByStateFips[sf] || []).push(ex);
 (citiesByCounty[home] = citiesByCounty[home] || []).push(ex);
 }
 if (home === fips) { ex.pk = p; list.push(ex); return; } // own-county entry — the canonical object
 var view = Object.create(ex); view.c = [p.lon, p.lat]; view.pk = p; // spillover view (draw + hit only)
 list.push(view);
 });
 list.sort(function (a, b) { return b.pop - a.pop || (a.name < b.name ? -1 : 1); });
 countyPlaceList[String(j.fips)] = list;
 }
 function flatPoly(pts) { // flat lon/lat pair list → current path (projection per point; county zoom = all near side)
 var started = false;
 for (var i = 0; i < pts.length; i += 2) {
 var p = projection([pts[i], pts[i + 1]]); if (!p) continue;
 if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
 }
 return started;
 }
 // Path2D cache for the county's pack linework — built once per projection state, so at-rest
 // frames (hover, fades, the perf gate) pay raster cost only.
 var countyCache = { key: '', p: null };
 function countyPaths(fips, dec) {
 var r = projection.rotate();
 var key = fips + '|' + r[0].toFixed(4) + ',' + r[1].toFixed(4) + ',' + projection.scale().toFixed(1) + ',' + W + 'x' + H;
 if (countyCache.key === key) return countyCache.p;
 function build(list) {
 var p2 = new Path2D(); pathD.context(p2);
 var any = false;
 for (var i = 0; i < list.length; i++) {
 var pts = list[i], started = false;
 for (var k = 0; k < pts.length; k += 2) {
 var pp = projection([pts[k], pts[k + 1]]); if (!pp) continue;
 if (!started) { p2.moveTo(pp[0], pp[1]); started = true; } else p2.lineTo(pp[0], pp[1]);
 }
 if (started) any = true;
 }
 return any ? p2 : null;
 }
 function buildRings(polys) {
 var p2 = new Path2D();
 var any = false;
 for (var i = 0; i < polys.length; i++) {
 for (var ri = 0; ri < polys[i].length; ri++) {
 var pts = polys[i][ri], started = false;
 for (var k = 0; k < pts.length; k += 2) {
 var pp = projection([pts[k], pts[k + 1]]); if (!pp) continue;
 if (!started) { p2.moveTo(pp[0], pp[1]); started = true; } else p2.lineTo(pp[0], pp[1]);
 }
 if (started) { p2.closePath(); any = true; }
 }
 }
 return any ? p2 : null;
 }
 var built = {
 contours: build(dec.contours),
 waterA: buildRings(dec.waterA),
 waterL: build(dec.waterL),
 rI: build(dec.roads.i), rP: build(dec.roads.p), rS: build(dec.roads.s),
 };
 countyCache = { key: key, p: built };
 return built;
 }
 // physical climate textures clipped to the county (Design A7 county column — forest 0.35 bosk,
 // desert stipple 0.50, tundra). Caller has us INSIDE the county clip; the world-register ramps
 // (cf) are already faded out here, so this pass draws at the county column's fixed alphas.
 function drawCountyTextures(a, rest) {
 if (!physOn() || a <= 0.01) return;
 var cache = physPaths(), reg = PHYS.reg[PHYS.reg.state ? 'state' : 'nation'];
 var dr = [0, 0, W, H];
 var des = buildPolyPath(cache, 'deserts', PHYS.deserts);
 if (des.any) {
 var drD = physRect(des, dr);
 ctx.save(); ctx.clip(des.p);
 ctx.fillStyle = 'rgba(211,195,154,' + (0.22 * a) + ')'; ctx.fillRect(drD[0], drD[1], drD[2], drD[3]);
 if (rest) { ctx.globalAlpha = 0.50 * a; ctx.fillStyle = DESERT_PAT; ctx.fillRect(drD[0], drD[1], drD[2], drD[3]); ctx.globalAlpha = 1; }
 ctx.restore();
 }
 var tun = buildPolyPath(cache, 'tundra', PHYS.tundra);
 if (tun.any) {
 var drT = physRect(tun, dr);
 ctx.save(); ctx.clip(tun.p);
 ctx.fillStyle = 'rgba(207,211,196,' + (0.28 * a) + ')'; ctx.fillRect(drT[0], drT[1], drT[2], drT[3]);
 if (rest) { ctx.globalAlpha = 0.30 * a; ctx.fillStyle = TUNDRA_PAT; ctx.fillRect(drT[0], drT[1], drT[2], drT[3]); ctx.globalAlpha = 1; }
 ctx.restore();
 }
 var fo = buildPolyPath(cache, 'forestOut', reg.forest.out), fi = buildPolyPath(cache, 'forestIn', reg.forest.inR);
 for (var fpass = 0; fpass < 2; fpass++) {
 var fp = fpass === 0 ? fo : fi;
 if (!fp.any) continue;
 var drF = physRect(fp, dr);
 ctx.save(); ctx.clip(fp.p);
 ctx.fillStyle = 'rgba(163,173,133,' + (0.35 * a) + ')'; ctx.fillRect(drF[0], drF[1], drF[2], drF[3]);
 if (rest) { ctx.globalAlpha = 0.35 * a; ctx.fillStyle = FOREST_PAT; ctx.fillRect(drF[0], drF[1], drF[2], drF[3]); ctx.globalAlpha = 1; }
 ctx.restore();
 }
 }
 // per-frame observability for the Phase-3 oracle
 var countyFrame = { fips: null, base: true, relief: false, contours: 0, waterA: 0, waterL: 0, roads: { i: 0, p: 0, s: 0 }, placesTotal: 0, labelsDrawn: 0, maskOn: false, countyLabelRect: null };
 var isoPlaceHits = []; // per-frame place hitboxes: dot + LABEL are both click targets (UX §2)
 function drawCountyRegister() {
 var a = isoAlphaNow();
 countyFrame = { fips: null, base: true, relief: false, contours: 0, waterA: 0, waterL: 0, roads: { i: 0, p: 0, s: 0 }, placesTotal: 0, labelsDrawn: 0, maskOn: false, countyLabelRect: null };
 isoPlaceHits.length = 0;
 if (a <= 0.01) return;
 var cc = containerCounty() || (isoLatch ? countyById[isoLatch] : null);
 if (!cc) return;
 var fips = String(cc.id);
 countyFrame.fips = fips; countyFrame.maskOn = true;
 var rest = !(dragging || flyRAF || inertiaRAF || autoOn);
 // ---- 1) THE MASK — ONE screen-space even-odd fill per frame: viewport rect + ALL county rings
 // as holes (geoPath emits every ring incl. doughnut holes + antimeridian clips — UX §5.4).
 // Page tone #07090f so the dim reads as "the desk", not grey fog (Design B1).
 var encl = countyEnclaves(cc); // doughnut holes (enclosed independent-city counties) stay masked
 function maskPath() { ctx.beginPath(); ctx.rect(0, 0, W, H); path(cc); for (var ei = 0; ei < encl.length; ei++) path(encl[ei]); }
 ctx.save();
 maskPath();
 ctx.fillStyle = 'rgba(7,9,15,' + (MASK_ALPHA * a) + ')';
 ctx.fill('evenodd');
 // edge seat: 10px under-stroke kept OUTSIDE the boundary (clip to the mask region) — seats the
 // lit plate into the dimmed sheet, blur-free (Design B1)
 ctx.save();
 maskPath(); ctx.clip('evenodd');
 ctx.beginPath(); path(cc); ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(7,9,15,' + (MASK_ALPHA * 0.45 * a) + ')'; ctx.stroke();
 ctx.restore();
 ctx.restore();
 // ---- 2) INTERIOR — the detail pack develops relief → water → roads → labels (Spec D order)
 var key = 'co' + fips;
 var rec = packRecs[key];
 if (packAutoFetch && (!rec || (!rec.data && rec.state !== 'loading' && rec.state !== 'failed' && rec.state !== 'nopack'))) requestPack(key);
 rec = packRecs[key];
 var la = rec && rec.data && rec.cdec ? packLayerAlphas(key) : null;
 if (la && !la.done) requestRender();
 if (la) {
 countyFrame.base = false;
 var dec = rec.cdec, pk = rec.data;
 // clip = county MINUS its doughnut holes (even-odd) — pack layers never paint the enclave
 ctx.save(); ctx.beginPath(); path(cc); for (var eci = 0; eci < encl.length; eci++) path(encl[eci]); ctx.clip('evenodd');
 // 2a. relief hillshade — the one sanctioned raster. Pre-toned sepia bake; two draws of one
 // image: multiply 0.55 (shadow ink into the plate) + source-over 0.25 (lit slopes) — Spec B2.
 var im = rec.reliefImg;
 if (im && im.complete && im.naturalWidth && pk.relief) {
 var rb = pk.relief.bbox;
 var nw = projection([normLon(rb[0]), rb[3]]), se = projection([normLon(rb[2]), rb[1]]);
 if (nw && se && se[0] > nw[0]) {
 var ra = a * la.relief;
 ctx.save();
 ctx.globalAlpha = 0.55 * ra; ctx.globalCompositeOperation = 'multiply';
 ctx.drawImage(im, nw[0], nw[1], se[0] - nw[0], se[1] - nw[1]);
 ctx.globalAlpha = 0.25 * ra; ctx.globalCompositeOperation = 'source-over';
 ctx.drawImage(im, nw[0], nw[1], se[0] - nw[0], se[1] - nw[1]);
 ctx.restore();
 countyFrame.relief = true;
 }
 }
 var paths = countyPaths(fips, dec);
 // 2b. contours — warm relief ink (existing vocabulary)
 if (paths.contours) { ctx.lineWidth = 0.5; ctx.strokeStyle = 'rgba(107,90,60,' + (0.40 * a * la.relief) + ')'; ctx.stroke(paths.contours); countyFrame.contours = dec.contours.length; }
 // 2c. physical textures clipped to the county (forest/desert/tundra, county column)
 drawCountyTextures(a * la.relief, rest);
 // 2d. water — TIGER area + linear (Spec B item 5)
 if (paths.waterA) {
 ctx.globalAlpha = a * la.water;
 ctx.fillStyle = 'rgba(92,125,132,0.9)'; ctx.fill(paths.waterA, 'evenodd');
 ctx.lineWidth = 0.5; ctx.strokeStyle = 'rgba(63,58,44,0.5)'; ctx.stroke(paths.waterA);
 ctx.globalAlpha = 1;
 countyFrame.waterA = dec.waterA.length;
 }
 if (paths.waterL) {
 ctx.globalAlpha = a * la.water;
 ctx.lineWidth = 0.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
 ctx.strokeStyle = 'rgba(122,148,150,0.5)'; ctx.stroke(paths.waterL);
 ctx.globalAlpha = 1;
 countyFrame.waterL = dec.waterL.length;
 }
 // 2e. roads — 3-class inking table (Spec B item 6): casings first, then cores
 ctx.globalAlpha = a * la.roads;
 ctx.lineCap = 'round'; ctx.lineJoin = 'round';
 if (paths.rI) { ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(20,22,18,0.9)'; ctx.stroke(paths.rI); }
 if (paths.rP) { ctx.lineWidth = 2.4; ctx.strokeStyle = 'rgba(20,22,18,0.8)'; ctx.stroke(paths.rP); }
 if (paths.rS) { ctx.lineWidth = 0.9; ctx.strokeStyle = 'rgba(201,203,162,0.55)'; ctx.stroke(paths.rS); countyFrame.roads.s = dec.roads.s.length; }
 if (paths.rP) { ctx.lineWidth = 1.2; ctx.strokeStyle = '#d9d3b8'; ctx.stroke(paths.rP); countyFrame.roads.p = dec.roads.p.length; }
 if (paths.rI) { ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(230,190,120,0.95)'; ctx.stroke(paths.rI); countyFrame.roads.i = dec.roads.i.length; }
 ctx.globalAlpha = 1;
 ctx.restore(); // unclip county
 }
 // ---- 3) THE FRAME — county-selected treatment, fillAlpha=0 (frame-not-fill)
 drawContainerRim(cc, a, 9, 1.3, 8);
 // F3 (Design round-2): the county centroid canvas label is SUPPRESSED once the isolation
 // register is committed — title chip, caption, and crumb already name the county, and on any
 // county whose principal place sits at/near the centroid (coextensive/borough class: Manhattan,
 // SF, Greensville) the centroid label overprints the principal place label at the focal point.
 // The label crossfades out with the commit ramp (alpha 1-a — Spec D alpha-only grammar), so the
 // pre-commit container grammar (isoA<=0.01 branch) hands off with continuity in both directions.
 countyFrame.countyLabelRect = null;
 if (a < 0.98) {
 var rp = projection(cc.__c || G.geoCentroid(cc));
 if (rp) {
 ctx.save(); ctx.globalAlpha = 1 - a;
 countyFrame.countyLabelRect = selectedLabel(countyDisplayName(cc).toUpperCase(), rp[0], rp[1] - 6, true) || null;
 ctx.restore();
 }
 }
 // ---- 4) PLACES — every Gazetteer place, 3 tiers, pop-wins collision, hovered always wins.
 // BASE state (pack not yet arrived) honestly shows the boot Gazetteer subset (Spec ).
 drawIsoPlaces(cc, fips, a, la);
 }
 function drawIsoPlaces(cc, fips, a, la) {
 var list = (la && countyPlaceList[fips]) ? countyPlaceList[fips] : (citiesByCounty[fips] || []);
 countyFrame.placesTotal = list.length;
 if (!list.length) return;
 var labelA = a * (la ? la.labels : 1);
 if (labelA <= 0.02) return;
 var allT1 = list.length <= 3; // ≤3-place counties: full tier immediately (UX §5.1)
 var reserved = centroidLabelRects.slice();
 function overlaps(x0, y0, x1, y1) { for (var r = 0; r < reserved.length; r++) { var b = reserved[r]; if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return true; } return false; }
 ctx.save(); ctx.textAlign = 'left'; ctx.lineJoin = 'round';
 for (var i = 0; i < list.length; i++) {
 var ci = list[i];
 var p = projection(ci.c); if (!p) continue;
 if (p[0] < -40 || p[0] > W + 40 || p[1] < -40 || p[1] > H + 40) continue;
 var t = allT1 ? 1 : (ci.pk ? ci.pk.t : (ci.pop >= 100000 ? 1 : ci.pop >= 10000 ? 2 : 3));
 var hov = ci === hoverCity;
 var r0 = t === 1 ? 3.0 : t === 2 ? 2.2 : 1.6;
 var r = hov ? 6 : r0;
 ctx.globalAlpha = labelA;
 // dot — atlas ink with paper ring on T1/T2 (Spec B tier table); hover = clay-lit promotion
 if (t <= 2) { ctx.beginPath(); ctx.arc(p[0], p[1], r + 0.5, 0, 7); ctx.strokeStyle = 'rgba(244,241,232,0.7)'; ctx.lineWidth = 0.8; ctx.stroke(); }
 ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fillStyle = hov ? '#f0c9a8' : '#3f3a2c'; ctx.fill();
 var font = t === 1 ? '11.5px' : t === 2 ? '10px' : '9.5px';
 var weight = hov ? '700 ' : (t === 1 ? '700 ' : t === 2 ? '600 ' : '500 ');
 ctx.font = weight + font + " 'Inter',system-ui,sans-serif";
 var lx = p[0] + 8, ly = p[1] + 3.5, w = ctx.measureText(ci.name).width;
 var x0 = lx - 2, y0 = ly - 11, x1 = lx + w + 2, y1 = ly + 4;
 // ≤3-place counties label EVERYTHING immediately (UX §5.1). F3 (Design round-2): they must
 // still never overprint EACH OTHER — Manhattan's "New York"(spillover)+"Manhattan"(cousub)
 // share one anchor, so the collision bypass garbled both at the focal point. Dodge rule,
 // allT1-only (normal plates keep cull-on-collision exactly): try right of the dot, then
 // left, below, above; first clear position wins; if none clear, draw at the default anyway.
 if (allT1 && !hov && overlaps(x0, y0, x1, y1)) {
 var cands = [[p[0] - 10 - w, p[1] + 3.5], [p[0] + 8, p[1] + 15], [p[0] + 8, p[1] - 8]];
 for (var cd = 0; cd < cands.length; cd++) {
 var tx = cands[cd][0], ty = cands[cd][1];
 if (!overlaps(tx - 2, ty - 11, tx + w + 2, ty + 4)) { lx = tx; ly = ty; x0 = tx - 2; y0 = ty - 11; x1 = tx + w + 2; y1 = ty + 4; break; }
 }
 }
 var drawLabel = hov || allT1 || !overlaps(x0, y0, x1, y1);
 if (drawLabel) {
 reserved.push([x0, y0, x1, y1]);
 if (hov) { // promotion: paper-on-ink (label flips ground) — Design B2 hover
 ctx.strokeStyle = 'rgba(12,13,16,0.75)'; ctx.lineWidth = 3; ctx.strokeText(ci.name, lx, ly);
 ctx.fillStyle = '#f4f1e8'; ctx.fillText(ci.name, lx, ly);
 } else {
 ctx.strokeStyle = 'rgba(244,241,232,0.85)'; ctx.lineWidth = 3; ctx.strokeText(ci.name, lx, ly);
 ctx.fillStyle = t === 3 ? 'rgba(44,40,28,0.9)' : '#2c281c'; ctx.fillText(ci.name, lx, ly);
 }
 countyFrame.labelsDrawn++;
 }
 // dot AND label are click targets (Fitts — UX §2)
 isoPlaceHits.push({ x: p[0], y: p[1], r: Math.max(r, 6), rect: drawLabel ? [x0, y0, x1, y1] : null, city: ci });
 }
 ctx.globalAlpha = 1; ctx.restore();
 }

 // ---------- city register (Phase 4 — UX city-register spec + Design Spec C) ----------
 // City = the LEAF frame. Boundary outline + .localtitle chrome, fillAlpha=0 on the frame itself;
 // the street map inside is CONTEXT (nothing inside the boundary is hit-tested — pointer is grab).
 // The ONLY interactive map feature here is the sibling jump: neighbor places render dimmed with
 // labels, hover promotes, click hops (~700ms) to that city's register. Class F (≥100k, full TIGER
 // mesh) and Class L (light) differ in DENSITY, never grammar — no badge, no apology copy.
 //
 // PERF MODEL: pack geometry is built ONCE per pack into planar lon/lat Path2Ds (residential mesh
 // bucketed on an 8×8 grid); each frame applies ONE affine lon/lat→screen transform derived from
 // the projection (orthographic is locally affine at city spans — error < ~0.5px) and strokes.
 // No per-frame path rebuild, so drag/zoom frames pay raster cost only. Line widths divide by the
 // transform's geometric-mean scale (±~15% directional width variance at high latitude — accepted,
 // engraved-plate tolerance).
 var cityAnim = { alpha: 0, from: 0, target: 0, t0: 0 };
 var cityRegLast = null; // last committed register city (renders the fade-out after leaving)
 function cityRegCity() { return NAV.level === 4 && NAV.cityId ? cityById[NAV.cityId] : null; }
 function cityKeyOf(ci) { return ci && ci.g ? 'ci' + ci.g : null; }
 function cityRegAlphaNow() {
 var target = cityRegCity() ? 1 : 0;
 if (target !== cityAnim.target) { cityAnim.target = target; cityAnim.from = cityAnim.alpha; cityAnim.t0 = performance.now(); }
 var dur = target > 0 ? 300 : 240;
 var t = clamp((performance.now() - cityAnim.t0) / dur, 0, 1);
 cityAnim.alpha = cityAnim.from + (target - cityAnim.from) * (1 - Math.pow(1 - t, 2));
 if (t < 1) requestRender();
 return cityAnim.alpha;
 }
 // canonical city-entry scale (what enterCity/jumpCity target) — the tier-LOD yardstick (UX §3.1).
 // Boundary cities frame their OWN bbox (a Culver-sized enclave lands at Culver depth, not lost at
 // its huge county's shallow entry) — floored at countyFit×2.55 so the entry always sits inside the
 // shipped NAV level-4 band (computeNav's 2.4× threshold is county-fit-relative and is NOT respec'd).
 // UNCLAMPED on purpose: maxScale() consults this at level 4 (clamping here would recurse).
 function cityEntryScale(ci) {
 var co = ci.cf ? countyById[ci.cf] : null;
 var floor4 = co ? countyFitOf(co) * 2.55 : baseScale * 70;
 if (ci.poly) {
 var b = ci.poly.b, ctr = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
 var P = Math.min(W, H) * 0.42, A = Math.max(angRadiusBBox(b, ctr), 0.0004);
 return Math.max((P * 0.62) / Math.sin(Math.min(A, Math.PI / 2)), floor4);
 }
 return co ? countyFitOf(co) * 2.7 : baseScale * 70;
 }
 // tier reveal bands: t2 ~1.6× entry, t3 ~2.6× entry (smooth band() — nothing pops)
 function cityTiers(ci) {
 var rat = projection.scale() / cityEntryScale(ci);
 return { rat: rat, t2: band(rat, 1.45, 1.7), t3: band(rat, 2.4, 2.7) };
 }
 function ensureCityPack(key) {
 if (PACKS[key] || !/^ci\d{7}$/.test(key)) return PACKS[key];
 PACKS[key] = { url: PACK_BASE + 'city/' + key.slice(2) + '.json', kind: 'city4' };
 return PACKS[key];
 }
 // ---- decode: delta-encoded pack → float rings + planar Path2Ds + label/shield candidates ----
 function cyDl(enc, q) {
 var pts = new Float64Array(enc.length);
 var x = enc[0], y = enc[1]; pts[0] = x / q; pts[1] = y / q; var k = 2;
 for (var i = 2; i < enc.length; i += 2) { x += enc[i]; y += enc[i + 1]; pts[k++] = x / q; pts[k++] = y / q; }
 return pts;
 }
 function planarPath(list) { // list of flat pair arrays → ONE Path2D in lon/lat space
 var p2 = new Path2D();
 for (var i = 0; i < list.length; i++) {
 var pts = list[i];
 p2.moveTo(pts[0], pts[1]);
 for (var k = 2; k < pts.length; k += 2) p2.lineTo(pts[k], pts[k + 1]);
 }
 return p2;
 }
 function planarRingsPath(polys) { // array of ring-lists → ONE even-odd Path2D
 var p2 = new Path2D();
 for (var i = 0; i < polys.length; i++) for (var ri = 0; ri < polys[i].length; ri++) {
 var pts = polys[i][ri];
 p2.moveTo(pts[0], pts[1]);
 for (var k = 2; k < pts.length; k += 2) p2.lineTo(pts[k], pts[k + 1]);
 p2.closePath();
 }
 return p2;
 }
 function chainMid(pts) { // arc-length midpoint of a flat pair array
 var L = 0, i;
 for (i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
 var half = L / 2, acc = 0;
 for (i = 2; i < pts.length; i += 2) {
 var d = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
 if (acc + d >= half) { var t = d > 0 ? (half - acc) / d : 0; return [pts[i - 2] + (pts[i] - pts[i - 2]) * t, pts[i - 1] + (pts[i + 1] - pts[i - 1]) * t, L]; }
 acc += d;
 }
 return [pts[0], pts[1], L];
 }
 function decodeCityPack(j) {
 var q = j.q || 10000;
 var dl = function (e) { return cyDl(e, q); };
 var boundary = (j.boundary || []).map(dl);
 var bbox = j.bbox;
 var d = { cls: j.cls, bbox: bbox, boundary: boundary, approx: j.approx || null, rn: j.rn || [] };
 // all boundary rings in ONE even-odd path — holes (enclaves) stay unfilled
 d.boundaryPath = boundary.length ? planarRingsPath([boundary]) : null;
 var roads = j.roads || {};
 function grp(o) { return o ? { g: (o.g || []).map(dl), n: o.n || [] } : { g: [], n: [] }; }
 d.roads = { i: grp(roads.i), p: grp(roads.p), s: grp(roads.s), r: grp(roads.r), v: { g: ((roads.v && roads.v.g) || []).map(dl) } };
 d.paths = { i: planarPath(d.roads.i.g), p: planarPath(d.roads.p.g), s: planarPath(d.roads.s.g) };
 // residential + service mesh: bucketed 8×8 by chain midpoint so deep-zoom frames stroke only
 // the visible cells (the LA mesh never pays full-city raster cost at street zoom)
 var NB = 8;
 function buckets(list) {
 var cells = [];
 var w = bbox[2] - bbox[0] || 1e-6, h = bbox[3] - bbox[1] || 1e-6;
 for (var i = 0; i < list.length; i++) {
 var pts = list[i];
 var bx = clamp(Math.floor(((pts[0] - bbox[0]) / w) * NB), 0, NB - 1);
 var by = clamp(Math.floor(((pts[1] - bbox[1]) / h) * NB), 0, NB - 1);
 var ci2 = by * NB + bx;
 if (!cells[ci2]) cells[ci2] = [];
 cells[ci2].push(pts);
 }
 return cells.map(function (l, idx) {
 if (!l) return null;
 var bx = idx % NB, by = (idx / NB) | 0;
 return { b: [bbox[0] + (w * bx) / NB, bbox[1] + (h * by) / NB, bbox[0] + (w * (bx + 1)) / NB, bbox[1] + (h * (by + 1)) / NB], p: planarPath(l), n: l.length };
 });
 }
 d.rBuckets = buckets(d.roads.r.g);
 d.vBuckets = buckets(d.roads.v.g);
 var water = j.water || { a: [], l: [] };
 d.waterA = (water.a || []).map(function (rings) { return rings.map(dl); });
 d.waterAPath = d.waterA.length ? planarRingsPath(d.waterA) : null;
 d.waterL = (water.l || []).map(dl);
 d.waterLPath = d.waterL.length ? planarPath(d.waterL) : null;
 d.lm = (j.lm || []).map(function (m) {
 var rings = m.r.map(dl);
 var mp = [rings[0][0], rings[0][1]]; var best = 0;
 // label anchor: ring bbox centre of the largest ring
 for (var ri = 0; ri < rings.length; ri++) {
 var r = rings[ri];
 var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
 for (var k = 0; k < r.length; k += 2) { if (r[k] < minx) minx = r[k]; if (r[k] > maxx) maxx = r[k]; if (r[k + 1] < miny) miny = r[k + 1]; if (r[k + 1] > maxy) maxy = r[k + 1]; }
 var a2 = (maxx - minx) * (maxy - miny);
 if (a2 > best) { best = a2; mp = [(minx + maxx) / 2, (miny + maxy) / 2]; }
 }
 return { k: m.k, name: m.n >= 0 ? d.rn[m.n] : '', c: mp, path: planarRingsPath([rings]) };
 });
 // ---- street-name label candidates (midpoint-horizontal — UX-approved v1 fallback; see report)
 var lab2 = [], lab3 = [];
 function collectLabels(cls, into, cap) {
 var g = d.roads[cls].g, n = d.roads[cls].n;
 var seen = {};
 var rows = [];
 for (var i = 0; i < g.length; i++) {
 if (n[i] == null || n[i] < 0) continue;
 var nm = d.rn[n[i]]; if (!nm) continue;
 var m2 = chainMid(g[i]);
 rows.push({ n: nm, c: [m2[0], m2[1]], len: m2[2] });
 }
 rows.sort(function (a, b) { return b.len - a.len || (a.n < b.n ? -1 : 1); });
 for (var r2 = 0; r2 < rows.length; r2++) {
 var key2 = rows[r2].n;
 seen[key2] = (seen[key2] || 0) + 1;
 if (seen[key2] > 2) continue; // longest 2 chains per name (clip splits) — declutter
 into.push(rows[r2]);
 if (into.length >= cap) break;
 }
 }
 collectLabels('p', lab2, 60); collectLabels('s', lab2, 160);
 collectLabels('r', lab3, 420);
 d.lab2 = lab2; d.lab3 = lab3;
 // ---- shields (tier 1): route parsed from TIGER FULLNAME verbatim — max 1 per route on screen
 var shields = [];
 var routeBest = {};
 function shieldScan(cls, kind, re) {
 var g = d.roads[cls].g, n = d.roads[cls].n;
 for (var i = 0; i < g.length; i++) {
 if (n[i] == null || n[i] < 0) continue;
 var m3 = re.exec(d.rn[n[i]] || ''); if (!m3) continue;
 var rt = kind + m3[1];
 var mid = chainMid(g[i]);
 if (!routeBest[rt] || mid[2] > routeBest[rt].len) routeBest[rt] = { kind: kind, num: m3[1], c: [mid[0], mid[1]], len: mid[2] };
 }
 }
 shieldScan('i', 'I', /^I-? ?(\d{1,3})/);
 shieldScan('p', 'U', /^US Hwy (\d{1,3})/);
 Object.keys(routeBest).sort().forEach(function (rt) { shields.push(routeBest[rt]); });
 d.shields = shields;
 return d;
 }
 // ---- the per-frame affine (lon/lat → CSS px) — valid at city spans, derived from the projection
 function cityXf(bbox) {
 var lon0 = (bbox[0] + bbox[2]) / 2, lat0 = (bbox[1] + bbox[3]) / 2, dd = 0.02;
 var c0 = projection([lon0, lat0]); if (!c0) return null;
 var cx = projection([normLon(lon0 + dd), lat0]), cy = projection([lon0, clamp(lat0 + dd, -89, 89)]);
 if (!cx || !cy) return null;
 var a = (cx[0] - c0[0]) / dd, b = (cx[1] - c0[1]) / dd, c = (cy[0] - c0[0]) / dd, dv = (cy[1] - c0[1]) / dd;
 var k = Math.sqrt(Math.abs(a * dv - b * c)) || 1;
 return { a: a, b: b, c: c, d: dv, e: c0[0] - a * lon0 - c * lat0, f: c0[1] - b * lon0 - dv * lat0, k: k };
 }
 function xfApply(xf) { ctx.transform(xf.a, xf.b, xf.c, xf.d, xf.e, xf.f); }
 function xfPt(xf, lon, lat) { return [xf.a * lon + xf.c * lat + xf.e, xf.b * lon + xf.d * lat + xf.f]; }
 // neighbors (sibling jump): from the national city index ALREADY in memory (UX data flag — never
 // blocked on a neighboring pack). Rural Class L widens the net until 2–6 neighbors exist.
 function cityNeighbors(ci) {
 if (ci.__nb) return ci.__nb;
 var b = ci.poly ? ci.poly.b.slice() : null;
 if (!b) { var rr = 0.06; b = [ci.c[0] - rr, ci.c[1] - rr, ci.c[0] + rr, ci.c[1] + rr]; }
 // ENCLAVES get RESERVED seats: a place whose dot sits in a HOLE of the boundary (Coronado in
 // SD's rings, Culver City in LA's) is the sibling jump's headline case (UX §2) and must never
 // lose its slot to a bigger suburb. Detection: even-odd says "outside", but the dot is inside
 // ≥1 individual ring ⇒ it lives in a hole.
 function ringCountAt(rings, x, y) {
 var cnt = 0;
 for (var r2 = 0; r2 < rings.length; r2++) {
 var ring = rings[r2], n2 = ring.length, ins = false;
 for (var i2 = 0, j2 = n2 - 2; i2 < n2; j2 = i2, i2 += 2) {
 var xi = ring[i2], yi = ring[i2 + 1], xj = ring[j2], yj = ring[j2 + 1];
 if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
 }
 if (ins) cnt++;
 }
 return cnt;
 }
 var encl = [], inBox = [], nearBox = [];
 var grow = [0.3, 0.9, 2.2, 4.5];
 for (var gi2 = 0; gi2 < grow.length; gi2++) {
 var mx = Math.max((b[2] - b[0]), 0.05) * grow[gi2], my = Math.max((b[3] - b[1]), 0.05) * grow[gi2];
 var eb = [b[0] - mx, b[1] - my, b[2] + mx, b[3] + my];
 encl = []; inBox = []; nearBox = [];
 for (var i = 0; i < CITIES.length; i++) {
 var o = CITIES[i];
 if (o === ci) continue;
 if (o.c[0] < eb[0] || o.c[0] > eb[2] || o.c[1] < eb[1] || o.c[1] > eb[3]) continue;
 // inside the city's own boundary = not a neighbor (enclaves ARE neighbors — they live in
 // the boundary's holes, which even-odd containment reports as outside)
 if (ci.poly && ringsContainPt(ci.poly.rings, o.c[0], o.c[1])) continue;
 if (ci.poly && ringCountAt(ci.poly.rings, o.c[0], o.c[1]) > 0) encl.push(o);
 else if (o.c[0] >= b[0] && o.c[0] <= b[2] && o.c[1] >= b[1] && o.c[1] <= b[3]) inBox.push(o);
 else nearBox.push(o);
 }
 if (encl.length + inBox.length + nearBox.length >= 2 || ci.pop >= 100000) break; // F: first ring; L: widen for rural
 }
 var byPop = function (a2, b2) { return b2.pop - a2.pop || (a2.name < b2.name ? -1 : 1); };
 encl.sort(byPop); inBox.sort(byPop); nearBox.sort(byPop);
 // seats: enclaves (reserved) → in-frame places (10 — deep enough that a Coronado-class bay
 // neighbor keeps its seat inside a metro bbox) → adjacent; draw-time collision culling declutters
 ci.__nb = encl.slice(0, 5).concat(inBox.slice(0, 10), nearBox).slice(0, 14);
 return ci.__nb;
 }
 // Class L zoom floor: the deep-zoom cap sits where the data runs out (no tier 3 in the pack) —
 // the reader can't zoom into emptiness and read it as a broken map (UX §4)
 function cityScaleCap() {
 var ci = cityRegCity() || (cityAnim.alpha > 0.5 ? cityRegLast : null);
 if (!ci) return Infinity;
 var rec = packRecs[cityKeyOf(ci)];
 var cls = rec && rec.data ? rec.data.cls : (ci.pop >= 100000 ? 'F' : 'L');
 return cls === 'L' ? cityEntryScale(ci) * 1.9 : Infinity;
 }
 // per-frame observability for the Phase-4 oracle + neighbor hitboxes (the sibling jump surface)
 var cityRegFrame = { g: null, cls: null, base: true, maskOn: false, ground: false, boundary: false, roads: { i: 0, p: 0, s: 0, r: 0, v: 0 }, rBucketsDrawn: 0, waterA: 0, waterL: 0, lm: 0, labels2: 0, labels3: 0, shields: 0, neighbors: 0, tier: null };
 var cityNbHits = [];
 function cityBoundaryRings(ci, dec) {
 if (dec && dec.boundary.length) return dec.boundary;
 if (ci.poly) return ci.poly.rings; // boot hit-zone geometry — honest BASE frame for ≥100k
 return null;
 }
 function drawCityRegister() {
 var a = cityRegAlphaNow();
 cityRegFrame = { g: null, cls: null, base: true, maskOn: false, ground: false, boundary: false, roads: { i: 0, p: 0, s: 0, r: 0, v: 0 }, rBucketsDrawn: 0, waterA: 0, waterL: 0, lm: 0, labels2: 0, labels3: 0, shields: 0, neighbors: 0, tier: null };
 cityNbHits.length = 0;
 if (a <= 0.01) return;
 var ci = cityRegCity() || cityRegLast;
 if (!ci || !ci.g) return;
 if (cityRegCity()) cityRegLast = ci;
 var key = cityKeyOf(ci);
 ensureCityPack(key);
 var rec = packRecs[key];
 if (packAutoFetch && (!rec || (!rec.data && rec.state !== 'loading' && rec.state !== 'failed' && rec.state !== 'nopack'))) requestPack(key);
 rec = packRecs[key];
 var la = rec && rec.data && rec.ydec ? packLayerAlphas(key) : null;
 if (la && !la.done) requestRender();
 var dec = la ? rec.ydec : null;
 var co = ci.cf ? countyById[ci.cf] : null;
 var rings = cityBoundaryRings(ci, dec);
 var tiers = cityTiers(ci);
 cityRegFrame.g = ci.g; cityRegFrame.cls = dec ? dec.cls : null; cityRegFrame.base = !dec;
 cityRegFrame.tier = { rat: +tiers.rat.toFixed(2), t2: +tiers.t2.toFixed(2), t3: +tiers.t3.toFixed(2) };
 var rest = !(dragging || flyRAF || inertiaRAF || autoOn);
 var bbox = dec ? dec.bbox : (ci.poly ? ci.poly.b : [ci.c[0] - 0.05, ci.c[1] - 0.05, ci.c[0] + 0.05, ci.c[1] + 0.05]);
 var xf = cityXf(bbox);
 function screenRingsPath(rs) { ctx.beginPath(); for (var r2 = 0; r2 < rs.length; r2++) { var ring = rs[r2], started = false; for (var k = 0; k < ring.length; k += 2) { var p2 = projection([ring[k], ring[k + 1]]); if (!p2) continue; if (!started) { ctx.moveTo(p2[0], p2[1]); started = true; } else ctx.lineTo(p2[0], p2[1]); } if (started) ctx.closePath(); } }
 // ---- 1) MASKS — the county stays the visual container (UX §1): beyond-county = Spec-B page
 // mask; inside-county-outside-city = a lighter page-tone dim. The lit city plate reads INWARD.
 if (co) {
 var encl = countyEnclaves(co);
 ctx.save();
 ctx.beginPath(); ctx.rect(0, 0, W, H); path(co); for (var e1 = 0; e1 < encl.length; e1++) path(encl[e1]);
 ctx.fillStyle = 'rgba(7,9,15,' + (MASK_ALPHA * a) + ')';
 ctx.fill('evenodd');
 ctx.restore();
 cityRegFrame.maskOn = true;
 }
 if (rings) {
 ctx.save();
 ctx.beginPath();
 if (co) path(co); else ctx.rect(0, 0, W, H);
 // append city rings in screen space (projection per point — boundary is a few hundred points)
 for (var rr2 = 0; rr2 < rings.length; rr2++) { var ring2 = rings[rr2], st2 = false; for (var k2 = 0; k2 < ring2.length; k2 += 2) { var pp2 = projection([ring2[k2], ring2[k2 + 1]]); if (!pp2) continue; if (!st2) { ctx.moveTo(pp2[0], pp2[1]); st2 = true; } else ctx.lineTo(pp2[0], pp2[1]); } if (st2) ctx.closePath(); }
 ctx.fillStyle = 'rgba(7,9,15,' + (0.80 * a) + ')';
 ctx.fill('evenodd');
 ctx.restore();
 }
 // ---- 2) GROUND + pack layers (clip to the boundary; even-odd keeps enclave holes unpainted)
 var groundA = a * (la ? la.relief : 1);
 if (rings && groundA > 0.02) {
 screenRingsPath(rings);
 ctx.fillStyle = 'rgba(36,38,32,' + (0.96 * groundA) + ')'; // Design C1 warm-dark plate
 ctx.fill('evenodd');
 cityRegFrame.ground = true;
 }
 if (dec && xf && rings) {
 ctx.save();
 screenRingsPath(rings); ctx.clip('evenodd');
 ctx.save(); xfApply(xf);
 var iw = function (px) { return px / xf.k; };
 // 2a. water (WATER slot) — matte fill + miniaturized shore lining (ocean grammar)
 if (dec.waterAPath) {
 ctx.globalAlpha = a * la.water;
 ctx.fillStyle = 'rgba(60,92,110,0.85)'; ctx.fill(dec.waterAPath, 'evenodd');
 ctx.save(); ctx.clip(dec.waterAPath, 'evenodd');
 ctx.lineWidth = iw(4); ctx.strokeStyle = 'rgba(169,182,172,0.12)'; ctx.stroke(dec.waterAPath);
 ctx.restore();
 cityRegFrame.waterA = dec.waterA.length;
 }
 if (dec.waterLPath) {
 ctx.globalAlpha = a * la.water;
 ctx.lineCap = 'round'; ctx.lineJoin = 'round';
 ctx.lineWidth = iw(1.0); ctx.strokeStyle = 'rgba(122,148,150,0.7)'; ctx.stroke(dec.waterLPath);
 cityRegFrame.waterL = dec.waterL.length;
 }
 // 2b. landmarks (tier 2) — parks / airports / campuses, real TIGER polygons only
 if (dec.lm.length && tiers.t2 > 0.02) {
 ctx.globalAlpha = a * la.water * tiers.t2;
 for (var li2 = 0; li2 < dec.lm.length; li2++) {
 var lm2 = dec.lm[li2];
 ctx.fillStyle = lm2.k === 'park' ? 'rgba(66,80,58,0.70)' : 'rgba(58,61,54,0.70)';
 ctx.fill(lm2.path, 'evenodd');
 }
 cityRegFrame.lm = dec.lm.length;
 }
 // 2c. roads — MTFCC inking table (Design C2); casings batched, then cores; minor → major.
 // Weights thicken ×1.15 per revealed tier (plate reading, not GIS zoom).
 var roadsA = a * la.roads;
 if (roadsA > 0.02) {
 var wMul = 1 + 0.15 * tiers.t2 + 0.15 * tiers.t3;
 ctx.lineCap = 'round'; ctx.lineJoin = 'round';
 // tier-3 mesh (residential + service) — bucket-culled to the viewport
 if (tiers.t3 > 0.02) {
 var t3A = roadsA * tiers.t3;
 var drawBuckets = function (cells, width, style, ck) {
 var drawn = 0, n3 = 0;
 for (var bi2 = 0; bi2 < cells.length; bi2++) {
 var cell = cells[bi2]; if (!cell) continue;
 var p00 = xfPt(xf, cell.b[0], cell.b[1]), p11 = xfPt(xf, cell.b[2], cell.b[3]);
 var x0 = Math.min(p00[0], p11[0]), x1 = Math.max(p00[0], p11[0]);
 var y0 = Math.min(p00[1], p11[1]), y1 = Math.max(p00[1], p11[1]);
 if (x1 < -30 || x0 > W + 30 || y1 < -30 || y0 > H + 30) continue;
 ctx.stroke(cell.p);
 drawn++; n3 += cell.n;
 }
 if (ck === 'r') { cityRegFrame.rBucketsDrawn = drawn; cityRegFrame.roads.r = n3; } else cityRegFrame.roads.v = n3;
 };
 ctx.globalAlpha = t3A;
 ctx.lineWidth = iw(0.5); ctx.strokeStyle = 'rgba(139,134,118,0.35)';
 drawBuckets(dec.vBuckets, 0.5, null, 'v');
 ctx.lineWidth = iw(0.55 * wMul); ctx.strokeStyle = 'rgba(139,134,118,0.50)';
 drawBuckets(dec.rBuckets, 0.55, null, 'r');
 }
 // tier-2 secondary arterials
 if (tiers.t2 > 0.02 && dec.roads.s.g.length) {
 ctx.globalAlpha = roadsA * tiers.t2;
 ctx.lineWidth = iw(1.1 * wMul); ctx.strokeStyle = 'rgba(201,203,162,0.75)'; ctx.stroke(dec.paths.s);
 cityRegFrame.roads.s = dec.roads.s.g.length;
 }
 // tier-1 cased classes: primary + interstate (casings then cores)
 ctx.globalAlpha = roadsA;
 if (dec.roads.p.g.length) { ctx.lineWidth = iw(3.0 * wMul); ctx.strokeStyle = 'rgba(20,22,18,0.85)'; ctx.stroke(dec.paths.p); }
 if (dec.roads.i.g.length) { ctx.lineWidth = iw(4.2 * wMul); ctx.strokeStyle = 'rgba(20,22,18,1)'; ctx.stroke(dec.paths.i); }
 if (dec.roads.p.g.length) { ctx.lineWidth = iw(1.5 * wMul); ctx.strokeStyle = '#d9d3b8'; ctx.stroke(dec.paths.p); cityRegFrame.roads.p = dec.roads.p.g.length; }
 if (dec.roads.i.g.length) { ctx.lineWidth = iw(2.0 * wMul); ctx.strokeStyle = 'rgba(230,190,120,0.95)'; ctx.stroke(dec.paths.i); cityRegFrame.roads.i = dec.roads.i.g.length; }
 }
 ctx.globalAlpha = 1;
 ctx.restore(); // un-transform
 ctx.restore(); // unclip
 }
 // approx-extent circle (polygon-less Class L) — honest dashed ring from Gazetteer land area
 if (!rings && dec && dec.approx) {
 var cp2 = projection(ci.c);
 if (cp2) {
 var rPx = dec.approx.r * (Math.PI / 180) * projection.scale();
 ctx.save();
 ctx.setLineDash([5, 4]);
 ctx.beginPath(); ctx.arc(cp2[0], cp2[1], Math.max(rPx, 12), 0, 7);
 ctx.strokeStyle = 'rgba(230,160,138,' + (0.55 * a) + ')'; ctx.lineWidth = 1.2; ctx.stroke();
 ctx.setLineDash([]);
 ctx.restore();
 cityRegFrame.boundary = true;
 }
 }
 // ---- 3) THE LEAF FRAME — clay outline over an outer seat, fillAlpha = 0 (Design C1)
 if (rings && groundA > 0.02) {
 screenRingsPath(rings);
 ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(7,9,15,' + (0.5 * groundA) + ')'; ctx.lineJoin = 'round'; ctx.stroke();
 screenRingsPath(rings);
 ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(230,160,138,' + (0.85 * groundA) + ')'; ctx.stroke();
 cityRegFrame.boundary = true;
 }
 // ---- 4) LABELS (screen space, halo = the dark ground you sit on — Design C3) ----
 var labA = a * (la ? la.labels : 1);
 var reserved = centroidLabelRects.slice();
 function overlaps(x0, y0, x1, y1) { for (var r3 = 0; r3 < reserved.length; r3++) { var b3 = reserved[r3]; if (x0 < b3[2] && x1 > b3[0] && y0 < b3[3] && y1 > b3[1]) return true; } return false; }
 ctx.save(); ctx.textAlign = 'center'; ctx.lineJoin = 'round';
 if (dec && labA > 0.02) {
 // landmark names — atlas italic for area features
 if (tiers.t2 > 0.05) {
 ctx.font = 'italic 11px Georgia,serif';
 for (var lj = 0; lj < dec.lm.length; lj++) {
 var lmm = dec.lm[lj]; if (!lmm.name) continue;
 var lp2 = projection(lmm.c); if (!lp2 || lp2[0] < -20 || lp2[0] > W + 20 || lp2[1] < 0 || lp2[1] > H) continue;
 var lw2 = ctx.measureText(lmm.name).width;
 if (overlaps(lp2[0] - lw2 / 2, lp2[1] - 10, lp2[0] + lw2 / 2, lp2[1] + 4)) continue;
 reserved.push([lp2[0] - lw2 / 2, lp2[1] - 10, lp2[0] + lw2 / 2, lp2[1] + 4]);
 ctx.globalAlpha = labA * tiers.t2;
 ctx.strokeStyle = 'rgba(12,13,16,0.9)'; ctx.lineWidth = 3; ctx.strokeText(lmm.name, lp2[0], lp2[1]);
 ctx.fillStyle = 'rgba(210,205,191,0.85)'; ctx.fillText(lmm.name, lp2[0], lp2[1]);
 }
 }
 // street names — MIDPOINT-HORIZONTAL v1 (UX-approved fallback; along-path deferred, see report)
 function streetLabels(cands, tierA, font, fill, cap) {
 if (tierA <= 0.05) return 0;
 ctx.font = font;
 var drawn = 0;
 for (var si2 = 0; si2 < cands.length && drawn < cap; si2++) {
 var cd2 = cands[si2];
 var sp2 = projection(cd2.c); if (!sp2 || sp2[0] < 20 || sp2[0] > W - 20 || sp2[1] < 20 || sp2[1] > H - 20) continue;
 var sw2 = ctx.measureText(cd2.n).width;
 if (overlaps(sp2[0] - sw2 / 2 - 2, sp2[1] - 9, sp2[0] + sw2 / 2 + 2, sp2[1] + 3)) continue;
 reserved.push([sp2[0] - sw2 / 2 - 2, sp2[1] - 9, sp2[0] + sw2 / 2 + 2, sp2[1] + 3]);
 ctx.globalAlpha = labA * tierA;
 ctx.strokeStyle = 'rgba(12,13,16,0.9)'; ctx.lineWidth = 3; ctx.strokeText(cd2.n, sp2[0], sp2[1]);
 ctx.fillStyle = fill; ctx.fillText(cd2.n, sp2[0], sp2[1]);
 drawn++;
 }
 return drawn;
 }
 if (rest) { // text passes are rest-gated (they're LOD dressing; motion frames keep the linework)
 cityRegFrame.labels2 = streetLabels(dec.lab2, tiers.t2, "500 9.5px 'Inter',system-ui,sans-serif", 'rgba(183,178,163,0.9)', 26);
 cityRegFrame.labels3 = streetLabels(dec.lab3, tiers.t3, "500 8.5px 'Inter',system-ui,sans-serif", 'rgba(183,178,163,0.75)', 40);
 }
 // shields (tier 1) — max 1 per route, collision-culled
 if (dec.shields.length) {
 for (var sh2 = 0; sh2 < dec.shields.length; sh2++) {
 var sh3 = dec.shields[sh2];
 var shp2 = projection(sh3.c); if (!shp2 || shp2[0] < 10 || shp2[0] > W - 10 || shp2[1] < 10 || shp2[1] > H - 10) continue;
 if (overlaps(shp2[0] - 8, shp2[1] - 9, shp2[0] + 8, shp2[1] + 9)) continue;
 reserved.push([shp2[0] - 8, shp2[1] - 9, shp2[0] + 8, shp2[1] + 9]);
 ctx.globalAlpha = a * (la ? la.roads : 1);
 if (sh3.kind === 'I') {
 ctx.beginPath();
 ctx.moveTo(shp2[0] - 6.5, shp2[1] - 6); ctx.quadraticCurveTo(shp2[0], shp2[1] - 9, shp2[0] + 6.5, shp2[1] - 6);
 ctx.lineTo(shp2[0] + 5.5, shp2[1] + 3); ctx.quadraticCurveTo(shp2[0], shp2[1] + 8.5, shp2[0] - 5.5, shp2[1] + 3);
 ctx.closePath();
 ctx.fillStyle = '#141612'; ctx.fill();
 ctx.strokeStyle = '#e6be78'; ctx.lineWidth = 1; ctx.stroke();
 ctx.font = "700 8px 'Inter',system-ui,sans-serif"; ctx.fillStyle = '#e6be78';
 ctx.fillText(sh3.num, shp2[0], shp2[1] + 2.5);
 } else {
 ctx.beginPath(); ctx.arc(shp2[0], shp2[1], 6, 0, 7);
 ctx.fillStyle = '#141612'; ctx.fill();
 ctx.strokeStyle = '#d9d3b8'; ctx.lineWidth = 1; ctx.stroke();
 ctx.font = "700 7.5px 'Inter',system-ui,sans-serif"; ctx.fillStyle = '#d9d3b8';
 ctx.fillText(sh3.num, shp2[0], shp2[1] + 2.5);
 }
 cityRegFrame.shields++;
 }
 }
 }
 // ---- 5) NEIGHBORS (the sibling jump — the ONLY interactive map feature at this register).
 // Deliberately greyed dim tier; hover promotes to clay-lit (Design C4). Dot + label = targets.
 var nbs = cityNeighbors(ci);
 ctx.textAlign = 'left';
 for (var nb2 = 0; nb2 < nbs.length; nb2++) {
 var nb3 = nbs[nb2];
 var np2 = projection(nb3.c); if (!np2) continue;
 if (np2[0] < -30 || np2[0] > W + 30 || np2[1] < -30 || np2[1] > H + 30) continue;
 var hov2 = nb3 === hoverCity;
 ctx.globalAlpha = a;
 ctx.beginPath(); ctx.arc(np2[0], np2[1], hov2 ? 3.2 : 2, 0, 7);
 ctx.fillStyle = hov2 ? '#f0c9a8' : 'rgba(139,134,118,0.9)'; ctx.fill();
 ctx.font = (hov2 ? '700 10.5px ' : '600 10px ') + "'Inter',system-ui,sans-serif";
 var nlx = np2[0] + 7, nly = np2[1] + 3, nw2 = ctx.measureText(nb3.name).width;
 var nx0 = nlx - 2, ny0 = nly - 10, nx1 = nlx + nw2 + 2, ny1 = nly + 3;
 var drawL = hov2 || !overlaps(nx0, ny0, nx1, ny1);
 if (drawL) {
 reserved.push([nx0, ny0, nx1, ny1]);
 ctx.strokeStyle = 'rgba(12,13,16,0.85)'; ctx.lineWidth = 3; ctx.strokeText(nb3.name, nlx, nly);
 ctx.fillStyle = hov2 ? '#f0c9a8' : '#8b8676'; ctx.fillText(nb3.name, nlx, nly);
 }
 cityNbHits.push({ x: np2[0], y: np2[1], r: 7, rect: drawL ? [nx0, ny0, nx1, ny1] : null, city: nb3 });
 cityRegFrame.neighbors++;
 }
 ctx.globalAlpha = 1;
 ctx.restore();
 }

 function ringsPath(rings) { // draw a set of lon/lat rings to current ctx path
 for (var r = 0; r < rings.length; r++) {
 var ring = rings[r];
 for (var i = 0; i < ring.length; i++) { var p = projection(ring[i]); if (!p) { continue; } if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }
 ctx.closePath();
 }
 }
 function polyline(pts) { ctx.beginPath(); for (var i = 0; i < pts.length; i++) { var p = projection(pts[i]); if (!p) continue; if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); } }

 // drawLocal — the exemplar detail layer, driven by the PACK CACHE (not inlined data). BASE state
 // (pack absent) draws nothing here: the base geometry beneath (county mesh, city dots/labels,
 // localtitle) IS the honest register — same surface every non-exemplar city shows. On pack arrival
 // in-register the layers develop relief→water→roads→labels, alpha ramps only (Design ).
 function drawLocal(alpha) {
 if (alpha <= 0.01) return;
 var ad = lod().drill; if (!ad) return;
 if (!packRecs[ad.key] || !packRecs[ad.key].data) { if (PACKS[ad.key]) requestPack(ad.key); return; } // free-zoom entry also triggers the fetch
 var rec = packRecs[ad.key];
 var la = packLayerAlphas(ad.key);
 if (!la.done) requestRender(); // keep the development animating (coalesced rAF)
 var m = rec.data.area.map, boundary = rec.data.area.boundary;
 // Phase 4: when the GENERATED street pack is rendering this exemplar's register (SD at city
 // depth), the curated pack becomes an OVERLAY — districts + feature labels on top of the
 // generated plate. Ground/water/roads/boundary come from drawCityRegister (Spec C values —
 // "the standard now feeds back", Design C4). Falls back to the full curated draw whenever
 // the generated pack is absent/failed (honest BASE, mockup parity).
 var curCity4 = cityRegCity();
 var genRec4 = curCity4 ? packRecs[cityKeyOf(curCity4)] : null;
 var overlayOnly = !!(m.scale === 'city' && curCity4 && isExemplarCity(curCity4) && genRec4 && genRec4.ydec && cityAnim.alpha > 0.4);
 ctx.save(); ctx.globalAlpha = alpha * la.relief;
 if (!overlayOnly) {
 // land base fill (calm) — ground tone is part of the RELIEF layer
 ctx.beginPath(); ringsPath(boundary.rings); ctx.fillStyle = 'rgba(30,32,26,0.96)'; ctx.fill();
 // clip to boundary
 ctx.save(); ctx.beginPath(); ringsPath(boundary.rings); ctx.clip();

 if (m.scale === 'county') {
 // relief raster placed by bbox corners
 var im = rec.reliefImg;
 if (m.relief && im && im.complete && im.naturalWidth) {
 var rb = m.relief.bbox; var nw = projection([rb[0], rb[3]]), se = projection([rb[2], rb[1]]);
 if (nw && se) { ctx.globalAlpha = alpha * 0.92 * la.relief; ctx.drawImage(im, nw[0], nw[1], se[0] - nw[0], se[1] - nw[1]); ctx.globalAlpha = alpha * la.relief; }
 }
 // contours (§3.4 warm relief ink #6b5a3c)
 ctx.strokeStyle = 'rgba(107,90,60,0.4)'; ctx.lineWidth = 0.5;
 for (var c = 0; c < (m.contours || []).length; c++) { polyline(m.contours[c].points); ctx.stroke(); }
 // rivers — WATER layer
 ctx.globalAlpha = alpha * la.water;
 ctx.strokeStyle = 'rgba(94,127,136,0.75)'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
 for (var rv = 0; rv < (m.rivers || []).length; rv++) { polyline(m.rivers[rv].points); ctx.stroke(); }
 } else {
 // city: water areas (WATER layer) then roads (ROADS layer)
 ctx.globalAlpha = alpha * la.water;
 ctx.fillStyle = 'rgba(60,92,110,0.85)';
 for (var wa = 0; wa < (m.water_areas || []).length; wa++) { ctx.beginPath(); ringsPath(m.water_areas[wa].rings); ctx.fill(); }
 // arterials (§3.4 warm coastal-lowland tone #c9cba2)
 ctx.globalAlpha = alpha * la.roads;
 ctx.strokeStyle = 'rgba(201,203,162,0.55)'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
 for (var ra = 0; ra < (m.roads || []).length; ra++) { if (m.roads[ra].cls !== 'arterial') continue; polyline(m.roads[ra].points); ctx.stroke(); }
 // interstates (casing + line)
 for (var ic = 0; ic < (m.roads || []).length; ic++) { if (m.roads[ic].cls !== 'interstate') continue; polyline(m.roads[ic].points); ctx.strokeStyle = 'rgba(20,22,18,0.9)'; ctx.lineWidth = 3.4; ctx.stroke(); }
 for (var il = 0; il < (m.roads || []).length; il++) { if (m.roads[il].cls !== 'interstate') continue; polyline(m.roads[il].points); ctx.strokeStyle = 'rgba(230,190,120,0.95)'; ctx.lineWidth = 1.8; ctx.stroke(); }
 }
 ctx.restore(); // unclip

 // boundary outline (engraved edge) — frame belongs to the ground/RELIEF layer
 ctx.globalAlpha = alpha * la.relief;
 ctx.beginPath(); ringsPath(boundary.rings); ctx.strokeStyle = 'rgba(230,160,138,0.85)'; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke();
 } // end !overlayOnly

 // labels — towns/districts + features (constant screen size) — LABELS layer, ink lands last
 ctx.globalAlpha = alpha * la.labels;
 ctx.textAlign = 'center';
 var marks = (m.scale === 'county' ? (m.towns || []) : (m.districts || []));
 for (var t = 0; t < marks.length; t++) {
 var mk = marks[t], mp = projection([mk.lon, mk.lat]); if (!mp) continue;
 if (mk.primary) {
 ctx.beginPath(); ctx.arc(mp[0], mp[1], 5, 0, 7); ctx.fillStyle = '#e6a08a'; ctx.fill();
 ctx.beginPath(); ctx.arc(mp[0], mp[1], 10, 0, 7); ctx.strokeStyle = 'rgba(230,160,138,0.8)'; ctx.lineWidth = 1.2; ctx.stroke();
 ctx.font = "700 12px 'Inter',system-ui,sans-serif"; ctx.fillStyle = '#f4f1e8';
 haloText(mk.name.toUpperCase(), mp[0], mp[1] - 15);
 } else {
 ctx.beginPath(); ctx.arc(mp[0], mp[1], 2.6, 0, 7); ctx.fillStyle = 'rgba(220,215,201,0.85)'; ctx.fill();
 ctx.font = "500 11px 'Inter',system-ui,sans-serif"; ctx.fillStyle = 'rgba(220,215,201,0.9)';
 haloText(mk.name, mp[0], mp[1] - 8);
 }
 }
 ctx.font = "italic 12px Georgia,serif"; ctx.fillStyle = 'rgba(210,205,191,0.85)';
 for (var f = 0; f < (m.features || []).length; f++) { var ft = m.features[f], fp = projection([ft.lon, ft.lat]); if (!fp) continue; haloText(ft.name, fp[0], fp[1]); }
 ctx.restore();
 }
 function haloText(s, x, y) {
 ctx.save(); ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(12,13,16,0.9)'; ctx.lineWidth = 3; ctx.strokeText(s, x, y); ctx.fillText(s, x, y); ctx.restore();
 }

 // ---------- hotspot pins + drill markers ----------
 function drawPins(worldA) {
 if (worldA <= 0.05) return;
 ctx.save(); ctx.globalAlpha = worldA;
 var t = (performance.now() % 2600) / 2600, amb = ambient();
 for (var i = 0; i < PINS.length; i++) {
 var pn = PINS[i]; if (!visiblePt(pn.c)) continue;
 var p = projection(pn.c); if (!p) continue;
 var war = pn.theater, col = war ? '224,96,96' : '230,160,138', isHot = hoverPin && hoverPin.id === pn.id;
 // pulse ring (liveness)
 if (amb > 0.05) { var rad = (war ? 6 : 4) + t * (war ? 22 : 15); ctx.beginPath(); ctx.arc(p[0], p[1], rad, 0, 7); ctx.strokeStyle = 'rgba(' + col + ',' + ((1 - t) * 0.55 * amb) + ')'; ctx.lineWidth = 1.4; ctx.stroke(); }
 ctx.beginPath(); ctx.arc(p[0], p[1], war ? 5 : 3.4, 0, 7); ctx.fillStyle = 'rgb(' + col + ')';
 ctx.shadowColor = 'rgba(' + col + ',.9)'; ctx.shadowBlur = (war ? 14 : 9) * (0.4 + 0.6 * amb); ctx.fill(); ctx.shadowBlur = 0;
 if (isHot) { ctx.beginPath(); ctx.arc(p[0], p[1], (war ? 5 : 3.4) + 5, 0, 7); ctx.strokeStyle = 'rgb(' + col + ')'; ctx.lineWidth = 1.4; ctx.stroke(); }
 // dateline label for the theater + hovered
 if (war || isHot) { ctx.font = "600 10px 'Inter',sans-serif"; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(244,241,232,0.9)'; haloText(pn.label.toUpperCase(), p[0], p[1] - (war ? 12 : 9)); }
 }
 // drill markers (San Diego / Virginia Beach) — the two local desks
 DRILL_KEYS.forEach(function (k) {
 var d = DRILLS[k]; if (!visiblePt(d.center)) return;
 var p = projection(d.center); if (!p) return;
 var isHot = hoverDrill === k;
 ctx.beginPath(); ctx.moveTo(p[0], p[1] - 7); ctx.lineTo(p[0] + 5, p[1] - 15); ctx.lineTo(p[0] - 5, p[1] - 15); ctx.closePath();
 ctx.fillStyle = isHot ? '#f0c9a8' : '#cbb58a'; ctx.fill();
 ctx.beginPath(); ctx.arc(p[0], p[1], 2.4, 0, 7); ctx.fillStyle = '#f4f1e8'; ctx.fill();
 ctx.font = "600 9.5px 'Inter',sans-serif"; ctx.textAlign = 'center'; ctx.fillStyle = isHot ? '#f4f1e8' : 'rgba(203,181,138,0.95)';
 haloText(d.name.toUpperCase() + ' ↓', p[0], p[1] - 20);
 });
 ctx.restore();
 }

 // ---------- master render ----------
 var raf = null, lastMs = 0, frameStamp = 0;
 function render() {
 var t0 = performance.now();
 frameStamp++; // per-frame stamp — invalidates the waterLandCtx cache (F1) once per frame
 ctx.clearRect(0, 0, W, H);
 physFrameReset(); // per-frame physical-layer counters (Spec-A budget caps are a code invariant)
 centroidLabelRects.length = 0; // reset per-frame container-label bboxes (city-label collision seed)
 computeNav(); // NAV derives from the projection (center + scale) every frame
 var o = lod(), amb = ambient();
 // world skin — Matte Atlas, the locked look (plate-baked at rest — one drawImage per steady frame)
 if (o.world > 0.01) drawGlobeMattePlated(o.world);
 // (Phase 2 §4) nation SELECTED (clicked & framed) — the stronger tier + serif label + underline.
 if (selCountry && selCountry !== hoverCountry && o.world > 0.2 && visiblePt(selCountry.__c || G.geoCentroid(selCountry))) {
 softGlowRegion(selCountry, SEL_FILL, SEL_SOFT, 0, 14, true);
 var scp = projection(selCountry.__c || G.geoCentroid(selCountry));
 if (scp) selectedLabel((selCountryName || '').toUpperCase(), scp[0], scp[1]);
 }
 // (Phase 2 §4.1) nation HOVER — clay fill + clipped soft-light warm glow + glow stroke.
 if (hoverCountry && o.world > 0.2) {
 softGlowRegion(hoverCountry, HOVER_FILL, HOVER_SOFT, 1.6, 8, false);
 }
 // US detail — the frame-not-fill state machine (nation outline / state rim / county rim / hover child)
 drawUSDetail(o);
 // county isolation register (Phase 3): mask + pack detail + frame + places — above the US
 // detail context, below the exemplar local plates
 drawCountyRegister();
 // city register (Phase 4): masks + street plate + leaf frame + neighbors — between the county
 // context and the curated exemplar overlays
 drawCityRegister();
 // the curated exemplar plate belongs to ITS OWN register: when the live city register is a
 // NON-exemplar sibling (Coronado next to SD), the exemplar must read as dimmed county context,
 // not a lit curated plate bleeding through the leaf frame (UX §1/§2 dim tier)
 var curReg = cityRegCity() || (cityAnim.alpha > 0.01 ? cityRegLast : null);
 var localMul = curReg && !isExemplarCity(curReg) ? (1 - cityAnim.alpha) : 1;
 drawLocal(o.local * localMul);
 // outside-the-mask floor (UX §1.1): generic city dots/labels AND world pins/drill markers all
 // fade out as isolation OR the city register fades in — the register's own neighbor labels are
 // the only place marks inside the leaf frame's view
 drawCities(o.cities * (1 - isoAnim.alpha) * (1 - cityAnim.alpha));
 drawPins(o.world * (1 - isoAnim.alpha) * (1 - cityAnim.alpha));
 lastMs = performance.now() - t0;
 syncHUD(o);
 }
 function requestRender() { if (!raf) raf = requestAnimationFrame(function () { raf = null; render(); }); }

 // ---------- interaction: drag (roll-locked two-axis) + inertia ----------
 var ROT_SENS = 78;
 var dragging = false, moved = false, lastX = 0, lastY = 0, prevT = 0, vel = null, inertiaRAF = null, autoOn = true;
 function stopInertia() { if (inertiaRAF) cancelAnimationFrame(inertiaRAF); inertiaRAF = null; vel = null; }
 function stopAuto() { autoOn = false; }
 function onDown(x, y) { stopInertia(); stopAuto(); dragging = true; moved = false; lastX = x; lastY = y; prevT = performance.now(); vel = null; canvas.classList.add('dragging'); }
 function onDrag(x, y) {
 var dx = x - lastX, dy = y - lastY; lastX = x; lastY = y;
 var kd = ROT_SENS / projection.scale(), r = projection.rotate();
 projection.rotate([r[0] + dx * kd, clamp(r[1] - dy * kd, -90, 90), 0]);
 var now = performance.now(), dt = Math.max(1, now - prevT); vel = [dx * kd / dt, -dy * kd / dt]; prevT = now;
 render();
 }
 function onUp() {
 if (!dragging) return; dragging = false; canvas.classList.remove('dragging');
 if (vel && (Math.abs(vel[0]) > 0.003 || Math.abs(vel[1]) > 0.003) && performance.now() - prevT < 90) {
 var v = [vel[0], vel[1]], last = performance.now();
 var spin = function (t) {
 var dt = Math.min(40, t - last); last = t; var r = projection.rotate();
 projection.rotate([r[0] + v[0] * dt, clamp(r[1] + v[1] * dt, -90, 90), 0]); render();
 var decay = Math.pow(0.94, dt / 16); v[0] *= decay; v[1] *= decay;
 if (Math.abs(v[0]) > 0.0005 || Math.abs(v[1]) > 0.0005) inertiaRAF = requestAnimationFrame(spin); else { inertiaRAF = null; isoSoftClamp(); }
 };
 inertiaRAF = requestAnimationFrame(spin);
 } else isoSoftClamp();
 }
 // soft-clamped pan while isolated (UX §1.2): the county's footprint may not leave the viewport
 // entirely — rubber-band back with the existing fly easing. No dead ends of pure mask.
 function isoSoftClamp() {
 if (flyRAF) return;
 // city register: soft-clamp the pan to the city bbox + ~25% margin (UX §1 rubber-band)
 var ci = cityRegCity();
 if (ci) {
 var b = null;
 var rec = packRecs[cityKeyOf(ci)];
 if (rec && rec.ydec) b = rec.ydec.bbox; else if (ci.poly) b = ci.poly.b;
 if (b) {
 var mx = (b[2] - b[0]) * 0.25, my = (b[3] - b[1]) * 0.25;
 var cg = centerCoord();
 if (cg[0] < b[0] - mx || cg[0] > b[2] + mx || cg[1] < b[1] - my || cg[1] > b[3] + my) {
 flyTo([clamp(cg[0], b[0] - mx, b[2] + mx), clamp(cg[1], b[1] - my, b[3] + my)], projection.scale(), 320);
 }
 }
 return;
 }
 if (!isoActive()) return;
 var co = countyById[isoLatch]; if (!co) return;
 if (!countyOnScreen(co, 0.05)) flyTo(countyAnchor(co), projection.scale(), 320);
 }

 // ---------- zoom (wheel/pinch) — clamped, no roll ----------
 function zoomBy(factor) {
 stopInertia(); stopAuto(); stopFly();
 // Class L zoom floor (UX §4): the cap sits where the pack's data runs out — zooming into
 // emptiness must not read as a broken map
 var target = clamp(projection.scale() * factor, minScale, Math.min(maxScale(), cityScaleCap()));
 if (target === projection.scale()) return;
 projection.scale(target); render(); updateZoomBtns();
 }

 // ---------- guided fly-to (the zoom journey) ----------
 var flyRAF = null;
 function stopFly() { if (flyRAF) cancelAnimationFrame(flyRAF); flyRAF = null; isoFlyCommit = null; }
 function flyTo(center, scale, ms, done, guardFips) {
 stopInertia(); stopAuto(); stopFly();
 isoFlyCommit = guardFips || null; // B1: set AFTER stopFly (which cleared it) so the very first
 // synchronous step()/computeNav already sees the guard and holds the committed county's mask.
 var r0 = projection.rotate(), s0 = projection.scale();
 var r1 = [-center[0], clamp(-center[1], -90, 90), 0], s1 = scale;
 // shortest longitude path
 var dLon = ((r1[0] - r0[0] + 540) % 360) - 180;
 var t0 = performance.now(); ms = ms || 1100;
 (function step(t) {
 var k = clamp((t - t0) / ms, 0, 1), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
 projection.rotate([r0[0] + dLon * e, r0[1] + (r1[1] - r0[1]) * e, 0]);
 projection.scale(Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * e));
 render(); updateZoomBtns();
 if (k < 1) flyRAF = requestAnimationFrame(step); else { flyRAF = null; isoFlyCommit = null; if (done) done(); }
 })(t0);
 }
 // level targets for a drill: 1 nation,2 state,3 region,4 local
 function levelTarget(drill, lvl) {
 if (lvl === 0) return { c: [12, 28], s: baseScale };
 if (lvl === 1) return { c: [-96, 39.5], s: fitScales.nation };
 if (lvl === 2) return { c: drill.cState, s: drill.sState };
 if (lvl === 3) return { c: drill.cRegion, s: drill.sRegion };
 return { c: drill.center, s: drill.sLocal };
 }
 function flyToLevel(drillKey, lvl) {
 if (lvl === 0) { selCountry = null; selCountryName = null; closeCard(); flyTo([12, 28], baseScale, 1000); return; }
 var d = DRILLS[drillKey], tg = levelTarget(d, lvl);
 currentDrillKey = drillKey;
 if (lvl === 4) requestPack(drillKey); // detail pack loads DURING the fly — landing is BASE, detail develops on arrival
 flyTo(tg.c, tg.s, 1150, function () { if (lvl >= 2) openLevelFeed(drillKey, lvl); else closeCard(); });
 }

 // ---------- HUD: crumbs, drills, zoom (no skin switcher — Matte only) ----------
 var currentDrillKey = 'sandiego';
 root.querySelectorAll('.drills .dl').forEach(function (el) {
 el.addEventListener('click', function () { flyToLevel(el.dataset.drill, 4); });
 el.addEventListener('mouseenter', function () { hoverDrill = el.dataset.drill; requestRender(); });
 el.addEventListener('mouseleave', function () { hoverDrill = null; requestRender(); });
 });

 // crumbs reflect NAV — World › United States › {State} › {County} › {City} (frame-not-fill journey)
 var crumbsEl = root.querySelector('#crumbs'), leveltagEl = root.querySelector('#leveltag');
 // persistent city/local title (edit #3a). OUTER carries the on/off class; INNER is the rebuilt
 // content — #packstatus lives between them as a persistent sibling (survives content rebuilds).
 var ltOuter = root.querySelector('#localtitle');
 var localTitleEl = ltOuter ? ltOuter.querySelector('#lt-inner') : null;
 // Fix 1 (2026-07-18): the city chip's × steps UP one register (city→county), the SAME target as the
 // county breadcrumb node and the first non-search Esc-ladder step (see onKeydown Escape branch). It
 // is NOT closeCard() — that only hides the feed. aria-label is set dynamically in syncHUD.
 var ltCloseEl = ltOuter ? ltOuter.querySelector('#lt-close') : null;
 if (ltCloseEl) ltCloseEl.addEventListener('click', function () { navTo(NAV.countyFips ? 3 : 2); });
 function currentLevel() { return NAV.level; }
 // county-register chrome (Phase 3): `.hint` copy swap (UX §6) + the root `iso` class that gates
 // the ≤720px bottom-sheet CSS. Default hint restored on exit.
 var hintEl = root.querySelector('.hud.hint');
 var hintDefault = hintEl ? hintEl.innerHTML : '';
 var hintKey = '__init__';
 function syncIsoChrome(coFeat) {
 var iso = isoActive() && coFeat;
 var cityReg = cityRegCity();
 // the ≤720px bottom-sheet grammar (P3 precedent) applies at BOTH deep registers (UX §6.2)
 root.classList.toggle('iso', !!(iso || cityReg));
 if (!hintEl) return;
 // F2 honesty (Design sign-off): the caption may claim "every place is on the map" ONLY over a
 // non-empty place layer. A pack-complete county with zero places (placesNone — Kalawao-class)
 // says so; while the pack is in flight or failed the caption never overclaims.
 var fips = iso ? String(coFeat.id) : '';
 var plCount = iso ? ((countyPlaceList[fips] || citiesByCounty[fips] || []).length) : 0;
 var pRec = iso ? packRecs['co' + fips] : null;
 var pState = pRec ? pRec.state : 'idle';
 var k = cityReg ? 'city:' + cityReg.id : iso ? fips + '|' + plCount + '|' + pState : '';
 if (k === hintKey) return;
 hintKey = k;
 if (cityReg) { hintEl.innerHTML = '<div>You’ve arrived — the streets are the map. Click a neighboring town to jump to it.</div>'; return; }
 if (!iso) { hintEl.innerHTML = hintDefault; return; }
 var disp = countyDisplayName(coFeat);
 // F4 (Design round-2): the pack-state branches WIN until the pack is COMPLETE. Boot-level
 // places make plCount > 0 for most counties, so a plCount-first order claimed "every place is
 // on the map" while #packstatus honestly said "boundaries and main features only" — two
 // contradictory sentences on one screen through LOADING and all of FAILED. Never overclaim.
 if (isIndepFips(fips)) hintEl.innerHTML = '<div><b>' + esc(disp.replace(/\s+city$/i, '')) + '</b> is an independent city — click it to open the street map.</div>';
 else if (pState === 'failed') hintEl.innerHTML = '<div><b>' + esc(disp) + '</b> — showing boundaries and main features.</div>';
 else if (pState !== 'complete') hintEl.innerHTML = '<div>Loading the places in <b>' + esc(disp) + '</b>…</div>';
 else if (plCount) hintEl.innerHTML = '<div>Every place in <b>' + esc(disp) + '</b> is on the map — hover one, or search, top-left.</div>';
 else hintEl.innerHTML = '<div><b>' + esc(disp) + '</b> has no Census-listed places — the county itself is the map.</div>';
 }
 // fly to a NAV breadcrumb node (deterministic targets from the current NAV chain)
 function navTo(level) {
 // active-node re-click = re-open the feed card without re-flying — a closed card is always
 // recoverable from the breadcrumb (UX §4.1; confirmed net-new, added here)
 if (level === NAV.level && level >= 2 && !flyRAF) {
 if (level === 2 && NAV.stateFips) { openGenericFeed('tpl_state', stateName(stateByFips(NAV.stateFips)), 'state:' + NAV.stateFips); return; }
 if (level === 3 && NAV.countyFips && countyById[NAV.countyFips]) { openCountyFeed(countyById[NAV.countyFips]); return; }
 if (level === 4 && NAV.cityId && cityById[NAV.cityId]) {
 var rci = cityById[NAV.cityId];
 if (isExemplarCity(rci)) openLevelFeed(rci.name === 'San Diego' ? 'sandiego' : 'vabeach', 4); else openCityView(rci);
 return;
 }
 }
 if (level <= 2) isoReleaseLatch(); // stepping out of the county register — mask fades with the fly (UX §3.2)
 if (level === 0) { navReset(); closeCard(); hideSearch(); flyTo([12, 28], baseScale, 900); return; }
 if (level === 1) { flyTo([-96, 39.5], fitScales.nation, 1000, closeCard); return; }
 if (level === 2 && NAV.stateFips) { var st = stateByFips(NAV.stateFips); var c = st.__c || G.geoCentroid(st); flyTo(c, fitFeature(st, c, 0.82), 1050, function () { openGenericFeed('tpl_state', stateName(st), 'state:' + NAV.stateFips); }); return; }
 if (level === 3 && NAV.countyFips) { enterCounty(countyById[NAV.countyFips]); return; }
 if (level === 4 && NAV.cityId && cityById[NAV.cityId]) { enterCity(cityById[NAV.cityId]); return; }
 }
 function syncHUD(o) {
 var lvl = NAV.level;
 // build labels present at each depth from NAV
 var stFeat = NAV.stateFips ? stateByFips(NAV.stateFips) : null;
 var coFeat = NAV.countyFips ? countyById[NAV.countyFips] : null;
 var ciFeat = NAV.cityId ? cityById[NAV.cityId] : null;
 var nodes = [{ lvl: 0, name: 'World' }, { lvl: 1, name: 'United States' }];
 // single-county federal district (DC): ONE node — `WORLD › UNITED STATES › DISTRICT OF
 // COLUMBIA`, never `DC › DC` (UX §5.2). The node targets the county register (the level that
 // actually exists — its state band is empty by geometry).
 var dcMerge = stFeat && coFeat && singleCountyState[String(stFeat.id)];
 if (stFeat && !dcMerge) nodes.push({ lvl: 2, name: stateName(stFeat) });
 if (coFeat) nodes.push({ lvl: 3, name: dcMerge ? countyDisplayName(coFeat) : ((coFeat.properties && coFeat.properties.name) ? coFeat.properties.name : 'County') });
 if (ciFeat) nodes.push({ lvl: 4, name: ciFeat.name });
 var html = '';
 for (var i = 0; i < nodes.length; i++) { if (i) html += '<span class="sep">›</span>'; html += '<button class="cb' + (nodes[i].lvl === lvl ? ' here' : '') + '" data-lvl="' + nodes[i].lvl + '">' + esc(nodes[i].name) + '</button>'; }
 if (crumbsEl.__k !== html) {
 crumbsEl.innerHTML = html; crumbsEl.__k = html;
 crumbsEl.querySelectorAll('.cb').forEach(function (b) { b.addEventListener('click', function () { navTo(+b.dataset.lvl); }); });
 }
 var names = ['Overview — the world, alive', 'United States', stFeat ? stateName(stFeat) : '', coFeat ? countyDisplayName(coFeat) : '', ciFeat ? (ciFeat.name + ' — local') : ''];
 leveltagEl.textContent = names[lvl] || ''; leveltagEl.classList.toggle('on', lvl > 0 && lvl < 4);
 syncIsoChrome(coFeat);
 // persistent WHERE-AM-I title at city/local level (works for ANY city, not just SD/VB), with the
 // ＋ Add to my newsfeed affordance. pid = the city's stable id so searched + drilled share one entry.
 if (localTitleEl) {
 var atLocal = lvl === 4 && ciFeat;
 var ltPid = atLocal ? ciFeat.id : '';
 var ltKey = atLocal ? (ciFeat.name + '|' + ciFeat.state + '|' + ltPid + '|' + (pinnedFeeds[ltPid] ? 1 : 0)) : '';
 if (localTitleEl.__k !== ltKey) {
 localTitleEl.innerHTML = atLocal
 ? '<span class="lt-city">' + esc(ciFeat.name.toUpperCase()) + '</span><span class="lt-state">' + esc(ciFeat.state.toUpperCase()) + '</span>' + addFeedBtnHTML(ltPid, ciFeat.name)
 : '';
 localTitleEl.__k = ltKey;
 }
 ltOuter.classList.toggle('on', !!atLocal);
 // Fix 1: chip × reads as up-navigation, distinct from the card's "Close". Parent = the register
 // the × lands on (county where one exists, else state — mirrors navTo(NAV.countyFips ? 3 : 2)).
 if (atLocal && ltCloseEl) {
 var ltParent = coFeat ? countyDisplayName(coFeat) : (stFeat ? stateName(stFeat) : 'the map');
 ltCloseEl.setAttribute('aria-label', 'Back to ' + ltParent);
 }
 if (atLocal && toast) toast.classList.remove('on');
 }
 syncSearchMount();
 syncPackStatus();
 updateZoomBtns();
 }
 var zin = root.querySelector('#zin'), zout = root.querySelector('#zout'), zreset = root.querySelector('#zreset');
 function updateZoomBtns() { zout.disabled = projection.scale() <= minScale + 0.5; zin.disabled = projection.scale() >= Math.min(maxScale(), cityScaleCap()) - 0.5; }
 zin.addEventListener('click', function () { zoomBy(1.35); });
 zout.addEventListener('click', function () { zoomBy(1 / 1.35); });
 zreset.addEventListener('click', function () { selCountry = null; selCountryName = null; closeCard(); flyTo([12, 28], baseScale, 900); });

 // ---------- hover + click routing (layer-aware — only the active CHILD layer is hit-tested) ----------
 var hoverPin = null, hoverCountry = null, hoverDrill = null, hoverState = null, hoverCounty = null, hoverCity = null, lastClick = null;
 var selCountry = null, selCountryName = null; // the clicked-and-framed foreign nation (US never floods)
 var tip = root.querySelector('#tip'), toast = root.querySelector('#toast'), toastT = null;
 function pos(ev) { var r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }

 // NAV derives from the projection each frame — clicks/search/breadcrumbs just FLY, NAV follows. So
 // free-zoom and explicit navigation reach the same container/child state with no dual bookkeeping.
 function stateAt(geo) { if (!geo) return null; for (var s = 0; s < usStates.length; s++) if (G.geoContains(usStates[s], geo)) return usStates[s]; return null; }
 // Return the SMALLEST containing county — VA/MD/MO independent cities are tiny county-equivalents nested
 // inside a surrounding county, and at 10m simplification both can contain a point; the small one wins.
 function countyBoxArea(co) { return co.__ba != null ? co.__ba : (co.__ba = Math.max(1e-9, bboxAreaDeg(G.geoBounds(co)))); }
 function countyAt(geo, stateFeat) {
 if (!geo) return null;
 // tiny/degenerate county proximity FIRST (global) — wins for independent cities + water-gap counties
 var tc = tinyCountyNear(geo); if (tc) return tc;
 if (!stateFeat) return null;
 var list = countiesByStateFips[String(stateFeat.id)] || [], best = null, ba = Infinity;
 for (var i = 0; i < list.length; i++) { if (G.geoContains(list[i], geo)) { var a = countyBoxArea(list[i]); if (a < ba) { ba = a; best = list[i]; } } }
 return best;
 }
 // free-zoom city resolution at viewport centre — BOUNDARY-CONTAINMENT first (which city's real
 // polygon contains the centre; zooming into downtown LA ⇒ NAV city = Los Angeles), population-
 // weighted-nearest dot fallback for points in no ≥100k city's boundary (Phase 0 identity fix).
 function cityAtCenter() {
 var c = centerCoord();
 if (!QC_LEGACY_CITYPICK) { var pc = cityPolyAt(c); if (pc) return pc; }
 // F1 (Design sign-off): an OVER-WATER centre is no city's boundary ground, so poly cities
 // rejoin the population-weighted pick there — offshore of SD the register resolves to San
 // Diego, not to whichever enclave dot happens to sit nearest (the Phase-0 bug class, offshore).
 // On LAND the Phase-0 rule stands: a poly city claims ground by containment only.
 var overWater = !QC_LEGACY_CITYPICK && !G.geoContains(usNation, c);
 var best = null, be = Infinity;
 for (var i = 0; i < CITIES.length; i++) {
 var ci = CITIES[i];
 if (!QC_LEGACY_CITYPICK && ci.poly && !overWater) continue; // poly cities claim ground by containment only
 var d = G.geoDistance(c, ci.c); if (d >= 1.2) continue;
 var eff = QC_LEGACY_CITYPICK ? d : d / Math.log10(Math.max(ci.pop, 1000));
 if (eff < be) { be = eff; best = ci; }
 }
 return best;
 }
 function computeNav() {
 NAV.stateFips = NAV.countyFips = NAV.cityId = null;
 if (!usEngaged()) { NAV.level = 0; return; }
 var s = projection.scale(), geo = centerCoord();
 // ---- isolation latch FIRST (UX §3.2 + §5.1): a committed county holds the register through
 // the hysteresis band (~10% beyond entry), through pans within it, below the free-zoom
 // threshold (tiny-county scale ceiling), and where centre-resolution is fragile (antimeridian
 // island chains). Zooming out past the release threshold — or losing the county from the
 // viewport entirely — releases it.
 var lc = isoLatch ? countyById[isoLatch] : null;
 if (lc) {
 // B1: while this county's explicit-commit fly is still animating, hold the register
 // UNCONDITIONALLY — the inbound scale ramp must not trip the zoom-out release predicate below
 // and drop a latch that was committed a frame earlier. On landing the guard clears and the
 // normal predicate takes over (s ≈ entryScale ≥ rel, so it holds even under the ceiling).
 if (isoFlyCommit === isoLatch) {
 NAV.stateFips = String(lc.id).slice(0, 2);
 NAV.countyFips = String(lc.id);
 NAV.level = 3;
 lastIsoFips = null;
 return;
 }
 var rel = isoReleaseScale(lc);
 // the latch holds while the CENTRE stays on the committed county's ground (containment or its
 // tiny-county zone), or on no-man's ground (coastal water, cross-border sea) while the county
 // is still in view. Re-centring onto DIFFERENT county ground releases it — the free path
 // below then re-anchors isolation if the new centre is inside that county's own band (deep
 // pan / search cross-fade) or falls back to the state register (wide framing). Without the
 // centre rule, a big county's latch captured every subsequent neighbour interaction.
 var inLc = geo && (G.geoContains(lc, geo) || tinyCountyNear(geo) === lc);
 if (s >= rel && (inLc || (!stateAt(geo) && countyOnScreen(lc)))) {
 NAV.stateFips = String(lc.id).slice(0, 2);
 NAV.countyFips = String(lc.id);
 NAV.level = 3;
 lastIsoFips = null;
 // deeper — the city register is still reached by zooming well past the county
 if (s >= countyFitOf(lc) * 2.4) { var lci = cityAtCenter(); if (lci) { NAV.level = 4; NAV.cityId = lci.id; NAV.stateFips = lci.sf || NAV.stateFips; NAV.countyFips = lci.cf || NAV.countyFips; } }
 return;
 }
 isoReleaseLatch();
 }
 var st = stateAt(geo);
 // a tiny/degenerate county under the centre can recover the state even when its anchor sits in water
 // (Island Co) or its 1px polygon flips containment (independent cities) — so state resolves too.
 var tco = tinyCountyNear(geo);
 if (!st && tco) st = stateByFips(String(tco.id).slice(0, 2));
 // F1 nearest-land fallback: centre over ocean/sound/lake with US land in view resolves to the
 // nearest county's context — the flat register + mask grammar persist across the water's edge
 // (Puget Sound, off-SD coast, Lake Michigan) instead of collapsing to a bare level-0/1 page.
 var wco = null;
 if (!st) { wco = waterLandCtx(); if (wco) st = stateByFips(String(wco.id).slice(0, 2)); }
 // NO US context at all (remote ocean, foreign land — nothing resolvable near the viewport):
 // DISENGAGE so the lod() sphere floor is the ground register. The old sticky level-1 here left
 // an engaged-but-empty frame whose world matte had faded — the F1 void by another door.
 if (!st && !usUnderCenter()) { NAV.level = 0; return; }
 // framed wider than any state (over US soil but not inside a state, or still nation-scale) → level 1
 if (!st || s < stateFitOf(st) * 0.5) { NAV.level = 1; return; }
 NAV.stateFips = String(st.id); NAV.level = 2;
 var co = tco || countyAt(geo, st) || wco;
 if (!co || s < countyFitOf(co) * 0.5) return; // inside the state, wider than a county → level 2
 NAV.countyFips = String(co.id); NAV.level = 3;
 // free-zoom self-commits isolation only once the county genuinely FRAMES the view (≥0.72×fit —
 // it fills the working area). Between fit×0.5 and fit×0.72 the county register renders as the
 // pre-P3 rim+label container WITHOUT the mask, so wide framings over big counties (a small
 // state's own fit can sit inside its largest county's band) never ambush the state view.
 if (s >= countyFitOf(co) * 0.72) {
 if (isoLatch !== String(co.id)) isoCommit(String(co.id), s, 'free');
 lastIsoFips = null;
 }
 // city/local level — only when zoomed WELL past the county (into a city), and a city is near centre
 if (s >= countyFitOf(co) * 2.4) { var ci = cityAtCenter(); if (ci) { NAV.level = 4; NAV.cityId = ci.id; NAV.stateFips = ci.sf || NAV.stateFips; NAV.countyFips = ci.cf || NAV.countyFips; } }
 }
 // cursor city pick (the child layer at county depth) — Phase 0 identity rule:
 // 1. the SMALLEST city polygon containing the cursor wins (San Diego clicks → San Diego; any LA
 // click — downtown, Hollywood, the Valley — → Los Angeles; enclaves are holes, so a click
 // inside Coronado/Culver City falls through to the dot pick and selects the enclave);
 // 2. dot pick covers the <100k (no-polygon) cities — admitted within 15px OR ~5.7 km of the
 // cursor, ranked population-weighted so a metro dot beats a suburb dot on ambiguous clicks;
 // 3. a direct hit (≤8px) on a poly-city's rendered dot still selects it (dot-in-enclave-hole edge).
 function cityAt(x, y, geoHint) {
 var geo = geoHint || (projection.invert && projection.invert([x, y]));
 if (QC_LEGACY_CITYPICK) { // pre-fix nearest-dot behavior — kept ONLY as the oracle's negative control
 var lb = null, lbd = 15 * 15;
 for (var li = 0; li < CITIES.length; li++) { var lc = CITIES[li]; if (!visiblePt(lc.c)) continue; var lp = projection(lc.c); if (!lp) continue; var ldx = lp[0] - x, ldy = lp[1] - y, ld = ldx * ldx + ldy * ldy; if (ld < lbd) { lbd = ld; lb = lc; } }
 return lb;
 }
 var pc = cityPolyAt(geo);
 if (pc) return pc;
 var best = null, be = Infinity, dotRescue = null, dotRescueD = 8;
 for (var i = 0; i < CITIES.length; i++) {
 var ci = CITIES[i]; if (!visiblePt(ci.c)) continue;
 var p = projection(ci.c); if (!p) continue;
 var dpx = Math.hypot(p[0] - x, p[1] - y);
 if (ci.poly) { if (dpx < dotRescueD) { dotRescueD = dpx; dotRescue = ci; } continue; }
 var gd = geo ? G.geoDistance(geo, ci.c) : Infinity;
 if (dpx >= 15 && gd >= 0.0009) continue;
 var eff = gd / Math.log10(Math.max(ci.pop, 1000));
 if (eff < be) { be = eff; best = ci; }
 }
 return best || dotRescue;
 }
 function countryHit(geo) { if (!geo) return null; for (var j = 0; j < countries.length; j++) if (G.geoContains(countries[j], geo)) return { type: 'country', country: countries[j] }; return null; }

 function hitTest(x, y) {
 var layer = childLayer();
 // world-register overlays (drill markers + national pins) — only when the world globe is showing
 if (lod().world > 0.1) {
 for (var k = 0; k < 2; k++) { var key = ['sandiego', 'vabeach'][k], d = DRILLS[key]; if (!visiblePt(d.center)) continue; var p = projection(d.center); if (p && Math.hypot(p[0] - x, p[1] - y) < 20) return { type: 'drill', key: key }; }
 for (var i = 0; i < PINS.length; i++) { var pn = PINS[i]; if (!visiblePt(pn.c)) continue; var pp = projection(pn.c); if (pp && Math.hypot(pp[0] - x, pp[1] - y) < (pn.theater ? 14 : 11)) return { type: 'pin', pin: pn }; }
 }
 var geo = projection.invert && projection.invert([x, y]);
 // ---- county isolation register (Phase 3): places are the ONLY children; outside is the mask.
 // Interaction floor (UX §1.1/§1.2): outside the rings — no hover, no picks, clicks inert.
 if (isoActive()) {
 var icc = countyById[isoLatch];
 if (icc) {
 var tcn = tinyCountyNear(geo);
 var inside = geo && (G.geoContains(icc, geo) || tcn === icc);
 // doughnut holes are OUTSIDE the county (UX §5.4): a point in an enclosed independent-city
 // county is mask ground, even though the 10m surrounding polygon (filled) contains it
 if (inside && tcn && tcn !== icc) inside = false;
 if (inside) { var ecl = countyEnclaves(icc); for (var eci = 0; eci < ecl.length; eci++) if (G.geoContains(ecl[eci], geo)) { inside = false; break; } }
 if (!inside) return { type: 'mask', county: icc };
 // ≥100k places keep boundary-first identity (Phase 0, inherited — UX §2)
 var ipc = cityPolyAt(geo);
 if (ipc && ipc.cf === isoLatch) return { type: 'city', city: ipc };
 // dot AND label are click targets (hit-boxes recorded by the draw pass). B2 enclave fix
 // (DoD §2 — "Culver City still selectable by clicking inside its own boundary"): a poly-city
 // is served by its POLYGON via ipc above whenever the click is inside its ring, so its
 // Gazetteer internal-point DOT reaching here means the click fell into a HOLE/gap (LA's
 // official internal point sits in West LA, ~2px from Culver City Hall). Its dot must not
 // out-rank the co-located dot-only enclave. Prefer the NEAREST dot-only place (the enclave
 // you're standing on) over pop order; a poly-city dot is a last-resort fallback only.
 var bDot = null, bD = Infinity, bLabel = null, bPoly = null, bPD = Infinity;
 for (var ph = 0; ph < isoPlaceHits.length; ph++) {
 var hp = isoPlaceHits[ph], dd = Math.hypot(hp.x - x, hp.y - y);
 if (dd <= hp.r + 5) {
 if (hp.city.poly) { if (dd < bPD) { bPD = dd; bPoly = hp.city; } }
 else if (dd < bD) { bD = dd; bDot = hp.city; }
 }
 if (!bLabel && hp.rect && x >= hp.rect[0] && x <= hp.rect[2] && y >= hp.rect[1] && y <= hp.rect[3]) bLabel = hp.city;
 }
 if (bDot) return { type: 'city', city: bDot };
 if (bLabel) return { type: 'city', city: bLabel };
 if (bPoly) return { type: 'city', city: bPoly };
 if (ipc) return { type: 'city', city: ipc };
 return null; // county interior, no place under the pointer — context is not clickable (UX §2 table)
 }
 }
 // ---- city register (Phase 4): the LEAF frame. Nothing inside the current city's boundary is
 // an affordance (fireClick/updateHover treat an own-city hit as inert ground — cursor grab);
 // neighbors are the only pickable map feature (dot/label hitboxes + boundary-first for ≥100k).
 // Identity semantics (Phase 0) are unchanged: a point still RESOLVES to the city that owns it.
 if (!QC_LEGACY_CITYPICK && NAV.level === 4 && NAV.cityId) {
 var st5 = stateAt(geo), co5 = countyAt(geo, st5);
 // DC locked rule (Phase 0): the district county wins clicks over its coincident city
 if (co5 && singleCountyState[String(co5.id).slice(0, 2)]) return { type: 'county', county: co5 };
 var cur4 = cityById[NAV.cityId];
 // 1. INSIDE the current city's boundary NOTHING else is pickable (UX §1 — the leaf frame).
 // A neighbor label spilling over the boundary never steals ground; identity still resolves
 // (a click on own ground returns the city; fireClick treats it as inert).
 if (cur4 && geo) {
 if (cur4.poly && ringsContainPt(cur4.poly.rings, geo[0], geo[1])) return { type: 'city', city: cur4 };
 var rec4 = packRecs[cityKeyOf(cur4)];
 var rings4 = rec4 && rec4.ydec && rec4.ydec.boundary.length ? rec4.ydec.boundary : null;
 if (rings4) {
 var in4 = false;
 for (var r4 = 0; r4 < rings4.length; r4++) {
 var ring4 = rings4[r4], n4 = ring4.length;
 for (var i4 = 0, j4 = n4 - 2; i4 < n4; j4 = i4, i4 += 2) {
 var xi4 = ring4[i4], yi4 = ring4[i4 + 1], xj4 = ring4[j4], yj4 = ring4[j4 + 1];
 if ((yi4 > geo[1]) !== (yj4 > geo[1]) && geo[0] < ((xj4 - xi4) * (geo[1] - yi4)) / (yj4 - yi4) + xi4) in4 = !in4;
 }
 }
 if (in4) return { type: 'city', city: cur4 };
 }
 // dot-city own ground (no boundary geometry): a click at its own dot is the city. ONLY for
 // poly-less cities — a poly city's ground is fully owned by its rings above, and its
 // Gazetteer dot can sit within px of an enclave neighbor's dot (LA's West-LA interior
 // point is ~11px from Culver City's dot at register framing — the dot radius must never
 // out-rank that neighbor's affordance).
 if (!cur4.poly) {
 var cp4 = projection(cur4.c);
 if (cp4 && Math.hypot(cp4[0] - x, cp4[1] - y) <= 12) return { type: 'city', city: cur4 };
 }
 }
 // 2. explicit neighbor affordances (dot + label rects recorded by the register draw)
 for (var nh = 0; nh < cityNbHits.length; nh++) {
 var nbh = cityNbHits[nh];
 if (Math.hypot(nbh.x - x, nbh.y - y) <= nbh.r) return { type: 'city', city: nbh.city };
 if (nbh.rect && x >= nbh.rect[0] && x <= nbh.rect[2] && y >= nbh.rect[1] && y <= nbh.rect[3]) return { type: 'city', city: nbh.city };
 }
 // 3. boundary-first for every OTHER city (Phase 0 rule — smallest containing place wins)
 var pc4 = cityPolyAt(geo);
 if (pc4) return { type: 'city', city: pc4 };
 // 4. pop-weighted dot pick (Phase-0 fallback for the <100k, no-polygon cities)
 var cd4 = cityAt(x, y, geo);
 if (cd4) return { type: 'city', city: cd4 };
 return null;
 }
 if (layer === 'cities') {
 var st4 = stateAt(geo), co4 = countyAt(geo, st4);
 // single-county district (DC): the district county IS the selectable unit and its own container band is
 // empty, so a coincident capital-city dot must NOT shadow it — county wins here (city still reachable by
 // zooming deeper into level 4). For every normal state, city dots keep priority as before.
 if (co4 && singleCountyState[String(co4.id).slice(0, 2)]) return { type: 'county', county: co4 };
 var cc = cityAt(x, y, geo); if (cc) return { type: 'city', city: cc };
 if (co4) return { type: 'county', county: co4 }; // fall back to county re-pick (proximity-aware)
 return null;
 }
 if (layer === 'counties') {
 var co3 = countyAt(geo, stateAt(geo)); if (co3) return { type: 'county', county: co3 }; // proximity-aware (works even where stateAt fails: water-gap counties)
 var st3 = stateAt(geo); if (st3) return { type: 'state', state: st3 };
 return countryHit(geo);
 }
 if (layer === 'states') {
 if (geo && G.geoContains(usNation, geo)) { var st2 = stateAt(geo); if (st2) return { type: 'state', state: st2 }; }
 return countryHit(geo);
 }
 return countryHit(geo); // world register — countries are the children
 }
 function updateHover(x, y) {
 var h = hitTest(x, y);
 var np = h && h.type === 'pin' ? h.pin : null, nc = h && h.type === 'country' ? h.country : null,
 nd = h && h.type === 'drill' ? h.key : null, ns = h && h.type === 'state' ? h.state : null,
 nco = h && h.type === 'county' ? h.county : null, nci = h && h.type === 'city' ? h.city : null;
 // city register (UX §2): the CURRENT city's own ground is not an affordance — cursor stays
 // grab, no tip. Only a neighbor reads as pickable ("the cursor is the affordance").
 var ownGround = nci && NAV.level === 4 && nci.id === NAV.cityId;
 if (ownGround) nci = null;
 var changed = np !== hoverPin || nc !== hoverCountry || nd !== hoverDrill || ns !== hoverState || nco !== hoverCounty || nci !== hoverCity;
 hoverPin = np; hoverCountry = nc; hoverDrill = nd; hoverState = ns; hoverCounty = nco; hoverCity = nci;
 var pick = np || nd || ns || nco || nci || (nc && countryStories[nc.properties.name]);
 canvas.style.cursor = dragging ? 'grabbing' : pick ? 'pointer' : (nc ? 'default' : 'grab');
 if (np) showTip(np, x, y); else if (nd) showDrillTip(nd, x, y); else if (nci) showCityTip(nci, x, y);
 else if (nco) showCountyTip(nco, x, y); else if (ns) showStateTip(ns, x, y); else hideTip();
 if (changed) requestRender();
 }
 function showStateTip(st, x, y) {
 tip.innerHTML = '<span class="place">' + esc(stateName(st)) + '</span><div class="hl">Zoom into ' + esc(stateName(st)) + ' — its counties, cities, and local desks.</div><div class="go">Click → drill in</div>';
 placeTip(x, y);
 }
 function showCountyTip(co, x, y) {
 var nm = (co.properties && co.properties.name) ? co.properties.name : 'This';
 tip.innerHTML = '<span class="place">' + esc(nm) + ' County</span><div class="hl">Open the ' + esc(nm) + ' County feed.</div><div class="go">Click → open feed</div>';
 placeTip(x, y);
 }
 function showCityTip(ci, x, y) {
 // sibling jump copy at the city register (UX §2); standard fly-in copy everywhere else
 if (NAV.level === 4 && ci.id !== NAV.cityId) {
 tip.innerHTML = '<span class="place">' + esc(ci.name) + '</span><div class="hl">Jump to ' + esc(ci.name) + ' — local desk.</div><div class="go">Click → jump</div>';
 } else {
 tip.innerHTML = '<span class="place">' + esc(ci.name) + '</span><span class="cat">' + esc(ci.state) + '</span><div class="hl">Fly into ' + esc(ci.name) + ' — local desk.</div><div class="go">Click → fly in</div>';
 }
 placeTip(x, y);
 }
 function showTip(pn, x, y) {
 var s = pn.story;
 tip.innerHTML = '<span class="place">' + (s.dateline || pn.label) + '</span><span class="cat">' + (s.category || '') + '</span><div class="hl">' + s.headline + '</div><div class="go">Click → read the fact</div>';
 placeTip(x, y);
 }
 function showDrillTip(key, x, y) {
 var d = DRILLS[key];
 tip.innerHTML = '<span class="place">' + d.name + '</span><div class="hl">Drill from the world down to ' + d.name + ' local news.</div><div class="go">Click → fly in</div>';
 placeTip(x, y);
 }
 function placeTip(x, y) {
 tip.classList.add('on'); var tw = 280;
 var left = x + 16, top = y + 16;
 if (left + tw > W - 12) left = x - tw - 16; if (top + tip.offsetHeight > H - 12) top = y - tip.offsetHeight - 16;
 tip.style.left = Math.max(12, left) + 'px'; tip.style.top = Math.max(12, top) + 'px';
 }
 function hideTip() { tip.classList.remove('on'); }
 function showToast(html) { toast.innerHTML = html; toast.classList.add('on'); if (toastT) clearTimeout(toastT); toastT = setTimeout(function () { toast.classList.remove('on'); }, 2400); }

 function fireClick(x, y) {
 var h = hitTest(x, y);
 if (!h) { selCountry = null; selCountryName = null; return; }
 if (h.type === 'mask') {
 // inert by design (accidental-exit protection). First masked click per county visit explains
 // the exits — once per visit, not per click (UX §1.2).
 var mf = String(h.county.id);
 if (!isoToasted[mf]) {
 isoToasted[mf] = true;
 showToast('You’re viewing <b>' + esc(countyDisplayName(h.county)) + '</b> — Esc or the breadcrumb steps back out.');
 }
 return;
 }
 if (h.type === 'drill') { selCountry = null; selCountryName = null; flyToLevel(h.key, 4); return; }
 if (h.type === 'pin') { selCountry = null; selCountryName = null; openStoryCard([h.pin.story]); return; }
 if (h.type === 'state') { selCountry = null; selCountryName = null; enterState(h.state); return; }
 if (h.type === 'county') { selCountry = null; selCountryName = null; enterCounty(h.county); return; }
 if (h.type === 'city') {
 selCountry = null; selCountryName = null;
 // leaf frame: a click on the CURRENT city's own ground is inert (UX §1 — nothing inside the
 // boundary is an affordance; the breadcrumb leaf re-click is the card-recovery path)
 if (NAV.level === 4 && h.city.id === NAV.cityId) return;
 // sibling jump = a short hop (~700ms), not the full drill fly (UX §2)
 enterCity(h.city, NAV.level === 4 ? 700 : 0);
 return;
 }
 if (h.type === 'country') {
 var f = h.country, nm = f.properties.name, fr = frameCountry(f, nm);
 var target = Math.max(fr.scale, projection.scale());
 lastClick = { country: nm, fromScale: projection.scale(), toScale: target };
 if (/United States/i.test(nm)) { // entering the US = OUTLINE + states light up (NEVER a flood)
 selCountry = null; selCountryName = null;
 flyTo(fr.center, target, 1000, closeCard); return;
 }
 selCountry = f; selCountryName = nm;
 flyTo(fr.center, target, 1000, function () {
 var st = countryStories[nm];
 if (st && st.length) openStoryCard(st, nm);
 else if (!(ltOuter && ltOuter.classList.contains('on'))) showToast('No Pigeon feed for <b>' + esc(nm) + '</b> yet — national level only.');
 });
 }
 }
 // ENTER a state/county/city — fly to it (NAV derives on arrival) + open its feed. Scripted exemplars
 // (CA→San Diego, VA→Virginia Beach) reuse their rich local path; everything else is fully generic.
 function enterState(stateFeat) {
 selCountry = null; selCountryName = null;
 var fips = String(stateFeat.id), a = stateFeat.__a || stateFeat.__c || G.geoCentroid(stateFeat);
 // single-county federal district (DC): selecting it from nation depth goes DIRECTLY to the
 // isolated district view — there is no separate state register for DC (UX §5.2, locked rule)
 if (singleCountyState[fips] && (countiesByStateFips[fips] || []).length) { enterCounty(countiesByStateFips[fips][0]); return; }
 flyTo(a, clamp(stateFitOf(stateFeat) * 0.9, minScale, maxScale()), 1050, function () { openGenericFeed('tpl_state', stateName(stateFeat), 'state:' + fips); });
 }
 // Frame the county in the WORKING AREA (UX §1.3): on desktop the feed card claims the right
 // edge, so the fly centers the county in the space left of it — a screen-x shift converted to a
 // longitude offset at the target scale. ≤720px uses the full width (sheet peeks from the bottom).
 // dock band: the feed docks as a right rail and the canvas reflows to the left remainder, so the
 // region is centred in its own box by fit() — the float-mode horizontal card-dodge below must NOT
 // also apply here or it double-shifts the county off the left edge (UX flag).
 function inDockBand() { var vw = window.innerWidth; return vw >= 721 && vw <= 1120; }
 function countyFrameCenter(countyFeat, targetScale, cardOpen) {
 var a = countyAnchor(countyFeat);
 if (!cardOpen || W <= 720 || inDockBand()) return a;
 var cardW = card ? Math.min(card.offsetWidth || 400, W * 0.45) : 400;
 // the shift is capped to ~45% of the county's own angular radius AND containment-verified:
 // NAV derives from the CENTRE, so a shifted centre that lands on neighbouring ground (a small
 // county, or an irregular one like Denver whose airport arm leaves an Adams-County notch mid-
 // bbox) would re-anchor isolation to the neighbour. Fall back toward the anchor until the
 // centre is verifiably on the county's own ground.
 var shiftRad = Math.min((cardW / 2) / targetScale, angRadius(countyFeat, a) * 0.45);
 var dLon = shiftRad * (180 / Math.PI) / Math.max(0.2, Math.cos(a[1] * Math.PI / 180));
 var ks = [1, 0.55, 0.28, 0];
 for (var ki = 0; ki < ks.length; ki++) {
 var c = [a[0] + dLon * ks[ki], a[1]];
 if (ks[ki] === 0 || G.geoContains(countyFeat, c) || tinyCountyNear(c) === countyFeat) return c;
 }
 return a;
 }
 function enterCounty(countyFeat) {
 selCountry = null; selCountryName = null;
 var fips = String(countyFeat.id);
 var sc = countyTargetScale(countyFeat); // scale ceiling holds for tiny counties (UX §5.1)
 isoCommit(fips, sc); // commit BEFORE the fly — the mask engages (and latches) as the fly lands
 // B1: guard the committed fips through the inbound fly so the ramp's transient low scale can't
 // release the latch before it lands (the ceiling can land below fit×0.72, where the free path
 // would otherwise refuse to re-engage).
 flyTo(countyFrameCenter(countyFeat, sc, true), sc, 1050, function () { openCountyFeed(countyFeat); }, fips);
 }
 function enterCity(city, ms) {
 selCountry = null; selCountryName = null;
 var known = (city.name === 'San Diego' && city.state === 'California') ? 'sandiego'
 : (city.name === 'Virginia Beach' && city.state === 'Virginia') ? 'vabeach' : null;
 var ck = cityKeyOf(city);
 if (ck) requestPack(ck); // street pack loads DURING the fly — landing is BASE, detail develops ()
 if (known) { currentDrillKey = known; flyToLevel(known, 4); return; }
 // entry is NOT clamped by maxScale — the ceiling follows the register (maxScale consults the
 // level-4 city), so clamping the inbound fly against the pre-entry ceiling would strand small
 // cities above their own frame
 var sc = Math.max(cityEntryScale(city), minScale);
 flyTo(city.c, sc, ms || 1100, function () { openCityView(city); });
 }

 // ---------- reading cards ----------
 var card = root.querySelector('#card'), cardBody = root.querySelector('#cardbody'), cardTitle = root.querySelector('#cardtitle');
 root.querySelector('#cardclose').addEventListener('click', closeCard);
 // closing the card does NOT exit isolation — the map stays isolated and soft-re-frames (~400ms)
 // to use the reclaimed width (UX §4.1)
 root.querySelector('#cardclose').addEventListener('click', function () {
 if (isoActive() && isoLatch && countyById[isoLatch]) flyTo(countyAnchor(countyById[isoLatch]), projection.scale(), 400);
 });
 function closeCard() { card.classList.remove('on'); card.classList.remove('expanded'); syncDock(); }
 // Fix 2: show the feed card AND re-fit if docking/undocking changed the #stage box. All card-open
 // paths route through here so the canvas reflow is never missed.
 function showCard() { card.classList.add('on'); syncDock(); }
 // Docking toggles #stage width via CSS (:has(#card.on)) WITHOUT firing a window resize, so fit()
 // (the resize handler) won't run on its own. Re-fit whenever the real stage box diverges from W.
 // Inert outside the dock band (float: stage stays full-width; mobile: card is a bottom sheet).
 function syncDock() { if (!firstFit && stage && Math.abs(stage.clientWidth - W) > 1) fit(); }
 // ≤720px bottom-sheet (UX §4.2 / Design B3): tap the sheet header to expand/collapse
 root.querySelector('#card .cx').addEventListener('click', function (ev) {
 if (ev.target && ev.target.id === 'cardclose') return;
 if (W <= 720 && root.classList.contains('iso')) card.classList.toggle('expanded');
 });
 function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
 function sources(arr) { if (!arr || !arr.length) return ''; return '<div class="src">Sources: ' + arr.map(function (s) { return '<a href="' + s.url + '" target="_blank" rel="noopener">' + esc(s.outlet) + '</a>'; }).join(' · ') + '</div>'; }
 function storyHTML(s) {
 var h = '<div class="st"><div class="dl">' + esc(s.dateline || '') + '<span class="cat">' + esc(s.category || '') + '</span></div>';
 h += '<h3>' + esc(s.headline) + '</h3>';
 if (s.fact) h += '<p class="lead">' + esc(s.fact) + '</p>';
 if (s.context) h += '<div class="reg">Context</div><p class="ctx">' + esc(s.context) + '</p>';
 if (s.constitutional) h += '<div class="reg">Constitutional register</div><p class="con">' + esc(s.constitutional) + '</p>';
 if (s.plain) h += '<div class="reg">What it means for you</div><p class="plain">' + esc(s.plain) + '</p>';
 if (s.civic_hook) h += '<div class="reg">How to weigh in</div><p class="plain">' + esc(s.civic_hook) + '</p>';
 if (s.predictive) h += '<div class="reg">What to watch</div><p class="pred">' + esc(s.predictive) + '</p>';
 h += sources(s.sources) + '</div>';
 return h;
 }
 function openStoryCard(stories, title) {
 cardTitle.textContent = title || (stories.length > 1 ? 'Dispatches' : 'Dispatch');
 cardBody.innerHTML = stories.map(storyHTML).join('');
 showCard();
 }

 // engagement ("Make your voice heard") civic surface — shared by any feed level that carries it
 function engagementHTML(e) {
 var h = '<div class="civic"><h4>' + esc(e.heading) + '</h4><p class="intro">' + esc(e.intro) + '</p>';
 var reps = e.representatives || {};
 Object.keys(reps).forEach(function (rk) {
 var r = reps[rk], title = rk.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
 h += '<div class="grp"><div class="gt">' + esc(title) + '</div>';
 if (r.note) h += '<div class="note">' + esc(r.note) + '</div>';
 if (r.mayor) h += '<div class="mem"><b>' + esc(r.mayor.name) + '</b> — Mayor</div>';
 if (r.council_note) h += '<div class="note">' + esc(r.council_note) + '</div>';
 (r.members || []).forEach(function (m) { h += '<div class="mem"><b>' + esc(m.name) + '</b> — District ' + m.district + (m.role ? ' <span class="role">(' + esc(m.role) + ')</span>' : '') + '</div>'; });
 h += '</div>';
 });
 (e.meetings || []).forEach(function (m) { h += '<div class="meet"><b>' + esc(m.body) + '</b> — next: ' + esc(m.next) + '<br>' + esc(m.where) + '<br>' + esc(m.detail) + (m.verified ? '' : ' <span class="role">(confirm on the official calendar)</span>') + '</div>'; });
 (e.on_the_ballot || []).forEach(function (b) { h += '<div class="ballot"><div class="bw">On your ballot — ' + esc(b.when) + '</div><div class="bt">' + esc(b.title) + '</div><p>' + esc(b.summary) + '</p></div>'; });
 if (e.how_to_participate) { h += '<div class="grp"><div class="gt">How to weigh in</div><div class="act">'; e.how_to_participate.forEach(function (a) { h += '<a href="' + a.link + '" target="_blank" rel="noopener">' + esc(a.action) + ' →</a>'; }); h += '</div></div>'; }
 return h + '</div>';
 }
 // (edit #1/#4) open the feed for a specific drill STOP (state / county-region / city). A feed marked
 // representative:true renders an honest amber SAMPLE banner from its note; feeds carrying an
 // engagement surface ("make your voice heard") render it below the stories.
 // (round2 F) in-memory feed-pinning state — a mockup of "add this place to my newsfeed". Keyed per
 // place id; no backend. The button toggles ＋ Add to my newsfeed ⇄ Added ✓.
 var pinnedFeeds = {};
 // (Phase 2 §5) place-named label; Added state stays in the clay family (NO green), check glyph in clay.
 function addFeedInner(on, place) {
 var p = '<span class="af-place">' + esc(place || 'this place') + '</span>';
 return on
 ? 'Added&nbsp;<span class="af-check">✓</span> · ' + p + ' is in your feed'
 : '<span class="plus">＋</span> Add ' + p + ' to my newsfeed';
 }
 function addFeedBtnHTML(pid, label) {
 var on = !!pinnedFeeds[pid];
 return '<button class="addfeed' + (on ? ' added' : '') + '" data-pid="' + esc(pid) + '" data-label="' + esc(label || '') + '">'
 + addFeedInner(on, label) + '</button>';
 }
 // desk-link — where a real /local/ pilot page exists for this place, the feed card links into it
 // (additive: the globe routes INTO the existing local surfaces; nothing existing is restructured).
 // Relative href ("../local/…/") survives both root-relative dev and the Pages basePath.
 function deskLinkHTML(slug, name) {
 if (!slug) return '';
 return '<a class="desklink" href="../local/' + esc(slug) + '/">Open the ' + esc(name) + ' local desk &rarr;</a>';
 }
 function openFeedCard(feed, d) {
 var pid = d.pid || (d.key || '') + ':' + ((feed && feed.area) || d.name);
 if (!feed) { // honest pending state — no feed wired for this stop
 cardTitle.textContent = d.name;
 cardBody.innerHTML = '<div class="feedhead">' + addFeedBtnHTML(pid, d.name) + '</div>'
 + deskLinkHTML(d.deskSlug, d.name)
 + '<div class="pending"><div class="tag">Feed</div><h4>' + esc(d.name) + ' desk is wiring in</h4>'
 + '<p>The map and civic surface are live. The verified news feed for this level is being sourced and will appear here — no stories are shown until they are verified.</p></div>';
 showCard(); return;
 }
 cardTitle.textContent = d.name || feed.area;
 var h = '<div class="feedhead">' + addFeedBtnHTML(pid, d.name || feed.area) + '</div>';
 h += deskLinkHTML(d.deskSlug, d.name || feed.area);
 // (round2 E) a template feed (placeholder layout) shows a TEMPLATE banner; a non-template
 // representative feed keeps the SAMPLE banner.
 if (feed.template) h += '<div class="sample tpl"><span class="stag">Template</span>' + esc(feed.note || 'Template — placeholder layout, not real headlines. This is the shape the feed takes at this level.') + '</div>';
 else if (feed.representative) h += '<div class="sample"><span class="stag">Sample</span>' + esc(feed.note || 'Representative sample — live sources for this level wire in at launch.') + '</div>';
 (feed.stories || []).forEach(function (s) { h += storyHTML(s); });
 if (feed.engagement) h += engagementHTML(feed.engagement);
 cardBody.innerHTML = h; showCard();
 }
 // resolve content.level_feeds[drillKey][lvl] -> a feed object, then open it (levels 2,3,4)
 function openLevelFeed(drillKey, lvl) {
 var map = CONTENT.level_feeds && CONTENT.level_feeds[drillKey];
 var key = map && map[String(lvl)];
 var d = DRILLS[drillKey], lvlName = ['World', 'United States', d.stateName, d.regionName, d.name][lvl] || d.name;
 var slug = lvl === 4 ? LOCAL_SLUGS.city[drillKey] : lvl === 3 ? LOCAL_SLUGS.county[d.regionFips] : null;
 openFeedCard(key ? CONTENT[key] : null, { name: lvlName, key: drillKey, pid: drillKey + ':' + lvl, deskSlug: slug });
 }
 // (round2 B) generic feed for a state/place with no scripted desk — opens the shared template
 function openGenericFeed(feedKey, name, pid) {
 openFeedCard(CONTENT[feedKey] || null, { name: name, key: 'generic', pid: pid || ('generic:' + name) });
 }
 // county feed — the county-level generic TEMPLATE (honest placeholder; live model fills at launch).
 // Title is class-honest: "… County" only where it IS a county; independents get "{Name}
 // (independent city)" (UX §5.3); DC gets "District of Columbia"; Gazetteer names (Parish/
 // Borough/Census Area) take over once the county pack is cached.
 function openCountyFeed(countyFeat) {
 openFeedCard(CONTENT.tpl_region || CONTENT.tpl_state || null, { name: countyFeedTitle(countyFeat), key: 'generic', pid: 'county:' + String(countyFeat.id), deskSlug: LOCAL_SLUGS.county[String(countyFeat.id)] });
 }
 // city view — non-exemplar cities get the CITY-level generic TEMPLATE (UX §3.7/§3.8 honesty rule).
 // pid = the city's stable id so a searched + a drilled instance of the same city share one feed entry.
 function openCityView(city) {
 openFeedCard(CONTENT.tpl_city || null, { name: city.name, key: 'generic', pid: city.id });
 }
 // (round2 F) delegated toggle for every ＋ Add to my newsfeed button (card body is rebuilt on open)
 cardBody.addEventListener('click', function (ev) {
 var b = ev.target.closest && ev.target.closest('.addfeed'); if (!b) return;
 var pid = b.getAttribute('data-pid'), place = b.getAttribute('data-label'); pinnedFeeds[pid] = !pinnedFeeds[pid];
 var on = pinnedFeeds[pid];
 b.classList.toggle('added', on);
 b.innerHTML = addFeedInner(on, place);
 if (on && place) showToast('<b>' + esc(place) + '</b> added to your newsfeed');
 syncLocalTitlePin();
 });
 function syncLocalTitlePin() { if (localTitleEl) { localTitleEl.__k = null; requestRender(); } }
 if (ltOuter) ltOuter.addEventListener('click', function (ev) {
 var b = ev.target.closest && ev.target.closest('.addfeed'); if (!b) return;
 var pid = b.getAttribute('data-pid'); pinnedFeeds[pid] = !pinnedFeeds[pid];
 if (localTitleEl) localTitleEl.__k = null; requestRender();
 });

 // ---------- city search combobox (UX §3 WAI-ARIA + Design §5 styling) ----------
 // Appears at STATE and COUNTY depth (hidden world/nation/city). Scope = the parent state; at county
 // depth the framed county's cities rank first. Full ARIA combobox: `/` focuses, arrows move the active
 // option (activedescendant), Enter selects → fly to the city + open its city view + feed.
 var FIPS_ABBR = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' };
 function normStr(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
 function isExemplarCity(ci) { return (ci.name === 'San Diego' && ci.state === 'California') || (ci.name === 'Virginia Beach' && ci.state === 'Virginia'); }
 var searchEl = null, searchInput = null, searchList = null, searchClear = null, searchScopeFips = null, searchActive = -1, searchRows = [];
 function buildSearchDOM() {
 searchEl = document.createElement('div'); searchEl.className = 'citysearch'; searchEl.id = 'citysearch';
 searchEl.innerHTML =
 '<div class="cs-field">' +
 '<svg class="cs-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" stroke-width="1.5"/></svg>' +
 '<input class="cs-input" type="text" role="combobox" aria-expanded="false" aria-controls="cs-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search cities">' +
 '<button class="cs-clear" aria-label="Clear search" hidden>&times;</button>' +
 '</div>' +
 '<ul class="cs-results" id="cs-list" role="listbox" aria-label="City search results" hidden></ul>';
 root.appendChild(searchEl);
 searchInput = searchEl.querySelector('.cs-input');
 searchList = searchEl.querySelector('.cs-results');
 searchClear = searchEl.querySelector('.cs-clear');
 searchInput.addEventListener('input', function () { searchClear.hidden = !searchInput.value; runSearch(); });
 // On mobile the feed card (z7) overlaps the full-width top search bar; while the input is focused we
 // dodge the card out of the way (bottom-sheet slide, CSS-gated to ≤720px) so the whole bar — clear-✕
 // and input tail included — is unobstructed and tappable. Restored on blur/close. Desktop unaffected.
 searchInput.addEventListener('focus', function () { root.classList.add('cs-searching'); runSearch(); });
 searchInput.addEventListener('blur', function () { root.classList.remove('cs-searching'); });
 searchInput.addEventListener('keydown', onSearchKey);
 searchClear.addEventListener('click', function () { searchInput.value = ''; searchClear.hidden = true; searchInput.focus(); runSearch(); });
 searchList.addEventListener('mousedown', function (ev) { // mousedown (before input blur) so the pick survives
 var li = ev.target.closest && ev.target.closest('.cs-item'); if (!li || li.dataset.idx == null) return;
 ev.preventDefault(); pickResult(+li.dataset.idx);
 });
 searchList.addEventListener('mousemove', function (ev) { var li = ev.target.closest && ev.target.closest('.cs-item'); if (li && li.dataset.idx != null) setActive(+li.dataset.idx); });
 }
 function searchScopeCities() {
 var sf = NAV.stateFips; if (!sf) return [];
 var list = (citiesByStateFips[sf] || []).slice();
 if (NAV.countyFips) { var cf = NAV.countyFips; list.sort(function (a, b) { var ac = a.cf === cf ? 1 : 0, bc = b.cf === cf ? 1 : 0; return bc - ac || b.pop - a.pop; }); }
 else list.sort(function (a, b) { return b.pop - a.pop; });
 return list;
 }
 function rankMatches(q) {
 var scope = searchScopeCities(), nq = normStr(q).trim();
 if (!nq) return scope.slice(0, 6); // empty focus → top 6 by pop in scope
 var scored = [];
 for (var i = 0; i < scope.length; i++) {
 var ci = scope[i], nn = normStr(ci.name); var rank = -1;
 if (nn.indexOf(nq) === 0) rank = 0; // exact-prefix
 else if (new RegExp('\\b' + nq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(nn)) rank = 1; // word-boundary prefix
 else if (nn.indexOf(nq) >= 0) rank = 2; // substring
 if (rank >= 0) scored.push({ ci: ci, rank: rank });
 }
 scored.sort(function (a, b) { return a.rank - b.rank || b.ci.pop - a.ci.pop; });
 return scored.slice(0, 8).map(function (s) { return s.ci; });
 }
 function hlName(name, q) {
 var nq = normStr(q).trim(); if (!nq) return esc(name);
 var idx = normStr(name).indexOf(nq); if (idx < 0) return esc(name);
 return esc(name.slice(0, idx)) + '<mark>' + esc(name.slice(idx, idx + nq.length)) + '</mark>' + esc(name.slice(idx + nq.length));
 }
 function runSearch() {
 var q = searchInput.value, rows = rankMatches(q), stName = FIPS_NAME[NAV.stateFips] || 'state';
 searchRows = rows; searchActive = -1;
 if (!rows.length) {
 searchList.innerHTML = '<li class="cs-empty">No city matches “' + esc(q) + '” in ' + esc(stName) + '.</li>'
 + '<li class="cs-empty" style="opacity:.8">Try a nearby larger city, or click a county on the map.</li>';
 } else {
 var head = !normStr(q).trim() ? '<li class="cs-head" aria-hidden="true">Cities in ' + esc(stName) + '</li>' : '';
 searchList.innerHTML = head + rows.map(function (ci, i) {
 var abbr = FIPS_ABBR[ci.sf] || '', tag = isExemplarCity(ci) ? '<span class="cs-full">FULL DESK</span>' : '';
 return '<li class="cs-item" role="option" id="cs-opt-' + i + '" data-idx="' + i + '" aria-selected="false">'
 + '<span class="cs-name">' + hlName(ci.name, q) + tag + '</span>'
 + '<span class="cs-ctx">' + esc(ci.cn || '') + (ci.cn ? ' · ' : '') + esc(abbr) + '</span></li>';
 }).join('');
 }
 searchList.hidden = false; searchInput.setAttribute('aria-expanded', 'true');
 setActive(rows.length ? 0 : -1);
 }
 function setActive(i) {
 searchActive = i;
 var items = searchList.querySelectorAll('.cs-item');
 items.forEach(function (el, j) { var on = j === i; el.classList.toggle('is-active', on); el.setAttribute('aria-selected', on ? 'true' : 'false'); if (on) el.scrollIntoView({ block: 'nearest' }); });
 searchInput.setAttribute('aria-activedescendant', i >= 0 ? ('cs-opt-' + i) : '');
 }
 function closeSearchList() { searchList.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); searchInput.setAttribute('aria-activedescendant', ''); }
 function onSearchKey(ev) {
 var n = searchRows.length;
 if (ev.key === 'ArrowDown') { ev.preventDefault(); if (searchList.hidden) { runSearch(); return; } setActive(n ? (searchActive + 1) % n : -1); }
 else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(n ? (searchActive - 1 + n) % n : -1); }
 else if (ev.key === 'Home') { ev.preventDefault(); setActive(n ? 0 : -1); }
 else if (ev.key === 'End') { ev.preventDefault(); setActive(n ? n - 1 : -1); }
 else if (ev.key === 'Enter') { ev.preventDefault(); pickResult(searchActive >= 0 ? searchActive : 0); }
 else if (ev.key === 'Escape') { ev.preventDefault(); if (!searchList.hidden) closeSearchList(); else { searchInput.value = ''; searchClear.hidden = true; searchInput.blur(); } }
 else if (ev.key === 'Tab') { closeSearchList(); }
 }
 function pickResult(i) {
 var ci = searchRows[i]; if (!ci) return;
 searchInput.value = ci.name; searchClear.hidden = false; closeSearchList(); searchInput.blur();
 if (!isExemplarCity(ci)) showToast('Generating local desk for <b>' + esc(ci.name) + '</b>…');
 enterCity(ci);
 }
 function syncSearchMount() {
 if (!searchEl) return;
 var show = NAV.level === 2 || NAV.level === 3;
 if (show) {
 var sf = NAV.stateFips, stName = FIPS_NAME[sf] || 'this state';
 var scopeName = NAV.countyFips && countyById[NAV.countyFips] ? ((countyById[NAV.countyFips].properties.name) + ' County') : stName;
 if (searchScopeFips !== (sf + '|' + (NAV.countyFips || ''))) { // scope changed → refresh placeholder, reset field
 searchScopeFips = sf + '|' + (NAV.countyFips || '');
 searchInput.placeholder = 'Search cities in ' + scopeName;
 searchEl.setAttribute('data-scope', scopeName);
 if (document.activeElement !== searchInput) { searchInput.value = ''; searchClear.hidden = true; closeSearchList(); }
 }
 if (!searchEl.classList.contains('on')) { searchEl.classList.add('on'); if (!searchPulsed) { searchEl.classList.add('pulse'); searchPulsed = true; setTimeout(function () { searchEl && searchEl.classList.remove('pulse'); }, 1300); } }
 } else { hideSearch(); }
 }
 var searchPulsed = false;
 function hideSearch() { if (searchEl) { searchEl.classList.remove('on'); closeSearchList(); searchInput.blur(); } }
 buildSearchDOM();

 // ---------- pointer wiring ----------
 canvas.addEventListener('pointerdown', function (ev) { canvas.setPointerCapture(ev.pointerId); var p = pos(ev); onDown(p[0], p[1]); });
 canvas.addEventListener('pointermove', function (ev) { var p = pos(ev); if (dragging) { moved = true; onDrag(p[0], p[1]); } else updateHover(p[0], p[1]); });
 canvas.addEventListener('pointerup', function (ev) { var wasDrag = dragging, didMove = moved; var p = pos(ev); onUp(); if (wasDrag && !didMove) fireClick(p[0], p[1]); updateHover(p[0], p[1]); updateZoomBtns(); });
 canvas.addEventListener('pointercancel', onUp);
 canvas.addEventListener('wheel', function (ev) { ev.preventDefault(); zoomBy(Math.exp(-ev.deltaY * 0.0014)); var p = pos(ev); if (!dragging) updateHover(p[0], p[1]); }, { passive: false });
 canvas.addEventListener('mouseleave', hideTip);
 window.addEventListener('resize', fit);
 function onKeydown(ev) {
 var typing = ev.target && ev.target.classList && ev.target.classList.contains('cs-input');
 // `/` focuses the city search when it's mounted (web-wide convention + UX [Keyboard] path)
 if (ev.key === '/' && !typing) { if (searchEl && searchEl.classList.contains('on')) { ev.preventDefault(); searchInput.focus(); runSearch(); } return; }
 if (typing) return; // let the combobox own its keys while focused
 if (ev.key === '+' || ev.key === '=') zoomBy(1.35);
 else if (ev.key === '-' || ev.key === '_') zoomBy(1 / 1.35);
 else if (ev.key === '0') zreset.click();
 else if (ev.key === 'Escape') {
 // Esc ladder (UX §2.1, single global order): 1 search list → 2 search text → 3 card →
 // 4 step up one register. (While the search input is FOCUSED its own handler owns steps 1–2.)
 if (searchEl && searchEl.classList.contains('on')) {
 if (searchList && !searchList.hidden) { closeSearchList(); return; }
 if (searchInput && searchInput.value) { searchInput.value = ''; searchClear.hidden = true; closeSearchList(); return; }
 }
 if (card.classList.contains('on')) { closeCard(); return; }
 if (NAV.level === 4) navTo(NAV.countyFips ? 3 : 2);
 else if (NAV.level === 3) navTo(singleCountyState[String(NAV.countyFips || '').slice(0, 2)] ? 1 : 2); // DC exits to nation — the parent that exists (UX §5.2)
 else if (NAV.level === 2) navTo(1);
 else if (NAV.level === 1) navTo(0);
 }
 }
 window.addEventListener('keydown', onKeydown);

 // centre the view on (lon,lat) at CITY-register zoom and resolve identity BOTH ways: free-zoom NAV
 // (computeNav → cityAtCenter) and a click at that exact point (hitTest → cityAt). Scale mirrors
 // jumpCity — unclamped county-fit×2.7 for the county UNDER the point, so tiny-county cities (VA
 // independents) still cross the level-4 threshold. Used by the exhaustive city-identity sweep.
 function cityProbeAt(lon, lat) {
 stopFly(); stopAuto(); stopInertia();
 var a = [lon, lat];
 projection.rotate([-a[0], clamp(-a[1], -90, 90), 0]);
 var co = tinyCountyNear(a) || countyAt(a, stateAt(a));
 projection.scale(co ? countyFitOf(co) * 2.7 : baseScale * 70);
 render();
 var p = projection(a); if (!p) return null;
 var h = hitTest(p[0], p[1]);
 var hit = !h ? 'none'
 : h.type === 'city' ? h.city.id
 : h.type + ':' + (h.county ? String(h.county.id) : h.state ? String(h.state.id) : h.country ? h.country.properties.name : '');
 return { nav: NAV.cityId, level: NAV.level, hit: hit,
 hitName: h && h.type === 'city' ? h.city.name + ', ' + h.city.state : null,
 navName: NAV.cityId && cityById[NAV.cityId] ? cityById[NAV.cityId].name + ', ' + cityById[NAV.cityId].state : null };
 }

 // ---------- QC hooks ----------
 window.__pig = {
 getRotate: function () { return projection.rotate(); },
 getScale: function () { return projection.scale(); },
 getBaseScale: function () { return baseScale; },
 getZoomRatio: zoomRatio,
 getLOD: lod,
 getSkin: function () { return SKIN; }, // always 'globe' — Matte Atlas is THE skin (locked)
 getFits: function () { var d = DRILLS.sandiego, v = DRILLS.vabeach; return { nation: fitScales.nation, sd: { state: d.sState, region: d.sRegion, local: d.sLocal }, vb: { state: v.sState, region: v.sRegion, local: v.sLocal } }; },
 dragBy: function (dx, dy) { stopAuto(); stopInertia(); var kd = ROT_SENS / projection.scale(), r = projection.rotate(); projection.rotate([r[0] + dx * kd, clamp(r[1] - dy * kd, -90, 90), 0]); render(); },
 setCenter: function (lon, lat) { stopAuto(); stopInertia(); projection.rotate([-lon, clamp(-lat, -90, 90), 0]); render(); },
 setScale: function (s) { stopAuto(); stopInertia(); projection.scale(clamp(s, minScale, maxScale())); render(); updateZoomBtns(); },
 flyToLevel: function (k, l) { flyToLevel(k, l); },
 jumpToLevel: function (k, l) { stopFly(); stopAuto(); stopInertia(); if (l === 0) { selCountry = null; selCountryName = null; } currentDrillKey = k; var d = DRILLS[k], tg = levelTarget(d, l); projection.rotate([-tg.c[0], clamp(-tg.c[1], -90, 90), 0]).scale(tg.s); render(); if (l >= 2) openLevelFeed(k, l); else closeCard(); },
 countryStories: function () { return Object.keys(countryStories); },
 cardOpen: function () { return card.classList.contains('on'); },
 cardText: function () { return cardBody.textContent; },
 cardTitle: function () { return cardTitle.textContent; },
 getRenderMs: function () { return lastMs; },
 getLevel: function () { return currentLevel(lod()); },
 frameInfo: function () { return { signalArcs: frameInfo.signalArcs, signalGraticule: frameInfo.signalGraticule }; },
 localTitle: function () { return localTitleEl ? localTitleEl.textContent : ''; },
 localTitleOn: function () { return !!(ltOuter && ltOuter.classList.contains('on')); },
 lastClick: function () { return lastClick; },
 fireClickAt: function (x, y) { fireClick(x, y); },
 openLevelFeed: function (k, l) { openLevelFeed(k, l); },
 drillMap: function (k) { var r = packRecs[k]; if (!r || !r.data) return null; var a = r.data.area; return { scale: a.map.scale, name: a.name, roads: (a.map.roads || []).length, water: (a.map.water_areas || []).length }; },
 // ---- round2 hooks ----
 cardHTML: function () { return cardBody.innerHTML; },
 projectPt: function (lon, lat) { return projection([lon, lat]); },
 stateCentroid: function (fips) { var s = stateByFips(fips); return s ? (s.__c || G.geoCentroid(s)) : null; },
 hoverAt: function (x, y) { updateHover(x, y); return { state: hoverState ? stateName(hoverState) : null, country: hoverCountry ? hoverCountry.properties.name : null, pin: hoverPin ? hoverPin.id : null, county: hoverCounty ? String(hoverCounty.id) : null, city: hoverCity ? hoverCity.name + ', ' + hoverCity.state : null }; },
 citiesInfo: function () { return { count: CITIES.length, top: CITIES[0] ? CITIES[0].name : null, minPop: CITIES.length ? CITIES[CITIES.length - 1].pop : 0 }; },
 isPinned: function (pid) { return !!pinnedFeeds[pid]; },
 clickAddFeed: function () { var b = cardBody.querySelector('.addfeed'); if (b) b.click(); return b ? b.textContent.trim() : null; },
 addFeedPresent: function () { return !!cardBody.querySelector('.addfeed'); },
 localTitleHTML: function () { return localTitleEl ? localTitleEl.innerHTML : ''; },
 // ---- Phase 2 (matte texture) hooks ----
 texturesBaked: function () { return texturesBaked; },
 bordersMeshCount: function () { return (countriesMesh && countriesMesh.coordinates ? countriesMesh.coordinates.length : 0); },
 hoverFillAlphas: function () { return { hover: HOVER_FILL, sel: SEL_FILL }; },
 citiesTiers: function () { var t = { A: 0, B: 0, C: 0, cap: 0 }; CITIES.forEach(function (c) { t[c.tier]++; if (c.capital) t.cap++; }); return t; },
 // ---- USA full-detail oracle hooks (frame-not-fill + exhaustive county/state/city sweep) ----
 navState: function () { return { level: NAV.level, stateFips: NAV.stateFips, countyFips: NAV.countyFips, cityId: NAV.cityId }; },
 childLayer: childLayer,
 stateFipsList: function () { return usStates.map(function (s) { return String(s.id); }).filter(function (f) { return !!FIPS_NAME[f]; }); },
 countyFipsList: function (sf) { return (countiesByStateFips[sf] || []).map(function (c) { return String(c.id); }); },
 countyTotal: function () { var n = 0; Object.keys(countiesByStateFips).forEach(function (f) { if (FIPS_NAME[f]) n += countiesByStateFips[f].length; }); return n; },
 stateCentroidOf: function (f) { var s = stateByFips(f); return s ? (s.__c || G.geoCentroid(s)) : null; },
 countyCentroidOf: function (f) { var c = countyById[f]; return c ? (c.__c || G.geoCentroid(c)) : null; },
 nationFit: function () { return fitScales.nation; },
 // pixel probe on the 2D canvas at a geo point — proves nation is OUTLINE (interior not clay-flooded)
 pixelAt: function (lon, lat) { var p = projection([lon, lat]); if (!p) return null; try { var d = ctx.getImageData(Math.round(p[0] * dpr), Math.round(p[1] * dpr), 1, 1).data; return [d[0], d[1], d[2], d[3]]; } catch (e) { return null; } },
 // set the CONUS nation view, then hover a state's interior anchor → returns the FIPS that lit (or
 // OFFSCREEN for AK/HI, which are off the CONUS near-side — reaching them = entering them, tested by drill)
 hoverStateTest: function (f) {
 var st = stateByFips(f); if (!st) return null; var a = st.__a || st.__c;
 stopFly(); stopAuto(); stopInertia();
 // pass 1 — CONUS nation view (states are children); works for all but the 2px-small states
 projection.rotate([96, -39.5, 0]).scale(fitScales.nation); render();
 if (visiblePt(a)) { var p = projection(a); if (p) { updateHover(p[0], p[1]); if (hoverState && String(hoverState.id) === String(f)) return String(f); } }
 // pass 2 — closer level-1 view centered on the state (still states-as-children: s < stateFit*0.5)
 projection.rotate([-a[0], clamp(-a[1], -90, 90), 0]).scale(stateFitOf(st) * 0.45); render();
 if (!visiblePt(a)) return 'OFFSCREEN';
 var p2 = projection(a); if (!p2) return null; updateHover(p2[0], p2[1]);
 return hoverState ? String(hoverState.id) : null;
 },
 // center on a county at its STATE fit (level 2, counties are the child layer) + hover its interior anchor
 hoverCountyTest: function (f) {
 var co = countyById[f]; if (!co) return null; var st = stateByFips(String(f).slice(0, 2)); if (!st) return null; var a = countyAnchor(co);
 stopFly(); stopAuto(); stopInertia();
 // pass 1 — at the state fit (counties are children); works for all but the 2-sq-mi independent cities
 projection.rotate([-a[0], clamp(-a[1], -90, 90), 0]).scale(stateFitOf(st) * 0.9); render();
 var p = projection(a); if (p) { updateHover(p[0], p[1]); if (hoverCounty && String(hoverCounty.id) === String(f)) return String(f); }
 // a county whose geometry auto-frames at this scale IS the committed container here — its
 // register (frame + name, or its isolation view) is the county's distinct highlight (DC and
 // near-state-sized counties have no external hover vantage by construction)
 if (NAV.level >= 3 && NAV.countyFips === String(f)) return String(f);
 // pass 2 — closer (county fills ~40%, still level 2) for tiny nested county-equivalents
 projection.rotate([-a[0], clamp(-a[1], -90, 90), 0]).scale(countyFitOf(co) * 0.4); render();
 var p2 = projection(a); if (!p2) return null; updateHover(p2[0], p2[1]);
 if (hoverCounty && String(hoverCounty.id) === String(f)) return String(f);
 if (NAV.level >= 3 && NAV.countyFips === String(f)) return String(f);
 return hoverCounty ? String(hoverCounty.id) : null;
 },
 // drill (synchronous mirror of a click's end-state) — fit-relative, works for every state/county size
 jumpState: function (f) { var st = stateByFips(f); if (!st) return false; var a = st.__a || st.__c; stopFly(); stopAuto(); stopInertia(); projection.rotate([-a[0], clamp(-a[1], -90, 90), 0]).scale(stateFitOf(st) * 0.95); render(); openGenericFeed('tpl_state', stateName(st), 'state:' + f); return NAV.level >= 2 && NAV.stateFips === String(f); },
 jumpCounty: function (f) { var co = countyById[f]; if (!co) return false; var a = countyAnchor(co); stopFly(); stopAuto(); stopInertia(); projection.rotate([-a[0], clamp(-a[1], -90, 90), 0]).scale(countyFitOf(co) * 0.95); render(); openCountyFeed(co); return NAV.level >= 3 && NAV.countyFips === String(f) && card.classList.contains('on'); },
 jumpCity: function (id) { var ci = cityById[id]; if (!ci) return false; var sc = Math.max(cityEntryScale(ci), minScale); stopFly(); stopAuto(); stopInertia(); projection.rotate([-ci.c[0], clamp(-ci.c[1], -90, 90), 0]).scale(sc); render(); var known = (ci.name === 'San Diego' && ci.state === 'California') ? 'sandiego' : (ci.name === 'Virginia Beach' && ci.state === 'Virginia') ? 'vabeach' : null; if (known) { currentDrillKey = known; openLevelFeed(known, 4); } else { openCityView(ci); } render(); return NAV.level === 4 && NAV.cityId === id && card.classList.contains('on'); },
 clearHover: function () { hoverPin = hoverCountry = hoverDrill = hoverState = hoverCounty = hoverCity = null; hideTip(); render(); },
 closeCard: function () { closeCard(); },
 degenerateCounties: function () { return degenList.slice(); },
 // city dataset integrity — every city carries pop + county_fips + state (the data dependency)
 citiesDataCheck: function () { var wc = 0, wp = 0, ws = 0, cap = 0; CITIES.forEach(function (c) { if (c.cf) wc++; if (c.pop > 0) wp++; if (c.sf) ws++; if (c.capital) cap++; }); return { count: CITIES.length, withCounty: wc, withPop: wp, withState: ws, capitals: cap }; },
 // city search hooks
 searchMounted: function () { return !!(searchEl && searchEl.classList.contains('on')); },
 searchScopeName: function () { return searchEl ? searchEl.getAttribute('data-scope') : null; },
 searchType: function (q) { if (!searchInput) return []; searchInput.focus(); searchInput.value = q; searchClear.hidden = !q; runSearch(); return searchRows.map(function (c) { return c.name; }); },
 searchRowsCities: function () { return searchRows.map(function (c) { return c.id; }); },
 searchListOpen: function () { return !!(searchList && !searchList.hidden); },
 searchActiveDesc: function () { return searchInput ? searchInput.getAttribute('aria-activedescendant') : null; },
 slashFocus: function () { if (searchEl && searchEl.classList.contains('on')) { searchInput.focus(); runSearch(); return document.activeElement === searchInput; } return false; },
 forceRender: function () { render(); return lastMs; },
 perfMin: function (n) { var m = Infinity; for (var i = 0; i < (n || 8); i++) { render(); if (lastMs < m) m = lastMs; } return m; },
 // ---- Phase 0 city-identity hooks (boundary-aware + pop-weighted picking) ----
 cityPolyStats: function () { var pts = 0; polyCitiesAsc.forEach(function (c) { c.poly.rings.forEach(function (r) { pts += r.length / 2; }); }); return { cities: polyCitiesAsc.length, points: pts }; },
 cityPolyIds: function () { return polyCitiesAsc.map(function (c) { return c.id; }); },
 cityIdOf: function (name, state) { for (var i = 0; i < CITIES.length; i++) if (CITIES[i].name === name && CITIES[i].state === state) return CITIES[i].id; return null; },
 cityInfoOf: function (id) { var c = cityById[id]; return c ? { name: c.name, state: c.state, pop: c.pop, hasPoly: !!c.poly, anchor: c.poly ? c.poly.anchor : null } : null; },
 cityProbe: cityProbeAt,
 // exhaustive per-city identity check: probe at the city's guaranteed interior anchor
 cityIdentityTest: function (id) {
 var ci = cityById[id]; if (!ci || !ci.poly || !ci.poly.anchor) return null;
 var r = cityProbeAt(ci.poly.anchor[0], ci.poly.anchor[1]);
 if (!r) return { id: id, ok: false, why: 'projection failed' };
 var dcCounty = ci.cf && singleCountyState[String(ci.cf).slice(0, 2)] ? 'county:' + ci.cf : null;
 var hitOK = r.hit === id || (dcCounty && r.hit === dcCounty); // DC: the district county wins clicks by LOCKED design (app.js singleCountyState)
 var navOK = r.nav === id;
 return { id: id, ok: hitOK && navOK, hitOK: hitOK, navOK: navOK, hit: r.hit, nav: r.nav, level: r.level, name: ci.name + ', ' + ci.state };
 },
 qcLegacyCityPick: function (on) { QC_LEGACY_CITYPICK = !!on; return QC_LEGACY_CITYPICK; },
 tipText: function () { return tip.textContent; },
 // ---- Phase 1 pack-loader hooks (UX pack spec acceptance + Design QC) ----
 packKeys: function () { return Object.keys(PACKS); },
 packUrl: function (k) { return PACKS[k] ? PACKS[k].url : null; },
 packState: function (k) { var r = packRecs[k]; return { state: r ? r.state : 'idle', hasData: !!(r && r.data), animDone: !!(r && r.animDone), fetches: packFetches[k] || 0, offline: !!(r && r.offline) }; },
 packAlphas: function (k) { return packLayerAlphas(k); },
 packRequest: function (k) { requestPack(k); },
 packRetryClick: function () { if (psRetry && !psRetry.hidden) { psRetry.click(); return true; } return false; },
 packStatus: function () { return { cls: packStatusEl ? packStatusEl.className : '', text: psTxt ? psTxt.textContent : '', retryVisible: !!(psRetry && !psRetry.hidden) }; },
 packCurrentKey: function () { return currentPackKey(); },
 packRaceBlocked: function () { return packRaceBlocked; },
 packReset: function (k) {
 var r = packRecs[k];
 if (r) { if (r.abort) { try { r.abort.abort(); } catch (e) { /* already settled */ } } clearTimeout(r.timeoutT); }
 delete packRecs[k]; packFetches[k] = 0; psKey = ''; syncPackStatus();
 },
 packFetchCount: function (k) { return packFetches[k] || 0; },
 // ---- Phase 2 physical-geography hooks (Spec A oracle surface) ----
 physState: function () { return { state: physFetchState, on: physOn(), stateLoaded: PHYS_STATE_LOADED, enabled: physEnabled, fetches: physFetches, register: PHYS ? physRegKey() : null, fadeDone: !physFadeStart }; },
 physEnable: function (on) { physEnabled = !!on; physCache = { key: '', p: {} }; physEpoch++; render(); return physEnabled; },
 physForceFadeDone: function () { physFadeStart = 0; render(); },
 physRamps: function () { return physRamps(); },
 physAlphas: function () { // the effective per-treatment layer alphas at the current scale (LOD gates)
 var rm = physRamps(), pA = physAlphaNow();
 return { register: PHYS ? physRegKey() : null, cf: rm.cf, rN: rm.rN, rS: rm.rS, physA: pA,
 desertStipple: (0.35 + 0.10 * rm.rN + 0.05 * rm.rS) * rm.cf * pA,
 tundraStipple: 0.30 * rm.cf * pA, bosk: 0.30 * rm.cf * pA, boskInRange: 0.15 * rm.cf * pA,
 rivers: (0.6 + 0.15 * rm.rS) * rm.cf * pA, riverDouble: (rm.rS > 0.05 ? 0.30 * rm.rS : 0) * rm.cf * pA,
 ice: 0.92 * rm.cf * pA, shelf: 0.85 * rm.cf * pA };
 },
 physProbe: function (lon, lat, regName) { // which treatments contain the point (planar even-odd)
 if (!PHYS) return null;
 function pipPair(rings, x, y) {
 var inside = false;
 for (var ri = 0; ri < rings.length; ri++) {
 var ring = rings[ri];
 for (var i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
 var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
 if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
 }
 }
 return inside;
 }
 function hit(members) { for (var i = 0; i < members.length; i++) if (pipPair(members[i].g, lon, lat)) return true; return false; }
 var reg = PHYS.reg[regName || physRegKey()] || PHYS.reg.nation;
 var glHit = false;
 for (var i = 0; i < reg.lakes.length; i++) if (reg.lakes[i].gl && pipPair(reg.lakes[i].g, lon, lat)) { glHit = true; break; }
 return { register: regName || physRegKey(), desert: hit(PHYS.deserts), tundra: hit(PHYS.tundra), ice: hit(reg.ice), shelf: hit(PHYS.shelves), forest: hit(reg.forest.out) || hit(reg.forest.inR), forestInRange: hit(reg.forest.inR), lake: hit(reg.lakes), greatLake: glHit };
 },
 physRiver: function (name) { // named-river presence per register (batch = weight class)
 if (!PHYS) return null;
 var rx = new RegExp('^' + name + '$', 'i'), out = {};
 Object.keys(PHYS.reg).forEach(function (rk) {
 out[rk] = null;
 var b = PHYS.reg[rk] && PHYS.reg[rk].rivers;
 if (b) Object.keys(b).forEach(function (bk) { if (!out[rk] && b[bk].some(function (l) { return l.n && rx.test(l.n); })) out[rk] = bk; });
 });
 return out;
 },
 physFrameCounts: function () { return { fills: physFrame.fills, lines: physFrame.lines, extra: physFrame.extra, linedLakes: physFrame.linedLakes, layers: Object.keys(physFrame.layers), caps: { fills: PHYS_MAX_FILLS, lines: PHYS_MAX_LINES } }; },
 physStats: function () {
 if (!PHYS) return null;
 var out = { shelves: PHYS.shelves.length, deserts: PHYS.deserts.length, tundra: PHYS.tundra.length, reg: {} };
 Object.keys(PHYS.reg).forEach(function (rk) {
 var r = PHYS.reg[rk]; if (!r) return;
 var rl = 0; Object.keys(r.rivers).forEach(function (bk) { rl += r.rivers[bk].length; });
 out.reg[rk] = { rivers: rl, lakes: r.lakes.length, ice: r.ice.length, forestOut: r.forest.out.length, forestIn: r.forest.inR.length };
 });
 return out;
 },
 // ---- Phase 3 county-isolation hooks (mask + pack + places oracle surface) ----
 isoState: function () { return { fips: isoLatch, level: NAV.level, alpha: isoAnim.alpha, maskAlphaConst: MASK_ALPHA, lastIso: lastIsoFips, entry: isoLatchEntry }; },
 isoForceDone: function () { var t = isoActive() ? 1 : 0; isoAnim.alpha = isoAnim.from = isoAnim.target = t; isoAnim.t0 = 0; render(); return isoAnim.alpha; },
 isoReleaseHook: function () { isoReleaseLatch(); render(); },
 enterCountySync: function (f) { // synchronous mirror of a county click — ceiling + commit + feed
 var co = countyById[f]; if (!co) return false;
 stopFly(); stopAuto(); stopInertia(); selCountry = null; selCountryName = null;
 var sc = countyTargetScale(co); isoCommit(f, sc);
 var ctr = countyFrameCenter(co, sc, true);
 projection.rotate([-ctr[0], clamp(-ctr[1], -90, 90), 0]).scale(sc); render();
 openCountyFeed(co); render();
 return NAV.level === 3 && NAV.countyFips === f;
 },
 countyFrameInfo: function () { return JSON.parse(JSON.stringify(countyFrame)); },
 // F3 oracle surface: per-frame DRAWN place-label bboxes on the isolation plate (name + rect)
 isoPlaceLabelRects: function () { return isoPlaceHits.filter(function (h) { return h.rect; }).map(function (h) { return { n: h.city.name, rect: h.rect }; }); },
 countyPlacesInfo: function (f) { var l = countyPlaceList[f]; return { merged: !!l, count: l ? l.length : (citiesByCounty[f] || []).length, boot: (citiesByCounty[f] || []).length, hitboxes: isoPlaceHits.length }; },
 // F2 oracle surface: the merged per-county place names + anchors (spillover views included)
 countyPlaceNames: function (f) { var l = countyPlaceList[f] || citiesByCounty[f] || []; return l.map(function (c) { return { n: c.name, c: c.c, home: c.cf, spill: !!(c.pk && c.pk.x) }; }); },
 // F1 oracle surface: the per-frame ground state — what covers the view centre this frame
 groundState: function () {
 var o = lod();
 return { world: o.world, us: o.us, county: o.county, local: o.local, engaged: usEngaged(),
 level: NAV.level, stateFips: NAV.stateFips, countyFips: NAV.countyFips, cityId: NAV.cityId,
 isoAlpha: isoAnim.alpha, cityAlpha: cityAnim.alpha, waterCtx: waterCtxVal ? String(waterCtxVal.id) : null };
 },
 countyDisplayNameOf: function (f) { return countyDisplayName(countyById[f]); },
 countyFeedTitleOf: function (f) { return countyById[f] ? countyFeedTitle(countyById[f]) : null; },
 countyTargetScaleOf: function (f) { var co = countyById[f]; return co ? countyTargetScale(co) : null; },
 countyCeiling: function () { return countyScaleCeiling(); },
 countyFitOfHook: function (f) { var co = countyById[f]; return co ? countyFitOf(co) : null; },
 maskAlphaSet: function (v) { MASK_ALPHA = v; render(); return MASK_ALPHA; }, // T1 void↔ghost = ONE constant
 packAutoFetchSet: function (on) { packAutoFetch = !!on; return packAutoFetch; },
 toastState: function () { return { on: toast.classList.contains('on'), text: toast.textContent }; },
 // ---- Phase 4 city-register hooks (street plate + leaf frame + sibling jump oracle surface) ----
 cityRegInfo: function () { return JSON.parse(JSON.stringify(cityRegFrame)); },
 cityRegAlpha: function () { return cityAnim.alpha; },
 cityRegForceDone: function () { var t = cityRegCity() ? 1 : 0; cityAnim.alpha = cityAnim.from = cityAnim.target = t; cityAnim.t0 = 0; render(); return cityAnim.alpha; },
 cityKeyOfHook: function (id) { return cityKeyOf(cityById[id]); },
 cityByGeoidHook: function (g) { var c = cityByGeoid[g]; return c ? { id: c.id, name: c.name, state: c.state, pop: c.pop, cf: c.cf } : null; },
 cityEntryScaleOf: function (id) { var c = cityById[id]; return c ? cityEntryScale(c) : null; },
 cityTiersNow: function () { var c = cityRegCity() || cityRegLast; return c ? cityTiers(c) : null; },
 cityScaleCapHook: function () { var v = cityScaleCap(); return v === Infinity ? null : v; },
 cityNeighborsHook: function () { return cityNbHits.map(function (h) { return { name: h.city.name, state: h.city.state, x: h.x, y: h.y, hasRect: !!h.rect }; }); },
 cityPackDecoded: function (g) {
 var r = packRecs['ci' + g];
 if (!r || !r.ydec) return null;
 var d = r.ydec;
 return { cls: d.cls, boundaryRings: d.boundary.length, roads: { i: d.roads.i.g.length, p: d.roads.p.g.length, s: d.roads.s.g.length, r: d.roads.r.g.length, v: d.roads.v.g.length }, waterA: d.waterA.length, waterL: d.waterL.length, lm: d.lm.length, lab2: d.lab2.length, lab3: d.lab3.length, shields: d.shields.length, names: d.rn.length, approx: !!d.approx };
 },
 hintText: function () { return hintEl ? hintEl.textContent : ''; },
 hitAt: function (x, y) { var h = hitTest(x, y); return h ? (h.type + ':' + (h.city ? h.city.name : h.county ? String(h.county.id) : h.state ? String(h.state.id) : '')) : 'none'; },
 // B3 oracle surface: the city-pack manifest gate
 cityIndexState: function () { return { state: cityIndexState, size: cityPackSet ? cityPackSet.size : 0 }; },
 cityPackHas: function (g) { return cityPackSet ? cityPackSet.has(g) : null; },
 fetchCityIndexNow: function () { fetchCityIndex(); },
 cityPidOf: function () { var b = cardBody ? cardBody.querySelector('.addfeed') : null; return b ? b.getAttribute('data-pid') : null; },
 ready: true,
 };

 // ---------- boot ----------
 root.setAttribute('data-skin', 'globe'); // Matte Atlas — the locked skin (round2 G)
 fit();
 updateZoomBtns();
 // physical-geography pack: lazily fetched AFTER first paint (never part of the boot wave); the
 // engraved treatments fade in on arrival (Spec D vocabulary — alpha only, base map honest meanwhile)
 setTimeout(fetchPhysical, 300);
 // B3: city-pack manifest — resolves the pack namespace so no-pack (CDP) places skip the fetch
 // (no 404, honest base register). Post-boot, well before any city register is reached.
 setTimeout(fetchCityIndex, 200);
 // idle auto-spin at world scale until first interaction
 autoOn = true; var autoLast = 0, autoRAF = null;
 function autoSpin(t) {
 if (destroyed) return;
 if (autoOn && !dragging && !flyRAF && !inertiaRAF && lod().world > 0.5) {
 var dt = autoLast ? Math.min(40, t - autoLast) : 16; autoLast = t;
 var r = projection.rotate(); projection.rotate([r[0] + 0.005 * dt, r[1], 0]); render();
 } else autoLast = 0;
 autoRAF = requestAnimationFrame(autoSpin);
 }
 autoRAF = requestAnimationFrame(autoSpin);

 var pig = window.__pig;
 function destroy() {
 destroyed = true;
 window.removeEventListener('resize', fit);
 window.removeEventListener('keydown', onKeydown);
 window.removeEventListener('online', onlineListener);
 clearInterval(psTimer);
 if (toastT) clearTimeout(toastT);
 if (raf) { cancelAnimationFrame(raf); raf = null; }
 if (autoRAF) cancelAnimationFrame(autoRAF);
 stopFly(); stopInertia();
 Object.keys(packRecs).forEach(function (k) {
 var r = packRecs[k];
 if (r && r.abort) { try { r.abort.abort(); } catch (e) { /* already settled */ } }
 if (r) clearTimeout(r.timeoutT);
 });
 if (searchEl && searchEl.parentNode) searchEl.parentNode.removeChild(searchEl);
 if (window.__pig === pig) { try { delete window.__pig; } catch (e) { window.__pig = undefined; } }
 }
 return { destroy: destroy, pig: pig };
}
