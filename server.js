import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID, randomBytes, createHmac } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── X OAuth 1.0a helper (verified working) ───────────────────────────────────
function buildXOAuthHeader(method, url, apiKey, apiSecret, accessToken, accessSecret, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const allParams = { ...oauthParams, ...extraParams };
  const paramStr = Object.entries(allParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`;
  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessSecret)}`;
  oauthParams['oauth_signature'] = createHmac('sha1', signingKey).update(baseString).digest('base64');
  return 'OAuth ' + Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(', ');
}

const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLERK_JWKS_URL = process.env.CLERK_JWKS_URL || 'https://clerk.forgeintelligence.ai/.well-known/jwks.json';
const clerkJWKS = createRemoteJWKSet(new URL(CLERK_JWKS_URL));
const SUPER_ADMIN_IDS = [
  'user_3BtC7nusm7CShN7EdUYaaLZcDwp', // brian@sandbox-xm.com
];

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 1200000 });

async function initDB() {
  try {
    await pool.query(`ALTER TABLE geo_briefs DROP CONSTRAINT IF EXISTS geo_briefs_brand_profile_id_fkey`);
    await pool.query(`ALTER TABLE brand_profiles DROP CONSTRAINT IF EXISTS brand_profiles_pkey`);
    await pool.query(`ALTER TABLE brand_profiles ALTER COLUMN id TYPE TEXT USING id::text`);
    await pool.query(`ALTER TABLE geo_briefs ALTER COLUMN brand_profile_id TYPE TEXT USING brand_profile_id::text`);
    await pool.query(`ALTER TABLE brand_profiles ADD PRIMARY KEY (id)`);
    await pool.query(`ALTER TABLE geo_briefs ADD CONSTRAINT geo_briefs_brand_profile_id_fkey FOREIGN KEY (brand_profile_id) REFERENCES brand_profiles(id) ON DELETE CASCADE`);
    console.log('NeonDB: id + geo_briefs.brand_profile_id both converted to TEXT, FK recreated');
  } catch(e) {
    console.log('NeonDB: id already TEXT or table not yet created:', e.message);
  }

  try {
    const fkResult = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'brand_profiles'::regclass AND contype = 'f'`);
    for (const row of fkResult.rows) {
      await pool.query(`ALTER TABLE brand_profiles DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    }
    await pool.query(`ALTER TABLE brand_profiles ALTER COLUMN client_id DROP NOT NULL, ALTER COLUMN voice_profile DROP NOT NULL, ALTER COLUMN personas DROP NOT NULL, ALTER COLUMN third_party_signals DROP NOT NULL, ALTER COLUMN competitive_gaps DROP NOT NULL, ALTER COLUMN last_scraped DROP NOT NULL`);
    await pool.query(`ALTER TABLE brand_profiles ALTER COLUMN client_id SET DEFAULT NULL`);
  } catch(e) {
    console.log('NeonDB: legacy migration note:', e.message);
  }

  try {
    const uuidRegex = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    const badRows = await pool.query(`SELECT id, brand_url, brand_name, profile_data FROM brand_profiles WHERE brand_url ~ $1 OR brand_name ~ $1`, [uuidRegex]);
    const domainToName = (url) => {
      const clean = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    };
    for (const row of badRows.rows) {
      const pd = row.profile_data || {};
      const realUrl = pd.brandUrl || pd.brand_url || null;
      const realName = pd.brandName || pd.brand_name || (realUrl ? domainToName(realUrl) : null);
      if (realUrl || realName) {
        await pool.query(`UPDATE brand_profiles SET brand_url = COALESCE($1, brand_url), brand_name = COALESCE($2, brand_name) WHERE id = $3`, [realUrl, realName, row.id]);
      }
    }
    if (badRows.rows.length > 0) console.log('NeonDB: fixed ' + badRows.rows.length + ' legacy UUID brand rows');
  } catch(e) {
    console.log('NeonDB: UUID cleanup note:', e.message);
  }

  const tableCheck = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'brand_profiles'`);

  if (tableCheck.rows.length === 0) {
    await pool.query(`
      CREATE TABLE brand_profiles (
        id TEXT PRIMARY KEY, brand_url TEXT NOT NULL, brand_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, is_active BOOLEAN NOT NULL DEFAULT true,
        cache_status TEXT NOT NULL DEFAULT 'fresh', profile_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bp_url ON brand_profiles(brand_url);
      CREATE INDEX IF NOT EXISTS idx_bp_active ON brand_profiles(is_active);
    `);
    console.log('NeonDB: brand_profiles table created fresh');
  } else {
    const colResult = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'brand_profiles'`);
    const cols = colResult.rows.map(r => r.column_name);
    const required = [
      { name: 'brand_url', def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'brand_name', def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'version', def: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'is_active', def: 'BOOLEAN NOT NULL DEFAULT true' },
      { name: 'cache_status', def: "TEXT NOT NULL DEFAULT 'fresh'" },
      { name: 'profile_data', def: "JSONB NOT NULL DEFAULT '{}'::jsonb" },
      { name: 'article_base_url', def: "TEXT DEFAULT ''" },
      { name: 'article_url_suffix', def: "TEXT DEFAULT ''" },
      { name: 'logo_url', def: "TEXT DEFAULT ''" },
      { name: 'settings', def: "JSONB NOT NULL DEFAULT '{}'" },
      { name: 'created_at', def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
      { name: 'updated_at', def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
    ];
    for (const col of required) {
      if (!cols.includes(col.name)) {
        await pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
        console.log(`NeonDB: added column ${col.name}`);
      }
    }
    if (cols.includes('voice_profile')) {
      await pool.query(`
        UPDATE brand_profiles SET
          profile_data = jsonb_build_object('voiceProfile', COALESCE(voice_profile, '{}'::jsonb), 'personas', COALESCE(personas, '[]'::jsonb), 'thirdPartySignals', COALESCE(third_party_signals, '[]'::jsonb), 'competitiveGaps', COALESCE(competitive_gaps, '[]'::jsonb), 'strategicRecommendations', '[]'::jsonb),
          brand_url = COALESCE(NULLIF(brand_url, ''), client_id::text, id::text),
          brand_name = COALESCE(NULLIF(brand_name, ''), client_id::text, id::text),
          is_active = true, version = 1, cache_status = 'fresh'
        WHERE profile_data = '{}'::jsonb OR profile_data IS NULL
      `);
      console.log('NeonDB: migrated old columns into profile_data');
    }
    const idColResult = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'brand_profiles' AND column_name = 'id'`);
    if (idColResult.rows.length && idColResult.rows[0].data_type === 'uuid') {
      await pool.query(`ALTER TABLE brand_profiles ALTER COLUMN id TYPE TEXT USING id::text`);
    }
    console.log('NeonDB: schema reconciled');
  }

  try {
    const geoCheck = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'geo_briefs'`);
    if (geoCheck.rows.length === 0) {
      await pool.query(`
        CREATE TABLE geo_briefs (
          id TEXT PRIMARY KEY, brand_profile_id TEXT NOT NULL REFERENCES brand_profiles(id) ON DELETE CASCADE,
          brand_url TEXT NOT NULL, brand_name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          brief_data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_gb_brand_profile ON geo_briefs(brand_profile_id);
        CREATE INDEX IF NOT EXISTS idx_gb_brand_url ON geo_briefs(brand_url);
      `);
      console.log('NeonDB: geo_briefs table created');
    }
  } catch(e) { console.log('NeonDB: geo_briefs init note:', e.message); }

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS enriched_briefs (
      id TEXT PRIMARY KEY, brand_profile_id TEXT NOT NULL DEFAULT '', geo_brief_id TEXT,
      brand_url TEXT NOT NULL DEFAULT '', brand_name TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, confidence_score INTEGER DEFAULT 0,
      enriched_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const enrichColRes = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'enriched_briefs'`);
    const existingEnrichCols = enrichColRes.rows.map(r => r.column_name);
    const enrichCols = [
      { name: 'brand_profile_id', def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'geo_brief_id', def: 'TEXT' },
      { name: 'brand_url', def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'article_base_url', def: "TEXT DEFAULT ''" },
      { name: 'article_url_suffix', def: "TEXT DEFAULT ''" },
      { name: 'logo_url', def: "TEXT DEFAULT ''" },
      { name: 'settings', def: "JSONB NOT NULL DEFAULT '{}'" },
      { name: 'brand_name', def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'version', def: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'confidence_score', def: 'INTEGER DEFAULT 0' },
      { name: 'enriched_data', def: "JSONB NOT NULL DEFAULT '{}'::jsonb" },
      { name: 'created_at', def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
      { name: 'updated_at', def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
    ];
    for (const col of enrichCols) {
      if (!existingEnrichCols.includes(col.name)) {
        await pool.query(`ALTER TABLE enriched_briefs ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
      }
    }
    try { await pool.query(`ALTER TABLE enriched_briefs ALTER COLUMN client_id DROP NOT NULL`); await pool.query(`ALTER TABLE enriched_briefs ALTER COLUMN client_id SET DEFAULT NULL`); } catch(e) {}
    console.log('NeonDB: enriched_briefs table ensured');
  } catch(e) { console.log('NeonDB: enriched_briefs init note:', e.message); }
}

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

  try {
    await pool.query(`ALTER TABLE patterns ALTER COLUMN client_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE patterns ALTER COLUMN client_id SET DEFAULT NULL`);
  } catch(e) { console.log('NeonDB: patterns migration note:', e.message); }

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS patterns (id TEXT PRIMARY KEY, pattern_type VARCHAR(100), success_rate FLOAT, confidence_score FLOAT, tags JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mistakes (id TEXT PRIMARY KEY, mistake_type VARCHAR(100), human_feedback TEXT, guardrail_created TEXT, severity VARCHAR(20), created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, raw_content TEXT, metadata JSONB, performance_outcome JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS brain_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_profile_id TEXT NOT NULL,
      pattern_type VARCHAR(100), description TEXT, confidence_score FLOAT DEFAULT 0,
      success_rate FLOAT DEFAULT 0, tags JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS brain_mistakes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_profile_id TEXT NOT NULL,
      mistake_type VARCHAR(100), description TEXT, human_feedback TEXT,
      guardrail_created TEXT, severity VARCHAR(20) DEFAULT 'low',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS brain_patterns_brand_idx ON brain_patterns(brand_profile_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS geo_citations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL, engine TEXT NOT NULL, query TEXT NOT NULL,
      is_cited BOOLEAN DEFAULT false, cited_url TEXT, cited_section TEXT,
      response_snippet TEXT, raw_citations JSONB DEFAULT '[]', checked_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(brand_profile_id, content_id, engine, query)
    )`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_geo_citations_brand ON geo_citations(brand_profile_id, is_cited)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS decay_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL, channel TEXT NOT NULL, title TEXT,
      peak_impressions INTEGER DEFAULT 0, peak_clicks INTEGER DEFAULT 0,
      current_impressions INTEGER DEFAULT 0, current_clicks INTEGER DEFAULT 0,
      decay_score FLOAT DEFAULT 0, status TEXT DEFAULT 'active', recommended_action TEXT,
      detected_at TIMESTAMPTZ DEFAULT NOW(), resolved_at TIMESTAMPTZ, UNIQUE(content_id, channel)
    )`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_decay_brand ON decay_alerts(brand_profile_id, status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS brain_mistakes_brand_idx ON brain_mistakes(brand_profile_id)`);
    console.log('NeonDB: Brain tables ensured');

    await pool.query(`CREATE TABLE IF NOT EXISTS publishing_channels (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, brand_profile_id TEXT NOT NULL,
      channel VARCHAR(50) NOT NULL, credentials JSONB NOT NULL DEFAULT '{}',
      utm_template JSONB NOT NULL DEFAULT '{}', is_active BOOLEAN DEFAULT true,
      last_tested_at TIMESTAMPTZ, test_status VARCHAR(20) DEFAULT 'untested',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(brand_profile_id, channel)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS publishing_queue (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL UNIQUE, title TEXT, channels JSONB NOT NULL DEFAULT '[]',
      status VARCHAR(30) DEFAULT 'staged', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      publish_results JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS publishing_queue_content_id_uidx ON publishing_queue(content_id)`).catch(() => {});

    try {
      const bpRows = await pool.query(`SELECT id FROM brand_profiles WHERE is_active = true`);
      for (const bp of bpRows.rows) {
        const safeId = bp.id.replace(/-/g, '_');
        const tableName = `generated_content_${safeId}`;
        const tableExists = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [tableName]);
        if (!tableExists.rows.length) continue;
        const approved = await pool.query(`SELECT id, title FROM ${tableName} WHERE compliance_status = 'approved'`).catch(() => ({ rows: [] }));
        for (const art of approved.rows) {
          await pool.query(`INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at) VALUES ($1, $2, $3, 'staged', NOW(), NOW()) ON CONFLICT (content_id) DO NOTHING`, [bp.id, art.id, art.title || 'Untitled']).catch(() => {});
        }
        if (approved.rows.length > 0) console.log(`[BACKFILL] Staged ${approved.rows.length} approved article(s) for brand ${bp.id}`);
      }
    } catch(e) { console.log('[BACKFILL] Note:', e.message); }

    try {
      const gcTables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'generated_content_%'`);
      for (const row of gcTables.rows) {
        await pool.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS hero_image_url TEXT`).catch(() => {});
        await pool.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS hero_image_prompt TEXT`).catch(() => {});
      }
      if (gcTables.rows.length > 0) console.log(`[MIGRATION] hero_image columns ensured on ${gcTables.rows.length} generated_content table(s)`);
    } catch(e) { console.log('[MIGRATION] hero_image cols note:', e.message); }

    await pool.query(`CREATE TABLE IF NOT EXISTS publish_log (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, queue_item_id TEXT NOT NULL,
      brand_profile_id TEXT NOT NULL, content_id TEXT NOT NULL, channel VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL, response_data JSONB, utm_params JSONB, published_url TEXT,
      error_message TEXT, attempted_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    console.log('NeonDB: Publishing tables ensured');

    await pool.query(`CREATE TABLE IF NOT EXISTS reviewers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_profile_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, title TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS hero_image_url TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_token TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS reviewer_id TEXT`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS topic_ideas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_profile_id UUID NOT NULL, topic TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'idea', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_status TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_comment TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_actioned_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS reading_time INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_unique ON content_analytics(brand_profile_id, content_id, channel)`).catch(() => {});
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS positive_feedback INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS negative_feedback INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS live_status VARCHAR(20) DEFAULT 'published'`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS synced_count INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});

    await pool.query(`CREATE TABLE IF NOT EXISTS content_analytics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL, channel TEXT NOT NULL, post_id TEXT,
      impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, reactions INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0, reposts INTEGER DEFAULT 0, ctr FLOAT DEFAULT 0,
      engagement_rate FLOAT DEFAULT 0, raw_data JSONB DEFAULT '{}',
      published_at TIMESTAMPTZ, synced_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(content_id, channel)
    )`);
    console.log('NeonDB: content_analytics table ensured');
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS campaign_id UUID`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS campaign_id UUID`).catch(() => {});
  } catch(e) { console.log('NeonDB: Brain tables note:', e.message); }

  const rlsTables = [
    'publishing_queue', 'publishing_channels', 'content_analytics',
    'brain_patterns', 'brain_mistakes', 'geo_briefs', 'geo_citations',
    'decay_alerts', 'precog_outcomes', 'topic_ideas', 'reviewers', 'memories',
  ];
  for (const tbl of rlsTables) {
    try {
      await pool.query(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
      await pool.query(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`);
      await pool.query(`DROP POLICY IF EXISTS no_orphan_brands ON ${tbl}`);
      await pool.query(`CREATE POLICY no_orphan_brands ON ${tbl} USING (brand_profile_id IN (SELECT id FROM brand_profiles WHERE clerk_user_id IS NOT NULL))`);
    } catch(e) {}
  }
  try {
    await pool.query(`ALTER TABLE publish_log ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE publish_log FORCE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY IF EXISTS no_orphan_brands ON publish_log`);
    await pool.query(`CREATE POLICY no_orphan_brands ON publish_log USING (queue_item_id IN (SELECT id FROM publishing_queue WHERE brand_profile_id IN (SELECT id FROM brand_profiles WHERE clerk_user_id IS NOT NULL)))`);
  } catch(e) { console.log('[RLS] publish_log:', e.message); }
  console.log('[SECURITY] RLS policies applied');

  try {
    const [op, om] = await Promise.all([
      pool.query(`DELETE FROM brain_patterns WHERE brand_profile_id NOT IN (SELECT id FROM brand_profiles WHERE clerk_user_id IS NOT NULL)`),
      pool.query(`DELETE FROM brain_mistakes WHERE brand_profile_id NOT IN (SELECT id FROM brand_profiles WHERE clerk_user_id IS NOT NULL)`),
    ]);
    if (op.rowCount || om.rowCount) console.log(`[SECURITY] Purged orphans: ${op.rowCount} patterns, ${om.rowCount} mistakes`);
  } catch(e) { console.log('[SECURITY] Orphan purge:', e.message); }


initDB().catch(err => console.error('DB init error:', err));

app.use(express.json({ limit: '500kb' }));

// ── Shared: Build brand-voice-aware Flux image prompt ────────────────────────
async function buildImagePrompt(title, voiceProfile = {}, firstBody = '') {
  const brandName = voiceProfile.brand_name || '';
  const toneAttrStr = Array.isArray(voiceProfile.toneAttributes) ? voiceProfile.toneAttributes.map(a => a.attribute).join(', ') : '';
  const toneSummary = voiceProfile.tone_summary || voiceProfile.summary || voiceProfile.writingStyle || toneAttrStr || '';
  const industry = voiceProfile.industry || voiceProfile.target_industry || voiceProfile.marketCategory || '';
  const positioning = voiceProfile.positioning || voiceProfile.brand_positioning || '';
  const targetPersona = voiceProfile.targetPersona || voiceProfile.target_persona || voiceProfile.primary_persona || '';
  const visualStyle = voiceProfile.visualStyle || voiceProfile.visual_style || voiceProfile.brand_aesthetic || '';
  const accentColor = voiceProfile.accentColor || voiceProfile.accent_color || voiceProfile.brand_color || '';

  const brandContext = [
    brandName && `Brand: ${brandName}`,
    industry && `Industry: ${industry}`,
    toneSummary && `Tone: ${toneSummary}`,
    positioning && `Positioning: ${positioning}`,
    targetPersona && `Audience: ${targetPersona}`,
    visualStyle && `Visual style: ${visualStyle}`,
    accentColor && `Brand accent color: ${accentColor}`,
  ].filter(Boolean).join('\n');

  const bodySnippet = (firstBody || '').slice(0, 250);
  const hasBrandVisual = !!(visualStyle || accentColor);

  const imagePromptInstruction = hasBrandVisual
    ? `Write a single-sentence Flux image generation prompt for a B2B article hero image that authentically reflects this brand's visual identity and the article topic.\n\nArticle title: "${title}"\n${brandContext ? brandContext + '\n' : ''}${bodySnippet ? 'Article context: ' + bodySnippet : ''}\n\nRules:\n- Let the brand's visual style and color palette drive the aesthetic — do not impose a generic look\n- Photorealistic editorial or commercial photography appropriate to this brand's industry and tone\n- NO floating UI elements, holographic screens, neon data walls, or sci-fi aesthetics\n- NO stock-photo clichés (handshakes, lightbulbs, generic offices, people pointing at whiteboards)\n- 1 sentence only, no explanation, no quotes\n\nOutput only the prompt.`
    : `Write a single-sentence Flux image generation prompt for a B2B article hero image.\n\nArticle title: "${title}"\n${bodySnippet ? 'Article context: ' + bodySnippet : ''}\n\nRules:\n- Photorealistic editorial photography — clean, high-contrast, professional\n- Abstract macro, architectural detail, natural textures, or environmental storytelling\n- Neutral palette with strong composition\n- NO floating UI elements, holographic screens, neon data walls, or sci-fi aesthetics\n- NO stock-photo clichés (handshakes, lightbulbs, generic offices, people pointing at whiteboards)\n- 1 sentence only, no explanation, no quotes\n\nOutput only the prompt.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: imagePromptInstruction }]
  });

  return res.content[0]?.type === 'text'
    ? res.content[0].text.trim()
    : `Professional B2B editorial photography for article about ${title}, dark cinematic lighting`;
}

// ── Extracts the first complete JSON object or array from a string ────────────
// Handles trailing text, markdown fences, and token-truncated responses
function extractJSON(text, type = 'object') {
  // Strip markdown code fences Claude sometimes wraps JSON in
  text = text.replace(/^