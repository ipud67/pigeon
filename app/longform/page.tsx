// app/longform/page.tsx — full press events / briefings / streamed addresses, linkout-only.
// SPEC §5.4: chronological, linkout-only v1 (no hosting/embedding — IP risk).

import Link from 'next/link';
import { readFacts } from '../../lib/store';
import { Masthead, Footer } from '../components';

export const dynamic = 'force-static';

export default function Longform() {
  const items = readFacts().filter((f) => f.longform_url || f.quote);

  return (
    <div className="shell">
      <Masthead activeNav="longform" />
      <div className="section-kicker" style={{ paddingTop: 26 }}>
        Long-form
      </div>
      <p className="empty" style={{ paddingTop: 0, paddingBottom: 16 }}>
        Full press events and addresses — the un-edited source, linkout only.
      </p>

      {items.length === 0 ? (
        <div className="empty">No long-form events in the current window.</div>
      ) : (
        <div>
          {items.map((f) => (
            <Link key={f.id} href={`/story/${f.id}`} className="dispatch">
              <div className="meta">
                <span>{f.place}</span>
              </div>
              <div className="lede">{f.what}</div>
              {f.quote ? <div className="deck">&ldquo;{f.quote}&rdquo;</div> : null}
              <div className="sources">
                {f.longform_url ? <span className="src">Full event available →</span> : <span>Statement record</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
      <Footer />
    </div>
  );
}
