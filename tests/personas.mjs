// tests/personas.mjs — 5-persona Playwright QC for the Pigeon reader (SPEC v2 rework).
// Standing rule (roster-wide): five distinct personas drive the core flows before any
// deploy is called done. Run: BASE_URL=https://... node tests/personas.mjs
//
// Personas: curious-browser, power-user, mobile-only, fresh-signup, returning-user.
// This suite verifies the v2 rework: mixed importance-ranked home (NOT all economics),
// 8-K micro-noise buried, tap-to-expand dropdown -> full long-form, and the long-form
// depth structure (context / short history / constitutional analysis / prediction).

import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3210').replace(/\/$/, '');
const SHOTS = process.env.SHOT_DIR ?? 'tests/shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function log(persona, name, pass, detail = '') {
  results.push({ persona, name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${persona}] ${name}${detail ? ' — ' + detail : ''}`);
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
    for (const [path, sel, label] of [
      ['/', '.feed-label', 'today'],
      ['/weekly', '.dispatch', 'weekly'],
    ]) {
      await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
      const ok = (await page.locator(sel).count()) > 0;
      log('power', `${label} section loads`, ok);
    }
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
    // nav no longer carries Long-form / Predict tabs
    const navText = (await page.locator('nav.nav').innerText()).toLowerCase();
    log('power', 'nav dropped Long-form + Predict tabs', !/long-?form|predict/.test(navText));
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
    // Economics is OPT-IN. Per Clark's Deliverable-3 rework the econ filter is the PLAIN-LANGUAGE
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
    log('fresh', '8-K micro-filings buried off the econ filter (Clark rework)', !eightKReachable);
    await ctx.close();
  }

  // 5 — RETURNING USER: theme persists; AND the long-form depth structure renders on a real
  // high-importance story (National Guard force-posture — Clark depth override).
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

    // full long-form depth on a high-importance force-posture story
    await page.goto(BASE + '/story/f219ec983fe5/', { waitUntil: 'networkidle' });
    const labels = (await page.locator('.narr .sec-label').allInnerTexts()).map((s) => s.toLowerCase());
    const hasHistory = labels.some((l) => /short history/.test(l));
    const hasConstitutional = labels.some((l) => /constitutional/.test(l));
    const hasPrediction = labels.some((l) => /predictive/.test(l));
    log('returning', 'long form has short-history + constitutional + predictive sections', hasHistory && hasConstitutional && hasPrediction);
    // Clark depth override renders REAL substance (not a provenance tag, which we no longer
    // show): the constitutional analysis opens with the founding argument itself.
    const body = (await page.locator('.detail').innerText()).toLowerCase();
    const hasSubstance = body.includes('whiskey rebellion') && body.includes('domestic tranquility');
    log('returning', 'Clark depth override renders real substance', hasSubstance);
    // Reader-facing = substance ONLY: no methodology meta leaks into the rendered story.
    const noMeta =
      (await page.locator('.lens-note, .depth-prov, .framing, .placeholder-body').count()) === 0 &&
      !/pigeon weighs this against|value lens|api_key|pending key/.test(body);
    log('returning', 'no internal-process meta leaks into reader view', noMeta);
    await page.screenshot({ path: `${SHOTS}/longform-detail.png`, fullPage: true });
    await ctx.close();
  }

  await browser.close();

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} assertions passed across 5 personas.`);
  if (passed !== total) process.exit(1);
}

console.log(`\n PIGEON 5-PERSONA QC  ·  ${BASE}\n`);
run().catch((e) => {
  console.error('persona run crashed:', e);
  process.exit(1);
});
