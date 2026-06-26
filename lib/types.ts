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
  resolved?: { outcome: boolean; brier: number; scored_at: string } | null;
  created_at: string;
};
