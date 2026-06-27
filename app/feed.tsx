'use client';

// app/feed.tsx — the mixed, importance-ranked home feed as a client island.
//
// SPEC v2 §A + §C. The DEFAULT view is "Top Stories": a mixed, importance-ranked stream
// across ALL categories (the ranking engine buries micro-noise like SEC 8-K filings and
// diversifies the top so no category dominates). Category chips are OPT-IN filters, never
// the default.
//
// ECONOMICS FILTER (Clark Deliverable-3): the economics chip no longer dumps raw 8-K / EDGAR
// filings. It renders the comprehensible "money tell" surface — live Treasury gauges + the
// Fed / jobs / tariffs, each with a deterministic plain-English wallet line. Filings/auctions
// are buried (deep-search only). The roofer reads the plain line and stays.
//
// SOURCES (Beck): every dispatch's sources are REAL clickable <a href> primary links now —
// the footer's "every claim links to its primary source" is true on the home feed, not just
// the story page.
//
// NO user-facing category labels on the default stream (mission rule 3): the inline "economics"
// tag is gone from the home item rows; category lives only in the opt-in filter chips.

import { useState } from 'react';
import Link from 'next/link';
import type { Category, MarketIndicator } from '../lib/types';
import type { SourceTier } from '../lib/llm/provider';
import type { FactRecord } from '../lib/types';
import { CATEGORIES, TOP_FILTER } from './components';
import { rankForHome } from '../lib/ranking/importance';
import { neutralizeText } from '../lib/editorial/neutralize';
import { buildEconSurface, plainHeadline, type EconCard } from '../lib/econ/plain';

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
  sources: { outlet: string; url: string; tier: SourceTier; paywalled?: boolean }[];
};

function fmtTime(dt: string): string {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  return (
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) +
    ' UTC'
  );
}

// Host label for a primary-source link — what the reader sees on the chip.
function SourceLinks({ sources }: { sources: FeedItem['sources'] }) {
  const shown = sources.slice(0, 4).filter((s) => s.url);
  if (shown.length === 0) return null;
  return (
    <div className="sources" data-testid="sources">
      {shown.map((s, i) => (
        <span key={s.url + i}>
          {i > 0 ? <span className="sep"> · </span> : null}
          <a
            className="src"
            data-testid="source-link"
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            // tap the source, not the card: don't bubble into the card's expand toggle
            onClick={(e) => e.stopPropagation()}
          >
            {s.outlet}
          </a>
          {s.paywalled ? <span className="paywall"> ↗ paywall</span> : null}
        </span>
      ))}
    </div>
  );
}

function DispatchCard({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const headline = plainHeadline(neutralizeText(item.what) || item.what);
  const context = neutralizeText(item.context || item.deck);

  return (
    <div className={`dispatch${open ? ' open' : ''}`} data-testid="dispatch" data-category={item.category}>
      <button
        type="button"
        className="dispatch-head"
        data-testid="dispatch-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="meta">
          <span>
            {item.place} · {fmtTime(item.datetime_utc)}
          </span>
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
            {context && context !== headline
              ? context
              : 'Open the full record for the context, short history, constitutional analysis, and forecast.'}
          </div>
          <div className="drop-cta">Read the full long-form →</div>
        </Link>
      ) : null}

      <SourceLinks sources={item.sources} />
    </div>
  );
}

// The economics-filter card — a plain, glossed headline + the wallet translation. Every number
// the reader sees is paired with its "what it means" line in the SAME block (the roofer never
// hits a naked number). Sources are real primary links; macro records deep-link to the long form.
function EconDispatchCard({ card }: { card: EconCard }) {
  return (
    <div className="dispatch econ-card" data-testid="dispatch" data-category="economics" data-econ-kind={card.kind}>
      <div className="lede">{card.plain.headline}</div>
      <div className="econ-plain" data-testid="econ-plain">
        {card.plain.wallet}
      </div>
      {card.plain.why ? (
        <div className="econ-why" data-testid="econ-why">
          {card.plain.why}
        </div>
      ) : null}
      <div className="sources" data-testid="sources">
        {card.source?.url ? (
          <a
            className="src"
            data-testid="source-link"
            href={card.source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {card.source.outlet}
          </a>
        ) : card.source ? (
          <span className="src-plain">{card.source.outlet}</span>
        ) : null}
        {card.storyId ? (
          <>
            <span className="sep"> · </span>
            <Link className="src" href={`/story/${card.storyId}`}>
              Full record →
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function Feed({ items, markets }: { items: FeedItem[]; markets: MarketIndicator[] }) {
  const [active, setActive] = useState<Category | typeof TOP_FILTER>(TOP_FILTER);

  const isEcon = active === 'economics';
  const shown: FeedItem[] =
    active === TOP_FILTER
      ? (rankForHome(items as unknown as FactRecord[]) as unknown as FeedItem[]).slice(0, 40)
      : isEcon
        ? []
        : (items.filter((f) => f.category === active) as FeedItem[]).slice(0, 40);

  const econCards: EconCard[] = isEcon ? buildEconSurface(items, markets) : [];

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
        {active === TOP_FILTER
          ? 'What mattered today'
          : isEcon
            ? 'The economy, in plain English'
            : `${CATEGORIES.find((c) => c.id === active)?.label} — filtered`}
      </div>

      {isEcon ? (
        econCards.length === 0 ? (
          <div className="empty">No economic readings available right now.</div>
        ) : (
          <div>
            {econCards.map((c) => (
              <EconDispatchCard key={c.id} card={c} />
            ))}
          </div>
        )
      ) : shown.length === 0 ? (
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
          : isEcon
            ? 'That’s the money picture in plain terms. Switch back to Top Stories for the mixed big picture.'
            : 'Every record in this filter. Switch back to Top Stories for the mixed big picture.'}
      </div>
    </>
  );
}
