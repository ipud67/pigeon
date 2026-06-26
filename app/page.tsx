// app/page.tsx — the 5-minute reader. The DEFAULT home is the mixed, importance-ranked
// "Top Stories" stream (SPEC v2 §A): top stories across ALL categories, micro-noise buried,
// the top diversified so no category dominates. NO category section labels on the landing.
//
// Ranking + the tap-to-expand interaction run in the <Feed> client island; the server just
// passes a slim projection of every fact (the island ranks + filters in the browser, which
// keeps it static-export-safe).

import { readFacts } from '../lib/store';
import { Masthead, Footer } from './components';
import { Feed, type FeedItem } from './feed';

export const dynamic = 'force-static';

export default function Home() {
  const facts = readFacts();
  const items: FeedItem[] = facts.map((f) => ({
    id: f.id,
    datetime_utc: f.datetime_utc,
    place: f.place,
    what: f.what,
    deck: f.deck,
    quote: f.quote,
    context: f.context,
    category: f.category,
    economics_flag: f.economics_flag,
    sources: f.sources.map((s) => ({ outlet: s.outlet, tier: s.tier })),
  }));

  return (
    <div className="shell">
      <Masthead count={facts.length} activeNav="today" />
      <Feed items={items} />
      <Footer />
    </div>
  );
}
