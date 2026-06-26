// tests/personas.mjs — 5-persona Playwright QC for the Pigeon reader.
// Standing rule (roster-wide): five distinct personas drive the core flows before any
// deploy is called done. Run: BASE_URL=https://... node tests/personas.mjs
//
// Personas: curious-browser, power-user, mobile-only, fresh-signup, returning-user.

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

  // 1 — CURIOUS BROWSER: lands, clicks a dispatch, reads the three layers, bails back.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const dispatches = page.locator('a.dispatch');
    const n = await dispatches.count();
    log('curious', 'home shows dispatches', n > 0, `${n} dispatches`);
    await Promise.all([
      page.waitForURL('**/story/**', { timeout: 15000 }),
      dispatches.first().click(),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle');
    const hasFact = (await page.locator('.detail .lede').count()) > 0;
    const hasSources = (await page.locator('.sources-panel').count()) > 0;
    log('curious', 'detail renders FACT + sources', hasFact && hasSources);
    await page.screenshot({ path: `${SHOTS}/curious-detail.png`, fullPage: true });
    await Promise.all([
      page.waitForURL((u) => !/\/story\//.test(u.toString()), { timeout: 15000 }),
      page.locator('.back-bar a').click(),
    ]).catch(() => {});
    await page.waitForLoadState('networkidle');
    log('curious', 'back to feed works', page.url().replace(/\/$/, '') === BASE);
    await ctx.close();
  }

  // 2 — POWER USER IN A HURRY: sweeps every section fast, expects all to load.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const [path, sel, label] of [
      ['/', '.feed-label', 'today'],
      ['/weekly', '.sec-label', 'weekly'],
      ['/predict', '.forecast', 'predict'],
      ['/longform', '.section-kicker', 'longform'],
    ]) {
      await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
      const ok = (await page.locator(sel).count()) > 0;
      log('power', `${label} section loads`, ok);
    }
    // predict must show a probability and the firewall note
    await page.goto(BASE + '/predict', { waitUntil: 'networkidle' });
    const prob = (await page.locator('.prob').count()) > 0;
    const firewall = (await page.locator('.predict-firewall').count()) > 0;
    log('power', 'predict shows probability + firewall', prob && firewall);
    await ctx.close();
  }

  // 3 — MOBILE-ONLY: small touch viewport, feed + tap-through must work.
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const n = await page.locator('a.dispatch').count();
    log('mobile', 'feed renders on 390px viewport', n > 0);
    // no horizontal overflow
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    );
    log('mobile', 'no horizontal overflow', overflow);
    await Promise.all([
      page.waitForURL('**/story/**', { timeout: 15000 }),
      page.locator('a.dispatch').first().tap(),
    ]).catch(() => {});
    log('mobile', 'tap opens story', /\/story\//.test(page.url()) && (await page.locator('.detail').count()) > 0);
    await page.screenshot({ path: `${SHOTS}/mobile-home.png`, fullPage: true });
    await ctx.close();
  }

  // 4 — FRESH SIGNUP / FIRST-TIME: reads everything, tries curation, sees the terminator.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const term = await page.locator('.terminator').innerText();
    log('fresh', 'terminator present (anti-doomscroll)', /caught up/i.test(term));
    const chips = await page.locator('.chip').count();
    log('fresh', 'curation chips present', chips >= 5, `${chips} chips`);
    // Curation is a client island: click the Economics chip and assert econ items float up.
    await page.getByRole('button', { name: 'Economics' }).click();
    await page.waitForTimeout(200);
    const econActive = (await page.locator('.chip.active').innerText()).toLowerCase().includes('econ');
    const firstHasEcon = (await page.locator('a.dispatch').first().locator('.econ-tag').count()) > 0;
    log('fresh', 'economics curation prioritizes econ items', econActive && firstHasEcon);
    await ctx.close();
  }

  // 5 — RETURNING USER: theme preference persists across reload; continuity.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const defaultTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    log('returning', 'dark is the default theme', defaultTheme === 'dark');
    // Wait for hydration so the toggle's onClick is wired before we click.
    await page.waitForTimeout(600);
    await page.locator('.toggle-btn').click();
    await page.waitForTimeout(200);
    const afterToggle = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.reload({ waitUntil: 'networkidle' });
    const afterReload = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    log('returning', 'theme choice persists across reload', afterToggle === 'light' && afterReload === 'light');
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
