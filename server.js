import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function initDB() {
  // Always ensure id column is TEXT (old schema used UUID)
  try {
    // Drop PK constraint first so we can change the column type
    await pool.query(`
      ALTER TABLE brand_profiles DROP CONSTRAINT IF EXISTS brand_profiles_pkey
    `);
    await pool.query(`
      ALTER TABLE brand_profiles ALTER COLUMN id TYPE TEXT USING id::text
    `);
    await pool.query(`
      ALTER TABLE brand_profiles ADD PRIMARY KEY (id)
    `);
    console.log('NeonDB: id column ensured as TEXT with PK recreated');
  } catch(e) {
    console.log('NeonDB: id already TEXT or table not yet created:', e.message);
  }

  const tableCheck = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'brand_profiles'
  `);

  if (tableCheck.rows.length === 0) {
    await pool.query(`
      CREATE TABLE brand_profiles (
        id TEXT PRIMARY KEY,
        brand_url TEXT NOT NULL,
        brand_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT true,
        cache_status TEXT NOT NULL DEFAULT 'fresh',
        profile_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bp_url ON brand_profiles(brand_url);
      CREATE INDEX IF NOT EXISTS idx_bp_active ON brand_profiles(is_active);
    `);
    console.log('NeonDB: brand_profiles table created fresh');
  } else {
    const colResult = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'brand_profiles'
    `);
    const cols = colResult.rows.map(r => r.column_name);

    // Add any missing new columns
    const required = [
      { name: 'brand_url',    def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'brand_name',   def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'version',      def: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'is_active',    def: 'BOOLEAN NOT NULL DEFAULT true' },
      { name: 'cache_status', def: "TEXT NOT NULL DEFAULT 'fresh'" },
      { name: 'profile_data', def: "JSONB NOT NULL DEFAULT '{}'::jsonb" },
      { name: 'created_at',   def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
      { name: 'updated_at',   def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
    ];
    for (const col of required) {
      if (!cols.includes(col.name)) {
        await pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
        console.log(`NeonDB: added column ${col.name}`);
      }
    }

    // Migrate old columns into profile_data for any rows where profile_data is empty
    // Old schema: voice_profile, personas, third_party_signals, competitive_gaps, client_id, last_scraped
    if (cols.includes('voice_profile')) {
      await pool.query(`
        UPDATE brand_profiles
        SET
          profile_data = jsonb_build_object(
            'voiceProfile',             COALESCE(voice_profile, '{}'::jsonb),
            'personas',                 COALESCE(personas, '[]'::jsonb),
            'thirdPartySignals',        COALESCE(third_party_signals, '[]'::jsonb),
            'competitiveGaps',          COALESCE(competitive_gaps, '[]'::jsonb),
            'strategicRecommendations', '[]'::jsonb
          ),
          brand_url  = COALESCE(NULLIF(brand_url, ''), client_id::text, id::text),
          brand_name = COALESCE(NULLIF(brand_name, ''), client_id::text, id::text),
          is_active  = true,
          version    = 1,
          cache_status = 'fresh'
        WHERE profile_data = '{}'::jsonb OR profile_data IS NULL
      `);
      console.log('NeonDB: migrated old columns into profile_data');
    }

    // Convert id column from uuid to text if needed
    const idColResult = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'brand_profiles' AND column_name = 'id'
    `);
    if (idColResult.rows.length && idColResult.rows[0].data_type === 'uuid') {
      await pool.query(`
        ALTER TABLE brand_profiles
          ALTER COLUMN id TYPE TEXT USING id::text
      `);
      console.log('NeonDB: converted id column from uuid to text');
    }

    console.log('NeonDB: schema reconciled');
  }
}

initDB().catch(err => console.error('DB init error:', err));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// ── Context Agent API ─────────────────────────────────────────────────────────

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

app.get('/api/context-agent/brains/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [req.params.id]);
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

app.post('/api/context-agent/analyze', async (req, res) => {
  const { brandUrl, brandName, competitorUrls = [], audienceNotes = '', strategicNotes = '', checkBrainFirst = true, saveToBrain = true } = req.body;
  if (!brandUrl || !brandName) {
    return res.status(400).json({ success: false, error: 'brandUrl and brandName are required' });
  }

  try {
    if (checkBrainFirst) {
      const existing = await pool.query(
        `SELECT * FROM brand_profiles WHERE brand_url = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        await pool.query(`UPDATE brand_profiles SET cache_status = 'cached' WHERE id = $1`, [r.id]);
        return res.json({ success: true, data: {
          id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
          version: r.version, isActive: r.is_active, cacheStatus: 'cached',
          createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
        }});
      }
    }

    const competitorSection = competitorUrls.length ? `\nCompetitor URLs: ${competitorUrls.join(', ')}` : '';
    const audienceSection = audienceNotes ? `\nAudience context: ${audienceNotes}` : '';
    const strategicSection = strategicNotes ? `\nStrategic context: ${strategicNotes}` : '';

    const prompt = `You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

Analyze the brand at: ${brandUrl}${competitorSection}${audienceSection}${strategicSection}

Return ONLY valid JSON (no markdown, no explanation):
{
  "voiceProfile": {
    "summary": "string",
    "toneAttributes": [{ "attribute": "string", "score": 0-100, "description": "string" }],
    "writingStyle": "string",
    "keyPhrases": ["string"]
  },
  "personas": [{
    "id": "string", "name": "string", "role": "string",
    "painPoints": ["string"], "triggers": ["string"],
    "skepticism": "string", "motivations": ["string"]
  }],
  "thirdPartySignals": [{ "source": "string", "signalType": "string", "value": "string or null", "confidence": 0-100, "lastChecked": "ISO8601" }],
  "competitiveGaps": [{ "topic": "string", "ownedBy": "string or null", "whitespaceOpportunity": "string", "priority": "high|medium|low" }],
  "strategicRecommendations": [{ "id": "string", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }]
}
Requirements: 5 toneAttributes, 2-3 personas, 4-6 thirdPartySignals, 3-5 competitiveGaps, 4-6 strategicRecommendations`;

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
      await pool.query(`UPDATE brand_profiles SET is_active = false WHERE brand_url = $1`, [brandUrl]);
      const versionResult = await pool.query(
        `SELECT COALESCE(MAX(version), 0) as max_v FROM brand_profiles WHERE brand_url = $1`, [brandUrl]
      );
      const nextVersion = versionResult.rows[0].max_v + 1;
      const id = randomUUID();

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
      id: randomUUID(), brandUrl, brandName,
      version: 1, isActive: false, cacheStatus: 'fresh',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...profileData
    }});

  } catch (err) {
    console.error('Context Agent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Waitlist ──────────────────────────────────────────────────────────────────
app.post('/api/waitlist', async function (req, res) {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
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
  <p style="color:#94A3B8;font-size:15px;line-height:1.7;margin:0">Questions? <a href="mailto:hello@forgeintelligence.ai" style="color:#3563FF;text-decoration:none">hello@forgeintelligence.ai</a></p>
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

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Forge Intelligence running on port ' + PORT);
});
