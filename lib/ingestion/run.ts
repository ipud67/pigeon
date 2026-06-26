// lib/ingestion/run.ts
//
// The ingestion orchestrator. `npm run ingest` runs this.
//
// Pipeline:
//   1. pull every source in the locked spine (failures degrade to [] and are reported)
//   2. run each raw item through the EDITORIAL GATE (classifier -> shouldPublish)
//      - dev runs the MOCK adapter: deterministic, zero-cost. Primaries (no opinion
//        markers) classify event_report and clear their tier threshold = published.
//   3. dedup/cluster: one event, N outlets -> one record, N linkouts
//   4. enrich: category, economics flag, dateline place, factual deck
//   5. generate rule-based WEIGH-IT questions (Clark §1b) — no LLM
//   6. write data/facts.json (committed; the deployed app reads it at build time)
//
// RED LINE: no paid LLM call. The gate uses getProvider(), which is mock unless a key is
// explicitly provisioned AND LLM_PROVIDER set. A long-form linkout is detected heuristically.

import { getProvider, resolveProviderName, shouldPublish, type ClassifyInput } from '../llm';
import type { FactRecord, RawItem } from '../types';
import { writeFacts, readForecasts, writeForecasts } from '../store';
import { SOURCES } from './sources';
import { clusterItems, stableId } from './dedup';
import { categorize, economicsFlag, derivePlace, buildDeck } from './enrich';
import { generateWeighIt } from '../weighit/generate';
import { generateDepth } from '../depth/generate';
import { scoreFact } from '../ranking/importance';
import { SAMPLE_FORECASTS } from '../predict/sample';

const DRY = process.env.PIGEON_INGEST_DRY === '1';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Long-form heuristic: press conferences / full addresses / streamed briefings.
function detectLongform(item: RawItem): string | undefined {
  const t = `${item.title} ${item.body}`.toLowerCase();
  if (/(press conference|full address|press briefing|remarks by|full remarks|transcript|oral argument)/.test(t)) {
    return item.url;
  }
  return undefined;
}

// Pull a quote if the body contains a quoted statement (for the statement card shape).
function extractQuote(body: string): string | undefined {
  const m = body.match(/[“"]([^”"]{20,240})[”"]/);
  return m ? m[1] : undefined;
}

async function main() {
  const provider = getProvider();
  const providerName = resolveProviderName();
  console.log(`\n PIGEON INGEST  ·  provider=${providerName} (${provider.name}/${provider.modelId})\n`);
  if (providerName !== 'mock' && provider.name === 'mock') {
    console.log(' (requested a paid provider but no key present — safely using mock)\n');
  }

  // 1 — pull all sources
  const allRaw: RawItem[] = [];
  const report: Array<{ source: string; pulled: number; ok: boolean; note?: string }> = [];

  for (const src of SOURCES) {
    if (src.throttleMs) await sleep(src.throttleMs);
    try {
      const items = await src.fn();
      allRaw.push(...items);
      report.push({ source: src.name, pulled: items.length, ok: true });
      console.log(`  ✓ ${src.name.padEnd(34)} ${items.length} item(s)`);
    } catch (err) {
      report.push({ source: src.name, pulled: 0, ok: false, note: (err as Error).message });
      console.log(`  ✗ ${src.name.padEnd(34)} 0 — ${(err as Error).message.slice(0, 80)}`);
    }
  }

  // 2 — editorial gate
  const admitted: RawItem[] = [];
  let rejected = 0;
  const gateMeta = new Map<string, { kind: string; confidence: number }>();
  for (const item of allRaw) {
    if (!item.url || !item.title) {
      rejected++;
      continue;
    }
    const input: ClassifyInput = {
      headline: item.title,
      bodyText: item.body,
      sourceTier: item.tier,
      sourceOutlet: item.outlet,
    };
    const c = await provider.classify(input);
    if (shouldPublish(c, item.tier)) {
      admitted.push(item);
      gateMeta.set(`${item.url}::${item.title}`, { kind: c.kind, confidence: c.confidence });
    } else {
      rejected++;
    }
  }
  console.log(`\n  editorial gate: ${admitted.length} admitted · ${rejected} rejected`);

  // 3 — dedup / cluster
  const clusters = clusterItems(admitted);

  // 4 + 5 + 6 — enrich + WEIGH-IT + DEPTH + importance score
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const records: FactRecord[] = await Promise.all(
    clusters.map(async (cluster): Promise<FactRecord> => {
      const p = cluster.primary;
      const combined = `${p.title} ${p.body}`;
      const category = categorize(combined);
      const place = derivePlace(p.place, p.outlet);
      const economics = economicsFlag(combined, p.outlet);
      const deck = buildDeck({ title: p.title, summary: p.body, outlet: p.outlet, datetime_utc: p.datetime_utc });
      const quote = p.quote ?? extractQuote(p.body);
      const context =
        cluster.members.length > 1
          ? `Reported by ${cluster.members.length} sources. ${p.body}`
          : p.body;
      const weigh = generateWeighIt({ what: p.title, context, category, outlet: p.outlet });
      const meta = gateMeta.get(`${p.url}::${p.title}`) ?? { kind: 'event_report', confidence: 0.72 };

      const sources = cluster.members
        .map((m) => ({ outlet: m.outlet, url: m.url, tier: m.tier, paywalled: m.paywalled }))
        .filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i);

      const partial: FactRecord = {
        id: stableId(p.url, p.title),
        datetime_utc: p.datetime_utc,
        place,
        what: p.title,
        deck,
        quote,
        context,
        sources,
        category,
        economics_flag: economics,
        weigh_it_questions: weigh,
        longform_url: p.longform_url ?? detectLongform(p),
        classifier_kind: meta.kind,
        classifier_confidence: meta.confidence,
        ingested_at: now,
      };

      // DEPTH: constitutional analysis is rule-based (real now); short_history + prediction
      // are placeholders under mock, LLM under Grok. RED LINE-safe (no `complete` on mock).
      const depth = await generateDepth(partial, provider);
      // IMPORTANCE: 0-100 + tier; the home/week feeds rank by this and bury micro-noise.
      const scored = scoreFact(partial, nowMs);

      return { ...partial, depth, importance: scored.score, importance_tier: scored.tier };
    }),
  );

  // sort newest first (the store re-sorts; render-time ranking re-orders for home/week)
  records.sort((a, b) => (a.datetime_utc < b.datetime_utc ? 1 : -1));

  // ---- report ----
  console.log(`\n  fact records built: ${records.length}`);
  const byCat = records.reduce<Record<string, number>>((m, r) => {
    m[r.category] = (m[r.category] ?? 0) + 1;
    return m;
  }, {});
  console.log('  by category:', JSON.stringify(byCat));
  const byTier = records.reduce<Record<string, number>>((m, r) => {
    const k = r.importance_tier ?? 'NONE';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  console.log('  by importance tier:', JSON.stringify(byTier));
  console.log(`  buried (off default home/week): ${records.filter((r) => r.importance_tier === 'BURIED').length}`);
  console.log(`  economics-flagged: ${records.filter((r) => r.economics_flag).length}`);
  console.log(`  with WEIGH-IT prompts: ${records.filter((r) => r.weigh_it_questions.length > 0).length}`);
  console.log(
    `  with constitutional analysis (rule-based): ${
      records.filter((r) => r.depth?.constitutional_analysis?.contrasts.length).length
    }`,
  );
  console.log(`  with long-form linkout: ${records.filter((r) => r.longform_url).length}`);

  if (DRY) {
    console.log('\n  [dry run] not writing data/facts.json\n');
    return;
  }

  writeFacts(records);
  console.log(`\n  → wrote data/facts.json (${records.length} records)`);

  // seed PREDICT sample forecasts if none exist yet (idempotent)
  const existing = readForecasts();
  if (existing.length === 0) {
    writeForecasts(SAMPLE_FORECASTS);
    console.log(`  → seeded data/predict.json (${SAMPLE_FORECASTS.length} forecasts)`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('ingest failed:', e);
  process.exit(1);
});
