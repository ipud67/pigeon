/* public/sw.js — Pigeon's service worker. R175 (mobile-first).
 *
 * WHAT IT IS FOR. Pigeon installs to a phone home screen: there is a manifest and five icons.
 * Until now there was no service worker behind them, so the app installed and then showed a
 * browser error page the moment the signal dropped — on a bus, in a lift, on a plane. The
 * edition is a static artifact that does not change between publishes, which is close to the
 * ideal case for a cache.
 *
 * THREE RULES, and the reason for each.
 *
 *   1. /_next/static/**  — CACHE FIRST. Every file under there is content-hashed, so a given URL
 *      can never mean two different things. Nothing to revalidate.
 *
 *   2. HTML pages — NETWORK FIRST, with a short timeout. The network is asked for today's page;
 *      if it answers within NETWORK_TIMEOUT_MS the reader sees the current edition and the copy is
 *      saved for later. If the network is slow or gone, the last saved copy is served, and if
 *      there is none, the offline page. (Pigeon, 2026-09-03: the first draft was stale-while-
 *      revalidate, which would have shown a once-a-day reader YESTERDAY's paper first. A newspaper
 *      that opens on the previous edition is wrong in the one way readers notice most, so
 *      freshness wins and the cache is only a fallback.)
 *
 *   3. Everything else — NETWORK ONLY. Nothing is cached that is not (1) or (2). In particular
 *      the account layer: anything crossing to Supabase, and any request from the profile's own
 *      sync path, is passed straight through and never stored. A reader's saved stories are
 *      their data; a cache of them on a shared device is a leak with no upside.
 *
 * Cross-origin requests (fonts, source links) are not touched at all.
 */

// Bump this to retire every previous cache. It is the ONLY thing that clears the old edition.
const CACHE = 'pigeon-v1';
const OFFLINE_URL = '/offline.html';
// How long a page fetch may take before the saved copy is served instead. Long enough for a slow
// phone connection to deliver a ~1 MB front page; short enough that "no signal" never looks like a
// hang. The network fetch keeps running past this point so the cache still gets today's page.
const NETWORK_TIMEOUT_MS = 4000;

// Never store, never serve from the cache. Substring match on the full URL, deliberately blunt:
// a rule that is easy to read is a rule that stays correct.
const NEVER_CACHE = ['supabase', '/profile/sync', '/auth', '/api/'];

function isNeverCached(url) {
  return NEVER_CACHE.some((frag) => url.includes(frag));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      // A failed precache must not leave the worker stuck in "installing" forever. Without the
      // offline page the worker still does its other two jobs.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // fonts, primary sources — not ours to cache
  if (isNeverCached(req.url)) return;

  // 1 — hashed build assets: cache first.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // 2 — pages: network first (today's edition), then the saved copy, then the offline page.
  const wantsHTML =
    req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (wantsHTML) {
    event.respondWith(
      caches.open(CACHE).then((cache) => {
        const fromNetwork = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        });
        // A slow network must not turn into a blank screen: after the timeout the saved copy is
        // served, but the network fetch above keeps running so the cache still gets today's page.
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('sw: network timeout')), NETWORK_TIMEOUT_MS),
        );
        return Promise.race([fromNetwork, timeout]).catch(() =>
          cache.match(req).then((hit) => hit || cache.match(OFFLINE_URL)),
        );
      }),
    );
  }
  // 3 — everything else falls through to the network untouched.
});
