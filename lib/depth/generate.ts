// lib/depth/generate.ts
//
// DEPTH generation (SPEC v2 §D). Every headline IS its own long form; the three depth
// layers below are first-class on the fact record.
//
//   CONSTITUTIONAL ANALYSIS — rule-based + cited; renders REAL content now (no LLM).
//   SHORT HISTORY           — needs real-world facts -> LLM (Grok). Placeholder on mock.
//   PREDICTIVE MODEL        — needs real-world facts -> LLM (Grok). Placeholder on mock.
//
// RED LINE (unchanged): no paid LLM call. Under the mock adapter `provider.complete` is
// undefined, so short_history + prediction fall straight to a clearly-labeled placeholder
// and NO network/cost is incurred. The Grok path runs only when a key is provisioned AND
// the adapter exposes `complete`. NEVER fabricate specifics — the placeholder says plainly
// that the section fills in once the model runs or a researched override is supplied.

import type {
  ConstitutionalAnalysis,
  FactDepth,
  FactRecord,
  PredictiveModel,
  ShortHistory,
} from '../types';
import type { LLMProvider } from '../llm/provider';
import { buildConstitutionalAnalysis } from './constitutional';

// VOICE (Timn 2026-06-26, LOCKED): plain, blue-collar — short sentences, concrete words, no
// academic jargon, no throat-clearing. Rich in history and meaning, but easy and fast to read.
// NOT dumbed-down. This line is appended to every reader-facing generation prompt.
const VOICE =
  'VOICE: write plain and blue-collar — short sentences, concrete words, no academic jargon, no throat-clearing. Rich in meaning and history but easy and fast for a working person to read. Not dumbed-down — just clear.';

// Placeholder marker only — NEVER reader-facing. The renderer omits any section whose source
// is 'placeholder' (no methodology text, no "what we would generate" explanation). These
// strings exist solely so a section is unambiguously flagged as not-yet-real internally.
const SHORT_HISTORY_PLACEHOLDER = 'Analysis coming.';

const PREDICTION_PLACEHOLDER = 'Analysis coming.';

function placeholderHistory(): ShortHistory {
  return { source: 'placeholder', text: SHORT_HISTORY_PLACEHOLDER };
}
function placeholderPrediction(): PredictiveModel {
  return { source: 'placeholder', forecast: PREDICTION_PLACEHOLDER };
}

const HISTORY_SYSTEM =
  'You write a tight SHORT HISTORY for a facts-only news app. 3-5 sentences: when this situation began, the key prior developments, and why it stands where it does today. No opinion, no adjectives of judgment, no speculation about the future. Cite only verifiable history. If you do not have enough grounded information, say so plainly rather than invent. ' +
  VOICE;

const PREDICTION_SYSTEM =
  'You write a neutral, indicator-based PREDICTIVE MODEL for one news story. State, in 3-5 sentences, how much longer this is likely to continue and where it may go next, anchored to observable indicators — including market gauges where relevant (Treasury yields and the 2s10s spread, the VIX, major index moves, WTI oil, CME-implied rate odds). Falsifiable and analytically neutral — NO value judgment, NO normative language, NO "should". Court actions may be named only as falsifiable indicators, never as a verdict. If indicators are too thin to forecast, say so rather than invent. End with a one-line horizon estimate. ' +
  VOICE;

// DIRECTIONAL constitutional analysis (Timn 2026-06-26, LOCKED). The Grok path supersedes the
// rule-based analysis with grounded, plain-voice prose that takes the founding standard as the
// measure. The hard rules are baked in so live generation can never drift back to neutral
// both-sides or cite a modern-liberal court as the constitutional authority.
const CONSTITUTIONAL_SYSTEM =
  'You write the CONSTITUTIONAL ANALYSIS for one news story in a facts-only news app with an explicitly directional editorial position. The founding standard IS the measure: weigh the event against the U.S. Constitution, the founders’ ideals, and the founding/colonial tradition. ' +
  'HARD RULES: (1) Lead with the founding ideal at stake (for example, government exists first for law and order so people can live in peace — the Preamble’s “domestic Tranquility”). (2) Go deep on real founding-era precedent — cite primary sources: the Constitution by article/section/clause, The Federalist by number, the Declaration, founding statutes, and the acts and episodes of the founding generation (for example, Washington personally leading the militia in the Whiskey Rebellion of 1794, the Militia Acts of 1792, the Tariff Act of 1789, the Decision of 1789, the First Bank fight and McCulloch v. Maryland, the Jay Treaty, the Naturalization Act of 1790). (3) Do NOT cite modern-liberal rulings or judges as constitutional authority or as a co-equal opposing view; a modern court ruling may appear only as a neutral fact or a forecast indicator, never as the measure. (4) Genuine founding-based tension is fair to name — but the critique must come FROM the founding standard (limited and enumerated federal power, anti-standing-army, separation of powers, consent of the governed), never from modern jurisprudence. ' +
  'Write 5-9 sentences of grounded prose. Do not invent event-specific facts you were not given; ground the law and history in verifiable primary sources. ' +
  VOICE;

function factPrompt(fact: FactRecord): string {
  return [
    `FACT: ${fact.what}`,
    fact.context ? `CONTEXT: ${fact.context}` : '',
    `PLACE: ${fact.place}`,
    `WHEN: ${fact.datetime_utc}`,
    `CATEGORY: ${fact.category}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Generate (or placeholder) the depth layers for one record. Async because the LLM path is
// async; under mock it resolves immediately with placeholders + the rule-based analysis.
export async function generateDepth(fact: FactRecord, provider: LLMProvider): Promise<FactDepth> {
  // Rule-based DIRECTIONAL analysis — real content now, on mock. The Grok path supersedes it
  // below with grounded plain-voice prose (same directional rules) when a key is present.
  const ruleBased = buildConstitutionalAnalysis({
    what: fact.what,
    context: fact.context,
    category: fact.category,
    outlet: fact.sources[0]?.outlet,
  });

  // No real completion endpoint (mock) -> labeled placeholders. RED LINE: no paid call.
  if (typeof provider.complete !== 'function') {
    return {
      short_history: placeholderHistory(),
      constitutional_analysis: ruleBased,
      prediction: placeholderPrediction(),
    };
  }

  // Grok path (inert without a key; UNTESTED against a live endpoint in this build).
  const prompt = factPrompt(fact);
  let short_history: ShortHistory;
  let prediction: PredictiveModel;
  let constitutional_analysis: ConstitutionalAnalysis = ruleBased;
  try {
    const h = await provider.complete({ system: HISTORY_SYSTEM, user: prompt, maxTokens: 400 });
    short_history = h ? { source: 'llm', text: h } : placeholderHistory();
  } catch {
    short_history = placeholderHistory();
  }
  try {
    const p = await provider.complete({ system: PREDICTION_SYSTEM, user: prompt, maxTokens: 400 });
    prediction = p ? { source: 'llm', forecast: p } : placeholderPrediction();
  } catch {
    prediction = placeholderPrediction();
  }
  // Only the lens-eligible items (those the rule-based pass actually flagged) get a generated
  // directional analysis — a routine item that maps to no tenet stays FACT + CONTEXT only.
  if (ruleBased.source === 'rule-based') {
    try {
      const c = await provider.complete({
        system: CONSTITUTIONAL_SYSTEM,
        user: prompt,
        maxTokens: 700,
      });
      if (c) constitutional_analysis = { source: 'llm', contrasts: [], prose: c };
    } catch {
      constitutional_analysis = ruleBased; // fall back to the cited rule-based contrast
    }
  }

  return { short_history, constitutional_analysis, prediction };
}
