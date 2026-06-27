// lib/ingestion/markets.ts
//
// MARKET SNAPSHOT builder (v2 scope expansion, Timn 2026-06-26). Closes the named Wall Street
// gap: the economics lens + PREDICTIVE MODEL had no market signal. This produces a structured
// MarketSnapshot of named, falsifiable gauges (yields, 2s10s, indices, VIX, oil, rate odds).
//
// RED LINE (unchanged): free / free-tier only; NO paid call. Keyless gauges are LIVE now
// (U.S. Treasury daily par yield curve — yields + the 2s10s spread). Key-gated gauges are
// IMPLEMENTED but INERT until env keys are present — the SAME graceful pattern as Grok:
//   - FRED_API_KEY    -> S&P 500, Nasdaq, VIX, WTI oil, Fed funds (FRED, free key, 120/min)
//   - FINNHUB_API_KEY -> live index quotes (Finnhub, free key, 60/min)
// Without a key the gauge is emitted with value:null and status:'pending_key' — never fetched,
// never charged. The snapshot always carries the full indicator set so the model + the UI can
// render "pending key" honestly rather than hide the gap.

import { XMLParser } from 'fast-xml-parser';
import type { MarketIndicator, MarketSnapshot } from '../types';
import { UA } from './http';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['#text'] !== 'undefined') return String(o['#text']);
  }
  return String(v);
}
function num(v: unknown): number | null {
  const n = Number(textOf(v));
  return Number.isFinite(n) ? n : null;
}

// ---- keyless: U.S. Treasury daily par yield curve (OData XML) ----------------
type Yields = { as_of: string | null; y2: number | null; y10: number | null; y30: number | null; m3: number | null };

async function treasuryYieldCurve(): Promise<Yields> {
  const empty: Yields = { as_of: null, y2: null, y10: null, y30: null, m3: null };
  const now = new Date();
  // Try the current month; fall back to last month near a month boundary / data lag.
  const months = [now, new Date(now.getFullYear(), now.getMonth() - 1, 1)];
  for (const d of months) {
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml, */*' } });
      if (!res.ok) continue;
      const doc = xml.parse(await res.text()) as Record<string, unknown>;
      const feed = doc.feed as Record<string, unknown> | undefined;
      const entries = feed?.entry;
      const arr = Array.isArray(entries) ? entries : entries ? [entries] : [];
      let best: Yields | null = null;
      for (const e of arr) {
        const props = ((e as Record<string, unknown>).content as Record<string, unknown> | undefined)?.[
          'm:properties'
        ] as Record<string, unknown> | undefined;
        if (!props) continue;
        const date = textOf(props['d:NEW_DATE']).slice(0, 10);
        const row: Yields = {
          as_of: date || null,
          y2: num(props['d:BC_2YEAR']),
          y10: num(props['d:BC_10YEAR']),
          y30: num(props['d:BC_30YEAR']),
          m3: num(props['d:BC_3MONTH']),
        };
        // keep the entry with the latest date that actually carries a 10y reading
        if (row.y10 != null && (!best || (row.as_of ?? '') > (best.as_of ?? ''))) best = row;
      }
      if (best) return best;
    } catch {
      // try next month / degrade
    }
  }
  return empty;
}

// ---- key-gated: FRED (free key, inert without FRED_API_KEY) ------------------
async function fredLatest(seriesId: string): Promise<{ value: number | null; as_of: string | null }> {
  const key = process.env.FRED_API_KEY ?? '';
  if (!key) return { value: null, as_of: null }; // INERT — no key, no call (RED LINE)
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return { value: null, as_of: null };
    const data = (await res.json()) as { observations?: Array<{ date?: string; value?: string }> };
    const o = data.observations?.[0];
    const v = o && o.value && o.value !== '.' ? Number(o.value) : NaN;
    return { value: Number.isFinite(v) ? v : null, as_of: o?.date ?? null };
  } catch {
    return { value: null, as_of: null };
  }
}

// ---- key-gated: Finnhub index quote (free key, inert without FINNHUB_API_KEY) -
async function finnhubQuote(symbol: string): Promise<{ value: number | null; as_of: string | null }> {
  const key = process.env.FINNHUB_API_KEY ?? '';
  if (!key) return { value: null, as_of: null }; // INERT — no key, no call (RED LINE)
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return { value: null, as_of: null };
    const q = (await res.json()) as { c?: number; t?: number };
    return {
      value: typeof q.c === 'number' && q.c > 0 ? q.c : null,
      as_of: q.t ? new Date(q.t * 1000).toISOString().slice(0, 10) : null,
    };
  } catch {
    return { value: null, as_of: null };
  }
}

const hasFred = () => Boolean(process.env.FRED_API_KEY);
const hasFinnhub = () => Boolean(process.env.FINNHUB_API_KEY);

export async function buildMarketSnapshot(): Promise<MarketSnapshot> {
  const y = await treasuryYieldCurve();

  // FRED-backed gauges (inert -> null + pending_key when no key)
  const [sp, nasdaq, vix, oil, ff] = await Promise.all([
    fredLatest('SP500'),
    fredLatest('NASDAQCOM'),
    fredLatest('VIXCLS'),
    fredLatest('DCOILWTICO'),
    fredLatest('FEDFUNDS'),
  ]);
  // Finnhub Dow proxy (DIA ETF) — inert without key
  const dow = await finnhubQuote('DIA');

  const fredStatus = hasFred() ? ('live' as const) : ('pending_key' as const);
  const finnhubStatus = hasFinnhub() ? ('live' as const) : ('pending_key' as const);

  const spread = y.y10 != null && y.y2 != null ? Math.round((y.y10 - y.y2) * 100) : null; // bps

  const indicators: MarketIndicator[] = [
    { key: 'ust_3m', label: '3-mo Treasury bill', value: y.m3, unit: '%', as_of: y.as_of, source: 'U.S. Treasury', status: 'live' },
    { key: 'ust_2y', label: '2-yr Treasury yield', value: y.y2, unit: '%', as_of: y.as_of, source: 'U.S. Treasury', status: 'live' },
    { key: 'ust_10y', label: '10-yr Treasury yield', value: y.y10, unit: '%', as_of: y.as_of, source: 'U.S. Treasury', status: 'live' },
    { key: 'ust_30y', label: '30-yr Treasury yield', value: y.y30, unit: '%', as_of: y.as_of, source: 'U.S. Treasury', status: 'live' },
    {
      key: 'spread_2s10s',
      label: '2s10s spread',
      value: spread,
      unit: 'bps',
      as_of: y.as_of,
      source: 'U.S. Treasury',
      status: 'live',
      note: 'inversion (2s10s below zero) is the market’s classic recession tell',
    },
    { key: 'sp500', label: 'S&P 500', value: sp.value, unit: 'index', as_of: sp.as_of, source: 'FRED', status: sp.value != null ? 'live' : fredStatus, note: 'broad risk appetite' },
    { key: 'nasdaq', label: 'Nasdaq Composite', value: nasdaq.value, unit: 'index', as_of: nasdaq.as_of, source: 'FRED', status: nasdaq.value != null ? 'live' : fredStatus },
    { key: 'dow', label: 'Dow (DIA proxy)', value: dow.value, unit: 'index', as_of: dow.as_of, source: 'Finnhub', status: dow.value != null ? 'live' : finnhubStatus },
    { key: 'vix', label: 'VIX (volatility)', value: vix.value, unit: 'index', as_of: vix.as_of, source: 'FRED', status: vix.value != null ? 'live' : fredStatus, note: 'spikes flag market stress on war / shock stories' },
    { key: 'wti_oil', label: 'WTI crude oil', value: oil.value, unit: '$/bbl', as_of: oil.as_of, source: 'FRED', status: oil.value != null ? 'live' : fredStatus, note: 'moves on war / sanctions / supply shocks' },
    { key: 'rate_expectation', label: 'Fed funds rate', value: ff.value, unit: '%', as_of: ff.as_of, source: 'FRED', status: ff.value != null ? 'live' : fredStatus, note: 'pairs with CME FedWatch implied-odds for the rate path' },
  ];

  const sources_live = Array.from(
    new Set(indicators.filter((i) => i.status === 'live').map((i) => i.source)),
  );
  const sources_pending_key = Array.from(
    new Set(indicators.filter((i) => i.status === 'pending_key').map((i) => i.source)),
  );

  return { as_of: new Date().toISOString(), indicators, sources_live, sources_pending_key };
}
