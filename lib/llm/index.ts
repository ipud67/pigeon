// lib/llm/index.ts
//
// The provider factory. One env switch (LLM_PROVIDER) selects the adapter; the rest of
// the codebase only ever touches the LLMProvider interface.
//
// RED LINE (Pigeon): dev + the whole framework run on the MOCK adapter by default.
// No paid LLM call is ever made automatically. The Grok (xAI) path is implemented but
// INERT: selecting it requires BOTH LLM_PROVIDER=xai AND a GROK_API_KEY present.
// There is no Anthropic / OpenAI default path here — provider correction D9 (2026-06-26)
// dropped the Anthropic dev key; the product runs on Grok, dev runs on mock.

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
        modelId: process.env.LLM_MODEL_ID ?? 'grok-2-1212', // re-verify the id at key-provision time
        providerName: 'xai',
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
