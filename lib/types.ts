// lib/types.ts
//
// The fact record is the first-class entity of Pigeon. Everything the reader sees is a
// projection of one. Schema follows the brief + SPEC_v1 §6.5 + the v2 three-layer model
// (FACT -> CONTEXT -> WEIGH-IT). Economics is a first-class flag/lens per v2, not a category.

import type { SourceTier } from './llm/provider';

export type Category =
  | 'war' // armed conflict, troop movement, strikes, defense posture
  | 'government' // executive orders, agency rules, briefings, legislation
  | 'economics' // rates, markets, trade, sanctions, fiscal/monetary, corporate filings
  | 'courts' // rulings, opinions, legal action
  | 'world' // diplomacy, treaties, balance-of-power, multilateral bodies
  | 'health' // public-health declarations, agency health action
  | 'other';

export type FactSource = {
  outlet: string; // e.g. "Federal Register", "AP", "SEC EDGAR"
  url: string; // primary-source linkout
  tier: SourceTier; // T1_wire | T1_gov | T2_indie | T3_factslice
  paywalled?: boolean; // flag per red line: never hide a paywalled "full source"
};

// A single WEIGH-IT prompt line: a labeled, tenet-anchored QUESTION. Never a conclusion.
export type WeighItQuestion = {
  tenet: string; // short tenet id, e.g. "foreign-restraint"
  question: string; // the interrogative prompt
  anchor: string; // the primary-document citation (e.g. "Washington, Farewell Address 1796")
};

// ---- DEPTH layers (SPEC v2 §B/§D) ------------------------------------------
// Every headline IS its own long form. These three depth fields are first-class on the
// fact record. They require LLM generation grounded in the real fact (the Grok path); the
// mock adapter never fabricates them — it leaves them undefined and the renderer shows a
// clearly-labeled placeholder. A hand-researched data/depth-overrides.json entry (Clark)
// supersedes whatever ingest produced.

// CONSTITUTIONAL ANALYSIS — the facts contrasted against the founding framework. Evolved
// from WEIGH-IT (questions-only) to a substantive, cited, two-sided within-bounds-or-not
// contrast. Still primary-source-anchored; still avoids a partisan verdict (calibration
// pending Timn's relevance chat).
export type ConstitutionalContrast = {
  tenet: string; // the tenet id this contrast turns on
  label: string; // human label of the tenet
  question: string; // the framing question (interrogative, retained from WEIGH-IT)
  within_bounds: string; // the case that the action sits inside constitutional limits
  beyond_bounds: string; // the case that it reaches past them
  anchor: string; // primary-document citation(s)
};

export type ConstitutionalAnalysis = {
  source: 'rule-based' | 'llm' | 'override' | 'placeholder';
  // DIRECTIONAL framing (Timn 2026-06-26 LOCKED): the founding standard IS the measure. This
  // lead names the founding ideal(s) at stake and states the yardstick before the contrast.
  framing?: string;
  contrasts: ConstitutionalContrast[]; // one block per firing tenet (rule-based mode)
  prose?: string; // override / LLM mode: a researched founding-standard prose block
  note?: string; // a labeled placeholder line when no substantive analysis is present
};

// SHORT HISTORY — when this thing began and why. Needs real-world facts -> LLM/override.
export type ShortHistory = {
  source: 'llm' | 'override' | 'placeholder';
  text: string; // the narrative, or a clearly-labeled placeholder
};

// PREDICTIVE MODEL — per-story forecast: how long / where next, indicator-based, neutral,
// falsifiable. Needs real-world facts -> LLM/override. The value lens is BANNED here.
export type PredictiveModel = {
  source: 'llm' | 'override' | 'placeholder';
  forecast: string; // the neutral forecast, or a clearly-labeled placeholder
  horizon?: string; // e.g. "3-6 months"
  indicators?: string[]; // the observable tells that would move it
};

export type FactDepth = {
  short_history?: ShortHistory;
  constitutional_analysis?: ConstitutionalAnalysis;
  prediction?: PredictiveModel;
};

export type FactRecord = {
  id: string; // stable hash id
  datetime_utc: string; // ISO 8601, the event/publication time
  place: string; // dateline place, uppercase short form (e.g. "WASHINGTON")
  what: string; // the FACT line — neutral who/what/when/where, one sentence
  deck?: string; // 1-2 sentence factual narrative lead (home-feed summary; mechanical/definitional only)
  quote?: string; // for statements: the exact attributed quote
  context?: string; // CONTEXT layer — neutral factual background / balance-of-power stakes
  sources: FactSource[]; // primary-source linkouts (one event, N outlets -> one record)
  category: Category;
  economics_flag: boolean; // economics standing lens — money movement present
  weigh_it_questions: WeighItQuestion[]; // rule-based, may be empty when no tenet maps
  // DEPTH (SPEC v2 §B): every headline IS its long form. Constitutional analysis is
  // rule-based (cited, deterministic) and present now; short_history + prediction need the
  // Grok path and are placeholders under mock (never fabricated). data/depth-overrides.json
  // supersedes any of these per fact id.
  depth?: FactDepth;
  // IMPORTANCE (SPEC v2 §A): 0-100 score + tier set by the ranking engine at ingest. The
  // home/week feeds rank by this and bury micro-noise (8-K etc.).
  importance?: number; // 0-100
  importance_tier?: 'HIGH' | 'MED' | 'LOW' | 'BURIED';
  longform_url?: string; // optional full press-event / stream linkout
  // provenance / audit
  classifier_kind: string; // the editorial-gate classification that admitted this record
  classifier_confidence: number;
  ingested_at: string; // ISO 8601
};

// What ingestion produces before the editorial gate + enrichment runs.
export type RawItem = {
  outlet: string;
  tier: SourceTier;
  url: string;
  title: string;
  body: string; // abstract / summary / extracted text used for classification + context
  datetime_utc: string;
  place?: string;
  quote?: string;
  longform_url?: string;
  paywalled?: boolean;
};

// ---- MARKETS (v2 scope expansion, Timn 2026-06-26) -------------------------
// "Where money goes is always a big tell." The economics standing lens was missing Wall
// Street entirely — no yields, indices, VIX, or oil. The MarketSnapshot is the structured
// market signal the PREDICTIVE MODEL ingests: named, falsifiable gauges with a value when a
// source is live, or null + a "pending key" note when the gauge is behind FRED/Finnhub keys
// (inert until FRED_API_KEY / FINNHUB_API_KEY are present — same graceful pattern as Grok).

export type MarketIndicatorKey =
  | 'ust_2y'
  | 'ust_10y'
  | 'ust_30y'
  | 'ust_3m'
  | 'spread_2s10s'
  | 'sp500'
  | 'nasdaq'
  | 'dow'
  | 'vix'
  | 'wti_oil'
  | 'rate_expectation';

export type MarketIndicator = {
  key: MarketIndicatorKey;
  label: string; // human label, e.g. "10-yr Treasury yield"
  value: number | null; // the reading; null when the source is key-gated and inert
  unit: string; // "%", "bps", "index", "$/bbl", "prob"
  as_of: string | null; // ISO date of the reading
  source: string; // "U.S. Treasury", "FRED", "Finnhub", "CME FedWatch"
  status: 'live' | 'pending_key'; // live keyless reading vs inert-awaiting-key
  note?: string; // the falsifiable tell, e.g. "inversion (2s10s < 0) flags recession risk"
};

export type MarketSnapshot = {
  as_of: string; // ISO timestamp the snapshot was built
  indicators: MarketIndicator[];
  sources_live: string[]; // which market sources produced a reading this build
  sources_pending_key: string[]; // which are wired but inert (no env key)
};

// ---- PREDICT (P1) ----------------------------------------------------------

export type IndicatorCategory =
  | 'statements_signaling'
  | 'diplomatic_protocol'
  | 'military_movements'
  | 'economic_trade'
  | 'domestic_political'
  | 'base_rate_history';

export type Indicator = {
  category: IndicatorCategory;
  text: string;
  direction: 'up' | 'down' | 'neutral'; // raises / lowers / ambiguous on the probability
  source?: string; // ties to an observable FACT-track item where possible
};

export type Forecast = {
  id: string;
  thread: string; // e.g. "NK alignment drift: China vs Russia"
  question: string; // falsifiable, with embedded resolution criterion
  resolution_date: string; // ISO date — when this gets scored
  resolution_criterion: string;
  base_rate: string; // outside-view anchor, stated first
  probability: number; // 0..1, the adjusted estimate
  confidence_band: string; // honest uncertainty, e.g. "55-70%"
  indicators: Indicator[];
  watch_items: string[]; // the 2-3 indicators that would most move it
  economics_note?: string; // economics is a first-look tell on every thread (v2)
  market_inputs?: MarketIndicator[]; // live market gauges the model ingests (v2 scope expansion)
  resolved?: { outcome: boolean; brier: number; scored_at: string } | null;
  created_at: string;
};
