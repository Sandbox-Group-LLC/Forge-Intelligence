import Anthropic from '@anthropic-ai/sdk';
import { queryBrain, writeToBrain } from '../../brain/client';
import { getBrainContext } from '../../brain/memory';
import { scrapeDomain, scrapeReviews, scrapeCompetitors } from '../../tools/scraper';
import { config } from 'dotenv';

config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export interface ContextAgentInput {
  clientId: string;
  url: string;
  competitors?: string[];
}

export interface VoiceProfile {
  formality_score: number;
  confidence_score: number;
  complexity_score: number;
  brand_vocabulary: string[];
  tone_summary: string;
}

export interface Persona {
  title: string;
  primary_pain_point: string;
  trigger_event: string;
  skepticism: string;
}

export interface BrandProfile {
  voice_profile: VoiceProfile;
  personas: Persona[];
  third_party_signals: {
    customer_power_phrases: string[];
    friction_points: string[];
  } | null;
  competitive_gaps: {
    competitor_owned_topics: string[];
    white_space: string;
  } | null;
}

/**
 * Context Agent — Stage 1
 * Model: Claude Sonnet 4.6
 * Architecture: Sequential prompts (Brain-First → Scrape → Synthesize → Write)
 */
export async function runContextAgent(input: ContextAgentInput): Promise<{
  brandProfileId: string;
  profile: BrandProfile;
}> {
  const { clientId, url, competitors } = input;
  console.log(`[Context Agent] Starting — client: ${clientId}, url: ${url}`);

  // ── STEP 0: Brain-First Protocol ─────────────────────────────────────────
  const brainContext = await getBrainContext(clientId);
  console.log(`[Context Agent] Brain loaded: ${brainContext.patterns.length} patterns, ${brainContext.mistakes.length} mistakes`);

  // ── STEP 1: Scrape raw signals ────────────────────────────────────────────
  console.log('[Context Agent] Scraping domain...');
  const [domainSignals, reviewSignals, competitorSignals] = await Promise.all([
    scrapeDomain(url),
    scrapeReviews(url),
    competitors?.length ? scrapeCompetitors(competitors) : Promise.resolve('No competitors provided.')
  ]);

  // ── STEP 2: Synthesize into structured Brand Profile ─────────────────────
  console.log('[Context Agent] Synthesizing Brand Intelligence Profile...');

  const synthesisPrompt = `You are the Context Agent for Forge by Sandbox.

Your job: synthesize raw brand signals into a structured Brand Intelligence Profile JSON.

BRAIN CONTEXT (from previous cycles — respect these patterns and avoid these mistakes):
${JSON.stringify(brainContext, null, 2)}

RAW DOMAIN SIGNALS:
${domainSignals}

RAW REVIEW SIGNALS:
${reviewSignals}

RAW COMPETITOR SIGNALS:
${competitorSignals}

RULES:
- Do NOT use generic persona names like "Marketing Mary". Use behavioral titles.
- Do NOT hallucinate signals. If data is missing, set the field to null.
- Voice scores must be integers 1-10.
- brand_vocabulary must contain exact words/phrases from the brand's copy.
- personas must reflect behavioral triggers, not demographics.

Return ONLY a valid JSON object in this exact structure:
{
  "voice_profile": {
    "formality_score": <1-10>,
    "confidence_score": <1-10>,
    "complexity_score": <1-10>,
    "brand_vocabulary": ["word1", "word2", "word3", "word4", "word5"],
    "tone_summary": "<one punchy sentence>"
  },
  "personas": [
    {
      "title": "<behavioral title>",
      "primary_pain_point": "<specific pain>",
      "trigger_event": "<why looking now>",
      "skepticism": "<objection>"
    }
  ],
  "third_party_signals": {
    "customer_power_phrases": ["phrase1", "phrase2", "phrase3"],
    "friction_points": ["friction1", "friction2"]
  },
  "competitive_gaps": {
    "competitor_owned_topics": ["topic1", "topic2", "topic3"],
    "white_space": "<one high-value unowned topic>"
  }
}`;

  const synthesisResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: synthesisPrompt }]
  });

  // Fix: use SDK's own TextBlock type — handles citations field in ^0.39.0
  const rawText = synthesisResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b: Anthropic.TextBlock) => b.text)
    .join('\n');

  // Extract JSON from response
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('[Context Agent] No valid JSON in synthesis response');
  }

  const profile: BrandProfile = JSON.parse(jsonMatch[0]);
  console.log(`[Context Agent] Profile built. Tone: "${profile.voice_profile?.tone_summary}"`);

  // ── STEP 3: Write to Brain ────────────────────────────────────────────────
  const saved = await writeToBrain('brand_profiles', {
    client_id: clientId,
    voice_profile: JSON.stringify(profile.voice_profile),
    personas: JSON.stringify(profile.personas),
    third_party_signals: JSON.stringify(profile.third_party_signals),
    competitive_gaps: JSON.stringify(profile.competitive_gaps),
    last_scraped: new Date().toISOString()
  });

  const profileId = (saved as Array<{ id: string }>)[0]?.id ?? 'unknown';
  console.log(`[Context Agent] Profile written to Brain: ${profileId}`);

  return { brandProfileId: profileId, profile };
}
