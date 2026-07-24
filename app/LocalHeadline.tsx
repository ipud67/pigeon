'use client';

// app/LocalHeadline.tsx — the "Local news" headline that sits near the top of Today (build-out C2).
//
// Client-only + localStorage. When the reader has added >=1 local area, this renders a single
// headline entry — "Local news · [area names] — N new" — linking to their own local newsfeed
// (/local/feed), with a "My local areas" cue. When NO area is added (the default reader), it
// renders NOTHING — so the base SSR Today feed is completely unchanged for anyone who hasn't
// opted in. Server + first client render return null (no hydration mismatch); the headline only
// appears after mount reads localStorage.
//
// `areas` is a slim, build-time list of EVERY known local area (slug + name + its civic-item dates)
// so the count can be computed honestly client-side; only the reader's added subset is ever shown.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getLocalAreas, newCount, subscribeLocalAreas } from './local/localStore';

export type LocalHeadlineArea = { slug: string; name: string; dates: string[] };

export function LocalHeadline({ areas }: { areas: LocalHeadlineArea[] }) {
 const [added, setAdded] = useState<string[]>([]);
 const [mounted, setMounted] = useState(false);

 useEffect(() => {
 setMounted(true);
 const sync = () => setAdded(getLocalAreas());
 sync();
 return subscribeLocalAreas(sync);
 }, []);

 if (!mounted) return null; // server + first paint: nothing (SSR Today unchanged)

 // Intersect the reader's stored slugs with the areas we actually have data for, preserving the
 // reader's add order.
 const bySlug = new Map(areas.map((a) => [a.slug, a]));
 const mine = added.map((s) => bySlug.get(s)).filter((a): a is LocalHeadlineArea => !!a);
 if (mine.length === 0) return null; // no added areas -> no headline

 const names = mine.map((a) => a.name).join(', ');
 const total = mine.reduce((sum, a) => sum + newCount(a.slug, a.dates), 0);

 return (
 <Link href="/local/feed" className="local-headline" data-testid="local-headline">
 <span className="lh-main">
 <span className="lh-kicker">Local news</span>
 <span className="lh-value">
 {names}
 {total > 0 ? <span className="lh-new"> — {total} new</span> : null}
 </span>
 </span>
 <span className="lh-manage" data-testid="local-headline-manage">
 My local areas <span aria-hidden>&rarr;</span>
 </span>
 </Link>
 );
}
