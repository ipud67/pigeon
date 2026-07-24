// tests/personas.mjs — 5-persona Playwright QC for the Pigeon reader (spec rework).
// Standing rule (roster-wide): five distinct personas drive the core flows before any
// deploy is called done. Run: BASE_URL=https://... node tests/personas.mjs
//
// Personas: curious-browser, power-user, mobile-only, fresh-signup, returning-user.
// This suite verifies the v2 rework: mixed importance-ranked home (NOT all economics),
// 8-K micro-noise buried, tap-to-expand dropdown -> full long-form, and the long-form
// depth structure (context / short history / constitutional analysis / prediction).

import { chromium, devices } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3210').replace(/\/$/, '');
const SHOTS = process.env.SHOT_DIR ?? 'tests/shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function log(persona, name, pass, detail = '') {
 results.push({ persona, name, pass });
 console.log(` ${pass ? 'PASS' : 'FAIL'} [${persona}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function run() {
 const browser = await chromium.launch();

 // 1 — CURIOUS BROWSER: lands, taps a headline -> context dropdown -> full long form, bails.
 {
 const ctx = await browser.newContext();
 const page = await ctx.newPage();
 await page.goto(BASE + '/', { waitUntil: 'networkidle' });
 await page.waitForTimeout(500); // hydration
 const cards = page.locator('.dispatch');
 const n = await cards.count();
 log('curious', 'home shows dispatch cards', n > 0, `${n} cards`);

 // tap headline -> inline context dropdown appears (no navigation yet)
 await cards.first().locator('.dispatch-head').click();
 await page.waitForTimeout(150);
 const dropVisible = (await cards.first().locator('.dispatch-drop').count()) > 0;
 log('curious', 'headline tap opens context dropdown', dropVisible);
 await page.screenshot({ path: `${SHOTS}/home.png`, fullPage: true });

 // tap dropdown -> navigate to full long form
 await Promise.all([
 page.waitForURL('**/story/**', { timeout: 15000 }),
 cards.first().locator('.dispatch-drop').click(),
 ]).catch(() => {});
 await page.waitForLoadState('networkidle');
 const hasFact = (await page.locator('.detail .lede').count()) > 0;
 const hasSources = (await page.locator('.sources-panel').count()) > 0;
 log('curious', 'long form renders FACT + sources', hasFact && hasSources);
 await Promise.all([
 page.waitForURL((u) => !/\/story\//.test(u.toString()), { timeout: 15000 }),
 page.locator('.back-bar a').click(),
 ]).catch(() => {});
 log('curious', 'back to feed works', page.url().replace(/\/$/, '') === BASE);
 await ctx.close();
 }

 // 2 — POWER USER: sweeps fast; the WHOLE POINT — top of home must be MIXED, not economics.
 {
 const ctx = await browser.newContext();
 const page = await ctx.newPage();
 await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
 log('power', 'today section loads', (await page.locator('.feed-label').count()) > 0);
 // /weekly renders a strict last-7-days window; when the committed fact store is older than
 // that (ingest is manual + id-stable by design), the HONEST state is "Nothing in the last
 // 7 days yet." — accept dispatches OR the plain empty copy (same pattern as the events check).
 // A hard >0 assertion made the suite fail on data staleness, not on behavior (found 2026-07-17).
 await page.goto(BASE + '/weekly', { waitUntil: 'domcontentloaded' });
 const weeklyCards = await page.locator('.dispatch').count();
 const weeklyEmpty = (await page.locator('.empty').allInnerTexts()).join(' ');
 log('power', 'weekly section loads (dispatches or honest empty state)',
 weeklyCards > 0 || /nothing in the last 7 days/i.test(weeklyEmpty), `${weeklyCards} cards`);
 await page.goto(BASE + '/', { waitUntil: 'networkidle' });
 await page.waitForTimeout(500);
 // top 15 must NOT be dominated by economics (round-1 failure was ~15 straight econ/8-K)
 const ledes = await page.locator('.dispatch .lede').allInnerTexts();
 const first15 = ledes.slice(0, 15);
 let econCount = 0;
 const cardCount = Math.min(15, await page.locator('.dispatch').count());
 for (let i = 0; i < cardCount; i++) {
 econCount += await page.locator('.dispatch').nth(i).locator('.econ-tag').count();
 }
 const has8K = first15.some((t) => /\b8-?K\b/i.test(t));
 log('power', 'top 15 not economics-dominated', econCount <= 6, `${econCount}/15 econ-tagged`);
 log('power', 'no SEC 8-K micro-filing on default home', !has8K);
 // Nav no longer carries Long-form / Predict tabs.
 // Selector updated 2026-07-22: the ruling was that the menu is built INTO the newspaper
 // structure rather than sitting in a web navbar, so `nav.nav` became `nav.sections` —
 // the section rule under the flag. Same assertions, new home.
 const navText = (await page.locator('nav.sections').innerText()).toLowerCase();
 log('power', 'nav dropped Long-form + Predict tabs', !/long-?form|predict/.test(navText));

 // FULL EVENTS : nav entry + standalone browsing page, newest-first or honestly empty.
 log('power', 'nav carries Full Events entry', /full events/.test(navText));
 await page.goto(BASE + '/events/', { waitUntil: 'networkidle' });
 const eventRows = page.locator('[data-testid="event-row"]');
 const evN = await eventRows.count();
 const evEmpty = (await page.locator('.empty').allInnerTexts()).join(' ');
 log('power', 'events page lists full events or says so plainly',
 evN > 0 || /no full events in the current window/i.test(evEmpty), `${evN} events`);

 // FULL EVENTS : the in-story labeled Full-event block on a tagged story.
 if (evN > 0) {
 const paywallFlagged = await eventRows.first().locator('.paywall').count();
 const extHref = await eventRows.first().locator('.event-title').getAttribute('href');
 log('power', 'event row links out to the artifact (external, paywall-flag honest)',
 !!extHref && /^https?:\/\//.test(extHref), `${extHref?.slice(0, 60)} paywallFlag=${paywallFlagged}`);
 await Promise.all([
 page.waitForURL('**/story/**', { timeout: 15000 }),
 eventRows.first().locator('.event-story').click(),
 ]).catch(() => {});
 const feBlock = page.locator('[data-testid="full-event"]');
 const feText = ((await feBlock.innerText().catch(() => '')) || '').toLowerCase();
 log('power', 'story long form carries the labeled Full event block',
 (await feBlock.count()) > 0 && /full event/.test(feText) && (await feBlock.locator('a.fe-link').count()) > 0);
 }
 await ctx.close();
 }

 // 3 — MOBILE-ONLY: small touch viewport, feed + tap-through must work.
 {
 const ctx = await browser.newContext({ ...devices['iPhone 13'] });
 const page = await ctx.newPage();
 await page.goto(BASE + '/', { waitUntil: 'networkidle' });
 await page.waitForTimeout(500);
 const n = await page.locator('.dispatch').count();
 log('mobile', 'feed renders on 390px viewport', n > 0);
 const overflow = await page.evaluate(
 () => document.documentElement.scrollWidth <= window.innerWidth + 2,
 );
 log('mobile', 'no horizontal overflow', overflow);
 await page.locator('.dispatch').first().locator('.dispatch-head').tap();
 await page.waitForTimeout(150);
 await Promise.all([
 page.waitForURL('**/story/**', { timeout: 15000 }),
 page.locator('.dispatch').first().locator('.dispatch-drop').tap(),
 ]).catch(() => {});
 log('mobile', 'tap-through opens story', /\/story\//.test(page.url()) && (await page.locator('.detail').count()) > 0);
 await ctx.close();
 }

 // 4 — FRESH SIGNUP / FIRST-TIME: reads everything, tries the opt-in economics filter.
 {
 const ctx = await browser.newContext();
 const page = await ctx.newPage();
 await page.goto(BASE + '/', { waitUntil: 'networkidle' });
 await page.waitForTimeout(500);
 const term = await page.locator('.terminator').innerText();
 log('fresh', 'terminator present (anti-doomscroll)', /caught up/i.test(term));
 const chips = await page.locator('.chip').count();
 log('fresh', 'Top Stories + category filter chips present', chips >= 6, `${chips} chips`);
 // Economics is OPT-IN. Per Research's Deliverable-3 rework the econ filter is the PLAIN-LANGUAGE
 // money surface — NOT a raw 8-K/EDGAR dump (those are buried, deep-search only). It must
 // surface comprehensible econ cards, each carrying a "what it means" wallet line.
 await page.locator('.chip', { hasText: 'Economics' }).click();
 await page.waitForTimeout(250);
 const econActive = (await page.locator('.chip.active').innerText()).toLowerCase().includes('econ');
 const econCards = await page.locator('.dispatch[data-category="economics"]').count();
 const walletLines = await page.locator('[data-testid="econ-plain"]').count();
 const ledes = await page.locator('.dispatch .lede').allInnerTexts();
 const eightKReachable = ledes.some((t) => /\b8-?K\b/i.test(t));
 log('fresh', 'economics filter surfaces plain-language econ cards', econActive && econCards > 0 && walletLines > 0, `${econCards} cards, ${walletLines} wallet lines`);
 log('fresh', '8-K micro-filings buried off the econ filter (Research rework)', !eightKReachable);
 await ctx.close();
 }

 // 5 — RETURNING USER: theme persists; AND the long-form depth structure renders on a real
 // high-importance story (National Guard force-posture — Research depth override).
 {
 const ctx = await browser.newContext();
 const page = await ctx.newPage();
 await page.goto(BASE + '/', { waitUntil: 'networkidle' });
 const defaultTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
 log('returning', 'dark is the default theme', defaultTheme === 'dark');
 await page.waitForTimeout(600);
 await page.locator('.toggle-btn').click();
 await page.waitForTimeout(200);
 const afterToggle = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
 await page.reload({ waitUntil: 'networkidle' });
 const afterReload = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
 log('returning', 'theme choice persists across reload', afterToggle === 'light' && afterReload === 'light');

 // Full long-form depth on a story that actually carries a Research depth override.
 //
 // This used to hardcode /story/f219ec983fe5/ (the National Guard / Whiskey Rebellion
 // story). That id aged out of the feed on an earlier ingest, so the assertion had been
 // failing against a 404 with a 30s locator timeout — it was testing a story that no
 // longer existed. Depth overrides are keyed by fact id and fact ids are derived from
 // url+title, so any override whose source story falls out of the RSS window goes dark.
 // Resolve the target from the data instead of pinning it.
 const OVERRIDES = JSON.parse(readFileSync('data/depth-overrides.json', 'utf8'));
 const FACTS = JSON.parse(readFileSync('data/facts.json', 'utf8'));
 const depthStory = FACTS.find((f) => OVERRIDES[f.id]);
 if (!depthStory) {
 log('returning', 'a depth-override story is present in the feed', false,
 `0 of ${Object.keys(OVERRIDES).length} overrides match a current fact id — all source stories aged out`);
 await ctx.close();
 return;
 }
 await page.goto(BASE + `/story/${depthStory.id}/`, { waitUntil: 'networkidle' });
 const labels = (await page.locator('.narr .sec-label').allInnerTexts()).map((s) => s.toLowerCase());
 const hasHistory = labels.some((l) => /short history/.test(l));
 const hasConstitutional = labels.some((l) => /constitutional/.test(l));
 const hasPrediction = labels.some((l) => /predictive/.test(l));
 log('returning', 'long form has short-history + constitutional + predictive sections', hasHistory && hasConstitutional && hasPrediction);
 // Research depth override renders REAL substance (not a provenance tag, which we no longer
 // show): the constitutional analysis opens with the founding argument itself.
 const body = (await page.locator('.detail').innerText()).toLowerCase();
 // Substance check reads from the override the story actually carries, rather than
 // asserting phrases from one specific brief that may not be the surviving story.
 const ovForStory = OVERRIDES[depthStory.id];
 const probe = (ovForStory.constitutional_analysis ?? ovForStory.short_history ?? '')
 .toLowerCase().split(/[.;]/)[0].split(/\s+/).filter((w) => w.length > 5).slice(0, 3);
 const hasSubstance = probe.length > 0 && probe.every((w) => body.includes(w));
 log('returning', 'Research depth override renders real substance', hasSubstance,
 `story ${depthStory.id} · probe [${probe.join(', ')}]`);
 // Reader-facing = substance ONLY: no methodology meta leaks into the rendered story.
 const noMeta =
 (await page.locator('.lens-note, .depth-prov, .framing, .placeholder-body').count()) === 0 &&
 !/pigeon weighs this against|value lens|api_key|pending key/.test(body);
 log('returning', 'no internal-process meta leaks into reader view', noMeta);
 await page.screenshot({ path: `${SHOTS}/longform-detail.png`, fullPage: true });
 await ctx.close();
 }

 // 6 — GLOBE (Phase 1 app port, minimal persona slice — the deep gate is tests/globe-oracle.mjs):
 // /globe/ loads + boots into Matte Atlas, nation→state→county→city drill works, search flies to
 // a city, add-to-newsfeed toggles.
 {
 const ctx = await browser.newContext();
 const page = await ctx.newPage();
 const pageErrors = [];
 page.on('pageerror', (e) => pageErrors.push(String(e)));
 await page.goto(BASE + '/globe/', { waitUntil: 'domcontentloaded' });
 const booted = await page
 .waitForFunction(() => window.__pig && window.__pig.ready, { timeout: 45000 })
 .then(() => true)
 .catch(() => false);
 log('globe', '/globe/ loads and the engine boots', booted);
 if (booted) {
 const skin = await page.evaluate(() => window.__pig.getSkin());
 log('globe', 'boots into the Matte Atlas skin', skin === 'globe');
 const drill = await page.evaluate(() => {
 const P = window.__pig, steps = {};
 P.jumpToLevel('sandiego', 1); steps.nation = P.navState().level === 1;
 steps.state = P.jumpState('06');
 steps.county = P.jumpCounty('06073');
 P.jumpToLevel('sandiego', 4); steps.city = P.navState().level === 4 && P.cardOpen();
 return steps;
 });
 log('globe', 'nation→state→county→city drill works', drill.nation && drill.state && drill.county && drill.city, JSON.stringify(drill));
 const search = await page.evaluate(() => {
 const P = window.__pig;
 P.jumpState('06');
 P.searchType('Fresno');
 const id = P.searchRowsCities()[0];
 const arrived = id ? P.jumpCity(id) : false;
 return { arrived, nav: P.navState() };
 });
 log('globe', 'search flies to a city and opens its view', search.arrived && search.nav.level === 4);
 const addFeed = await page.evaluate(() => {
 const P = window.__pig;
 const present = P.addFeedPresent();
 const pid = P.navState().cityId;
 const after1 = (P.clickAddFeed(), P.isPinned(pid));
 const after2 = (P.clickAddFeed(), P.isPinned(pid));
 return { present, after1, after2 };
 });
 log('globe', 'add-to-newsfeed toggles on and off', addFeed.present && addFeed.after1 === true && addFeed.after2 === false, JSON.stringify(addFeed));
 log('globe', 'zero page errors on the globe surface', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || '));
 }
 await ctx.close();
 }

 await browser.close();

 const passed = results.filter((r) => r.pass).length;
 const total = results.length;
 console.log(`\n ${passed}/${total} assertions passed across 5 personas + globe slice.`);
 if (passed !== total) process.exit(1);
}

console.log(`\n PIGEON 5-PERSONA QC · ${BASE}\n`);
run().catch((e) => {
 console.error('persona run crashed:', e);
 process.exit(1);
});
