// lib/store.ts
//
// The storage layer. Decision: typed JSON store, not SQLite.
//
// Why JSON over SQLite/Prisma for v1:
//  1. Vercel's serverless filesystem is read-only/ephemeral — a SQLite file written at
//     runtime does not persist and cannot be shared across lambda invocations. The clean
//     pattern is: ingestion runs locally / in CI -> writes data/facts.json -> commits it
//     -> Next.js reads it at BUILD time for static generation. The deployed preview then
//     renders real, pre-ingested data with zero runtime DB.
//  2. No native module (better-sqlite3) to compile on the Vercel builder.
//  3. Fact records are document-shaped and v1 volume is small (tens-hundreds).
//  4. This module is the single seam: swapping to Neon Postgres / Drizzle later (SPEC §6.3)
//     means reimplementing read*/write* here and nothing else changes upstream.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FactRecord, Forecast } from './types';
import { applyDepthOverride } from './depth/overrides';

const DATA_DIR = join(process.cwd(), 'data');
const FACTS_PATH = join(DATA_DIR, 'facts.json');
const PREDICT_PATH = join(DATA_DIR, 'predict.json');

function ensureDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// ---- facts -----------------------------------------------------------------

export function readFacts(): FactRecord[] {
  const facts = readJson<FactRecord[]>(FACTS_PATH, []);
  // Newest first — the reader always sees the most recent dispatch at top.
  return facts
    .slice()
    .sort((a, b) => (a.datetime_utc < b.datetime_utc ? 1 : -1));
}

export function readFactById(id: string): FactRecord | undefined {
  const fact = readFacts().find((f) => f.id === id);
  if (!fact) return undefined;
  // Merge any hand-researched depth override (data/depth-overrides.json, keyed by id). The
  // reader always sees the override when present; otherwise the ingest-produced depth
  // (rule-based constitutional analysis + placeholder/LLM short-history + prediction).
  return { ...fact, depth: applyDepthOverride(id, fact.depth) };
}

export function writeFacts(facts: FactRecord[]): void {
  ensureDir(FACTS_PATH);
  writeFileSync(FACTS_PATH, JSON.stringify(facts, null, 2) + '\n', 'utf8');
}

// ---- predict ---------------------------------------------------------------

export function readForecasts(): Forecast[] {
  return readJson<Forecast[]>(PREDICT_PATH, []);
}

export function readForecastById(id: string): Forecast | undefined {
  return readForecasts().find((f) => f.id === id);
}

export function writeForecasts(forecasts: Forecast[]): void {
  ensureDir(PREDICT_PATH);
  writeFileSync(PREDICT_PATH, JSON.stringify(forecasts, null, 2) + '\n', 'utf8');
}
