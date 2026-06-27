// scripts/refresh-markets.ts
//
// Refresh data/markets.json from live free sources WITHOUT touching facts.json (so override
// ids stay stable — same discipline as scripts/reenrich.ts). Keyless Treasury yields are LIVE;
// FRED/Finnhub gauges fill in only when FRED_API_KEY / FINNHUB_API_KEY are present (inert
// otherwise — RED LINE: no paid call). Run: node --import tsx scripts/refresh-markets.ts

import { buildMarketSnapshot } from '../lib/ingestion/markets';
import { writeMarketSnapshot } from '../lib/store';

async function main() {
  console.log('\n PIGEON MARKETS REFRESH\n');
  const snap = await buildMarketSnapshot();
  writeMarketSnapshot(snap);
  console.log(`  live sources:        ${snap.sources_live.join(', ') || 'none'}`);
  console.log(`  pending-key sources: ${snap.sources_pending_key.join(', ') || 'none'}`);
  for (const i of snap.indicators) {
    const v = i.value == null ? '— (pending key)' : `${i.value}${i.unit === '%' ? '%' : i.unit === 'bps' ? ' bps' : ''}`;
    console.log(`   ${i.label.padEnd(24)} ${v.toString().padEnd(18)} [${i.status}]`);
  }
  console.log(`\n  → wrote data/markets.json (${snap.indicators.length} gauges)\n`);
}

main().catch((e) => {
  console.error('markets refresh failed:', e);
  process.exit(1);
});
