import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Boot: ensure brand_profiles table exists
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_profiles (
      id TEXT PRIMARY KEY,
      brand_url TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT true,
      cache_status TEXT NOT NULL DEFAULT 'fresh',
      profile_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bp_url ON brand_profiles(brand_url);
    CREATE INDEX IF NOT EXISTS idx_bp_active ON brand_profiles(is_active);
  `);
  console.log('NeonDB ready');
}
initDB().catch(err => console.error('DB init error:', err));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// ── Context Agent API ────────────────────────────────────────────────────────

// GET all active brand brains
app.get('/api/context-agent/brains', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, brand_url, brand_name, version, is_active, cache_status,
              created_at, updated_at, profile_data
       FROM brand_profiles WHERE is_active = true ORDER BY updated_at DESC`
    );
    const data = result.rows.map(r => ({
      id: r.id,
      brandUrl: r.brand_url,
      brandName: r.brand_name,
      version: r.version,
      isActive: r.is_active,
      cacheStatus: r.cache_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...r.profile_data
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single brain by ID
app.get('/api/context-agent/brains/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM brand_profiles WHERE id = $1`, [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const r = result.rows[0];
    res.json({ success: true, data: {
      id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
      version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
      createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET version history for a brand URL
app.get('/api/context-agent/history/:encodedUrl', async (req, res) => {
  try {
    const brandUrl = decodeURIComponent(req.params.encodedUrl);
    const result = await pool.query(
      `SELECT id, brand_url, brand_name, version, is_active, cache_status, created_at, updated_at
       FROM brand_profiles WHERE brand_url = $1 ORDER BY version DESC`, [brandUrl]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST run a new Context Agent analysis via Claude
app.post('/api/context-agent/analyze', async (req, res) => {
  const { brandUrl, brandName, competitorUrls = [], audienceNotes = '', strategicNotes = '', checkBrainFirst = true, saveToBrain = true } = req.body;
  if (!brandUrl || !brandName) {
    return res.status(400).json({ success: false, error: 'brandUrl and brandName are required' });
  }

  try {
    // Check brain first if requested
    if (checkBrainFirst) {
      const existing = await pool.query(
        `SELECT * FROM brand_profiles WHERE brand_url = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const cached = { id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
          version: r.version, isActive: r.is_active, cacheStatus: 'cached',
          createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data };
        // Update cache_status to cached
        await pool.query(`UPDATE brand_profiles SET cache_status = 'cached' WHERE id = $1`, [r.id]);
        return res.json({ success: true, data: cached });
      }
    }

    // Build Context Agent prompt
    const competitorSection = competitorUrls.length
      ? `\nCompetitor URLs to analyze: ${competitorUrls.join(', ')}`
      : '';
    const audienceSection = audienceNotes ? `\nAudience context: ${audienceNotes}` : '';
    const strategicSection = strategicNotes ? `\nStrategic context: ${strategicNotes}` : '';

    const prompt = `You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

Analyze the brand at: ${brandUrl}${competitorSection}${audienceSection}${strategicSection}

Your job is to produce a complete Brand Brain profile. Crawl the brand signals, infer voice patterns, build personas, map competitive gaps, and generate strategic recommendations.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "voiceProfile": {
    "summary": "2-3 sentence brand voice summary",
    "toneAttributes": [
      { "attribute": "string", "score": 0-100, "description": "string" }
    ],
    "writingStyle": "string",
    "keyPhrases": ["string"]
  },
  "personas": [
    {
      "id": "persona_001",
      "name": "string",
      "role": "string",
      "painPoints": ["string"],
      "triggers": ["string"],
      "skepticism": "string",
      "motivations": ["string"]
    }
  ],
  "thirdPartySignals": [
    { "source": "string", "signalType": "string", "value": "string or null", "confidence": 0-100, "lastChecked": "ISO8601" }
  ],
  "competitiveGaps": [
    { "topic": "string", "ownedBy": "string or null", "whitespaceOpportunity": "string", "priority": "high|medium|low" }
  ],
  "strategicRecommendations": [
    { "id": "rec_001", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }
  ]
}

Requirements:
- toneAttributes: exactly 5 attributes
- personas: 2-3 distinct buyer personas
- thirdPartySignals: 4-6 signals (G2, LinkedIn, Crunchbase, Twitter/X, SimilarWeb, Reddit)
- competitiveGaps: 3-5 gaps
- strategicRecommendations: 4-6 actionable recommendations`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude returned no valid JSON');
    const profileData = JSON.parse(jsonMatch[0]);

    if (saveToBrain) {
      // Deactivate old versions for this URL
      await pool.query(`UPDATE brand_profiles SET is_active = false WHERE brand_url = $1`, [brandUrl]);

      // Get next version number
      const versionResult = await pool.query(
        `SELECT MAX(version) as max_v FROM brand_profiles WHERE brand_url = $1`, [brandUrl]
      );
      const nextVersion = (versionResult.rows[0].max_v || 0) + 1;
      const id = `bp_${Date.now()}`;

      const inserted = await pool.query(
        `INSERT INTO brand_profiles (id, brand_url, brand_name, version, is_active, cache_status, profile_data)
         VALUES ($1, $2, $3, $4, true, 'fresh', $5) RETURNING *`,
        [id, brandUrl, brandName, nextVersion, JSON.stringify(profileData)]
      );

      const r = inserted.rows[0];
      return res.json({ success: true, data: {
        id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
        version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
        createdAt: r.created_at, updatedAt: r.updated_at, ...profileData
      }});
    }

    res.json({ success: true, data: {
      id: `bp_tmp_${Date.now()}`, brandUrl, brandName,
      version: 1, isActive: false, cacheStatus: 'fresh',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...profileData
    }});

  } catch (err) {
    console.error('Context Agent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Waitlist ─────────────────────────────────────────────────────────────────
app.post('/api/waitlist', async function (req, res) {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Forge Intelligence <hello@forgeintelligence.ai>',
        to: ['hello@forgeintelligence.ai'],
        subject: 'New early access request: ' + email,
        html: '<p>New early access request from <strong>' + email + '</strong></p>',
      }),
    });
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Forge Intelligence <hello@forgeintelligence.ai>',
        to: [email],
        subject: "You're on the list.",
        html: `<div style="font-family:Inter,system-ui,sans-serif;background:#0F1720;color:#F8FAFC;padding:48px 32px;max-width:520px;margin:0 auto;border-radius:12px">
  <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#3563FF;margin:0 0 24px">Forge Intelligence</p>
  <h1 style="font-size:24px;font-weight:600;margin:0 0 16px;line-height:1.3">You're on the list.</h1>
  <p style="color:#94A3B8;font-size:15px;line-height:1.7;margin:0 0 24px">Thanks for your interest in Forge Intelligence. We'll reach out when early access opens.</p>
  <p style="color:#94A3B8;font-size:15px;line-height:1.7;margin:0">Questions? Reply to this email or reach us at <a href="mailto:hello@forgeintelligence.ai" style="color:#3563FF;text-decoration:none">hello@forgeintelligence.ai</a>.</p>
  <p style="margin:40px 0 0;font-size:12px;color:#475569">© 2026 Sandbox Group LLC</p>
</div>`,
      }),
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err);
    return res.status(500).json({ error: 'Failed to send' });
  }
});

// ── Asset proxy ───────────────────────────────────────────────────────────────
app.get('/api/assets/:filename', async function (req, res) {
  try {
    const response = await fetch('https://forge-os.ai/api/assets/' + req.params.filename);
    if (!response.ok) throw new Error('Not found');
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', response.headers.get('content-type'));
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(404).send('Asset not found');
  }
});

// SPA catch-all
app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Forge Intelligence running on port ' + PORT);
});
