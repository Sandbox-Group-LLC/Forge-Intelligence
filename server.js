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
    // 1. Drop FK on geo_briefs that depends on brand_profiles.id
    await pool.query(`ALTER TABLE geo_briefs DROP CONSTRAINT IF EXISTS geo_briefs_brand_profile_id_fkey`);
    // 2. Drop PK so we can change type
    await pool.query(`ALTER TABLE brand_profiles DROP CONSTRAINT IF EXISTS brand_profiles_pkey`);
    // 3. Change both columns to TEXT
    await pool.query(`ALTER TABLE brand_profiles ALTER COLUMN id TYPE TEXT USING id::text`);
    await pool.query(`ALTER TABLE geo_briefs ALTER COLUMN brand_profile_id TYPE TEXT USING brand_profile_id::text`);
    // 4. Recreate PK and FK
    await pool.query(`ALTER TABLE brand_profiles ADD PRIMARY KEY (id)`);
    await pool.query(`ALTER TABLE geo_briefs ADD CONSTRAINT geo_briefs_brand_profile_id_fkey FOREIGN KEY (brand_profile_id) REFERENCES brand_profiles(id) ON DELETE CASCADE`);
    console.log('NeonDB: id + geo_briefs.brand_profile_id both converted to TEXT, FK recreated');
  } catch(e) {
    console.log('NeonDB: id already TEXT or table not yet created:', e.message);
  }

  // Migration: drop FK + NOT NULL on all legacy columns so new inserts work
  try {
    // 1. Drop any foreign key constraints referencing clients table
    const fkResult = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'brand_profiles'::regclass AND contype = 'f'
    `);
    for (const row of fkResult.rows) {
      await pool.query(`ALTER TABLE brand_profiles DROP CONSTRAINT IF EXISTS "${row.conname}"`);
      console.log('NeonDB: dropped FK constraint:', row.conname);
    }

    // 2. Drop NOT NULL on all legacy columns in one statement
    await pool.query(`
      ALTER TABLE brand_profiles
        ALTER COLUMN client_id DROP NOT NULL,
        ALTER COLUMN voice_profile DROP NOT NULL,
        ALTER COLUMN personas DROP NOT NULL,
        ALTER COLUMN third_party_signals DROP NOT NULL,
        ALTER COLUMN competitive_gaps DROP NOT NULL,
        ALTER COLUMN last_scraped DROP NOT NULL
    `);
    console.log('NeonDB: legacy NOT NULL constraints dropped');

    // 3. Set default for client_id so old rows are unaffected
    await pool.query(`
      ALTER TABLE brand_profiles
        ALTER COLUMN client_id SET DEFAULT NULL
    `);
    console.log('NeonDB: client_id default set to NULL');

  } catch(e) {
    console.log('NeonDB: legacy migration note:', e.message);
  }

  // Clean up legacy rows where brand_name/brand_url were set to UUID instead of real values
  try {
    const uuidRegex = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    const badRows = await pool.query(
      `SELECT id, brand_url, brand_name, profile_data FROM brand_profiles WHERE brand_url ~ $1 OR brand_name ~ $1`,
      [uuidRegex]
    );

    const domainToName = (url) => {
      const clean = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    };

    for (const row of badRows.rows) {
      const pd = row.profile_data || {};
      const realUrl = pd.brandUrl || pd.brand_url || null;
      const realName = pd.brandName || pd.brand_name || (realUrl ? domainToName(realUrl) : null);
      if (realUrl || realName) {
        await pool.query(
          `UPDATE brand_profiles SET brand_url = COALESCE($1, brand_url), brand_name = COALESCE($2, brand_name) WHERE id = $3`,
          [realUrl, realName, row.id]
        );
      }
    }
    if (badRows.rows.length > 0) console.log('NeonDB: fixed ' + badRows.rows.length + ' legacy UUID brand rows');
  } catch(e) {
    console.log('NeonDB: UUID cleanup note:', e.message);
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

    const idColResult = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'brand_profiles' AND column_name = 'id'
    `);
    if (idColResult.rows.length && idColResult.rows[0].data_type === 'uuid') {
      await pool.query(`ALTER TABLE brand_profiles ALTER COLUMN id TYPE TEXT USING id::text`);
      console.log('NeonDB: converted id column from uuid to text');
    }

    console.log('NeonDB: schema reconciled');
  }

  // ── geo_briefs table ────────────────────────────────────────────────────────
  try {
    const geoCheck = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'geo_briefs'
    `);
    if (geoCheck.rows.length === 0) {
      await pool.query(`
        CREATE TABLE geo_briefs (
          id TEXT PRIMARY KEY,
          brand_profile_id TEXT NOT NULL REFERENCES brand_profiles(id) ON DELETE CASCADE,
          brand_url TEXT NOT NULL,
          brand_name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          brief_data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_gb_brand_profile ON geo_briefs(brand_profile_id);
        CREATE INDEX IF NOT EXISTS idx_gb_brand_url ON geo_briefs(brand_url);
      `);
      console.log('NeonDB: geo_briefs table created');
    } else {
      console.log('NeonDB: geo_briefs table already exists');
    }
  } catch(e) {
    console.log('NeonDB: geo_briefs init note:', e.message);
  }
}

  // ── geo_briefs: add opportunity_score column if missing ─────────────────────
  try {
    await pool.query(`ALTER TABLE geo_briefs ADD COLUMN IF NOT EXISTS opportunity_score INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE geo_briefs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE geo_briefs ADD COLUMN IF NOT EXISTS brand_url TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE geo_briefs ADD COLUMN IF NOT EXISTS brand_name TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE geo_briefs ADD COLUMN IF NOT EXISTS brief_data JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE geo_briefs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await pool.query(`ALTER TABLE geo_briefs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await pool.query(`ALTER TABLE geo_briefs ALTER COLUMN client_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE geo_briefs ALTER COLUMN client_id SET DEFAULT NULL`);
    console.log('NeonDB: geo_briefs columns ensured');
  } catch(e) { console.log('NeonDB: geo_briefs migration note:', e.message); }

  // ── patterns: drop client_id NOT NULL if present ───────────────────────────
  try {
    await pool.query(`ALTER TABLE patterns ALTER COLUMN client_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE patterns ALTER COLUMN client_id SET DEFAULT NULL`);
    console.log('NeonDB: patterns.client_id nullable ensured');
  } catch(e) { console.log('NeonDB: patterns migration note:', e.message); }

  // ── Brain tables: patterns, mistakes, memories ────────────────────────────
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY, pattern_type VARCHAR(100), success_rate FLOAT,
      confidence_score FLOAT, tags JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mistakes (
      id TEXT PRIMARY KEY, mistake_type VARCHAR(100), human_feedback TEXT,
      guardrail_created TEXT, severity VARCHAR(20), created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, raw_content TEXT, metadata JSONB,
      performance_outcome JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    console.log('NeonDB: Brain tables (patterns, mistakes, memories) ensured');
  } catch(e) { console.log('NeonDB: Brain tables note:', e.message); }


initDB().catch(err => console.error('DB init error:', err));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// ── Context Agent API ─────────────────────────────────────────────────────────

app.get('/api/context-hub/brains', async (req, res) => {
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

app.get('/api/context-hub/brains/:id', async (req, res) => {
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

app.get('/api/context-hub/history/:encodedUrl', async (req, res) => {
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

app.post('/api/context-hub/analyze', async (req, res) => {
  const { brandUrl, competitorUrls = [], audienceNotes = '', strategicNotes = '', checkBrainFirst = true, saveToBrain = true } = req.body;
  if (!brandUrl) {
    return res.status(400).json({ success: false, error: 'brandUrl is required' });
  }

  const domainToName = (url) => {
    const clean = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  };
  const brandName = domainToName(brandUrl);
  const startTime = Date.now();

  try {
    // ── Brain-First: cache check ──────────────────────────────────────────────
    if (checkBrainFirst) {
      const existing = await pool.query(
        `SELECT * FROM brand_profiles WHERE brand_url = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        await pool.query(`UPDATE brand_profiles SET cache_status = 'cached' WHERE id = $1`, [r.id]);
        console.log(`[Context Hub] Cache hit for ${brandUrl}`);
        return res.json({ success: true, cached: true, data: {
          id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
          version: r.version, isActive: r.is_active, cacheStatus: 'cached',
          createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
        }});
      }
    }

    // ── Tool 1: Perplexity Sonar — competitor + ICP discovery ────────────────
    console.log(`[Context Hub] Tool 1: Perplexity Sonar research for ${brandUrl}...`);
    let sonarCompetitors = [];
    let sonarICP = '';
    let sonarContext = '';

    try {
      const sonarRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{
            role: 'user',
            content: `Research the brand at ${brandUrl} and return ONLY valid JSON (no markdown):
{
  "brandDescription": "1-2 sentence description of what this company does",
  "competitors": ["url1", "url2", "url3"],
  "targetICP": "specific description of their ideal customer profile — job title, company size, pain points",
  "marketCategory": "the specific market category this brand competes in",
  "keyDifferentiators": ["string"],
  "contentThemes": ["main topics this brand and competitors publish content about"]
}
Return exactly 3 competitor URLs. Be specific and accurate.`
          }],
          max_tokens: 800
        })
      });

      if (sonarRes.ok) {
        const sonarData = await sonarRes.json();
        const sonarText = sonarData.choices[0].message.content;
        const sonarMatch = sonarText.match(/\{[\s\S]*\}/);
        if (sonarMatch) {
          const sonarJson = JSON.parse(sonarMatch[0]);
          // Merge Sonar competitors with any manual overrides passed by user
          sonarCompetitors = competitorUrls.length > 0 ? competitorUrls : (sonarJson.competitors || []);
          sonarICP = sonarJson.targetICP || '';
          sonarContext = `Brand description: ${sonarJson.brandDescription}
Market category: ${sonarJson.marketCategory}
Key differentiators: ${(sonarJson.keyDifferentiators || []).join(', ')}
Content themes in this market: ${(sonarJson.contentThemes || []).join(', ')}`;
          console.log(`[Context Hub] Sonar found ${sonarCompetitors.length} competitors, ICP: ${sonarICP.slice(0, 80)}...`);
        }
      }
    } catch(e) {
      console.log('[Context Hub] Sonar research failed, proceeding without:', e.message);
    }

    // ── Tool 2: Claude — Brand Intelligence Profile ───────────────────────────
    console.log(`[Context Hub] Tool 2: Claude brand analysis...`);

    const competitorSection = sonarCompetitors.length ? `\nCompetitor URLs (auto-discovered): ${sonarCompetitors.join(', ')}` : '';
    const icpSection = sonarICP ? `\nICP context (auto-discovered): ${sonarICP}` : '';
    const marketSection = sonarContext ? `\nMarket context: ${sonarContext}` : '';
    const audienceSection = audienceNotes ? `\nAdditional audience context: ${audienceNotes}` : '';
    const strategicSection = strategicNotes ? `\nAdditional strategic context: ${strategicNotes}` : '';

    const prompt = `You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

Analyze the brand at: ${brandUrl}${competitorSection}${icpSection}${marketSection}${audienceSection}${strategicSection}

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
  "strategicRecommendations": [{ "id": "string", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }],
  "discoveredCompetitors": ["string"],
  "marketCategory": "string"
}
Requirements: 5 toneAttributes, 2-3 personas, 4-6 thirdPartySignals, 3-5 competitiveGaps, 4-6 strategicRecommendations. Use the ICP and market context provided to make personas and gaps highly specific.`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude returned no valid JSON');
    const profileData = JSON.parse(jsonMatch[0]);

    // Inject discovered competitors into profile
    profileData.discoveredCompetitors = sonarCompetitors;

    const latencyMs = Date.now() - startTime;
    console.log(`[Context Hub] Complete — ${brandName} | Latency: ${latencyMs}ms | Competitors found: ${sonarCompetitors.length}`);

    if (saveToBrain) {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const resolvedBrandName = (profileData.brandName && !uuidPattern.test(profileData.brandName))
        ? profileData.brandName : brandName;

      await pool.query(`UPDATE brand_profiles SET is_active = false WHERE brand_url = $1`, [brandUrl]);
      const versionResult = await pool.query(
        `SELECT COALESCE(MAX(version), 0) as max_v FROM brand_profiles WHERE brand_url = $1`, [brandUrl]
      );
      const nextVersion = versionResult.rows[0].max_v + 1;
      const id = randomUUID();

      const inserted = await pool.query(
        `INSERT INTO brand_profiles (id, brand_url, brand_name, version, is_active, cache_status, profile_data)
         VALUES ($1, $2, $3, $4, true, 'fresh', $5) RETURNING *`,
        [id, brandUrl, resolvedBrandName, nextVersion, JSON.stringify(profileData)]
      );
      const r = inserted.rows[0];
      return res.json({ success: true, cached: false, data: {
        id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
        version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
        latencyMs, discoveredCompetitors: sonarCompetitors,
        createdAt: r.created_at, updatedAt: r.updated_at, ...profileData
      }});
    }

    res.json({ success: true, cached: false, data: {
      id: randomUUID(), brandUrl, brandName,
      version: 1, isActive: false, cacheStatus: 'fresh',
      latencyMs, discoveredCompetitors: sonarCompetitors,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...profileData
    }});

  } catch (err) {
    console.error('[Context Hub] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── GEO data normalizer — shared by fresh + cached responses ─────────────────
function normalizeGeoData(briefData, topicalMap, geoOpportunities, entitySchema, profile) {
  const gaps = (topicalMap && topicalMap.gapsByCluster) || [];
  const topicalAuthorityMap = gaps.map(g => ({
    topic: g.topic || g.cluster || 'Unknown',
    coverage: g.rationale || g.owner || '',
    citationProbability: g.geoCitationScore || g.citationProbability || 0,
    priority: (g.geoCitationScore || 0) >= 70 ? 'high' : (g.geoCitationScore || 0) >= 40 ? 'medium' : 'low'
  }));

  const topicMap = {};
  (geoOpportunities || []).forEach(o => {
    const t = o.topic || 'Unknown';
    if (!topicMap[t]) topicMap[t] = { topic: t, chatgpt: 0, perplexity: 0, aiOverviews: 0, gemini: 0, quickWin: o.quickWin || false };
    const p = (o.platform || '').toLowerCase().replace(/\s/g, '');
    if (p.includes('chatgpt') || p.includes('openai')) topicMap[t].chatgpt = o.score || 0;
    else if (p.includes('perplexity')) topicMap[t].perplexity = o.score || 0;
    else if (p.includes('overview') || p.includes('google')) topicMap[t].aiOverviews = o.score || 0;
    else if (p.includes('gemini')) topicMap[t].gemini = o.score || 0;
    if (o.quickWin) topicMap[t].quickWin = true;
  });
  const geoOpportunitiesNorm = Object.values(topicMap);

  const entitySchemaMap = (entitySchema || []).map(e => ({
    entity: e.entity || '',
    schemaType: Array.isArray(e.schemaTypes) ? e.schemaTypes[0] : (e.schemaType || 'Article'),
    competitorCited: e.competitorCiting || e.competitorCited || false,
    recommendation: e.rationale || e.recommendation || ''
  }));

  const h2sRaw = briefData.h2s || [];
  const geoBrief = {
    title: briefData.titleTag || briefData.title || briefData.targetTopic || (profile && profile.brand_name) || '',
    h1: briefData.h1 || briefData.targetTopic || '',
    h2s: h2sRaw.map(h => typeof h === 'string' ? h : h.heading || h.h2 || ''),
    faqItems: (briefData.faqStructure || briefData.faqItems || []).map(f => ({
      q: f.question || f.q || '',
      a: f.answerDirection || f.answer || f.a || ''
    })),
    geoAnchors: briefData.geoAnchors || [],
    estimatedCitationLift: briefData.geoScorecard
      ? `+${Math.round((briefData.geoScorecard.currentReadiness || 0) * 0.4)}% in 90 days`
      : '+15–30% in 90 days'
  };

  return { topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief };
}

// ── GEO Strategist API (Stage 2) ──────────────────────────────────────────────

// Extracts the first complete JSON object or array from a string — handles trailing text/markdown
function extractJSON(text, type = 'object') {
  // Strip markdown code fences if present
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
  const open = type === 'array' ? '[' : '{';
  const close = type === 'array' ? ']' : '}';
  const start = stripped.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === open) depth++;
    else if (stripped[i] === close) { depth--; if (depth === 0) return stripped.slice(start, i + 1); }
  }
  return null;
}

app.get('/api/geo-strategist/briefs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data, created_at, updated_at
       FROM geo_briefs ORDER BY updated_at DESC`
    );
    const data = result.rows.map(r => ({
      id: r.id, brandProfileId: r.brand_profile_id,
      brandUrl: r.brand_url, brandName: r.brand_name,
      version: r.version, opportunityScore: r.opportunity_score,
      createdAt: r.created_at, updatedAt: r.updated_at,
      ...r.brief_data
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/geo-strategist/briefs/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM geo_briefs WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const r = result.rows[0];
    res.json({ success: true, data: {
      id: r.id, brandProfileId: r.brand_profile_id,
      brandUrl: r.brand_url, brandName: r.brand_name,
      version: r.version, opportunityScore: r.opportunity_score,
      createdAt: r.created_at, updatedAt: r.updated_at,
      ...r.brief_data
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/geo-strategist/analyze', async (req, res) => {
  const { brandProfileId, topicFocus = '', additionalContext = '' } = req.body;
  if (!brandProfileId) {
    return res.status(400).json({ success: false, error: 'brandProfileId is required' });
  }

  const startTime = Date.now();

  try {
    // ── Step 0: Brain-First Protocol ─────────────────────────────────────────
    let brainPatterns = [], brainMistakes = [], brainMemories = [];
    try {
      const [pRes, mRes, memRes] = await Promise.all([
        pool.query(`SELECT pattern_type, success_rate, confidence_score, tags FROM patterns ORDER BY success_rate DESC LIMIT 10`),
        pool.query(`SELECT mistake_type, human_feedback, guardrail_created, severity FROM mistakes ORDER BY created_at DESC LIMIT 10`),
        pool.query(`SELECT raw_content, metadata, performance_outcome FROM memories ORDER BY created_at DESC LIMIT 5`),
      ]);
      brainPatterns = pRes.rows;
      brainMistakes = mRes.rows;
      brainMemories = memRes.rows;
    } catch(e) {
      console.log('[GEO] Brain tables not seeded — proceeding cold:', e.message);
    }

    const brainContext = `BRAIN PATTERNS (what worked): ${JSON.stringify(brainPatterns)}
BRAIN MISTAKES (DO NOT repeat): ${JSON.stringify(brainMistakes)}
BRAIN MEMORIES (high performers): ${JSON.stringify(brainMemories)}`;

    // ── Step 1: Load Stage 1 brand profile ───────────────────────────────────
    const profileResult = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]);
    if (!profileResult.rows.length) {
      return res.status(404).json({ success: false, error: 'Brand profile not found. Run Stage 1 first.' });
    }
    const profile = profileResult.rows[0];
    const pd = profile.profile_data || {};

    // ── Cache check ──────────────────────────────────────────────────────────
    if (!topicFocus && !additionalContext) {
      const existing = await pool.query(
        `SELECT * FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`, [brandProfileId]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const bd = r.brief_data || {};
        const normalized = normalizeGeoData(bd, bd.topicalMap || {}, bd.geoOpportunities || [], bd.entitySchema || [], r);
        return res.json({ success: true, cached: true, data: {
          id: r.id, brandProfileId: r.brand_profile_id,
          brandUrl: r.brand_url, brandName: r.brand_name,
          version: r.version, opportunityScore: r.opportunity_score,
          createdAt: r.created_at, updatedAt: r.updated_at,
          ...normalized
        }});
      }
    }

    const voiceProfile = pd.voiceProfile || {};
    const personas = pd.personas || [];
    const competitiveGaps = pd.competitiveGaps || {};
    const whitespace = typeof competitiveGaps === 'string' ? competitiveGaps : (competitiveGaps.whitespace || '');
    const competitorTopics = Array.isArray(competitiveGaps) ? competitiveGaps : (competitiveGaps.competitorOwnedTopics || []);

    // ── Tool 1: Topical Authority Mapper ─────────────────────────────────────
    console.log('[GEO] Tool 1: Topical Authority Mapper...');
    const topicalRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: `You are the Topical Authority Mapper for Forge Intelligence GEO Strategist.

${brainContext}

BRAND: ${profile.brand_name} (${profile.brand_url})
Voice summary: ${JSON.stringify(voiceProfile).slice(0, 500)}
Personas: ${JSON.stringify(personas).slice(0, 500)}
Competitor-owned topics: ${JSON.stringify(competitorTopics)}
Brand whitespace opportunity: ${whitespace}
${topicFocus ? 'Focus topic: ' + topicFocus : ''}

Map topical authority clusters. Score each gap by GEO citation probability (0-100).

Return ONLY valid JSON:
{"brandClusters":["topic"],"competitorClusters":["topic"],"gapsByCluster":[{"topic":"string","geoCitationScore":0,"owner":"string|null","rationale":"string"}]}` }]
    });
    let topicalMap = {};
    try {
      const tm = extractJSON(topicalRes.content[0].text, 'object');
      if (!tm) throw new Error('No JSON object found in Tool 1 response');
      topicalMap = JSON.parse(tm);
    } catch(e) { console.log('[GEO] Tool 1 parse warn:', e.message, '| raw:', topicalRes.content[0].text.slice(0,200)); topicalMap = { brandClusters: [], competitorClusters: [], gapsByCluster: [] }; }

    // ── Tool 2: GEO Opportunity Scorer ────────────────────────────────────────
    console.log('[GEO] Tool 2: GEO Opportunity Scorer...');
    const scorerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `You are the GEO Opportunity Scorer for Forge Intelligence.

TOPICAL MAP: ${JSON.stringify(topicalMap)}
BRAND WHITESPACE: ${whitespace}

Score each gap across ChatGPT, Perplexity, Google AI Overviews, and Gemini.
- recencyBias (0-1): platform preference for fresh content
- entityAuthority (0-1): brand entity recognition in this topic
- structuralFit (0-1): FAQ/HowTo/Article schema citation likelihood
- quickWin: true if brand has authority but no content yet

Return ONLY valid JSON array:
[{"platform":"string","topic":"string","score":0,"recencyBias":0,"entityAuthority":0,"structuralFit":0,"quickWin":false}]` }]
    });
    let geoOpportunities = [];
    try {
      const go = extractJSON(scorerRes.content[0].text, 'array');
      if (!go) throw new Error('No JSON array found in Tool 2 response');
      geoOpportunities = JSON.parse(go);
    } catch(e) { console.log('[GEO] Tool 2 parse warn:', e.message, '| raw:', scorerRes.content[0].text.slice(0,200)); }

    // ── Tool 3: Entity & Schema Mapper ────────────────────────────────────────
    console.log('[GEO] Tool 3: Entity & Schema Mapper...');
    const entityRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: `You are the Entity & Schema Mapper for Forge Intelligence.

BRAND: ${profile.brand_name}
COMPETITIVE GAPS: ${JSON.stringify(competitorTopics).slice(0, 400)}
TOP GEO OPPORTUNITIES: ${JSON.stringify(geoOpportunities.slice(0, 8))}

Identify entities needing structured markup for AI citation. Flag competitor entities this brand is NOT being cited for.

Return ONLY valid JSON array:
[{"entity":"string","schemaTypes":["Article"],"competitorCiting":false,"priority":"high|medium|low","rationale":"string"}]` }]
    });
    let entitySchema = [];
    try {
      const es = extractJSON(entityRes.content[0].text, 'array');
      if (!es) throw new Error('No JSON array found in Tool 3 response');
      entitySchema = JSON.parse(es);
    } catch(e) { console.log('[GEO] Tool 3 parse warn:', e.message, '| raw:', entityRes.content[0].text.slice(0,200)); }

    // ── Tool 4: Brief Generator ───────────────────────────────────────────────
    console.log('[GEO] Tool 4: Brief Generator...');
    const quickWins = geoOpportunities.filter(o => o.quickWin).slice(0, 3);
    const targetTopic = topicFocus || quickWins[0]?.topic || geoOpportunities[0]?.topic || whitespace || profile.brand_name + ' strategy';

    const briefRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `You are the GEO Brief Generator for Forge Intelligence.

MANDATORY BRAIN-FIRST CHECK:
${brainContext}
DO NOT repeat patterns flagged as mistakes above.

BRAND: ${profile.brand_name} | Voice: ${JSON.stringify(voiceProfile).slice(0, 400)}
Personas: ${JSON.stringify(personas).slice(0, 400)}
Whitespace: ${whitespace}
TARGET TOPIC: ${targetTopic}
TOP OPPORTUNITIES: ${JSON.stringify(geoOpportunities.slice(0, 6))}
HIGH-PRIORITY ENTITIES: ${JSON.stringify(entitySchema.filter(e => e.priority === 'high'))}
${additionalContext ? 'Additional context: ' + additionalContext : ''}

Generate a complete GEO-optimized content brief structured for AI citation.

Return ONLY valid JSON:
{
  "targetTopic":"string","executiveSummary":"string","h1":"string",
  "h2s":[{"heading":"string","intent":"string","geoAnchor":"string"}],
  "entities":["string"],"faqStructure":[{"question":"string","answerDirection":"string"}],
  "geoAnchors":["string"],"schemaRequirements":["string"],
  "overallOpportunityScore":0,"targetPlatforms":["string"],
  "contentCalendar":{"month1":["string"],"month2":["string"],"month3":["string"]},
  "quickWins":[{"topic":"string","rationale":"string","geoTarget":"string"}],
  "geoScorecard":{"currentReadiness":0,"primaryGap":"string","topOpportunity":"string"},
  "briefRationale":"string"
}` }]
    });
    let briefData = {};
    try {
      const bd = extractJSON(briefRes.content[0].text, 'object');
      if (!bd) throw new Error('No JSON object found in Tool 4 response');
      briefData = JSON.parse(bd);
    } catch(e) { console.log('[GEO] Tool 4 parse warn:', e.message, '| raw:', briefRes.content[0].text.slice(0,200)); briefData = { targetTopic, overallOpportunityScore: 50 }; }

    const opportunityScore = briefData.overallOpportunityScore || 0;

    // ── Persist to geo_briefs ─────────────────────────────────────────────────
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version), 0) as max_v FROM geo_briefs WHERE brand_profile_id = $1`, [brandProfileId]
    );
    const nextVersion = versionResult.rows[0].max_v + 1;
    const id = randomUUID();
    const fullBriefData = { ...briefData, topicalMap, geoOpportunities, entitySchema };

    await pool.query(
      `INSERT INTO geo_briefs (id, client_id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, null, brandProfileId, profile.brand_url, profile.brand_name, nextVersion, opportunityScore, JSON.stringify(fullBriefData)]
    );

    // ── Write pattern if score >= 75 ──────────────────────────────────────────
    if (opportunityScore >= 75) {
      try {
        await pool.query(
          `INSERT INTO patterns (id, pattern_type, success_rate, confidence_score, tags, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT DO NOTHING`,
          [randomUUID(), 'geo-brief-high-score', opportunityScore / 100, opportunityScore / 100,
           JSON.stringify({ topic: briefData.targetTopic, platforms: briefData.targetPlatforms, score: opportunityScore, brandUrl: profile.brand_url })]
        );
        console.log(`[GEO] Pattern written — score ${opportunityScore} >= 75`);
      } catch(e) { console.log('[GEO] Pattern write skipped:', e.message); }
    }

    const latencyMs = Date.now() - startTime;
    console.log(`[GEO] Complete — Score: ${opportunityScore} | Latency: ${latencyMs}ms | QuickWins: ${quickWins.length}`);

    const { topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief } = normalizeGeoData(briefData, topicalMap, geoOpportunities, entitySchema, profile);
    res.json({ success: true, cached: false, data: {
      id, brandProfileId, brandUrl: profile.brand_url, brandName: profile.brand_name,
      version: nextVersion, opportunityScore, latencyMs,
      topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief
    }});

  } catch (err) {
    console.error('[GEO] Error:', err);
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
