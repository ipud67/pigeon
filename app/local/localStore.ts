// app/local/localStore.ts — client-side "my local areas" store (build-out C2).
//
// FREE, anonymous-OK, NO backend (): the reader's chosen local areas live only in the browser's
// localStorage. A slug list (`pigeon.localAreas`) plus a per-area last-seen map (`pigeon.localSeen`)
// that lets the Today headline show an HONEST "N new" count (items newer than the reader's last
// visit to their local feed) — never a fabricated number. Every accessor is SSR-safe (guards
// `window`) so the static export renders fine with no JS / no stored areas.

const AREAS_KEY = 'pigeon.localAreas';
const SEEN_KEY = 'pigeon.localSeen';
const EVENT = 'pigeon:localareas';

function hasWindow(): boolean {
 return typeof window !== 'undefined' && !!window.localStorage;
}

function readJson<T>(key: string, fallback: T): T {
 if (!hasWindow()) return fallback;
 try {
 const raw = window.localStorage.getItem(key);
 if (!raw) return fallback;
 return JSON.parse(raw) as T;
 } catch {
 return fallback;
 }
}

function writeJson(key: string, value: unknown): void {
 if (!hasWindow()) return;
 try {
 window.localStorage.setItem(key, JSON.stringify(value));
 } catch {
 /* storage full / disabled — degrade silently (the feature is optional) */
 }
}

function emit(): void {
 if (!hasWindow()) return;
 try {
 window.dispatchEvent(new CustomEvent(EVENT));
 } catch {
 /* no-op */
 }
}

/** The reader's added local-area slugs (order preserved; deduped). */
export function getLocalAreas(): string[] {
 const list = readJson<string[]>(AREAS_KEY, []);
 if (!Array.isArray(list)) return [];
 return list.filter((s) => typeof s === 'string');
}

export function hasLocalArea(slug: string): boolean {
 return getLocalAreas().includes(slug);
}

export function addLocalArea(slug: string): void {
 const list = getLocalAreas();
 if (list.includes(slug)) return;
 writeJson(AREAS_KEY, [...list, slug]);
 emit();
}

export function removeLocalArea(slug: string): void {
 const list = getLocalAreas();
 if (!list.includes(slug)) return;
 writeJson(
 AREAS_KEY,
 list.filter((s) => s !== slug),
 );
 emit();
}

/** Map of slug -> ISO timestamp the reader last opened their local feed for that area. */
export function getSeen(): Record<string, string> {
 const obj = readJson<Record<string, string>>(SEEN_KEY, {});
 return obj && typeof obj === 'object' ? obj : {};
}

/** Mark the given areas as seen NOW — called when the reader opens their local feed, so the
 * Today headline's "N new" count honestly reflects items newer than this visit. */
export function markSeen(slugs: string[]): void {
 if (slugs.length === 0) return;
 const seen = getSeen();
 const now = new Date().toISOString();
 for (const s of slugs) seen[s] = now;
 writeJson(SEEN_KEY, seen);
 emit();
}

/** Count of items dated AFTER the reader's last-seen timestamp for `slug`. Never-seen => all new. */
export function newCount(slug: string, itemDates: string[]): number {
 const seenAt = getSeen()[slug];
 if (!seenAt) return itemDates.length;
 const seenMs = new Date(seenAt).getTime();
 if (isNaN(seenMs)) return itemDates.length;
 return itemDates.filter((d) => {
 const t = new Date(d).getTime();
 return !isNaN(t) && t > seenMs;
 }).length;
}

/** Subscribe to any change (this tab via CustomEvent, other tabs via the storage event).
 * Returns an unsubscribe fn. */
export function subscribeLocalAreas(cb: () => void): () => void {
 if (!hasWindow()) return () => {};
 const onStorage = (e: StorageEvent) => {
 if (e.key === AREAS_KEY || e.key === SEEN_KEY || e.key === null) cb();
 };
 window.addEventListener(EVENT, cb);
 window.addEventListener('storage', onStorage);
 return () => {
 window.removeEventListener(EVENT, cb);
 window.removeEventListener('storage', onStorage);
 };
}
