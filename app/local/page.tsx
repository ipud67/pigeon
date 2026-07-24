// app/local/page.tsx — Local: a search bar plus a plain newsfeed of the most recent local news.
//
// Was a directory of covered areas. Timn ruled 2026-07-24 that the added-areas list comes out and
// the page opens on the news itself; picking a place is a search. Server side just bakes every
// covered area's real civic headlines into one newest-first list — the client component owns the
// search, the honest no-coverage state, and the scroll-aware bar.

import { Footer } from '../components';
import { Flag, BottomTabs } from '../flag';
import { listLocalCivicSummaries } from '../../lib/local';
import { LocalView, type LocalFeedRow, type AreaOption } from './LocalView';

export const dynamic = 'force-static';

export const metadata = { title: 'Local — Pigeon' };

export default function LocalIndex() {
 const summaries = listLocalCivicSummaries();

 const areas: AreaOption[] = summaries.map((a) => ({
 slug: a.slug,
 name: a.name,
 state: a.state,
 kind: a.kind,
 }));

 const rows: LocalFeedRow[] = summaries
 .flatMap((a) =>
 a.items.map((it) => ({
 title: it.title,
 outlet: it.outlet,
 url: it.url,
 date: it.date,
 areaName: a.name,
 areaSlug: a.slug,
 state: a.state,
 })),
 )
 // newest first across every covered area — one feed, not one list per place
 .sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime());

 return (
 <div className="shell">
 <Flag activeNav="local" />
 <LocalView rows={rows} areas={areas} />
 <Footer />
 <BottomTabs activeNav="local" />
 </div>
 );
}
