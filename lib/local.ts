// lib/local.ts
//
// The LOCAL LAYER (R31 pilot — San Diego County + Virginia Beach). A local area is a
// first-class record, same flat-JSON pattern as data/facts.json. Everything the reader sees
// on a /local/[slug] page is a projection of one LocalArea record.
//
// Hard rule (Pigeon red line + QC): every heritage claim carries a primary/authoritative
// source and is checkable. Prose is rule-based template built from STRUCTURED data
// (Wikidata CC0 + curated primary-sourced constants) — never LLM-generated in this pilot,
// never invented. A field with no real data renders a labeled "not yet available" state.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FactRecord } from './types';
import type { SourceTier } from './llm/provider';

// The pride-in-America markers (Timn's filter). Exclusion is silent — we simply don't feature.
// Broadened 2026-07-13 (R33/R31 feedback): beyond the original honor markers, we also feature
// the accomplished and notable FROM an area across public life — athletes, politicians, business
// founders, inventors, authors, actors, musicians — every one a real Wikidata entity born in /
// from the area. Category bucketing is approximate (a person with several occupations lands in
// one bucket by a fixed priority); it is a soft grouping, never a factual claim about the person.
export type LocalMarker =
 | 'medal_of_honor'
 | 'olympic'
 | 'astronaut'
 | 'signer'
 | 'pioneer'
 | 'athlete'
 | 'politician'
 | 'entrepreneur'
 | 'inventor'
 | 'author'
 | 'actor'
 | 'musician';

export type LocalSource = {
 outlet: string;
 url: string;
 tier: SourceTier;
};

export type LocalFigure = {
 name: string;
 known_for: string; // factual, structured — the marker + (where present) discipline/medal
 marker: LocalMarker;
 wikidata_qid: string;
 // A brief one-sentence explanation of what made the person notable, shown on tap (build-out B).
 // Built ONLY from real structured fields: the Wikidata English schema:description (CC0), combined
 // with the achievement marker (known_for) where the bare description would be thin. Never LLM,
 // never invented — omitted (name shows alone) where no clean description exists.
 blurb?: string;
 sources: LocalSource[];
};

export type LocalSite = {
 name: string;
 nrhp_ref: string; // National Register reference number — kept in DATA only (load-bearing: it
 // builds the NPS linkout). NEVER rendered to the reader (R33: no catalog artifacts in the UI).
 url: string; // NPS asset-detail linkout
 // A brief one-sentence explanation of what the site is / why it is historic, shown on tap
 // (build-out B). Built ONLY from the Wikidata English schema:description (CC0). Never invented —
 // omitted (site name shows alone) where no clean, non-generic description exists.
 blurb?: string;
};

// A notable COMPANY founded / headquartered in the area (Wikidata CC0, by P159/P740 in the area).
// Name only in the reader UI — the QID is data-plane provenance, never surfaced .
export type LocalCompany = {
 name: string;
 wikidata_qid: string;
};

export type LocalMarkerLinkout = {
 title: string;
 hmdb_url: string; // HMdb.org is copyrighted -> LINK ONLY (never ingested)
};

// "Worth Exploring" — a curated, confirmed park / public-land unit. Federal units are public
// domain (17 U.S.C. §105); state/local are open-data linkouts. Each carries a plain one-line
// description and a linkout to the managing agency's own page — no fabricated parks (Pigeon red
// line). tier groups the entry under National / State / Local in the reader UI.
export type LocalPark = {
 name: string;
 note: string; // one honest line, 5th-grade register
 url: string; // official managing-agency page (verified resolving at build authoring)
 tier: 'national' | 'state' | 'local';
};

// A LOCAL-GOVERNMENT linkout entry (law enforcement, school board, schools). Where no machine
// feed exists (Research confirmed sheriff/PD/school-board portals have NO public RSS/API), the honest
// pilot treatment is a labeled linkout to the agency's own page — never a fabricated feed.
// `facts` holds facts-only lines (e.g. an enrollment count from NCES) — never a judgment/rating.
export type LocalGovLink = {
 name: string;
 note: string;
 url: string;
 facts?: string[];
};

export type LocalGov = {
 law_enforcement: LocalGovLink[];
 school_boards: LocalGovLink[];
 education: LocalGovLink[];
};

export type LocalHeritage = {
 founding: { year: number | null; driver: string; text: string; sources: LocalSource[] };
 economy: { text: string; sources: LocalSource[] };
 statehood: { admitted: string; note: string; sources: LocalSource[] };
 figures: LocalFigure[];
 companies: LocalCompany[];
 sites: LocalSite[];
 markers_linkout: LocalMarkerLinkout[];
};

// Real county / independent-city boundary (extracted at build time from the Census TIGERweb
// GeoServices REST API — high-res GeoJSON — with a us-atlas TopoJSON fallback; both static-safe,
// baked into the committed JSON so the runtime/deploy has zero external dependency).
// Rings are [lon,lat] pairs; the client map fits them to its viewBox with a linear projection.
export type LocalBoundary = {
 rings: [number, number][][];
 bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
} | null;

// ---- A2 engraved-relief map layers (all from REAL free/PD data, baked at build) --------------
// A principal town mark. `primary` = the area's current-view (ink-red) mark; others are quiet
// tap-through circles (R37 preview). Source: Census TIGERweb Incorporated Places, point-in-polygon
// filtered to the real boundary (so a neighbor city in the bbox is correctly excluded).
export type LocalTownMark = { name: string; lon: number; lat: number; primary: boolean };

// A single elevation contour line (chained iso-line polyline in [lon,lat]). Source: an elevation
// grid sampled from OpenTopoData (ASTER GDEM, public) + marching squares. Clipped to the boundary
// in SVG (never drawn where there is no county). Empty for genuinely flat areas (honest, not faked).
export type LocalContour = { level: number; points: [number, number][] };

// A high-elevation cluster centre (a real massif, from connected high-elevation grid cells) — the
// centre of an A2 olive "mountain wash" radial. Empty for flat areas.
export type LocalMassif = { lon: number; lat: number; rx: number; ry: number };

// A major river polyline, clipped to the bbox (Natural Earth 10m North-America rivers, PD).
// Main marks only — not every creek. Empty where no major river is on record for the area.
export type LocalRiver = { name: string; points: [number, number][] };

// ATLAS-GRADE additions (iteration 5) --------------------------------------------------------
// A baked shaded-relief x hypsometric-tint COMPOSITE raster (the standard atlas pipeline —
// Design's recommendation over runtime SVG filters). Generated at build from the real DEM grid:
// per-pixel hypsometric colour (coast green -> mountain brown -> desert ochre) modulated by a
// Horn's-method hillshade (NW light). One PNG per theme (light/dark), embedded as a data URI so
// the static export has ZERO external/runtime dependency. `bbox` is the geographic extent the
// image spans (== the DEM/boundary bbox) so the client positions it precisely in the projection,
// then clips it to the real boundary. Null for flat/city areas that carry no relief.
export type LocalRelief = {
 light: string; // data:image/png;base64,... (hillshade x hypsometric, light theme)
 dark: string; // data:image/png;base64,... (dark theme)
 bbox: [number, number, number, number]; // [minLon,minLat,maxLon,maxLat] the raster covers
 w: number;
 h: number;
} | null;

// A named NATURAL feature label, atlas convention (italic serif): ocean, mountain range, desert,
// bay/water. Curated per area from well-established geography (a label, not a data layer) — flagged
// `curated: true`. Never a coordinate/measurement; just the name placed at a representative point.
export type LocalFeatureLabel = {
 name: string;
 lon: number;
 lat: number;
 kind: 'ocean' | 'range' | 'desert' | 'water' | 'park' | 'beach';
 curated?: boolean;
};

// ---- CITY-SCALE layers (R44: a city page zooms to streets, not county relief) ----------------
// A real street / artery, from the Census TIGER/Line ROADS shapefile (public domain). `cls`
// groups it for the render weight: interstate (heavy casing, incl. I-264) / arterial (medium) /
// minor. Named where TIGER carries a FULLNAME.
export type LocalRoad = { name: string; cls: 'interstate' | 'arterial' | 'minor'; points: [number, number][] };

// A real water body polygon, from the Census TIGER/Line AREAWATER shapefile (public domain) —
// Chesapeake Bay, Lynnhaven River, Back Bay, Rudee Inlet, the Atlantic edge. Rings are [lon,lat].
export type LocalWaterArea = { name: string | null; rings: [number, number][][] };

// A curated district / neighbourhood point-label (Town Center, Lynnhaven, Great Neck, Kempsville,
// Sandbridge, Oceanfront). No authoritative neighbourhood-polygon source exists for the pilot, so
// these are curated point-labels (flagged in data_notes). `primary` = the current-view mark.
export type LocalDistrict = { name: string; lon: number; lat: number; primary?: boolean };

// A PROGRESSIVE place-label (labels-LOD): a finer, real place name that appears only when the
// reader zooms past `minZoom` (like a real atlas revealing more names as you zoom in). Curated real
// names placed at representative points (flagged in data_notes) — the coordinate positions the label
// and is NEVER rendered . `style` picks the house type: 'natural' = italic serif (physical /
// natural features — parks, inlets, capes, beaches); 'place' = Inter (cultural places — a boardwalk,
// a base, a neighbourhood). Reusable across any city map, not VB-specific.
export type LocalLabelLOD = {
 name: string;
 lon: number;
 lat: number;
 style: 'natural' | 'place';
 minZoom: number;
};

// The map payload. `scale` selects the render: 'county' = atlas relief (baked hillshade x
// hypsometric + contours + rivers + towns + named features); 'city' = street-level (roads + water
// + districts). Everything is derived from REAL data at build time; a flat coastal county still
// carries no contours (honest, not a gap).
export type LocalMapData = {
 scale: 'county' | 'city';
 ocean_bearing: number | null; // compass degrees to open water (for the sea ripple + water label); null if landlocked
 water_label: string | null; // e.g. "PACIFIC" / "ATLANTIC" — a real geographic label, not data
 tint: 'coast_desert' | 'coastal'; // A2 wash ramp variant: sage->ochre (relief county) vs coastal sage
 elev: { min: number; max: number } | null; // metres, from the sampled DEM
 contours: LocalContour[];
 massifs: LocalMassif[];
 towns: LocalTownMark[];
 rivers: LocalRiver[];
 // atlas-grade (county) additions:
 relief?: LocalRelief; // baked hillshade x hypsometric composite (both themes)
 features?: LocalFeatureLabel[]; // named natural features (italic serif atlas labels)
 // city-scale additions:
 roads?: LocalRoad[];
 water_areas?: LocalWaterArea[];
 districts?: LocalDistrict[];
 // Progressive place-labels (labels-LOD): finer real place names revealed as the reader zooms in
 // (atlas convention — more names appear at closer zoom). Overview shows the districts above; these
 // appear at/above each label's `minZoom`. Curated real names (flagged in data_notes); coordinates
 // position them and are never rendered .
 labels?: LocalLabelLOD[];
 // Progressive detail (LOD): the fine local-street mesh (TIGER/Line S1400) is NOT inlined here —
 // it is baked to a separate static asset (public/local/<slug>/streets.json, a flat array of
 // [lon,lat] polylines) that the client fetches on the FIRST zoom-in past the detail threshold.
 // This keeps the overview page payload light (zero added weight until the reader zooms). `file`
 // is resolved relative to the area page URL (basePath-agnostic); `count` is the segment count.
 fine_streets?: { file: string; count: number } | null;
} | null;

export type LocalVocab = { word: string; definition: string };

// A local OUTLET / civic feed we LINK to (never ingest as a vetted fact — raw news headlines
// can't clear the fact/opinion gate without the classifier, so outlets are a link-out directory,
// not asserted content). Presence of outlets here is the honest counter to a "news desert" claim.
export type LocalOutlet = {
 name: string;
 url: string;
 kind: 'news' | 'civic_video' | 'gov'; // what the outlet is
 scope: 'local' | 'state'; // local-to-this-area vs. statewide
 paywalled?: boolean; // red line: a paywalled outlet is flagged, never hidden
};

// ---- FREE, REAL civic-news layer (build-out C1) ---------------------------------------------
// The FREE real-content layer: at build time we fetch the confirmed local-news RSS feeds for the
// area, keep only items that match the civic topics (schools, land/zoning, taxes/budget, business/
// economy, elections, local offices) and drop crime/accident/obituary/sports/human-interest — a
// rule-based keyword heuristic, NO LLM. We show the REAL headline, outlet, date, and a link out to
// the source. We do NOT write summaries and never fabricate an item. A separate AI-distilled weekly
// summary is a LATER PAID layer — not built here.
export type LocalNewsItem = {
 title: string; // the outlet's real headline, verbatim (never rewritten, never invented)
 outlet: string; // which local outlet published it
 url: string; // link out to the source article
 date: string; // ISO 8601 publish date
 scope: 'local' | 'state'; // local-to-this-area vs. a statewide outlet
};

export type LocalCivicNews = {
 items: LocalNewsItem[]; // recent (~7 days) real civic headlines, newest first — may be empty
 generated_at: string;
 // AI-distilled weekly civic summary (build-out D, R49+R53). A short "This week" summary of the
 // week's KEPT local headlines, produced by the cost-capped Grok classifier (LLM_PROVIDER=xai).
 // Summarizes ONLY what the real headlines say (no fabrication); house style (5th-grade, past
 // tense, no opinion, no emoji). Absent when the mock provider is active or no items survived.
 summary?: string;
 // Which layer produced `items`/`summary`: 'grok' when the paid fact-vs-opinion + geo classifier
 // judged the survivors; 'keyword' when only the free keyword pre-filter ran (mock provider).
 gate?: 'grok' | 'keyword';
 // Honest provenance: which feeds resolved, and why the list may be empty (all a plain state,
 // never self-narration about our plumbing — R34).
 note?: string;
};

// ---- FREE, REAL civic calendar (build-out C1) -----------------------------------------------
// Upcoming public meetings + where to find elections. `meetings` holds REAL dated meetings pulled
// from a free government feed (Legistar upcoming events for a county board) — empty when no free
// dated feed exists or the body is in recess (honest, never a projected/invented date).
// `meeting_sources` + `elections` are honest labeled linkouts to the official calendars / registrar
// (where dated data is not freely machine-readable) — flagged as links, not asserted dates.
export type LocalCalendarItem = {
 date: string; // YYYY-MM-DD — a REAL meeting date from a government feed (never projected)
 title: string; // e.g. "Board of Supervisors — meeting"
 url: string; // link out to the agenda / official meeting calendar
};

export type LocalCalendar = {
 meetings: LocalCalendarItem[]; // real upcoming dated meetings from a free feed (may be empty)
 meeting_sources: LocalGovLink[]; // official meeting calendars to check (honest linkouts)
 elections: LocalGovLink[]; // registrar / state elections office — where upcoming election dates live
 generated_at: string;
 note?: string;
};

export type LocalArea = {
 area: {
 name: string;
 kind: 'county' | 'independent_city';
 state: string; // 2-letter
 fips: string;
 parent_county: string | null; // null for an independent city — the schema stress-test
 primary_city: string;
 centroid: [number, number]; // [lon, lat]
 boundary?: LocalBoundary;
 map?: LocalMapData; // A2 engraved-relief layers (real data; may be null if the build couldn't source them)
 };
 heritage: LocalHeritage;
 news: FactRecord[]; // region-tagged GOVERNMENT primary records (primary-by-construction)
 civic_news?: LocalCivicNews; // FREE real civic-news roundup from local RSS feeds (build-out C1)
 calendar?: LocalCalendar; // FREE real civic calendar: upcoming meetings + elections (build-out C1)
 gov?: LocalGov; // government linkouts: law enforcement, school boards, schools (no feeds exist)
 parks?: LocalPark[]; // "Worth Exploring" — curated confirmed parks / public lands
 outlets: LocalOutlet[]; // link-out directory of local outlets + civic feeds (Research-vetted)
 vocab: LocalVocab[]; // R13 education layer
 generated_at: string;
 // Honest provenance: which sources populated live vs. what is a placeholder this build.
 data_notes?: string[];
};

const LOCAL_DIR = join(process.cwd(), 'data', 'local');

function readJson<T>(path: string): T | null {
 try {
 if (!existsSync(path)) return null;
 return JSON.parse(readFileSync(path, 'utf8')) as T;
 } catch {
 return null;
 }
}

// The two pilot slugs (and any future ones) are discovered from the data dir — no hardcoding.
// Map-only exemplar files (e.g. san-diego-city-ca.json, regenerated 2026-07-16 as street-map data
// for the globe's detail packs — {area} only, no heritage/news/civic layers) share this dir but are
// NOT local-desk pages; rendering them would crash the /local/[slug] prerender. A local desk is a
// file that carries the heritage layer — filter on that, not on filename.
export function listLocalSlugs(): string[] {
 try {
 if (!existsSync(LOCAL_DIR)) return [];
 return readdirSync(LOCAL_DIR)
 .filter((f) => f.endsWith('.json'))
 .map((f) => f.replace(/\.json$/, ''))
 .filter((slug) => {
 const doc = readJson<{ heritage?: unknown }>(join(LOCAL_DIR, `${slug}.json`));
 return !!(doc && doc.heritage);
 })
 .sort();
 } catch {
 return [];
 }
}

export function readLocalArea(slug: string): LocalArea | null {
 // Guard against path traversal — slug must be a plain kebab id.
 if (!/^[a-z0-9-]+$/.test(slug)) return null;
 return readJson<LocalArea>(join(LOCAL_DIR, `${slug}.json`));
}

export function listLocalAreas(): { slug: string; area: LocalArea }[] {
 return listLocalSlugs()
 .map((slug) => ({ slug, area: readLocalArea(slug) }))
 .filter((x): x is { slug: string; area: LocalArea } => x.area !== null);
}

// A slim per-area civic-news summary for the client "my local areas" layer (build-out C2):
// slug + name + state + the area's real civic-news items. Baked into the Today headline (dates
// only, for the honest "N new" count) and the /local/feed page (full items, aggregated client-side
// by the reader's localStorage set). No fabrication — items come straight from the committed JSON.
export type LocalCivicSummary = {
 slug: string;
 name: string;
 state: string;
 kind: LocalArea['area']['kind'];
 items: LocalNewsItem[];
};

export function listLocalCivicSummaries(): LocalCivicSummary[] {
 return listLocalAreas().map(({ slug, area }) => ({
 slug,
 name: area.area.name,
 state: area.area.state,
 kind: area.area.kind,
 items: area.civic_news?.items ?? [],
 }));
}
