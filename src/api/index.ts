import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';

config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', platform: 'Forge by Sandbox', version: '0.1.0' });
});

// Stage 1 — Context Agent
app.post('/api/v1/context', async (req, res) => {
  try {
    const { url, competitors, clientId } = req.body;
    if (!url || !clientId) {
      return res.status(400).json({ error: 'url and clientId are required' });
    }
    // TODO: wire in src/agents/stage1_context_agent/index.ts
    res.json({ status: 'queued', stage: 1, clientId, url });
  } catch (err) {
    res.status(500).json({ error: 'Context Agent failed', detail: String(err) });
  }
});

// Stage 2 — GEO Strategist
app.post('/api/v1/geo-brief', async (req, res) => {
  try {
    const { clientId, brandProfileId } = req.body;
    if (!clientId || !brandProfileId) {
      return res.status(400).json({ error: 'clientId and brandProfileId are required' });
    }
    // TODO: wire in src/agents/stage2_geo_strategist/index.ts
    res.json({ status: 'queued', stage: 2, clientId, brandProfileId });
  } catch (err) {
    res.status(500).json({ error: 'GEO Strategist failed', detail: String(err) });
  }
});

// Stage 3 — Authenticity Enricher
app.post('/api/v1/enrich', async (req, res) => {
  try {
    const { clientId, geoBriefId } = req.body;
    if (!clientId || !geoBriefId) {
      return res.status(400).json({ error: 'clientId and geoBriefId are required' });
    }
    // TODO: wire in src/agents/stage3_authenticity_enricher/index.ts
    res.json({ status: 'queued', stage: 3, clientId, geoBriefId });
  } catch (err) {
    res.status(500).json({ error: 'Authenticity Enricher failed', detail: String(err) });
  }
});

// Full pipeline: Stages 1 → 2 → 3 in sequence
app.post('/api/v1/pipeline', async (req, res) => {
  try {
    const { url, competitors, clientId } = req.body;
    if (!url || !clientId) {
      return res.status(400).json({ error: 'url and clientId are required' });
    }
    // TODO: wire in src/agents/orchestrator.ts
    res.json({ status: 'pipeline_queued', stages: [1, 2, 3], clientId, url });
  } catch (err) {
    res.status(500).json({ error: 'Pipeline failed', detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 Forge by Sandbox running on port ${PORT}`);
});

export default app;
