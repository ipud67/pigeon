// lib/ranking/importance.ts
//
// THE importance ranking engine (spec §A), encoding Research's News-Relevance Rubric v1
// (the relevance-rubric brief) rather than the rough SPEC heuristic. The
// core fix for round 1's failure: the home "All" feed was a raw arrival-order dump, so the
// first ~15 headlines were ALL economics / SEC-8-K micro-filings. That is not a 5-minute
// big picture.
//
// Score model (Research §4), 0-100, NO LLM:
// importance_raw = W_type(0-55) + W_actor(0-15) + W_scale(0-15) + W_corrob(0-8) + W_geo(0-7)
// importance = round(importance_raw * R_recency) // §4.5 multiplicative 0.55-1.0
// then NOISE CAPS / FLOORS (§4.6) override; then voice:advocacy discount; clamp [0,100].
//
// Mixer (Research §5): greedy MMR-style rerank — consecutive-category cap 2, top-8 window max 3
// per category, ≥4-category spread floor, >20-point score-gap override.
//
// Pure functions, no node deps — safe to import in a client island. Grounding: Galtung &
// Ruge (1965) / Harcup & O'Neill (2001) news-values, AP/Reuters budget-meeting triage,
// McCombs & Shaw (1972) agenda-setting. The mission governs: "does this help a 5-minute
// reader understand what actually mattered?" If no, it does not belong on the home page.

import type { FactRecord, Category } from '../types';
import { hasAdvocacyVoice } from '../editorial/neutralize';

// LEAD was missing from this union entirely until 2026-07-22. Months of desk-session training
// ran on LEAD as a first-class tier — what earns the lead slot, how long a lead holds, the
// per-reader lead — and the engine had no way to express it. The front page printed forty
// headlines at identical weight because nothing ever said which one was the lead.
//
// LEAD is defined per the ruling that tier is CONTEXT-RELATIVE: the lead is the top of the
// window's competing field, not an absolute severity line. On a quiet day a mid-caliber story
// leads. There is always exactly one lead in a non-empty feed.
export type ImportanceTier = 'LEAD' | 'HIGH' | 'MED' | 'LOW' | 'BURIED';

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

// ACTUAL ordnance on actual targets. Split out from RE_FORCE deliberately.
//
// The 2026-07-20 failure that started all of this: "Centcom Completes Another Wave of Strikes
// Against Iran" scored 31 — dead last — because RE_FORCE only knew 'airstrike', 'missile
// strike' and 'launch a strike'. A bare "strikes against Iran" matched NOTHING, so an active
// US bombing campaign fell to the generic Band-B war floor. Meanwhile "national guard" in
// RE_FORCE handed a Croatia anniversary party the full Band-A treatment at 83.
//
// Guarded against the labour-strike sense by requiring a target preposition or a military
// qualifier — "strikes against", "strikes on", "offensive strikes", never a bare "strike".
const RE_COMBAT =
 /\b(strikes? (against|on|at|targeting)|struck (targets?|sites?|positions?)|offensive strikes?|wave of strikes?|air ?strikes?|missile strikes?|precision munitions|central command|centcom|bombard\w*|shelling|drone attack|killed in (a|the) strike|casualt\w+|opened fire|shot down)\b/i;

// Combat CONTEMPLATED is not combat CONDUCTED. Caught on the live feed, not by the oracle:
// "Trump mulling military strikes on Mali militant group: Report" matched RE_COMBAT on
// "strikes on" and landed at #10 in the home feed — a second-hand report of something not yet
// done, ranked as an active bombing campaign. The oracle had no pair for this because the
// fixtures contained no such headline. Also catches the trailing ": Report" attribution,
// which marks the item as somebody else's sourcing rather than an event we have.
const RE_CONTEMPLATED =
 /\b(mulling|considering|weighing|contemplat\w+|may launch|could launch|plans? to (strike|attack|launch)|prepar\w+ to (strike|attack)|threaten\w* to|reportedly (considering|weighing|planning)|is expected to strike)\b|:\s*report\s*$/i;

function isActiveCombat(f: FactRecord): boolean {
 const t = blob(f);
 if (RE_CONTEMPLATED.test(t) || RE_CONTEMPLATED.test(f.what ?? '')) return false;
 return RE_COMBAT.test(t);
}

// Advocacy / argument-shaped releases. Distinct from the slogan list in
// editorial/neutralize.ts, which keys on vocabulary ("america first", "witch hunt"); this
// keys on STRUCTURE. "Democrat 'Glitch' Registers Thousands of Noncitizens to Vote: Another
// Reason to Pass the SAVE Act" carries no banned slogan, cleared the discount, and scored 59
// HIGH on the live feed — an argument for a bill, on the front page of a facts-only product.
// The tell is a claim with a conclusion welded on after a colon.
const RE_ADVOCACY_SHAPE =
 /(:\s*(another reason|here'?s why|why (we|america|congress)|what they|the truth about|it'?s time)|^\s*(icymi\b|myth vs\.? fact|setting the record straight|by the numbers:|the facts:))/i;
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
// Prices a reader pays directly. Kept separate from RE_MACRO_DATA: a CPI print is a
// statistic, the price at the pump is an experience.
const RE_CONSUMER_PRICE =
 /\b(gas(oline)? prices?|price at the pump|pump prices?|grocery prices?|food prices?|electricity (bill|rates?|prices?)|utility bills?|mortgage rates?|rent(al)? prices?|heating (oil|costs?)|airfares?|cost of living)\b/i;
const RE_NOMINATION =
 /\b(nominat\w+ (to|for)|confirmation|to serve as (director|secretary|chair|governor|justice|judge))\b/i;

// DoD soft / ceremonial output — real, but low-importance for a 5-min reader.
//
// Timn's ruling on oracle pair P001 (2026-07-21), verbatim: "an active shooting war outranks
// ALL military ceremony, training, exercises, rehearsals, logistics, and human-interest rescue
// items. No exceptions." This list is that ruling, expanded against the actual DoD feed copy
// in training/oracle/fixtures.json rather than against imagined headlines.
const RE_MIL_SOFT =
 /\b(readiness|disaster relief|humanitarian (relief|assistance|aid)|families|missing (service members|in action)|remembr\w*|ceremon\w*|memorial|honor\w*|tribute|recruit\w*|graduat\w*|\bsports?\b|athlete|military children|spotlight|profile|hall of fame|wreath|medal|unit renam\w*|exercises?|rehears\w*|simulation|drills?|interoperab\w*|sharpen\w*|readiness and training|partnership|state partnership program|celebrat\w*|anniversar\w*|rescue[sd]?|search and rescue|wildland|wildfire|firefight\w*|tricare|pharmacy|prescription|health benefits?|student naval aviators?|congratulat\w*|commission(s|ed)? (its|the) first|maritime security vessel|air show|open house)\b/i;

// Real combat context that OVERRIDES a soft-military match — a rescue during a bombing
// campaign is not a human-interest item. Kept narrow on purpose: "Exercise Combat Power 26"
// must NOT read as combat, so bare "combat" is excluded and only "combat operations" counts.
const RE_HARD_OVERRIDE =
 /\b(strikes? (against|on|at|targeting)|offensive operations?|combat operations?|invasion|incursion|declares? war|act of war|killed in action|under fire)\b/i;

function isSoftMilitary(f: FactRecord): boolean {
 const t = blob(f);
 if (RE_HARD_OVERRIDE.test(t)) return false;
 return RE_MIL_SOFT.test(t);
}

// ---- §4.6 noise caps (title/outlet regex; applied LAST, override everything) ------------
const CAP_SEC_FILING = { re: /(^|\b)(\d?\d?-?[KQ]\b|\(filer\)|form (8-?k|10-?[qk]|s-1))/i, cap: 8 };
const CAP_FR_NOTICE = {
 re: /\b(information collection|paperwork reduction|omb review|privacy act of 1974|sunshine act|system of records|comment request|submission for omb)\b/i,
 cap: 10,
};
// PROCLAMATIONS. Timn ruled these bottom-of-feed but VISIBLE, not cut (pairs P002/P003/
// P016/P017/P019/P020, PROVISIONAL — see training/oracle/OPEN_QUESTIONS.md §1, they are not
// all equal and this needs its own drill). Hence `bury: false`: the score is pushed to the
// floor but the tier stays LOW so the item survives rankForHome's BURIED filter.
//
// The old pattern required the word "national" ("national [a-z ]+ week, YYYY"), so it caught
// nothing: "Captive Nations Week, 2026" and "Made in America Week, 2026" both sailed through
// at 78 and outranked an active war. Now any "<Anything> Week/Month/Day, YYYY" title reads as
// a proclamation, plus the proclamation body boilerplate itself.
const CAP_CEREMONIAL = {
 re: /(\b[a-z' ]+ (week|month|day),? \d{4}\s*$|\b(presidential message|anniversary|flag (day|week)|father'?s day|mother'?s day|memorial day|veterans day|independence day)\b)/i,
 cap: 24,
 bury: false,
};
// A proclamation that DOES something is not ceremonial. Section 232 duties are issued as
// proclamations; so are half-staff orders on a Senator's death. Matching the proclamation
// BODY boilerplate ("BY THE PRESIDENT... A PROCLAMATION") broke both anchors P032 and P038 on
// the first attempt — it capped a Canadian tariff action and a Senator's death at 24. The
// anchors caught it. Ceremonial status is read from the TITLE SHAPE only, and any title
// carrying a substantive action verb is exempt outright.
const RE_SUBSTANTIVE_ACTION =
 /\b(imposing|impose|securing|modifying|revoking|establishing|declaring|adjusting|suspending|terminating|authorizing|prohibiting|restricting|death of|blocking|expanding|reducing) /i;
const CAP_ADMIN = {
 re: /\b(hearth act|leasing ordinance|uniform allowance|notice of filing of complaint|cost-of-living adjustment|grant competition|funding competition|lawtech|annual report & accounts)\b/i,
 cap: 15,
};
// Routine agency rulemaking — a drawbridge schedule, a fishery closure. Real, published,
// and of no consequence to a five-minute reader. Distinct from CAP_FR_NOTICE, which catches
// procedural paperwork rather than minor substantive rules.
const CAP_ROUTINE_RULE = {
 re: /\b(drawbridge|migratory species|fisher(y|ies)|closure of the [a-z ]+ (category|fishery)|safety zone|restricted area|anchorage ground|special local regulation|airworthiness directive)\b/i,
 cap: 15,
};
// Digests, readouts, briefings, promotional releases. Timn ruled these are NOT events
// (pairs P011/P014/P024/P030/P031/P042, group event-vs-digest/readout/briefing/promotion).
// A table of contents is not a story; a record that a phone call happened is not the call.
const CAP_NOT_AN_EVENT = {
 re: /(^daily news\b|^daily press briefing\b|^what they are saying\b|^readout of\b|\bdaily news \d{1,2} ?\/ ?\d{1,2} ?\/ ?\d{4}|^pm call with\b|^call with\b|^statement on the call\b|\bpress gaggle\b|^week ahead\b)/i,
 cap: 18,
};

// ---- helpers ---------------------------------------------------------------

function blob(f: FactRecord): string {
 return `${f.what} ${f.deck ?? ''} ${f.context ?? ''}`.toLowerCase();
}
function outletOf(f: FactRecord): string {
 return f.sources[0]?.outlet ?? '';
}

// ---- court significance: is a government the party? ------------------------
//
// Timn ratified that court items rank by constitutional weight, not by being on the docket
// (pairs P027/P028/P029). The engine scored every SCOTUS entry identically at 38, so
// `Trump v. Slaughter` (can a President fire an independent agency commissioner?) and
// `Dershowitz v. Cable News Network` (a defamation suit) were the same number to it.
//
// A regex cannot read a case — but it can read the CAPTION. A case with a government as a
// party is public law: it decides what the state may do. Private-v-private is not. That is a
// real doctrinal line, not a hardcode of these three fixtures, and it separates
// Trump v. Slaughter and West Virginia v. B.P.J. from Dershowitz v. CNN and Smith v. Kind.
//
// LIMIT, stated honestly: this reads WHO is arguing, not WHAT is at stake. A landmark
// private-party case ranks low and a trivial suit against a city ranks high. Closing that gap
// needs a real classifier — the one ratified judgment that cannot be reached by rules
// (OPEN_QUESTIONS.md §4). Matched against the case NAME only: every SCOTUS slip opinion body
// contains "SUPREME COURT OF THE UNITED STATES", which would make every case look federal.
const US_STATES =
 /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const GOV_PARTY =
 /\b(united states|trump|biden|harris|secretary (of|general)|attorney general|commissioner|administrator|department of|city of|county of|board of education|environmental protection agency|internal revenue service|securities and exchange commission|federal trade commission|national labor relations board|\bfcc\b|\bfda\b|\bepa\b|\birs\b|\bsec\b|\bnlrb\b)\b/i;

function hasGovernmentParty(f: FactRecord): boolean {
 const caption = f.what ?? '';
 if (!/ v\.? /i.test(caption)) return false; // not a case caption
 return GOV_PARTY.test(caption) || US_STATES.test(caption);
}

// ---- §2 event-type band -> W_type (0-55) -----------------------------------

function wType(f: FactRecord): { w: number; reason: string } {
 const t = blob(f);
 const cat = f.category;

 // BAND A (46-55)
 // Ordnance on targets ranks at the top of Band A regardless of the record's category —
 // a strike report filed under 'other' is still a war story.
 if (isActiveCombat(f)) return { w: 55, reason: 'active combat operations (Band A)' };
 if (cat === 'courts' && hasGovernmentParty(f))
 return { w: 48, reason: 'court case against a government party — public-law weight (Band A)' };
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
 // What the reader actually pays. The mission's roofer persona is the hard test gate —
 // "what it means for your wallet" — and R116 says an economic figure takes the denominator
 // matching the reader's stake. A national gas-price move is a bigger story for a five-minute
 // reader than most macro releases, and it was scoring 52 as a mis-filed war item.
 if (RE_CONSUMER_PRICE.test(t)) return { w: 44, reason: 'consumer prices — direct reader impact (Band B)' };
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

// Magnitude of a stated consequence. Timn ratified PROVISIONALLY that size lifts rank
// (pairs P025/P026), in his words: "for now, we say size matters. However, put a note on this
// and expect that as we test this may change, because context really matters." Deliberately a
// modest +8, not a multiplier — money is a proxy for consequence, not consequence itself, and
// the failure mode he named is a big number winning on the number alone.
const RE_BIG_MONEY =
 /(€|\$|£)\s?\d[\d,.]*\s?(billion|bn|million|m\b|trillion)|\b\d[\d,.]*\s?(billion|trillion)\b/i;
function magnitudeLift(f: FactRecord): number {
 return RE_BIG_MONEY.test(blob(f)) ? 8 : 0;
}

function wScale(f: FactRecord): number {
 const t = blob(f);
 if (isActiveCombat(f)) return 15;
 if (RE_FORCE.test(t) || RE_FOMC.test(t) || RE_SYSTEMIC_MKT.test(t)) return 15;
 if (RE_TRADE_ACTION.test(t) && /\b(section 232|ieepa|all (imports|countries)|sector)/i.test(t)) return 15;
 if (RE_CONSUMER_PRICE.test(t)) return 13; // every household, every week
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
// Timn ruled a HARD staleness cutoff at roughly two weeks (pairs P012/P013/P021/P022).
// The bug it fixes: `isRunningStory` matched 'fomc', so a Federal Reserve statement from the
// June meeting held its 0.80 continuity floor for 33 days and kept scoring 72 — above a trade
// action from yesterday. Continuity is meant to keep a LIVE story alive, not to embalm a
// month-old one. Past the cutoff the floor no longer applies and decay steepens.
const STALE_DAYS = 14;

function rRecency(f: FactRecord, now: number): number {
 const ts = new Date(f.datetime_utc).getTime();
 if (isNaN(ts)) return 0.8;
 const days = Math.max(0, (now - ts) / 86_400_000);
 let r: number;
 if (days <= 1) r = 1.0;
 else if (days <= 3) r = 0.92;
 else if (days <= 7) r = 0.8;
 else if (days <= STALE_DAYS) r = 0.68;
 else if (days <= 30) r = 0.45;
 else r = 0.35;
 // Galtung-Ruge continuity: a running big story doesn't decay below 0.80 — but only while
 // it is actually running. Past the staleness cutoff the floor is withdrawn.
 if (days <= STALE_DAYS && isRunningStory(blob(f))) r = Math.max(r, 0.8);
 return r;
}

// ---- §4.6 noise caps -------------------------------------------------------

type Cap = { cap: number; reason: string; bury: boolean };

function noiseCap(f: FactRecord): Cap | null {
 const title = f.what;
 const o = outletOf(f);
 if (o === 'SEC EDGAR' || CAP_SEC_FILING.re.test(title))
 return { cap: CAP_SEC_FILING.cap, reason: 'single-issuer SEC filing (cap 8)', bury: true };
 if (/treasury auction/i.test(`${f.what} ${f.context ?? ''}`) && !RE_SYSTEMIC_MKT.test(blob(f)))
 return { cap: 8, reason: 'routine Treasury auction (cap 8)', bury: true };
 if (CAP_FR_NOTICE.re.test(title) && !RE_EXEC_ACTION.test(blob(f)))
 return { cap: CAP_FR_NOTICE.cap, reason: 'Federal Register procedural notice (cap 10)', bury: true };
 if (RE_ADVOCACY_SHAPE.test(title))
 return { cap: 20, reason: 'advocacy-shaped release — a claim with an argument welded on (cap 20)', bury: true };
 if (CAP_NOT_AN_EVENT.re.test(title.trim()))
 return { cap: CAP_NOT_AN_EVENT.cap, reason: 'digest / readout / briefing / promotion — not an event (cap 18)', bury: true };
 if (CAP_CEREMONIAL.re.test(title) && !RE_SUBSTANTIVE_ACTION.test(title))
 return {
 cap: CAP_CEREMONIAL.cap,
 reason: 'proclamation / commemorative — bottom of feed, still visible (cap 24)',
 bury: CAP_CEREMONIAL.bury,
 };
 if (CAP_ROUTINE_RULE.re.test(title))
 return { cap: CAP_ROUTINE_RULE.cap, reason: 'routine agency rulemaking (cap 15)', bury: true };
 if (CAP_ADMIN.re.test(title)) return { cap: CAP_ADMIN.cap, reason: 'single-entity admin (cap 15)', bury: true };
 // Soft military — ceremony, exercises, rehearsals, logistics, human-interest rescue.
 // Capped BELOW the war floor so Timn's "no exceptions" ruling holds by construction.
 if (isSoftMilitary(f))
 return { cap: 34, reason: 'military ceremony / training / logistics / human-interest (cap 34)', bury: false };
 return null;
}

// ---- public API ------------------------------------------------------------

export function scoreFact(f: FactRecord, now = Date.now()): ScoredFact {
 const type = wType(f);
 const raw = type.w + wActor(f) + wScale(f) + wCorrob(f) + wGeo(f) + magnitudeLift(f);
 let score = Math.round(raw * rRecency(f, now));
 let reason = type.reason;

 // §4.6 floor: confirmed war / nuclear / nationwide-emergency never sinks.
 // The >=2-primaries requirement was dropped for ACTIVE COMBAT: US strikes on Iran reach us
 // through a single CENTCOM release, and requiring corroboration meant the one channel the
 // war actually arrives on could never clear the floor. Corroboration still earns W_corrob;
 // it no longer gates the floor for ordnance-on-target reporting.
 const t = blob(f);
 if (isActiveCombat(f)) {
 score = Math.max(score, 60);
 } else if (RE_FORCE.test(t) && /\b(war|nuclear|insurrection|invasion|strike)\b/i.test(t) && f.sources.length >= 2) {
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

 // Tier: capped noise is BURIED — EXCEPT caps flagged bury:false, which Timn ruled must stay
 // visible at the bottom of the feed rather than drop off it (proclamations; soft-military).
 let tier: ImportanceTier;
 if ((cap && cap.bury) || score < 20) tier = 'BURIED';
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

// ---- near-duplicate suppression -------------------------------------------
//
// The clustering layer (lib/ingestion/dedup.ts) merges items that share a URL or a very close
// title. It does NOT merge the same government action announced four different ways, because
// the wording differs completely:
//
// "Imposing Additional Duties to Offset Canadian Discrimination Against the Commerce..."
// "Fact Sheet: President Donald J. Trump Takes Further Action To Adjust Imports Of Aluminum"
// "Further Strengthening Actions Taken to Adjust Imports of Aluminum into the United States"
// "Fact Sheet: President Donald J. Trump Imposes Additional Tariffs on Canada"
//
// On the 2026-07-22 live feed that single tariff action held SIX of the top seventeen slots.
// For a product whose whole promise is five minutes, spending a third of the front page on
// one story restated is the most expensive kind of noise.
//
// This does not merge records — merging is the clustering layer's job and doing it here would
// hide sources. It DEFERS a near-duplicate out of the top window so the front page covers more
// ground. The item still appears further down, intact.
const STOPWORDS = new Set([
 'the','and','for','with','that','this','from','into','over','under','after','before','about',
 'president','fact','sheet','donald','trump','takes','take','taken','united','states','america',
 'american','new','his','her','its','their','been','have','has','was','were','will','would',
]);
function significantTokens(title: string): Set<string> {
 const out = new Set<string>();
 for (const raw of title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
 if (raw.length < 4 || STOPWORDS.has(raw)) continue;
 // light stemming so canada/canadian and imposing/imposes collapse together
 const stem = raw
 .replace(/(ian|ians|ing|ions|ion|ies|es|s)$/, '')
 .replace(/(a|e)$/, '');
 if (stem.length >= 3) out.add(stem);
 }
 return out;
}
const DUP_SHARED_TOKENS = 3; // >= this many shared significant stems reads as the same story
const DUP_WINDOW = 12; // only enforced across the front page, not the whole feed

function isNearDuplicate(candidate: ScoredFact, placed: ScoredFact[]): boolean {
 const a = significantTokens(candidate.fact.what ?? '');
 if (a.size < DUP_SHARED_TOKENS) return false;
 for (const p of placed.slice(0, DUP_WINDOW)) {
 const b = significantTokens(p.fact.what ?? '');
 let shared = 0;
 for (const tok of a) if (b.has(tok)) shared++;
 if (shared >= DUP_SHARED_TOKENS) return true;
 }
 return false;
}

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
 // Pass 1: satisfy category spread AND avoid restating a story already on the front page.
 for (let i = 0; i < remaining.length; i++) {
 const cat = remaining[i].fact.category;
 const consecOk = trailingRun(out, cat) < CONSEC_CAP;
 const windowOk = countInWindow(out, cat, WINDOW) < WINDOW_CAP;
 if (consecOk && windowOk && !(out.length < DUP_WINDOW && isNearDuplicate(remaining[i], out))) {
 chosen = i;
 break;
 }
 }
 // Pass 2: if duplicate-avoidance alone left nothing, relax it rather than stall.
 if (chosen === -1) {
 for (let i = 0; i < remaining.length; i++) {
 const cat = remaining[i].fact.category;
 if (trailingRun(out, cat) < CONSEC_CAP && countInWindow(out, cat, WINDOW) < WINDOW_CAP) {
 chosen = i;
 break;
 }
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

// ---- the front page -------------------------------------------------------
//
// The newspaper structure the desktop front page renders: one LEAD, a short ranked RUNDOWN
// rail beside it, and the rest of the feed beneath. This is the shape approved as Option A
// ("The Front Page") — lead story left, ranked rail right, section nav in the flag.
//
// Deliberately a ranking-layer function, not a UI slice: which story leads is an editorial
// judgment and belongs next to the rules that produced the ordering, where the scoreboard can
// eventually check it. The UI asks for a front page; it does not decide what leads.
export type FrontPage = {
 lead: FactRecord | null;
 rundown: FactRecord[]; // the ranked rail beside the lead
 rest: FactRecord[]; // everything below the fold, in ranked order
};

export const RUNDOWN_SIZE = 5;

export function selectFrontPage(
 facts: FactRecord[],
 now = Date.now(),
 rundownSize = RUNDOWN_SIZE,
): FrontPage {
 const ordered = rankForHome(facts, now);
 if (ordered.length === 0) return { lead: null, rundown: [], rest: [] };
 return {
 lead: ordered[0],
 rundown: ordered.slice(1, 1 + rundownSize),
 rest: ordered.slice(1 + rundownSize),
 };
}

// Tier as the front page assigns it: the top of the ranked field is the LEAD, everything else
// keeps the band its score earned. Exposed so the reader UI and any future scoreboard pair
// agree on one definition rather than each inventing its own.
export function tierForFrontPage(f: FactRecord, index: number, now = Date.now()): ImportanceTier {
 return index === 0 ? 'LEAD' : scoreFact(f, now).tier;
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
