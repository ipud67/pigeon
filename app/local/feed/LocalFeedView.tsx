'use client';

// app/local/feed/LocalFeedView.tsx — the client view of the reader's local newsfeed + area manager.
//
// Reads the reader's added-area slugs from localStorage and, from the baked per-area civic items,
// renders one aggregated list (newest-first, each row labeled by its area) plus the "My local areas"
// manager (chips + remove). Honest states throughout: no areas added -> a prompt to browse/add;
// an added area with no civic news this week -> a plain "no civic news" line for that area, never a
// fabricated item. Marks the shown areas as "seen" on mount so the Today headline's "N new" is
// honest.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { LocalNewsItem } from '../../../lib/local';
import {
 getLocalAreas,
 markSeen,
 removeLocalArea,
 subscribeLocalAreas,
} from '../localStore';

export type LocalFeedArea = {
 slug: string;
 name: string;
 state: string;
 items: LocalNewsItem[];
};

type Row = LocalNewsItem & { areaSlug: string; areaName: string };

function fmtDate(dt: string): string {
 const d = new Date(dt);
 if (isNaN(d.getTime())) return '';
 return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function LocalFeedView({ areas }: { areas: LocalFeedArea[] }) {
 const [added, setAdded] = useState<string[]>([]);
 const [mounted, setMounted] = useState(false);

 useEffect(() => {
 setMounted(true);
 const sync = () => setAdded(getLocalAreas());
 sync();
 return subscribeLocalAreas(sync);
 }, []);

 const bySlug = useMemo(() => new Map(areas.map((a) => [a.slug, a])), [areas]);

 // The reader's added areas that we actually have data for, in add order.
 const mine = useMemo(
 () => added.map((s) => bySlug.get(s)).filter((a): a is LocalFeedArea => !!a),
 [added, bySlug],
 );

 // Mark the added areas seen once they're shown, so Today's "N new" resets honestly.
 useEffect(() => {
 if (mounted && mine.length > 0) markSeen(mine.map((a) => a.slug));
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [mounted, mine.map((a) => a.slug).join(',')]);

 // Aggregate every added area's civic items into one newest-first list, tagged by area.
 const rows: Row[] = useMemo(() => {
 const all: Row[] = [];
 for (const a of mine) {
 for (const it of a.items) all.push({ ...it, areaSlug: a.slug, areaName: a.name });
 }
 all.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
 return all;
 }, [mine]);

 // Added areas that produced no civic news this week — surfaced honestly, per area.
 const emptyAreas = useMemo(() => mine.filter((a) => a.items.length === 0), [mine]);

 return (
 <>
 <div className="back-bar">
 <Link href="/">
 <span className="arrow">&larr;</span> Today
 </Link>
 </div>

 <div className="section-kicker" style={{ paddingTop: 22 }}>
 My local news
 </div>

 {/* MY LOCAL AREAS — the manager (chips + remove). Present whenever the reader has areas. */}
 {mounted && mine.length > 0 ? (
 <div className="local-areas-manager" data-testid="local-areas-manager">
 {mine.map((a) => (
 <span className="area-chip" data-testid="area-chip" key={a.slug}>
 <Link href={`/local/${a.slug}`} className="area-chip-name">
 {a.name}
 </Link>
 <button
 type="button"
 className="area-chip-remove"
 data-testid="area-chip-remove"
 aria-label={`Remove ${a.name} from my feed`}
 onClick={() => removeLocalArea(a.slug)}
 >
 &times;
 </button>
 </span>
 ))}
 <Link href="/local" className="area-chip area-chip-add" data-testid="area-chip-add">
 + Add an area
 </Link>
 </div>
 ) : null}

 {/* THE AGGREGATED FEED, or honest empty-states. */}
 {!mounted ? (
 // Server + first paint: a neutral placeholder (replaced on mount). Keeps SSR valid without
 // asserting any state.
 <p className="empty" style={{ paddingTop: 0 }} data-testid="local-feed-loading">
 Loading your local areas&hellip;
 </p>
 ) : mine.length === 0 ? (
 <div className="local-feed-empty" data-testid="local-feed-empty">
 <p className="empty" style={{ paddingTop: 0 }}>
 You haven&rsquo;t added any local areas yet. Open an area and choose
 &ldquo;+ Add to my feed&rdquo; to build your own local newsfeed here.
 </p>
 <Link href="/local" className="local-feed-browse" data-testid="local-feed-browse">
 Browse local areas <span aria-hidden>&rarr;</span>
 </Link>
 </div>
 ) : (
 <>
 {rows.length > 0 ? (
 <div className="local-news" data-testid="local-feed">
 {rows.map((r) => (
 <div className="local-news-row" data-testid="local-feed-row" key={r.areaSlug + r.url}>
 <div className="lnr-date">
 {fmtDate(r.date)} · <span className="lnr-area" data-testid="local-feed-area">{r.areaName}</span>
 </div>
 <a className="lnr-title" href={r.url} target="_blank" rel="noopener noreferrer">
 {r.title} <span className="ext">&#8599;</span>
 </a>
 <div className="lnr-outlet">
 {r.outlet}
 {r.scope === 'state' ? ' · statewide' : ''}
 </div>
 </div>
 ))}
 </div>
 ) : (
 <p className="empty" style={{ paddingTop: 0 }} data-testid="local-feed-none">
 No civic news from your areas this week. Check back — the local feeds refresh weekly.
 </p>
 )}

 {emptyAreas.length > 0 ? (
 <div className="local-feed-notes" data-testid="local-feed-notes">
 {emptyAreas.map((a) => (
 <div className="lfn-row" key={a.slug}>
 No civic news from <strong>{a.name}</strong> this week.
 </div>
 ))}
 </div>
 ) : null}
 </>
 )}
 </>
 );
}
