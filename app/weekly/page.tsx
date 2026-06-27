// app/weekly/page.tsx — the week review. Same philosophy as home (SPEC v2 §A.5 / mission
// rule 1): a MIXED, importance-ranked "what mattered this week," NOT category-bucketed. No
// section labels. Micro-noise stays buried; the mixer keeps the top from being dominated by
// one category. White-House advocacy phrasing is neutralized before render.

import Link from 'next/link';
import { readFacts, readMarketSnapshot } from '../../lib/store';
import { Masthead, Footer } from '../components';
import { rankForWeek } from '../../lib/ranking/importance';
import { neutralizeText } from '../../lib/editorial/neutralize';
import type { MarketIndicator } from '../../lib/types';

export const dynamic = 'force-static';

function fmtIndicator(i: MarketIndicator): string {
  if (i.value == null) return '—';
  if (i.unit === '%') return `${i.value}%`;
  if (i.unit === 'bps') return `${i.value > 0 ? '+' : ''}${i.value} bps`;
  if (i.unit === '$/bbl') return `$${i.value}`;
  return `${i.value}`;
}

// "Where money goes is always a big tell." Reader-facing = substance ONLY (Timn 2026-06-26):
// show the live market numbers, nothing about WHERE they come from or which API keys are
// pending. Gauges that have no real value yet are omitted (never shown as "pending key"); if
// none are live, the strip renders nothing.
function MarketsStrip() {
  const snap = readMarketSnapshot();
  if (!snap) return null;
  const live = snap.indicators.filter((i) => i.status === 'live' && i.value != null);
  if (live.length === 0) return null;
  return (
    <section className="markets-strip">
      <div className="section-kicker" style={{ paddingTop: 4 }}>
        Markets — the money tell
      </div>
      <div className="markets-grid">
        {live.map((i) => (
          <div className="mkt live" key={i.key}>
            <div className="mkt-val">{fmtIndicator(i)}</div>
            <div className="mkt-label">{i.label}</div>
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
                {f.economics_flag ? <span className="econ-tag">economics</span> : null}
              </div>
              <div className="lede">{neutralizeText(f.what) || f.what}</div>
            </Link>
          ))}
        </div>
      )}
      <Footer />
    </div>
  );
}
