'use client';

// app/MoreSheet.tsx — the mobile "More" tab and the sheet it opens.
//
// Until 2026-07-24 "More" was not a menu at all: it was a plain link straight to Full Events,
// so the label promised a drawer that did not exist. It is now a real sheet, and the category
// filters moved into it — they used to sit as a swipe strip directly under the masthead, eating
// roughly 70px above the first headline on the one screen where the ruling is to maximise the
// feed. Filters are an occasional action; headlines are the point of the page.
//
// Desktop is untouched: the chip row still sits inline on the front page, where there is room.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CATEGORIES, TOP_FILTER } from './components';
import { getFilter, setFilter, subscribeFilter, type ActiveFilter } from './filterStore';
import { addPick } from './personalize/profileStore';
import type { Category } from '../lib/types';

// Labels only. The descriptive second lines ("What mattered since you last looked", etc.) were
// the same self-narrating copy Timn struck from the pages, so they go too.
const LINKS = [
 { href: '/events', label: 'Full events' },
 { href: '/weekly', label: 'This Week in 5 Minutes' },
 { href: '/local', label: 'Local' },
 { href: '/profile', label: 'Your profile' },
];

export function MoreSheet({ active }: { active?: boolean }) {
 const [open, setOpen] = useState(false);
 const [filter, setLocalFilter] = useState<ActiveFilter>(TOP_FILTER);
 const router = useRouter();
 const pathname = usePathname();

 useEffect(() => {
 setLocalFilter(getFilter());
 return subscribeFilter(() => setLocalFilter(getFilter()));
 }, []);

 // ?more=1 opens the sheet on load. It exists so the sheet can be SHOWN — in the review
 // mockup, in a screenshot, in a bug report — without someone having to tap it first. Read
 // once on mount rather than via useSearchParams so the static export needs no Suspense
 // boundary, and read from window so nothing runs on the server.
 useEffect(() => {
 try {
 if (new URLSearchParams(window.location.search).get('more') === '1') setOpen(true);
 } catch {
 /* no-op */
 }
 }, []);

 // Close on route change — otherwise the sheet stays open over the page you just navigated to.
 // Skips the first run: this effect fires on mount too, and on mount there is nothing to close
 // — it was overwriting the ?more=1 open above, which runs earlier in the same commit.
 const mounted = useRef(false);
 useEffect(() => {
 if (!mounted.current) {
 mounted.current = true;
 return;
 }
 setOpen(false);
 }, [pathname]);

 // A sheet that traps you is a bug. Escape closes it, and the body stops scrolling behind it.
 useEffect(() => {
 if (!open) return;
 const onKey = (e: KeyboardEvent) => {
 if (e.key === 'Escape') setOpen(false);
 };
 window.addEventListener('keydown', onKey);
 const prev = document.body.style.overflow;
 document.body.style.overflow = 'hidden';
 return () => {
 window.removeEventListener('keydown', onKey);
 document.body.style.overflow = prev;
 };
 }, [open]);

 function pick(id: ActiveFilter) {
 setFilter(id);
 if (id !== TOP_FILTER) addPick(id as Category);
 setOpen(false);
 // The filter only means something on the front page, so send them there if they aren't.
 if (pathname !== '/') router.push('/');
 }

 return (
 <>
 <button
 type="button"
 className={`tab tab-more${active ? ' tab-active' : ''}`}
 aria-expanded={open}
 aria-haspopup="dialog"
 onClick={() => setOpen((v) => !v)}
 >
 More
 </button>

 {open ? (
 <>
 <div className="sheet-scrim" onClick={() => setOpen(false)} aria-hidden />
 <div className="sheet" role="dialog" aria-modal="true" aria-label="More">
 <div className="sheet-grip" aria-hidden />

 <div className="sheet-label">Filters</div>
 <div className="sheet-chips">
 {CATEGORIES.map((c) => (
 <button
 key={c.id}
 type="button"
 className={`chip${filter === c.id ? ' active' : ''}`}
 onClick={() => pick(c.id)}
 >
 {c.label}
 </button>
 ))}
 </div>

 <div className="sheet-label">Go to</div>
 <ul className="sheet-links">
 {LINKS.map((l) => (
 <li key={l.href}>
 <Link href={l.href} className="sheet-link" onClick={() => setOpen(false)}>
 <span className="sl-t">{l.label}</span>
 </Link>
 </li>
 ))}
 </ul>

 <button type="button" className="sheet-close" onClick={() => setOpen(false)}>
 Close
 </button>
 </div>
 </>
 ) : null}
 </>
 );
}
