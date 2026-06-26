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

import {
  type ClassifyInput,
  type ClassifyOutput,
  type LLMProvider,
} from '../provider';

const ANALYSIS_MARKERS = [
  'why it matters',
  'what it means',
  'the implications',
  'this signals',
  'the bigger picture',
  'the takeaway',
  "what's really going on",
  'experts say this shows',
];
const SPECULATION_MARKERS = [
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
const OPINION_MARKERS = ['i think', 'we should', 'the truth is', 'in my view', 'op-ed'];
const GOSSIP_MARKERS = ['red carpet', 'dating', 'split from', 'feud', 'reality star', 'influencer'];
const BANNED_VERBS = ['slams', 'blasts', 'claims', 'admits', 'insists', 'hits out', 'rips ', 'touts'];

function countHits(haystack: string, needles: string[]): number {
  return needles.reduce((n, m) => (haystack.includes(m) ? n + 1 : n), 0);
}

export class MockAdapter implements LLMProvider {
  readonly name = 'mock';
  readonly modelId = 'mock-heuristic-v1';

  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const hay = `${input.headline}\n${input.bodyText}`.toLowerCase();

    const analysis = countHits(hay, ANALYSIS_MARKERS);
    const speculation = countHits(hay, SPECULATION_MARKERS);
    const opinion = countHits(hay, OPINION_MARKERS) + countHits(hay, BANNED_VERBS);
    const gossip = countHits(hay, GOSSIP_MARKERS);

    let kind: ClassifyOutput['kind'] = 'event_report';
    let confidence = 0.72;
    let reasoning = 'No opinion/analysis/speculation markers found; treated as event report.';

    const scores: Array<[ClassifyOutput['kind'], number]> = [
      ['analysis', analysis],
      ['speculation', speculation],
      ['opinion', opinion],
      ['gossip', gossip],
    ];
    scores.sort((a, b) => b[1] - a[1]);
    if (scores[0][1] > 0) {
      kind = scores[0][0];
      confidence = Math.min(0.95, 0.6 + scores[0][1] * 0.1);
      reasoning = `Matched ${scores[0][1]} ${scores[0][0]} marker(s) via mock heuristic.`;
    }

    return {
      kind,
      confidence,
      reasoning,
      estTokensIn: 0,
      estTokensOut: 0,
      estCostUsd: 0,
    };
  }
}
