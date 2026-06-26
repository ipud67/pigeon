// src/lib/llm/provider.ts
//
// The LLMProvider abstraction for Pigeon.
//
// Design goal: this file moves into the real repo at lib/llm/provider.ts UNCHANGED.
// The classifier is the load-bearing trust mechanism of the whole product (SPEC_v1 §2),
// so the contract here is deliberately strict: every classify call returns a typed kind,
// a confidence, a human-readable reasoning string for the audit trail, and a cost estimate.
//
// Provider-agnostic by construction. Anthropic (dev), OpenAI-compatible (Grok-ready),
// and Mock all satisfy this same interface. Switching dev->Grok at prod-flip time is one
// env var (LLM_PROVIDER) + one model id — no prompt rewrite, no caller change.

export type FactKind =
  | 'event_report' // factual reporting of an event/statement/action/data release
  | 'opinion' // op-ed, editorial, "X explains why Y", columnist argument
  | 'analysis' // interprets facts for the reader, "what it means", "why it matters"
  | 'gossip' // celebrity, pop culture, relationship/personality drama
  | 'speculation' // "could", "might", "experts fear", "is expected to"
  | 'unclear'; // too short / paywalled / malformed / genuinely mixed

export const FACT_KINDS: FactKind[] = [
  'event_report',
  'opinion',
  'analysis',
  'gossip',
  'speculation',
  'unclear',
];

export type SourceTier = 'T1_wire' | 'T1_gov' | 'T2_indie' | 'T3_factslice';

export type ClassifyInput = {
  headline: string;
  bodyText: string; // Readability-extracted body, caller should cap at ~8000 chars
  sourceTier: SourceTier;
  sourceOutlet: string;
};

export type ClassifyOutput = {
  kind: FactKind;
  confidence: number; // 0..1, the model's self-reported confidence in `kind`
  reasoning: string; // 1-2 sentences citing specific phrases that drove the call
  estTokensIn: number;
  estTokensOut: number;
  estCostUsd: number; // computed per-provider rate card
};

// A generic completion used by the DEPTH layer (short history + per-story prediction).
// Optional on the interface: the mock adapter does NOT implement it, which is exactly how
// the RED LINE is enforced — under mock there is no `complete`, so depth falls back to a
// labeled placeholder and no paid call is ever made. Only the real (Grok) adapter wires it.
export type CompletionInput = {
  system: string;
  user: string;
  maxTokens?: number;
};

export interface LLMProvider {
  readonly name: string; // 'anthropic' | 'openai-compatible' | 'mock'
  readonly modelId: string; // the exact model in use

  classify(input: ClassifyInput): Promise<ClassifyOutput>;
  complete?(input: CompletionInput): Promise<string>;
}

// ---- Shared helpers used by every adapter ----------------------------------

// The decision rule that turns a raw classification into a publish/reject call.
// Tier sets the rejection threshold: T1 sources are near-auto-pass once kind is
// event_report; T3 (opinion-commingled independents) must clear a higher bar.
// This is the §6.4 editorial gate, expressed once so every caller agrees.
export const PASS_THRESHOLD: Record<SourceTier, number> = {
  T1_wire: 0.7,
  T1_gov: 0.7,
  T2_indie: 0.8,
  T3_factslice: 0.9,
};

export function shouldPublish(c: ClassifyOutput, tier: SourceTier): boolean {
  return c.kind === 'event_report' && c.confidence >= PASS_THRESHOLD[tier];
}

// Defensive JSON extraction. Models occasionally wrap JSON in prose or code fences
// even under json-mode; never let that crash the ingest pipeline. Returns null on
// genuine failure so the caller can treat it as `unclear`.
export function extractJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip ```json fences if present.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  // Find the first { ... last } span.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Coerce a raw model object into a typed ClassifyOutput, clamping/validating fields.
// Unknown `kind` -> 'unclear' (fail closed: an item we can't classify never publishes).
export function coerceClassification(
  obj: Record<string, unknown> | null,
  costFields: { estTokensIn: number; estTokensOut: number; estCostUsd: number },
): ClassifyOutput {
  const kindRaw = typeof obj?.kind === 'string' ? obj.kind.trim() : '';
  const kind: FactKind = (FACT_KINDS as string[]).includes(kindRaw)
    ? (kindRaw as FactKind)
    : 'unclear';

  let confidence =
    typeof obj?.confidence === 'number' ? obj.confidence : Number(obj?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const reasoning =
    typeof obj?.reasoning === 'string' && obj.reasoning.trim().length > 0
      ? obj.reasoning.trim()
      : 'No reasoning returned.';

  return {
    kind,
    confidence,
    reasoning,
    estTokensIn: costFields.estTokensIn,
    estTokensOut: costFields.estTokensOut,
    estCostUsd: costFields.estCostUsd,
  };
}
