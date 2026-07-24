// app/events/page.tsx — FULL EVENTS, the standalone browsing surface (product ruling ).
//
// Newest-first list of complete event artifacts: whole press briefings, press conferences,
// hearings, and full official records. Each row: date/time UTC, place, what it is, the
// source name, and the linkout to the complete artifact — plus the story it belongs to.
// LINKOUT ONLY — we never embed or host streams ( stands). Direction B minimal: no
// infinite scroll, no thumbnails, wire-terse. Empty state is honest, never padded.

import Link from 'next/link';
import { readFacts } from '../../lib/store';
import {Footer} from '../components';
import { Flag, BottomTabs } from '../flag';
import { neutralizeText } from '../../lib/editorial/neutralize';
import { plainHeadline } from '../../lib/econ/plain';

export const dynamic = 'force-static';

export const metadata = { title: 'Full events — Pigeon' };

function fmtFull(dt: string): string {
 const d = new Date(dt);
 if (isNaN(d.getTime())) return '';
 return (
 d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) +
 ' · ' +
 d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) +
 ' UTC'
 );
}

export default function Events() {
 // readFacts() is already newest-first; keep only records tagged as complete artifacts.
 const events = readFacts().filter((f) => f.full_event);

 return (
 <div className="shell">
 <Flag activeNav="events" />
 <div className="section-kicker" style={{ paddingTop: 26 }}>
 Full events
 </div>

 {events.length === 0 ? (
 <div className="empty">No full events in the current window.</div>
 ) : (
 <div>
 {events.map((f) => {
 const fe = f.full_event!;
 return (
 <div className="event-row" data-testid="event-row" key={f.id}>
 <div className="meta">
 <span>
 {f.place} · {fmtFull(f.datetime_utc)}
 </span>
 </div>
 <a className="event-title" href={fe.url} target="_blank" rel="noopener noreferrer">
 {plainHeadline(neutralizeText(f.what) || f.what)} <span className="ext">↗</span>
 </a>
 <div className="event-sub">
 <span className="event-kind">{fe.label}</span>
 <span className="event-outlet">· {fe.outlet}</span>
 {fe.paywalled ? <span className="paywall">paywall</span> : null}
 <Link href={`/story/${f.id}`} className="event-story">
 Story →
 </Link>
 </div>
 </div>
 );
 })}
 </div>
 )}
 <Footer />
 <BottomTabs activeNav="events" />
 </div>
 );
}
