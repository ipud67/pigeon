// app/personalize/profileStore.ts — client-side READER PROFILE store (Ranking Model v1).
//
// FREE, anonymous-OK, NO backend (): the reader's personalization state lives only in the
// browser's localStorage. Four keys under `pigeon.profile.*`: the PREVIOUS visit time, the LRU set
// of story ids already shown, the explicit category picks, and light implicit signals. Mirrors
// app/local/localStore.ts EXACTLY — SSR-safe `hasWindow()` guards, silent degrade on quota errors,
// CustomEvent + storage-event subscribe — so the static export renders fine with no JS / no profile.
//
// The ReaderProfile SHAPE is owned by the ranking layer (lib/ranking/personalize.ts); the store
// just persists it. This keeps the dependency direction app → lib (never lib → app).

import type { Category } from '../../lib/types';
import type { ReaderProfile } from '../../lib/ranking/personalize';

const LAST_VISIT_KEY = 'pigeon.profile.lastVisit';
const SEEN_KEY = 'pigeon.profile.seen';
const PICKS_KEY = 'pigeon.profile.picks';
const SIGNALS_KEY = 'pigeon.profile.signals';
const EVENT = 'pigeon:profile';

const SEEN_CAP = 500; // LRU cap — drop oldest; prevents unbounded localStorage growth
const SIGNAL_MIN = -2; // light implicit signal is bounded so it can never dominate picks/importance
const SIGNAL_MAX = 2;

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

function readStringArray(key: string): string[] {
 const list = readJson<string[]>(key, []);
 if (!Array.isArray(list)) return [];
 return list.filter((s) => typeof s === 'string');
}

/** The full reader profile as the ranking layer consumes it. SSR-safe (all-empty off the server). */
export function getProfile(): ReaderProfile {
 const signalsRaw = readJson<Record<string, number>>(SIGNALS_KEY, {});
 const signals: Partial<Record<Category, number>> =
 signalsRaw && typeof signalsRaw === 'object' ? (signalsRaw as Partial<Record<Category, number>>) : {};
 return {
 lastVisit: readJson<string | null>(LAST_VISIT_KEY, null),
 seenIds: readStringArray(SEEN_KEY),
 picks: readStringArray(PICKS_KEY) as Category[],
 signals,
 };
}

/** READ the prior last-visit value — call this BEFORE markVisited so the ranking sees the PRIOR
 * visit (read-then-write, exactly like localStore.markSeen). Returns null on first-ever visit. */
export function getLastVisit(): string | null {
 return readJson<string | null>(LAST_VISIT_KEY, null);
}

/** Write NOW as the new last-visit. Call AFTER reading the prior value into the ranking call. */
export function markVisited(nowISO: string = new Date().toISOString()): void {
 writeJson(LAST_VISIT_KEY, nowISO);
 emit();
}

/** Record the ids that were shown to the reader this visit. LRU-capped at 500 (oldest dropped);
 * a re-shown id moves to the most-recent end. A story is "seen" once it has been rendered. */
export function markSeen(ids: string[]): void {
 if (!ids || ids.length === 0) return;
 const fresh = ids.filter((s) => typeof s === 'string');
 if (fresh.length === 0) return;
 const freshSet = new Set(fresh);
 // keep prior order, drop any id being re-seen, then append the fresh ids at the recent end
 const prior = readStringArray(SEEN_KEY).filter((id) => !freshSet.has(id));
 const merged = [...prior, ...fresh];
 const capped = merged.length > SEEN_CAP ? merged.slice(merged.length - SEEN_CAP) : merged;
 writeJson(SEEN_KEY, capped);
 emit();
}

export function getSeenIds(): string[] {
 return readStringArray(SEEN_KEY);
}

/** The reader's explicit category picks (order preserved; deduped). */
export function getPicks(): Category[] {
 return readStringArray(PICKS_KEY) as Category[];
}

/** Record an explicit category pick. Sticky + deduped. */
export function addPick(cat: Category): void {
 const list = getPicks();
 if (list.includes(cat)) return;
 writeJson(PICKS_KEY, [...list, cat]);
 emit();
}

export function removePick(cat: Category): void {
 const list = getPicks();
 if (!list.includes(cat)) return;
 writeJson(
 PICKS_KEY,
 list.filter((c) => c !== cat),
 );
 emit();
}

/** Light implicit signal: += on story-open, -= on dismiss, clamped to [-2, +2] per category so it
 * can never overpower an explicit pick or editorial importance. */
export function bumpSignal(cat: Category, delta: number): void {
 const signals = readJson<Record<string, number>>(SIGNALS_KEY, {}) ?? {};
 const next = Math.max(SIGNAL_MIN, Math.min(SIGNAL_MAX, (signals[cat] ?? 0) + delta));
 signals[cat] = next;
 writeJson(SIGNALS_KEY, signals);
 emit();
}

/** Subscribe to any profile change (this tab via CustomEvent, other tabs via the storage event).
 * Returns an unsubscribe fn. */
export function subscribeProfile(cb: () => void): () => void {
 if (!hasWindow()) return () => {};
 const onStorage = (e: StorageEvent) => {
 if (
 e.key === LAST_VISIT_KEY ||
 e.key === SEEN_KEY ||
 e.key === PICKS_KEY ||
 e.key === SIGNALS_KEY ||
 e.key === null
 )
 cb();
 };
 window.addEventListener(EVENT, cb);
 window.addEventListener('storage', onStorage);
 return () => {
 window.removeEventListener(EVENT, cb);
 window.removeEventListener('storage', onStorage);
 };
}
