'use client';

// app/profile/page.tsx — the reader's profile/account entry point.
//
// Added 2026-07-24 (Timn: "there is no 'profile' button on the home page, users need to be
// able to access their profile/account"). Pigeon has NO account backend yet — personalization
// is 100% anonymous, client-side localStorage (; see app/personalize/profileStore.ts). Signup
// + the paid tier are a later backend build. So this page is honest about what exists
// today (the reader's local reading profile, editable) and what's coming (sign-in), rather than
// faking an account system.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Category } from '../../lib/types';
import { Footer } from '../components';
import { Flag, BottomTabs } from '../flag';
import { CATEGORIES } from '../components';
import { getPicks, removePick, getSeenIds, subscribeProfile } from '../personalize/profileStore';
import { getLocalAreas } from '../local/localStore';
import { ThemeToggle } from '../theme-toggle';

export default function ProfilePage() {
 const [picks, setPicks] = useState<Category[]>([]);
 const [seenCount, setSeenCount] = useState(0);
 const [localAreas, setLocalAreas] = useState<string[]>([]);

 useEffect(() => {
 const refresh = () => {
 setPicks(getPicks());
 setSeenCount(getSeenIds().length);
 setLocalAreas(getLocalAreas());
 };
 refresh();
 return subscribeProfile(refresh);
 }, []);

 const pickLabels = picks.map((id) => CATEGORIES.find((c) => c.id === id)?.label ?? id);

 return (
 <div className="shell">
 <Flag activeNav="today" />

 <div className="section-kicker" style={{ paddingTop: 26 }}>
 Your profile
 </div>

 <div className="profile-section">
 <div className="profile-section-label">Account</div>
 {/* Kept, trimmed to one line: this is a functional state, not a page blurb. A disabled
 "Sign in" with no explanation is worse than a short one. */}
 <p className="empty" style={{ paddingTop: 0, paddingBottom: 8 }}>
 No accounts yet — everything below lives only in this browser.
 </p>
 <button type="button" className="profile-btn" disabled aria-disabled="true">
 Sign in — coming soon
 </button>
 </div>

 <div className="profile-section">
 <div className="profile-section-label">Reading profile</div>
 <p className="empty" style={{ paddingTop: 0, paddingBottom: 8 }}>
 {seenCount > 0
 ? `You've been shown ${seenCount} stor${seenCount === 1 ? 'y' : 'ies'} on this device.`
 : "You haven't read anything on this device yet."}
 </p>
 <div className="profile-row">
 <span className="profile-row-label">Theme</span>
 <ThemeToggle />
 </div>
 </div>

 <div className="profile-section">
 <div className="profile-section-label">Category picks</div>
 {pickLabels.length === 0 ? (
 <p className="empty" style={{ paddingTop: 0 }}>
 No categories picked yet — filter the home feed by a category and it&rsquo;s
 remembered here.
 </p>
 ) : (
 <ul className="profile-list">
 {picks.map((id, i) => (
 <li key={id} className="profile-list-row">
 <span>{pickLabels[i]}</span>
 <button type="button" className="profile-remove" onClick={() => removePick(id)}>
 Remove
 </button>
 </li>
 ))}
 </ul>
 )}
 </div>

 <div className="profile-section">
 <div className="profile-section-label">Local areas</div>
 {localAreas.length === 0 ? (
 <p className="empty" style={{ paddingTop: 0 }}>
 No local areas added yet.{' '}
 <Link href="/local">Browse local areas →</Link>
 </p>
 ) : (
 <ul className="profile-list">
 {localAreas.map((slug) => (
 <li key={slug} className="profile-list-row">
 <Link href={`/local/${slug}`}>{slug}</Link>
 </li>
 ))}
 </ul>
 )}
 </div>

 <Footer />
 <BottomTabs activeNav="today" />
 </div>
 );
}
