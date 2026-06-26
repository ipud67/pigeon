// lib/ingestion/dedup.ts
//
// Three-layer dedup (SPEC §6.5), v1 implementation: URL-hash exact match + headline
// token-set near-match. (Semantic clustering is deferred to the Grok/embedding phase.)
// One event hit by N sources collapses to one record carrying N source linkouts.

import { createHash } from 'node:crypto';
import type { RawItem } from '../types';

export function stableId(url: string, title: string): string {
  return createHash('sha1').update(`${url}::${title}`).digest('hex').slice(0, 12);
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSet(t: string): Set<string> {
  return new Set(normalizeTitle(t).split(' ').filter((w) => w.length > 3));
}

// Jaccard similarity over title token sets.
function similar(a: string, b: string): boolean {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return inter / union >= 0.6;
}

export type Cluster = { primary: RawItem; members: RawItem[] };

export function clusterItems(items: RawItem[]): Cluster[] {
  const clusters: Cluster[] = [];
  const seenUrls = new Set<string>();

  for (const item of items) {
    if (item.url && seenUrls.has(item.url)) continue;
    if (item.url) seenUrls.add(item.url);

    const existing = clusters.find((c) => similar(c.primary.title, item.title));
    if (existing) {
      existing.members.push(item);
      // Prefer the higher-tier (lower-number) source as the primary linkout.
      const tierRank: Record<string, number> = {
        T1_wire: 0,
        T1_gov: 1,
        T2_indie: 2,
        T3_factslice: 3,
      };
      if (tierRank[item.tier] < tierRank[existing.primary.tier]) existing.primary = item;
    } else {
      clusters.push({ primary: item, members: [item] });
    }
  }
  return clusters;
}
