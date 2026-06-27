// tests/personas-readers.mjs — three ADVERSARIAL reader fixtures for Pigeon.
//
// Glenn Beck (clicks every primary-source link), Dr. Larry Arnn (Churchill-scholar rigor on
// the constitutional layer), and THE ROOFER (no diploma, comprehension is the hard floor).
// Spec: inbox/from_lex_pigeon_personas_2026-06-26.md (Lex) + Clark's persona+econ research.
//
// Assertion tags:
//   [LIVE]    — must pass against the build today.
//   [TARGET]  — gates the depth layer that fills in with Grok; passes today only where a
//               hand-researched depth override exists (the golden National Guard story).
//   [LIVE-net]— best-effort network reachability; gov hosts that bot-block resolve as
//               INCONCLUSIVE (logged, not failed) so the suite is not flaky on rate limits.
//
// THE ROOFER IS A HARD GATE: the first banned naked token / unglossed number models "the
// roofer quits" — the remaining steps abort and the test FAILS (no soft-continue).
//
// Run: BASE_URL=https://ipud67.github.io/pigeon node tests/personas-readers.mjs

import { chromium, devices } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3211').replace(/\/$/, '');
const GOLDEN_ID = 'f219ec983fe5'; // National Guard domestic missions (Clark depth override)

const results = [];
function log(persona, tag, name, pass, detail = '') {
  const status = pass === 'SKIP' ? 'SKIP' : pass ? 'PASS' : 'FAIL';
  results.push({ persona, name, pass: pass === 'SKIP' ? true : pass, hard: pass !== 'SKIP' });
  console.log(`  ${status}  [${persona}] ${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- shared source allowlist / blocklist (Lex §0.6) ------------------------
const PRIMARY_SOURCE_ALLOWLIST = [
  'federalregister.gov', 'govinfo.gov', 'whitehouse.gov', 'defense.gov', 'war.gov',
  'federalreserve.gov', 'supremecourt.gov', 'courtlistener.com', 'congress.gov',
  'gpo.gov', 'sec.gov', 'bls.gov', 'eia.gov', 'fred.stlouisfed.org',
  'founders.archives.gov', 'archives.gov', 'loc.gov', 'avalon.law.yale.edu',
  'constitution.congress.gov', 'home.treasury.gov', 'treasury.gov', 'treasurydirect.gov',
];
const OPINION_BLOCKLIST = [
  'theblaze.com', 'msnbc.com', 'medium.com', 'substack.com', 'x.com', 'twitter.com',
  'facebook.com', 'wikipedia.org',
];
const PAYWALL_HOSTS = ['wsj.com', 'ft.com', 'nytimes.com', 'economist.com', 'bloomberg.com'];

function hostOf(href) {
  try { return new URL(href, BASE).hostname.replace(/^www\./, ''); } catch { return ''; }
}
const inList = (host, list) => list.some((h) => host === h || host.endsWith('.' + h));

// ---- roofer comprehension lint (Lex §3.3) ----------------------------------
// Returns the offending token string, or null if the text is clean.
function bannedNakedToken(text) {
  if (/\b8-?K\b/.test(text)) return '8-K';
  if (/\b10-?[QK]\b/.test(text)) return '10-Q/K';
  if (/\bEDGAR\b/i.test(text)) return 'EDGAR';
  if (/\(\d{7,10}\)/.test(text)) return 'CIK number';
  if (/\bFiler\b/.test(text)) return 'Filer';
  if (/filed with the SEC/i.test(text)) return 'filed with the SEC';
  // FOMC allowed only if glossed within ~80 chars
  const fomc = text.match(/\bFOMC\b/);
  if (fomc) {
    const after = text.slice(fomc.index, fomc.index + 80);
    if (!/fed'?s? rate|rate-setting|interest rate|federal reserve/i.test(after)) return 'FOMC (unglossed)';
  }
  const cpi = text.match(/\bCPI\b/);
  if (cpi) {
    const around = text.slice(Math.max(0, cpi.index - 40), cpi.index + 80);
    if (!/inflation/i.test(around)) return 'CPI (unglossed)';
  }
  if (/\bbps\b/.test(text) || /\bbasis points\b/i.test(text)) {
    if (!/percentage point|percent/i.test(text)) return 'basis points (unglossed)';
  }
  // bare ticker immediately before a % or after a $ (no company name)
  const TICKER_OK = ['US', 'USA', 'EU', 'UK', 'UN', 'AM', 'PM', 'UTC', 'GDP', 'CEO'];
  const beforePct = text.match(/\b([A-Z]{2,5})\b(?=\s*[+\-]?\d+(?:\.\d+)?\s*%)/);
  if (beforePct && !TICKER_OK.includes(beforePct[1])) return `bare ticker ${beforePct[1]}`;
  const afterDollar = text.match(/\$([A-Z]{2,5})\b/);
  if (afterDollar && !TICKER_OK.includes(afterDollar[1])) return `bare ticker $${afterDollar[1]}`;
  // S&P 500 needs the gloss on first use
  if (/\bS&P 500\b/.test(text) && !/500 biggest/i.test(text)) return 'S&P 500 (unglossed)';
  return null;
}
function hasNumber(text) {
  return /%|\$\s?\d|\b\d{2,3}(?:,\d{3})+\b|\bindex\b|\bat \d{3,}/.test(text);
}

class RooferQuit extends Error {}

async function run() {
  const browser = await chromium.launch();

  // ===========================================================================
  // PERSONA 1 — GLENN BECK (clicks every primary-source link)
  // ===========================================================================
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // B1 [LIVE] home scan: default Top Stories, National Guard present
    const activeChip = (await page.locator('.curate .chip.active').innerText().catch(() => '')).trim();
    const ledes = await page.locator('.dispatch .lede').allInnerTexts();
    const ngIdx = ledes.findIndex((t) => /National Guard/i.test(t));
    log('beck', '[LIVE]', 'B1 home scan (Top Stories default + National Guard present)',
      /top stories/i.test(activeChip) && ngIdx >= 0, `active="${activeChip}", ngIdx=${ngIdx}`);

    // golden dispatch locator
    const golden = page.locator('.dispatch', { hasText: 'National Guard' }).first();

    // B6 [LIVE] sources are REAL clickable primary links (the live build's #1 gap)
    const srcLinks = golden.locator('[data-testid="source-link"]');
    const nLinks = await srcLinks.count();
    log('beck', '[LIVE]', 'B6 every source is a clickable <a> primary link', nLinks >= 1, `${nLinks} link(s)`);

    // collect + validate the golden story's source hrefs
    const hrefs = [];
    for (let i = 0; i < nLinks; i++) hrefs.push(await srcLinks.nth(i).getAttribute('href'));
    let allowlisted = nLinks > 0, blocked = false, sameOrigin = false;
    for (const h of hrefs) {
      const host = hostOf(h);
      if (!inList(host, PRIMARY_SOURCE_ALLOWLIST)) allowlisted = false;
      if (inList(host, OPINION_BLOCKLIST)) blocked = true;
      if (host === hostOf(BASE)) sameOrigin = true;
    }
    log('beck', '[LIVE]', 'B6 golden links resolve to allowlisted primary hosts (not opinion/same-origin)',
      allowlisted && !blocked && !sameOrigin, hrefs.map(hostOf).join(', '));

    // B6 [LIVE-net] reachability — bot-block (403/429) is inconclusive, not a fail
    let netVerdict = true, netDetail = '';
    for (const h of hrefs) {
      try {
        const res = await fetch(h, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 PigeonQC' }, signal: AbortSignal.timeout(8000) });
        netDetail += `${hostOf(h)}:${res.status} `;
        if (res.status === 404 || res.status === 410 || res.status >= 500) netVerdict = false;
        else if (res.status === 403 || res.status === 429) netVerdict = 'SKIP';
      } catch (e) {
        netDetail += `${hostOf(h)}:neterr `;
        if (netVerdict !== false) netVerdict = 'SKIP';
      }
    }
    log('beck', '[LIVE-net]', 'B6 primary links are live (not 404/dead)', netVerdict, netDetail.trim());

    // B2 [LIVE] expander reveals context, not methodology throat-clearing
    await golden.locator('[data-testid="dispatch-head"]').click();
    await page.waitForTimeout(150);
    const expanded = (await golden.locator('[data-testid="dispatch-head"]').getAttribute('aria-expanded')) === 'true';
    const drop = (await golden.locator('.dispatch-drop .drop-body').innerText().catch(() => '')).trim();
    const PREAMBLE = /Pigeon weighs|we weigh this against|our framing|court rulings are facts|never (a )?co-equal|methodology|we exclude|how we (forecast|rank|weight)/i;
    log('beck', '[LIVE]', 'B2 expander shows context, no methodology preamble',
      expanded && drop.length > 0 && !PREAMBLE.test(drop.slice(0, 200)), `expanded=${expanded}, len=${drop.length}`);

    // B8 [LIVE] front page is a big picture, not one-category noise
    const cats = [];
    const dn = Math.min(10, await page.locator('.dispatch').count());
    for (let i = 0; i < dn; i++) cats.push(await page.locator('.dispatch').nth(i).getAttribute('data-category'));
    const econRun = cats.filter((c) => c === 'economics').length;
    log('beck', '[LIVE]', 'B8 first 10 not economics-dominated (mixed big picture)', econRun < 6, `${econRun}/10 economics`);

    // ---- depth gates on the golden long form (Clark override) ----
    await page.goto(`${BASE}/story/${GOLDEN_ID}/`, { waitUntil: 'networkidle' });
    const ca = (await page.locator('.constitutional .body').innerText().catch(() => '')).trim();
    const caLow = ca.toLowerCase();

    // B3 [TARGET] constitutional analysis exists + leads with the founding ideal
    const firstSentence = ca.split(/(?<=[.!?])\s/)[0] + ' ' + (ca.split(/(?<=[.!?])\s/)[1] ?? '');
    log('beck', '[TARGET]', 'B3 constitutional analysis present + opens on the founding ideal',
      ca.length > 0 && /law and order|live in peace|domestic tranquility|founding|constitution|the founders/i.test(firstSentence),
      `caLen=${ca.length}`);

    // B4 [TARGET] founding-era precedent specific (≥2 of the set)
    const precedents = [
      /whiskey rebellion/i, /militia acts? of 1792/i, /article i.{0,6}(section|§)\s*8/i,
      /suppress insurrections|execute the laws of the union/i,
    ];
    const pHit = precedents.filter((re) => re.test(ca)).length;
    log('beck', '[TARGET]', 'B4 specific founding-era precedent present (≥2)', pHit >= 2, `${pHit}/4`);

    // B5 [TARGET] no modern-liberal ruling cited AS the constitutional authority
    const modernAuthority = /(controlling|the constitutional (standard|authority|measure)|the (other|opposing) side holds|co-equal)/i;
    const modernCourt = /\b(19[7-9]\d|20\d\d)\b.{0,40}(ruling|court|judge|injunction|ninth circuit|district court)/i;
    log('beck', '[TARGET]', 'B5 no modern-liberal ruling elevated to the measure',
      !(modernAuthority.test(ca) && modernCourt.test(ca)), '');

    // B7 [TARGET] full-text payoff: a non-same-origin allowlisted primary linkout on the long form
    const panelHrefs = await page.locator('.sources-panel a, .longform-link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    const realPrimary = panelHrefs.some((h) => h && hostOf(h) !== hostOf(BASE) && inList(hostOf(h), PRIMARY_SOURCE_ALLOWLIST));
    log('beck', '[TARGET]', 'B7 long form links to the document itself (non-same-origin primary)', realPrimary, panelHrefs.map(hostOf).join(', '));

    await ctx.close();
  }

  // ===========================================================================
  // PERSONA 2 — DR. LARRY ARNN (Churchill-scholar rigor)
  // ===========================================================================
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/story/${GOLDEN_ID}/`, { waitUntil: 'networkidle' });
    const ca = (await page.locator('.constitutional .body').innerText().catch(() => '')).trim();
    const sh = (await page.locator('.narr').allInnerTexts()).join(' ');

    // A1 [TARGET] Declaration–Constitution unity (principle + instrument)
    const principle = /natural rights|self-evident|unalienable|consent of the governed|domestic tranquility|law and order|declaration of independence/i;
    const instrument = /article i|article ii|militia clause|§\s*8|enumerated|clause 15|commander in chief/i;
    log('arnn', '[TARGET]', 'A1 Declaration→Constitution throughline (principle tied to instrument)',
      principle.test(ca) && instrument.test(ca), '');

    // A2 [TARGET] precedent accurate (right facts + right years)
    const whiskeyOk = /whiskey rebellion/i.test(ca) && /1794/.test(ca) && !/whiskey rebellion[^.]{0,12}179[0-35-9]/i.test(ca);
    const militiaOk = /militia acts? of 1792/i.test(ca);
    const clauseOk = /article i.{0,8}(§|section)\s*8.{0,16}(cl(ause)?\.?\s*15|15)/i.test(ca) || /execute the laws of the union, suppress insurrections/i.test(ca);
    log('arnn', '[TARGET]', 'A2 precedent accurate (Whiskey 1794 + Militia Acts 1792 + Art I §8 cl15)',
      whiskeyOk && militiaOk && clauseOk, `whiskey=${whiskeyOk} militia=${militiaOk} clause=${clauseOk}`);

    // A3 [TARGET] pop-history ABSENT (the Beck/Arnn reconciliation gate)
    const popHistory = /skousen|5,?000 year leap|28 (founding )?principles|providential/i;
    log('arnn', '[TARGET]', 'A3 debunked pop-history absent (sourced to the founding record)', !popHistory.test(ca + ' ' + sh), '');

    // A4 [TARGET] date precision: every 4-digit year in the analysis is in the founding/allowed set
    const ALLOWED_YEARS = new Set(['1776','1787','1788','1789','1790','1791','1792','1794','1795','1798','1807','1819','1878','1883','1905','1913','1926','1928','1933','1977','2020','2021','2025','2026']);
    const years = (ca.match(/\b\d{4}\b/g) ?? []);
    const badYears = years.filter((y) => !ALLOWED_YEARS.has(y));
    log('arnn', '[TARGET]', 'A4 no stray/wrong dates in the analysis', badYears.length === 0, badYears.length ? `bad: ${badYears.join(',')}` : `${years.length} years all valid`);

    // A5 [TARGET] depth, not gloss: ≥90 words + ≥2 named precedents/documents
    const words = ca.split(/\s+/).filter(Boolean).length;
    const namedDocs = [/whiskey rebellion/i, /militia acts/i, /posse comitatus/i, /federalist/i, /declaration of independence/i, /insurrection act/i, /constitution/i].filter((re) => re.test(ca)).length;
    log('arnn', '[TARGET]', 'A5 depth not gloss (≥90 words, ≥2 named precedents)', words >= 90 && namedDocs >= 2, `${words} words, ${namedDocs} named`);

    // A6 [TARGET] reasoned, not false-balance mush or slogan
    const connective = /because|therefore|the principle|which is why|the founders held|that is the founding|the line is/i;
    const falseBalance = /both sides|on the one hand.{0,40}on the other/i;
    log('arnn', '[TARGET]', 'A6 reasoned argument (connective present, no false-balance verdict, not a slogan)',
      connective.test(ca) && !falseBalance.test(ca) && words >= 25, '');

    // A7 [LIVE] plain-but-rigorous register
    const sentences = ca.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
    const avgLen = sentences.length ? words / sentences.length : 0;
    const academic = /heretofore|aforementioned|it must be noted that|in this analysis we/i;
    log('arnn', '[LIVE]', 'A7 plain register (avg sentence ≤ ~22 words, no academic throat-clearing)',
      ca.length === 0 ? false : avgLen <= 24 && !academic.test(ca), `avg=${avgLen.toFixed(1)} words/sentence`);

    await ctx.close();
  }

  // ===========================================================================
  // PERSONA 3 — THE ROOFER (comprehension is the hard floor; first jargon = quit)
  // ===========================================================================
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    let quit = false;
    try {
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      // R1 [LIVE] home headlines understandable on their face
      const homeLedes = await page.locator('.dispatch .lede').allInnerTexts();
      for (const t of homeLedes.slice(0, 10)) {
        const bad = bannedNakedToken(t);
        if (bad) { log('roofer', '[LIVE]', 'R1 home headlines understandable', false, `quit on "${bad}" in: ${t.slice(0, 60)}`); throw new RooferQuit(); }
      }
      log('roofer', '[LIVE]', 'R1 first 10 home headlines have no naked jargon', true, `${Math.min(10, homeLedes.length)} checked`);

      // R3a [LIVE] no EDGAR/CIK/8-K anywhere on the default home surface
      const homeText = await page.locator('main, .shell').innerText().catch(async () => await page.locator('body').innerText());
      const edgarHome = /\bEDGAR\b/.test(homeText) || /\(\d{7,10}\)\s*\(Filer\)/i.test(homeText) || /Form 8-?K filed/i.test(homeText);
      if (edgarHome) { log('roofer', '[LIVE]', 'R3 no filings/EDGAR on home', false, 'quit — EDGAR/8-K on home'); throw new RooferQuit(); }

      // R2 [LIVE] economics filter is comprehensible — THE quit step
      await page.locator('.chip', { hasText: 'Economics' }).click();
      await page.waitForTimeout(300);
      const econActive = /econ/i.test((await page.locator('.chip.active').innerText()).toLowerCase());
      const econCards = page.locator('.dispatch[data-category="economics"]');
      const ecount = await econCards.count();
      for (let i = 0; i < ecount; i++) {
        const card = econCards.nth(i);
        const lede = (await card.locator('.lede').innerText().catch(() => '')).trim();
        const plain = (await card.locator('[data-testid="econ-plain"]').innerText().catch(() => '')).trim();
        const why = (await card.locator('[data-testid="econ-why"]').innerText().catch(() => '')).trim();
        const block = `${lede} ${plain} ${why}`;
        const bad = bannedNakedToken(block);
        if (bad) { log('roofer', '[LIVE]', 'R2 economics filter comprehensible', false, `quit on "${bad}" in card ${i}: ${lede.slice(0, 50)}`); throw new RooferQuit(); }
        if (hasNumber(lede) && plain.length === 0) { log('roofer', '[LIVE]', 'R2 economics filter comprehensible', false, `quit — naked number, no wallet line: ${lede.slice(0, 50)}`); throw new RooferQuit(); }
      }
      log('roofer', '[LIVE]', 'R2 economics filter comprehensible (every number has a wallet line)', econActive && ecount > 0, `${ecount} econ cards, all glossed`);

      // R3b [LIVE] no EDGAR/8-K on the econ-filtered surface either
      const econText = await page.locator('.shell').innerText();
      const edgarEcon = /\bEDGAR\b/.test(econText) || /\b8-?K\b/.test(econText) || /\(\d{7,10}\)\s*\(Filer\)/i.test(econText);
      log('roofer', '[LIVE]', 'R3 no filings/CIK/EDGAR on home or econ filter', !edgarHome && !edgarEcon, '');

      // R6 [TARGET] top econ card has both a "What it means" and a "Why" layer
      const top = econCards.first();
      const topPlain = (await top.locator('[data-testid="econ-plain"]').innerText().catch(() => '')).trim();
      const topWhy = (await top.locator('[data-testid="econ-why"]').innerText().catch(() => '')).trim();
      log('roofer', '[TARGET]', 'R6 top econ item has What-it-means + Why layers', /what it means/i.test(topPlain) && /^why/i.test(topWhy), '');

      // R5 [TARGET] term translated on first use (Fed funds / S&P / CPI as present)
      const allEcon = (await page.locator('.dispatch[data-category="economics"]').allInnerTexts()).join(' ');
      const fedOk = !/fed'?s? interest rate|fed funds|federal reserve/i.test(allEcon) || /mortgage|car loan|credit-card/i.test(allEcon);
      log('roofer', '[TARGET]', 'R5 economics terms glossed on first use', fedOk, '');

      // R4 [LIVE] weekly markets strip is plain
      await page.goto(BASE + '/weekly/', { waitUntil: 'networkidle' });
      const mkts = page.locator('.mkt');
      const mn = await mkts.count();
      let allGlossed = mn > 0, badLabel = false;
      for (let i = 0; i < mn; i++) {
        const val = (await mkts.nth(i).locator('.mkt-val').innerText().catch(() => '')).trim();
        const plain = (await mkts.nth(i).locator('.mkt-plain').innerText().catch(() => '')).trim();
        const label = (await mkts.nth(i).locator('.mkt-label').innerText().catch(() => '')).trim();
        if (val && plain.length === 0) allGlossed = false;
        if (/^\^?[A-Z]{1,5}$/.test(label)) badLabel = true;
      }
      const note = (await page.locator('.markets-note').innerText().catch(() => '')).trim();
      const noteLeak = /predictive model|FRED|Finnhub|API_?KEY|gauges feed/i.test(note);
      log('roofer', '[LIVE]', 'R4 weekly markets plain (every value glossed, plain labels, no internal-process note)',
        allGlossed && !badLabel && !noteLeak, `${mn} gauges, noteLeak=${noteLeak}`);
    } catch (e) {
      if (e instanceof RooferQuit) { quit = true; }
      else throw e;
    }
    if (quit) console.log('  --- roofer ABANDONED the app (hard fail) ---');
    await ctx.close();
  }

  await browser.close();

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} assertions passed across 3 reader personas (Beck / Arnn / roofer).`);
  if (passed !== total) process.exit(1);
}

console.log(`\n PIGEON READER-PERSONA QC  ·  ${BASE}\n`);
run().catch((e) => {
  console.error('reader-persona run crashed:', e);
  process.exit(1);
});
