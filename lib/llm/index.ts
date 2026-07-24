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
 // Verified live via GET /v1/models 2026-07-13 (budget, non-flagship, non-reasoning model).
 modelId: process.env.LLM_MODEL_ID ?? 'grok-4.20-non-reasoning-latest',
 providerName: 'xai',
 // Budget-tier rate card ($0.20/1M in, $0.50/1M out). NOTE: this TS path (main-feed classify)
 // is still INERT this pass — the main feed runs on mock. The LOCAL pipeline uses the
 // cost-capped Grok path in scripts/lib. When the main-feed cutover happens, route this
 // adapter through the same SpendGuard before enabling.
 rates: { inPerM: 0.2, outPerM: 0.5 },
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
