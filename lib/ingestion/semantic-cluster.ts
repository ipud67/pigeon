// lib/ingestion/semantic-cluster.ts
//
// PHASE 1 of the semantic ranking build (docs/SEMANTIC_RANKING_SPEC_2026-07-23.md §3a).
//
// The lexical layer in dedup.ts (URL hash + Jaccard token-set match) catches the same story
// reworded slightly. It cannot catch the same ACTION described by headlines sharing zero
// words — the proof case named in the spec:
//
//   "Imposing Additional Duties to Offset Canadian Discrimination Against the Commerce of the
//    United States with Respect to Motor Vehicles"
//   "Fact Sheet: President Donald J. Trump Takes Further Action To Adjust Imports Of Aluminum
//    Into The United States"
//
// This module runs a SECOND pass over the lexical clusters' primaries: embed each primary,
// and agglomeratively merge clusters whose primaries are close enough in meaning. It augments
// the lexical layer, it does not replace it — dedup.ts stays exactly as it was, cheap and
// exact-match-first; this only looks at what lexical dedup left as SEPARATE clusters.
//
// ---- why a bare cosine threshold is not enough (tuning notes, 2026-07-24) -------------------
//
// Tuned against the 43 real (frozen, non-constructed) records in training/oracle/fixtures.json
// — the only real corroborated-by-multiple-sources news data in the repo. Embedding
// `${title}. ${body, stripped of HTML entities, first 500 chars}` with all-MiniLM-L6-v2:
//
//   the ONE known true pair (tariff duties <-> aluminum fact sheet)  cosine = 0.563
//
// At threshold 0.55 that pair is caught, and of all 903 possible pairs across the 43 fixtures,
// only 5 OTHERS score higher or comparably. Four of those five are same-recurring-body,
// different-instance items that a global similarity number genuinely cannot tell apart from a
// true duplicate at this text length:
//   - two different monthly payroll reports (Feb vs March)            0.81
//   - two different Supreme Court cases (shared opinion boilerplate)  0.72, 0.64
//   - two different UN Security Council meetings on different agenda items   0.63
//
// Two guards close most of that gap without adding spelling-epicycle regex:
//   1. DATE_PROXIMITY_GUARD_DAYS — a single news EVENT does not span more than two weeks of
//      separate publication dates; a monthly/periodic report from a different period will.
//      This alone kills the payroll false-positive (28 days apart).
//   2. Case-caption guard — "X v. Y" is a legal fact, not a spelling pattern: two different
//      captions are, by definition, two different cases, however similar the surrounding
//      opinion boilerplate reads. Reject any merge where both titles are caption-shaped and
//      the captions differ.
//
// What remains unguarded (documented, not hidden): two DIFFERENT meetings of the same
// recurring body close together in time (the Security Council case) can still cross the
// threshold. This is the honest residual risk this phase ships with — see the phase report.
// In production this risk is smaller than the test above suggests, because a real ingest run
// only ever clusters items pulled in the SAME run (hours, not the 7-month span the fixtures
// deliberately cover to stress-test the threshold).

import type { RawItem } from '../types';
import { stripHtml } from './http';
import { embedTexts, cosineSimilarity } from './embeddings';
import { preferPrimary, type Cluster } from './dedup';

export const SEMANTIC_SIM_THRESHOLD = 0.55;
export const DATE_PROXIMITY_GUARD_DAYS = 14;

// ---- structured-identifier guard --------------------------------------------------------
//
// A live `npm run ingest:dry` run against TODAY's real feed (2026-07-24, not a fixture)
// surfaced a second, more severe template-collision family the fixture-tuned threshold above
// never saw: SEC 8-K filing titles ("8-K - Quantum-Si Inc (0001816431) (Filer)") are SO
// templated that the company name barely moves the embedding — fifteen DIFFERENT companies'
// unrelated 8-Ks chained into one cluster at cosine 0.78-0.85, well clear of the 0.55
// threshold. DCPD (Daily Compilation of Presidential Documents) titles did the same thing at
// 0.66-0.85. Both families carry a STRUCTURED IDENTIFIER in the title that uniquely names the
// underlying document — the SEC CIK number, the DCPD document number — and that identifier is
// a fact, not a spelling pattern: two different identifiers are, by construction, two
// different documents, however close the surrounding boilerplate reads. Same principle as the
// case-caption guard below, generalized to a short table instead of one special case.
//
// This is a real, load-bearing limitation of short-string sentence embeddings, not a tuning
// miss: at ~10-15 content-bearing tokens, a rigid template dominates mean pooling. The fix is
// structural pattern-reading (three lines, extensible, documented), not a spelling epicycle —
// the distinction the spec draws in §2 between matching technique and policy.
type IdentifierRule = { name: string; re: RegExp };
const IDENTIFIER_RULES: IdentifierRule[] = [
  // "X v. Y" case captions — different party names are definitionally different cases.
  { name: 'case-caption', re: /^(.{2,60}?)\s+v\.?\s+(.{2,80})$/i },
  // SEC EDGAR filings — the CIK (company identifier) in parens before "(Filer)".
  { name: 'sec-8k-cik', re: /\((\d{6,10})\)\s*\(filer\)\s*$/i },
  // Daily Compilation of Presidential Documents — the DCPD document number.
  { name: 'dcpd-number', re: /^dcpd-(\d+)\s*-/i },
];

function identifierOf(title: string): { rule: string; id: string } | null {
  const t = title.trim();
  for (const { name, re } of IDENTIFIER_RULES) {
    const m = t.match(re);
    if (m) return { rule: name, id: m.slice(1).join('|').toLowerCase() };
  }
  return null;
}

/** True when both titles carry the SAME kind of structured identifier (case caption / SEC CIK
 *  / DCPD number) but the identifiers themselves differ. A hard block, overriding embedding
 *  similarity entirely — see the module note above for why. */
function isDistinctIdentifierPair(a: string, b: string): boolean {
  const ia = identifierOf(a);
  const ib = identifierOf(b);
  if (!ia || !ib || ia.rule !== ib.rule) return false;
  return ia.id !== ib.id;
}

function daysApart(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (isNaN(ta) || isNaN(tb)) return 0; // unknown dates never block a merge on their own
  return Math.abs(ta - tb) / 86_400_000;
}

function embedText(item: RawItem): string {
  return `${item.title}. ${stripHtml(item.body ?? '').slice(0, 500)}`;
}

export type SemanticMergeAudit = {
  a: string; // title
  b: string; // title
  similarity: number;
};

export type SemanticMergeResult = {
  clusters: Cluster[];
  merges: SemanticMergeAudit[];
  embedMs: number;
  itemsEmbedded: number;
  skippedReason?: string; // set when the model failed to load / run — merge is skipped, not fatal
};

/**
 * Second-pass agglomerative merge over lexical clusters' primaries. $0, local, ingest-time
 * only (spec §4). Never throws: a model-load failure (offline dev box, first-run download
 * blocked) degrades to "no semantic merge this run," identical to how a dead RSS source
 * degrades to zero items elsewhere in the pipeline — never blocks the ingest.
 */
export async function semanticMerge(clusters: Cluster[]): Promise<SemanticMergeResult> {
  if (clusters.length < 2) {
    return { clusters, merges: [], embedMs: 0, itemsEmbedded: 0 };
  }

  const t0 = Date.now();
  let vectors: Float32Array[];
  try {
    vectors = await embedTexts(clusters.map((c) => embedText(c.primary)));
  } catch (err) {
    return {
      clusters,
      merges: [],
      embedMs: Date.now() - t0,
      itemsEmbedded: 0,
      skippedReason: (err as Error).message,
    };
  }
  const embedMs = Date.now() - t0;

  // Working state: each node keeps EVERY constituent lexical cluster's own vector, not a
  // running average. Merge eligibility is COMPLETE-linkage: the minimum pairwise similarity
  // across the full cross-product of both nodes' vectors, not just the closest pair.
  //
  // Single-linkage (merge if the CLOSEST pair clears the threshold, judge future merges
  // against a running centroid average) is the textbook chaining trap, and the live run that
  // surfaced the 8-K/DCPD false-merge families (see the identifier-guard note above) also
  // showed the shape of it: once two items merge, an averaged centroid drifts toward the
  // shared TEMPLATE, making the next merge easier than the last, so a chain can walk from one
  // real duplicate into a dozen unrelated ones. Complete-linkage requires every member to stay
  // genuinely close to every other member, so one weak link stops the chain instead of
  // dragging the average down with it.
  type Node = { cluster: Cluster; vecs: Float32Array[] };
  let nodes: Node[] = clusters.map((c, i) => ({ cluster: c, vecs: [vectors[i]] }));
  const merges: SemanticMergeAudit[] = [];

  function minPairwiseSim(a: Node, b: Node): number {
    let min = Infinity;
    for (const va of a.vecs) {
      for (const vb of b.vecs) {
        const s = cosineSimilarity(va, vb);
        if (s < min) min = s;
      }
    }
    return min;
  }

  // Greedy agglomerative: repeatedly merge the single closest eligible pair above threshold,
  // repeat. O(k^2) node-pairs per round, each an O(m*n) vector cross-check on typically 1-2
  // vectors per node — cheap at a per-run cluster count of tens to low hundreds, and merges
  // are rare so this outer loop runs only a handful of times.
  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let bestSim = -1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const titleA = a.cluster.primary.title;
        const titleB = b.cluster.primary.title;
        if (isDistinctIdentifierPair(titleA, titleB)) continue;
        if (daysApart(a.cluster.primary.datetime_utc, b.cluster.primary.datetime_utc) > DATE_PROXIMITY_GUARD_DAYS)
          continue;
        const sim = minPairwiseSim(a, b);
        if (sim >= SEMANTIC_SIM_THRESHOLD && sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI === -1) break;

    const a = nodes[bestI];
    const b = nodes[bestJ];
    merges.push({ a: a.cluster.primary.title, b: b.cluster.primary.title, similarity: bestSim });

    const mergedMembers = [...a.cluster.members, ...b.cluster.members];
    const mergedPrimary = preferPrimary(a.cluster.primary, b.cluster.primary);
    const merged: Node = { cluster: { primary: mergedPrimary, members: mergedMembers }, vecs: [...a.vecs, ...b.vecs] };
    nodes = [...nodes.filter((_, idx) => idx !== bestI && idx !== bestJ), merged];
  }

  return {
    clusters: nodes.map((n) => n.cluster),
    merges,
    embedMs,
    itemsEmbedded: clusters.length,
  };
}
