// lib/depth/constitutional.ts
//
// CONSTITUTIONAL ANALYSIS (SPEC v2 §B, layer 3) — DIRECTIONAL (Timn 2026-06-26, LOCKED).
// The founding standard IS the measure: every event is weighed against the Constitution, the
// founders' ideals, and the founding/colonial tradition. This is NOT neutral both-sides — but
// the directional stance is IMPLICIT in how the contrast is written, never announced.
//
// READER-FACING = SUBSTANCE ONLY (Timn 2026-06-26). We do NOT emit a methodology/framing
// preamble that explains to the reader how we weigh, what standard we use, or what we exclude.
// That is internal training/auditing for Pigeon only. The contrasts below argue from the
// founding standard directly — the within/beyond statements ARE the analysis. No lens-note,
// no "Pigeon weighs this against…" lead.
//
// This is RULE-BASED and deterministic — it reuses the SAME relevance pass as WEIGH-IT
// (lib/weighit), so it never fires on a routine item the lens doesn't touch. It writes NO
// event-specific claims: the within/beyond text is the founding standard the reader tests the
// event against, not a fabricated fact. Because it needs no LLM, this layer renders REAL
// content now, on mock — unlike short_history + prediction, which need the Grok path and are
// omitted under mock. The Grok path (lib/depth/generate.ts) supersedes this with a directional,
// plain-voice prose analysis when a key is provisioned.

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
    // Routine / administrative / outside the founding framework — no constitutional question
    // maps. The renderer omits the section entirely; this note is internal only.
    return { source: 'placeholder', contrasts: [], note: 'No constitutional question maps to this item.' };
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
