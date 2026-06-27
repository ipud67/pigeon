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

// "Where money goes is always a big tell." The live market gauges the PREDICTIVE MODEL ingests
// (v2 scope expansion). Keyless Treasury yields render live now; FRED/Finnhub gauges show
// "pending key" until FRED_API_KEY / FINNHUB_API_KEY are provisioned — honest, never hidden.
function MarketsStrip() {
  const snap = readMarketSnapshot();
  if (!snap) return null;
  return (
    <section className="markets-strip">
      <div className="section-kicker" style={{ paddingTop: 4 }}>
        Markets — the money tell
      </div>
      <div className="markets-grid">
        {snap.indicators.map((i) => (
          <div className={`mkt ${i.status}`} key={i.key}>
            <div className="mkt-val">{fmtIndicator(i)}</div>
            <div className="mkt-label">{i.label}</div>
            {i.status === 'pending_key' ? <div className="mkt-pending">pending key</div> : null}
          </div>
        ))}
      </div>
      <div className="markets-note">
        Live gauges feed the per-story predictive model. Live now: {snap.sources_live.join(', ') || 'none'}.
        {snap.sources_pending_key.length
          ? ` Inert until keyed: ${snap.sources_pending_key.join(', ')} (FRED_API_KEY / FINNHUB_API_KEY).`
          : ''}
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
