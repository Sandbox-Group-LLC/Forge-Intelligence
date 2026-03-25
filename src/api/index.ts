import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { runPipeline } from '../agents/orchestrator';

config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Root — browser / domain ping response
app.get('/', (_req, res) => {
  res.json({
    platform: 'Forge by Sandbox',
    version: '0.1.0',
    status: 'operational',
    description: 'Compounding Content Intelligence Platform',
    docs: '/health'
  });
});

// Health check — Render pinger
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    platform: 'Forge by Sandbox',
    version: '0.1.0',
    uptime: process.uptime()
  });
});

// Full pipeline: Stages 1 → 2 → 3
app.post('/api/v1/pipeline', async (req, res) => {
  try {
    const { url, competitors, clientId } = req.body;
    if (!url || !clientId) {
      return res.status(400).json({ error: 'url and clientId are required' });
    }
    console.log(`[API] Pipeline request — client: ${clientId}, url: ${url}`);
    const result = await runPipeline({ url, competitors, clientId });
    res.json({ status: 'complete', ...result });
  } catch (err) {
    console.error('[API] Pipeline error:', err);
    res.status(500).json({ error: 'Pipeline failed', detail: String(err) });
  }
});

// Stage 1 only
app.post('/api/v1/context', async (req, res) => {
  try {
    const { url, competitors, clientId } = req.body;
    if (!url || !clientId) {
      return res.status(400).json({ error: 'url and clientId are required' });
    }
    const { runContextAgent } = await import('../agents/stage1_context_agent/index');
    const result = await runContextAgent({ clientId, url, competitors });
    res.json({ status: 'complete', stage: 1, ...result });
  } catch (err) {
    console.error('[API] Context Agent error:', err);
    res.status(500).json({ error: 'Context Agent failed', detail: String(err) });
  }
});

// Stage 2 placeholder
app.post('/api/v1/geo-brief', async (_req, res) => {
  res.json({ status: 'coming_soon', stage: 2, message: 'GEO Strategist wiring in progress' });
});

// Stage 3 placeholder
app.post('/api/v1/enrich', async (_req, res) => {
  res.json({ status: 'coming_soon', stage: 3, message: 'Authenticity Enricher wiring in progress' });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found', platform: 'Forge by Sandbox' });
});

app.listen(PORT, () => {
  console.log(`🔥 Forge by Sandbox running on port ${PORT}`);
});

export default app;
