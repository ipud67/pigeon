// app/page.tsx — the 5-minute reader. The DEFAULT home is the mixed, importance-ranked
// "Top Stories" stream (spec §A): top stories across ALL categories, micro-noise buried,
// the top diversified so no category dominates. NO category section labels on the landing.
//
// Ranking + the tap-to-expand interaction run in the <Feed> client island; the server just
// passes a slim projection of every fact (the island ranks + filters in the browser, which
// keeps it static-export-safe).

import { readFacts, readMarketSnapshot } from '../lib/store';
import { listLocalCivicSummaries } from '../lib/local';
import {Footer} from './components';
import { Flag, BottomTabs } from './flag';
import { Feed, type FeedItem } from './feed';
import { LocalHeadline, type LocalHeadlineArea } from './LocalHeadline';

export const dynamic = 'force-static';

export default function Home() {
 const facts = readFacts();
 // Build-out C2: slim per-area civic dates for the client "Local news" headline. Baked at build;
 // the headline only renders client-side when the reader has added >=1 area (localStorage).
 const localAreas: LocalHeadlineArea[] = listLocalCivicSummaries().map((a) => ({
 slug: a.slug,
 name: a.name,
 dates: a.items.map((it) => it.date),
 }));
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
 // Beck: carry the real primary-source URL through to the card so sources render as clickable
 // <a href> links, not dead <span>s.
 sources: f.sources.map((s) => ({ outlet: s.outlet, url: s.url, tier: s.tier, paywalled: s.paywalled })),
 }));
 const markets = readMarketSnapshot()?.indicators ?? [];

 return (
 <div className="shell">
 <Flag activeNav="today" />
 <LocalHeadline areas={localAreas} />
 <Feed items={items} markets={markets} />
 <Footer />
 <BottomTabs activeNav="today" />
 </div>
 );
}
