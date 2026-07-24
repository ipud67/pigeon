'use client';

// app/feed.tsx — the mixed, importance-ranked home feed as a client island.
//
// spec §A + §C. The DEFAULT view is "Top Stories": a mixed, importance-ranked stream
// across ALL categories (the ranking engine buries micro-noise like SEC 8-K filings and
// diversifies the top so no category dominates). Category chips are OPT-IN filters, never
// the default.
//
// ECONOMICS FILTER (Research Deliverable-3): the economics chip no longer dumps raw 8-K / EDGAR
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

import { useEffect, useLayoutEffect, useState } from 'react';
import Link from 'next/link';
import type { Category, MarketIndicator } from '../lib/types';
import type { SourceTier } from '../lib/llm/provider';
import type { FactRecord } from '../lib/types';
import { CATEGORIES, TOP_FILTER } from './components';
import { rankForHome, RUNDOWN_SIZE } from '../lib/ranking/importance';
import { rankForReaderDetailed } from '../lib/ranking/personalize';
import { getProfile, markSeen, markVisited, addPick } from './personalize/profileStore';
import { getFilter, setFilter, subscribeFilter } from './filterStore';
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
 // De-duplicate by OUTLET, not just by url. When one action is announced three ways by the
 // same publisher, clustering keeps all three links and the card rendered
 // "White House · White House · White House" — three identical-looking chips that tell the
 // reader nothing and read as a bug. One chip per outlet, first link wins.
 const seen = new Set<string>();
 const shown = sources
 .filter((s) => s.url)
 .filter((s) => {
 const key = (s.outlet || s.url).toLowerCase();
 if (seen.has(key)) return false;
 seen.add(key);
 return true;
 })
 .slice(0, 4);
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

// ---- the front page: LEAD + RUNDOWN ---------------------------------------
//
// The lead story, set the way a broadsheet sets its lead: kicker, then the headline at display
// size, then the opening of the report. Same three-tier interaction as every other card —
// headline, tap for context, tap the context for the full page — so the lead is not a
// different behaviour, only a different weight.
//
// Until 2026-07-22 every headline on this page rendered at identical size. The ordering was
// correct and invisible: nothing on the page said which story mattered most.
function LeadStory({ item }: { item: FeedItem }) {
 const [open, setOpen] = useState(false);
 const headline = plainHeadline(neutralizeText(item.what) || item.what);
 const context = neutralizeText(item.context || item.deck);

 return (
 <article className="lead" data-testid="lead-story" data-category={item.category}>
 <div className="lead-kicker">
 {item.place} · {fmtTime(item.datetime_utc)}
 </div>
 <button
 type="button"
 className="lead-head"
 data-testid="lead-head"
 aria-expanded={open}
 onClick={() => setOpen((v) => !v)}
 >
 <h1 className="lead-hed">{headline}</h1>
 </button>
 {item.quote ? <div className="lead-quote">&ldquo;{neutralizeText(item.quote) || item.quote}&rdquo;</div> : null}
 {open ? (
 <Link href={`/story/${item.id}`} className="lead-drop" data-testid="lead-drop">
 <div className="drop-label">Context</div>
 <div className="drop-body">
 {context && context !== headline
 ? context
 : 'Open the full record for the context, short history, constitutional analysis, and forecast.'}
 </div>
 <div className="drop-cta">Read the full report →</div>
 </Link>
 ) : (
 <div className="lead-teaser">{context && context !== headline ? context : null}</div>
 )}
 <SourceLinks sources={item.sources} />
 </article>
 );
}

// The ranked rail beside the lead. Numbered on purpose: the numbers are the ranking made
// visible, which is the whole point of a scoreboard the reader can see the output of.
//
// Numbering starts at 1 (Timn, 2026-07-24). The rail is its own ranked list, not a
// continuation of the lead's rank — the lead carries no numeral at all, so there is no
// competing "#1" on the page.
function Rundown({ items }: { items: FeedItem[] }) {
 if (items.length === 0) return null;
 return (
 <aside className="rundown" data-testid="rundown" aria-label="The rundown">
 <div className="rail-label">The Rundown</div>
 <ol className="rail-list">
 {items.map((f, i) => (
 <li key={f.id} className="rail-item">
 <span className="rail-num" aria-hidden>
 {i + 1}
 </span>
 <Link href={`/story/${f.id}`} className="rail-link">
 <span className="rail-kicker">{f.place}</span>
 <span className="rail-hed">{plainHeadline(neutralizeText(f.what) || f.what)}</span>
 </Link>
 </li>
 ))}
 </ol>
 </aside>
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

// How many stories the home stream actually renders. Named because it is load-bearing in TWO
// places that must agree: what we show, and what we record as seen. They disagreed until
// 2026-07-23 and the disagreement silently demoted stories the reader never laid eyes on.
const FEED_LEN = 40;

// useLayoutEffect runs BEFORE the browser paints; useEffect runs after. That difference is the
// whole fix for the reorder flash, so this must not silently degrade to useEffect in the browser.
// On the server there is no paint and React warns if useLayoutEffect is called, so the static
// export (which prerenders at build time) takes useEffect and the browser takes useLayoutEffect.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function Feed({ items, markets }: { items: FeedItem[]; markets: MarketIndicator[] }) {
 // The filter lives in a shared store, not local state: on mobile it is set from the bottom
 // bar's "More" sheet, which is a sibling of this component rather than a child.
 const [active, setActiveState] = useState<Category | typeof TOP_FILTER>(TOP_FILTER);
 useEffect(() => {
 setActiveState(getFilter());
 return subscribeFilter(() => setActiveState(getFilter()));
 }, []);
 const setActive = setFilter;

 // PERSONALIZATION (Ranking Model v1). SSR + first client paint keep the universal editorial
 // order (rankForHome) — no profile read before mount ⇒ no hydration mismatch, no-JS static export
 // unchanged. AFTER mount we read the reader profile and reorder/cut per reader with rankForReader.
 const [readerOrder, setReaderOrder] = useState<FeedItem[] | null>(null);
 const [kickerCount, setKickerCount] = useState(0); // honest "since your last visit" count (lapsed only)

 useIsomorphicLayoutEffect(() => {
 // read-then-write: read the PRIOR visit into the ranking call, THEN write now as the new visit.
 const profile = getProfile();
 const now = Date.now();
 const ranking = rankForReaderDetailed(items as unknown as FactRecord[], profile, now);
 const order = ranking.order as unknown as FeedItem[];
 setReaderOrder(order);
 // honest kicker: ONLY for a lapsed reader, ONLY from the real unseen-HIGH-in-window count.
 setKickerCount(ranking.lapsed ? ranking.unseenHighInWindow : 0);
 // Record ONLY what the reader was actually shown. This marked the ENTIRE ranked list until
 // 2026-07-23 — 164 ids on a page that renders 40 — so ~124 stories per visit were stamped
 // "seen" without ever being rendered. Consequence: they lost their new-since-your-last-visit
 // boost and became ineligible for the reader's lead slot, which is the opposite of what the
 // store's own contract says ("a story is seen once it has been RENDERED").
 markSeen(order.slice(0, FEED_LEN).map((f) => f.id));
 markVisited(new Date(now).toISOString());
 // Release the pre-paint hold armed by the bootstrap in app/layout.tsx. Runs before paint, so
 // the reader sees exactly one feed order — theirs.
 if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-personalizing');
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const isEcon = active === 'economics';
 // Top Stories: universal order on the server + first paint; personalized order once mounted.
 const topOrder: FeedItem[] =
 readerOrder ?? (rankForHome(items as unknown as FactRecord[]) as unknown as FeedItem[]);
 const shown: FeedItem[] =
 active === TOP_FILTER
 ? topOrder.slice(0, FEED_LEN)
 : isEcon
 ? []
 : (items.filter((f) => f.category === active) as FeedItem[]).slice(0, FEED_LEN);

 // Tapping a category chip ALSO records it as an explicit pick (v1 heuristic per spec §4.5:
 // "picks = the set of categories the reader has filtered to at least once"). The filter remains
 // the primary action; the pick is a silent side effect — least-intrusive, no new UI surface.
 const selectFilter = (id: Category | typeof TOP_FILTER) => {
 setActive(id);
 if (id !== TOP_FILTER) addPick(id);
 };

 const econCards: EconCard[] = isEcon ? buildEconSurface(items, markets) : [];

 return (
 <>
 <div className="curate">
 {CATEGORIES.map((c) => (
 <button
 key={c.id}
 type="button"
 className={`chip${active === c.id ? ' active' : ''}`}
 onClick={() => selectFilter(c.id)}
 >
 {c.label}
 </button>
 ))}
 </div>

 {active === TOP_FILTER && kickerCount > 0 ? (
 <div className="since-last" data-testid="since-last">
 <span className="sl-kicker">Since your last visit</span>
 <span className="sl-value">
 {kickerCount} major {kickerCount === 1 ? 'story' : 'stories'} you haven&rsquo;t seen
 </span>
 </div>
 ) : null}

 <div className="feed-label">
 {active === TOP_FILTER
 ? 'Today in 5 minutes'
 : isEcon
 ? 'The economy, in plain English'
 : `${CATEGORIES.find((c) => c.id === active)?.label} — filtered`}
 </div>

 {/* feed-body is the hold target for the reorder-flash fix (app/layout.tsx bootstrap + the
 layout effect above). Wrapping ONLY the story list means the flag, the nav, the chips and
 the section label stay visible throughout — the page never looks broken or empty, it just
 doesn't show a story order it is about to replace. */}
 <div className="feed-body">
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
 ) : active === TOP_FILTER ? (
 // FRONT PAGE: one lead, a ranked rail beside it, the rest of the paper beneath.
 // Only on Top Stories — a category filter is a list, not a front page.
 <>
 <div className="frontpage">
 <LeadStory item={shown[0]} />
 <Rundown items={shown.slice(1, 1 + RUNDOWN_SIZE)} />
 </div>
 <div className="below-fold">
 {shown.slice(1 + RUNDOWN_SIZE).map((f) => (
 <DispatchCard key={f.id} item={f} />
 ))}
 </div>
 </>
 ) : (
 <div>
 {shown.map((f) => (
 <DispatchCard key={f.id} item={f} />
 ))}
 </div>
 )}
 </div>

 {/* Terminator is the end-of-feed signal and nothing else. The explanatory second line
 ("That's the big picture. No opinion. No gossip…") went with the rest of the page
 blurbs — the product should not narrate itself to the reader. */}
 <div className="terminator">
 <strong>You&rsquo;re caught up.</strong>
 </div>
 </>
 );
}
