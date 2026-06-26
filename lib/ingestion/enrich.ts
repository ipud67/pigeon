// lib/ingestion/enrich.ts
//
// Deterministic enrichment of a raw/admitted item into the structured fields a FactRecord
// needs: category, the economics standing-lens flag, a dateline place, and a short factual
// deck. All rule-based — no LLM, no opinion, only definitional/structural transforms.

import type { Category } from '../types';

const CATEGORY_RULES: Array<{ category: Category; kw: RegExp }> = [
  {
    category: 'war',
    kw: /\b(war|troops?|deploy|military|missile|strike|airstrike|naval|invasion|ceasefire|combat|armed forces|defense department|pentagon|nato|warfare|offensive)\b/i,
  },
  {
    category: 'economics',
    kw: /\b(tariff|inflation|interest rate|rate decision|fomc|monetary|treasury|sec |edgar|8-k|earnings|capex|gdp|unemployment|jobs report|cpi|ppi|trade|sanction|bond|yield|currency|capital|fiscal|budget deficit|debt|economic|market)\b/i,
  },
  {
    category: 'courts',
    kw: /\b(supreme court|court|ruling|opinion|justices?|verdict|sentenced|appeal|litigation|lawsuit|judicial|judge)\b/i,
  },
  {
    category: 'world',
    kw: /\b(united nations|security council|treaty|summit|diplomatic|ambassador|bilateral|foreign minister|alliance|accord|sanctions?|geopolit)\b/i,
  },
  {
    category: 'government',
    kw: /\b(executive order|presidential action|federal register|agency|regulation|rule|congress|senate|legislation|department of|commission|white house|administration|directive)\b/i,
  },
  {
    category: 'health',
    kw: /\b(who|world health|outbreak|emergency|disease|pandemic|vaccine|public health|cdc|mpox|epidemic)\b/i,
  },
];

export function categorize(text: string): Category {
  for (const rule of CATEGORY_RULES) {
    if (rule.kw.test(text)) return rule.category;
  }
  return 'other';
}

// Economics standing lens (v2): "where money goes is always a big tell." Flag any item
// touching money movement, regardless of its primary category. Economics-primary outlets
// (Fed, Treasury, SEC, BLS) flag true by provenance even if the title is terse.
const ECON_KW =
  /\b(tariff|inflation|interest rate|rate|fomc|monetary|treasury|securities|edgar|8-k|earnings|capex|gdp|unemployment|jobs|cpi|ppi|trade|sanction|sanctions|bond|yield|currency|capital|fiscal|budget|deficit|debt|economic|market|de-dollar|reserve|commodity|energy price|oil|export|import|tax)\b/i;

const ECON_PRIMARY_OUTLETS = new Set([
  'Federal Reserve',
  'U.S. Treasury',
  'SEC EDGAR',
  'Bureau of Labor Statistics',
]);

export function economicsFlag(text: string, outlet: string): boolean {
  return ECON_PRIMARY_OUTLETS.has(outlet) || ECON_KW.test(text);
}

// Dateline place. Prefer an explicit place; else infer from outlet; else a sane default.
const OUTLET_PLACE: Record<string, string> = {
  'Federal Register': 'WASHINGTON',
  'White House': 'WASHINGTON',
  'Federal Reserve': 'WASHINGTON',
  'U.S. Treasury': 'WASHINGTON',
  'SEC EDGAR': 'WASHINGTON',
  'Bureau of Labor Statistics': 'WASHINGTON',
  'U.S. Dept. of Defense': 'WASHINGTON',
  'Supreme Court (CourtListener)': 'WASHINGTON',
  'UN Press': 'NEW YORK',
  'UK Hansard': 'LONDON',
  GDELT: 'GLOBAL',
};

export function derivePlace(explicit: string | undefined, outlet: string): string {
  if (explicit && explicit.trim()) return explicit.trim().toUpperCase();
  return OUTLET_PLACE[outlet] ?? 'WORLD';
}

// A short, factual deck (home-feed narrative lead). Mechanical only: type + source +
// date framing. Never interpretive. Trims a source summary to one clean sentence.
export function buildDeck(args: {
  title: string;
  summary: string;
  outlet: string;
  datetime_utc: string;
}): string {
  const clean = args.summary.replace(/\s+/g, ' ').trim();
  if (clean && clean.toLowerCase() !== args.title.toLowerCase()) {
    // first sentence, capped
    const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
    const deck = firstSentence.length > 220 ? firstSentence.slice(0, 217).trimEnd() + '…' : firstSentence;
    return deck;
  }
  const d = new Date(args.datetime_utc);
  const date = isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${args.outlet}${date ? ` · ${date}` : ''}.`;
}
