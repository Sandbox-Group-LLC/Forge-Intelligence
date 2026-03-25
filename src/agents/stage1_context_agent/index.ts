import Anthropic from '@anthropic-ai/sdk';
import { contextAgentTools } from './tools';
import { queryBrain, writeToBrain } from '../../brain/client';
import { getBrainContext } from '../../brain/memory';
import { scrapeDomain, scrapeReviews, scrapeCompetitors } from '../../tools/scraper';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';

config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Load the system prompt from the spec file
const SYSTEM_PROMPT = readFileSync(
  join(__dirname, '../../../agents/stage1_context_agent/system_prompt.md'),
  'utf-8'
);

export interface ContextAgentInput {
  clientId: string;
  url: string;
  competitors?: string[];
}

export interface BrandProfile {
  voice_profile: {
    formality_score: number;
    confidence_score: number;
    complexity_score: number;
    brand_vocabulary: string[];
    tone_summary: string;
  };
  personas: Array<{
    title: string;
    primary_pain_point: string;
    trigger_event: string;
    skepticism: string;
  }>;
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
 * Brain-First: reads Patterns + Mistakes before any external call
 */
export async function runContextAgent(input: ContextAgentInput): Promise<{
  brandProfileId: string;
  profile: BrandProfile;
}> {
  const { clientId, url, competitors } = input;

  console.log(`[Context Agent] Starting for client ${clientId} — ${url}`);

  // Brain-First: pre-load context
  const brainContext = await getBrainContext(clientId);
  console.log(`[Context Agent] Brain loaded: ${brainContext.patterns.length} patterns, ${brainContext.mistakes.length} mistakes`);

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Build a Brand Intelligence Profile for this company.

URL: ${url}
${competitors?.length ? `Competitors: ${competitors.join(', ')}` : ''}
Client ID: ${clientId}

Brain Context (from previous cycles):
${JSON.stringify(brainContext, null, 2)}

Execute the Brain-First Protocol first, then proceed through all 4 steps.
Output a single structured JSON payload as your final response.`
    }
  ];

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: contextAgentTools,
    messages
  });

  // Agentic loop: handle tool calls until agent returns final JSON
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      console.log(`[Context Agent] Tool call: ${toolUse.name}`);
      let result = '';

      try {
        const inp = toolUse.input as Record<string, unknown>;

        switch (toolUse.name) {
          case 'query_brain':
            const rows = await queryBrain(
              inp.client_id as string,
              inp.table as 'memories' | 'patterns' | 'mistakes' | 'agent_coordination'
            );
            result = JSON.stringify(rows);
            break;

          case 'scrape_domain':
            result = await scrapeDomain(inp.url as string);
            break;

          case 'scrape_reviews':
            result = await scrapeReviews(inp.brand_name as string);
            break;

          case 'scrape_competitors':
            result = await scrapeCompetitors(inp.urls as string[]);
            break;

          case 'write_to_brain':
            const written = await writeToBrain('brand_profiles', {
              client_id: inp.client_id,
              ...(inp.data_payload as object)
            });
            result = JSON.stringify(written);
            break;

          default:
            result = JSON.stringify({ error: `Unknown tool: ${toolUse.name}` });
        }
      } catch (err) {
        result = JSON.stringify({ error: String(err) });
        console.error(`[Context Agent] Tool error: ${toolUse.name}`, err);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result
      });
    }

    // Continue the conversation with tool results
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: contextAgentTools,
      messages
    });
  }

  // Extract final JSON from response
  const finalText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  // Parse the JSON profile
  const jsonMatch = finalText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('[Context Agent] No JSON found in final response');
  }

  const profile: BrandProfile = JSON.parse(jsonMatch[0]);
  console.log(`[Context Agent] Profile built. Tone: ${profile.voice_profile?.tone_summary}`);

  // Write completed profile to Brain
  const saved = await writeToBrain('brand_profiles', {
    client_id: clientId,
    voice_profile: profile.voice_profile,
    personas: profile.personas,
    third_party_signals: profile.third_party_signals,
    competitive_gaps: profile.competitive_gaps,
    last_scraped: new Date().toISOString()
  });

  return {
    brandProfileId: (saved as { id: string }).id,
    profile
  };
}
