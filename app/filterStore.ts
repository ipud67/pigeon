// app/filterStore.ts — the active home-feed category filter, shared across component trees.
//
// The filter used to be local useState inside <Feed>. It can't stay there: the control that
// sets it now lives in the bottom tab bar's "More" sheet, which is a sibling of <Feed>, not a
// descendant. Same shape as localStore/profileStore (module state + CustomEvent + a subscribe
// that returns an unsubscribe) so there is one pattern in this codebase, not three.
//
// Deliberately NOT persisted. The filter is a way to look at today's news, not a preference —
// a reader who filtered to War once should not be locked out of the mixed feed tomorrow. The
// durable signal is the explicit category pick, which profileStore already records.

import type { Category } from '../lib/types';
import { TOP_FILTER } from './components';

export type ActiveFilter = Category | typeof TOP_FILTER;

const EVENT = 'pigeon:filter';
let active: ActiveFilter = TOP_FILTER;

export function getFilter(): ActiveFilter {
 return active;
}

export function setFilter(next: ActiveFilter): void {
 if (active === next) return;
 active = next;
 if (typeof window === 'undefined') return;
 try {
 window.dispatchEvent(new CustomEvent(EVENT));
 } catch {
 /* no-op */
 }
}

export function subscribeFilter(cb: () => void): () => void {
 if (typeof window === 'undefined') return () => {};
 window.addEventListener(EVENT, cb);
 return () => window.removeEventListener(EVENT, cb);
}
