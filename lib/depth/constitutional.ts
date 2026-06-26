// lib/depth/constitutional.ts
//
// CONSTITUTIONAL ANALYSIS (SPEC v2 §B, layer 3). The evolution of WEIGH-IT from
// questions-only to a substantive, cited, two-sided contrast: for each tenet the event
// actually implicates, lay out the within-bounds case AND the beyond-bounds case, each
// anchored to a primary founding document.
//
// This is RULE-BASED and deterministic — it reuses the SAME relevance pass as WEIGH-IT
// (lib/weighit), so it never fires on a routine item the lens doesn't touch. It writes NO
// event-specific claims: the within/beyond text is a neutral framing the reader tests the
// event against (the tenets' `within`/`beyond` templates), not a fabricated fact. The
// partisan verdict is deliberately withheld (calibration pending Timn's relevance chat).
//
// Because it needs no LLM, the constitutional layer renders REAL content now, on mock —
// unlike short_history + prediction, which need the Grok path and fall back to a labeled
// placeholder.

import type { ConstitutionalAnalysis, Category } from '../types';
import { matchTenets } from '../weighit/generate';

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

  return { source: 'rule-based', contrasts };
}
