import Anthropic from '@anthropic-ai/sdk';
import { env, hasAnthropic } from '../config/env';

// Multi-model routing, mirroring Forge's economics:
//   deep   → Opus    (foundational/forensic reasoning)
//   reason → Sonnet  (strategic analysis, voice fidelity)
//   fast   → Haiku   (cheap signal checks, routing)
export const MODELS = {
  deep: 'claude-opus-4-7',
  reason: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
} as const;

export type ModelTier = keyof typeof MODELS;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!hasAnthropic) throw new Error('ANTHROPIC_API_KEY not configured');
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export interface CompleteArgs {
  tier: ModelTier;
  prompt: string;
  system?: string;
  maxTokens?: number;
}

export async function complete({ tier, prompt, system, maxTokens = 2048 }: CompleteArgs): Promise<string> {
  const resp = await getClient().messages.create({
    model: MODELS[tier],
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
