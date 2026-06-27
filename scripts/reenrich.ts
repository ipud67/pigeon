// scripts/reenrich.ts
//
// Re-enrich the existing committed data/facts.json IN PLACE (stable ids preserved) with the
// SPEC v2 fields: evolved WEIGH-IT, the DEPTH layers (rule-based constitutional analysis +
// labeled short-history/prediction placeholders under mock), and the IMPORTANCE score/tier.
//
// Why in-place instead of a fresh `npm run ingest`: Clark hand-researched depth for 7
// specific stories (data/depth-overrides.json) and verified their ids against THIS dataset,
// and the QC demo depends on those exact records (National Guard force-posture, FOMC, TPS,
// tariffs, Schedule F, vaccine, Iran MOU) being present with matching ids. A fresh feed pull
// would rotate ids and orphan that research. This pass keeps the dataset stable while adding
// every new field. RED LINE preserved: mock provider, no paid call, no fabrication.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactRecord } from '../lib/types';
import { getProvider, resolveProviderName } from '../lib/llm';
import { generateWeighIt } from '../lib/weighit/generate';
import { generateDepth } from '../lib/depth/generate';
import { scoreFact } from '../lib/ranking/importance';

const FACTS_PATH = join(process.cwd(), 'data', 'facts.json');

async function main() {
  const provider = getProvider();
  console.log(`\n PIGEON RE-ENRICH  ·  provider=${resolveProviderName()} (${provider.name})\n`);

  const facts = JSON.parse(readFileSync(FACTS_PATH, 'utf8')) as FactRecord[];
  const now = Date.now();

  const out: FactRecord[] = await Promise.all(
    facts.map(async (f): Promise<FactRecord> => {
      const outlet = f.sources[0]?.outlet;
      const weigh = generateWeighIt({ what: f.what, context: f.context, category: f.category, outlet });
      const depth = await generateDepth({ ...f, weigh_it_questions: weigh }, provider);
      const scored = scoreFact(f, now);
      return {
        ...f,
        weigh_it_questions: weigh,
        depth,
        importance: scored.score,
        importance_tier: scored.tier,
      };
    }),
  );

  // newest first (render-time ranking re-orders for home/week)
  out.sort((a, b) => (a.datetime_utc < b.datetime_utc ? 1 : -1));
  writeFileSync(FACTS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

  const byTier = out.reduce<Record<string, number>>((m, r) => {
    const k = r.importance_tier ?? 'NONE';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  console.log(`  re-enriched ${out.length} records`);
  console.log('  by importance tier:', JSON.stringify(byTier));
  console.log(`  buried (off default home/week): ${out.filter((r) => r.importance_tier === 'BURIED').length}`);
  console.log(
    `  with constitutional analysis (rule-based): ${
      out.filter((r) => r.depth?.constitutional_analysis?.contrasts.length).length
    }`,
  );
  console.log('');
}

main().catch((e) => {
  console.error('re-enrich failed:', e);
  process.exit(1);
});
