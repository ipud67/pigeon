// app/weekly/page.tsx — the week review. Same philosophy as home (SPEC v2 §A.5 / mission
// rule 1): a MIXED, importance-ranked "what mattered this week," NOT category-bucketed. No
// section labels. Micro-noise stays buried; the mixer keeps the top from being dominated by
// one category. White-House advocacy phrasing is neutralized before render.

import Link from 'next/link';
import { readFacts, readMarketSnapshot } from '../../lib/store';
import { Masthead, Footer } from '../components';
import { rankForWeek } from '../../lib/ranking/importance';
import { neutralizeText } from '../../lib/editorial/neutralize';
import { marketWallet, plainHeadline, MARKET_ORDER } from '../../lib/econ/plain';
import type { MarketIndicator } from '../../lib/types';

export const dynamic = 'force-static';

function fmtIndicator(i: MarketIndicator): string {
  if (i.value == null) return '—';
  if (i.unit === '%') return `${i.value}%`;
  // No naked "bps"/"2s10s" jargon on the reader strip — show the gap in plain percentage points.
  if (i.unit === 'bps') return `${i.value > 0 ? '+' : ''}${(i.value / 100).toFixed(2)} pts`;
  if (i.unit === '$/bbl') return `$${i.value}`;
  return `${i.value}`;
}

// Plain reader label — keep the compact strip free of trader shorthand.
function plainLabel(i: MarketIndicator): string {
  if (i.key === 'spread_2s10s') return '10-year vs 2-year gap';
  return i.label;
}

// "Where money goes is always a big tell." Reader-facing = substance ONLY (Timn 2026-06-26):
// show the live market numbers, nothing about WHERE they come from or which API keys are
// pending. Gauges that have no real value yet are omitted (never shown as "pending key"); if
// none are live, the strip renders nothing.
function MarketsStrip() {
  const snap = readMarketSnapshot();
  if (!snap) return null;
  const liveSet = snap.indicators.filter((i) => i.status === 'live' && i.value != null);
  if (liveSet.length === 0) return null;
  // Wallet-relevant order; anything not in the order list trails after.
  const order = (k: MarketIndicator['key']) => {
    const idx = MARKET_ORDER.indexOf(k);
    return idx === -1 ? 99 : idx;
  };
  const live = liveSet.slice().sort((a, b) => order(a.key) - order(b.key));
  return (
    <section className="markets-strip">
      <div className="section-kicker" style={{ paddingTop: 4 }}>
        Markets — the money tell
      </div>
      <div className="markets-grid">
        {live.map((i) => (
          <div className="mkt live" key={i.key}>
            <div className="mkt-val">{fmtIndicator(i)}</div>
            <div className="mkt-label">{plainLabel(i)}</div>
            {/* Roofer: no naked index value — every number carries its plain meaning. */}
            <div className="mkt-plain" data-testid="mkt-plain">
              {marketWallet(i).replace(/^What it means:\s*/i, '')}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function fmtTime(dt: string): string {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  return (
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) +
    ' UTC'
  );
}

export default function Weekly() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const week = readFacts().filter((f) => {
    const t = new Date(f.datetime_utc).getTime();
    return isNaN(t) ? true : t >= cutoff;
  });
  const ranked = rankForWeek(week).slice(0, 30);

  return (
    <div className="shell">
      <Masthead activeNav="weekly" />
      <div className="section-kicker" style={{ paddingTop: 26 }}>
        This Week
      </div>
      <p className="empty" style={{ paddingTop: 0, paddingBottom: 8 }}>
        What mattered this week — ranked by importance, mixed across everything. A five-minute read.
      </p>

      <MarketsStrip />

      {ranked.length === 0 ? (
        <div className="empty">Nothing in the last 7 days yet.</div>
      ) : (
        <div>
          {ranked.map((f) => (
            <Link href={`/story/${f.id}`} className="dispatch week-dispatch" key={f.id}>
              <div className="meta">
                <span>
                  {f.place} · {fmtTime(f.datetime_utc)}
                </span>
              </div>
              <div className="lede">{plainHeadline(neutralizeText(f.what) || f.what)}</div>
            </Link>
          ))}
        </div>
      )}
      <Footer />
    </div>
  );
}
