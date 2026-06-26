// lib/weighit/generate.ts
//
// Rule-based WEIGH-IT generation — Clark §1b, implemented as deterministic code. NO LLM.
//
// Mechanism:
//   1. build a MatchContext from the FACT (what) + CONTEXT + outlet + category
//   2. run each tenet's RELEVANCE GATE — a tenet fires only when the event's ACTOR and
//      ACTION genuinely implicate that tenet's domain (and, for the US-constitutional
//      tenets, only when there is a real US nexus). A lone incidental keyword does NOT
//      fire a tenet. This is the fix for the over-firing bug: a routine UN staffing
//      notice no longer triggers a separation-of-powers / war-powers prompt.
//   3. emit ONLY the matched template question lines (2-4, capped), closing with the
//      historical-contrast question when >=1 tenet fired
//   4. ZERO is a valid, correct result. Most routine / administrative / foreign-
//      bureaucratic items map to no tenet -> weigh_it stays empty. Showing nothing is
//      honest; a forced irrelevant prompt is an editorial failure.
//   5. never write a conclusion — output is always interrogative

import type { WeighItQuestion, Category } from '../types';
import { TENETS, HISTORICAL_CONTRAST, type Tenet } from './tenets';

// Categories eligible for a value-lens prompt at all (cheap pre-filter; the relevance
// gate below is the real bar). Pure-economic data releases and health declarations
// usually map to no civic tenet.
const LENS_ELIGIBLE: Category[] = ['war', 'government', 'courts', 'world'];

const MAX_TENET_QUESTIONS = 3; // before the always-on historical-contrast closer

// US-government primary outlets — strong, provenance-level US nexus signal.
const US_GOV_OUTLETS = new Set([
  'Federal Register',
  'White House',
  'Federal Reserve',
  'U.S. Treasury',
  'SEC EDGAR',
  'Bureau of Labor Statistics',
  'U.S. Dept. of Defense',
  'Supreme Court (CourtListener)',
]);

type Actor = 'court' | 'executive' | 'congress' | 'federal-agency' | 'foreign-body' | 'unknown';

type MatchContext = {
  text: string; // lowercased fact + context
  category: Category;
  outlet: string;
  usNexus: boolean; // a US federal actor / US-gov outlet / explicit US reference is present
  usMilitaryNexus: boolean; // American armed-force / foreign-policy posture is implicated
  actor: Actor;
};

// ---- nexus + actor detection ----------------------------------------------

// An explicit US FEDERAL actor named in the text.
const RE_US_ACTOR =
  /\b(president|white house|the administration|executive order|presidential action|congress|the senate|house of representatives|supreme court|federal court|district court|court of appeals|federal reserve|u\.?s\.? treasury|treasury department|pentagon|department of defense|defense department|state department|department of (commerce|state|justice|homeland security|labor|education|energy|health|agriculture|transportation|the interior|veterans)|\bepa\b|\bfda\b|\bfcc\b|\bsec\b|\bdoj\b|\bfbi\b|\bfaa\b|federal agency|federal register|federal government|u\.?s\.? government)\b/;

// An explicit reference that the United States is the subject.
const RE_US_REF = /\b(united states|u\.s\.|u\.s\.a|\bus\b(?= (government|military|forces|troops|economy|policy))|american|americans|washington)\b/;

function detectUSNexus(text: string, outlet: string): boolean {
  if (US_GOV_OUTLETS.has(outlet)) return true;
  return RE_US_ACTOR.test(text) || RE_US_REF.test(text);
}

// American armed-force / foreign-policy posture. Requires a US military actor AND a
// force/entanglement action — a purely foreign conflict with no US involvement is NOT
// a foreign-restraint item under this tenet ("move AMERICAN foreign policy...").
const RE_US_MIL_ACTOR =
  /\b(pentagon|department of defense|defense department|war department|u\.?s\.? (military|troops|forces|navy|naval|air ?force|marines|army|central command|centcom|southern command|fleet|carrier|warship))\b/;
const RE_US_MIL_LOOSE =
  /\b(united states|u\.s\.|american|americans?|washington|president|nato)\b/;
// A genuine foreign-FORCE-posture action — not the DoD's routine human-interest output.
const RE_FORCE_ACTION =
  /\b(deploys?|deployment|airstrikes?|air strike|missile strike|launch\w* (a |an )?(strike|offensive|attack)|invasion|incursion|offensive operations?|combat operations?|sanctions?\b|imposes? sanctions|treaty|mutual defense|defense pact|alliance|military aid|arms (deal|sale|shipment|transfer)|boots on the ground|no-fly zone|declares? war|act of war|escalat\w* (the )?(war|conflict)|peace (deal|agreement|talks)|withdraw\w* (troops|forces))\b/;
// DoD publishes heavy soft/ceremonial/domestic content (readiness, relief, remembrance,
// family events). Those do NOT implicate American foreign-force posture — veto them.
const RE_MIL_SOFT_OR_DOMESTIC =
  /\b(readiness|disaster relief|earthquake relief|humanitarian (relief|assistance|aid)|relief operations?|domestic mission\w*|families|missing (service members|in action)|remembr\w*|ceremon\w*|memorial|honor\w*|gather\w*|tribute|recruit\w*|graduat\w*|\bsports?\b|athlete|military children|spotlight|profile|hall of fame|wreath)\b/;

function detectUSMilitaryNexus(text: string, outlet: string): boolean {
  if (RE_MIL_SOFT_OR_DOMESTIC.test(text)) return false; // soft/domestic/ceremonial veto
  if (!RE_FORCE_ACTION.test(text)) return false;
  if (outlet === 'U.S. Dept. of Defense') return true;
  if (RE_US_MIL_ACTOR.test(text)) return true;
  return RE_US_MIL_LOOSE.test(text); // US named AND a real force action in the same item
}

function detectActor(text: string): Actor {
  if (/(supreme court|justices?|court held|the court|federal court|district court|court of appeals)/.test(text))
    return 'court';
  if (/(executive order|the president|white house|presidential action|the administration)/.test(text))
    return 'executive';
  if (/(\bcongress\b|the senate|house of representatives|lawmakers|committee)/.test(text)) return 'congress';
  if (/(pentagon|department of defense|defense department|federal reserve|u\.?s\.? treasury|federal agency|department of |\bsec\b|\bepa\b|\bfda\b|\bfcc\b)/.test(text))
    return 'federal-agency';
  if (/(united nations|secretary-general|security council|general assembly|foreign minister|prime minister|parliament|european union)/.test(text))
    return 'foreign-body';
  return 'unknown';
}

// The actor phrase used inside the firing tenet questions ({actor}).
function actorPhrase(actor: Actor): string {
  switch (actor) {
    case 'court':
      return 'the court';
    case 'executive':
      return 'the executive';
    case 'congress':
      return 'Congress';
    case 'federal-agency':
      return 'the federal agency';
    default:
      return 'the federal actor';
  }
}

// A clean actor/action reference for the historical-contrast closer ({eventRef}).
// Never the raw headline.
function actorGist(actor: Actor): string {
  switch (actor) {
    case 'court':
      return 'this ruling';
    case 'executive':
      return 'this executive action';
    case 'congress':
      return 'this act of Congress';
    case 'federal-agency':
      return 'this federal action';
    default:
      return 'this action';
  }
}

// ---- per-tenet relevance gates ---------------------------------------------
// Each returns true ONLY when the event's actor + action implicate the tenet's domain.
// US-constitutional tenets require ctx.usNexus so foreign/IGO items don't fire them.

const RELEVANCE: Record<string, (ctx: MatchContext) => boolean> = {
  // Enumerated & limited federal power — fires on a genuine PRESIDENTIAL action (an
  // executive order / proclamation / memorandum) or a substantive imposition (a new
  // mandate, ban, prohibition, or directed requirement). Routine agency rulemaking and
  // Federal Register paperwork notices (information-collection requests, uniform-allowance
  // tweaks, brake-standard updates) are NOT a "beyond enumerated power" question for a
  // 5-minute reader — they don't fire. "executive order" as a citation ("consistent with
  // Executive Order 14XXX") deliberately does NOT count; only a real presidential action.
  'power-scope': (ctx) =>
    ctx.usNexus &&
    (/\b(hereby ordered|by the authority vested in me|presidential memorandum|presidential proclamation|national security memorandum|i hereby (order|direct|proclaim)|the president (signed|issued|ordered|directed)|signed (an )?executive order)\b/.test(
      ctx.text,
    ) ||
      /\b(imposes?|imposing|prohibits?|\bbans?\b|mandates?\b|requires? (all|every|that all)|directs? (the secretary|all agencies|the department|federal agencies)|establishes? a new (agency|program|federal requirement)|expands? (its|federal) (authority|power|reach))\b/.test(
        ctx.text,
      )),

  // Federalism — genuine federal-vs-state centralization, not a lone "state" token.
  federalism: (ctx) =>
    ctx.usNexus &&
    /\b(preempt|preemption|tenth amendment|10th amendment|states['’]? rights|commandeer|unfunded mandate|override(s|d|ing)? state|supersed\w+ state|block grant|federal funding (to|for|of) states|left to the states|reserved to the states)\b/.test(
      ctx.text,
    ),

  // Separation of powers — a US branch acting on / absorbing another branch's power.
  // War powers, vetoes, impeachment, subpoenas, confirmation fights, courts blocking the
  // executive. NOT a bare "appoints" (the over-firing bug) — only Senate-confirmation /
  // recess-appointment friction counts here.
  // NB: a bare executive order does NOT fire this — an EO is a power-scope question, not
  // inherently inter-branch. This fires only on genuine branch-vs-branch friction.
  'separation-of-powers': (ctx) =>
    ctx.usNexus &&
    /\b(veto|override the veto|war powers|declare war|authoriz(e|ation|es) (for |of )?(the )?use of (military )?force|\baumf\b|impeach\w*|subpoena|contempt of congress|executive privilege|recess appointment|senate (confirm\w*|reject\w*|block\w*)|nominat\w+ (to|for) .*(senate|confirmation)|strikes? down|struck down|blocks? the (president|administration|executive)|enjoin\w*|injunction against the|usurp\w*|checks and balances|oversteps? its (authority|power)|defies? (congress|the court)|constitutional crisis)\b/.test(
      ctx.text,
    ),

  // Natural rights & consent — a US government action securing/eroding an unalienable
  // right: speech, search/seizure, detention, due process, the franchise, arms.
  'natural-rights': (ctx) =>
    ctx.usNexus &&
    /\b(arrests?|detain\w*|detention|search and seizure|warrantless|surveillance|wiretap|censor\w*|first amendment|free speech|prior restraint|gag order|due process|habeas|deport\w*|voter|voting rights|ballot access|election integrity|second amendment|gun (ban|control|confiscat\w*)|seiz\w+ (property|assets)|civil liberties)\b/.test(
      ctx.text,
    ),

  // Foreign-policy restraint — American armed-force / entanglement posture.
  'foreign-restraint': (ctx) => ctx.usMilitaryNexus,

  // Originalism — a US court interpreting the Constitution (text/original meaning vs
  // reinterpretation), not a foreign court or a stray "opinion".
  // Requires a US court AND genuine constitutional-interpretation content. A bare "Supreme
  // Court opinion." slip-opinion caption is incidental keyword presence — it says nothing
  // about whether THIS case turns on original meaning vs reinterpretation, so it does NOT
  // fire. Fires when the Constitution / a named amendment / stare-decisis / originalism is
  // actually at issue.
  originalism: (ctx) =>
    ctx.usNexus &&
    /\b(supreme court|federal court|court of appeals|district court|justices?|the court)\b/.test(ctx.text) &&
    /\b(constitution\b|constitutional\w*|unconstitutional|stare decisis|original(ism|ist|\s+meaning|\s+intent)|article v\b|((first|second|fourth|fifth|sixth|eighth|tenth|fourteenth)) amendment|overturn\w* (precedent|a prior|roe)|struck down .* unconstitutional|reinterpret\w*)\b/.test(
      ctx.text,
    ),

  // Virtue & religion as preconditions — a US action touching religion / education /
  // family / moral order in law.
  'virtue-covenant': (ctx) =>
    ctx.usNexus &&
    /\b(religio\w*|faith-based|church|chaplain|school prayer|prayer in school|ten commandments|establishment clause|free exercise|marriage|same-sex|abortion|parental rights|curriculum|sex education|gender (identity|ideology)|public morals?)\b/.test(
      ctx.text,
    ),
};

// ---- event extraction ------------------------------------------------------

// Trim the FACT line to a short, embeddable {event} phrase (no judgment added).
function extractEvent(what: string): string {
  let e = what.trim().replace(/\s+/g, ' ');
  e = e.replace(/\.$/, ''); // drop trailing period so it slots mid-sentence
  // Keep the title's original case — headlines are usually proper-noun / headline-case,
  // and lowercasing the lead produced blemishes like "war Department Review". Titles read
  // cleanly after "Does …" without transformation.
  if (e.length > 140) e = e.slice(0, 137).trimEnd() + '…';
  return e;
}

export function generateWeighIt(args: {
  what: string;
  context?: string;
  category: Category;
  outlet?: string;
}): WeighItQuestion[] {
  if (!LENS_ELIGIBLE.includes(args.category)) return [];

  const text = `${args.what} ${args.context ?? ''}`.toLowerCase();
  const outlet = args.outlet ?? '';
  const ctx: MatchContext = {
    text,
    category: args.category,
    outlet,
    usNexus: detectUSNexus(text, outlet),
    usMilitaryNexus: detectUSMilitaryNexus(text, outlet),
    actor: detectActor(text),
  };

  const event = extractEvent(args.what);
  const actor = actorPhrase(ctx.actor);
  const eventRef = actorGist(ctx.actor);

  const fill = (t: Tenet): WeighItQuestion => ({
    tenet: t.id,
    question: t.question
      .replace(/\{event\}/g, event)
      .replace(/\{actor\}/g, actor)
      .replace(/\{eventRef\}/g, eventRef),
    anchor: t.anchor,
  });

  const matched: WeighItQuestion[] = [];
  for (const tenet of TENETS) {
    const gate = RELEVANCE[tenet.id];
    if (gate && gate(ctx)) {
      matched.push(fill(tenet));
      if (matched.length >= MAX_TENET_QUESTIONS) break;
    }
  }

  if (matched.length === 0) return []; // zero is correct — show FACT + CONTEXT only
  matched.push(fill(HISTORICAL_CONTRAST)); // close the set with the clean reference
  return matched;
}
