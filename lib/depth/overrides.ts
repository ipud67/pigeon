// lib/depth/overrides.ts
//
// Hand-researched depth overrides (SPEC v2 §D). Clark hand-researches real short-history,
// constitutional-analysis, and prediction content for the top ranked stories and drops it
// at data/depth-overrides.json, keyed by fact id. When a fact has an override, the renderer
// uses it instead of whatever ingest produced (placeholder under mock, LLM under Grok).
//
// The file is OPTIONAL — absent it, this returns an empty map and nothing breaks. Each
// override entry is a partial FactDepth; only the sub-sections present are overridden, so
// Clark can supply just a real short_history (say) and leave the rule-based constitutional
// analysis intact.
//
// Server-only (reads disk). The store/pages import this; the client feed island never does.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FactDepth, ConstitutionalAnalysis, ShortHistory, PredictiveModel } from '../types';

const OVERRIDES_PATH = join(process.cwd(), 'data', 'depth-overrides.json');

// Raw shape allowed in the JSON file (loose — we tag `source` ourselves so authors don't
// have to). Each section optional.
type RawOverride = {
  short_history?: string | ShortHistory;
  // Clark's research drops constitutional_analysis as a single prose string (within-bounds
  // AND exceeds-bounds, cited, no verdict). A structured object is also accepted.
  constitutional_analysis?: string | ConstitutionalAnalysis;
  prediction?: string | { forecast: string; horizon?: string; indicators?: string[] } | PredictiveModel;
};

let cache: Record<string, RawOverride> | null = null;

function load(): Record<string, RawOverride> {
  if (cache) return cache;
  try {
    if (!existsSync(OVERRIDES_PATH)) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as Record<string, RawOverride>;
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function normHistory(v: RawOverride['short_history']): ShortHistory | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return { source: 'override', text: v };
  return { ...v, source: 'override' };
}

function normPrediction(v: RawOverride['prediction']): PredictiveModel | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return { source: 'override', forecast: v };
  return { ...v, source: 'override' };
}

function normConstitutional(
  v: string | ConstitutionalAnalysis | undefined,
): ConstitutionalAnalysis | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return { source: 'override', contrasts: [], prose: v };
  return { ...v, source: 'override' };
}

// Merge any override for `id` over the depth ingest already produced. Section-level merge:
// a present override section replaces; an absent one keeps the ingest value.
export function applyDepthOverride(id: string, base: FactDepth | undefined): FactDepth | undefined {
  const ov = load()[id];
  if (!ov) return base;
  const merged: FactDepth = { ...(base ?? {}) };
  const h = normHistory(ov.short_history);
  const c = normConstitutional(ov.constitutional_analysis);
  const p = normPrediction(ov.prediction);
  if (h) merged.short_history = h;
  if (c) merged.constitutional_analysis = c;
  if (p) merged.prediction = p;
  return merged;
}

export function hasOverride(id: string): boolean {
  return Boolean(load()[id]);
}
