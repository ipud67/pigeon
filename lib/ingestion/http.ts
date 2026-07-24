// lib/ingestion/http.ts
//
// Shared fetch + RSS/Atom parsing for ingestion. Free endpoints only. Every request gets a
// browser-realistic User-Agent. Failures degrade gracefully — a source that errors returns
// [] and logs; it never crashes the run.

import { XMLParser } from 'fast-xml-parser';

// UA CHOICE (2026-07-21, Research source-roster-rulings): the prior default was a self-
// identifying bot string (`PigeonNews/1.0 (+https://...)`). Research found live that Politico
// 403s that string and 200s a Chrome-like UA — a pure UA-fingerprint block, not an IP or
// rate block. CBC failed once and then succeeded on retry with no other change, which is
// the same lesson from the other direction: "failed once" is not "dead," and a naive UA is
// itself a source of false negatives. Government endpoints that reject blank UAs (e.g. SEC)
// have always required *a* UA, not specifically the old bot string, so this is a safe
// across-the-board default. Override via PIGEON_UA if a specific endpoint ever needs it.
export const UA =
 process.env.PIGEON_UA ??
 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
 const ctrl = new AbortController();
 const t = setTimeout(() => ctrl.abort(), timeoutMs);
 try {
 const res = await fetch(url, {
 headers: { 'User-Agent': UA, Accept: 'application/json, application/xml, text/xml, */*' },
 signal: ctrl.signal,
 });
 if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
 return await res.text();
 } finally {
 clearTimeout(t);
 }
}

export async function fetchJson<T = unknown>(url: string, timeoutMs = 20000): Promise<T> {
 const text = await fetchText(url, timeoutMs);
 return JSON.parse(text) as T;
}

const parser = new XMLParser({
 ignoreAttributes: false,
 attributeNamePrefix: '@_',
 trimValues: true,
 cdataPropName: '__cdata',
});

export type FeedEntry = {
 title: string;
 link: string;
 summary: string;
 published: string; // raw date string
};

function asText(v: unknown): string {
 if (v == null) return '';
 if (typeof v === 'string') return v;
 if (typeof v === 'object') {
 const o = v as Record<string, unknown>;
 if (typeof o.__cdata === 'string') return o.__cdata;
 if (typeof o['#text'] === 'string') return o['#text'];
 }
 return String(v);
}

function atomLink(links: unknown): string {
 // Atom <link> can be an array of {@_href,@_rel} or a single object.
 const arr = Array.isArray(links) ? links : [links];
 const alt = arr.find((l) => (l as Record<string, unknown>)?.['@_rel'] === 'alternate');
 const pick = (alt ?? arr[0]) as Record<string, unknown> | undefined;
 return typeof pick?.['@_href'] === 'string' ? (pick['@_href'] as string) : '';
}

// Parse either RSS 2.0 or Atom into a flat entry list.
export function parseFeed(xml: string): FeedEntry[] {
 let doc: Record<string, unknown>;
 try {
 doc = parser.parse(xml) as Record<string, unknown>;
 } catch {
 return [];
 }

 // RSS 2.0
 const rss = doc.rss as Record<string, unknown> | undefined;
 if (rss) {
 const channel = rss.channel as Record<string, unknown> | undefined;
 const items = channel?.item;
 const arr = Array.isArray(items) ? items : items ? [items] : [];
 return arr.map((it) => {
 const o = it as Record<string, unknown>;
 return {
 title: asText(o.title),
 link: asText(o.link),
 summary: asText(o.description) || asText(o['content:encoded']),
 published: asText(o.pubDate) || asText(o['dc:date']),
 };
 });
 }

 // Atom
 const feed = doc.feed as Record<string, unknown> | undefined;
 if (feed) {
 const entries = feed.entry;
 const arr = Array.isArray(entries) ? entries : entries ? [entries] : [];
 return arr.map((it) => {
 const o = it as Record<string, unknown>;
 return {
 title: asText(o.title),
 link: atomLink(o.link),
 summary: asText(o.summary) || asText(o.content),
 published: asText(o.updated) || asText(o.published),
 };
 });
 }

 return [];
}

// Normalize any date string to ISO 8601; fall back to now if unparseable.
export function toIso(raw: string): string {
 if (!raw) return new Date().toISOString();
 const d = new Date(raw);
 return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Entity handling was a hand-written list of five, so anything outside it reached the reader
// raw. The live front page on 2026-07-22 carried "&#160;" and "[&#8230;]" in the lead story's
// opening line. Decoded generically instead: named entities we actually see, then ALL numeric
// entities (decimal and hex) by code point, so a sixth entity never ships as literal text.
const NAMED_ENTITIES: Record<string, string> = {
 nbsp: ' ',
 amp: '&',
 quot: '"',
 apos: "'",
 lt: '<',
 gt: '>',
 hellip: '…',
 mdash: '—',
 ndash: '–',
 lsquo: '‘',
 rsquo: '’',
 ldquo: '“',
 rdquo: '”',
};

// Feed boilerplate that is not part of the report. WordPress-backed government feeds append a
// syndication footer to every item ("The post <title> appeared first on The White House."),
// which was being published as though it were the dispatch's closing sentence.
const FEED_BOILERPLATE = [
 /\s*The post\b[\s\S]*?appeared first on[^.]*\.\s*/gi,
 /\s*\[\s*…\s*\]\s*$/g,
 /\s*Read more\s*(→|>>|\.\.\.)?\s*$/gi,
 /\s*Continue reading\b[^.]*\.\s*$/gi,
];

export function decodeEntities(s: string): string {
 return s
 .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
 .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
 .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[String(name).toLowerCase()] ?? m);
}

export function stripHtml(s: string): string {
 let out = decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' '));
 for (const re of FEED_BOILERPLATE) out = out.replace(re, ' ');
 return out.replace(/\s+/g, ' ').trim();
}
