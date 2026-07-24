// app/local/feed/page.tsx — the reader's OWN local newsfeed (build-out C2).
//
// Static-export server page: it bakes EVERY known local area's civic-news items (from the same
// data/local/*.json the area pages read) into the page, then a client island filters to just the
// areas the reader added (localStorage) and renders them newest-first, labeled by area. The page
// also hosts the "My local areas" manager (remove controls). With no area added it shows an honest
// prompt to browse and add areas — never an empty or fabricated feed.

import {Footer} from '../../components';
import { Flag, BottomTabs } from '../../flag';
import { listLocalCivicSummaries } from '../../../lib/local';
import { LocalFeedView } from './LocalFeedView';

export const dynamic = 'force-static';

export const metadata = { title: 'My local news — Pigeon' };

export default function LocalFeedPage() {
 const areas = listLocalCivicSummaries();
 return (
 <div className="shell">
 <Flag activeNav="local" />
 <LocalFeedView areas={areas} />
 <Footer />
 <BottomTabs activeNav="local" />
 </div>
 );
}
