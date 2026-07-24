// lib/ranking/personalize.ts
//
// PER-READER personalization LAYER (Ranking Model v1, R2 build — spec
// docs/RANKING_MODEL_V1_SPEC_2026-07-17.md). This sits ON TOP of the importance engine
// (lib/ranking/importance.ts). It reorders and cuts the feed per reader from three inputs held
// only in the browser: last-visit time, seen-story ids, explicit category picks (+ light signals).
//
// THE RED LINE (enforced by CONSTRUCTION, not by a tuned multiplier):
// Tier bands are hard walls. Personalization reorders and cuts stories *within* a band. It can
// NEVER promote a story across a band boundary. A reader who only picked "economics" still gets
// the war LEAD if the editorial engine scored it HIGH-tier. We PARTITION by band, then sort
// WITHIN each band, then concatenate HIGH → MID+LOW. Because HIGH is emitted before MID/LOW by
// assembly order, no interest weight can ever lift a MID story above a HIGH story. The caps on
// the interest/cadence multipliers are belt-and-suspenders, not the safety mechanism.
//
// Grounding: NYT/BBC/VRT (editors own the tiers, algorithms rank the tail), Yahoo! JAPAN UTDF
// (cadence anchored to last visit), FD "MissedLastWeek", and desk rulings R88/R96/R98/R100/R104/
// R105. Pure functions, no node deps — safe to import in the client island, same constraint as
// importance.ts. Consumes scoreFact/mix/rankForHome; does NOT modify their internals.

import type { FactRecord, Category } from '../types';
import { scoreFact, mix, rankForHome, type ScoredFact } from './importance';

// ---- the reader profile (shape owned here; app/personalize/profileStore.ts persists it) --------

export type ReaderProfile = {
 lastVisit: string | null; // ISO of the PREVIOUS visit (null = first-ever visitor)
 seenIds: string[]; // story ids already shown on a prior visit (LRU-capped in the store)
 picks: Category[]; // explicit category priorities the reader chose (may be empty)
 // light implicit signal, bounded in the store; a MISSING key reads as 0.
 signals: Partial<Record<Category, number>>;
};

// ---- TUNING (CALIBRATION-PENDING) --------------------------------------------------------------
// Every number below is a calibration-pending DEFAULT, tuned in desk-session week drills — NOT
// locked. The literature publishes none of these (research report §6). Keep them in this one block.
export const TUNING = {
 // cadence classification
 LAPSED_GAP_DAYS: 3, // >= this many days away ⇒ catch-up ("lapsed") reader 
 // LEAD selection (R100 + R104 + R105)
 LEAD_COUNT_DAILY: 1, // daily reader: the single biggest NEW unseen HIGH story
 LEAD_COUNT_LAPSED: 2, // lapsed reader carries ~1 more lead-tier story 
 MISSED_WINDOW_MAX_DAYS: 7, // "missed" window never reaches back more than a week (FD precedent)
 // cadence boost (Yahoo! JAPAN UTDF): anchor the decay to the reader's last visit
 CADENCE_BOOST_SEEN: 0.8, // already-seen tail decays so it isn't re-served first
 CADENCE_BOOST_FRESH: 1.25, // unseen AND dated after last visit ⇒ "new since you were here"
 CADENCE_BOOST_NEUTRAL: 1.0, // unseen but older than last visit, or no last visit
 // interest weight (explicit picks + light signals), capped so it never crosses a band
 INTEREST_PICK_MULT: 1.35, // category ∈ picks
 INTEREST_SIGNAL_STEP: 0.05, // per signal point
 INTEREST_CLAMP_MIDLOW: [0.85, 1.5] as [number, number], // MID/LOW: interest tunes order freely
 INTEREST_CLAMP_HIGH: [0.95, 1.15] as [number, number], // HIGH: near-pure importance (R97 shared)
 // cadence-adaptive cutline + length (R88 + R98 + R100 variable window)
 CUTLINE_MIDLOW_DAILY: 30, // daily: normal bar
 CUTLINE_MIDLOW_LAPSED: 42, // lapsed: RAISE the bar — only what mattered survives 
 TAIL_LEN_DAILY: 40, // daily: the tight 5-minute MID+LOW budget
 TAIL_LEN_LAPSED: 55, // lapsed: longer catch-up budget (R100/R105, 15-20 min)
};

// ---- detailed result (feed uses leadIds + unseenHighInWindow for the honest kicker) ------------

export type ReaderRanking = {
 order: FactRecord[]; // final assembled per-reader order (=== rankForReader output)
 leadIds: string[]; // the per-reader LEAD selection (top-of-feed items)
 lapsed: boolean; // 3+ days away
 gapDays: number; // days since last visit (0 for first-ever / same-day)
 unseenHighInWindow: number; // honest count for the "since your last visit" kicker
};

// ---- helpers -----------------------------------------------------------------------------------

function tsOf(f: FactRecord): number {
 const t = Date.parse(f.datetime_utc);
 return Number.isNaN(t) ? 0 : t;
}

function clampRange(v: number, [lo, hi]: [number, number]): number {
 return Math.max(lo, Math.min(hi, v));
}

// A profile with NO signal at all: nothing to personalize on ⇒ pure editorial order. This is the
// required cold-start behavior (spec §2/§5), not a fallback — a brand-new reader gets rankForHome
// exactly, so personalization is a verifiable no-op on the first-ever visit.
function isNeutral(p: ReaderProfile): boolean {
 const noVisit = !p.lastVisit;
 const noSeen = !p.seenIds || p.seenIds.length === 0;
 const noPicks = !p.picks || p.picks.length === 0;
 const noSignals = !p.signals || Object.values(p.signals).every((v) => !v);
 return noVisit && noSeen && noPicks && noSignals;
}

function cadenceBoost(f: FactRecord, lastVisitMs: number | null, seen: Set<string>): number {
 if (lastVisitMs === null) return TUNING.CADENCE_BOOST_NEUTRAL;
 if (seen.has(f.id)) return TUNING.CADENCE_BOOST_SEEN; // seen → decay
 return tsOf(f) >= lastVisitMs ? TUNING.CADENCE_BOOST_FRESH : TUNING.CADENCE_BOOST_NEUTRAL;
}

function interestWeight(cat: Category, p: ReaderProfile, clamp: [number, number]): number {
 let w = 1.0;
 if (p.picks && p.picks.includes(cat)) w *= TUNING.INTEREST_PICK_MULT;
 const sig = p.signals?.[cat] ?? 0;
 w *= 1 + TUNING.INTEREST_SIGNAL_STEP * sig;
 return clampRange(w, clamp);
}

// Within-band blended key. NEVER leaves the band (assembly order is the wall); editorial importance
// stays the dominant term, cadence + interest only re-order inside the band.
function readerKey(
 s: ScoredFact,
 p: ReaderProfile,
 lastVisitMs: number | null,
 seen: Set<string>,
 clamp: [number, number],
): number {
 return s.score * cadenceBoost(s.fact, lastVisitMs, seen) * interestWeight(s.fact.category, p, clamp);
}

function byScoreDescThenNewest(a: ScoredFact, b: ScoredFact): number {
 if (b.score !== a.score) return b.score - a.score;
 return tsOf(b.fact) - tsOf(a.fact);
}

function dedupeByFactId(list: ScoredFact[]): ScoredFact[] {
 const seen = new Set<string>();
 const out: ScoredFact[] = [];
 for (const s of list) {
 if (!seen.has(s.fact.id)) {
 seen.add(s.fact.id);
 out.push(s);
 }
 }
 return out;
}

// ---- the algorithm -----------------------------------------------------------------------------

export function rankForReaderDetailed(
 facts: FactRecord[],
 profile: ReaderProfile,
 now = Date.now(),
): ReaderRanking {
 // Cold-start: no reader state ⇒ pure editorial order (spec §5 exact-equality requirement).
 if (isNeutral(profile)) {
 return { order: rankForHome(facts, now), leadIds: [], lapsed: false, gapDays: 0, unseenHighInWindow: 0 };
 }

 // 3.1 score + drop buried (identical to rankForHome; R96 — buried never surfaces).
 const scored = facts.map((f) => scoreFact(f, now)).filter((s) => s.tier !== 'BURIED');

 // 3.2 cadence.
 const lastVisitMs = profile.lastVisit ? Date.parse(profile.lastVisit) : null;
 const gapDays =
 lastVisitMs !== null && !Number.isNaN(lastVisitMs) ? Math.max(0, (now - lastVisitMs) / 86_400_000) : 0;
 const lapsed = gapDays >= TUNING.LAPSED_GAP_DAYS;
 const seen = new Set(profile.seenIds ?? []);
 const isUnseen = (s: ScoredFact) => !seen.has(s.fact.id);

 // 3.3 partition into hard-walled bands. These lists are never merged across boundaries below.
 const high = scored.filter((s) => s.tier === 'HIGH');
 const mid = scored.filter((s) => s.tier === 'MED');
 const low = scored.filter((s) => s.tier === 'LOW');

 // 3.4 LEAD selection (R100 + R104 + R105) — from the HIGH band, against the UNSEEN set, within
 // the missed window. Older-than-window HIGH items still appear in the HIGH body, just not as LEAD.
 const leadCount = lapsed ? TUNING.LEAD_COUNT_LAPSED : TUNING.LEAD_COUNT_DAILY;
 const windowDays = Math.min(Math.max(gapDays, 1), TUNING.MISSED_WINDOW_MAX_DAYS);
 const windowStartMs = now - windowDays * 86_400_000;
 const inWindow = (s: ScoredFact) => tsOf(s.fact) >= windowStartMs;

 const unseenHighInWindowList = high.filter(isUnseen).filter(inWindow);
 const leads = unseenHighInWindowList.slice().sort(byScoreDescThenNewest).slice(0, leadCount);
 const leadIds = new Set(leads.map((s) => s.fact.id));

 // 3.5 within-band reorder (cadence + interest, capped). HIGH stays near-pure importance so the
 // universal "what mattered" layer is shared across readers (R97 recognition gate).
 const highBody = high
 .filter((s) => !leadIds.has(s.fact.id))
 .sort(
 (a, b) =>
 readerKey(b, profile, lastVisitMs, seen, TUNING.INTEREST_CLAMP_HIGH) -
 readerKey(a, profile, lastVisitMs, seen, TUNING.INTEREST_CLAMP_HIGH),
 );

 // 3.7 cadence-adaptive cutline + length (R88 + R98 + R100). Cutline is a MINIMUM editorial score
 // for the MID/LOW tail; the lapsed reader's raised bar buries the marginal.
 const cutline = lapsed ? TUNING.CUTLINE_MIDLOW_LAPSED : TUNING.CUTLINE_MIDLOW_DAILY;
 const tailLen = lapsed ? TUNING.TAIL_LEN_LAPSED : TUNING.TAIL_LEN_DAILY;
 const tailBand = [...mid, ...low].filter((s) => s.score >= cutline);

 // 3.6 diversify the tail (REUSE the existing mix()). mix() ranks by `.score` and applies the PSM
 // category-repetition guts (CONSEC_CAP=2 / WINDOW_CAP=3). To keep the reader's within-band order
 // as the ranking priority while still diversifying, we hand mix() ScoredFact COPIES whose `.score`
 // is the reader's blended key — so mix() diversifies over the personalized order, not raw score.
 // The `.fact` reference is preserved, so the mapping back is exact. The wall is untouched: this
 // only ever operates on MID+LOW (HIGH/leads never go through mix, per §3.6).
 const keyedTail: ScoredFact[] = tailBand.map((s) => ({
 ...s,
 score: readerKey(s, profile, lastVisitMs, seen, TUNING.INTEREST_CLAMP_MIDLOW),
 }));
 const mixedTail = mix(keyedTail).slice(0, tailLen);

 // 3.8 assemble: leads → HIGH body → diversified MID+LOW tail. De-dupe by id defensively.
 const assembled = dedupeByFactId([...leads, ...highBody, ...mixedTail]);

 return {
 order: assembled.map((s) => s.fact),
 leadIds: [...leadIds],
 lapsed,
 gapDays,
 unseenHighInWindow: unseenHighInWindowList.length,
 };
}

// Public entry point (spec §3 signature). Pure, client-safe; does not touch importance.ts internals.
export function rankForReader(
 facts: FactRecord[],
 profile: ReaderProfile,
 now = Date.now(),
): FactRecord[] {
 return rankForReaderDetailed(facts, profile, now).order;
}
