'use client';

// GlobeClient — mounts the ported Matte Atlas engine (engine.js) over the static HUD shell.
// Boot model (UX pack-loading spec framing): ONE fetch wave of base geometry (world + US topo +
// cities + city boundary polys + feed templates) then the engine boots fully interactive; detail
// packs (SD/VB exemplars) stay lazy and are fetched by the engine's pack-loader on drill-in.
// The boot line is honest copy (same #packstatus vocabulary) — never a fake map.

import { useEffect, useRef, useState } from 'react';
import { initGlobe, type GlobeHandle } from './engine';

// Data + packs live under the route's own static dir (public/globe/…), so URLs resolved against
// the /globe/ document URL survive both root-relative dev and the GitHub Pages basePath.
function routeBase(): string {
 const p = window.location.pathname;
 return p.endsWith('/') ? p : p + '/';
}

export default function GlobeClient() {
 const rootRef = useRef<HTMLDivElement | null>(null);
 const handleRef = useRef<GlobeHandle | null>(null);
 const [boot, setBoot] = useState<'loading' | 'ready' | 'failed'>('loading');
 const [attempt, setAttempt] = useState(0);

 useEffect(() => {
 let cancelled = false;
 const base = routeBase();
 const get = (f: string) =>
 fetch(base + 'data/' + f).then((r) => {
 if (!r.ok) throw new Error(f + ' → HTTP ' + r.status);
 return r.json();
 });
 setBoot('loading');
 Promise.all([
 get('world.json'),
 get('us.json'),
 get('cities.json'),
 get('city-polys.json'),
 get('content.json'),
 ])
 .then(([worldPack, usPack, cities, citypolys, content]) => {
 if (cancelled || !rootRef.current) return;
 handleRef.current = initGlobe({
 root: rootRef.current,
 data: {
 world: worldPack.world,
 terrain: worldPack.terrain,
 us: usPack.us,
 conus: usPack.conus,
 cities,
 citypolys,
 content,
 },
 packBase: base + 'packs/',
 // physical-geography pack (Phase 2) — the ENGINE fetches this lazily after first paint;
 // it is deliberately NOT part of the boot Promise.all wave above.
 dataBase: base + 'data/',
 });
 setBoot('ready');
 })
 .catch(() => {
 if (!cancelled) setBoot('failed');
 });
 return () => {
 cancelled = true;
 if (handleRef.current) {
 handleRef.current.destroy();
 handleRef.current = null;
 }
 };
 }, [attempt]);

 return (
 <div id="globeroot" ref={rootRef} data-skin="globe">
 <div id="stage">
 <canvas
 id="globe"
 aria-label="Interactive world globe. Drag to spin, scroll to zoom, click a region to read the fact."
 />
 </div>

 {boot !== 'ready' && (
 <div id="globeboot" className={boot === 'failed' ? 'failed' : ''}>
 <div className="gb-line">
 <span className="gb-dot" />
 {boot === 'failed' ? (
 <>
 Couldn&rsquo;t load the globe&rsquo;s map data.
 <button className="gb-retry" onClick={() => setAttempt((a) => a + 1)}>
 Retry
 </button>
 </>
 ) : (
 <>Loading the atlas&hellip;</>
 )}
 </div>
 </div>
 )}

 <div className="hud masthead">
 <div className="kick">
 <a href="../">Pigeon</a>
 </div>
 <div className="title">World → Local</div>
 <div className="sub">Grab the world. Spin it. Zoom from the whole planet down into your local news.</div>
 </div>

 {/* The two hard-coded drill cards (San Diego / Virginia Beach) were removed 2026-07-24:
 "on the landing page for globe it should be clean in that it is just the globe."
 Reaching a place is the globe's own job — spin and zoom, or click a region and take
 the option offered in the pop-up. Nothing about who you follow belongs on this screen. */}

 <div className="hud leveltag" id="leveltag" />
 <div className="hud localtitle" id="localtitle">
 <button className="lt-close" id="lt-close" type="button" aria-label="Back">
 &times;
 </button>
 <div id="lt-inner" />
 <div id="packstatus">
 <span className="ps-dot" />
 <span className="ps-txt" />
 <button className="ps-retry" hidden>
 Retry
 </button>
 </div>
 </div>

 <div className="hud crumbs" id="crumbs" />

 <div className="hud zoom">
 <button id="zin" title="Zoom in" aria-label="Zoom in">
 +
 </button>
 <button id="zout" title="Zoom out" aria-label="Zoom out">
 &#8722;
 </button>
 <button id="zreset" className="reset" title="Reset to world" aria-label="Reset to world">
 World
 </button>
 </div>

 <div className="hud hint">
 <div>
 <b>Drag</b> to spin · <b>Scroll</b> / pinch to zoom · <b>Click</b> a region to read the fact
 </div>
 <div>
 Zoom <span className="key">+</span>
 <span className="key">-</span> · World <span className="key">0</span> · Search <span className="key">/</span>
 </div>
 </div>

 <div id="tip" />
 <div id="toast" />

 <aside id="card" aria-label="Story reader">
 <div className="cx">
 <span className="ct" id="cardtitle">
 Dispatch
 </span>
 <button id="cardclose" aria-label="Close">
 &times;
 </button>
 </div>
 <div className="body" id="cardbody" />
 </aside>
 </div>
 );
}
