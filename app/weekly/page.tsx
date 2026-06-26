// app/weekly/page.tsx — the weekly digest. "5 min once a week" reader (v2 D16).
// What mattered this week + how to weigh it. Weighted: war/government/economics/courts/world
// lead; grouped by category; each item links to its three-layer record.

import Link from 'next/link';
import { readFacts } from '../../lib/store';
import { Masthead, Footer } from '../components';
import type { Category, FactRecord } from '../../lib/types';

export const dynamic = 'force-static';

const WEIGHT: Record<Category, number> = {
  war: 6,
  government: 5,
  economics: 5,
  world: 4,
  courts: 4,
  health: 2,
  other: 1,
};

const GROUP_ORDER: { id: Category; label: string }[] = [
  { id: 'war', label: 'War & Defense' },
  { id: 'world', label: 'World & Balance of Power' },
  { id: 'government', label: 'Government Action' },
  { id: 'economics', label: 'Economics — Where the Money Moved' },
  { id: 'courts', label: 'Courts' },
  { id: 'health', label: 'Public Health' },
];

export default function Weekly() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const week = readFacts().filter((f) => {
    const t = new Date(f.datetime_utc).getTime();
    return isNaN(t) ? true : t >= cutoff;
  });

  const groups = GROUP_ORDER.map((g) => ({
    ...g,
    items: week
      .filter((f) => f.category === g.id)
      .sort((a, b) => WEIGHT[b.category] - WEIGHT[a.category])
      .slice(0, 5),
  })).filter((g) => g.items.length > 0);

  const weighItCount = week.filter((f) => f.weigh_it_questions.length > 0).length;

  return (
    <div className="shell">
      <Masthead activeNav="weekly" />
      <div className="section-kicker" style={{ paddingTop: 26 }}>
        This Week
      </div>
      <p className="empty" style={{ paddingTop: 0, paddingBottom: 8 }}>
        What mattered this week, weighted — and questions to weigh it by. A five-minute read.
        <br />
        {week.length} facts · {weighItCount} carry a Weigh-It prompt.
      </p>

      {groups.length === 0 ? (
        <div className="empty">Nothing in the last 7 days yet.</div>
      ) : (
        groups.map((g) => (
          <section key={g.id} style={{ marginTop: 18 }}>
            <div className="narr">
              <div className="sec-label">{g.label}</div>
              <div>
                {g.items.map((f: FactRecord) => (
                  <div className="week-item" key={f.id}>
                    <div className="w-cat">
                      {f.place}
                      {f.economics_flag ? ' · economics' : ''}
                    </div>
                    <div className="w-what">
                      <Link href={`/story/${f.id}`}>{f.what}</Link>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ))
      )}
      <Footer />
    </div>
  );
}
