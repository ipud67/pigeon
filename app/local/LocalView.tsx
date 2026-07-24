'use client';

// app/local/LocalView.tsx — the Local surface: a search bar plus a plain newsfeed.
//
// Replaces the old index, which was a directory of the areas you had added ("San Diego County",
// "Virginia Beach"). Timn, 2026-07-24: "There should not be a list of what has been added to the
// local newsfeed … it should simply be a newsfeed of the most recent news." So the page opens on
// the news itself; choosing a place is a search, not a menu you have to read first.
//
// SEARCH IS HONEST ABOUT COVERAGE. Pigeon covers three areas today (a two-city pilot). A search
// box implies you can type any city in the country, so when a query matches nothing we say plainly
// that we don't cover it yet rather than returning a silent empty list that reads like a bug.
//
// The bar's position differs by platform on purpose: on the phone it sits at the bottom, in thumb
// reach, and hides as you read down / returns as you scroll up. On desktop it stays at the top,
// where there is no reach problem and a moving element would just be noise.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

export type LocalFeedRow = {
 title: string;
 outlet: string;
 url: string;
 date: string;
 areaName: string;
 areaSlug: string;
 state: string;
};

export type AreaOption = { slug: string; name: string; state: string; kind: string };

function fmtDate(iso: string): string {
 const d = new Date(iso);
 if (isNaN(d.getTime())) return '';
 return d
 .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
 .toUpperCase();
}

export function LocalView({ rows, areas }: { rows: LocalFeedRow[]; areas: AreaOption[] }) {
 const [q, setQ] = useState('');
 const [hidden, setHidden] = useState(false);
 const lastY = useRef(0);

 // Hide on the way down, reveal on the way up. Guarded by a small delta so a jittery finger
 // doesn't flicker the bar, and disabled near the top where there is nothing to hide from.
 useEffect(() => {
 lastY.current = window.scrollY;
 const onScroll = () => {
 const y = window.scrollY;
 const dy = y - lastY.current;
 if (Math.abs(dy) < 6) return;
 setHidden(y > 90 && dy > 0);
 lastY.current = y;
 };
 window.addEventListener('scroll', onScroll, { passive: true });
 return () => window.removeEventListener('scroll', onScroll);
 }, []);

 const query = q.trim().toLowerCase();
 const matches = useMemo(() => {
 if (!query) return [];
 return areas.filter(
 (a) => a.name.toLowerCase().includes(query) || a.state.toLowerCase().includes(query),
 );
 }, [q, areas]);

 return (
 <>
 <div className="section-kicker" style={{ paddingTop: 26 }}>
 Local
 </div>

 {/* Authored HERE, above the feed, because that is where desktop shows it. On mobile the
 bar is position:fixed to the bottom, and fixed positioning ignores DOM order — so one
 piece of markup serves both platforms with no breakpoint branch in the component. */}
 <div className={`local-search${hidden ? ' is-hidden' : ''}`} data-testid="local-search">
 <input
 type="search"
 className="ls-input"
 placeholder="Search a city, county, or state"
 aria-label="Search a city, county, or state"
 value={q}
 onChange={(e) => setQ(e.target.value)}
 />
 {q ? (
 <button type="button" className="ls-clear" onClick={() => setQ('')} aria-label="Clear search">
 &times;
 </button>
 ) : null}
 </div>

 {query ? (
 <div className="local-results" data-testid="local-results">
 {matches.length > 0 ? (
 matches.map((a) => (
 <Link href={`/local/${a.slug}`} className="local-result" key={a.slug}>
 <span className="lr-name">{a.name}</span>
 <span className="lr-meta">
 {a.kind === 'independent_city' ? 'Independent city' : 'County'} · {a.state}
 </span>
 </Link>
 ))
 ) : (
 <div className="local-empty" data-testid="local-no-coverage">
 {/* Functional empty state, kept — a silent blank list reads as a bug. Trimmed to
 the fact; the paragraph explaining our sourcing philosophy was self-narration. */}
 <strong>We don&rsquo;t cover {q.trim()} yet.</strong>
 <span>{areas.length} areas so far.</span>
 </div>
 )}
 </div>
 ) : rows.length === 0 ? (
 <div className="empty">No local dispatches in the current window.</div>
 ) : (
 <div data-testid="local-feed">
 {rows.map((r, i) => (
 <div className="dispatch" data-testid="local-row" key={r.url + i}>
 <div className="meta">
 <span>
 {r.areaName} · {fmtDate(r.date)}
 </span>
 </div>
 <a className="lede" href={r.url} target="_blank" rel="noopener noreferrer">
 {r.title}
 </a>
 <div className="sources">
 <span className="src-plain">{r.outlet}</span>
 <span className="sep"> · </span>
 <Link className="src" href={`/local/${r.areaSlug}`}>
 About {r.areaName} →
 </Link>
 </div>
 </div>
 ))}
 </div>
 )}

 </>
 );
}
