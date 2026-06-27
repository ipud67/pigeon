// scripts/build-overrides.mjs
//
// Transform Clark's depth-override briefs (a fenced JSON ARRAY of {id, short_history,
// constitutional_analysis, prediction}) into data/depth-overrides.json, the object KEYED BY
// fact id that lib/depth/overrides.ts expects. Reproducible: re-run whenever Clark ships a
// new override brief. Pass the brief path as argv[2] (defaults to the v2 directional brief).
//
// The override loader (lib/depth/overrides.ts) accepts each section as a prose string and
// tags `source:'override'` itself, so we only carry the three depth strings per id.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const briefPath =
  process.argv[2] ??
  join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    '.claude/agents/pigeon/inbox/from_clark_depth_overrides_v2_2026-06-26.md',
  );

const md = readFileSync(briefPath, 'utf8');
const fence = md.match(/```json\s*([\s\S]*?)```/i);
if (!fence) {
  console.error('No ```json fenced block found in', briefPath);
  process.exit(1);
}

const arr = JSON.parse(fence[1]);
if (!Array.isArray(arr)) {
  console.error('Fenced block is not a JSON array.');
  process.exit(1);
}

const keyed = {};
for (const rec of arr) {
  if (!rec || typeof rec.id !== 'string') {
    console.error('Override record missing string id:', rec);
    process.exit(1);
  }
  const { id, ...sections } = rec;
  keyed[id] = sections;
}

const outPath = join(process.cwd(), 'data', 'depth-overrides.json');
writeFileSync(outPath, JSON.stringify(keyed, null, 2) + '\n', 'utf8');

console.log(`Wrote ${Object.keys(keyed).length} overrides -> ${outPath}`);
console.log('ids:', Object.keys(keyed).join(', '));
