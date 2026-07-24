// Type surface for the ported Matte Atlas globe engine (engine.js — vanilla JS module,
// carried over at parity from the 2026-07-16 mockup; typed at the boundary only).
export interface GlobeData {
 world: unknown;
 terrain: unknown;
 us: unknown;
 conus?: unknown;
 cities: unknown[];
 citypolys: unknown;
 content: Record<string, unknown>;
}

export interface GlobeInitOptions {
 root: HTMLElement;
 data: GlobeData;
 /** URL prefix the pack-loader fetches per-region detail packs from (default 'packs/'). */
 packBase?: string;
 /** URL prefix for lazily-fetched shared data (physical-geography pack; default 'data/'). */
 dataBase?: string;
}

export interface GlobeHandle {
 destroy: () => void;
 /** The QC hook surface (also exposed as window.__pig for the oracle). */
 pig: Record<string, (...args: never[]) => unknown> & { ready: boolean };
}

export function initGlobe(opts: GlobeInitOptions): GlobeHandle;
