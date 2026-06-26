'use client';

// app/feed.tsx — the curated feed as a client island.
//
// Curation is PRIORITY, not filter (SPEC §5.3) and must work under full static export, so
// it runs in the browser: the server passes the facts; the chip selection re-orders them
// in place (selected category floats up; the rest stay below). No navigation, instant,
// and no dependency on request-time searchParams (which a force-static page cannot read).

import { useState } from 'react';
import type { FactRecord, Category } from '../lib/types';
import { Dispatch, CATEGORIES } from './components';

export function Feed({ facts }: { facts: FactRecord[] }) {
  const [active, setActive] = useState<Category | 'all'>('all');

  const prioritized =
    active === 'all'
      ? facts
      : [...facts.filter((f) => f.category === active), ...facts.filter((f) => f.category !== active)];

  const shown = prioritized.slice(0, 40);

  return (
    <>
      <div className="curate">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip${active === c.id ? ' active' : ''}`}
            onClick={() => setActive(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="feed-label">Today&rsquo;s dispatches</div>

      {shown.length === 0 ? (
        <div className="empty">No dispatches in this slice.</div>
      ) : (
        <div>
          {shown.map((f) => (
            <Dispatch key={f.id} fact={f} />
          ))}
        </div>
      )}

      <div className="terminator">
        <strong>You&rsquo;re caught up.</strong>
        <br />
        That&rsquo;s every fact that mattered. No opinion. No gossip.
      </div>
    </>
  );
}
