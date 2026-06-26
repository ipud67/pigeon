// lib/ingestion/http.ts
//
// Shared fetch + RSS/Atom parsing for ingestion. Free endpoints only. Every government
// endpoint gets a polite User-Agent (some, e.g. SEC, reject blank UAs). Failures degrade
// gracefully — a source that errors returns [] and logs; it never crashes the run.

import { XMLParser } from 'fast-xml-parser';

export const UA =
  process.env.PIGEON_UA ??
  'PigeonNews/1.0 (+https://creatusdesign.dev; contact pigeon@creatusdesign.dev)';

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

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&#x2019;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
