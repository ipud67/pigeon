// app/weekly/page.tsx — the week review. Same philosophy as home (SPEC v2 §A.5 / mission
// rule 1): a MIXED, importance-ranked "what mattered this week," NOT category-bucketed. No
// section labels. Micro-noise stays buried; the mixer keeps the top from being dominated by
// one category. White-House advocacy phrasing is neutralized before render.

import Link from 'next/link';
import { readFacts } from '../../lib/store';
import { Masthead, Footer } from '../components';
import { rankForWeek } from '../../lib/ranking/importance';
import { neutralizeText } from '../../lib/editorial/neutralize';

export const dynamic = 'force-static';

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
