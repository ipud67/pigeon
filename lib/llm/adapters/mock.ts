// src/lib/llm/adapters/mock.ts
//
// Mock adapter — deterministic, zero-cost, no network. For unit tests and fast local
// iteration on pipeline plumbing (dedup, storage, render) without paying for classify
// calls. Also used to smoke-test the eval harness itself before spending real tokens.
//
// The heuristic here is intentionally crude — it keys on the epistemic-verb/marker
// vocabulary from the prompt. It is NOT the product's classifier (the LLM is). It exists
// so the harness can run end-to-end with no key, and so the registry/factory has a
// safe default.
//
// ---------------------------------------------------------------------------
// 2026-07-22 — TWO STRUCTURAL DEFECTS FIXED. Both silently gated real sources out.
//
// Defect 1 — the flat 0.72 ceiling.
// The old adapter returned a CONSTANT 0.72 for every clean event report, and raised
// confidence ONLY on the branch that also flipped `kind` to a non-event value. So
// `shouldPublish` (kind === 'event_report' && confidence >= threshold) could never be
// satisfied for T2_indie (0.8) or T3_factslice (0.9) — not for any input, ever. Five of
// the seven sources Timn ratified on 2026-07-21 published zero records because of this,
// and it read as an editorial trust problem when it was arithmetic.
// Fix: a clean event report now EARNS its confidence from positive evidence that it is a
// factual dispatch (reporting verb, time reference, quantity, dateline-ish proper noun,
// substantive body). No evidence still means low confidence — the gate keeps its meaning.
// "I found nothing wrong" is not the same claim as "I can see this is a news event," and
// the old code conflated them.
//
// Defect 2 — single incidental hedge word flipped the whole item to `speculation`.
// ' may ', 'could ', 'might ' are ordinary words in straight wire copy ("the ruling may
// take effect in August"). One occurrence anywhere in a 2,000-character body reclassified
// the item and dropped it. Fix: markers are graded. Unambiguous ones (op-ed, in my view,
// red carpet, "why it matters") still flip on a single hit. Ambiguous hedges must either
// appear in the HEADLINE — where an opinion piece announces itself — or appear at least
// twice before they carry the item.
//
// Neither change touches PASS_THRESHOLD. Timn's trust thresholds are untouched and remain
// his to set (§7). This only makes the stand-in capable of expressing a confidence the
// thresholds can actually read.
// ---------------------------------------------------------------------------

import {
 type ClassifyInput,
 type ClassifyOutput,
 type LLMProvider,
} from '../provider';

// ---- disqualifying markers, graded by ambiguity ----------------------------

// STRONG: effectively never appear in a straight factual dispatch. One hit is enough.
const STRONG_ANALYSIS = [
 'why it matters',
 'what it means',
 'the implications',
 'this signals',
 'the bigger picture',
 'the takeaway',
 "what's really going on",
 'experts say this shows',
];
const STRONG_OPINION = ['i think', 'we should', 'the truth is', 'in my view', 'op-ed', 'opinion:', 'editorial:', 'commentary:'];
const STRONG_GOSSIP = ['red carpet', 'dating', 'split from', 'feud', 'reality star', 'influencer'];

// WEAK: ordinary words in neutral reporting. Need a headline hit or >= 2 occurrences.
const WEAK_SPECULATION = [
 'could ',
 'might ',
 ' may ',
 'is expected to',
 'is poised to',
 'analysts predict',
 'experts fear',
 'is likely to',
 'looms',
];
// Tabloid framing verbs. Strong in a HEADLINE, weak in a body (a lawsuit "claims" things in
// perfectly neutral copy).
const FRAMING_VERBS = ['slams', 'blasts', 'claims', 'admits', 'insists', 'hits out', 'rips ', 'touts'];

// ---- positive evidence that this IS a factual dispatch ---------------------

// Reporting/action verbs. BOTH tenses on purpose: wire headlines are overwhelmingly present
// tense ("Kuwait intercepts Iranian drones", "House passes defense bill") while bodies are
// past tense. An earlier revision of this list was past-tense-only, calibrated against
// hand-written test sentences rather than real feed output, and it scored genuine CENTCOM and
// Mossad war dispatches at 0.55-0.64 — under the T2 bar. The probe in tests/probe-jpost.mjs
// caught it. Real feed shapes, not imagined ones.
const REPORTING_VERBS =
 /\b(said|says|announced?s?|sign(s|ed)|issue[sd]?|release[sd]?|file[sd]?|rule[sd]?|confirm(s|ed)?|report(s|ed)?|strike[s]?|struck|launch(es|ed)?|arrest(s|ed)?|approve[sd]?|reject(s|ed)?|vote[sd]?|die[sd]?|kill(s|ed)?|resign(s|ed)?|meet(s)?|met|agree[sd]?|declare[sd]?|impose[sd]?|seize[sd]?|testif(y|ies|ied)|sentence[sd]?|charge[sd]?|publish(es|ed)?|award(s|ed)?|appoint(s|ed)?|withdrew|withdraw(s)?|suspend(s|ed)?|halt(s|ed)?|intercept(s|ed)?|pass(es|ed)?|warn(s|ed)?|win(s)?|won|add(s|ed)?|urge[sd]?|promise[sd]?|escalate[sd]?|seek(s)?|sought|find(s)?|found|order(s|ed)?|hold(s)?|held|back(s|ed)?|block(s|ed)?|call(s|ed)?|name[sd]?|accuse[sd]?|deny|denies|denied|aim(s|ed)?|coordinate[sd]?|coordinates)\b/;
const TIME_REFERENCE =
 /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|yesterday|today|this morning|overnight|on \w+day|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\b(19|20)\d{2}\b)\b/;
const QUANTITY = /\d/;
// A named actor: an ALL-CAPS acronym (IRGC, CENTCOM, CIA, IDF, UNESCO), OR two consecutive
// capitalised words, OR at least two distinct capitalised tokens anywhere outside sentence
// position. Real dispatches name who did the thing; that is the signal being read here.
const ACRONYM = /\b[A-Z]{2,}\b/;
const CONSECUTIVE_CAPS = /\b[A-Z][a-z]+ [A-Z][a-z]+/;
function namedActors(text: string): boolean {
 if (ACRONYM.test(text) || CONSECUTIVE_CAPS.test(text)) return true;
 // Capitalised tokens that are not the first word of a sentence.
 const tokens = text.match(/(?<![.!?]\s|^)\b[A-Z][a-z]{2,}\b/g) ?? [];
 return new Set(tokens).size >= 2;
}

function countHits(haystack: string, needles: string[]): number {
 return needles.reduce((n, m) => (haystack.includes(m) ? n + 1 : n), 0);
}

export class MockAdapter implements LLMProvider {
 readonly name = 'mock';
 readonly modelId = 'mock-heuristic-v2';

 async classify(input: ClassifyInput): Promise<ClassifyOutput> {
 const rawHead = input.headline ?? '';
 const rawBody = input.bodyText ?? '';
 const head = rawHead.toLowerCase();
 const hay = `${rawHead}\n${rawBody}`.toLowerCase();

 // ---- 1. disqualifying pass ---------------------------------------------

 const strongAnalysis = countHits(hay, STRONG_ANALYSIS);
 const strongOpinion = countHits(hay, STRONG_OPINION);
 const strongGossip = countHits(hay, STRONG_GOSSIP);

 // Weak markers carry only from the headline, or when the body is SATURATED with them.
 // Raw repetition is the wrong test: a 2,000-character dispatch can legitimately contain
 // both "may" and "could" without being speculation. A speculation piece is dense in them.
 // Threshold is 3, not 2, and deliberately so: the RSS summaries we actually ingest run
 // 150-400 characters, and a straight court or policy dispatch of that length routinely
 // carries two ordinary hedges ("the ruling may take effect... could affect five
 // agencies"). Two is normal prose. Three is a posture.
 const carriesWeak = (headHits: number, allHits: number): number => {
 if (headHits > 0) return headHits + 1; // an opinion piece announces itself in the headline
 if (allHits >= 3) return allHits; // saturated body
 return 0;
 };

 const speculation = carriesWeak(countHits(head, WEAK_SPECULATION), countHits(hay, WEAK_SPECULATION));
 const framing = carriesWeak(countHits(head, FRAMING_VERBS), countHits(hay, FRAMING_VERBS));

 const scores: Array<[ClassifyOutput['kind'], number]> = [
 ['analysis', strongAnalysis],
 ['speculation', speculation],
 ['opinion', strongOpinion + framing],
 ['gossip', strongGossip],
 ];
 scores.sort((a, b) => b[1] - a[1]);

 if (scores[0][1] > 0) {
 return {
 kind: scores[0][0],
 confidence: Math.min(0.95, 0.6 + scores[0][1] * 0.1),
 reasoning: `Matched ${scores[0][1]} ${scores[0][0]} marker(s) via mock heuristic.`,
 estTokensIn: 0,
 estTokensOut: 0,
 estCostUsd: 0,
 };
 }

 // ---- 1b. not-an-event formats -----------------------------------------
 //
 // Timn ratified on 2026-07-21 that readouts, digests, briefings and promotional
 // releases are not events (oracle pairs P011-P015, group `event-vs-digest`). The same
 // logic applies at the gate: an interrogative headline is an explainer or a listicle,
 // and a "now streaming"/"watch:" item is a format promotion. Neither is a dispatch.
 const NOT_AN_EVENT =
 /^(watch|listen|photos?|video|opinion|analysis|explainer|live updates?|in pictures)\s*[:|-]|\bis now streaming\b|\bsubscribe\b|\bnewsletter\b/i;
 if (rawHead.trim().endsWith('?') || NOT_AN_EVENT.test(rawHead)) {
 return {
 kind: 'analysis',
 confidence: 0.75,
 reasoning: 'Interrogative or promotional headline format — an explainer/listicle/promo, not an event dispatch.',
 estTokensIn: 0,
 estTokensOut: 0,
 estCostUsd: 0,
 };
 }

 // ---- 2. positive pass: is this recognisably a factual dispatch? --------
 //
 // Confidence is EARNED here, not asserted. An item with no visible event evidence
 // (a bare link, a nav stub, a paywall teaser) stays below every threshold and is
 // still rejected — which is the behaviour the gate is supposed to have.

 const evidence: string[] = [];
 if (REPORTING_VERBS.test(hay)) evidence.push('reporting verb');
 if (TIME_REFERENCE.test(hay)) evidence.push('time reference');
 if (QUANTITY.test(hay)) evidence.push('quantity');
 if (namedActors(`${rawHead}\n${rawBody}`)) evidence.push('named actor/dateline');

 let confidence = 0.55 + evidence.length * 0.09; // 0.55 (none) .. 0.91 (all four)
 if (rawBody.trim().length >= 200) {
 confidence += 0.04; // a substantive dispatch, not a headline stub
 evidence.push('substantive body');
 }
 confidence = Math.min(0.93, Math.round(confidence * 100) / 100);

 return {
 kind: 'event_report',
 confidence,
 reasoning: evidence.length
 ? `No disqualifying markers; event evidence: ${evidence.join(', ')}.`
 : 'No disqualifying markers, but no positive event evidence either — low confidence.',
 estTokensIn: 0,
 estTokensOut: 0,
 estCostUsd: 0,
 };
 }
}
