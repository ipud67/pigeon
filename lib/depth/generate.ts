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

import type { FactDepth, FactRecord, PredictiveModel, ShortHistory } from '../types';
import type { LLMProvider } from '../llm/provider';
import { buildConstitutionalAnalysis } from './constitutional';

const SHORT_HISTORY_PLACEHOLDER =
  'Short history pending. Pigeon traces when this began and why using its model layer (Grok), which is not yet provisioned. No timeline has been fabricated — this section fills in once the model runs or a hand-researched override is supplied.';

const PREDICTION_PLACEHOLDER =
  'Predictive model pending. Pigeon generates a neutral, indicator-based per-story forecast (how long this is likely to continue and where it may go next) with its model layer (Grok), which is not yet provisioned. No forecast has been fabricated — the value lens never enters a prediction, and this fills in once the model runs or a researched override is supplied.';

function placeholderHistory(): ShortHistory {
  return { source: 'placeholder', text: SHORT_HISTORY_PLACEHOLDER };
}
function placeholderPrediction(): PredictiveModel {
  return { source: 'placeholder', forecast: PREDICTION_PLACEHOLDER };
}

const HISTORY_SYSTEM =
  'You write a tight, neutral SHORT HISTORY for a facts-only news app. 3-5 sentences: when this situation began, the key prior developments, and why it stands where it does today. No opinion, no adjectives of judgment, no speculation about the future. Cite only verifiable history. If you do not have enough grounded information, say so plainly rather than invent.';

const PREDICTION_SYSTEM =
  'You write a neutral, indicator-based PREDICTIVE MODEL for one news story. State, in 3-5 sentences, how much longer this is likely to continue and where it may go next, anchored to observable indicators. Falsifiable and analytically neutral — NO value judgment, NO normative language, NO "should". If indicators are too thin to forecast, say so rather than invent. End with a one-line horizon estimate.';

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
  const constitutional_analysis = buildConstitutionalAnalysis({
    what: fact.what,
    context: fact.context,
    category: fact.category,
    outlet: fact.sources[0]?.outlet,
  });

  // No real completion endpoint (mock) -> labeled placeholders. RED LINE: no paid call.
  if (typeof provider.complete !== 'function') {
    return {
      short_history: placeholderHistory(),
      constitutional_analysis,
      prediction: placeholderPrediction(),
    };
  }

  // Grok path (inert without a key; UNTESTED against a live endpoint in this build).
  const prompt = factPrompt(fact);
  let short_history: ShortHistory;
  let prediction: PredictiveModel;
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

  return { short_history, constitutional_analysis, prediction };
}
