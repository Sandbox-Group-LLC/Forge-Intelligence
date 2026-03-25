/**
 * Forge Orchestrator — Stages 1 → 2 → 3
 * Uses Claude-native tool use. No LangChain. No framework monkeys.
 * Brain-First protocol enforced on every agent before it acts.
 */

import { getBrainContext } from '../brain/memory';
import { runContextAgent, BrandProfile } from './stage1_context_agent/index';

export interface PipelineInput {
  clientId: string;
  url: string;
  competitors?: string[];
}

export interface PipelineOutput {
  brandProfileId: string;
  profile: BrandProfile;
  geoBriefId: string;       // populated in Phase 2
  enrichedBriefId: string;  // populated in Phase 2
  confidenceScore: number;
}

export async function runPipeline(input: PipelineInput): Promise<Partial<PipelineOutput>> {
  const { clientId, url, competitors } = input;

  console.log(`[Orchestrator] Pipeline started — client: ${clientId}`);

  // Brain-First: global context loaded once, shared across all agents
  const brainContext = await getBrainContext(clientId);
  console.log(`[Orchestrator] Brain loaded: ${brainContext.patterns.length} patterns`);

  // ─── STAGE 1: Context Agent ───────────────────────────────────────────────
  console.log('[Orchestrator] Stage 1: Context Agent firing...');
  const { brandProfileId, profile } = await runContextAgent({ clientId, url, competitors });
  console.log(`[Orchestrator] Stage 1 complete. Brand profile: ${brandProfileId}`);

  // ─── STAGE 2: GEO Strategist ──────────────────────────────────────────────
  // TODO: wire in stage2_geo_strategist
  console.log('[Orchestrator] Stage 2: GEO Strategist (wiring next)');

  // ─── STAGE 3: Authenticity Enricher ──────────────────────────────────────
  // TODO: wire in stage3_authenticity_enricher
  console.log('[Orchestrator] Stage 3: Authenticity Enricher (wiring next)');

  return {
    brandProfileId,
    profile,
    geoBriefId: 'pending_stage2',
    enrichedBriefId: 'pending_stage3',
    confidenceScore: 0
  };
}
