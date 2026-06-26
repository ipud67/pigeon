// lib/ranking/importance.ts
//
// THE importance ranking engine (SPEC v2 §A), encoding Clark's News-Relevance Rubric v1
// (from_clark_relevance_rubric_2026-06-26.md) rather than the rough SPEC heuristic. The
// core fix for round 1's failure: the home "All" feed was a raw arrival-order dump, so the
// first ~15 headlines were ALL economics / SEC-8-K micro-filings. That is not a 5-minute
// big picture.
//
// Score model (Clark §4), 0-100, NO LLM:
//   importance_raw = W_type(0-55) + W_actor(0-15) + W_scale(0-15) + W_corrob(0-8) + W_geo(0-7)
//   importance     = round(importance_raw * R_recency)         // §4.5 multiplicative 0.55-1.0
//   then NOISE CAPS / FLOORS (§4.6) override; then voice:advocacy discount; clamp [0,100].
//
// Mixer (Clark §5): greedy MMR-style rerank — consecutive-category cap 2, top-8 window max 3
// per category, ≥4-category spread floor, >20-point score-gap override.
//
// Pure functions, no node deps — safe to import in a client island. Grounding: Galtung &
// Ruge (1965) / Harcup & O'Neill (2001) news-values, AP/Reuters budget-meeting triage,
// McCombs & Shaw (1972) agenda-setting. The mission governs: "does this help a 5-minute
// reader understand what actually mattered?" If no, it does not belong on the home page.

import type { FactRecord, Category } from '../types';
import { hasAdvocacyVoice } from '../editorial/neutralize';

export type ImportanceTier = 'HIGH' | 'MED' | 'LOW' | 'BURIED';

export type ScoredFact = {
  fact: FactRecord;
  score: number; // 0-100
  tier: ImportanceTier;
  reason: string;
  advocacy: boolean; // voice:advocacy framing detected (down-weighted + neutralized on render)
};

// ---- regex signal library --------------------------------------------------

const RE_FORCE =
  /\b(deploys?|deployment|federaliz\w*|national guard|troops?|withdraw\w* (troops|forces)|airstrikes?|air strike|missile strike|launch\w* (a |an )?(strike|offensive|attack)|invasion|incursion|offensive operations?|combat operations?|boots on the ground|no-fly zone|declares? war|act of war|escalat\w* (the )?(war|conflict)|ceasefire|peace (deal|agreement|talks)|mutual defense|defense pact|insurrection act|arms (deal|sale|shipment|transfer)|military aid|nuclear (test|weapon|program)|naval (movement|deployment)|mobiliz\w*)\b/i;
const RE_EXEC_ACTION =
  /\b(executive order|proclamation|presidential memorandum|national security (presidential )?memorandum|\bnspm\b|the president (signed|issued|ordered|directed|proclaimed)|hereby ordered|by the authority vested in me|signs? (an )?executive order)\b/i;
const RE_FOMC =
  /\b(fomc|federal open market committee|federal funds rate|monetary policy|rate (decision|cut|hike)|raises? (its )?rates|lowers? (its )?rates|basis points|dot[- ]plot|quantitative (easing|tightening))\b/i;
const RE_MACRO_DATA =
  /\b(employment situation|nonfarm payroll|unemployment rate|jobs report|consumer price index|producer price index|\bcpi\b|\bppi\b|\bpce\b|gross domestic product|\bgdp\b|inflation (rose|fell|rate|data|print))\b/i;
const RE_TRADE_ACTION =
  /\b(section 232|section 301|\bieepa\b|tariffs?|sanction(s|ed|ing)?|trade (deal|war|agreement|pact)|embargo|export controls?|de-?dollar|currency (peg|war)|countervailing dut\w+|antidumping)\b/i;
const RE_SYSTEMIC_MKT =
  /\b(circuit breaker|market crash|bank failure|sovereign default|failed (treasury )?auction|yield spike|debt ceiling|government shutdown|continuing resolution)\b/i;
const RE_CONSTITUTIONAL =
  /\b(constitution\w*|unconstitutional|amendment|stare decisis|first amendment|second amendment|fourth amendment|fifth amendment|fourteenth amendment|struck down|strikes down|overturn\w*|enjoin\w*|injunction|emergency (docket|stay)|merits|major questions)\b/i;
const RE_FOREIGN_SHIFT =
  /\b(treaty|memorandum of understanding|\bmou\b|bilateral agreement|nuclear|coup|annex\w*|contested election|security council|alliance|summit)\b/i;
const RE_NATL_POLICY =
  /\b(national strateg\w*|resilience strategy|vaccine schedule|childhood (vaccine|immuniz)|schedule (f|policy\/career)|civil service|immigration enforcement|nationwide|across the country|every (family|american))\b/i;
const RE_NOMINATION =
  /\b(nominat\w+ (to|for)|confirmation|to serve as (director|secretary|chair|governor|justice|judge))\b/i;

// DoD soft / ceremonial output — real, but low-importance for a 5-min reader.
const RE_MIL_SOFT =
  /\b(readiness|disaster relief|humanitarian (relief|assistance|aid)|families|missing (service members|in action)|remembr\w*|ceremon\w*|memorial|honor\w*|tribute|recruit\w*|graduat\w*|\bsports?\b|athlete|military children|spotlight|profile|hall of fame|wreath|medal|unit renam\w*)\b/i;

// ---- §4.6 noise caps (title/outlet regex; applied LAST, override everything) ------------
const CAP_SEC_FILING = { re: /(^|\b)(\d?\d?-?[KQ]\b|\(filer\)|form (8-?k|10-?[qk]|s-1))/i, cap: 8 };
const CAP_FR_NOTICE = {
  re: /\b(information collection|paperwork reduction|omb review|privacy act of 1974|sunshine act|system of records|comment request|submission for omb)\b/i,
  cap: 10,
};
const CAP_CEREMONIAL = {
  re: /\b(presidential message|national [a-z ]+ (week|month|day),? \d{4}|anniversary|flag (day|week)|father'?s day|mother'?s day|memorial day|veterans day|independence day)\b/i,
  cap: 12,
};
const CAP_ADMIN = {
  re: /\b(hearth act|leasing ordinance|uniform allowance|notice of filing of complaint|cost-of-living adjustment)\b/i,
  cap: 15,
};

// ---- helpers ---------------------------------------------------------------

function blob(f: FactRecord): string {
  return `${f.what} ${f.deck ?? ''} ${f.context ?? ''}`.toLowerCase();
}
function outletOf(f: FactRecord): string {
  return f.sources[0]?.outlet ?? '';
}

// ---- §2 event-type band -> W_type (0-55) -----------------------------------

function wType(f: FactRecord): { w: number; reason: string } {
  const t = blob(f);
  const cat = f.category;

  // BAND A (46-55)
  if (cat === 'war' && RE_FORCE.test(t)) return { w: 50, reason: 'war / force-posture (Band A)' };
  if (RE_FORCE.test(t) && /\b(national guard|insurrection act|troops?|federaliz)/i.test(t))
    return { w: 49, reason: 'domestic force-posture (Band A)' };
  if (outletOf(f) === 'Federal Reserve' && RE_FOMC.test(t))
    return { w: 52, reason: 'FOMC monetary-policy decision (Band A)' };
  if (RE_TRADE_ACTION.test(t) && /\b(section 232|section 301|ieepa|tariff|sanction)/i.test(t))
    return { w: 50, reason: 'major trade / sanctions action (Band A)' };
  if (RE_SYSTEMIC_MKT.test(t)) return { w: 50, reason: 'systemic market / fiscal event (Band A)' };
  if (cat === 'courts' && RE_CONSTITUTIONAL.test(t))
    return { w: 50, reason: 'constitutional-weight court ruling (Band A)' };
  if (RE_EXEC_ACTION.test(t) || outletOf(f) === 'White House') {
    // executive action carrying legal weight; plain WH posts slightly lower.
    return RE_EXEC_ACTION.test(t)
      ? { w: 49, reason: 'major executive action / EO (Band A)' }
      : { w: 40, reason: 'executive / White House action (Band A/B)' };
  }
  if (RE_FOREIGN_SHIFT.test(t) && (cat === 'world' || cat === 'government'))
    return { w: 47, reason: 'foreign balance-of-power shift (Band A)' };

  // BAND B (30-45)
  if (RE_MACRO_DATA.test(t)) return { w: 42, reason: 'country-wide economic data (Band B)' };
  if (RE_NATL_POLICY.test(t)) return { w: 38, reason: 'national policy launch (Band B)' };
  if (RE_NOMINATION.test(t)) return { w: 33, reason: 'senior nomination / confirmation (Band B)' };
  if (cat === 'world' || cat === 'courts') return { w: 32, reason: 'world / court item (Band B/C)' };
  if (cat === 'war') return { w: 34, reason: 'defense / conflict item (Band B)' };
  if (cat === 'government') return { w: 31, reason: 'government action (Band B/C)' };
  if (cat === 'health') return { w: 30, reason: 'public-health action (Band B)' };

  // BAND C (15-29)
  if (outletOf(f) === 'U.S. Dept. of Defense' && RE_MIL_SOFT.test(t))
    return { w: 20, reason: 'routine military / ceremonial (Band C)' };
  if (cat === 'economics') return { w: 18, reason: 'economics (non-macro, Band C)' };

  // BAND D (0-14)
  return { w: 12, reason: 'routine / uncategorized (Band D)' };
}

// ---- §4.1 actor seniority W_actor (0-15) -----------------------------------

function wActor(f: FactRecord): number {
  const o = outletOf(f);
  const t = blob(f);
  if (o === 'White House' || RE_EXEC_ACTION.test(t)) return 15; // head of state acting
  if (o === 'Federal Reserve' && RE_FOMC.test(t)) return 15; // FOMC as a body
  if (o === 'Supreme Court (CourtListener)') return RE_CONSTITUTIONAL.test(t) ? 13 : 9;
  if (/\b(secretary|agency head|treasury|department of (defense|homeland security|state|commerce)|fed chair|attorney general)\b/i.test(t))
    return 11;
  if (o === 'Federal Reserve' || o === 'Bureau of Labor Statistics' || o === 'Federal Register') return 11;
  if (o === 'UN Press') return 7;
  if (o === 'U.S. Dept. of Defense') return RE_FORCE.test(t) ? 9 : 4; // unit PAO when soft
  if (o === 'SEC EDGAR') return 0; // corporate filer
  if (o === 'U.S. Treasury') return /auction/i.test(t) ? 3 : 9;
  return 5;
}

// ---- §4.2 scale / magnitude W_scale (0-15) ---------------------------------

function wScale(f: FactRecord): number {
  const t = blob(f);
  if (RE_FORCE.test(t) || RE_FOMC.test(t) || RE_SYSTEMIC_MKT.test(t)) return 15;
  if (RE_TRADE_ACTION.test(t) && /\b(section 232|ieepa|all (imports|countries)|sector)/i.test(t)) return 15;
  if (RE_MACRO_DATA.test(t) || RE_EXEC_ACTION.test(t)) return 12;
  if (RE_NATL_POLICY.test(t) || /\b(tps|temporary protected status|nationwide|migrant|immigration)\b/i.test(t))
    return 10;
  if (f.category === 'economics' && outletOf(f) === 'SEC EDGAR') return 0; // one company
  if (/\b(single|one (company|tribe|individual)|niche|regional|single-state)\b/i.test(t)) return 5;
  return 5;
}

// ---- §4.3 corroboration W_corrob (0-8) -------------------------------------

function wCorrob(f: FactRecord): number {
  const n = f.sources.length;
  if (n >= 4) return 8;
  if (n >= 2) return 5;
  // single primary: 2 if a T1 gov tier, else 0
  return f.sources[0]?.tier?.startsWith('T1') ? 2 : 0;
}

// ---- §4.4 geopolitical-consequence W_geo (0-7) -----------------------------

function wGeo(f: FactRecord): number {
  const t = blob(f);
  if (RE_FORCE.test(t) || /\b(nuclear|alliance|sovereignty|constitution)\b/i.test(t) || RE_CONSTITUTIONAL.test(t))
    return 7;
  if (RE_TRADE_ACTION.test(t) || /\b(migration|tps|election integrity|immigration)\b/i.test(t)) return 4;
  if (/\b(congress|branch|separation of powers|executive power)\b/i.test(t)) return 2;
  return 0;
}

// ---- §4.5 recency multiplier (0.55-1.0) ------------------------------------

function isRunningStory(t: string): boolean {
  return /\b(war|tariff|national guard|insurrection|supreme court|tps|sanction|fomc|nuclear)\b/i.test(t);
}
function rRecency(f: FactRecord, now: number): number {
  const ts = new Date(f.datetime_utc).getTime();
  if (isNaN(ts)) return 0.8;
  const days = Math.max(0, (now - ts) / 86_400_000);
  let r: number;
  if (days <= 1) r = 1.0;
  else if (days <= 3) r = 0.92;
  else if (days <= 7) r = 0.8;
  else if (days <= 21) r = 0.68;
  else r = 0.55;
  // Galtung-Ruge continuity: a running big story doesn't decay below 0.80.
  if (isRunningStory(blob(f))) r = Math.max(r, 0.8);
  return r;
}

// ---- §4.6 noise caps -------------------------------------------------------

function noiseCap(f: FactRecord): { cap: number; reason: string } | null {
  const title = f.what;
  const o = outletOf(f);
  if (o === 'SEC EDGAR' || CAP_SEC_FILING.re.test(title))
    return { cap: CAP_SEC_FILING.cap, reason: 'single-issuer SEC filing (cap 8)' };
  if (/treasury auction/i.test(`${f.what} ${f.context ?? ''}`) && !RE_SYSTEMIC_MKT.test(blob(f)))
    return { cap: 8, reason: 'routine Treasury auction (cap 8)' };
  if (CAP_FR_NOTICE.re.test(title) && !RE_EXEC_ACTION.test(blob(f)))
    return { cap: CAP_FR_NOTICE.cap, reason: 'Federal Register procedural notice (cap 10)' };
  if (CAP_CEREMONIAL.re.test(title))
    return { cap: CAP_CEREMONIAL.cap, reason: 'ceremonial / commemorative (cap 12)' };
  if (CAP_ADMIN.re.test(title)) return { cap: CAP_ADMIN.cap, reason: 'single-entity admin (cap 15)' };
  return null;
}

// ---- public API ------------------------------------------------------------

export function scoreFact(f: FactRecord, now = Date.now()): ScoredFact {
  const type = wType(f);
  const raw = type.w + wActor(f) + wScale(f) + wCorrob(f) + wGeo(f);
  let score = Math.round(raw * rRecency(f, now));
  let reason = type.reason;

  // §4.6 floor: confirmed war / nuclear / nationwide-emergency with >=2 primaries never sinks.
  const t = blob(f);
  if (RE_FORCE.test(t) && /\b(war|nuclear|insurrection|invasion|strike)\b/i.test(t) && f.sources.length >= 2) {
    score = Math.max(score, 60);
  }

  // §4.6 caps override everything.
  const cap = noiseCap(f);
  if (cap) {
    score = Math.min(score, cap.cap);
    reason = cap.reason;
  }

  // voice:advocacy discount (§4.6) — frame, not fact. Down-weight but keep the event's type.
  const advocacy = hasAdvocacyVoice(`${f.what} ${f.context ?? ''}`);
  if (advocacy) score = Math.max(0, score - 8);

  score = Math.max(0, Math.min(100, score));

  // Tier: capped/noise items are BURIED; otherwise band by final score.
  let tier: ImportanceTier;
  if (cap || score < 20) tier = 'BURIED';
  else if (score >= 58) tier = 'HIGH';
  else if (score >= 38) tier = 'MED';
  else tier = 'LOW';

  return { fact: f, score, tier, reason, advocacy };
}

// ---- §5 the MMR-style diversified mixer ------------------------------------

const CONSEC_CAP = 2;
const WINDOW = 8;
const WINDOW_CAP = 3;
const SCORE_GAP_OVERRIDE = 20;

function countInWindow(out: ScoredFact[], cat: Category, window: number): number {
  let n = 0;
  for (let i = out.length - 1; i >= 0 && i >= out.length - window; i--) {
    if (out[i].fact.category === cat) n++;
  }
  return n;
}
function trailingRun(out: ScoredFact[], cat: Category): number {
  let n = 0;
  for (let i = out.length - 1; i >= 0 && out[i].fact.category === cat; i--) n++;
  return n;
}

// Greedy diversified rerank: keep importance order but refuse to let one category own the
// top — unless a genuinely huge second item (>20-pt gap) earns its place.
export function mix(scored: ScoredFact[]): ScoredFact[] {
  const remaining = scored.slice().sort((a, b) => b.score - a.score);
  const out: ScoredFact[] = [];

  while (remaining.length) {
    let chosen = -1;
    for (let i = 0; i < remaining.length; i++) {
      const cat = remaining[i].fact.category;
      const consecOk = trailingRun(out, cat) < CONSEC_CAP;
      const windowOk = countInWindow(out, cat, WINDOW) < WINDOW_CAP;
      if (consecOk && windowOk) {
        chosen = i;
        break;
      }
    }
    if (chosen === -1) {
      // Every remaining top item is constrained. Score-gap override: if the best item
      // outscores the best *allowed* alternative by >20, take it anyway; else just take the
      // best remaining (constraints can't be satisfied — exhaust the busy category).
      chosen = 0;
    } else {
      // Score-gap override: a blocked item that vastly outscores the chosen one wins.
      const blocked = remaining[0];
      if (chosen !== 0 && blocked.score - remaining[chosen].score > SCORE_GAP_OVERRIDE) {
        chosen = 0;
      }
    }
    out.push(remaining.splice(chosen, 1)[0]);
  }

  return enforceSpreadFloor(out);
}

// §5.4 spread floor: the top-8 should touch >=4 distinct categories when >=4 categories have
// an item scoring >=35. If not, pull the best item from an unrepresented category into the
// top-8 at a modest cost.
function enforceSpreadFloor(out: ScoredFact[]): ScoredFact[] {
  if (out.length <= WINDOW) return out;
  const top = out.slice(0, WINDOW);
  const topCats = new Set(top.map((s) => s.fact.category));
  if (topCats.size >= 4) return out;

  const eligibleCats = new Set(out.filter((s) => s.score >= 35).map((s) => s.fact.category));
  if (eligibleCats.size < 4) return out;

  const need = 4 - topCats.size;
  let pulled = 0;
  for (let i = WINDOW; i < out.length && pulled < need; i++) {
    if (!topCats.has(out[i].fact.category) && out[i].score >= 35) {
      const [item] = out.splice(i, 1);
      out.splice(WINDOW - 1, 0, item); // place at the bottom of the top window
      topCats.add(item.fact.category);
      pulled++;
    }
  }
  return out;
}

// ---- feed builders ---------------------------------------------------------

// The default HOME feed: mixed, importance-ranked top stories across ALL categories, with
// micro-noise buried and the top diversified so nothing dominates. No category sections.
export function rankForHome(facts: FactRecord[], now = Date.now()): FactRecord[] {
  const scored = facts.map((f) => scoreFact(f, now)).filter((s) => s.tier !== 'BURIED');
  return mix(scored).map((s) => s.fact);
}

// The WEEK review: same machinery (the mission says week == same mixed-importance philosophy).
export function rankForWeek(facts: FactRecord[], now = Date.now()): FactRecord[] {
  return rankForHome(facts, now);
}

// The economics FILTER view (opt-in): surfaces economics items the home buries, including
// the 8-K / auction micro-noise, in recency order. "Reachable via the explicit economics
// filter" path from the mission doc.
export function filterByCategory(facts: FactRecord[], category: Category): FactRecord[] {
  return facts
    .filter((f) => f.category === category)
    .slice()
    .sort((a, b) => (a.datetime_utc < b.datetime_utc ? 1 : -1));
}
