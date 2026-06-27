// lib/depth/constitutional.ts
//
// CONSTITUTIONAL ANALYSIS (SPEC v2 §B, layer 3) — DIRECTIONAL (Timn 2026-06-26, LOCKED).
// The founding standard IS the measure: every event is weighed against the Constitution, the
// founders' ideals, and the founding/colonial tradition. This is NOT neutral both-sides.
//   - The analysis LEADS with the founding ideal(s) at stake (rule 3), then names the case
//     the action lines up with that standard and the founding-BASED tension (rule 5).
//   - Modern-liberal rulings/judges are NEVER cited here as constitutional authority or as a
//     co-equal "other side" (rule 2). Both sides of the contrast anchor to PRIMARY founding
//     documents only; a court action is a neutral FACT elsewhere and a prediction indicator,
//     never the measure.
//   - Voice: plain, blue-collar — the tenets carry it (lib/weighit/tenets.ts).
//
// This is RULE-BASED and deterministic — it reuses the SAME relevance pass as WEIGH-IT
// (lib/weighit), so it never fires on a routine item the lens doesn't touch. It writes NO
// event-specific claims: the framing + within/beyond text is the founding standard the reader
// tests the event against, not a fabricated fact. Because it needs no LLM, this layer renders
// REAL content now, on mock — unlike short_history + prediction, which need the Grok path and
// fall back to a labeled placeholder. The Grok path (lib/depth/generate.ts) supersedes this
// with a directional, plain-voice prose analysis when a key is provisioned.

import type { ConstitutionalAnalysis, Category } from '../types';
import { matchTenets } from '../weighit/generate';

const MEASURE_LEAD =
  'Pigeon weighs this against the founding standard — the Constitution, the founders’ ideals, and the founding tradition. That is the yardstick here, not modern court opinion.';

// When a story implicates force / law-and-order, foreground the founders' first reason for
// government — order so people can live in peace (Preamble "domestic Tranquility"). Timn
// flagged this ideal was under-played; lead with it where it applies.
const RE_LAW_ORDER =
  /\b(national guard|troops?|insurrection|riot|unrest|deploy|federaliz|law enforcement|police|crime|border|militia|martial law|public safety|order)\b/i;
const LAW_ORDER_IDEAL =
  'The founders built government first to secure order so ordinary people can live and work in peace — “domestic Tranquility” (Preamble). Law and order is the first job, not an afterthought.';

export function buildConstitutionalAnalysis(args: {
  what: string;
  context?: string;
  category: Category;
  outlet?: string;
}): ConstitutionalAnalysis {
  const { tenets, fill } = matchTenets(args);

  if (tenets.length === 0) {
    return {
      source: 'placeholder',
      contrasts: [],
      note: 'No constitutional question maps to this item — it is routine, administrative, or outside the founding framework. Pigeon shows the fact and its context only.',
    };
  }

  // LEAD with the founding ideals at stake (foregrounded, hard). The law-and-order ideal goes
  // first when the story touches force/public-order, then the firing tenets' own ideals.
  const text = `${args.what} ${args.context ?? ''}`;
  const ideals: string[] = [];
  if (RE_LAW_ORDER.test(text)) ideals.push(LAW_ORDER_IDEAL);
  for (const t of tenets) {
    if (t.ideal && !ideals.includes(t.ideal)) ideals.push(t.ideal);
  }
  const framing = [MEASURE_LEAD, ...ideals].join(' ');

  const contrasts = tenets
    .filter((t) => t.within && t.beyond)
    .map((t) => ({
      tenet: t.id,
      label: t.label,
      question: fill(t.question),
      within_bounds: fill(t.within as string),
      beyond_bounds: fill(t.beyond as string),
      anchor: t.anchor,
    }));

  return { source: 'rule-based', framing, contrasts };
}
