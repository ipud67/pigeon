// lib/ingestion/opinion-filter.ts
//
// Title-suffix opinion filter (editorial ruling, internal record).
//
// Jerusalem Post and Times of Israel mix news and opinion in one undifferentiated RSS feed,
// but both outlets reliably self-tag opinion/editorial/analysis items with a suffix in the
// TITLE field itself. Research's live samples (2026-07-21):
// "Israel has a right to defend itself on the information battlefield too - editorial"
// "Conscience or convenience: What's behind Israel's recognition of Armenian Genocide? -opinion"
//
// This strips those items BEFORE ingestion — it runs inside the source adapter, not the
// classifier gate (the mock gate's OPINION_MARKERS list has no concept of this suffix
// convention, so an unfiltered item would sail straight through as event_report).
//
// Matches the SUFFIX only: a space, then a dash, then an optional space, then the marker
// word, then end-of-string. A legitimate headline that merely CONTAINS "analysis" or
// "opinion" mid-sentence (no dash immediately before it, or not at the end) is never
// dropped — that distinction is the whole point of a per-item, not per-outlet, filter.

const OPINION_SUFFIX_RE = /\s-\s?(editorial|opinion|analysis)\s*$/i;

export function isOpinionSuffixed(title: string): boolean {
 return OPINION_SUFFIX_RE.test(title.trim());
}

// Drops items whose title carries the suffix. Generic over anything with a `.title`.
export function stripOpinionSuffixed<T extends { title: string }>(items: T[]): T[] {
 return items.filter((item) => !isOpinionSuffixed(item.title));
}
