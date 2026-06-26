// src/lib/llm/adapters/openai-compatible.ts
//
// OpenAI-compatible adapter — powers xAI/Grok, OpenAI, and DeepSeek with one code path.
//
// xAI's /v1/chat/completions is OpenAI-spec-compatible, so the `openai` npm package
// works against https://api.x.ai/v1 with only a baseURL override. This is the
// "flip dev->Grok is one env change" path from SPEC_v1 §6.4.
//
// JSON is enforced via response_format: { type: 'json_object' }. The system prompt is
// IDENTICAL to the Anthropic path — the prompt is provider-agnostic by design.
//
// NOTE (flagged, not verified): the current Grok model id + exact rate card must be
// re-checked the day xAI's key is provisioned. xAI rev model names frequently. This
// adapter does NOT hardcode a Grok id; the caller passes it via env. We have no Grok
// key, so this path is UNTESTED against a live xAI endpoint in this prototype.

import OpenAI from 'openai';
import {
  type ClassifyInput,
  type ClassifyOutput,
  type CompletionInput,
  type LLMProvider,
  coerceClassification,
  extractJson,
} from '../provider';
import { CLASSIFIER_SYSTEM, buildClassifierUserMessage } from '../prompt';

export type OpenAICompatibleOpts = {
  apiKey: string;
  baseURL: string; // e.g. https://api.x.ai/v1  | https://api.openai.com/v1 | https://api.deepseek.com/v1
  modelId: string; // e.g. grok-2-1212 | gpt-4o-mini | deepseek-chat  (re-verify Grok id at key time)
  providerName: string; // 'xai' | 'openai' | 'deepseek'
  rates?: { inPerM: number; outPerM: number }; // re-cost at provision time
};

export class OpenAICompatibleAdapter implements LLMProvider {
  readonly name: string;
  readonly modelId: string;
  private client: OpenAI;
  private rates: { inPerM: number; outPerM: number };

  constructor(opts: OpenAICompatibleOpts) {
    if (!opts.apiKey) throw new Error('OpenAICompatibleAdapter: apiKey is required');
    if (!opts.baseURL) throw new Error('OpenAICompatibleAdapter: baseURL is required');
    if (!opts.modelId) throw new Error('OpenAICompatibleAdapter: modelId is required');
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.modelId = opts.modelId;
    this.name = opts.providerName;
    // Placeholder rates; Grok-2 was last-known ~$2/M in, ~$10/M out. Re-cost at key time.
    this.rates = opts.rates ?? { inPerM: 2.0, outPerM: 10.0 };
  }

  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const resp = await this.client.chat.completions.create({
      model: this.modelId,
      max_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM },
        { role: 'user', content: buildClassifierUserMessage(input) },
      ],
    });

    const text = resp.choices[0]?.message?.content ?? '';
    const inTok = resp.usage?.prompt_tokens ?? 0;
    const outTok = resp.usage?.completion_tokens ?? 0;
    const costFields = {
      estTokensIn: inTok,
      estTokensOut: outTok,
      estCostUsd:
        (inTok / 1_000_000) * this.rates.inPerM + (outTok / 1_000_000) * this.rates.outPerM,
    };

    return coerceClassification(extractJson(text), costFields);
  }

  // Generic completion for the DEPTH layer (short history + per-story prediction). Only the
  // real provider has this; the mock adapter omits it, so under mock the depth generator
  // never reaches a paid call. Wired but UNTESTED against a live xAI endpoint (no key).
  async complete(input: CompletionInput): Promise<string> {
    const resp = await this.client.chat.completions.create({
      model: this.modelId,
      max_tokens: input.maxTokens ?? 700,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? '';
  }
}
