// app/page.tsx — the 5-minute reader. Today's dispatches, newest first.
//
// No woven-prose briefing here — Timn rejected the single-digest home (D6); the home is
// the per-story feed, each with its own 1-2 sentence factual deck. Curation runs in the
// <Feed> client island (priority, not filter — SPEC §5.3).

import { readFacts } from '../lib/store';
import { Masthead, Footer } from './components';
import { Feed } from './feed';

export const dynamic = 'force-static';

export default function Home() {
  const facts = readFacts();
  // Pass a generous window (covers every category for client-side prioritization).
  const window = facts.slice(0, 80);

  return (
    <div className="shell">
      <Masthead count={facts.length} activeNav="today" />
      <Feed facts={window} />
      <Footer />
    </div>
  );
}
