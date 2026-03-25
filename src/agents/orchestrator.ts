/**
 * Forge Orchestrator — Stages 1 → 2 → 3
 * Uses Claude-native tool use. No LangChain.
 * Each agent reads the Brain before acting.
 */

import { getBrainContext } from '../brain/memory';

export interface PipelineInput {
  clientId: string;
  url: string;
  competitors?: string[];
}

export interface PipelineOutput {
  brandProfileId: string;
  geoBriefId: string;
  enrichedBriefId: string;
  confidenceScore: number;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { clientId, url, competitors } = input;

  // Brain-First: load context before any agent fires
  const brainContext = await getBrainContext(clientId);

  // Stage 1: Context Agent
  // TODO: import and call contextAgent(url, competitors, brainContext)
  const brandProfileId = 'pending';

  // Stage 2: GEO Strategist
  // TODO: import and call geoStrategist(brandProfileId, brainContext)
  const geoBriefId = 'pending';

  // Stage 3: Authenticity Enricher
  // TODO: import and call authenticityEnricher(geoBriefId, brainContext)
  const enrichedBriefId = 'pending';

  return {
    brandProfileId,
    geoBriefId,
    enrichedBriefId,
    confidenceScore: 0
  };
}
