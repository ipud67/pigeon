// lib/editorial/fullevent.ts
//
// FULL EVENT tagging (product ruling 2026-07-02). A full event is a source item that IS
// the complete event artifact — the whole press briefing, press conference, transcript,
// hearing, or oral argument, start to finish. Not a story ABOUT an event; the event itself.
//
// PRECISION OVER RECALL. A mislabeled "full event" is worse than a missed one, so every
// rule is gated per-domain: a keyword only fires on the host where it reliably means the
// artifact is complete. There is deliberately NO generic fallback — e.g. a Federal Register
// "notice of public hearing" is an announcement OF a hearing, not the hearing, and
// WhiteHouse.gov /briefings-statements/ URLs carry presidential MESSAGES, not briefings,
// so neither matches here.
//
// Used in two places:
// 1. ingest (lib/ingestion/run.ts) — tags new fact records as they are built.
// 2. read time (lib/store.ts) — backfills the committed dataset without a re-ingest,
// which keeps Research's depth-override fact ids stable (no id rotation).

import type { FactRecord, FullEvent, FullEventKind } from '../types';

type Probe = {
 outlet: string;
 url: string;
 title: string;
 paywalled?: boolean;
};

const KIND_LABEL: Record<FullEventKind, string> = {
 press_briefing: 'Press briefing — full record',
 press_conference: 'Press conference — full record',
 remarks: 'Full remarks',
 transcript: 'Full record',
 hearing: 'Hearing — full record',
 oral_argument: 'Court argument — full record',
};

function host(url: string): string {
 try {
 return new URL(url).hostname.replace(/^www\./, '');
 } catch {
 return '';
 }
}

const onHost = (h: string, domain: string) => h === domain || h.endsWith('.' + domain);

// Per-domain rules. Each returns a kind (and optional label override) only when the item
// is reliably the complete artifact.
function match(p: Probe): { kind: FullEventKind; label?: string } | undefined {
 const h = host(p.url);
 const t = p.title;

 // UN Press — daily briefings + press conferences are full-session records.
 if (onHost(h, 'press.un.org')) {
 if (/\bpress briefing\b/i.test(t)) return { kind: 'press_briefing' };
 if (/\bpress conference\b/i.test(t)) return { kind: 'press_conference' };
 return undefined;
 }

 // White House — briefing-room briefings + full remarks. Title keywords gate; the
 // /briefings-statements/ path alone does NOT (it carries messages/statements).
 if (onHost(h, 'whitehouse.gov')) {
 if (/\bpress briefing\b/i.test(t) || /\/briefing-room\/press-briefings\//i.test(p.url))
 return { kind: 'press_briefing' };
 if (/\bpress conference\b/i.test(t)) return { kind: 'press_conference' };
 if (/^remarks (by|at|of)\b/i.test(t) || /\/briefing-room\/speeches-remarks\//i.test(p.url))
 return { kind: 'remarks' };
 return undefined;
 }

 // DoD — the /transcripts/ path IS the verbatim artifact; press-event titles also gate.
 if (onHost(h, 'defense.gov') || onHost(h, 'war.gov')) {
 if (/\/transcripts?\//i.test(p.url)) return { kind: 'transcript' };
 if (/\b(press briefing|press conference|media availability)\b/i.test(t))
 return { kind: 'press_briefing' };
 return undefined;
 }

 // Federal Reserve — FOMC press conference materials.
 if (onHost(h, 'federalreserve.gov')) {
 if (/\bpress conference\b/i.test(t) || /fomcpresconf/i.test(p.url))
 return { kind: 'press_conference' };
 return undefined;
 }

 // Courts — oral arguments only (an opinion is a document, not an event artifact).
 if (onHost(h, 'supremecourt.gov') || onHost(h, 'courtlistener.com') || onHost(h, 'oyez.org')) {
 if (/\boral argument\b/i.test(t) || /oral[_-]argument/i.test(p.url))
 return { kind: 'oral_argument' };
 return undefined;
 }

 // UK Hansard — a /debates/ page is by definition the complete verbatim record of the
 // proceeding (Parliament's official word-for-word record).
 if (onHost(h, 'hansard.parliament.uk')) {
 if (/\/debates\//i.test(p.url))
 return { kind: 'transcript', label: 'Parliament debate — full record' };
 return undefined;
 }

 // Congress — committee hearings.
 if (onHost(h, 'congress.gov') || h.endsWith('.senate.gov') || h.endsWith('.house.gov')) {
 if (/\bhearing\b/i.test(t)) return { kind: 'hearing' };
 return undefined;
 }

 return undefined;
}

// Tag a single source item (used at ingest).
export function detectFullEvent(p: Probe): FullEvent | undefined {
 if (!p.url || !p.title) return undefined;
 const m = match(p);
 if (!m) return undefined;
 return {
 kind: m.kind,
 label: m.label ?? KIND_LABEL[m.kind],
 url: p.url,
 outlet: p.outlet,
 paywalled: p.paywalled,
 };
}

// Backfill for an already-built fact record (used at read time on the committed dataset).
// Scans every clustered source linkout; first precise match wins.
export function deriveFullEvent(f: FactRecord): FullEvent | undefined {
 if (f.full_event) return f.full_event;
 for (const s of f.sources) {
 const fe = detectFullEvent({ outlet: s.outlet, url: s.url, title: f.what, paywalled: s.paywalled });
 if (fe) return fe;
 }
 return undefined;
}
