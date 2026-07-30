// lib/llm/index.ts
//
// The provider factory. One env switch (LLM_PROVIDER) selects the adapter; the rest of
// the codebase only ever touches the LLMProvider interface.
//
// RED LINE (Pigeon): dev + the whole framework run on the MOCK adapter by default.
// No paid LLM call is ever made automatically. The Grok (xAI) path is implemented but
// INERT: selecting it requires BOTH LLM_PROVIDER=xai AND a GROK_API_KEY present.
// There is no an alternate LLM vendor / OpenAI default path here — provider correction (2026-06-26)
// dropped the an alternate LLM vendor dev key; the product runs on Grok, dev runs on mock.

import { type LLMProvider } from './provider';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible';
import { MockAdapter } from './adapters/mock';

export * from './provider';
export { CLASSIFIER_SYSTEM, buildClassifierUserMessage } from './prompt';
export { OpenAICompatibleAdapter } from './adapters/openai-compatible';
export { MockAdapter } from './adapters/mock';

export type ProviderName = 'mock' | 'xai' | 'openai' | 'deepseek';

export function resolveProviderName(): ProviderName {
 const which = (process.env.LLM_PROVIDER ?? 'mock').toLowerCase() as ProviderName;
 return which;
}

// Returns the active provider. Falls back to mock — loudly — whenever a paid path is
// requested without a key, so a missing key can never become a silent paid call and can
// never crash ingestion.
export function getProvider(): LLMProvider {
 const which = resolveProviderName();

 switch (which) {
 case 'xai': {
 const apiKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? '';
 if (!apiKey) {
 console.warn(
 '[llm] LLM_PROVIDER=xai but no GROK_API_KEY present — Grok path is INERT. Falling back to MOCK (zero-cost, deterministic).',
 );
 return new MockAdapter();
 }
 return new OpenAICompatibleAdapter({
 apiKey,
 baseURL: 'https://api.x.ai/v1',
 modelId: process.env.LLM_MODEL_ID ?? 'grok-4.20-non-reasoning-latest',
 providerName: 'xai',
 // Rate card CORRECTED 2026-07-29. The previous 0.20/0.50 was the CACHED-input price with a 10x
 // unit mis-scale, not the standard rate, and it under-counted real spend ~6x. There is no
 // "budget tier": this model bills 1.25 in / 2.50 out per 1M, same as grok-4.3. Verified against
 // live GET /v1/language-models (12500 / 2000 / 25000, units of 1e-10 USD per token) and the
 // published table at https://docs.x.ai/docs/models. Sub-200k-prompt rates; xAI doubles every
 // rate once a prompt reaches 200k tokens.
 //
 // THIS FILE IS THE ONE THAT MATTERS FOR COST. The scheduled publish job lives in THIS repo
 // (.github/workflows/pages.yml, cron every 6h) and calls npm run ingest -> generateDepth. There
 // is no scripts/ directory here, so scripts/lib/spend-guard.mjs does NOT exist on this side —
 // these constants are the only cost accounting the cron has. Do not arm a paid provider here
 // until a guard exists in lib/.
 rates: { inPerM: 1.25, outPerM: 2.5 },
 });
 }
 case 'openai': {
 const apiKey = process.env.OPENAI_API_KEY ?? '';
 if (!apiKey) {
 console.warn('[llm] LLM_PROVIDER=openai but no OPENAI_API_KEY — falling back to MOCK.');
 return new MockAdapter();
 }
 return new OpenAICompatibleAdapter({
 apiKey,
 baseURL: 'https://api.openai.com/v1',
 modelId: process.env.LLM_MODEL_ID ?? 'gpt-4o-mini',
 providerName: 'openai',
 });
 }
 case 'deepseek': {
 const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
 if (!apiKey) {
 console.warn('[llm] LLM_PROVIDER=deepseek but no DEEPSEEK_API_KEY — falling back to MOCK.');
 return new MockAdapter();
 }
 return new OpenAICompatibleAdapter({
 apiKey,
 baseURL: 'https://api.deepseek.com/v1',
 modelId: process.env.LLM_MODEL_ID ?? 'deepseek-chat',
 providerName: 'deepseek',
 });
 }
 case 'mock':
 default:
 return new MockAdapter();
 }
}
