// lib/predict/brier.ts
//
// Brier scoring for PREDICT (Clark §2a, principle 6). A forecast carries a probability,
// a resolution date, and a resolution criterion. When it resolves, we score it:
//   Brier = (probability - outcome)^2      (outcome ∈ {0,1}; lower is better)
// The running track record is the credibility anchor (Clark §2c rule 4).

import type { Forecast } from '../types';

export function brierScore(probability: number, outcome: boolean): number {
  const o = outcome ? 1 : 0;
  return Math.round((probability - o) ** 2 * 1000) / 1000;
}

export function resolveForecast(f: Forecast, outcome: boolean): Forecast {
  return {
    ...f,
    resolved: { outcome, brier: brierScore(f.probability, outcome), scored_at: new Date().toISOString() },
  };
}

// Mean Brier over all resolved forecasts — the calibration headline.
export function trackRecord(forecasts: Forecast[]): { resolved: number; meanBrier: number | null } {
  const scored = forecasts.filter((f) => f.resolved);
  if (scored.length === 0) return { resolved: 0, meanBrier: null };
  const mean = scored.reduce((s, f) => s + (f.resolved?.brier ?? 0), 0) / scored.length;
  return { resolved: scored.length, meanBrier: Math.round(mean * 1000) / 1000 };
}
