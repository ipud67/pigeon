// lib/ingestion/sources.ts
//
// Source adapters for the locked free primary spine (SPEC §4 / MASTER_PLAN ) plus the
// economics primaries. Each adapter fetches a REAL free endpoint and normalizes to
// RawItem[]. Each is wrapped by the orchestrator in try/catch so one failing source never
// stops the run. No paid wires. No API keys.
//
// GDELT is wired as a DETECTION RADAR only (SPEC §6.1): it surfaces that an event happened;
// we tier its items T3_factslice (high editorial bar) and publish from the primary link.

import type { RawItem } from '../types';
import type { SourceTier } from '../llm/provider';
import { fetchJson, fetchText, parseFeed, toIso, stripHtml } from './http';
import { stripOpinionSuffixed } from './opinion-filter';

export type SourceResult = { source: string; items: RawItem[]; ok: boolean; note?: string };

const MAX_PER_SOURCE = 25;

function sleep(ms: number) {
 return new Promise((r) => setTimeout(r, ms));
}

// ---- 1. Federal Register (JSON API) — government action -----------------------
export async function federalRegister(): Promise<RawItem[]> {
 const fields = ['title', 'type', 'abstract', 'html_url', 'publication_date', 'agencies']
 .map((f) => `fields[]=${f}`)
 .join('&');
 const url = `https://www.federalregister.gov/api/v1/documents.json?${fields}&per_page=${MAX_PER_SOURCE}&order=newest`;
 const data = await fetchJson<{ results?: Array<Record<string, unknown>> }>(url);
 const results = data.results ?? [];
 return results.map((r) => {
 const type = String(r.type ?? 'Document');
 const title = String(r.title ?? '').trim();
 const abstract = String(r.abstract ?? '').trim();
 const agencies = Array.isArray(r.agencies)
 ? (r.agencies as Array<Record<string, unknown>>).map((a) => String(a.name ?? '')).filter(Boolean)
 : [];
 const tier: SourceTier = type.includes('Presidential') ? 'T1_gov' : 'T1_gov';
 return {
 outlet: 'Federal Register',
 tier,
 url: String(r.html_url ?? ''),
 title: `${title}`,
 body: `${type}. ${abstract || title}${agencies.length ? ` (${agencies.join(', ')})` : ''}`,
 datetime_utc: toIso(String(r.publication_date ?? '')),
 };
 });
}

// ---- 2. White House — presidential actions (RSS) ------------------------------
export async function whiteHouse(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.whitehouse.gov/presidential-actions/feed/');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'White House',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 3. SEC EDGAR — latest 8-K filings (Atom) — economics primary -------------
export async function secEdgar(): Promise<RawItem[]> {
 const xml = await fetchText(
 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom&count=40',
 );
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'SEC EDGAR',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: `Form 8-K filed with the SEC. ${stripHtml(e.title)}`,
 datetime_utc: toIso(e.published),
 }));
}

// ---- 4. Federal Reserve — monetary policy press (RSS) — economics primary ------
export async function federalReserve(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.federalreserve.gov/feeds/press_monetary.xml');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'Federal Reserve',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 5. Bureau of Labor Statistics — major economic indicators (RSS) ----------
export async function bls(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.bls.gov/feed/bls_latest.rss');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'Bureau of Labor Statistics',
 tier: 'T1_gov' as SourceTier,
 url: e.link || 'https://www.bls.gov/',
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 6. UN Press — meetings & press releases (RSS) — world --------------------
export async function unPress(): Promise<RawItem[]> {
 const xml = await fetchText('https://press.un.org/en/rss.xml');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'UN Press',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 7. CourtListener — SCOTUS opinions (Atom; public RSS, no auth) — courts ---
export async function courtListener(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.courtlistener.com/feed/court/scotus/');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'Supreme Court (CourtListener)',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: `Supreme Court opinion. ${stripHtml(e.summary) || stripHtml(e.title)}`,
 datetime_utc: toIso(e.published),
 }));
}

// ---- 8. GDELT — DETECTION RADAR ONLY (JSON). Hard 1-req/5s limit (Research). ------
// Runs LAST in the registry and retries once after the throttle window, since a 429 is
// GDELT's own rate-limit notice (endpoint alive), not a dead source.
// Query widened 2026-07-21 (source-roster-rulings): the original 5 keywords (sanctions,
// ceasefire, "executive order", tariffs, treaty) contain no war or energy terms at all —
// structurally incapable of detecting an active war ("US strikes Iran for a 9th night") or
// a gas-price story. Existing terms kept; conflict + energy terms added.
// GDELT radar pulls wide then filters hard, so it does NOT use MAX_PER_SOURCE. The API's
// documented max is 250 (default 75); we were asking for 25 — less than we'd have got by
// passing nothing at all.
const GDELT_MAX_RECORDS = 250;
const GDELT_KEEP = 75;

// GDELT indexes the whole open web, not a newswire. Even a correct query returns product
// roundups and hobby sites that matched a keyword in a non-news sense — the live probe on
// 2026-07-23 returned outdoorlife.com "This Long Forgotten Tactic Catches Bass" on the word
// "strike". This denylist is a coarse first cut ONLY. The real fix is semantic relevance
// scoring (the embedding layer), because a lexical rule cannot tell a bass strike from an
// airstrike — which is the same limit that makes the ranking engine brittle.
const GDELT_DENY_DOMAIN =
 /\b(outdoorlife|fieldandstream|bassmaster|espn|goal|sportskeeda|tripadvisor|yelp|groupon|coupons?|deals?|shopping|etsy|pinterest|fandom|wikihow|quora|medium|substack|patch|prnewswire|globenewswire|businesswire|accesswire|einpresswire|openpr|marketscreener|simplywall|zacks|fool|investing|benzinga|stocktwits)\./i;

export async function gdelt(): Promise<RawItem[]> {
 // sourcelang is a QUERY-STRING OPERATOR, not a URL parameter.
 //
 // This was wrong from the day it was written: the URL carried `&sourcelang=eng`, which the
 // DOC 2.0 API does not recognise and silently ignores (it does not error). The language
 // filter therefore never applied — a 2026-07-23 probe of the exact live URL returned a
 // Chinese-language gold-trading site as result #1 and sputniknews.cn as #2. A "detection
 // radar" was scanning the Chinese and Russian web.
 //
 // Correct syntax puts the operator inside the query text (docs: DOC 2.0 API debut post).
 // Measured on the same query, same minute: broken = 25 records, mixed-language;
 // corrected = 75 records, 75/75 English.
 const query = encodeURIComponent(
 '(sanctions OR ceasefire OR "executive order" OR tariffs OR treaty OR strike OR airstrike OR attack OR war OR blockade OR missile OR invasion OR offensive OR oil OR crude OR "oil price" OR "gas prices") sourcelang:english',
 );
 // sort is explicit: the default ordering is relevance-flavoured, and a detection radar
 // wants newest-first so a breaking event surfaces before an older better-matching one.
 const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=${GDELT_MAX_RECORDS}&format=json&timespan=2d&sort=DateDesc`;
 let data: { articles?: Array<Record<string, unknown>> } | null = null;
 try {
 data = await fetchJson(url);
 } catch {
 try {
 await sleep(7000); // respect the documented 1-req/5s limit, then one retry
 data = await fetchJson(url);
 } catch {
 // Still failing (persistent 429, or GDELT down) after the cooloff. GDELT is a
 // radar-only detection source, never load-bearing — degrade quietly to an empty
 // pull so this reports as "0 items" (a warning) at the orchestrator level, not a
 // thrown error that reads like a crash.
 return [];
 }
 }
 const arts = data?.articles ?? [];
 return arts
 .filter((a) => {
 // Belt-and-braces on language: the operator is applied server-side now, but GDELT
 // stamps each article with its detected language and a silent regression here is
 // exactly the failure we just spent a month not noticing. Check the data, not the URL.
 const lang = String(a.language ?? '').toLowerCase();
 if (lang && lang !== 'english') return false;
 return !GDELT_DENY_DOMAIN.test(String(a.domain ?? ''));
 })
 .slice(0, GDELT_KEEP)
 .map((a) => ({
 outlet: String(a.domain ?? 'GDELT'),
 // Radar tier — high editorial bar. GDELT detects; we publish from the primary link.
 tier: 'T3_factslice' as SourceTier,
 url: String(a.url ?? ''),
 title: stripHtml(String(a.title ?? '')),
 body: stripHtml(String(a.title ?? '')),
 datetime_utc: toIso(String(a.seendate ?? '')),
 }));
}

// ---- 9. DoD press releases (RSS) — defense ------------------------------------
// NOTE: defense.gov fronts behind Akamai and 403s/blank-bodies programmatic clients from
// some networks. Wired per the locked spine; degrades to [] when blocked.
export async function dod(): Promise<RawItem[]> {
 const xml = await fetchText(
 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=20',
 );
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'U.S. Dept. of Defense',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 10. U.S. Treasury press releases (RSS) — economics primary ----------------
// NOTE: home.treasury.gov press feed returns an HTML block page to programmatic clients
// from some networks. Wired per the locked spine; degrades to [] when blocked.
export async function treasury(): Promise<RawItem[]> {
 const xml = await fetchText('https://home.treasury.gov/system/files/126/press_releases.xml');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'U.S. Treasury',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 11. UK Parliament Hansard — verbatim debate record (API) — world ----------
// Corrected to Research's verified endpoint: /search/debates.json (the /overview + /sittings
// paths 404). Needs a search term; we use a broad high-signal term and degrade gracefully.
export async function ukHansard(): Promise<RawItem[]> {
 const url =
 'https://hansard-api.parliament.uk/search/debates.json?queryParameters.searchTerm=government&queryParameters.take=20&queryParameters.orderBy=SittingDateDesc';
 const data = await fetchJson<{ Results?: Array<Record<string, unknown>> }>(url);
 const rows = data.Results ?? [];
 return rows.slice(0, MAX_PER_SOURCE).map((r) => {
 const title = stripHtml(String(r.Title ?? r.DebateSection ?? 'Commons debate'));
 return {
 outlet: 'UK Hansard',
 tier: 'T1_gov' as SourceTier,
 url:
 typeof r.DebateSectionExtId === 'string'
 ? `https://hansard.parliament.uk/Commons/debates/${r.DebateSectionExtId}`
 : 'https://hansard.parliament.uk/',
 title,
 body: `UK Parliament (Hansard) verbatim record. ${title}`,
 datetime_utc: toIso(String(r.SittingDate ?? '')),
 };
 });
}

// ---- 12. White House — news / statements (RSS) — broader gov surface (Research) ----
export async function whiteHouseNews(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.whitehouse.gov/news/feed/');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'White House',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 13. U.S. Treasury — auctions (FiscalData API) — economics primary (Research) --
// Treasury PRESS has no feed; Treasury DATA does. Auction results are a money-flow tell
// (demand for US debt) for the economics standing lens + PREDICT.
export async function treasuryAuctions(): Promise<RawItem[]> {
 const url =
 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query?page[size]=20&sort=-auction_date';
 const data = await fetchJson<{ data?: Array<Record<string, unknown>> }>(url);
 const rows = data.data ?? [];
 return rows.slice(0, MAX_PER_SOURCE).map((r) => {
 const term = String(r.security_term ?? '');
 const type = String(r.security_type ?? 'Treasury security');
 const date = String(r.auction_date ?? '');
 const high = r.high_yield ? `, high yield ${r.high_yield}%` : '';
 const btc = r.bid_to_cover_ratio ? `, bid-to-cover ${r.bid_to_cover_ratio}` : '';
 return {
 outlet: 'U.S. Treasury',
 tier: 'T1_gov' as SourceTier,
 url: 'https://www.treasurydirect.gov/auctions/auction-query/',
 title: `U.S. Treasury auctions ${term} ${type}`.replace(/\s+/g, ' ').trim(),
 body: `Treasury auction settled ${date}${high}${btc}. Demand for U.S. debt is a money-flow indicator.`,
 datetime_utc: toIso(date),
 };
 });
}

// ---- 14. BLS — Employment Situation / jobs report (Atom) — economics primary ----
export async function blsJobs(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.bls.gov/feed/empsit.rss');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'Bureau of Labor Statistics',
 tier: 'T1_gov' as SourceTier,
 url: e.link || 'https://www.bls.gov/',
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 15. GovInfo — Compilation of Presidential Documents (RSS) — redundancy ------
// GPO's official presidential-documents stream; a durable backstop for the CMS-driven
// WhiteHouse.gov feeds (Research: WH paths can drift).
export async function govInfo(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.govinfo.gov/rss/dcpd.xml');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'GovInfo (GPO)',
 tier: 'T2_indie' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 16. European Commission — press corner (RSS) — world (Research scope-expansion P2) -------
// World-government primary: official EU statements, matching the US-gov tier for another
// balance-of-power player. Keyless, LIVE.
export async function euCommission(): Promise<RawItem[]> {
 const xml = await fetchText('https://ec.europa.eu/commission/presscorner/api/rss?language=en');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'European Commission',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 17. UK Government — news & communications (Atom) — world (Research scope-expansion P2) ----
// Official gov.uk announcements firehose; primary UK-government statements. Keyless, LIVE.
export async function govUkNews(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.gov.uk/search/news-and-communications.atom');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'UK Government',
 tier: 'T1_gov' as SourceTier,
 url: e.link.startsWith('http') ? e.link : `https://www.gov.uk${e.link}`,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 18. AP Business wire (RSS) — markets / economics news (Research scope-expansion P1) -------
// Wire-grade market reporting (earnings, M&A, market moves) — carried per the editorial
// standard (wire = fact). NOTE: AP's public feeds 401/403 programmatic clients from many
// networks; wired per the registry but degrades to [] when blocked (honest: not load-bearing).
export async function apBusiness(): Promise<RawItem[]> {
 const xml = await fetchText('https://apnews.com/hub/business?outputType=rss');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'AP',
 tier: 'T1_wire' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 19. France 24 English (RSS) — war / world / head-of-government transitions ----------
// Research 2026-07-21 (source-roster-rulings): single highest-priority addition — the one feed
// that surfaced the UK PM-transition headline in Research's live sample. State-funded (like
// BBC/DW) but Timn's Al Jazeera objection is to AJ's specific editorial alignment, NOT state
// funding as a category — France24 is not disqualified on that basis.
export async function france24(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.france24.com/en/rss');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'France 24',
 tier: 'T1_wire' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 20. AAA Gas Prices (RSS) — energy / pump-price bulletins ----------------------------
// Non-profit motor-club trade association publishing price-average data meant for media
// pickup. Cleanest fix for the "0 gasoline records" finding (Research 2026-07-21).
export async function aaaGasPrices(): Promise<RawItem[]> {
 const xml = await fetchText('https://gasprices.aaa.com/feed/');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'AAA',
 tier: 'T2_indie' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 21. EIA — Today in Energy (RSS) — energy, primary/public-domain data ----------------
// A different job than the existing gov-press-release roster: data/analysis publication,
// not an announcement of an action. Supplements AAA (#20), does not substitute for it.
export async function eiaEnergy(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.eia.gov/rss/todayinenergy.xml');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'U.S. Energy Information Administration',
 tier: 'T1_gov' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 22. Ukrainska Pravda, English edition (RSS) — Ukraine war coverage ------------------
// Closes a war-coverage gap Pigeon had zero visibility into beyond incidental UN/EU mentions.
export async function ukrainskaPravda(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.pravda.com.ua/eng/rss/');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'Ukrainska Pravda',
 tier: 'T2_indie' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 23. The Hill (RSS) — US domestic politics / Congress -------------------------------
export async function theHill(): Promise<RawItem[]> {
 const xml = await fetchText('https://thehill.com/feed');
 return parseFeed(xml)
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'The Hill',
 tier: 'T2_indie' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 24. Jerusalem Post — frontpage (RSS) — Israeli cross-reference (AJ radar rule) ------
// CONDITIONAL on the title-suffix opinion filter (product ruling, source-roster-rulings):
// JPost reliably self-tags opinion/editorial content with a "- editorial" / "-opinion" /
// "-analysis" title suffix. Stripped BEFORE ingestion, not left to the classifier gate.
export async function jerusalemPost(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.jpost.com/rss/rssfeedsfrontpage.aspx');
 return stripOpinionSuffixed(parseFeed(xml))
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'Jerusalem Post',
 tier: 'T2_indie' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// ---- 25. Times of Israel (RSS) — Israeli cross-reference (AJ radar rule) ----------------
// Same conditional-on-filter posture as Jerusalem Post above.
export async function timesOfIsrael(): Promise<RawItem[]> {
 const xml = await fetchText('https://www.timesofisrael.com/feed/');
 return stripOpinionSuffixed(parseFeed(xml))
 .slice(0, MAX_PER_SOURCE)
 .map((e) => ({
 outlet: 'Times of Israel',
 tier: 'T2_indie' as SourceTier,
 url: e.link,
 title: stripHtml(e.title),
 body: stripHtml(e.summary) || stripHtml(e.title),
 datetime_utc: toIso(e.published),
 }));
}

// The registry. 10-source spine + economics primaries (Research feed-registry-v1 corrected) +
// the v2 scope expansion: EU + UK gov primaries (world), AP Business (markets news) +
// the 2026-07-21 coverage-gap expansion (France24, AAA, EIA, Ukrainska Pravda, The Hill,
// JPost, TOI — the source-roster ruling record). Market PRICE data (yields,
// 2s10s, indices, VIX, oil) flows through the separate MarketSnapshot
// (lib/ingestion/markets.ts), not this headline registry.
// GDELT runs LAST (its 1-req/5s limit means giving it the most slack before the call).
export const SOURCES: Array<{ name: string; fn: () => Promise<RawItem[]>; throttleMs?: number }> = [
 { name: 'Federal Register', fn: federalRegister },
 { name: 'White House (actions)', fn: whiteHouse },
 { name: 'White House (news)', fn: whiteHouseNews },
 { name: 'GovInfo (presidential docs)', fn: govInfo },
 { name: 'SEC EDGAR 8-K', fn: secEdgar },
 { name: 'U.S. Treasury (press)', fn: treasury },
 { name: 'U.S. Treasury (auctions)', fn: treasuryAuctions },
 { name: 'U.S. Dept. of Defense', fn: dod },
 { name: 'Federal Reserve (FOMC)', fn: federalReserve },
 { name: 'UK Hansard', fn: ukHansard },
 { name: 'UN Security Council / Press', fn: unPress },
 { name: 'CourtListener (SCOTUS)', fn: courtListener },
 { name: 'Bureau of Labor Statistics (CPI/PPI)', fn: bls },
 { name: 'Bureau of Labor Statistics (jobs)', fn: blsJobs },
 { name: 'European Commission (press)', fn: euCommission },
 { name: 'UK Government (gov.uk)', fn: govUkNews },
 { name: 'AP Business (wire)', fn: apBusiness },
 { name: 'France 24', fn: france24 },
 { name: 'AAA Gas Prices', fn: aaaGasPrices },
 { name: 'EIA (Today in Energy)', fn: eiaEnergy },
 { name: 'Ukrainska Pravda', fn: ukrainskaPravda },
 { name: 'The Hill', fn: theHill },
 { name: 'Jerusalem Post', fn: jerusalemPost },
 { name: 'Times of Israel', fn: timesOfIsrael },
 { name: 'GDELT (radar)', fn: gdelt, throttleMs: 6000 },
];
