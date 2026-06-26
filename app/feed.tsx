'use client';

// app/feed.tsx — the mixed, importance-ranked home feed as a client island.
//
// SPEC v2 §A + §C. The DEFAULT view is "Top Stories": a mixed, importance-ranked stream
// across ALL categories (the ranking engine buries micro-noise like SEC 8-K filings and
// diversifies the top so no category dominates). Category chips are OPT-IN filters, never
// the default — the Economics filter is the path to the buried micro-noise.
//
// Interaction (§C): tap a headline once -> an inline dropdown shows the CONTEXT blurb. Tap
// that dropdown -> navigate to the full long form. Runs in the browser so it works under
// full static export and needs no request-time state.

import { useState } from 'react';
import Link from 'next/link';
import type { Category } from '../lib/types';
import type { SourceTier } from '../lib/llm/provider';
import type { FactRecord } from '../lib/types';
import { CATEGORIES, TOP_FILTER } from './components';
import { rankForHome, filterByCategory } from '../lib/ranking/importance';
import { neutralizeText } from '../lib/editorial/neutralize';

// Slim projection passed from the server page — enough for ranking + the card, no depth.
export type FeedItem = {
  id: string;
  datetime_utc: string;
  place: string;
  what: string;
  deck?: string;
  quote?: string;
  context?: string;
  category: Category;
  economics_flag: boolean;
  sources: { outlet: string; tier: SourceTier }[];
};

function fmtTime(dt: string): string {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  return (
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) +
    ' UTC'
  );
}

function DispatchCard({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const headline = neutralizeText(item.what) || item.what;
  const context = neutralizeText(item.context || item.deck) ;

  return (
    <div className={`dispatch${open ? ' open' : ''}`}>
      <button type="button" className="dispatch-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <div className="meta">
          <span>
            {item.place} · {fmtTime(item.datetime_utc)}
          </span>
          {item.economics_flag ? <span className="econ-tag">economics</span> : null}
          <span className="chevron" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        </div>
        {item.quote ? (
          <>
            <div className="lede">{headline}</div>
            <div className="quote">&ldquo;{neutralizeText(item.quote) || item.quote}&rdquo;</div>
          </>
        ) : (
          <div className="lede">{headline}</div>
        )}
      </button>

      {open ? (
        <Link href={`/story/${item.id}`} className="dispatch-drop">
          <div className="drop-label">Context</div>
          <div className="drop-body">
            {context && context !== headline ? context : 'Open the full record for the context, short history, constitutional analysis, and forecast.'}
          </div>
          <div className="drop-cta">Read the full long-form →</div>
        </Link>
      ) : null}

      <div className="sources">
        {item.sources.slice(0, 4).map((s, i) => (
          <span key={s.outlet + i}>
            {i > 0 ? <span className="sep"> · </span> : null}
            <span className="src">{s.outlet}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Feed({ items }: { items: FeedItem[] }) {
  const [active, setActive] = useState<Category | typeof TOP_FILTER>(TOP_FILTER);

  const shown: FeedItem[] =
    active === TOP_FILTER
      ? (rankForHome(items as unknown as FactRecord[]) as unknown as FeedItem[]).slice(0, 40)
      : filterByCategory(items as unknown as FactRecord[], active).slice(0, 40) as unknown as FeedItem[];

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

      <div className="feed-label">
        {active === TOP_FILTER ? 'What mattered today' : `${CATEGORIES.find((c) => c.id === active)?.label} — filtered`}
      </div>

      {shown.length === 0 ? (
        <div className="empty">No dispatches in this slice.</div>
      ) : (
        <div>
          {shown.map((f) => (
            <DispatchCard key={f.id} item={f} />
          ))}
        </div>
      )}

      <div className="terminator">
        <strong>You&rsquo;re caught up.</strong>
        <br />
        {active === TOP_FILTER
          ? 'That’s the big picture. No opinion. No gossip. Filter by category above to go deeper.'
          : 'Every record in this filter. Switch back to Top Stories for the mixed big picture.'}
      </div>
    </>
  );
}
