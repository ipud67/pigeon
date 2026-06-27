// lib/econ/plain.ts
//
// THE economics plain-language layer (Clark Deliverable-3, 2026-06-26). The economics filter
// is the surface that made the roofer quit: raw SEC 8-K / EDGAR filings, naked tickers, no
// wallet line. This module rebuilds that surface to Clark's spec so a reader with no
// high-school diploma understands every number:
//
//   1. BURY filings/auctions/micro-noise off the default econ surface (deep-search only).
//   2. SURFACE the real economy — the live Treasury "money tell", the Fed, jobs, tariffs.
//   3. PLAIN LANGUAGE — every number carries a deterministic, templated "what it means for
//      your wallet" line NOW. Terms are translated on first use. No naked tickers/acronyms/
//      filing-codes ever reach the reader view.
//
// These templates are DETERMINISTIC and must stand alone (Grok enriches them later, but the
// roofer's comprehension gate has to pass with no key). Pure functions, no node deps — safe
// to import into the client feed island.

import type { MarketIndicator, MarketIndicatorKey } from '../types';

export type EconPlain = {
  headline: string; // the plain, glossed FACT line (no naked tokens)
  wallet: string; // the "what it means for your wallet" translation
  why?: string; // optional one-line cause (Clark's "Why:" layer, top items)
};

// Structural subset of a fact record the econ layer needs — satisfied by both FactRecord and
// the slim FeedItem the client island holds, so the same templates run server- and client-side.
export type EconLike = {
  id: string;
  what: string;
  context?: string;
  sources: { outlet: string; url: string; paywalled?: boolean }[];
};

export type EconCard = {
  kind: 'market' | 'macro';
  id: string;
  plain: EconPlain;
  source?: { outlet: string; url: string; paywalled?: boolean };
  storyId?: string; // macro records deep-link to /story/[id]
};

// Display order for the econ "money tell" — most wallet-relevant first (Clark Tier A spine).
export const MARKET_ORDER: MarketIndicatorKey[] = [
  'ust_10y',
  'spread_2s10s',
  'rate_expectation',
  'sp500',
  'dow',
  'nasdaq',
  'wti_oil',
  'vix',
  'ust_2y',
  'ust_3m',
  'ust_30y',
];

// Plain-language scrub for any reader-facing FACT line. Translates the naked acronyms that
// would make the roofer quit on the home feed (the FACT line must stay accurate wire-desk, so
// this only swaps a jargon term for its plain equivalent, never adds interpretation). Grok
// refines later; this passes the comprehension gate today. Applied to home / weekly / story
// headlines.
export function plainHeadline(input: string | undefined): string {
  if (!input) return input ?? '';
  let t = input;
  // The FOMC is the Fed's rate-setting committee; write it plainly.
  t = t.replace(/\bFederal Reserve Board and (the )?Federal Open Market Committee\b/gi, 'Federal Reserve');
  t = t.replace(/\bFederal Open Market Committee\b/gi, 'Federal Reserve');
  t = t.replace(/\bFOMC\b/g, 'rate-setting');
  // CPI -> inflation, unless the sentence already says "inflation"
  if (!/inflation/i.test(t)) t = t.replace(/\bCPI\b/g, 'inflation');
  return t.replace(/\s{2,}/g, ' ').trim();
}

// A live market gauge -> a plain headline that names the number in words a roofer reads fast.
export function marketHeadline(i: MarketIndicator): string {
  const v = i.value;
  if (v == null) return i.label;
  switch (i.key) {
    case 'ust_3m':
      return `The 3-month Treasury rate is ${v}%.`;
    case 'ust_2y':
      return `The 2-year Treasury yield is ${v}%.`;
    case 'ust_10y':
      return `The 10-year Treasury yield is ${v}%.`;
    case 'ust_30y':
      return `The 30-year Treasury yield is ${v}%.`;
    case 'spread_2s10s': {
      const pts = Math.abs(v / 100).toFixed(2);
      const dir = v < 0 ? 'lower' : 'higher';
      return `The 10-year Treasury rate is about ${pts} percentage points ${dir} than the 2-year.`;
    }
    case 'sp500':
      return `The S&P 500 is at ${v}.`;
    case 'nasdaq':
      return `The Nasdaq is at ${v}.`;
    case 'dow':
      return `The Dow is at ${v}.`;
    case 'vix':
      return `The market's fear gauge is at ${v}.`;
    case 'wti_oil':
      return `US crude oil costs $${v} a barrel.`;
    case 'rate_expectation':
      return `The Fed's interest rate is ${v}%.`;
    default:
      return `${i.label}: ${v}`;
  }
}

// The wallet translation — what this number does to an ordinary person's money. Terms are
// glossed on first use; no naked acronym/ticker survives.
export function marketWallet(i: MarketIndicator): string {
  switch (i.key) {
    case 'ust_3m':
      return "What it means: that's roughly what the government pays to borrow for three months. It tracks what your savings account and short-term loans pay.";
    case 'ust_2y':
      return "What it means: that's about what it costs the government to borrow for two years. It moves with where people think interest rates are headed soon.";
    case 'ust_10y':
      return "What it means: that's about what it costs Uncle Sam to borrow for ten years, and it drags your mortgage rate along with it. Higher here usually means a pricier home loan.";
    case 'ust_30y':
      return "What it means: the government's long-term borrowing cost. It shapes 30-year mortgages and what big projects cost to finance.";
    case 'spread_2s10s':
      return "What it means: when the 10-year rate drops below the 2-year, it is the market's classic warning that a recession could be coming. The 10-year sitting higher, like now, is the normal and healthier sign.";
    case 'sp500':
      return 'What it means: the S&P 500 tracks the 500 biggest US companies. When it rises, most people’s retirement savings rise with it; when it falls, they fall.';
    case 'nasdaq':
      return 'What it means: the Nasdaq leans heavily on tech companies, so it tells you how the big tech names are doing, and how your tech-heavy savings are doing.';
    case 'dow':
      return 'What it means: the Dow tracks 30 big-name American companies. It is a quick gut-check on how the market did today.';
    case 'vix':
      return 'What it means: this gauge rises when investors get scared and falls when they are calm. A spike means the market expects a bumpy ride.';
    case 'wti_oil':
      return 'What it means: the price of crude oil flows straight to the gas pump. When this climbs, expect to pay more to fill your tank.';
    case 'rate_expectation':
      return 'What it means: this is the rate the Fed sets. It flows down to your mortgage, car loan, and credit-card bill. Higher means borrowing costs more.';
    default:
      return 'What it means: a money signal worth watching.';
  }
}

export function marketWhy(i: MarketIndicator): string | undefined {
  switch (i.key) {
    case 'ust_10y':
      return 'Why: this rate climbs when investors expect more inflation or heavier government borrowing, and eases when they expect the opposite.';
    case 'spread_2s10s':
      return 'Why: it reflects whether the market expects the Fed to keep rates high (short-term up) or cut them as growth slows (long-term down).';
    default:
      return undefined;
  }
}

export function marketPlain(i: MarketIndicator): EconPlain {
  return { headline: marketHeadline(i), wallet: marketWallet(i), why: marketWhy(i) };
}

// ---- macro fact records -> plain ------------------------------------------
// Only records we can confidently render in plain language are surfaced on the econ filter.
// Anything we cannot gloss cleanly returns null and stays buried (the safe move: the roofer
// quits on a single naked token, so we never gamble a half-translated record onto his surface).

function jobsNumbers(what: string): { jobs: string | null; ur: string | null } {
  const jobsM = what.match(/([\d][\d,]{2,})/); // first comma-grouped count: 172,000 / 50,000
  const urM = what.match(/(\d+\.\d+)\s*%|\(\s*(\d+\.\d+)\s*%\s*\)|at\s+(\d+\.\d+)/i);
  const jobs = jobsM ? jobsM[1].replace(/[,]/g, ',').replace(/^\+/, '') : null;
  const ur = urM ? urM.slice(1).find(Boolean) ?? null : null;
  return { jobs, ur };
}

export function econItemPlain(f: EconLike): EconPlain | null {
  const what = f.what;
  const outlet = f.sources[0]?.outlet ?? '';
  const t = `${f.what} ${f.context ?? ''}`;

  // The Fed — statements, projections, minutes (FOMC). Always glossed, never the bare acronym.
  if (outlet === 'Federal Reserve' && /\bfomc\b|federal open market committee|federal reserve/i.test(t)) {
    const wallet =
      'What it means: the Fed sets the interest rate that flows down to your mortgage, car loan, and credit-card bill. When it moves, your monthly payments move with it.';
    if (/minutes/i.test(what))
      return {
        headline: 'The Federal Reserve released the notes from its last interest-rate meeting.',
        wallet,
        why: 'Why: the notes hint at whether the Fed is leaning toward raising rates, cutting them, or holding steady.',
      };
    if (/projection|longer-run goals/i.test(t))
      return {
        headline: 'The Federal Reserve published its members’ own forecast for where interest rates are headed.',
        wallet,
        why: 'Why: the Fed’s own forecast is the best early read on whether your borrowing costs rise or fall next.',
      };
    return {
      headline: 'The Federal Reserve met and set its decision on interest rates.',
      wallet,
      why: 'Why: rate decisions ripple through every loan in the country within weeks.',
    };
  }

  // Jobs report (BLS) — keep the real numbers, attach the wallet meaning.
  if (outlet === 'Bureau of Labor Statistics' && /payroll|employment|unemployment/i.test(t)) {
    const { jobs, ur } = jobsNumbers(what);
    const gained = /increase|\+|add/i.test(what) || (jobs && !/lost|decline|fell/i.test(what));
    const headline =
      jobs && ur
        ? `American employers ${gained ? 'added' : 'cut'} ${jobs} jobs, and ${ur}% of people who want work still can’t find it.`
        : jobs
          ? `American employers ${gained ? 'added' : 'cut'} ${jobs} jobs last month.`
          : 'The monthly US jobs report came out.';
    return {
      headline,
      wallet:
        'What it means: more jobs makes it easier to get hired and to ask for a raise. The percentage is the share of job-seekers still looking — lower is better for workers.',
    };
  }

  // Tariffs / trade duties (White House proclamations, Federal Register duty determinations).
  if (/\btariff|countervailing dut|antidumping|section 232|section 301|import dut/i.test(t)) {
    const metals = /aluminum|steel|copper/i.test(what);
    const headline = metals
      ? 'The government raised tariffs — taxes on imports — on foreign aluminum, steel, and copper.'
      : 'The government set new tariffs — taxes on imports — on certain foreign goods.';
    return {
      headline,
      wallet:
        'What it means: a tariff is a tax on goods coming from other countries. It can protect American jobs, but it often makes those products — cars, cans, building materials — cost more at the store.',
    };
  }

  // Everything else economics-flagged but not cleanly translatable -> stays buried.
  return null;
}

// Is this an economics record we should bury off the comprehensible surface (filing/auction/
// micro-noise)? Mirrors the ranking noise caps; used to keep the econ filter clean.
export function isBuriedEconNoise(f: EconLike): boolean {
  const outlet = f.sources[0]?.outlet ?? '';
  if (outlet === 'SEC EDGAR') return true;
  if (/\b8-?K\b|\b10-?[QK]\b|\bedgar\b|\(filer\)|form\s+8-?k|filed with the sec/i.test(`${f.what} ${f.context ?? ''}`))
    return true;
  if (/treasury\s+auction|auctions?\s+\d|-week bill|-year (note|bond)|-month bill/i.test(f.what)) return true;
  return false;
}

// Build the full economics-filter surface: the live market "money tell" first (Clark Tier A),
// then the macro records we can render in plain language. Filings/auctions stay buried.
export function buildEconSurface(items: EconLike[], markets: MarketIndicator[]): EconCard[] {
  const cards: EconCard[] = [];

  // 1 — markets, fixed wallet-relevant order, live readings only.
  const live = markets.filter((m) => m.status === 'live' && m.value != null);
  const ordered = MARKET_ORDER.map((k) => live.find((m) => m.key === k)).filter(Boolean) as MarketIndicator[];
  for (const m of ordered) {
    cards.push({
      kind: 'market',
      id: `mkt-${m.key}`,
      plain: marketPlain(m),
      source: { outlet: m.source, url: TREASURY_SOURCE_URL[m.key] ?? '' },
    });
  }

  // 2 — macro econ records we can plain-ify; bury filings/auctions/anything untranslatable.
  for (const f of items) {
    if (isBuriedEconNoise(f)) continue;
    const plain = econItemPlain(f);
    if (!plain) continue;
    cards.push({
      kind: 'macro',
      id: `econ-${f.id}`,
      plain,
      storyId: f.id,
      source: f.sources[0] ? { outlet: f.sources[0].outlet, url: f.sources[0].url, paywalled: f.sources[0].paywalled } : undefined,
    });
  }

  return cards;
}

// Primary-source linkouts for the keyless Treasury gauges (the par yield curve page).
const TREASURY_SOURCE_URL: Partial<Record<MarketIndicatorKey, string>> = {
  ust_3m: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
  ust_2y: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
  ust_10y: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
  ust_30y: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
  spread_2s10s: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
};
