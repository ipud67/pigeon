'use client';

// app/local/[slug]/AddAreaButton.tsx — the "+ Add [area] to my feed" affordance (build-out C2).
//
// Client-only, localStorage-backed (NO backend). Adds/removes the area's slug from the reader's
// "my local areas" set and reflects the current membership. Renders a stable, JS-off-safe default
// (the un-added "+ Add" state) on the server, then reconciles to the true stored state on mount —
// so the static SSR page is never wrong for a fresh reader and there is no hydration mismatch.
//
// Visual: the mockup's restrained ink-red "+ Add" affordance (Direction B) — a bordered accent
// button, NOT an urgent-red call to action. Toggles to "Added ✓ / Remove" once present.

import { useEffect, useState } from 'react';
import { addLocalArea, hasLocalArea, removeLocalArea, subscribeLocalAreas } from '../localStore';

export function AddAreaButton({ slug, name }: { slug: string; name: string }) {
 // Start false on BOTH server and first client render (matches the SSR HTML), then sync on mount.
 const [added, setAdded] = useState(false);
 const [mounted, setMounted] = useState(false);

 useEffect(() => {
 setMounted(true);
 const sync = () => setAdded(hasLocalArea(slug));
 sync();
 return subscribeLocalAreas(sync);
 }, [slug]);

 const toggle = () => {
 if (hasLocalArea(slug)) removeLocalArea(slug);
 else addLocalArea(slug);
 };

 return (
 <button
 type="button"
 className={`add-area-btn${added ? ' added' : ''}`}
 data-testid="add-area-btn"
 data-added={mounted ? String(added) : 'false'}
 aria-pressed={added}
 onClick={toggle}
 >
 {added ? (
 <>
 <span className="aab-mark" aria-hidden>
 &#10003;
 </span>{' '}
 Added to my feed <span className="aab-remove">· Remove</span>
 </>
 ) : (
 <>+ Add {name} to my feed</>
 )}
 </button>
 );
}
