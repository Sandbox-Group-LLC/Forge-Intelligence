import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID, randomBytes, createHmac, createHash } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── Live Log Ring Buffer ──────────────────────────────────────────────────────
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
const logSSEClients = new Set();
const errorAggregates = [];

function captureLog(level, args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: msg.slice(0, 2000),
    isError: level === 'error' || /\b(error|fail|crash|ECONNREFUSED|FATAL|uncaught|unhandled)\b/i.test(msg),
    isWarn: level === 'warn' || /\b(warn|deprecat|timeout|retry)\b/i.test(msg),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();

  // Aggregate errors
  if (entry.isError) {
    const errorKey = msg.slice(0, 120).replace(/[0-9a-f-]{36}/gi, '{id}').replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, '{ts}');
    const existing = errorAggregates.find(e => e.key === errorKey);
    if (existing) { existing.count++; existing.lastSeen = entry.ts; existing.lastMsg = msg.slice(0, 300); }
    else { errorAggregates.push({ key: errorKey, count: 1, firstSeen: entry.ts, lastSeen: entry.ts, lastMsg: msg.slice(0, 300), level }); }
    if (errorAggregates.length > 100) errorAggregates.shift();
  }

  // Push to SSE clients
  for (const client of logSSEClients) {
    try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { logSSEClients.delete(client); }
  }
}

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.log = (...args) => { origLog(...args); captureLog('log', args); };
console.error = (...args) => { origError(...args); captureLog('error', args); };
console.warn = (...args) => { origWarn(...args); captureLog('warn', args); };


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
// Super Admin user IDs (Clerk) — full access to all brands
const SUPER_ADMIN_IDS = [
  'user_3BtC7nusm7CShN7EdUYaaLZcDwp', // brian@sandbox-xm.com
  'user_3CJmE0WkOj1RJC5yF99scEuwUpO', // brian — therosethyme
];


const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 1200000 }); // 20min

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
      { name: 'brand_url',        def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'brand_name',       def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'version',          def: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'is_active',        def: 'BOOLEAN NOT NULL DEFAULT true' },
      { name: 'cache_status',     def: "TEXT NOT NULL DEFAULT 'fresh'" },
      { name: 'profile_data',     def: "JSONB NOT NULL DEFAULT '{}'::jsonb" },
      { name: 'article_base_url',    def: "TEXT DEFAULT ''" },
      { name: 'article_url_suffix', def: "TEXT DEFAULT ''" },
      { name: 'logo_url',           def: "TEXT DEFAULT ''" },
      { name: 'settings',         def: "JSONB NOT NULL DEFAULT '{}'" },
      { name: 'created_at',       def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
      { name: 'updated_at',       def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
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

  // ── enriched_briefs table ─────────────────────────────────────────────────
  // Migration: force ON DELETE CASCADE on geo_brief_id FK so GEO re-runs don't throw FK violations.
  // Older environments may have the constraint without CASCADE — this is idempotent and safe.
  try {
    await pool.query(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'enriched_briefs_geo_brief_id_fkey'
            AND pg_get_constraintdef(oid) NOT LIKE '%ON DELETE CASCADE%'
        ) THEN
          ALTER TABLE enriched_briefs DROP CONSTRAINT enriched_briefs_geo_brief_id_fkey;
          ALTER TABLE enriched_briefs ADD CONSTRAINT enriched_briefs_geo_brief_id_fkey
            FOREIGN KEY (geo_brief_id) REFERENCES geo_briefs(id) ON DELETE CASCADE;
        END IF;
      END $$;`).catch(() => {});
  } catch(e) { /* ignore — table may not exist yet on fresh DB */ }

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS enriched_briefs (
      id TEXT PRIMARY KEY,
      brand_profile_id TEXT NOT NULL DEFAULT '',
      geo_brief_id TEXT,
      brand_url TEXT NOT NULL DEFAULT '',
      brand_name TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      confidence_score INTEGER DEFAULT 0,
      enriched_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Migration: ensure all columns exist on pre-existing table
    const enrichCols = [
      { name: 'brand_profile_id', def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'geo_brief_id',     def: 'TEXT' },
      { name: 'brand_url',        def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'article_base_url',    def: "TEXT DEFAULT ''" },
      { name: 'article_url_suffix', def: "TEXT DEFAULT ''" },
      { name: 'logo_url',           def: "TEXT DEFAULT ''" },
      { name: 'settings',         def: "JSONB NOT NULL DEFAULT '{}'" },
      { name: 'brand_name',       def: "TEXT NOT NULL DEFAULT ''" },
      { name: 'version',          def: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'confidence_score', def: 'INTEGER DEFAULT 0' },
      { name: 'enriched_data',    def: "JSONB NOT NULL DEFAULT '{}'::jsonb" },
      { name: 'created_at',       def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
      { name: 'updated_at',       def: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' },
    ];
    const enrichColRes = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'enriched_briefs'
    `);
    const existingEnrichCols = enrichColRes.rows.map(r => r.column_name);
    for (const col of enrichCols) {
      if (!existingEnrichCols.includes(col.name)) {
        await pool.query(`ALTER TABLE enriched_briefs ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
        console.log('NeonDB: enriched_briefs added column:', col.name);
      }
    }
    // Drop NOT NULL on client_id if it exists (legacy column)
    try {
      await pool.query(`ALTER TABLE enriched_briefs ALTER COLUMN client_id DROP NOT NULL`);
      await pool.query(`ALTER TABLE enriched_briefs ALTER COLUMN client_id SET DEFAULT NULL`);
      console.log('NeonDB: enriched_briefs client_id made nullable');
    } catch(e) { /* column may not exist — fine */ }
    console.log('NeonDB: enriched_briefs table ensured — cols:', existingEnrichCols.join(', '));
  } catch(e) {
    console.log('NeonDB: enriched_briefs init note:', e.message);
  }
}


  // ── Relax enriched_briefs.geo_brief_id FK — allow topic-brief-derived enrichments ──
  // Historically FK'd hard to geo_briefs. New architecture derives enrichment from
  // geo_topic_briefs, whose IDs won't exist in geo_briefs. Drop the hard FK and use
  // SET NULL on delete instead — cleaner for both old and new paths.
  try {
    await pool.query(`ALTER TABLE enriched_briefs DROP CONSTRAINT IF EXISTS enriched_briefs_geo_brief_id_fkey`);
    // Only recreate as soft FK if the column still exists — belt and suspenders
    const colCheck = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='enriched_briefs' AND column_name='geo_brief_id'`);
    if (colCheck.rows.length) {
      // leave it unconstrained — topic-brief IDs and legacy geo-brief IDs both land here
      console.log('[MIGRATION] enriched_briefs.geo_brief_id FK relaxed (no constraint, soft reference)');
    }
  } catch(e) { console.log('[MIGRATION] enriched_briefs FK relax:', e.message); }

  // ── geo_opportunities table ───────────────────────────────────────────────
  // Topics surfaced by GEO Strategist but not yet briefed. User cherry-picks from here.
  // Unpicked rows preserved as brain food — "user did NOT pick this" is a signal.
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS geo_opportunities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      brain_version INTEGER NOT NULL DEFAULT 1,
      topic TEXT NOT NULL,
      platform_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
      avg_score NUMERIC(5,2) DEFAULT 0,
      quick_win BOOLEAN DEFAULT false,
      topical_authority_context TEXT DEFAULT '',
      intent_signals JSONB DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'discovered',
      discovery_session_id UUID,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_geo_opp_brand ON geo_opportunities(brand_profile_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_geo_opp_session ON geo_opportunities(discovery_session_id)`);
  } catch(e) { console.log('[MIGRATION] geo_opportunities:', e.message); }

  // ── geo_topic_briefs table ────────────────────────────────────────────────
  // One brief per user-selected topic. Built via Stage 2.1 Brief Builder.
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS geo_topic_briefs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      opportunity_id UUID NOT NULL REFERENCES geo_opportunities(id) ON DELETE CASCADE,
      brand_profile_id TEXT NOT NULL,
      brief_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      brain_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'briefed',
      superseded_by UUID REFERENCES geo_topic_briefs(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_topic_brief_brand ON geo_topic_briefs(brand_profile_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_topic_brief_opp ON geo_topic_briefs(opportunity_id)`);
  } catch(e) { console.log('[MIGRATION] geo_topic_briefs:', e.message); }

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
    // Per-brand brain tables (brand_profile_id scoped — used by campaign generator and agents)
    await pool.query(`CREATE TABLE IF NOT EXISTS brain_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      pattern_type VARCHAR(100),
      description TEXT,
      confidence_score FLOAT DEFAULT 0,
      success_rate FLOAT DEFAULT 0,
      tags JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS brain_mistakes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      mistake_type VARCHAR(100),
      description TEXT,
      human_feedback TEXT,
      guardrail_created TEXT,
      severity VARCHAR(20) DEFAULT 'low',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS brain_patterns_brand_idx ON brain_patterns(brand_profile_id)`);
    // GEO Citations table
    await pool.query(`CREATE TABLE IF NOT EXISTS geo_citations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      query TEXT NOT NULL,
      is_cited BOOLEAN DEFAULT false,
      cited_url TEXT,
      cited_section TEXT,
      response_snippet TEXT,
      raw_citations JSONB DEFAULT '[]',
      checked_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(brand_profile_id, content_id, engine, query)
    )`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_geo_citations_brand ON geo_citations(brand_profile_id, is_cited)`).catch(() => {});

    // Decay monitoring table
    await pool.query(`CREATE TABLE IF NOT EXISTS decay_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      title TEXT,
      peak_impressions INTEGER DEFAULT 0,
      peak_clicks INTEGER DEFAULT 0,
      current_impressions INTEGER DEFAULT 0,
      current_clicks INTEGER DEFAULT 0,
      decay_score FLOAT DEFAULT 0,
      status TEXT DEFAULT 'active',
      recommended_action TEXT,
      detected_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      UNIQUE(content_id, channel)
    )`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_decay_brand ON decay_alerts(brand_profile_id, status)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS brain_mistakes_brand_idx ON brain_mistakes(brand_profile_id)`);
    console.log('NeonDB: Brain tables (patterns, mistakes, memories) ensured');

    // Publishing tables
    await pool.query(`CREATE TABLE IF NOT EXISTS publishing_channels (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      brand_profile_id TEXT NOT NULL,
      channel VARCHAR(50) NOT NULL,
      credentials JSONB NOT NULL DEFAULT '{}',
      utm_template JSONB NOT NULL DEFAULT '{}',
      is_active BOOLEAN DEFAULT true,
      last_tested_at TIMESTAMPTZ,
      test_status VARCHAR(20) DEFAULT 'untested',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(brand_profile_id, channel)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS publishing_queue (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL UNIQUE,
      title TEXT,
      channels JSONB NOT NULL DEFAULT '[]',
      status VARCHAR(30) DEFAULT 'staged',
      scheduled_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      publish_results JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Ensure unique constraint exists on pre-existing tables (migration guard)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS publishing_queue_content_id_uidx ON publishing_queue(content_id)`).catch(() => {});
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bp_active_url ON brand_profiles (brand_url) WHERE is_active = true`).catch(() => {});
    await pool.query(`ALTER TABLE brand_profiles ADD CONSTRAINT brand_profiles_pkey PRIMARY KEY (id)`).catch(() => {});

    // Backfill: stage any approved articles that aren't in the queue yet
    try {
      const bpRows = await pool.query(`SELECT id FROM brand_profiles WHERE is_active = true`);
      for (const bp of bpRows.rows) {
        const safeId = bp.id.replace(/-/g, '_');
        const tableName = `generated_content_${safeId}`;
        const tableExists = await pool.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [tableName]
        );
        if (!tableExists.rows.length) continue;
        const approved = await pool.query(
          `SELECT id, title FROM ${tableName} WHERE compliance_status = 'approved'`
        ).catch(() => ({ rows: [] }));
        for (const art of approved.rows) {
          await pool.query(
            `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
             VALUES ($1, $2, $3, 'staged', NOW(), NOW())
             ON CONFLICT (content_id) DO NOTHING`,
            [bp.id, art.id, art.title || 'Untitled']
          ).catch(() => {});
        }
        if (approved.rows.length > 0) console.log(`[BACKFILL] Staged ${approved.rows.length} approved article(s) for brand ${bp.id}`);
      }
    } catch(e) { console.log('[BACKFILL] Note:', e.message); }

  // Migration: ensure hero_image_url + hero_image_prompt exist on all generated_content_* tables
  try {
    const gcTables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'generated_content_%'
    `);
    for (const row of gcTables.rows) {
      await pool.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS hero_image_url TEXT`).catch(() => {});
      await pool.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS hero_image_prompt TEXT`).catch(() => {});
    }
    if (gcTables.rows.length > 0) console.log(`[MIGRATION] hero_image columns ensured on ${gcTables.rows.length} generated_content table(s)`);
  } catch(e) { console.log('[MIGRATION] hero_image cols note:', e.message); }




















    await pool.query(`CREATE TABLE IF NOT EXISTS publish_log (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      queue_item_id TEXT NOT NULL,
      brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      channel VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL,
      response_data JSONB,
      utm_params JSONB,
      published_url TEXT,
      error_message TEXT,
      attempted_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    console.log('NeonDB: Publishing tables ensured');


    // ── precog_outcomes table ──────────────────────────────────────────────────
    await pool.query(`CREATE TABLE IF NOT EXISTS precog_outcomes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      predicted_signal TEXT,
      predicted_impressions_low INTEGER,
      predicted_impressions_high INTEGER,
      avg_impressions_at_prediction FLOAT,
      actual_impressions INTEGER,
      actual_clicks INTEGER,
      direction_correct BOOLEAN,
      in_range BOOLEAN,
      measured_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(brand_profile_id, content_id)
    )`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_precog_brand ON precog_outcomes(brand_profile_id)`).catch(() => {});

    // ── brain_patterns extended columns ────────────────────────────────────────
    await pool.query(`ALTER TABLE brain_patterns ADD COLUMN IF NOT EXISTS source_channel TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE brain_patterns ADD COLUMN IF NOT EXISTS example_titles JSONB DEFAULT '[]'`).catch(() => {});
    await pool.query(`ALTER TABLE brain_patterns ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE brain_patterns ADD COLUMN IF NOT EXISTS success_rate FLOAT DEFAULT 0`).catch(() => {});

    // ── precog columns on generated_content tables ─────────────────────────────
    try {
      const gcTables2 = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'generated_content_%'
      `);
      for (const row of gcTables2.rows) {
        await pool.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS precog_score INTEGER`).catch(() => {});
        await pool.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS precog_breakdown JSONB`).catch(() => {});
        await pool.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS precog_scored_at TIMESTAMPTZ`).catch(() => {});
      }
    } catch(e) { console.log('[MIGRATION] precog cols note:', e.message); }

    // Reviewers table
    await pool.query(`CREATE TABLE IF NOT EXISTS reviewers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      title TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS hero_image_url TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_token TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS reviewer_id TEXT`).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS topic_ideas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand_profile_id UUID NOT NULL,
        topic TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'idea',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_status TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_comment TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS review_actioned_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS reading_time INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_unique ON content_analytics(brand_profile_id, content_id, channel)`).catch(() => {});
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS positive_feedback INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS negative_feedback INTEGER DEFAULT 0`).catch(() => {});
    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to publish_log
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS live_status VARCHAR(20) DEFAULT 'published'`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS synced_count INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});

    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to publish_log
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS live_status VARCHAR(20) DEFAULT 'published'`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS synced_count INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});

    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to content_analytics
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Migration: add missing columns to publish_log
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS live_status VARCHAR(20) DEFAULT 'published'`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS synced_count INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});
    await pool.query(`ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
    // Backfill published_at from attempted_at where null
    await pool.query(`UPDATE publish_log SET published_at = attempted_at WHERE published_at IS NULL`).catch(() => {});

    // ── Analytics table
    await pool.query(`CREATE TABLE IF NOT EXISTS content_analytics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      post_id TEXT,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      reactions INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      reposts INTEGER DEFAULT 0,
      ctr FLOAT DEFAULT 0,
      engagement_rate FLOAT DEFAULT 0,
      raw_data JSONB DEFAULT '{}',
      published_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(content_id, channel)
    )`);
    console.log('NeonDB: content_analytics table ensured');
    // Campaign analytics migrations
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS campaign_id UUID`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS campaign_id UUID`).catch(() => {});
  } catch(e) { console.log('NeonDB: Brain tables note:', e.message); }


  // ── RLS REMOVED (April 14, 2026) ──────────────────────────────────────────
  // Rogue agent's fake RLS stripped. Real isolation: verifyBrandAccess() + WHERE brand_profile_id = $1


initDB().catch(err => console.error('DB init error:', err));

app.use(express.json());

// ── Hero image generation — Ideogram v2 via fal.ai ───────────────────────────
// Swapped from Flux Schnell (4-step distilled, plastic skin, "Kim K" vibe on humans)
// to Ideogram v2 (realistic style, built-in MagicPrompt expansion, reliable faces/hands).
// Cost: ~$0.08/image vs $0.003 prior. Quality difference is enormous for B2B marketing imagery.
const HERO_IMAGE_NEGATIVE_PROMPT = "airbrushed skin, smooth skin, plastic skin, waxy skin, overproduced, HDR, oversaturated, hyperreal, AI art, digital painting, 3D render, cartoon, illustration, distorted hands, extra fingers, malformed fingers, mutated anatomy, stock photo, generic corporate stock image, blurry faces in background blobbing together, text artifacts";

async function generateHeroImage(prompt) {
  const falRes = await fetch('https://fal.run/fal-ai/ideogram/v2', {
    method: 'POST',
    headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspect_ratio: '16:9',
      style: 'realistic',
      expand_prompt: true,            // Ideogram's MagicPrompt — expands our terse prompt into a richer one before generation
      negative_prompt: HERO_IMAGE_NEGATIVE_PROMPT,
      num_images: 1
    })
  });
  if (!falRes.ok) throw new Error(`fal.ai ${falRes.status}: ${await falRes.text()}`);
  const falData = await falRes.json();
  const imageUrl = falData?.images?.[0]?.url;
  if (!imageUrl) throw new Error('No image URL returned from fal.ai');
  return imageUrl;
}


// ── Shared: Build brand-voice-aware image prompt ─────────────────────────────
async function buildImagePrompt(title, voiceProfile = {}, firstBody = '') {
  const brandName = voiceProfile.brand_name || '';
  // tone: handle both snake_case (legacy) and camelCase (Context Agent output)
  const toneAttrStr = Array.isArray(voiceProfile.toneAttributes)
    ? voiceProfile.toneAttributes.map(a => a.attribute).join(', ')
    : '';
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
    ? `Write a single-sentence image generation prompt for an article hero image that reflects this brand's visual identity and the article topic.

Article title: "${title}"
${brandContext ? brandContext + '\n' : ''}${bodySnippet ? 'Article context: ' + bodySnippet : ''}

Rules:
- One sentence. Describe the concrete scene — what's happening, who is in it (if anyone), where, what the mood is.
- Editorial/documentary photography feel: natural available light, real moment, candid — not posed. If humans are present, describe what they are doing, not how they look.
- Let the brand's visual style, tone, and color palette shape the aesthetic.
- Avoid words that signal AI-generated stock imagery: "photorealistic", "professional", "polished", "corporate", "stock", "perfect", "high-quality". Use concrete sensory details instead.
- No illustrations, 3D renders, cartoons, or surrealism.
- NEVER interpret the brand name literally (e.g. 'Forge' is software, not a blacksmith).
- Output only the prompt. No quotes, no preamble, no explanation.`
    : `Write a single-sentence image generation prompt for an article hero image.

Article title: "${title}"
${bodySnippet ? 'Article context: ' + bodySnippet : ''}

Rules:
- One sentence. Describe the concrete scene — what's happening, who is in it (if anyone), where, what the mood is.
- Editorial/documentary photography feel: natural available light, real moment, candid — not posed. If humans are present, describe what they are doing, not how they look.
- Avoid words that signal AI-generated stock imagery: "photorealistic", "professional", "polished", "corporate", "stock", "perfect", "high-quality". Use concrete sensory details instead.
- No illustrations, 3D renders, cartoons, or surrealism.
- Output only the prompt. No quotes, no preamble, no explanation.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: imagePromptInstruction }]
  });

  return res.content[0]?.type === 'text'
    ? res.content[0].text.trim()
    : `A candid documentary moment capturing the world of ${title}, natural available light, shallow depth of field`;
}


// ── Public Article Viewer ─────────────────────────────────────────────────────
app.get('/api/articles/:brandSlug/:articleSlug', async (req, res) => {
  try {
    const { brandSlug, articleSlug } = req.params;
    // Find brand by matching slug of brand_url or brand_name
    const brandsRes = await pool.query('SELECT id, brand_url, brand_name, profile_data FROM brand_profiles');
    let matchedBrand = null;
    // Exact match first, then prefix match — avoids false positives like sandbox-xm vs sandbox-gtm
    for (const b of brandsRes.rows) {
      const slug = (b.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      if (slug === brandSlug) { matchedBrand = b; break; }
    }
    if (!matchedBrand) {
      for (const b of brandsRes.rows) {
        const slug = (b.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const nameSlug = (b.profile_data?.voice_profile?.brand_name || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const nameSlug2 = (b.brand_name || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        if (slug.startsWith(brandSlug) || brandSlug.startsWith(slug) ||
            nameSlug.startsWith(brandSlug) || nameSlug2.startsWith(brandSlug)) {
          matchedBrand = b; break;
        }
      }
    }
    if (!matchedBrand) return res.status(404).json({ error: 'Brand not found' });

    const safeId = matchedBrand.id.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;
    const articlesRes = await pool.query(`SELECT * FROM ${tableName} ORDER BY created_at DESC`);

    // Find article by matching title slug
    let matchedArticle = null;
    for (const a of articlesRes.rows) {
      const tSlug = (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
      if (tSlug === articleSlug || tSlug.startsWith(articleSlug) || articleSlug.startsWith(tSlug.slice(0, 30))) {
        matchedArticle = a;
        break;
      }
    }
    if (!matchedArticle) return res.status(404).json({ error: 'Article not found' });

    const articleJson = matchedArticle.article_json || {};
    res.json({
      title: matchedArticle.title,
      sections: articleJson.sections || [],
      category: articleJson.category || articleJson.targetPersona || null,
      overallConfidence: matchedArticle.overall_confidence,
      heroImageUrl: matchedArticle.hero_image_url || null,
      metaDescription: articleJson.metaDescription || null,
      brandName: matchedBrand?.brand_name || matchedBrand?.profile_data?.voice_profile?.brand_name || brandSlug,
      createdAt: matchedArticle.created_at,
    });
  } catch (err) {
    console.error('[PUBLIC-ARTICLE]', err.message);
    res.status(500).json({ error: 'Failed to load article' });
  }
});


// ── Sync publish status ───────────────────────────────────────────────────────
// Checks live channel APIs and updates publish_log.live_status
app.get('/api/publishing/sync/:queueItemId', requireAuth, async (req, res) => {
  const { queueItemId } = req.params;
  try {
    // Only process the most recent log entry per channel — older entries are historical
    const logRes = await pool.query(
      `SELECT DISTINCT ON (pl.channel) pl.*, pc.credentials
       FROM publish_log pl
       LEFT JOIN publishing_channels pc ON pc.brand_profile_id = pl.brand_profile_id AND pc.channel = pl.channel
       WHERE pl.queue_item_id = $1
       ORDER BY pl.channel, pl.attempted_at DESC`,
      [queueItemId]
    );
    if (!logRes.rows.length) return res.json({ success: true, results: {} });

    const results = {};
    for (const row of logRes.rows) {
      let liveStatus = row.live_status || 'published';
      const creds = row.credentials || {};

      // If we already know it's deleted (set by unpublish endpoint), don't re-check
      if (liveStatus === 'deleted') {
        await pool.query(
          'UPDATE publish_log SET last_synced_at = NOW(), synced_count = synced_count + 1 WHERE id = $1',
          [row.id]
        );
        results[row.channel] = { channel: row.channel, liveStatus: 'deleted' };
        continue;
      }

      try {
        if (row.channel === 'linkedin') {
          const postId = row.response_data?.postId;
          const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
          if (postId && token) {
            const encodedId = encodeURIComponent(postId);
            const liRes = await fetch(`https://api.linkedin.com/v2/ugcPosts/${encodedId}`, {
              headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' }
            });
            if (liRes.status === 404) liveStatus = 'deleted';
            else if (liRes.status === 403) liveStatus = 'unknown'; // token expired
            else if (liRes.ok) liveStatus = 'published';
          }
        } else if (row.channel === 'wordpress') {
          const postId = row.response_data?.postId;
          const wpUrl = creds.siteUrl?.replace(/\/+$/, '');
          const authHeader = 'Basic ' + Buffer.from(`${creds.username}:${creds.appPassword}`).toString('base64');
          if (postId && wpUrl) {
            const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${postId}`, {
              headers: { 'Authorization': authHeader }
            });
            if (wpRes.status === 404) liveStatus = 'deleted';
            else if (wpRes.ok) {
              const wpData = await wpRes.json();
              liveStatus = wpData.status === 'publish' ? 'published' : wpData.status || 'unknown';
            }
          }
        } else if (row.channel === 'x') {
          // Check X tweet status via v2 API — OAuth 2.0 preferred, 1.0a fallback
          const tweetId = row.response_data?.tweetId || row.response_data?.id;
          let xAuth = '';
          if (creds.oauth2AccessToken) {
            xAuth = `Bearer ${creds.oauth2AccessToken}`;
          } else {
            const xApiKey    = creds.apiKey    || process.env.X_OAUTH1CONSUMER_KEY;
            const xApiSecret = creds.apiSecret || process.env.X_OAUTH1CONSUMER_SECRET;
            const xAccessToken  = creds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
            const xAccessSecret = creds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
            if (xApiKey && xAccessToken) {
              const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;
              xAuth = buildXOAuthHeader('GET', endpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret);
            }
          }

          if (tweetId && xAuth) {
            const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;

            const xRes = await fetch(endpoint, { headers: { 'Authorization': xAuth } });
            if (xRes.status === 404) {
              liveStatus = 'deleted';
            } else if (xRes.status === 401 || xRes.status === 403) {
              liveStatus = 'unknown';
            } else if (xRes.ok) {
              const xBody = await xRes.json();
              // X API v2 returns 200 with errors[] for deleted/not-found tweets
              const notFound = xBody.errors?.some(e =>
                e.type?.includes('resource-not-found') ||
                e.detail?.toLowerCase().includes('could not find tweet')
              );
              liveStatus = notFound ? 'deleted' : (xBody.data ? 'published' : 'deleted');
            }
          }
        } else if (row.channel === 'facebook') {
          // Facebook Graph API — check post still exists
          const { pageAccessToken } = creds;
          const postId = row.response_data?.postId;
          if (postId && pageAccessToken) {
            const fbCheck = await fetch(
              `https://graph.facebook.com/v21.0/${postId}?fields=id&access_token=${pageAccessToken}`
            );
            if (fbCheck.status === 404) liveStatus = 'deleted';
            else if (fbCheck.ok) liveStatus = 'published';
          }
        } else if (row.channel === 'reddit') {
          // Reddit link posts — no lightweight status endpoint without heavy OAuth; preserve existing status
          liveStatus = row.live_status || 'published';
        } else if (row.channel === 'medium') {
          // Medium posts don't have a status API — once published they stay published
          liveStatus = row.live_status || 'published';
        } else if (row.channel === 'ghost') {
          // Check Ghost post still exists via Admin API
          const { adminUrl, adminApiKey } = creds;
          const postId = row.response_data?.postId;
          if (postId && adminUrl && adminApiKey) {
            try {
              const [keyId, keySecret] = adminApiKey.split(':');
              const now = Math.floor(Date.now() / 1000);
              const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
              const p = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
              const { createHmac } = await import('node:crypto');
              const sig = createHmac('sha256', Buffer.from(keySecret, 'hex')).update(`${h}.${p}`).digest('base64url');
              const jwt = `${h}.${p}.${sig}`;
              const chkRes = await fetch(`${adminUrl.replace(/\/+$/, '')}/ghost/api/admin/posts/${postId}/`, {
                headers: { 'Authorization': `Ghost ${jwt}`, 'Accept-Version': 'v5.0' }
              });
              if (chkRes.status === 404) liveStatus = 'deleted';
              else if (chkRes.ok) {
                const chkData = await chkRes.json();
                liveStatus = chkData.posts?.[0]?.status === 'published' ? 'published' : 'unpublished';
              }
            } catch { liveStatus = row.live_status || 'published'; }
          }
        }
      } catch (e) {
        console.warn(`[SYNC] ${row.channel} check failed:`, e.message);
        liveStatus = 'unknown';
      }

      await pool.query(
        'UPDATE publish_log SET live_status = $1, last_synced_at = NOW(), synced_count = synced_count + 1 WHERE id = $2',
        [liveStatus, row.id]
      );

      // If post was deleted, reset the queue item back to staged so it can be republished
      if (liveStatus === 'deleted') {
        await pool.query(
          `UPDATE publishing_queue SET status = 'staged', updated_at = NOW()
           WHERE id = $1 AND status = 'published'`,
          [queueItemId]
        ).catch(() => {});
      }

      results[row.channel] = { liveStatus, publishedUrl: row.published_url, lastSynced: new Date().toISOString() };
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('[SYNC]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Republish to a specific channel ──────────────────────────────────────────
app.post('/api/publishing/republish', requireAuth, async (req, res) => {
  const { queueItemId, channel } = req.body;
  if (!queueItemId || !channel) return res.status(400).json({ error: 'queueItemId and channel required' });
  try {
    // Re-use the main publish endpoint logic by delegating
    const fakeReq = { body: { queueItemId, channels: [channel] } };
    const fakeRes = {
      _data: null,
      _status: 200,
      status(s) { this._status = s; return this; },
      json(d) { this._data = d; }
    };
    // Find the publish handler and invoke it
    // Simpler: just call the DB directly and re-run the publish logic inline
    const queueRes = await pool.query('SELECT * FROM publishing_queue WHERE id = $1', [queueItemId]);
    if (!queueRes.rows.length) return res.status(404).json({ error: 'Queue item not found' });
    const item = queueRes.rows[0];

    // Mark any previous log entry for this channel as 'republishing'
    await pool.query(
      "UPDATE publish_log SET live_status = 'republishing' WHERE queue_item_id = $1 AND channel = $2",
      [queueItemId, channel]
    );

    // Forward to main publish route
    const publishRes = await fetch(`${process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}/api/publishing/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueItemId, channels: [channel] })
    });
    const publishData = await publishRes.json();

    if (publishData.success) {
      res.json({ success: true, result: publishData.results?.[channel] });
    } else {
      res.status(500).json({ error: publishData.error || 'Republish failed' });
    }
  } catch (err) {
    console.error('[REPUBLISH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get publish log for a queue item ─────────────────────────────────────────
app.get('/api/publishing/log/:queueItemId', requireAuth, async (req, res) => {
  try {
    const logRes = await pool.query(
      `SELECT DISTINCT ON (channel) id, channel, status, live_status, published_url, error_message, attempted_at, last_synced_at
       FROM publish_log WHERE queue_item_id = $1
       ORDER BY channel, attempted_at DESC`,
      [req.params.queueItemId]
    );
    res.json({ success: true, log: logRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── On-demand hero image regeneration ────────────────────────────────────────
app.post('/api/content/regenerate-image/:contentId', requireAuth, async (req, res) => {
  const { contentId } = req.params;
  const { brandProfileId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;
    const artRes = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!artRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = artRes.rows[0];

    const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const brand = brandRes.rows[0] || {};
    const profileData = brand.profile_data || {};
    const regenBody = (article.article_json?.sections?.[0]?.body || article.article_json?.sections?.[0]?.content || '').slice(0, 250);
    const fluxPrompt = await buildImagePrompt(article.title, profileData?.voice_profile || {}, regenBody);

    const imageUrl = await generateHeroImage(fluxPrompt);

    await pool.query(`UPDATE ${tableName} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
      [imageUrl, fluxPrompt, contentId]);

    res.json({ success: true, imageUrl, prompt: fluxPrompt });
  } catch (err) {
    console.error('[REGEN-IMAGE]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Auto-generate hero image if missing (called by article page on load) ──────
app.post('/api/articles/:brandSlug/:articleSlug/ensure-image', async (req, res) => {
  const { brandSlug, articleSlug } = req.params;
  try {
    const brandsRes = await pool.query('SELECT id, brand_url, brand_name, profile_data FROM brand_profiles');
    let matchedBrand = null;
    for (const b of brandsRes.rows) {
      const slug = (b.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const nameSlug = ((b.profile_data?.voice_profile?.brand_name) || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      if (slug.startsWith(brandSlug) || nameSlug.startsWith(brandSlug) || brandSlug.startsWith(slug.split('-')[0])) {
        matchedBrand = b; break;
      }
    }
    if (!matchedBrand) return res.status(404).json({ error: 'Brand not found' });

    const safeId = matchedBrand.id.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;
    const articlesRes = await pool.query(`SELECT * FROM ${tableName} ORDER BY created_at DESC`);
    let article = null;
    for (const a of articlesRes.rows) {
      const tSlug = (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      if (tSlug === articleSlug || articleSlug.startsWith(tSlug.slice(0, 40)) || tSlug.startsWith(articleSlug.slice(0, 40))) {
        article = a; break;
      }
    }
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // Already has image — just return it
    if (article.hero_image_url) return res.json({ imageUrl: article.hero_image_url, generated: false });

    // Generate image via fal.ai
    const aj = article.article_json || {};
    const sections = aj.sections || [];
    const firstBody = (sections[0]?.body || sections[0]?.content || '').slice(0, 300);
    const imgPromptRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: `Write a Flux image generation prompt for a B2B editorial hero image for this article: "${article.title}". Context: ${firstBody}. Output only the prompt, no quotes, no preamble. Professional photography style, 16:9, no text in image.` }]
    });
    const fluxPrompt = imgPromptRes.content[0]?.type === 'text' ? imgPromptRes.content[0].text.trim() : `Professional B2B editorial hero image for article about ${article.title}`;

    const imageUrl = await generateHeroImage(fluxPrompt);

    await pool.query(`UPDATE ${tableName} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
      [imageUrl, fluxPrompt, article.id]);

    res.json({ imageUrl, generated: true });
  } catch(e) {
    console.error('[ENSURE-IMAGE]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Article page — server-side OG meta injection (must be before express.static) ──
app.get('/articles/:brandSlug/:articleSlug', async (req, res) => {
  const { brandSlug, articleSlug } = req.params;
  try {
    const brandsRes = await pool.query('SELECT id, brand_url, brand_name, profile_data FROM brand_profiles');
    let matchedBrand = null;
    // Exact match first, then prefix — avoids false positives between similar brand slugs
    for (const b of brandsRes.rows) {
      const slug = (b.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      if (slug === brandSlug) { matchedBrand = b; break; }
    }
    if (!matchedBrand) {
      for (const b of brandsRes.rows) {
        const slug = (b.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const nameSlug = ((b.profile_data?.voice_profile?.brand_name) || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const nameSlug2 = (b.brand_name || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
        if (slug.startsWith(brandSlug) || brandSlug.startsWith(slug) ||
            nameSlug.startsWith(brandSlug) || nameSlug2.startsWith(brandSlug)) {
          matchedBrand = b; break;
        }
      }
    }

    if (!matchedBrand) return res.sendFile(path.join(__dirname, 'dist', 'index.html'));

    const safeId = matchedBrand.id.replace(/-/g, '_');
    const articlesRes = await pool.query(`SELECT * FROM generated_content_${safeId} ORDER BY created_at DESC`);
    let article = null;
    for (const a of articlesRes.rows) {
      const tSlug = (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      if (tSlug === articleSlug || articleSlug.startsWith(tSlug.slice(0, 40)) || tSlug.startsWith(articleSlug.slice(0, 40))) {
        article = a; break;
      }
    }

    if (!article) return res.sendFile(path.join(__dirname, 'dist', 'index.html'));

    const aj = article.article_json || {};
    const title = (article.title || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const description = (aj.metaDescription || (aj.sections?.[0]?.body || aj.sections?.[0]?.content || '').slice(0, 200)).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const imageUrl = article.hero_image_url || '';
    const artBaseDomain = process.env.BASE_DOMAIN || 'forgeintelligence.ai';
    const canonicalUrl = `https://${artBaseDomain}/articles/${brandSlug}/${articleSlug}`;
    const brandName = (matchedBrand.brand_name || matchedBrand.profile_data?.voice_profile?.brand_name || brandSlug).replace(/"/g, '&quot;');
    const authorName = (matchedBrand.profile_data?.voice_profile?.author_name || brandName).replace(/"/g, '&quot;');
    const wordCount = (aj.sections || []).reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
    const readMinutes = Math.max(1, Math.round(wordCount / 200));

    const html = await fs.promises.readFile(path.join(__dirname, 'dist', 'index.html'), 'utf8');
    // ── Build JSON-LD schema for Google ──
    // Pull Factual Ground author + DB brand_url for deterministic author block
    let ldJsonScript = '';
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg, brand_url FROM brand_profiles WHERE id = $1`,
        [matchedBrand.id]
      );
      const fg = fgRes.rows[0]?.fg;
      const realUrl = fgRes.rows[0]?.brand_url || `https://${artBaseDomain}`;
      const primary = (fg?.authors || []).find(a => a.name && a.name.trim()) || null;

      const authorBlock = primary ? {
        "@type": "Person",
        "name": primary.name.trim(),
        "jobTitle": primary.title || '',
        "url": realUrl,
        "sameAs": (primary.linkedinUrl && primary.linkedinUrl.trim()) ? [primary.linkedinUrl.trim()] : [],
        "knowsAbout": (primary.expertise || '').split(',').map(s => s.trim()).filter(Boolean),
        "description": primary.bio || '',
        ...(primary.credentials ? { "hasCredential": primary.credentials.split(/[,.]/).map(s => s.trim()).filter(Boolean) } : {})
      } : {
        "@type": "Organization",
        "name": brandName,
        "url": realUrl,
      };

      const ldJson = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": article.title,
        "description": description,
        ...(imageUrl ? { "image": imageUrl } : {}),
        "author": authorBlock,
        "publisher": {
          "@type": "Organization",
          "name": brandName,
          "url": realUrl,
          ...(matchedBrand.profile_data?.voice_profile?.logo_url ? { "logo": { "@type": "ImageObject", "url": matchedBrand.profile_data.voice_profile.logo_url } } : {})
        },
        "datePublished": article.created_at || new Date().toISOString(),
        "dateModified": article.updated_at || article.created_at || new Date().toISOString(),
        "mainEntityOfPage": { "@type": "WebPage", "@id": canonicalUrl },
        "wordCount": wordCount,
        "timeRequired": `PT${readMinutes}M`,
      };
      ldJsonScript = `\n  <script type="application/ld+json">${JSON.stringify(ldJson, null, 2)}</script>`;
    } catch(e) {
      console.error('[ARTICLE-SSR] JSON-LD build failed (non-fatal):', e.message);
    }

    const publishedTime = article.created_at ? new Date(article.created_at).toISOString() : new Date().toISOString();
    const modifiedTime = article.updated_at ? new Date(article.updated_at).toISOString() : publishedTime;
    const ogTags = `
  <title>${title} | ${brandName}</title>
  <meta name="description" content="${description}" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="${brandName}" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${canonicalUrl}" />
  ${imageUrl ? `<meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:secure_url" content="${imageUrl}" />
  <meta property="og:image:width" content="1280" />
  <meta property="og:image:height" content="720" />
  <meta property="og:image:type" content="image/jpeg" />` : ''}
  <meta property="article:author" content="${authorName}" />
  <meta property="article:published_time" content="${publishedTime}" />
  <meta property="article:modified_time" content="${modifiedTime}" />
  <meta name="author" content="${authorName}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  ${imageUrl ? `<meta name="twitter:image" content="${imageUrl}" />` : ''}`;

    // ── Build SSR body content for AI crawlers (ChatGPT, Perplexity, GPTBot, Googlebot) ──
    // React hydrates over this on client load. Wrapped in off-screen container so humans don't see it twice.
    const sectionsHtml = (aj.sections || []).map(s => {
      const heading = (s.heading || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const body = (s.body || s.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Preserve paragraph breaks
      const paragraphs = body.split(/\n\n+/).map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`).join('\n');
      return `<section><h2>${heading}</h2>${paragraphs}</section>`;
    }).join('\n');

    // Build an authorship footer with Factual Ground bio for bot consumption
    let authorFooter = '';
    try {
      const fgRes2 = await pool.query(
        `SELECT settings->'factualGround' as fg FROM brand_profiles WHERE id = $1`,
        [matchedBrand.id]
      );
      const fg = fgRes2.rows[0]?.fg;
      const primary = (fg?.authors || []).find(a => a.name && a.name.trim());
      if (primary) {
        const safeBio = (primary.bio || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        authorFooter = `<footer><h3>About the author</h3><p><strong>${primary.name.trim()}</strong>${primary.title ? ', ' + primary.title.replace(/</g, '&lt;') : ''}</p><p>${safeBio}</p></footer>`;
      }
    } catch(e) { /* silent — non-fatal */ }

    const heroImg = imageUrl ? `<img src="${imageUrl}" alt="${title}" />` : '';
    const h1Safe = (aj.h1 || article.title).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const metaLine = `<p><em>By ${authorName} · ${readMinutes} min read · ${wordCount} words</em></p>`;

    const ssrBody = `<article style="position:absolute;left:-99999px;top:-99999px" aria-hidden="true"><h1>${h1Safe}</h1>${metaLine}${heroImg}${sectionsHtml}${authorFooter}</article>`;

    const injected = html
      .replace(/<title>[^<]*<\/title>/, '')
      .replace('<head>', '<head>' + ogTags + ldJsonScript)
      .replace('<div id="root"></div>', `<div id="root">${ssrBody}</div>`);

    res.set('Cache-Control', 'no-cache');
    return res.send(injected);
  } catch(e) {
    console.error('[OG-META]', e.message);
    return res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  }
});

// ── Marketing pages SSR — inject real content so scrapers + crawlers see it ──
// Without this, SPA shell returns 1538 bytes of empty <div id="root"></div>
// Forge's own scraper AND Google both need real HTML to extract product info.
const MARKETING_META = {
  '/': {
    title: 'Forge Intelligence — Brand Intelligence That Compounds',
    description: 'Forge extracts competitive intelligence from brand websites using an 8-stage AI pipeline. Find undefended market positions, audience blind spots, and messaging fault lines your competitors haven\'t claimed. Intelligence compounds. The content proves it.',
    bodyContent: `
      <h1>Brand Intelligence That Compounds</h1>
      <p>Forge Intelligence extracts competitive intelligence from brand websites using an 8-stage AI pipeline. Every stage conditions the next. By the time content is generated, it's not writing from a prompt — it's writing from a fully constructed competitive worldview unique to your brand.</p>
      <h2>What Forge Does</h2>
      <p>Forge surfaces what the best brand strategists charge $50,000 and six weeks to find: competitive gaps, undefended market positions, audience blind spots, messaging fault lines. Then it turns that intelligence into content, closes the loop with performance data, and writes what it learns back into your brand brain automatically.</p>
      <h2>What Forge Is Not</h2>
      <p>Forge is not a content marketing agency. Forge does not automate marketing workflows. Forge is the intelligence layer your marketing operation never had.</p>
      <h2>The 8-Stage Context Agent Architecture</h2>
      <p>Context Hub scrapes your brand and maps the competitive landscape. GEO Strategist finds topical territory your competitors haven't claimed. Authenticity Enricher injects E-E-A-T signals that make content rank and resonate. Content Generator writes from a fully constructed brand worldview. Compliance Gate critiques before anything goes live. Publishing Queue schedules and distributes with UTM tracking. Performance Dashboard pulls real engagement data back into the system. Brain Memory writes every pattern back automatically.</p>
      <h2>Who Forge Is For</h2>
      <p>Mid-market B2B companies building content operations that can compete with teams ten times their size. Bootstrapped. Portland, Oregon. Founded 2025 by Brian Morgan after a decade running Sandbox Group.</p>
    `
  },
  '/product': {
    title: 'The Forge Product — Context Agent Architecture',
    description: 'Eight specialized AI agents. One compounding intelligence system. Context Hub, GEO Strategist, Authenticity Enricher, Content Generator, Compliance Gate, Publishing Queue, Performance Dashboard, Brain Memory.',
    bodyContent: `
      <h1>The Forge Product</h1>
      <p>Eight specialized agents. One compounding system. Each stage doesn't just execute — it conditions the next.</p>
      <h2>Context Hub</h2>
      <p>Scrapes your brand and maps the competitive landscape. Identifies competitive gaps, personas, voice attributes, and whitespace your competitors haven't claimed.</p>
      <h2>GEO Strategist</h2>
      <p>Finds the topical territory your competitors haven't claimed. Builds a topical authority map and GEO opportunity set specific to your positioning.</p>
      <h2>Authenticity Enricher</h2>
      <p>Injects E-E-A-T signals — expertise, experience, authoritativeness, trustworthiness — that make content both rank and resonate.</p>
      <h2>Content Generator</h2>
      <p>Writes from a fully constructed brand worldview, not a prompt. Uses Factual Ground — founder-provided facts and credentials — as verbatim source material.</p>
      <h2>Compliance Gate</h2>
      <p>Critiques every article before publishing. Flags factual confidence issues, voice drift, and brand violations section-by-section.</p>
      <h2>Publishing Queue</h2>
      <p>Schedules and distributes across LinkedIn, X, HubSpot, Facebook, and your own site with UTM tracking baked in.</p>
      <h2>Performance Dashboard</h2>
      <p>Pulls real engagement data back into the system — tracks what landed, what decayed, what drove action.</p>
      <h2>Brain Memory</h2>
      <p>Closes the loop. Every pattern that worked, every mistake flagged, every competitive insight surfaced — written back into the brain automatically, informing every agent on the next cycle.</p>
    `
  }
};

// Shared JSON-LD blocks — Organization + WebSite go on every marketing page for Knowledge Panel eligibility
// and site-wide entity grounding. The SearchAction on WebSite is what enables Google's sitelinks search box.
const ORG_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Forge Intelligence",
  "url": "https://forgeintelligence.ai",
  "logo": "https://forgeintelligence.ai/forge-logo-white.png",
  "description": "Forge Intelligence extracts competitive intelligence from brand websites using an 8-stage AI pipeline. Intelligence compounds. The content proves it.",
  "foundingDate": "2025",
  "founder": { "@type": "Person", "name": "Brian Morgan" },
  "address": { "@type": "PostalAddress", "addressLocality": "Portland", "addressRegion": "OR", "addressCountry": "US" },
  "knowsAbout": ["B2B content marketing", "Generative Engine Optimization", "brand intelligence", "AI content generation", "competitive intelligence", "E-E-A-T optimization"]
};
const WEBSITE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Forge Intelligence",
  "url": "https://forgeintelligence.ai",
  "publisher": { "@type": "Organization", "name": "Forge Intelligence" },
  "potentialAction": {
    "@type": "SearchAction",
    "target": { "@type": "EntryPoint", "urlTemplate": "https://forgeintelligence.ai/?q={search_term_string}" },
    "query-input": "required name=search_term_string"
  }
};
// TODO: replace `/1.png` (product screenshot, 1920x1080) with a dedicated 1200x630 branded OG card at `/og-card.png`
const DEFAULT_OG_IMAGE = 'https://forgeintelligence.ai/1.png';

function renderMarketingPage(meta, html, pathOverride = '/') {
  const escapedDesc = meta.description.replace(/"/g, '&quot;');
  const escapedTitle = meta.title.replace(/"/g, '&quot;');
  const canonicalUrl = `https://forgeintelligence.ai${pathOverride}`;
  const ogImage = meta.ogImage || DEFAULT_OG_IMAGE;
  const headTags = `
  <title>${escapedTitle}</title>
  <meta name="description" content="${escapedDesc}" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Forge Intelligence" />
  <meta property="og:title" content="${escapedTitle}" />
  <meta property="og:description" content="${escapedDesc}" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapedTitle}" />
  <meta name="twitter:description" content="${escapedDesc}" />
  <meta name="twitter:image" content="${ogImage}" />
  <script type="application/ld+json">${JSON.stringify(ORG_JSON_LD)}</script>
  <script type="application/ld+json">${JSON.stringify(WEBSITE_JSON_LD)}</script>`;
  // Inject head tags AND body content. Content sits inside #root so React hydrates over it on the client.
  const withMeta = html.replace(/<title>[^<]*<\/title>/, '').replace('<head>', '<head>' + headTags);
  const withBody = withMeta.replace('<div id="root"></div>', `<div id="root"><div style="position:absolute;left:-99999px;top:-99999px" aria-hidden="true">${meta.bodyContent}</div></div>`);
  return withBody;
}

app.get(['/', '/product'], async (req, res, next) => {
  // Only SSR the landing domains (skip dev.* and strategy.*)
  const host = (req.get('host') || '').toLowerCase();
  if (host.includes('dev.') || host.includes('strategy.')) return next();
  try {
    const meta = MARKETING_META[req.path];
    if (!meta) return next();
    const html = await fs.promises.readFile(path.join(__dirname, 'dist', 'index.html'), 'utf8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(renderMarketingPage(meta, html, req.path));
  } catch(e) {
    console.error('[MARKETING-SSR]', e.message);
    return next();
  }
});

app.use(express.static(path.join(__dirname, 'dist')));

// ── Content fetch for preview ─────────────────────────────────────────────────

// GET /api/content/:safeId/latest — SSE recovery: check if article was generated
app.get('/api/content/:safeId/latest', async (req, res) => {
  try {
    const tableName = `generated_content_${req.params.safeId}`;
    const result = await pool.query(
      `SELECT id, title, article_json, overall_confidence, brain_match_score, compliance_status, hero_image_url, created_at
       FROM ${tableName} WHERE created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`
    );
    if (!result.rows.length) return res.json({ success: false });
    const r = result.rows[0];
    const article = r.article_json || {};
    res.json({ success: true, article: { ...article, contentId: r.id, title: r.title, overallConfidence: r.overall_confidence, brainMatchScore: r.brain_match_score, heroImageUrl: r.hero_image_url } });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/content/:safeId/:contentId', requireAuth, async (req, res) => {
  try {
    const { safeId, contentId } = req.params;
    const tableName = `generated_content_${safeId}`;
    const r = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Article not found' });
    res.json({ success: true, article: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Context Agent API ─────────────────────────────────────────────────────────

app.get('/api/context-hub/brains', softAuth, async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    
    // Unauthenticated: check session ID, filter expired
    if (!req.userId) {
      if (!sessionId) {
        return res.json({ success: true, data: [] });
      }
      const sessResult = await pool.query(
        `SELECT id, brand_url, brand_name, version, is_active, cache_status,
                created_at, updated_at, profile_data
         FROM brand_profiles 
         WHERE is_active = true 
           AND onboard_session_id = $1 
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY updated_at DESC`,
        [sessionId]
      );
      const sessData = sessResult.rows.map(r => ({
        id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
        version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
        createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
      }));
      return res.json({ success: true, data: sessData });
    }
    
    // Authenticated: show user's brains (super admins see all)
    const isSuperAdmin = SUPER_ADMIN_IDS.includes(req.userId);
    const result = isSuperAdmin
      ? await pool.query(
          `SELECT id, brand_url, brand_name, version, is_active, cache_status,
                  created_at, updated_at, profile_data,
                  (settings->'factualGround') IS NOT NULL AND settings->'factualGround' != '{}'::jsonb as has_factual_ground,
                  settings->'factualGround'->>'_updatedAt' as factual_ground_updated_at
           FROM brand_profiles WHERE is_active = true ORDER BY updated_at DESC`
        )
      : await pool.query(
          `SELECT id, brand_url, brand_name, version, is_active, cache_status,
                  created_at, updated_at, profile_data,
                  (settings->'factualGround') IS NOT NULL AND settings->'factualGround' != '{}'::jsonb as has_factual_ground,
                  settings->'factualGround'->>'_updatedAt' as factual_ground_updated_at
           FROM brand_profiles WHERE is_active = true AND clerk_user_id = $1 ORDER BY updated_at DESC`,
          [req.userId]
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
      hasFactualGround: r.has_factual_ground,
      factualGroundUpdatedAt: r.factual_ground_updated_at,
      ...r.profile_data
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/context-hub/brains/:id', requireAuth, async (req, res) => {
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

// POST /api/brand-settings/:brandProfileId/scrape-template
app.post('/api/brand-settings/:brandProfileId/scrape-template', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { articleUrl, catalogUrl } = req.body;
  if (!articleUrl) return res.status(400).json({ error: 'articleUrl required' });
  try {
    const scrape = async (url, type) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'ForgeIntelligence/1.0' } });
      if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
      const html = await r.text();
      const cls = (pattern) => html.match(pattern)?.[1] || null;

      if (type === 'article') {
        return {
          type: 'article',
          scrapedAt: new Date().toISOString(),
          sourceUrl: url,
          nav: {
            class: cls(/<nav[^>]*class="([^"]+)"/) || 'navbar',
            linksHtml: (html.match(/<ul[^>]*class="[^"]*nav[^"]*"[^>]*>([\s\S]*?)<\/ul>/) || [])[0]?.slice(0, 800) || '',
          },
          hero: {
            sectionClass: cls(/<section[^>]*class="([^"]*(?:hero|article-hero)[^"]*)"/) || 'article-hero',
            eyebrowClass: cls(/class="([^"]*eyebrow[^"]*)"/) || 'article-hero-eyebrow',
            metaClass: cls(/class="([^"]*(?:article-meta|byline)[^"]*)"/) || 'article-meta',
            imageWrapClass: cls(/class="([^"]*(?:hero-image|article-hero-image)[^"]*)"/) || 'article-hero-image',
          },
          body: {
            sectionClass: cls(/<section[^>]*class="([^"]*(?:body-section|article-body-section)[^"]*)"/) || 'article-body-section',
            bodyClass: (html.match(/class="((?:article-body|post-body|content-body)(?:[^"-]*)?)"/) || [])[1] || 'article-body',
          },
          backLink: {
            class: cls(/class="([^"]*(?:article-back|back-link)[^"]*)"/) || 'article-back',
            text: (html.match(/class="[^"]*(?:article-back|back-link)[^"]*"[^>]*>([^<]+)</) || [])[1]?.trim() || 'Back to Articles',
            href: catalogUrl || '/',
          },
          cta: {
            class: cls(/class="([^"]*(?:article-cta|cta-section)[^"]*)"/) || 'article-cta-section',
          },
          footer: {
            class: cls(/<footer[^>]*class="([^"]+)"/) || 'site-footer',
          },
        };
      }

      if (type === 'catalog') {
        return {
          type: 'catalog',
          scrapedAt: new Date().toISOString(),
          sourceUrl: url,
          grid: { class: cls(/class="([^"]*(?:articles-grid|posts-grid|cards-grid|article-grid)[^"]*)"/) || 'articles-grid' },
          card: {
            class: cls(/class="([^"]*(?:article-card|post-card)[^"]*)"[^>]*>/) || 'article-card',
            imageClass: cls(/class="([^"]*(?:article-card-image|card-image)[^"]*)"/) || 'article-card-image',
            bodyClass: cls(/class="([^"]*(?:article-card-body|card-body)[^"]*)"/) || 'article-card-body',
          },
          meta: {
            categoryClass: cls(/class="([^"]*(?:article-category|post-category|card-category)[^"]*)"/) || 'article-category',
            readMoreClass: cls(/class="([^"]*(?:article-read-more|read-more)[^"]*)"/) || 'article-read-more',
          },
        };
      }
    };

    const articleTemplate = await scrape(articleUrl, 'article');
    const catalogTemplate = catalogUrl ? await scrape(catalogUrl, 'catalog') : null;

    const existing = await pool.query('SELECT settings FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const currentSettings = existing.rows[0]?.settings || {};
    const newSettings = { ...currentSettings, siteTemplate: { article: articleTemplate, catalog: catalogTemplate, lastScrapedAt: new Date().toISOString() } };

    await pool.query(
      'UPDATE brand_profiles SET settings = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(newSettings), brandProfileId]
    );

    res.json({ success: true, template: newSettings.siteTemplate });
  } catch (err) {
    console.error('[SCRAPE-TEMPLATE]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/content/topic-check — pre-flight check topic against brain_patterns/mistakes
app.post('/api/content/topic-check', requireAuth, async (req, res) => {
  const { brandProfileId, topic } = req.body;
  if (!brandProfileId || !topic) return res.status(400).json({ error: 'brandProfileId and topic required' });
  try {
    const [pRes, mRes] = await Promise.all([
      pool.query('SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8', [brandProfileId]),
      pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 5', [brandProfileId])
    ]);

    const patterns = pRes.rows;
    const mistakes = mRes.rows;

    // If no brain data yet return neutral
    if (!patterns.length && !mistakes.length) {
      return res.json({ success: true, signal: 'strong', confidence: 'No prior data', reason: 'No performance patterns have been extracted yet for this brand. Generate and publish content, then run Pattern Extraction to unlock topic intelligence.', reframe: null });
    }

    const prompt = `You are a content strategy advisor for a B2B brand. A user wants to write about this topic:
"${topic}"

Here is what has worked for this brand (brain patterns):
${patterns.map(p => `- [${p.pattern_type}] ${p.description} (${Math.round((p.confidence_score||0)*100)}% confidence)`).join('\n') || 'None yet'}

Here is what has underperformed (brain mistakes):
${mistakes.map(m => `- [${m.severity} severity] ${m.mistake_type}: ${m.description}`).join('\n') || 'None yet'}

Evaluate the user's topic against this brand's performance data and return ONLY a JSON object:
{
  "signal": "strong" | "caution" | "weak",
  "confidence": "one short phrase like '92% alignment' or 'Low confidence'",
  "reason": "2-3 sentences explaining why this topic will or won't perform based on the brain data",
  "reframe": "If signal is caution or weak, return ONLY the reframed topic as a short phrase — just the topic the user should write about instead, no explanation. If strong, return null.",
  "reframeRationale": "If reframe is not null, explain in 1-2 sentences why this angle aligns better with the brand's brain data. If strong, return null."
}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const aiData = await aiRes.json();
    const raw = aiData.content?.[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = safeParseLLM(clean, 'object', 'topic-check');
    // Guard: if Anthropic returned an error, parsed will be empty — don't send a blank card
    if (!parsed.signal) {
      return res.json({ success: true, signal: 'strong', confidence: 'Check unavailable', reason: 'Could not evaluate topic against brain data right now. Proceed with generation.', reframe: null });
    }
    res.json({ success: true, ...parsed });
  } catch(e) {
    console.error('[TOPIC-CHECK]', e.message);
    res.json({ success: true, signal: 'strong', confidence: 'Check unavailable', reason: 'Could not evaluate topic against brain data right now. Proceed with generation.', reframe: null });
  }
});


// PATCH /api/content/:brandSafeId/:contentId — inline article edit from preview modal
app.patch('/api/content/:brandSafeId/:contentId', async (req, res) => {
  const { brandSafeId, contentId } = req.params;
  const { article_json, title } = req.body;
  const tableName = `generated_content_${brandSafeId}`;
  try {
    const updates = [];
    const params = [];
    let pi = 1;
    if (title !== undefined) { updates.push(`title = $${pi++}`); params.push(title); }
    if (article_json !== undefined) { updates.push(`article_json = $${pi++}`); params.push(JSON.stringify(article_json)); }
    if (!updates.length) return res.json({ success: true });
    updates.push(`updated_at = NOW()`);
    params.push(contentId);
    await pool.query(
      `UPDATE ${tableName} SET ${updates.join(', ')} WHERE id = $${pi}`,
      params
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/publishing/queue/:id/title — inline title edit
app.patch('/api/publishing/queue/:id/title', async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  try {
    await pool.query(
      `UPDATE publishing_queue SET title = $1, updated_at = NOW() WHERE id = $2`,
      [title.trim(), req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/publishing/queue/:id/archive
app.post('/api/publishing/queue/:id/archive', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE publishing_queue SET status = 'archived', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/publishing/queue/:id/unarchive
app.post('/api/publishing/queue/:id/unarchive', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE publishing_queue SET status = 'staged', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/analytics/patterns/:brandProfileId
app.get('/api/analytics/patterns/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  try {
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const [pRes, mRes] = await Promise.all([
      pool.query(
        'SELECT id, pattern_type, description, confidence_score, success_rate, tags, created_at FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC, created_at DESC',
        [brandProfileId]
      ),
      pool.query(
        'SELECT id, mistake_type, description, human_feedback, guardrail_created, severity, created_at FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC',
        [brandProfileId]
      )
    ]);
    res.json({ success: true, patterns: pRes.rows, mistakes: mRes.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── Brain Distill — convert human edits into writing rules ───────────────────
app.post('/api/brain/distill/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  const isCron = req.body?.adminPassword === process.env.ADMIN_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'] });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // Read all human edits from brain_mistakes
    const editsRes = await pool.query(
      `SELECT description, human_feedback FROM brain_mistakes
       WHERE brand_profile_id = $1 AND mistake_type = 'human_edit' AND human_feedback IS NOT NULL
       ORDER BY created_at DESC LIMIT 40`,
      [brandProfileId]
    );

    if (editsRes.rows.length === 0) {
      return res.json({ success: true, rules: [], ruleCount: 0, editCount: 0,
        message: 'No editorial signals yet. Review AI content in Compliance Gate — every edit teaches the Brain your voice.' });
    }

    // Format edits for Haiku (cap body to keep tokens manageable)
    const editSummary = editsRes.rows.map((e, i) => {
      const fb = e.human_feedback || '';
      // Try structured Avoid/Prefer parsing first, fall back to raw feedback
      const avoidMatch = fb.match(/Avoid:\s*"([\s\S]*?)(?:"|$)/);
      const preferMatch = fb.match(/[Pp]refer:\s*"([\s\S]*?)(?:"|$)/);
      const avoid = (avoidMatch?.[1] || '').replace(/\n/g, ' ').trim().slice(0, 500);
      const prefer = (preferMatch?.[1] || '').replace(/\n/g, ' ').trim().slice(0, 500);
      if (avoid || prefer) {
        return `Edit ${i + 1}:\nAvoid: "${avoid}"\nPrefer: "${prefer}"`;
      }
      // Raw fallback — just pass the feedback directly
      const raw = fb.replace(/\n/g, ' ').trim().slice(0, 500);
      if (!raw) return null;
      return `Edit ${i + 1}:\n${raw}`;
    }).filter(Boolean).join('\n\n');

    const brandRes = await pool.query('SELECT brand_name FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const brandName = brandRes.rows[0]?.brand_name || 'this brand';

    const prompt = `You are analyzing human editorial corrections made to AI-generated B2B marketing content for ${brandName}.

Each correction shows: what the AI wrote (Avoid) and what the human reviewer preferred (Prefer).
These corrections represent the editor's authentic voice and non-negotiable brand standards.

Analyze these ${editsRes.rows.length} editorial corrections and distill them into 8-10 clear, actionable writing rules that the AI must follow on every future generation.

EDITORIAL CORRECTIONS:
${editSummary}

Rules for your analysis:
- Look for PATTERNS across multiple edits — what does the editor consistently change?
- Each rule should be immediately actionable for an AI content generator
- Prefer "avoid X, do Y" framing when direction is clear
- Weight rules by how many edits support them
- Be specific — "avoid named fictional case studies" is better than "be authentic"

Return ONLY valid JSON, no explanation:
{
  "rules": [
    {
      "rule": "One clear, actionable directive sentence",
      "rationale": "Why this rule exists — the pattern you observed across edits",
      "direction": "avoid OR do",
      "example_avoid": "Representative example of what to avoid (under 120 chars)",
      "example_prefer": "Representative example of what to write instead (under 120 chars)",
      "confidence": 0.0-1.0,
      "edit_count": number
    }
  ]
}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
    });
    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';
    const clean = rawText.replace(/```json|```/g, '').trim();
    let extracted = { rules: [] };
    try { extracted = safeParseLLM(clean, 'object', 'brain-distill'); } catch(e) { console.error('[BRAIN-DISTILL] JSON parse error:', e.message, rawText.slice(0, 200)); }

    const rules = extracted.rules || [];

    // Replace existing writing_rule patterns for this brand
    await pool.query(`DELETE FROM brain_patterns WHERE brand_profile_id = $1 AND pattern_type = 'writing_rule'`, [brandProfileId]);

    for (const rule of rules) {
      await pool.query(
        `INSERT INTO brain_patterns
           (brand_profile_id, pattern_type, description, confidence_score, tags, source_channel, example_titles, last_validated_at, updated_at)
         VALUES ($1, 'writing_rule', $2, $3, $4, 'compliance_gate', $5, NOW(), NOW())`,
        [
          brandProfileId,
          rule.rule || '',
          rule.confidence || 0.7,
          JSON.stringify([
            `direction:${rule.direction || 'avoid'}`,
            `rationale:${rule.rationale || ''}`,
            `edits:${rule.edit_count || 1}`
          ]),
          JSON.stringify([
            rule.example_avoid || '',
            rule.example_prefer || ''
          ])
        ]
      );
    }

    console.log(`[BRAIN-DISTILL] ${rules.length} rules written for ${brandProfileId} from ${editsRes.rows.length} edits`);
    res.json({ success: true, rules, ruleCount: rules.length, editCount: editsRes.rows.length });
  } catch(e) {
    console.error('[BRAIN-DISTILL]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/analytics/extract-patterns/:brandProfileId
// Analyzes content_analytics + publishing_queue to extract Brain Patterns and Mistakes
app.post('/api/analytics/extract-patterns/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  // Allow cron/admin bypass with adminPassword, otherwise require Clerk JWT
  const isCron = req.body?.adminPassword === process.env.ADMIN_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'] });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  }
  try {
    if (!isCron && !(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const safeId = brandProfileId.replace(/-/g, '_');

    // Fetch analytics data
    const analyticsRes = await pool.query(
      `SELECT ca.content_id, ca.channel, ca.impressions, ca.clicks, ca.reactions,
              ca.ctr, ca.engagement_rate, ca.reading_time, ca.positive_feedback,
              ca.negative_feedback, ca.published_at,
              pq.title
       FROM content_analytics ca
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id = $1
       ORDER BY ca.impressions DESC, ca.clicks DESC`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    if (analyticsRes.rows.length === 0) {
      return res.json({ success: true, patternsWritten: 0, mistakesWritten: 0, patterns: [], mistakes: [], message: 'No analytics data to extract from' });
    }

    // Build summary for Claude
    const topPosts = analyticsRes.rows.slice(0, 10);
    const bottomPosts = analyticsRes.rows.slice(-5);
    const avgImpressions = analyticsRes.rows.reduce((a, r) => a + (r.impressions || 0), 0) / analyticsRes.rows.length;
    const avgCtr = analyticsRes.rows.reduce((a, r) => a + (r.ctr || 0), 0) / analyticsRes.rows.length;

    const prompt = `You are a content intelligence analyst. Analyze this performance data and extract actionable patterns and mistakes.

ANALYTICS SUMMARY:
- Total articles tracked: ${analyticsRes.rows.length}
- Average impressions: ${Math.round(avgImpressions)}
- Average CTR: ${avgCtr.toFixed(2)}%

TOP PERFORMING (highest impressions/engagement):
${topPosts.map(p => `- "${p.title || 'Untitled'}" | Channel: ${p.channel} | Impressions: ${p.impressions || 0} | Clicks: ${p.clicks || 0} | CTR: ${p.ctr || 0}% | Reactions: ${p.reactions || 0} | Reading time: ${p.reading_time || 0}min`).join('\n')}

UNDERPERFORMING (lowest engagement):
${bottomPosts.map(p => `- "${p.title || 'Untitled'}" | Channel: ${p.channel} | Impressions: ${p.impressions || 0} | Clicks: ${p.clicks || 0} | CTR: ${p.ctr || 0}%`).join('\n')}

Return ONLY a JSON object with this exact structure:
{
  "patterns": [
    { "pattern_type": "short label", "description": "1-2 sentence actionable insight about what's working", "confidence_score": 0.0-1.0, "tags": ["tag1"] }
  ],
  "mistakes": [
    { "mistake_type": "short label", "description": "1-2 sentence insight about what to avoid", "severity": "high|medium|low" }
  ]
}

Extract 3-6 patterns and 2-4 mistakes. Be specific and actionable. Focus on content type, topic, channel, format, timing patterns.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';
    let extracted = { patterns: [], mistakes: [] };
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      extracted = safeParseLLM(clean, 'object', 'pattern-extractor');
    } catch(e) { console.error('[EXTRACT-PATTERNS] JSON parse error:', e.message); }

    // Write patterns to brain_patterns
    let patternsWritten = 0;
    for (const p of (extracted.patterns || [])) {
      await pool.query(
        `INSERT INTO brain_patterns (brand_profile_id, pattern_type, description, confidence_score, tags)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [brandProfileId, p.pattern_type || 'general', p.description || '', p.confidence_score || 0.5, JSON.stringify(p.tags || [])]
      ).catch(() => {});
      patternsWritten++;
    }

    // Write mistakes to brain_mistakes
    let mistakesWritten = 0;
    for (const m of (extracted.mistakes || [])) {
      await pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, severity)
         VALUES ($1, $2, $3, $4)`,
        [brandProfileId, m.mistake_type || 'general', m.description || '', m.severity || 'low']
      ).catch(() => {});
      mistakesWritten++;
    }

    // Return fresh patterns and mistakes
    const [pRes, mRes] = await Promise.all([
      pool.query('SELECT * FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC', [brandProfileId]),
      pool.query('SELECT * FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC', [brandProfileId])
    ]);

    res.json({ success: true, patternsWritten, mistakesWritten, patterns: pRes.rows, mistakes: mRes.rows });
  } catch(e) {
    console.error('[EXTRACT-PATTERNS]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Pre-cog Score — Predictive Performance Scoring ────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/precog/score — Calculate pre-cog score for a content item
async function updatePrecogOutcomes(brandProfileId) {
  try {
    // Find outcomes awaiting measurement — join with content_analytics for actuals
    const pending = await pool.query(`
      SELECT po.id, po.predicted_signal, po.predicted_impressions_low,
             po.predicted_impressions_high, po.avg_impressions_at_prediction,
             ca.impressions AS actual_impressions, ca.clicks AS actual_clicks
      FROM precog_outcomes po
      INNER JOIN content_analytics ca
        ON ca.content_id = po.content_id AND ca.brand_profile_id = po.brand_profile_id
      WHERE po.brand_profile_id = $1
        AND po.measured_at IS NULL
        AND ca.impressions > 0
    `, [brandProfileId]);

    if (!pending.rows.length) return;

    for (const row of pending.rows) {
      const actual = parseInt(row.actual_impressions) || 0;
      const avg    = parseFloat(row.avg_impressions_at_prediction) || 0;

      // Directional accuracy
      let directionCorrect = false;
      if (row.predicted_signal === 'above_average') {
        directionCorrect = avg > 0 ? actual >= avg : actual > 0;
      } else if (row.predicted_signal === 'below_average') {
        directionCorrect = avg > 0 ? actual < avg : false;
      } else {
        // 'average' — correct if within 40% of historical avg
        directionCorrect = avg > 0
          ? (actual >= avg * 0.6 && actual <= avg * 1.4)
          : true;
      }

      // Range accuracy
      const low  = parseInt(row.predicted_impressions_low)  || 0;
      const high = parseInt(row.predicted_impressions_high) || 0;
      const inRange = (low > 0 && high > 0) ? (actual >= low && actual <= high) : null;

      await pool.query(`
        UPDATE precog_outcomes SET
          actual_impressions = $1,
          actual_clicks = $2,
          direction_correct = $3,
          in_range = $4,
          measured_at = NOW()
        WHERE id = $5
      `, [actual, parseInt(row.actual_clicks) || 0, directionCorrect, inRange, row.id]);
    }

    console.log(`[PRE-COG] Accuracy updated for ${pending.rows.length} outcome(s) — brand ${brandProfileId}`);
  } catch(e) {
    console.log('[PRE-COG] updatePrecogOutcomes error:', e.message);
  }
}

app.post('/api/precog/score', requireAuth, async (req, res) => {
  const { brandProfileId, contentId } = req.body;
  if (!brandProfileId || !contentId) {
    return res.status(400).json({ error: 'brandProfileId and contentId required' });
  }

  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;

    // 1. Get the content
    const contentRes = await pool.query(`SELECT * FROM ${contentTable} WHERE id = $1`, [contentId]);
    if (!contentRes.rows.length) return res.status(404).json({ error: 'Content not found' });
    const content = contentRes.rows[0];
    const articleJson = content.article_json || {};
    const sections = articleJson.sections || [];

    // 2. Get historical performance data
    const analyticsRes = await pool.query(`
      SELECT 
        AVG(impressions) as avg_impressions,
        AVG(clicks) as avg_clicks,
        AVG(engagement_rate) as avg_engagement,
        AVG(ctr) as avg_ctr,
        MAX(impressions) as max_impressions,
        MAX(engagement_rate) as max_engagement,
        COUNT(*) as total_posts
      FROM content_analytics 
      WHERE brand_profile_id = $1 AND impressions > 0
    `, [brandProfileId]);
    const stats = analyticsRes.rows[0] || {};

    // 3. Get top performing content patterns
    const topPerformersRes = await pool.query(`
      SELECT ca.content_id, ca.impressions, ca.engagement_rate, ca.channel
      FROM content_analytics ca
      WHERE ca.brand_profile_id = $1 AND ca.impressions > 0
      ORDER BY ca.engagement_rate DESC
      LIMIT 10
    `, [brandProfileId]);

    // 4. Get brain patterns
    const patternsRes = await pool.query(`
      SELECT pattern_type, description, confidence_score, success_rate
      FROM brain_patterns
      WHERE brand_profile_id = $1
      ORDER BY success_rate DESC
      LIMIT 20
    `, [brandProfileId]);
    const patterns = patternsRes.rows;

    // 5. Get brain mistakes (anti-patterns)
    const mistakesRes = await pool.query(`
      SELECT mistake_type, description, severity
      FROM brain_mistakes
      WHERE brand_profile_id = $1
    `, [brandProfileId]);
    const mistakes = mistakesRes.rows;

    // ── SCORING ALGORITHM ──
    let score = 50; // Base score
    const breakdown = {};

    // A. Content Structure Score (0-15 points)
    const wordCount = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
    const sectionCount = sections.length;
    const hasHeadings = sections.filter(s => s.heading).length;
    
    let structureScore = 0;
    if (wordCount >= 800 && wordCount <= 2000) structureScore += 5;
    else if (wordCount >= 500 && wordCount <= 2500) structureScore += 3;
    if (sectionCount >= 3 && sectionCount <= 8) structureScore += 5;
    else if (sectionCount >= 2) structureScore += 2;
    if (hasHeadings >= 3) structureScore += 5;
    else if (hasHeadings >= 1) structureScore += 2;
    
    breakdown.structure = { score: structureScore, max: 15, wordCount, sectionCount, hasHeadings };
    score += structureScore;

    // B. Title Score (0-15 points)
    const title = content.title || '';
    let titleScore = 0;
    if (title.length >= 30 && title.length <= 70) titleScore += 5;
    if (/\d/.test(title)) titleScore += 3;
    if (/how|why|what|guide|tips|secrets|mistakes/i.test(title)) titleScore += 4;
    if (!/\?$/.test(title) && title.length > 0) titleScore += 3;
    
    breakdown.title = { score: titleScore, max: 15, length: title.length };
    score += titleScore;

    // C. Pattern Match Score (0-20 points)
    let patternScore = 0;
    const matchedPatterns = [];
    const titleLower = title.toLowerCase();
    const bodyText = sections.map(s => (s.body || s.content || '').toLowerCase()).join(' ');
    
    for (const p of patterns) {
      const desc = (p.description || '').toLowerCase();
      const keywords = desc.split(' ').filter(w => w.length > 4).slice(0, 5);
      const matches = keywords.filter(k => titleLower.includes(k) || bodyText.includes(k));
      if (matches.length >= 2) {
        patternScore += Math.min(4, (p.success_rate || 0.5) * 5);
        matchedPatterns.push({ type: p.pattern_type, confidence: p.confidence_score });
      }
    }
    patternScore = Math.min(20, patternScore);
    breakdown.patternMatch = { score: patternScore, max: 20, matchedPatterns };
    score += patternScore;

    // D. Anti-pattern Penalty (-10 to 0 points)
    let penaltyScore = 0;
    const triggeredMistakes = [];
    for (const m of mistakes) {
      const desc = (m.description || '').toLowerCase();
      const keywords = desc.split(' ').filter(w => w.length > 4).slice(0, 3);
      const matches = keywords.filter(k => titleLower.includes(k) || bodyText.includes(k));
      if (matches.length >= 2) {
        const penalty = m.severity === 'high' ? -4 : m.severity === 'medium' ? -2 : -1;
        penaltyScore += penalty;
        triggeredMistakes.push({ type: m.mistake_type, severity: m.severity });
      }
    }
    penaltyScore = Math.max(-10, penaltyScore);
    breakdown.antiPatterns = { score: penaltyScore, max: 0, triggeredMistakes };
    score += penaltyScore;

    // E. Historical Context Score (0-10 points)
    let historyScore = 0;
    if (stats.total_posts > 0) {
      if (stats.total_posts >= 20) historyScore += 5;
      else if (stats.total_posts >= 10) historyScore += 3;
      else if (stats.total_posts >= 5) historyScore += 1;
      if (stats.avg_engagement > 0.03) historyScore += 5;
      else if (stats.avg_engagement > 0.01) historyScore += 3;
    }
    breakdown.history = { 
      score: historyScore, 
      max: 10, 
      totalPosts: parseInt(stats.total_posts) || 0,
      avgEngagement: parseFloat(stats.avg_engagement) || 0,
      avgImpressions: parseInt(stats.avg_impressions) || 0
    };
    score += historyScore;

    // Normalize to 0-100
    score = Math.max(0, Math.min(100, score));

    // Prediction tier
    let tier, prediction, color;
    if (score >= 80) {
      tier = 'high'; prediction = 'Likely to outperform your average'; color = '#22C55E';
    } else if (score >= 60) {
      tier = 'medium'; prediction = 'Expected to perform near your average'; color = '#EAB308';
    } else if (score >= 40) {
      tier = 'low'; prediction = 'May underperform — consider revisions'; color = '#F97316';
    } else {
      tier = 'risk'; prediction = 'High risk — review before publishing'; color = '#EF4444';
    }

    // Predicted impressions range
    const predictedImpressions = stats.avg_impressions 
      ? { low: Math.round(stats.avg_impressions * (score / 100) * 0.7), high: Math.round(stats.avg_impressions * (score / 100) * 1.5) }
      : null;

    // Save score to content table
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_score INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_breakdown JSONB`).catch(() => {});
    await pool.query(`UPDATE ${contentTable} SET precog_score = $1, precog_breakdown = $2, updated_at = NOW() WHERE id = $3`, [Math.round(score), JSON.stringify(breakdown), contentId]);

    res.json({
      success: true, score, tier, prediction, color, breakdown, predictedImpressions,
      historicalContext: {
        totalPosts: parseInt(stats.total_posts) || 0,
        avgImpressions: Math.round(stats.avg_impressions) || 0,
        avgEngagement: ((parseFloat(stats.avg_engagement) || 0) * 100).toFixed(2) + '%'
      }
    });

  } catch (err) {
    console.error('[Pre-cog] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/precog/score/:brandProfileId/:contentId — Get cached score
app.get('/api/precog/score/:brandProfileId/:contentId', requireAuth, async (req, res) => {
  const { brandProfileId, contentId } = req.params;
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;
    
    const result = await pool.query(`SELECT precog_score, precog_breakdown FROM ${contentTable} WHERE id = $1`, [contentId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Content not found' });
    
    const row = result.rows[0];
    if (!row.precog_score) return res.json({ success: true, score: null, message: 'Score not yet calculated' });

    const score = row.precog_score;
    let tier, prediction, color;
    if (score >= 80) { tier = 'high'; prediction = 'Likely to outperform'; color = '#22C55E'; }
    else if (score >= 60) { tier = 'medium'; prediction = 'Near average'; color = '#EAB308'; }
    else if (score >= 40) { tier = 'low'; prediction = 'May underperform'; color = '#F97316'; }
    else { tier = 'risk'; prediction = 'High risk'; color = '#EF4444'; }

    res.json({ success: true, score, tier, prediction, color, breakdown: row.precog_breakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/precog/batch — Score all unscored content for a brand
app.post('/api/precog/batch', requireAuth, async (req, res) => {
  const { brandProfileId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;
    
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_score INTEGER`).catch(() => {});
    await pool.query(`ALTER TABLE ${contentTable} ADD COLUMN IF NOT EXISTS precog_breakdown JSONB`).catch(() => {});

    const unscoredRes = await pool.query(`SELECT id FROM ${contentTable} WHERE precog_score IS NULL ORDER BY created_at DESC LIMIT 50`);

    const scored = [];
    for (const row of unscoredRes.rows) {
      try {
        const scoreRes = await fetch(`https://${req.headers.host}/api/precog/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization || '' },
          body: JSON.stringify({ brandProfileId, contentId: row.id })
        });
        const data = await scoreRes.json();
        if (data.success) scored.push({ id: row.id, score: data.score });
      } catch (e) {
        console.error(`[Pre-cog] Failed to score ${row.id}:`, e.message);
      }
    }

    res.json({ success: true, scored: scored.length, items: scored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/precog/all/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;
    // Query separately to avoid RLS cross-table join issue on precog_outcomes
    const [gcRes, poRes] = await Promise.all([
      pool.query(`
        SELECT id, title, precog_score, precog_breakdown, precog_scored_at, created_at
        FROM ${contentTable}
        WHERE precog_score IS NOT NULL
           OR (precog_breakdown IS NOT NULL AND precog_breakdown->>'tier' = 'insufficient_data')
        ORDER BY created_at DESC LIMIT 100
      `),
      pool.query(`
        SELECT content_id, actual_impressions, actual_clicks, direction_correct, in_range,
               measured_at, predicted_signal, predicted_impressions_low, predicted_impressions_high
        FROM precog_outcomes WHERE brand_profile_id = $1
      `, [brandProfileId])
    ]);
    // Merge outcomes onto content rows
    const outcomesMap = {};
    for (const po of poRes.rows) outcomesMap[po.content_id] = po;
    const items = gcRes.rows.map(gc => ({ ...gc, ...( outcomesMap[gc.id] || {}) }));
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/precog/accuracy/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)                                                              AS total_predictions,
        COUNT(*) FILTER (WHERE measured_at IS NOT NULL)                      AS measured_count,
        COUNT(*) FILTER (WHERE measured_at IS NULL)                          AS pending_count,
        COUNT(*) FILTER (WHERE direction_correct = true)                     AS direction_correct_count,
        COUNT(*) FILTER (WHERE in_range = true)                              AS in_range_count
      FROM precog_outcomes
      WHERE brand_profile_id = $1
    `, [brandProfileId]);

    const s = r.rows[0];
    const measured  = parseInt(s.measured_count)          || 0;
    const pending   = parseInt(s.pending_count)           || 0;
    const dirCorr   = parseInt(s.direction_correct_count) || 0;
    const inRange   = parseInt(s.in_range_count)          || 0;

    res.json({
      success: true,
      measuredCount: measured,
      pendingCount: pending,
      totalPredictions: parseInt(s.total_predictions) || 0,
      directionAccuracy: measured >= 3 ? Math.round((dirCorr / measured) * 100) : null,
      rangeAccuracy:     measured >= 3 ? Math.round((inRange / measured) * 100) : null,
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// -- GET /api/brand-profiles/list
// GET /api/brand-settings/:brandProfileId
app.get('/api/brand-settings/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  try {
    const r = await pool.query(
      'SELECT id, brand_name, brand_url, article_base_url, article_url_suffix, logo_url, settings, created_at, updated_at FROM brand_profiles WHERE id = $1',
      [brandProfileId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/brand-settings/:brandProfileId
app.patch('/api/brand-settings/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  const { brandName, articleBaseUrl, articleUrlSuffix, logoUrl, settings } = req.body;
  try {
    const fields = [];
    const vals = [];
    let i = 1;
    if (brandName      !== undefined) { fields.push(`brand_name = $${i++}`);        vals.push(brandName); }
    if (articleBaseUrl    !== undefined) { fields.push(`article_base_url = $${i++}`);    vals.push(articleBaseUrl); }
    if (articleUrlSuffix !== undefined) { fields.push(`article_url_suffix = $${i++}`); vals.push(articleUrlSuffix); }
    if (logoUrl        !== undefined) { fields.push(`logo_url = $${i++}`);           vals.push(logoUrl); }
    if (settings       !== undefined) {
      // If factualGround is being saved, stamp it with a timestamp so UI can show "user enrichment applied"
      const settingsWithTimestamp = { ...settings };
      if (settings.factualGround) {
        settingsWithTimestamp.factualGround = {
          ...settings.factualGround,
          _updatedAt: new Date().toISOString(),
        };
      }
      fields.push(`settings = COALESCE(settings, '{}'::jsonb) || $${i++}::jsonb`);
      vals.push(JSON.stringify(settingsWithTimestamp));
    }
    // Bump version when factualGround is saved — it is a meaningful brain update
    if (settings?.factualGround !== undefined) { fields.push(`version = COALESCE(version, 1) + 1`); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`);
    vals.push(brandProfileId);
    await pool.query(
      `UPDATE brand_profiles SET ${fields.join(', ')} WHERE id = $${i}`,
      vals
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/brand-profiles/list', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, brand_url, brand_name, profile_data FROM brand_profiles WHERE is_active = true ORDER BY updated_at DESC`
    );
    const profiles = result.rows.map(r => ({
      id: r.id,
      brandUrl: r.brand_url,
      brandName: r.brand_name || r.profile_data?.voice_profile?.brand_name || r.brand_url,
    }));
    res.json({ success: true, profiles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/context-hub/history/:encodedUrl', async (req, res) => {
  try {
    const brandUrl = decodeURIComponent(req.params.encodedUrl);
    const result = await pool.query(
      `SELECT id, brand_url, brand_name, version, is_active, cache_status, created_at, updated_at,
              (settings->'factualGround') IS NOT NULL AND settings->'factualGround' != '{}'::jsonb as has_factual_ground,
              settings->'factualGround'->>'_updatedAt' as factual_ground_updated_at
       FROM brand_profiles WHERE brand_url = $1 ORDER BY version DESC`, [brandUrl]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/context-hub/analyze', softAuth, async (req, res) => {
  const { brandUrl, competitorUrls = [], audienceNotes = '', strategicNotes = '', checkBrainFirst = true, saveToBrain = true } = req.body;
  if (!brandUrl) {
    return res.status(400).json({ success: false, error: 'brandUrl is required' });
  }
  // Validate domain format — block gibberish / bot submissions
  const domainCleaned = brandUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  if (!domainCleaned.includes('.') || !/^[a-zA-Z0-9.-]+$/.test(domainCleaned)) {
    return res.status(400).json({ success: false, error: 'Invalid domain format' });
  }
  const tld = domainCleaned.split('.').pop();
  if (!tld || tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) {
    return res.status(400).json({ success: false, error: 'Invalid domain — must have a valid TLD (e.g. .com, .io)' });
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


    // ── Tool 1.5: Website Scraper — actual content extraction ─────────────────
    console.log(`[Context Hub] Tool 1.5: Scraping website content for ${brandUrl}...`);
    let scrapedContent = '';
    let homeHtml = '';
    let workingBaseUrl = '';
    // Masked-subdomain support: if the user set a scrapeUrlOverride in Brand Settings
    // (e.g., brand_url is a vanity domain pointing to a Render subservice), use the
    // override as the actual scrape target instead of the public-facing URL.
    let scrapeInputUrl = brandUrl;
    try {
      const ovRes = await pool.query(
        `SELECT settings->>'scrapeUrlOverride' as override FROM brand_profiles WHERE brand_url = $1 ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );
      const override = ovRes.rows[0]?.override?.trim();
      if (override) {
        scrapeInputUrl = override;
        console.log(`[Context Hub] Using scrape URL override: ${override} (public: ${brandUrl})`);
      }
    } catch { /* no profile yet, use brandUrl directly */ }
    try {
      // Chrome UA — some sites (Squarespace, Vercel edge, etc.) 403 on unknown UAs. Forge UA tried first for honesty, Chrome as fallback.
      const FORGE_UA = 'ForgeIntelligence/1.0 (Brand Analysis)';
      const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

      const stripHtml = (html) => html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Tell the developer exactly why a fetch failed (not just "it didn't work")
      const describeFetchFailure = (err) => {
        if (!err) return 'unknown';
        const code = err.cause?.code || err.code || '';
        if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/i.test(err.message || '')) return `DNS-NOT-FOUND (${err.message || code})`;
        if (code === 'ECONNREFUSED') return 'CONNECTION-REFUSED';
        if (code === 'ECONNRESET') return 'CONNECTION-RESET';
        if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) return 'TIMEOUT';
        if (/certificate|TLS|SSL/i.test(err.message || '')) return `TLS-ERROR (${err.message})`;
        return `${err.name || 'Error'}: ${err.message || code || 'no detail'}`;
      };

      // Fetch with detailed error surfacing. Returns { res, html, error } — never throws.
      const fetchWithDiag = async (url, { ua = FORGE_UA, timeout = 10000 } = {}) => {
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeout)
          });
          if (!res.ok) return { res, html: '', error: `HTTP-${res.status}` };
          const html = await res.text();
          return { res, html, error: null };
        } catch(e) {
          return { res: null, html: '', error: describeFetchFailure(e) };
        }
      };

      // Build candidate base URLs. Brands saved as "example.com" may have apex-only or www-only DNS —
      // try both, and try Chrome UA as a fallback if the Forge UA gets 403.
      const inputUrl = scrapeInputUrl.startsWith('http') ? scrapeInputUrl : `https://${scrapeInputUrl}`;
      const u = new URL(inputUrl);
      const bareHost = u.hostname.replace(/^www\./, '');
      const candidates = [];
      if (u.hostname.startsWith('www.')) {
        candidates.push(`${u.protocol}//${u.hostname}`, `${u.protocol}//${bareHost}`);
      } else {
        candidates.push(`${u.protocol}//${u.hostname}`, `${u.protocol}//www.${u.hostname}`);
      }

      // Try each candidate with Forge UA, then Chrome UA
      for (const candidate of candidates) {
        let attempt = await fetchWithDiag(candidate, { ua: FORGE_UA });
        if (!attempt.html && /HTTP-4\d\d/.test(attempt.error || '')) {
          // Some sites 403/406 unknown UAs. Retry same URL with a standard Chrome UA.
          console.log(`[Context Hub] ${candidate} returned ${attempt.error} with Forge UA — retrying with Chrome UA`);
          attempt = await fetchWithDiag(candidate, { ua: CHROME_UA });
        }
        if (attempt.html) {
          homeHtml = attempt.html;
          workingBaseUrl = candidate;
          console.log(`[Context Hub] Homepage scraped from ${candidate} (${attempt.html.length} bytes)`);
          break;
        } else {
          console.log(`[Context Hub] Homepage fetch failed for ${candidate} — ${attempt.error}`);
        }
      }

      if (homeHtml) {
        const homeText = stripHtml(homeHtml).slice(0, 3000);
        if (homeText.length > 80) scrapedContent += `HOMEPAGE CONTENT:\n${homeText}\n\n`;
      }

      // Extract internal links from homepage for deeper crawl
      const linkMatches = homeHtml.match(/href=["'](\/[^"'#?]+)["']/g) || [];
      const internalPaths = [...new Set(
        linkMatches
          .map(m => m.match(/href=["'](\/[^"'#?]+)["']/)?.[1])
          .filter(Boolean)
          .filter(p => /\/(about|story|product|service|blog|mission|team|who-we|what-we|our-)/i.test(p))
      )].slice(0, 4);

      // Also try common about paths if none found
      const aboutPaths = internalPaths.length > 0 ? internalPaths : ['/about', '/about-us', '/pages/about'];

      if (workingBaseUrl) {
        for (const path of aboutPaths) {
          const pageUrl = new URL(path, workingBaseUrl).href;
          let pageAttempt = await fetchWithDiag(pageUrl, { ua: FORGE_UA, timeout: 8000 });
          if (!pageAttempt.html && /HTTP-4\d\d/.test(pageAttempt.error || '')) {
            pageAttempt = await fetchWithDiag(pageUrl, { ua: CHROME_UA, timeout: 8000 });
          }
          if (pageAttempt.html) {
            const pageText = stripHtml(pageAttempt.html).slice(0, 2000);
            if (pageText.length > 100) {
              scrapedContent += `PAGE (${path}):\n${pageText}\n\n`;
            }
          } else {
            console.log(`[Context Hub] Subpage ${path} failed — ${pageAttempt.error}`);
          }
        }
      }

      if (scrapedContent.length > 200) {
        console.log(`[Context Hub] Scraped ${scrapedContent.length} chars from ${aboutPaths.length + 1} pages (base: ${workingBaseUrl})`);
      } else {
        console.log(`[Context Hub] Scraping returned minimal content — Claude will rely on Sonar context`);
      }
    } catch(e) {
      console.log(`[Context Hub] Scraper error (non-fatal):`, e.message);
    }

    const scraperSuccess = scrapedContent.length > 200;
    const siteContentSection = scraperSuccess
      ? `\n\nACTUAL WEBSITE CONTENT (scraped — use this as primary source, do NOT guess from domain name):\n${scrapedContent.slice(0, 8000)}`
      : '';
    if (!scraperSuccess) console.warn(`[Context Hub] ⚠️ SCRAPER FAILED for ${brandUrl} — Claude will guess from domain name + Sonar context only`);

    // ── Tool 2: Claude — Brand Intelligence Profile ───────────────────────────
    console.log(`[Context Hub] Tool 2: Claude brand analysis...`);

    const competitorSection = sonarCompetitors.length ? `\nCompetitor URLs (auto-discovered): ${sonarCompetitors.join(', ')}` : '';
    const icpSection = sonarICP ? `\nICP context (auto-discovered): ${sonarICP}` : '';
    const marketSection = sonarContext ? `\nMarket context: ${sonarContext}` : '';
    const audienceSection = audienceNotes ? `\nAdditional audience context: ${audienceNotes}` : '';
    const strategicSection = strategicNotes ? `\nAdditional strategic context: ${strategicNotes}` : '';

    // ── Inject Stage 8 patterns from prior runs if this brand has been analyzed before ──
    let patternSection = '';
    let mistakeSection = '';
    try {
      const existingBrand = await pool.query(
        'SELECT id FROM brand_profiles WHERE brand_url = $1 ORDER BY version DESC LIMIT 1',
        [brandUrl]
      );
      if (existingBrand.rows.length) {
        const existingId = existingBrand.rows[0].id;
        const [priorPatterns, priorMistakes] = await Promise.all([
          pool.query('SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 5', [existingId]),
          pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 3', [existingId])
        ]);
        if (priorPatterns.rows.length) {
          patternSection = '\n\nPRIOR PERFORMANCE PATTERNS (from published content analytics — reinforce these in your analysis):\n' +
            priorPatterns.rows.map(p => `- [${p.pattern_type}] ${p.description} (${Math.round((p.confidence_score||0)*100)}% confidence)`).join('\n');
        }
        if (priorMistakes.rows.length) {
          mistakeSection = '\n\nCONTENT MISTAKES TO AVOID (from underperforming published content):\n' +
            priorMistakes.rows.map(m => `- [${m.severity?.toUpperCase()} severity] ${m.mistake_type}: ${m.description}`).join('\n');
        }
      }
    } catch(e) { console.log('[Context Hub] No prior patterns:', e.message); }

    const prompt = `You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

Analyze the brand at: ${brandUrl}${siteContentSection}${competitorSection}${icpSection}${marketSection}${audienceSection}${strategicSection}${patternSection}${mistakeSection}

Return ONLY valid JSON (no markdown, no explanation, no newlines inside string values — use spaces instead):
{
  "brandName": "string — the brand's actual display name as it appears on the website (e.g. 'Rose + Thyme', not 'therosethyme' or 'Therosethyme')",
  "voiceProfile": {
    "summary": "string",
    "toneAttributes": [{ "attribute": "string", "score": 0-100, "description": "string" }],
    "writingStyle": "string",
    "keyPhrases": ["string"],
    "industry": "string — e.g. \'B2B SaaS\', \'Fintech\', \'Healthcare IT\', \'Manufacturing\'",
    "positioning": "string — one tight sentence: what they do, for whom, and why they win",
    "targetPersona": "string — primary buyer in plain language, e.g. \'VP of Marketing at mid-market SaaS\'",
    "visualStyle": "string — inferred from site aesthetic, e.g. \'dark editorial minimal\', \'bright human photography\', \'technical precision grids\', \'warm organic textures\'",
    "accentColor": "string — dominant brand color as hex if detectable, otherwise descriptor e.g. \'#3563FF\' or \'deep indigo\'"
  },
  "personas": [{
    "id": "string", "name": "string", "role": "string",
    "painPoints": ["string"], "triggers": ["string"],
    "skepticism": "string", "motivations": ["string"]
  }],
  "thirdPartySignals": [{ "source": "string", "signalType": "string", "value": "string or null", "confidence": 0-100, "lastChecked": "ISO8601" }],
  "competitiveGaps": [{ "topic": "string", "ownedBy": "string or null", "whitespaceOpportunity": "string", "priority": "high|medium|low" }],
  "strategicRecommendations": [{ "id": "string", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }],
  "businessProfile": {
    "whatTheyDo": "string — plain-language description of the core business, e.g. 'Designs and sells vegan skincare products direct to consumer' or 'Provides experiential marketing services for premium consumer brands'",
    "productsOrServices": ["string — specific offerings, e.g. 'Brand activations', 'Event production', 'AI-powered content platform', 'Rose hip face serum'"],
    "revenueModel": "string — how they make money, e.g. 'Project-based creative services', 'Monthly SaaS subscription', 'DTC e-commerce', 'Retainer + project fees'",
    "targetBuyer": "string — who writes the check, e.g. 'CMO at premium consumer brands', 'Individual skincare consumers age 25-45', 'VP Marketing at mid-market B2B'",
    "companyScale": "string — rough size indicator, e.g. 'Boutique agency (<50 people)', 'Enterprise ($50B+ revenue)', 'Early-stage startup', 'Mid-market SaaS'",
    "geography": "string — where they operate, e.g. 'NYC-based, US clients', 'Global', 'Portland OR, primarily US west coast'"
  },
  "discoveredCompetitors": ["string"],
  "marketCategory": "string"
}
Requirements: 5 toneAttributes, 2-3 personas, 4-6 thirdPartySignals, 3-5 competitiveGaps, 4-6 strategicRecommendations, 1 businessProfile (all fields required). Use the ICP and market context provided to make personas and gaps highly specific. For visualStyle and accentColor: infer carefully from the brand website design, color palette, imagery, and overall aesthetic — these feed directly into AI hero image generation and must reflect the real brand identity. For industry, positioning, and targetPersona: be specific and commercially precise, not generic.`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    });

    let profileData;
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = attempt === 0 ? message : await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = msg.content[0].text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { if (attempt === 1) throw new Error('Claude returned no valid JSON'); continue; }
      try {
        profileData = safeParseLLM(jsonMatch[0], 'object', 'context-hub');
        break;
      } catch(parseErr) {
        try {
          const fixed = jsonMatch[0].replace(/:\s*"([\s\S]*?)"/g, (m, val) => ': "' + val.replace(/\n/g, ' ').replace(/\r/g, ' ') + '"');
          profileData = JSON.parse(fixed);
          break;
        } catch(fixErr) {
          if (attempt === 0) {
            console.log('[Context Hub] JSON parse failed, retrying Claude call...');
            continue;
          }
          throw fixErr;
        }
      }
    }

    // Inject discovered competitors into profile
    profileData.discoveredCompetitors = sonarCompetitors;

    const latencyMs = Date.now() - startTime;
    console.log(`[Context Hub] Complete — ${brandName} | Latency: ${latencyMs}ms | Competitors found: ${sonarCompetitors.length}`);

    profileData.scraperSuccess = scraperSuccess;

    if (saveToBrain) {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const resolvedBrandName = (profileData.brandName && !uuidPattern.test(profileData.brandName))
        ? profileData.brandName : brandName;

      // Check if brand already exists — UPDATE in place to preserve UUID and all content references
      const existing = await pool.query(
        `SELECT id, version FROM brand_profiles WHERE brand_url = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );

      let r;
      if (existing.rows.length > 0) {
        // UPDATE existing — preserves UUID, content tables, queue, analytics, brain data
        const ex = existing.rows[0];
        const updated = await pool.query(
          `UPDATE brand_profiles SET profile_data = $1, brand_name = $2, version = $3, cache_status = 'fresh', updated_at = NOW()
           WHERE id = $4 RETURNING *`,
          [JSON.stringify(profileData), resolvedBrandName, ex.version + 1, ex.id]
        );
        r = updated.rows[0];
        console.log(`[Context Hub] Updated existing brand ${r.id} to v${r.version}`);
      } else {
        // INSERT new — first-time analysis for this URL
        const versionResult = await pool.query(
          `SELECT COALESCE(MAX(version), 0) as max_v FROM brand_profiles WHERE brand_url = $1`, [brandUrl]
        );
        const nextVersion = versionResult.rows[0].max_v + 1;
        const id = randomUUID();
        const sessionId = req.body.sessionId || null;
        const expiresAt = req.userId ? null : "NOW() + INTERVAL '24 hours'";
        const inserted = await pool.query(
          `INSERT INTO brand_profiles (id, brand_url, brand_name, version, is_active, cache_status, profile_data, clerk_user_id, onboard_session_id, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, true, 'fresh', $5, $6, $7, ${expiresAt ? expiresAt : 'NULL'}, NOW(), NOW())
           ON CONFLICT (brand_url) WHERE is_active = true
           DO UPDATE SET profile_data = $5, brand_name = $3, version = brand_profiles.version + 1, cache_status = 'fresh', updated_at = NOW()
           RETURNING *`,
          [id, brandUrl, resolvedBrandName, nextVersion, JSON.stringify(profileData), req.userId || null, sessionId]
        );
        r = inserted.rows[0];
        console.log(`[Context Hub] Created/merged brand ${r.id} v${r.version}`);
      }

      return res.json({ success: true, cached: false, data: {
        id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
        version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
        latencyMs, discoveredCompetitors: sonarCompetitors,
        createdAt: r.created_at, updatedAt: r.updated_at, ...profileData
      }});

    }
    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage1_context_agent', brandProfileId||null, 'success', (usage?.input_tokens||0)+(usage?.output_tokens||0), Date.now()-startTime]).catch(()=>{});
        res.json({ success: true, cached: false, data: {
      id: randomUUID(), brandUrl, brandName,
      version: 1, isActive: false, cacheStatus: 'fresh',
      latencyMs, discoveredCompetitors: sonarCompetitors, scraperSuccess,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...profileData
    }});

  } catch (err) {
    console.error('[Context Hub] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// GET /api/context-hub/brand/:brandId — fetch brand profile by ID (unauthenticated, for URL-based recovery)
app.get('/api/context-hub/brand/:brandId', async (req, res) => {
  const { brandId } = req.params;
  try {
    const r = await pool.query(
      `SELECT * FROM brand_profiles WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
      [brandId]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Brand not found or expired' });
    const row = r.rows[0];
    res.json({ success: true, data: {
      id: row.id, brandUrl: row.brand_url, brandName: row.brand_name,
      version: row.version, isActive: row.is_active, cacheStatus: row.cache_status,
      expiresAt: row.expires_at, createdAt: row.created_at, isPaid: !!row.clerk_user_id,
      ...row.profile_data
    }});
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── Email Campaign Tables ──────────────────────────────────────────────────
// Created in initDB — see payment_events block above

// ── Stage 4.6 — Email Campaign Generator ──────────────────────────────────

// POST /api/email-campaign/create — save brief + create campaign record
app.post('/api/email-campaign/create', requireAuth, async (req, res) => {
  const { brandProfileId, brief } = req.body;
  if (!brandProfileId || !brief) return res.status(400).json({ error: 'brandProfileId and brief required' });

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      brand_profile_id TEXT NOT NULL,
      brief JSONB NOT NULL,
      status VARCHAR(30) DEFAULT 'pending',
      sequence_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});

    await pool.query(`CREATE TABLE IF NOT EXISTS email_campaign_emails (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      campaign_id TEXT NOT NULL,
      email_index INTEGER NOT NULL,
      job TEXT,
      send_day INTEGER DEFAULT 0,
      subject_lines JSONB,
      preview_text TEXT,
      body TEXT,
      cta_text TEXT,
      cta_url_placeholder TEXT,
      ps TEXT,
      confidence_score INTEGER,
      confidence_reason TEXT,
      flags JSONB DEFAULT '[]',
      status VARCHAR(30) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});

    const result = await pool.query(
      `INSERT INTO email_campaigns (brand_profile_id, brief, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [brandProfileId, JSON.stringify(brief)]
    );
    const campaignId = result.rows[0].id;
    res.json({ success: true, campaignId });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/list/:brandProfileId — list saved campaigns
app.get('/api/email-campaign/list/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, brief, status, sequence_notes, created_at FROM email_campaigns WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.brandProfileId]
    );
    res.json({ success: true, campaigns: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/:id — get campaign + emails
app.get('/api/email-campaign/:id', requireAuth, async (req, res) => {
  try {
    const [camp, emails] = await Promise.all([
      pool.query(`SELECT * FROM email_campaigns WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT * FROM email_campaign_emails WHERE campaign_id = $1 ORDER BY email_index`, [req.params.id])
    ]);
    if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, campaign: camp.rows[0], emails: emails.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/generate/:id — SSE — generate all emails sequentially
app.get('/api/email-campaign/generate/:id', requireAuth, async (req, res) => {
  // Duplicate stream guard
  const streamKey = `${req.params.id}:email-campaign`;
  if (activeStreams.has(streamKey)) {
    const existing = activeStreams.get(streamKey);
    const elapsed = Math.floor((Date.now() - existing.startedAt) / 1000);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`event: busy\ndata: ${JSON.stringify({ message: 'Email campaign generation already in progress', elapsed })}\n\n`);
    return res.end();
  }
  activeStreams.set(streamKey, { startedAt: Date.now(), userId: req.userId });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(keepalive); activeStreams.delete(streamKey); });

  try {
    const campRes = await pool.query(`SELECT * FROM email_campaigns WHERE id = $1`, [req.params.id]);
    if (!campRes.rows.length) { send('error', { message: 'Campaign not found' }); return res.end(); }
    const campaign = campRes.rows[0];
    const brief = campaign.brief;

    const profileRes = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [campaign.brand_profile_id]);
    if (!profileRes.rows.length) { send('error', { message: 'Brand profile not found' }); return res.end(); }
    const profileData = profileRes.rows[0].profile_data || profileRes.rows[0];

    const [patternsRes, mistakesRes] = await Promise.all([
      pool.query(`SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 6`, [campaign.brand_profile_id]).catch(() => ({ rows: [] })),
      pool.query(`SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 5`, [campaign.brand_profile_id]).catch(() => ({ rows: [] }))
    ]);

    const systemPrompt = fs.readFileSync(
      path.join(__dirname, 'src/agents/stage46_email_campaign/system_prompt.md'), 'utf8'
    );

    const trimTo = (obj, max = 3000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
      return s.length > max ? s.substring(0, max) + '...[truncated]' : s;
    };

    const numEmails = brief.num_emails || 5;
    const userPrompt = `Generate a ${numEmails}-email ${brief.campaign_type || 'nurture'} sequence using the following brief and brand brain.

CAMPAIGN BRIEF:
- Business Problem: ${brief.business_problem}
- SMART Goal: ${brief.smart_goal}
- Single-Minded Proposition: ${brief.smp}
- UVP: ${brief.uvp}
- Pain Point Being Solved: ${brief.pain_point}
- Target Persona: ${brief.target_persona}
- Current Mindset: ${brief.current_mindset}
- Desired Mindset After Reading: ${brief.desired_mindset}
- Direct Competitor: ${brief.competitor || 'Not specified'}
- Mandatories: ${brief.mandatories || 'None'}

BRAND VOICE PROFILE:
${trimTo(profileData?.voiceProfile || profileData?.voice_profile || {}, 2000)}

PERSONAS:
${trimTo(profileData?.personas || [], 1500)}

BRAIN PATTERNS (what has worked — lean into these):
${patternsRes.rows.map(p => `- [${p.pattern_type}] ${p.description}`).join('\n') || 'None yet'}

BRAIN MISTAKES (what has failed — avoid unconditionally):
${mistakesRes.rows.map(m => `- [${m.severity}] ${m.mistake_type}: ${m.description}`).join('\n') || 'None yet'}

Generate exactly ${numEmails} emails. Return ONLY valid JSON matching the output format.`;

    await pool.query(`UPDATE email_campaigns SET status = 'generating', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    send('status', { message: 'Brain loaded. Generating sequence...' });

    // ── Mistral Large for email — optimized for lead-gen focused writing ──
    const mistralEmailRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        max_tokens: 8000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });
    if (!mistralEmailRes.ok) {
      const errBody = await mistralEmailRes.text();
      throw new Error(`Mistral API ${mistralEmailRes.status}: ${errBody.slice(0, 300)}`);
    }
    const mistralEmailData = await mistralEmailRes.json();
    const raw = mistralEmailData.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = safeParseLLM(jsonMatch ? jsonMatch[0] : raw, 'object', 'email-campaign');
    } catch(e) {
      // Fallback: strip newlines inside strings
      const fixed = (jsonMatch ? jsonMatch[0] : raw).replace(/:\s*"([\s\S]*?)"/g, (m, val) => ': "' + val.replace(/\n/g, ' ').replace(/\r/g, ' ') + '"');
      parsed = JSON.parse(fixed);
    }

    // Save campaign-level metadata
    await pool.query(
      `UPDATE email_campaigns SET status = 'complete', sequence_notes = $1, updated_at = NOW() WHERE id = $2`,
      [parsed.sequence_notes || '', req.params.id]
    );

    // Save each email
    for (const email of parsed.emails || []) {
      await pool.query(
        `INSERT INTO email_campaign_emails (campaign_id, email_index, job, send_day, subject_lines, preview_text, body, cta_text, cta_url_placeholder, ps, confidence_score, confidence_reason, flags, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'complete')
         ON CONFLICT DO NOTHING`,
        [
          req.params.id, email.index, email.job || '', email.send_day || 0,
          JSON.stringify(email.subject_lines || {}), email.preview_text || '',
          email.body || '', email.cta_text || '', email.cta_url_placeholder || '{{cta_url}}',
          email.ps || null, email.confidence_score || 80, email.confidence_reason || '',
          JSON.stringify(email.flags || [])
        ]
      ).catch(() => {});
      send('email', { index: email.index, job: email.job, confidence_score: email.confidence_score, flags: email.flags || [] });
    }

    send('complete', { campaignId: req.params.id, emailCount: parsed.emails?.length || 0, sequenceNotes: parsed.sequence_notes });
    clearInterval(keepalive);
    res.end();
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] Generate error:', err.message);
    send('error', { message: err.message });
    clearInterval(keepalive);
    res.end();
  }
});

// POST /api/email-campaign/push-to-hubspot — push email sequence to HubSpot as draft campaign
app.post('/api/email-campaign/push-to-hubspot', requireAuth, async (req, res) => {
  const { brandProfileId, campaignId } = req.body;
  if (!brandProfileId || !campaignId) return res.status(400).json({ error: 'brandProfileId and campaignId required' });

  try {
    const accessToken = await refreshHubSpotToken(brandProfileId);

    const [camp, emails] = await Promise.all([
      pool.query(`SELECT * FROM email_campaigns WHERE id = $1`, [campaignId]),
      pool.query(`SELECT * FROM email_campaign_emails WHERE campaign_id = $1 ORDER BY email_index`, [campaignId])
    ]);
    if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const brief = camp.rows[0].brief;
    const campaignName = `${brief.smp || 'Email Campaign'} — ${new Date().toLocaleDateString()}`;

    // Create a HubSpot campaign object to group the emails
    const hsRes = await fetch('https://api.hubapi.com/marketing/v3/campaigns', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: campaignName, startDate: new Date().toISOString() })
    }).catch(() => null);

    const hsCampaign = hsRes?.ok ? await hsRes.json() : null;
    const hsCampaignId = hsCampaign?.id || null;

    // Push each email as a draft marketing email in HubSpot
    const results = [];
    for (const email of emails.rows) {
      const subjects = email.subject_lines || {};
      const primarySubject = subjects.benefit || subjects.curiosity || 'New Email';
      const emailRes = await fetch('https://api.hubapi.com/marketing/v3/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `[${email.email_index}] ${primarySubject}`,
          subject: primarySubject,
          previewText: email.preview_text || '',
          content: { body: (email.body || '').replace(/\n/g, '<br>') },
          state: 'DRAFT',
          campaign: hsCampaignId ? { id: hsCampaignId } : undefined
        })
      }).catch(() => null);

      if (emailRes?.ok) {
        const hsEmail = await emailRes.json();
        results.push({ index: email.email_index, hsEmailId: hsEmail.id, status: 'pushed' });
      } else {
        const errBody = emailRes ? await emailRes.text().catch(() => 'no body') : 'fetch failed';
        console.error(`[EMAIL CAMPAIGN] HubSpot email push failed for #${email.email_index}: ${emailRes?.status} ${errBody}`);
        results.push({ index: email.email_index, status: 'failed', error: `HubSpot ${emailRes?.status || 'network error'}: ${errBody.slice(0, 200)}` });
      }
    }

    res.json({ success: true, hsCampaignId, results, campaignName });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] HubSpot push error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-campaign/save-brief-template — save reusable brief
app.post('/api/email-campaign/save-brief-template', requireAuth, async (req, res) => {
  const { brandProfileId, name, brief } = req.body;
  if (!brandProfileId || !name || !brief) return res.status(400).json({ error: 'brandProfileId, name, and brief required' });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS email_brief_templates (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      brand_profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brief JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    const result = await pool.query(
      `INSERT INTO email_brief_templates (brand_profile_id, name, brief) VALUES ($1, $2, $3) RETURNING id`,
      [brandProfileId, name, JSON.stringify(brief)]
    );
    res.json({ success: true, templateId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-campaign/brief-templates/:brandProfileId
app.get('/api/email-campaign/brief-templates/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, brief, created_at FROM email_brief_templates WHERE brand_profile_id = $1 ORDER BY created_at DESC`,
      [req.params.brandProfileId]
    ).catch(() => ({ rows: [] }));
    res.json({ success: true, templates: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GEO data normalizer — shared by fresh + cached responses ─────────────────
function normalizeGeoData(briefData, topicalMap, geoOpportunities, entitySchema, profile) {
  const gaps = (topicalMap && topicalMap.gapsByCluster) || [];
  if (gaps.length > 0) console.log('[GEO] normalizer gaps[0] RAW:', JSON.stringify(gaps[0]));
  const topicalAuthorityMap = gaps.map(g => {
    const score = g.geoCitationScore || g.citationProbability || g.score || g.geoScore || g.probability || 0;
    return {
      topic: g.topic || g.cluster || g.name || g.title || 'Unknown',
      coverage: g.rationale || g.description || g.reason || g.owner || g.gap || '',
      citationProbability: score,
      priority: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
    };
  });

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
// ── Strip LLM scaffolding artifacts from article section bodies ──────────────
// Enrichment briefs give the writer bracketed placeholders like "[SME Hook: ...]",
// "[CTA: ...]", "[Author Quote: ...]" that the model is supposed to expand into
// prose or drop. It sometimes copies them verbatim, and they leak past human
// compliance review. This is the final safety net — called at every article
// write path (content-gen, campaign, compliance approve, content-import).
function stripScaffoldingArtifacts(article) {
  if (!article || typeof article !== 'object' || !Array.isArray(article.sections)) return article;

  // Inline: keyword-gated bracketed instructions (safe — won't nuke legit refs like [1] or [Appendix A])
  const INLINE_RX = /\[(?:SME[\s-]?Hook|Author[\s-]?(?:Quote|Citation|Bio)|Writer[\s-]?Note|(?:Note|Editor[\s-]?Note)[\s-]?to[\s-]?(?:writer|editor|self)?|Insert|TODO|Placeholder|NEEDS[\s-]?CITATION|CITATION|SOURCE|CTA|Pull[\s-]?Quote|Hook|Quote|Link|Image|Tip|Callout|Stat|Fact[\s-]?Check)\s*[:\s][^\]]*\]/gi;
  // Standalone paragraph: entire paragraph is just a bracketed instruction with a colon
  // (e.g. "[Something: details]" alone on its own line — the scaffolding signature)
  const STANDALONE_COLON_BRACKET_RX = /^\s*\[[^\]]*:[^\]]*\]\s*$/;

  const cleanBody = (text) => {
    if (!text || typeof text !== 'string') return text;
    const parts = text.split(/\n\s*\n/);
    const filtered = parts
      .map(p => p.replace(INLINE_RX, '').replace(/[ \t]{2,}/g, ' ').trim())
      .filter(p => p && !STANDALONE_COLON_BRACKET_RX.test(p));
    return filtered.join('\n\n').trim();
  };

  article.sections = article.sections.map(s => {
    const updated = { ...s };
    if (typeof s.body === 'string') updated.body = cleanBody(s.body);
    if (typeof s.content === 'string') updated.content = cleanBody(s.content);
    return updated;
  });
  return article;
}

function extractJSON(text, type = 'object') {
  const open = type === 'array' ? '[' : '{';
  const close = type === 'array' ? ']' : '}';
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // JSON was truncated (hit token limit) — attempt recovery by closing open structures
  if (depth > 0) {
    let partial = text.slice(start).trimEnd();
    // Remove any trailing incomplete string or value
    partial = partial.replace(/,\s*$/, '').replace(/"[^"]*$/, '"truncated"');
    // Close all open braces/brackets
    const stack = [];
    for (const ch of partial) {
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    partial += stack.reverse().join('');
    try { JSON.parse(partial); return partial; } catch(e) { /* unrecoverable */ }
  }
  return null;
}

// Not a library. Not an npm package. Just a dev who got tired of Claude's newlines.
// ── Shared LLM JSON parser — sanitise + recover ──────────────────────────────
function safeParseLLM(raw, type = 'object', caller = 'unknown') {
  const stripped = raw
    .replace(/```(?:json)?\s*/g, '')
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060\u00A0]/g, '')
    .trim();
  const extracted = extractJSON(stripped, type) || stripped;
  // Step 2: fast path
  try { return JSON.parse(extracted); } catch(_) {}
  // Step 3: control chars + trailing commas
  try {
    const sanitized = extracted
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
      .replace(/(?<!\\)\n(?=(?:[^"]*"[^"]*")*[^"]*"[^"]*$)/g, '\\n')
      .replace(/,\s*([\]\}])/g, '$1');
    const result = JSON.parse(sanitized);
    console.warn('[safeParseLLM] Step 3 recovery (' + caller + ') control chars/trailing commas');
    return result;
  } catch(_) {}
  // Step 4: brute-force
  try {
    const brute = extracted
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f]/g, ' ')
      .replace(/,\s*([\]\}])/g, '$1')
      .replace(/("\s*)(\n\s*")/g, '$1,$2')
      .replace(/(\}\s*)(\{)/g, '$1,$2')
      .replace(/("\s*)(\{)/g, '$1,$2')
      .replace(/(\}\s*)(")/g, '$1,$2')
      .replace(/([\]\}])\s*([\[\{])/g, '$1,$2')
      .replace(/(")\s*(")/g, '$1,$2');
    const result = JSON.parse(brute);
    console.warn('[safeParseLLM] Step 4 recovery (' + caller + ') brute-force escape');
    return result;
  } catch(_) {}
  // Step 5: nuclear
  try {
    const open = type === 'array' ? '[' : '{';
    const close = type === 'array' ? ']' : '}';
    const first = stripped.indexOf(open);
    const last = stripped.lastIndexOf(close);
    if (first !== -1 && last > first) {
      const sliced = stripped.slice(first, last + 1)
        .replace(/[\x00-\x1f]/g, ' ')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t')
        .replace(/,\s*([\]\}])/g, '$1');
      const result = JSON.parse(sliced);
      console.warn('[safeParseLLM] NUCLEAR Step 5 recovery (' + caller + ') prompt is broken. First 80: ' + stripped.slice(0, 80).replace(/\n/g, ' '));
      return result;
    }
  } catch(_) {}
  console.error('[safeParseLLM] TOTAL FAILURE (' + caller + ') First 300:', stripped.slice(0, 300));
  throw new Error('LLM JSON parse failed after recovery');
}

app.get('/api/geo-strategist/briefs', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.query;
    const query = brandProfileId
      ? `SELECT id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data, brain_version, created_at, updated_at
         FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY updated_at DESC`
      : `SELECT id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data, brain_version, created_at, updated_at
         FROM geo_briefs ORDER BY updated_at DESC`;
    const result = brandProfileId
      ? await pool.query(query, [brandProfileId])
      : await pool.query(query);
    // Get current brain version for staleness comparison
    let currentBrainVersion = 1;
    if (brandProfileId) {
      const bpRes = await pool.query('SELECT version FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (bpRes.rows.length) currentBrainVersion = bpRes.rows[0].version || 1;
    }
    const data = result.rows.map(r => ({
      id: r.id, brandProfileId: r.brand_profile_id,
      brandUrl: r.brand_url, brandName: r.brand_name,
      version: r.version, opportunityScore: r.opportunity_score,
      brainVersion: r.brain_version || 1, currentBrainVersion,
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

app.post('/api/geo-strategist/analyze', requireAuth, async (req, res) => {
  const { brandProfileId, topicFocus = '', additionalContext = '' } = req.body;
  if (!brandProfileId) {
    return res.status(400).json({ success: false, error: 'brandProfileId is required' });
  }

  const startTime = Date.now();

  try {
    // ── Step 0: Brain-First Protocol ─────────────────────────────────────────
    let brainPatterns = [], brainMistakes = [];
    try {
      const [pRes, mRes] = await Promise.all([
        pool.query(`SELECT pattern_type, description, success_rate, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY success_rate DESC LIMIT 10`, [brandProfileId]),
        pool.query(`SELECT mistake_type, description, human_feedback, guardrail_created, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 10`, [brandProfileId]),
      ]);
      brainPatterns = pRes.rows;
      brainMistakes = mRes.rows;
    } catch(e) {
      console.log('[GEO] Brain tables not seeded — proceeding cold:', e.message);
    }

    const brainContext = `BRAIN PATTERNS (what worked for this brand): ${JSON.stringify(brainPatterns)}
BRAIN MISTAKES (DO NOT repeat for this brand): ${JSON.stringify(brainMistakes)}`;

    // ── Step 1: Load Stage 1 brand profile ───────────────────────────────────
    const profileResult = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]);
    if (!profileResult.rows.length) {
      return res.status(404).json({ success: false, error: 'Brand profile not found. Run Stage 1 first.' });
    }
    const profile = profileResult.rows[0];
    const pd = profile.profile_data || {};

    // ── Cache check ──────────────────────────────────────────────────────────
    const forceRefresh = req.body.force === true;
    if (!topicFocus && !additionalContext && !forceRefresh) {
      const existing = await pool.query(
        `SELECT * FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`, [brandProfileId]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const bd = r.brief_data || {};
        const cachedTopical = bd.topicalAuthorityMap || [];
        const cachedGeo = bd.geoOpportunitiesNorm || [];
        const topicalIsReal = cachedTopical.length > 0 && cachedTopical.some(t => t.topic && t.topic !== 'Unknown' && t.citationProbability > 0);
        const geoIsReal = cachedGeo.length > 0 && cachedGeo.some(g => g.topic && (g.chatgpt > 0 || g.perplexity > 0));
        if (!topicalIsReal || !geoIsReal) {
          console.log('[GEO] Cache stale — topical or geo has bad data, forcing fresh run');
          // fall through to fresh analysis
        } else if ((r.brain_version || 1) < (profile.version || 1)) {
          console.log(`[GEO] Cache stale — built on brain v${r.brain_version || 1}, current is v${profile.version || 1}, forcing fresh run`);
          // fall through to fresh analysis
        } else {
          const normalized = { topicalAuthorityMap: cachedTopical, geoOpportunities: cachedGeo, entitySchemaMap: bd.entitySchemaMap, geoBrief: bd.geoBrief };
          return res.json({ success: true, cached: true, data: {
            id: r.id, brandProfileId: r.brand_profile_id,
            brandUrl: r.brand_url, brandName: r.brand_name,
            version: r.version, opportunityScore: r.opportunity_score,
            brainVersion: r.brain_version || 1, currentBrainVersion: profile.version || 1,
            createdAt: r.created_at, updatedAt: r.updated_at,
            ...normalized
          }});
        }
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
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `You are the Topical Authority Mapper for Forge Intelligence GEO Strategist.

BRAND: ${profile.brand_name} (${profile.brand_url})
PERSONAS: ${JSON.stringify(personas).slice(0, 400)}
COMPETITOR TOPICS: ${JSON.stringify(competitorTopics).slice(0, 400)}
WHITESPACE: ${whitespace.slice(0, 300)}
${topicFocus ? 'FOCUS: ' + topicFocus : ''}

Identify 8-12 topical gaps where this brand has low AI citation probability vs competitors.

YOU MUST return a raw JSON array using EXACTLY these field names: topic, geoCitationScore, owner, rationale.
Example:
[{"topic":"AI PC and Edge Inference","geoCitationScore":85,"owner":"NVIDIA","rationale":"NVIDIA dominates this topic across AI platforms"},{"topic":"Open Ecosystem Software","geoCitationScore":72,"owner":null,"rationale":"Unclaimed whitespace with high intent"}]

Return ONLY the raw JSON array. No markdown. No backticks. No explanation. No other keys.` }]
    });
    let topicalMap = { gapsByCluster: [] };
    try {
      // Tool 1 returns a flat array
      const tm = extractJSON(topicalRes.content[0].text, 'array');
      if (!tm) throw new Error('No JSON array found in Tool 1 response');
      const gaps = JSON.parse(tm);
      topicalMap = { gapsByCluster: gaps, brandClusters: [], competitorClusters: [] };
    } catch(e) { console.log('[GEO] Tool 1 parse warn:', e.message, '| raw:', topicalRes.content[0].text.slice(0,200)); }
    console.log(`[GEO] Tool 1 gaps: ${topicalMap.gapsByCluster.length}`);
    if (topicalMap.gapsByCluster.length > 0) console.log("[GEO] Tool 1 sample:", JSON.stringify(topicalMap.gapsByCluster.slice(0,2)));

    // ── Tool 2: GEO Opportunity Scorer ────────────────────────────────────────
    console.log('[GEO] Tool 2: GEO Opportunity Scorer...');
    const scorerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: `You are the GEO Opportunity Scorer for Forge Intelligence.

BRAND: ${profile.brand_name} (${profile.brand_url})
TOPICAL GAPS: ${JSON.stringify(
  (topicalMap.gapsByCluster || [])
    .map(g => ({ ...g, _score: g.geoCitationScore || g.citationProbability || g.score || g.geoScore || g.probability || 0 }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 10)
    .map(({ _score, ...rest }) => rest)
)}
WHITESPACE: ${whitespace.slice(0, 300)}

For each topic gap, score citation probability 0-100 across all 4 AI platforms. quickWin=true if score >= 70 and low brand presence.

Return ONLY a raw JSON array (no markdown, no explanation):
[{"platform":"ChatGPT","topic":"string","score":80,"quickWin":true},{"platform":"Perplexity","topic":"string","score":70,"quickWin":false},{"platform":"Google AI Overviews","topic":"string","score":65,"quickWin":false},{"platform":"Gemini","topic":"string","score":60,"quickWin":false}]` }]
    });
    let geoOpportunities = [];
    try {
      const go = extractJSON(scorerRes.content[0].text, 'array');
      if (!go) throw new Error('No JSON array found in Tool 2 response');
      geoOpportunities = JSON.parse(go);
    } catch(e) { console.log('[GEO] Tool 2 parse warn:', e.message, '| raw:', scorerRes.content[0].text.slice(0,200)); }
    console.log(`[GEO] Tool 2 opportunities: ${(geoOpportunities||[]).length}`);

    // ── Tool 3: Entity & Schema Mapper ────────────────────────────────────────
    console.log('[GEO] Tool 3: Entity & Schema Mapper...');
    const entityRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
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

    // ── NEW ARCHITECTURE: No auto-brief. Persist opportunities for user cherry-picking. ──
    // Tool 4 (Brief Generator) moved to Stage 2.1 — runs ONLY on user-selected topics.
    // Why: burning tokens on 10 briefs when user may only want 2-3 was wasteful.
    // Unpicked opportunities stay in the table as brain food — "user did NOT pick this" is signal.
    console.log('[GEO] Persisting opportunities — no auto-brief (user cherry-picks in UI)...');
    const quickWins = geoOpportunities.filter(o => o.quickWin).slice(0, 3);

    // Generate a session ID that groups all opportunities from this GEO run
    const discoverySessionId = randomUUID();

    // Deduplicate opportunities by topic before persisting (input array often repeats topics per platform)
    const opportunitiesByTopic = new Map();
    for (const opp of geoOpportunities) {
      const key = (opp.topic || '').trim().toLowerCase();
      if (!key) continue;
      if (!opportunitiesByTopic.has(key)) {
        opportunitiesByTopic.set(key, { ...opp, platformScores: {} });
      }
      const existing = opportunitiesByTopic.get(key);
      // Merge platform-specific scores
      if (opp.platform && typeof opp.score === 'number') {
        const _p = opp.platform.toLowerCase().replace(/\s/g, '');
        const _key = _p.includes('overview') || _p.includes('google') ? 'aiOverviews'
          : _p.includes('chatgpt') || _p.includes('openai') ? 'chatgpt'
          : _p.includes('perplexity') ? 'perplexity'
          : _p.includes('gemini') ? 'gemini' : _p;
        existing.platformScores[_key] = opp.score;
      } else if (opp.chatgpt !== undefined || opp.perplexity !== undefined) {
        existing.platformScores = {
          chatgpt: opp.chatgpt, perplexity: opp.perplexity,
          aiOverviews: opp.aiOverviews, gemini: opp.gemini
        };
      }
    }

    // Persist each unique opportunity — link topical authority context for user decision-making
    const persistedOpportunities = [];
    for (const [topic, opp] of opportunitiesByTopic) {
      const platforms = opp.platformScores || {};
      const scores = Object.values(platforms).filter(v => typeof v === 'number');
      const avgScore = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length) : 0;
      // Find the topical authority writeup for this topic if available
      // topicalMap is an OBJECT like { gapsByCluster: [...] }, not an array
      const authorityGaps = (topicalMap && Array.isArray(topicalMap.gapsByCluster))
        ? topicalMap.gapsByCluster
        : (Array.isArray(topicalMap) ? topicalMap : []);
      const authorityWriteup = authorityGaps.find(t => {
        const tt = (t.topic || t.cluster || '').trim().toLowerCase();
        return tt === topic || topic.includes(tt) || tt.includes(topic);
      });
      const authorityContext = authorityWriteup ? JSON.stringify(authorityWriteup) : '';

      try {
        const insertRes = await pool.query(
          `INSERT INTO geo_opportunities (
            brand_profile_id, brain_version, topic, platform_scores, avg_score, quick_win,
            topical_authority_context, intent_signals, status, discovery_session_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'discovered', $9)
          RETURNING id`,
          [
            brandProfileId, profile.version || 1, opp.topic,
            JSON.stringify(platforms), avgScore.toFixed(2), !!opp.quickWin,
            authorityContext, JSON.stringify({ entities: entitySchema.filter(e => e.priority === 'high').slice(0, 5) }),
            discoverySessionId
          ]
        );
        persistedOpportunities.push({ ...opp, id: insertRes.rows[0].id, avgScore });
      } catch(e) {
        console.log('[GEO] opp persist warn:', e.message, '| topic:', topic);
      }
    }
    console.log(`[GEO] Persisted ${persistedOpportunities.length} opportunities in session ${discoverySessionId}`);

    // Build legacy brief shape for response compatibility — stub values, no real brief yet
    // The actual per-topic brief building happens in Stage 2.1 when user selects topics
    const briefData = {
      targetTopic: null,  // no auto-pick anymore
      executiveSummary: 'Topics surfaced. Select topics in the GEO Opportunities table to build briefs.',
      h1: null,
      h2s: [],
      entities: entitySchema.filter(e => e.priority === 'high').map(e => e.entity).slice(0, 10),
      faqStructure: [],
      geoAnchors: [],
      schemaRequirements: [],
      overallOpportunityScore: persistedOpportunities.length ? Math.round(Math.max(...persistedOpportunities.map(o => o.avgScore || 0))) : 0,
      targetPlatforms: [],
      contentCalendar: { month1: [], month2: [], month3: [] },
      quickWins: quickWins.map(q => ({ topic: q.topic, rationale: '', geoTarget: '' })),
      geoScorecard: {
        currentReadiness: persistedOpportunities.length ? Math.round(Math.max(...persistedOpportunities.map(o => o.avgScore || 0))) : 0,
        primaryGap: 'User selection pending',
        topOpportunity: quickWins[0]?.topic || persistedOpportunities[0]?.topic || ''
      },
      briefRationale: `${persistedOpportunities.length} opportunities discovered. Cherry-pick topics to build briefs.`,
      discoverySessionId,
      pendingUserSelection: true
    };

    // Legacy geo_briefs row kept as stub for backward-compat with older code paths
    // New architecture uses geo_opportunities + geo_topic_briefs instead.
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version), 0) as max_v FROM geo_briefs WHERE brand_profile_id = $1`, [brandProfileId]
    );
    const nextVersion = versionResult.rows[0].max_v + 1;
    const id = randomUUID();
    const { topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief } = normalizeGeoData(briefData, topicalMap, geoOpportunities, entitySchema, profile);
    const fullBriefData = { ...briefData, topicalMap, geoOpportunities, entitySchema, topicalAuthorityMap, geoOpportunitiesNorm, entitySchemaMap, geoBrief };
    const opportunityScore = briefData.overallOpportunityScore || 0;

    // Nuke stale GEO briefs — re-run means old data is superseded
    await pool.query('DELETE FROM geo_briefs WHERE brand_profile_id = $1', [brandProfileId]);

    await pool.query(
      `INSERT INTO geo_briefs (id, client_id, brand_profile_id, brand_url, brand_name, version, opportunity_score, brief_data, brain_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, null, brandProfileId, profile.brand_url, profile.brand_name, nextVersion, opportunityScore, JSON.stringify(fullBriefData), profile.version || 1]
    );

    const latencyMs = Date.now() - startTime;
    console.log(`[GEO] Complete — Score: ${opportunityScore} | Latency: ${latencyMs}ms | QuickWins: ${quickWins.length}`);

    console.log('[GEO] FINAL topicalAuthorityMap[0]:', JSON.stringify(topicalAuthorityMap[0]));
    console.log('[GEO] FINAL geoOpportunities[0]:', JSON.stringify(geoOpportunitiesNorm[0]));
    console.log('[GEO] FINAL counts — topical:', topicalAuthorityMap.length, 'geo:', geoOpportunitiesNorm.length);
    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage2_geo_strategist', brandProfileId, 'success', 0, latencyMs]).catch(e => console.error('[ACTIVITY LOG]', e.message));
            res.json({ success: true, cached: false, data: {
      id, brandProfileId, brandUrl: profile.brand_url, brandName: profile.brand_name,
      version: nextVersion, opportunityScore, latencyMs,
      brainVersion: profile.version || 1, currentBrainVersion: profile.version || 1,
      topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief
    }});

  } catch (err) {
    console.error('[GEO] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// ── Authenticity Enricher API (Stage 3) ──────────────────────────────────────

app.get('/api/authenticity-enricher/briefs', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.query;
    const query = brandProfileId
      ? `SELECT id, brand_profile_id, geo_brief_id, brand_url, brand_name, version,
                confidence_score, enriched_data, brain_version, created_at, updated_at
         FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY updated_at DESC`
      : `SELECT id, brand_profile_id, geo_brief_id, brand_url, brand_name, version,
                confidence_score, enriched_data, brain_version, created_at, updated_at
         FROM enriched_briefs ORDER BY updated_at DESC`;
    const result = brandProfileId
      ? await pool.query(query, [brandProfileId])
      : await pool.query(query);
    // Get current brain version for staleness comparison
    let currentBrainVersion = 1;
    if (brandProfileId) {
      const bpRes = await pool.query('SELECT version FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (bpRes.rows.length) currentBrainVersion = bpRes.rows[0].version || 1;
    }
    res.json({ success: true, data: result.rows.map(r => ({
      id: r.id, brandProfileId: r.brand_profile_id, geoBriefId: r.geo_brief_id,
      brandUrl: r.brand_url, brandName: r.brand_name, version: r.version,
      confidenceScore: r.confidence_score,
      brainVersion: r.brain_version || 1, currentBrainVersion,
      createdAt: r.created_at, updatedAt: r.updated_at,
      ...r.enriched_data
    }))});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Truncate long text at last sentence boundary within budget ──
// Prefers ending on a full sentence (. ! ?) rather than mid-word.
// Falls back to word boundary if no sentence break found in window.
function truncateAtSentence(text, maxChars) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxChars) return text.trim();
  const window = text.slice(0, maxChars);
  // Look for last sentence-ending punctuation followed by space/newline or at end
  const sentenceMatch = window.match(/^.*[.!?](?=\s|$)/s);
  if (sentenceMatch && sentenceMatch[0].length >= maxChars * 0.5) {
    return sentenceMatch[0].trim();
  }
  // Fallback: last complete word
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.5) return window.slice(0, lastSpace).trim() + '…';
  return window.trim() + '…';
}

app.post('/api/authenticity-enricher/analyze', requireAuth, async (req, res) => {
  const { brandProfileId, geoBriefId, topicBriefId, manualInputs = {}, force = false } = req.body;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId is required' });
  const startTime = Date.now();

  // SSE streaming for real-time progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, payload) => {
    try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {}
  };

  try {
    // ── Brain-First ──────────────────────────────────────────────────────────
    let brainPatterns = [], brainMistakes = [];
    try {
      const [pRes, mRes] = await Promise.all([
        pool.query(`SELECT pattern_type, description, success_rate, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY success_rate DESC LIMIT 10`, [brandProfileId]),
        pool.query(`SELECT mistake_type, description, human_feedback, guardrail_created FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 10`, [brandProfileId])
      ]);
      brainPatterns = pRes.rows;
      brainMistakes = mRes.rows;
    } catch(e) { console.log('[ENRICH] Brain cold:', e.message); }

    // ── Load brand profile ───────────────────────────────────────────────────
    const profileResult = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]);
    if (!profileResult.rows.length) { send('error', { error: 'Brand profile not found. Run Stage 1 first.' }); return res.end(); }
    const profile = profileResult.rows[0];
    const pd = profile.profile_data || {};

    // ── Load GEO brief — prefer new topic-specific brief if provided ─────────
    let geoBrief = null;
    if (topicBriefId) {
      // New cherry-pick architecture: brief was built for a specific user-selected topic
      const tbRes = await pool.query(
        `SELECT tb.*, opp.topic FROM geo_topic_briefs tb
         JOIN geo_opportunities opp ON opp.id = tb.opportunity_id
         WHERE tb.id = $1`,
        [topicBriefId]
      );
      if (tbRes.rows.length) {
        const tb = tbRes.rows[0];
        geoBrief = { ...tb.brief_data, briefId: tb.id, topic: tb.topic, brandName: profile.brand_name, isTopicBrief: true };
        console.log(`[ENRICH] Using topic-specific brief: "${tb.topic}"`);
      send('topic', { topic: tb.topic });
      } else {
        // Stale/invalid topicBriefId — don't silently fall through to wrong data
        console.log(`[ENRICH] Topic brief ${topicBriefId} not found — returning 404`);
        send('error', { error: 'Topic brief not found. It may have been deleted or expired.' }); return res.end();
      }
    } else if (geoBriefId) {
      // Legacy path: specific old-style GEO brief ID
      const gbRes = await pool.query(`SELECT * FROM geo_briefs WHERE id = $1`, [geoBriefId]);
      if (gbRes.rows.length) geoBrief = { ...gbRes.rows[0].brief_data, brandName: gbRes.rows[0].brand_name };
    } else {
      // Fallback: latest GEO brief for this brand
      const gbRes = await pool.query(
        `SELECT * FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`, [brandProfileId]
      );
      if (gbRes.rows.length) geoBrief = { ...gbRes.rows[0].brief_data, briefId: gbRes.rows[0].id, brandName: gbRes.rows[0].brand_name };
    }

    // ── Cache check ──────────────────────────────────────────────────────────
    // Skip cache when enriching a specific topic brief — different topics need different enrichments.
    // Only cache at the brand level for legacy (topic-less) enrichments.
    if (!force && !topicBriefId && !Object.keys(manualInputs).length) {
      const existing = await pool.query(
        `SELECT * FROM enriched_briefs WHERE brand_profile_id = $1 AND (enriched_data->>'topicBriefId') IS NULL ORDER BY version DESC LIMIT 1`, [brandProfileId]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const ed = r.enriched_data || {};
        // Only serve cache if ALL tools produced real data
        const hasEEAT = ed.eeatScores && Object.keys(ed.eeatScores).length > 0 &&
          Object.values(ed.eeatScores).some(s => s.score > 0);
        const hasInjections = ed.injectionMap && ed.injectionMap.length > 0 &&
          ed.injectionMap.some(i => i.suggestedContent && i.suggestedContent.length > 10);
        const hasBrief = ed.enrichedSections && ed.enrichedSections.length > 0;
        const isReal = hasEEAT && hasInjections && hasBrief;
        const brainStale = (r.brain_version || 1) < (profile.version || 1);
        if (brainStale) {
          console.log(`[ENRICH] Cache stale — built on brain v${r.brain_version || 1}, current is v${profile.version || 1}, forcing fresh run`);
        } else if (isReal) {
          console.log(`[ENRICH] Cache hit for ${r.brand_url} — eeat:${hasEEAT} injections:${hasInjections} brief:${hasBrief}`);
          send('result', { success: true, cached: true, data: {
            id: r.id, brandProfileId: r.brand_profile_id, geoBriefId: r.geo_brief_id,
            brandUrl: r.brand_url, brandName: r.brand_name, version: r.version,
            confidenceScore: r.confidence_score,
            brainVersion: r.brain_version || 1, currentBrainVersion: profile.version || 1,
            createdAt: r.created_at, updatedAt: r.updated_at,
            ...r.enriched_data
          }});
          return res.end();
        }
        console.log(`[ENRICH] Cache stale — eeat:${hasEEAT} injections:${hasInjections} brief:${hasBrief} — forcing fresh run`);
      }
    }

    const voiceProfile = pd.voiceProfile || {};
    const personas = pd.personas || [];
    const thirdPartySignals = pd.thirdPartySignals || [];
    const brandUrl = profile.brand_url;
    const brandName = profile.brand_name;

    // Build manual inputs context string
    const correctionsCtx = manualInputs.corrections
      ? `\nCRITICAL CORRECTIONS FROM BRAND OWNER (these OVERRIDE any AI-discovered data — do NOT include incorrect information):\n${manualInputs.corrections}`
      : '';
    const otherInputs = { ...manualInputs };
    delete otherInputs.corrections;
    const manualCtx = Object.keys(otherInputs).length
      ? `\nMANUAL INPUTS PROVIDED BY USER (treat as verified, high-confidence):\n${JSON.stringify(otherInputs, null, 2)}${correctionsCtx}`
      : correctionsCtx || '';

    // ── Tool 1: SME Signal Scraper ────────────────────────────────────────────
    send('progress', { stage: 1, label: 'SME Signal Scraper', detail: 'Scanning for named experts, awards, certifications...' });
    console.log('[ENRICH] Tool 1: SME Signal Scraper...');

    let sonarSignals = {};
    try {
      const sonarRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{
            role: 'user',
            content: `Research ${brandName} (${brandUrl}) and return ONLY valid JSON (no markdown):
{
  "awards": ["award name and year if known"],
  "certifications": ["certifications, accreditations, standards"],
  "caseStudies": ["brief description of notable case studies or client outcomes"],
  "originalResearch": ["surveys, reports, studies, or proprietary data published"],
  "namedExperts": ["name and title of known SMEs, executives, or thought leaders at this company"],
  "mediaAppearances": ["podcasts, publications, speaking engagements"],
  "customerQuotes": ["verbatim or paraphrased quotes from customers or reviews"],
  "foundingStory": "brief founding/origin story if notable",
  "notableClients": ["notable clients or logos if public"]
}
Return empty arrays if not found. Be factual and accurate.`
          }],
          max_tokens: 2000
        })
      });
      if (sonarRes.ok) {
        const sd = await sonarRes.json();
        const match = sd.choices[0].message.content.match(/\{[\s\S]*\}/);
        if (match) sonarSignals = JSON.parse(match[0]);
      }
    } catch(e) { console.log('[ENRICH] Sonar scrape failed:', e.message); }

    console.log('[ENRICH] Sonar signals found:', Object.keys(sonarSignals).filter(k => {
      const v = sonarSignals[k]; return Array.isArray(v) ? v.length > 0 : !!v;
    }).join(', ') || 'none');
    send('detail', { stage: 1, detail: `Signals: ${Object.keys(sonarSignals).filter(k => sonarSignals[k]?.length > 0).join(', ') || 'none found — will rely on brand voice'}` });

    // ── Tool 2: E-E-A-T Confidence Scorer + Gap Detector ─────────────────────
    send('progress', { stage: 2, label: 'E-E-A-T Confidence Scorer', detail: 'Scoring experience, expertise, authoritativeness, trust...' });
    console.log('[ENRICH] Tool 2: E-E-A-T Confidence Scorer...');

    const scorerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: 'You are a JSON API. You must respond with valid JSON only — no markdown, no explanation, no code fences.',
      messages: [
        { role: 'user', content: `E-E-A-T scoring task for ${brandName} (${brandUrl}).

SCRAPED SIGNALS: ${JSON.stringify(sonarSignals).slice(0, 800)}
STAGE 1 SIGNALS: ${JSON.stringify(thirdPartySignals).slice(0, 400)}${manualCtx}

Score Experience, Expertise, Authoritativeness, Trustworthiness 0-100. List gaps where score < 60. List smeSignals found.

Respond with this exact JSON structure:
{"scores":{"experience":{"score":0,"rationale":"","evidence":[]},"expertise":{"score":0,"rationale":"","evidence":[]},"authoritativeness":{"score":0,"rationale":"","evidence":[]},"trustworthiness":{"score":0,"rationale":"","evidence":[]}},"overallEEATScore":0,"gaps":[{"dimension":"","gapType":"sme_credentials|awards|case_studies|original_research|customer_proof|author_authority|founding_story|certifications","severity":"high|medium|low","tooltip":"","placeholder":"","whyItMatters":""}],"smeSignals":[{"type":"award|certification|case_study|research|quote|expert|media|client|story","value":"","confidence":0,"source":"scraped|manual","injectionPoint":""}]}` },
      ]
    });

    let scorerData = {};
    try {
      const sd = extractJSON(scorerRes.content[0].text, 'object');
      if (!sd) throw new Error('No JSON in Tool 2');
      scorerData = JSON.parse(sd);
    } catch(e) { console.log('[ENRICH] Tool 2 parse warn:', e.message, '| raw:', scorerRes.content[0].text.slice(0,200)); scorerData = { scores: {}, gaps: [], smeSignals: [], overallEEATScore: 0 }; }

    const gaps = scorerData.gaps || [];
    const needsManualInput = gaps.some(g => g.severity === 'high') && !Object.keys(manualInputs).length;
    console.log(`[ENRICH] E-E-A-T score: ${scorerData.overallEEATScore} | Gaps: ${gaps.length} | NeedsManual: ${needsManualInput}`);
    send('detail', { stage: 2, detail: `E-E-A-T score: ${scorerData.overallEEATScore || 0}/100 · ${gaps.length} gap${gaps.length === 1 ? '' : 's'}${needsManualInput ? ' · manual review recommended' : ''}` });

    // ── Tool 3: Voice + Persona Injection Mapper ──────────────────────────────
    send('progress', { stage: 3, label: 'Voice & Persona Injection Mapper', detail: 'Mapping brand voice patterns into section-level injections...' });
    console.log('[ENRICH] Tool 3: Voice & Persona Injection Mapper...');

    const injectionRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: 'You are a JSON API. You must respond with valid JSON only — no markdown, no explanation, no code fences.',
      messages: [
        { role: 'user', content: `Voice & persona injection mapping task for ${brandName}. Be concise — max 4 injectionMap items, 2 hooks, 3 powerPhrases.

VOICE: ${JSON.stringify(voiceProfile).slice(0, 400)}
PERSONAS: ${JSON.stringify(personas).slice(0, 400)}
SME SIGNALS: ${JSON.stringify(scorerData.smeSignals || []).slice(0, 400)}
GEO TOPICS: ${geoBrief ? JSON.stringify((geoBrief.h2s || []).slice(0,4)) : '[]'}${manualCtx}

Map E-E-A-T signals to content sections. Generate hooks. Build author schema.

Respond with this exact JSON structure:
{"voiceConsistencyScore":0,"injectionMap":[{"section":"","injectionType":"sme_quote|stat|case_study|first_person_hook|customer_voice|founding_story|award_mention|certification_reference","suggestedContent":"","persona":"","eeatDimension":"experience|expertise|authoritativeness|trustworthiness","confidence":0}],"powerPhrases":[],"authorSchema":{"name":null,"title":null,"expertise":[],"credentials":[],"sameAs":[]},"contentHooks":[{"hook":"","persona":"","type":"curiosity|pain_point|stat|story|contrarian"}]}` },
      ]
    });

    let injectionData = {};
    try {
      const id2 = extractJSON(injectionRes.content[0].text, 'object');
      if (!id2) throw new Error('No JSON in Tool 3');
      injectionData = JSON.parse(id2);
    } catch(e) { console.log('[ENRICH] Tool 3 parse warn:', e.message, '| raw:', injectionRes.content[0].text.slice(0,200)); injectionData = { injectionMap: [], powerPhrases: [], authorSchema: {}, contentHooks: [] }; }

    // ── Tool 4: Enriched Brief Assembler ─────────────────────────────────────
    send('progress', { stage: 4, label: 'Enriched Brief Assembler', detail: 'Compiling enriched H1, sections, FAQs, schema markup...' });
    console.log('[ENRICH] Tool 4: Enriched Brief Assembler...');

    const assemblerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: 'You are a JSON API. You must respond with valid JSON only — no markdown, no explanation, no code fences.',
      messages: [
        { role: 'user', content: `Enriched brief assembly task for ${brandName}.

EEAT SCORES: ${JSON.stringify(scorerData.scores || {}).slice(0, 400)}
INJECTIONS: ${JSON.stringify(injectionData.injectionMap || []).slice(0, 600)}
POWER PHRASES: ${JSON.stringify(injectionData.powerPhrases || []).slice(0, 200)}
AUTHOR SCHEMA: ${JSON.stringify(injectionData.authorSchema || {}).slice(0, 200)}
GEO H2S: ${geoBrief ? JSON.stringify((geoBrief.h2s || []).slice(0,6)) : '[]'}
HIGH GAPS: ${JSON.stringify(gaps.filter(g => g.severity === 'high').map(g => g.gapType))}

Assemble enriched brief. Flag sections green/yellow/red by confidence. Mark smeRequired where needed.

Respond with this exact JSON structure:
{"enrichedTitle":"","enrichedH1":"","enrichedSections":[{"heading":"","eeatInjections":[],"confidenceFlag":"green|yellow|red","flagReason":null,"smeRequired":false}],"enrichedFAQ":[{"q":"","a":"","eeatSignal":""}],"overallConfidence":0,"readyForStage4":true,"humanReviewItems":[]}` },
      ]
    });

    let assembledBrief = {};
    try {
      const ab = extractJSON(assemblerRes.content[0].text, 'object');
      if (!ab) throw new Error('No JSON in Tool 4');
      assembledBrief = JSON.parse(ab);
    } catch(e) { console.log('[ENRICH] Tool 4 parse warn:', e.message, '| raw:', assemblerRes.content[0].text.slice(0,200)); assembledBrief = { enrichedSections: [], overallConfidence: 0, readyForStage4: false }; }

    // ── Persist to enriched_briefs ────────────────────────────────────────────

    const vRes = await pool.query(
      `SELECT COALESCE(MAX(version), 0) as max_v FROM enriched_briefs WHERE brand_profile_id = $1`, [brandProfileId]
    );
    const nextVersion = vRes.rows[0].max_v + 1;
    const newId = randomUUID();

    // Fallback brief if Tool 4 returned empty sections
    if (!assembledBrief.enrichedSections || assembledBrief.enrichedSections.length === 0) {
      const fallbackSections = (geoBrief?.h2s || []).slice(0, 6).map((h2, idx) => {
        const injection = (injectionData.injectionMap || []).find(i => i.section && h2 && i.section.toLowerCase().includes(h2.toLowerCase().slice(0,20)));
        return {
          heading: h2,
          eeatInjections: injection ? [injection.suggestedContent] : [],
          confidenceFlag: scorerData.overallEEATScore >= 75 ? 'green' : scorerData.overallEEATScore >= 50 ? 'yellow' : 'red',
          flagReason: null,
          smeRequired: false
        };
      });
      assembledBrief = {
        enrichedTitle: geoBrief?.title || brandName,
        enrichedH1: geoBrief?.h1 || '',
        enrichedSections: fallbackSections,
        enrichedFAQ: (geoBrief?.faqStructure || []).slice(0,3).map(f => ({ q: f.question || f.q || '', a: f.answer || f.a || '', eeatSignal: '' })),
        overallConfidence: scorerData.overallEEATScore || 0,
        readyForStage4: fallbackSections.length > 0,
        humanReviewItems: ['Tool 4 used fallback — re-run for full enrichment']
      };
      console.log('[ENRICH] Tool 4 fallback brief built from GEO brief —', fallbackSections.length, 'sections');
    }

    // ── Factual Ground takes over authorSchema when present ──
    // DB brand_url is the source of truth for URL. Named authors from Factual Ground
    // replace any LLM-generated author schema. Never let Tool 3 hallucinate URLs or names.
    let finalAuthorSchema = injectionData.authorSchema || {};
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg, brand_url FROM brand_profiles WHERE id = $1`,
        [brandProfileId]
      );
      const fg = fgRes.rows[0]?.fg;
      const realBrandUrl = fgRes.rows[0]?.brand_url || '';
      const fgAuthors = fg?.authors || [];
      const primaryAuthor = fgAuthors.find(a => a.name && a.name.trim()) || null;

      if (primaryAuthor) {
        const sameAs = [];
        if (primaryAuthor.linkedinUrl && primaryAuthor.linkedinUrl.trim()) sameAs.push(primaryAuthor.linkedinUrl.trim());

        finalAuthorSchema = {
          "@context": "https://schema.org",
          "@type": "Person",
          "name": primaryAuthor.name.trim(),
          "jobTitle": primaryAuthor.title || '',
          "url": realBrandUrl,  // from DB, never LLM
          "sameAs": sameAs,
          "knowsAbout": (primaryAuthor.expertise || '').split(',').map(s => s.trim()).filter(Boolean),
          "description": primaryAuthor.bio || '',
          "affiliation": {
            "@type": "Organization",
            "name": brandName,
            "url": realBrandUrl,  // from DB, never LLM
            ...(fg?.companyFacts ? { "description": truncateAtSentence(fg.companyFacts, 500) } : {})
          },
          ...(primaryAuthor.credentials ? { "hasCredential": primaryAuthor.credentials.split(/[,.]/).map(s => s.trim()).filter(Boolean) } : {})
        };
        console.log(`[ENRICH] Author schema overridden with Factual Ground: ${primaryAuthor.name}`);
      } else if (realBrandUrl) {
        // Even without named author, at minimum fix the URL field if LLM generated one
        if (finalAuthorSchema.url) finalAuthorSchema.url = realBrandUrl;
        if (finalAuthorSchema.affiliation?.url) finalAuthorSchema.affiliation.url = realBrandUrl;
      }
    } catch(e) {
      console.log('[ENRICH] Author schema FG override failed (non-fatal):', e.message);
    }

    const enrichedData = {
      eeatScores: scorerData.scores,
      overallEEATScore: scorerData.overallEEATScore,
      gaps,
      needsManualInput,
      smeSignals: scorerData.smeSignals,
      injectionMap: injectionData.injectionMap,
      powerPhrases: injectionData.powerPhrases,
      contentHooks: injectionData.contentHooks,
      voiceConsistencyScore: injectionData.voiceConsistencyScore,
      ...assembledBrief,
      // ── Factual Ground author schema comes AFTER assembledBrief spread ──
      // This guarantees our deterministic schema wins over whatever Tool 4 hallucinated
      authorSchema: finalAuthorSchema,
      authorSchemaMarkup: finalAuthorSchema,
      sonarSignals,
      manualInputsProvided: manualInputs,
      // If source is a topic brief, don't write its ID into geo_brief_id column (different table)
      geoBriefId: (geoBrief?.isTopicBrief ? null : (geoBrief?.briefId || geoBriefId || null)),
      // Track topic brief linkage separately so it survives in the enriched blob
      topicBriefId: (geoBrief?.isTopicBrief ? geoBrief.briefId : null)
    };

    const confidenceScore = assembledBrief.overallConfidence || scorerData.overallEEATScore || 0;

    // Smart nuke: delete only prior enrichments tied to THIS topic brief (re-runs of same topic).
    // DO NOT nuke other enriched briefs for this brand — each topic's enrichment is independent work,
    // tied to its own topicBriefId. Legacy behavior (pre-cherry-pick) nuked all enrichments per brand,
    // which orphaned generated articles when users enriched multiple topics in sequence.
    if (topicBriefId) {
      await pool.query(
        `DELETE FROM enriched_briefs WHERE brand_profile_id = $1 AND enriched_data->>'topicBriefId' = $2`,
        [brandProfileId, topicBriefId]
      );
      console.log(`[ENRICH] Cleared prior enrichment for topic brief ${topicBriefId}`);
    } else {
      // Legacy (non-topic-brief) enrichments: delete only legacy rows (where topicBriefId is null)
      await pool.query(
        `DELETE FROM enriched_briefs WHERE brand_profile_id = $1 AND (enriched_data->>'topicBriefId') IS NULL`,
        [brandProfileId]
      );
      console.log('[ENRICH] Cleared prior legacy enrichment for brand (non-topic-brief path)');
    }

    await pool.query(
      `INSERT INTO enriched_briefs (id, brand_profile_id, geo_brief_id, brand_url, brand_name, version, confidence_score, enriched_data, brain_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newId, brandProfileId, enrichedData.geoBriefId, profile.brand_url, brandName, nextVersion, confidenceScore, JSON.stringify(enrichedData), profile.version || 1]
    );

    // NEW: if this enrichment came from a topic brief, mark it complete + its opportunity
    if (topicBriefId) {
      await pool.query(
        `UPDATE geo_topic_briefs SET status = 'enriched', updated_at = NOW() WHERE id = $1`,
        [topicBriefId]
      ).catch(() => {});
      await pool.query(
        `UPDATE geo_opportunities SET status = 'enriched', status_changed_at = NOW()
         WHERE id = (SELECT opportunity_id FROM geo_topic_briefs WHERE id = $1)`,
        [topicBriefId]
      ).catch(() => {});
      console.log(`[ENRICH] Marked topic brief ${topicBriefId} as enriched`);
    }

    const latencyMs = Date.now() - startTime;
    console.log(`[ENRICH] Complete — Score: ${confidenceScore} | Gaps: ${gaps.length} | NeedsManual: ${needsManualInput} | Latency: ${latencyMs}ms`);

    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage3_authenticity_enricher', brandProfileId, 'success', 0, latencyMs]).catch(e => console.error('[ACTIVITY LOG]', e.message));
            send('result', { success: true, cached: false, data: {
      id: newId, brandProfileId, brandUrl: profile.brand_url, brandName,
      version: nextVersion, confidenceScore, latencyMs, needsManualInput,
      brainVersion: profile.version || 1, currentBrainVersion: profile.version || 1,
      ...enrichedData
    }});
    res.end();

  } catch (err) {
    console.error('[ENRICH] Error:', err);
    send('error', { error: err.message });
    res.end();
  }
});


// ── Strategy Intelligence: PVA + Messaging Fault Lines ────────────────────────
app.post('/api/strategy/competitive-intel/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { force = false } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

  // SSE streaming for real-time progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (type, payload) => {
    try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {}
  };

  try {
    const profile = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!profile.rows.length) { send('error', { error: 'Brand not found' }); return res.end(); }
    const brand = profile.rows[0];
    const pd = brand.profile_data || {};
    const competitors = pd.discoveredCompetitors || [];

    if (!competitors.length) {
      send('error', { error: 'No competitors discovered. Run Context Hub first to discover competitors.' });
      return res.end();
    }

    send('progress', { stage: 'init', detail: `${competitors.length} competitors: ${competitors.join(', ')}` });

    // ── Cache check ──
    if (!force) {
      const existing = await pool.query(
        'SELECT * FROM competitive_intelligence WHERE brand_profile_id = $1 ORDER BY created_at DESC',
        [brandProfileId]
      );
      if (existing.rows.length > 0) {
        const stale = existing.rows[0].brain_version < (brand.version || 1);
        if (!stale) {
          send('result', {
            success: true, cached: true,
            competitors: existing.rows.map(r => ({
              url: r.competitor_url, name: r.competitor_name,
              pva: r.pva_data, faultLines: r.fault_lines_data,
              scrapedLength: r.scraped_content_length, createdAt: r.created_at
            }))
          });
          return res.end();
        }
        send('progress', { stage: 'cache', detail: 'Brain updated since last analysis — running fresh' });
      }
    }

    // ── Scrape each competitor ──
    const stripHtml = (html) => html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const competitorData = [];
    for (let ci = 0; ci < competitors.length; ci++) {
      const compUrl = competitors[ci];
      const normalizedUrl = compUrl.startsWith('http') ? compUrl : `https://${compUrl}`;
      send('progress', { stage: 'scrape', competitor: compUrl, index: ci + 1, total: competitors.length, detail: `Scraping ${compUrl}...` });

      let scraped = '';
      let compName = compUrl.replace(/https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      try {
        // Homepage
        const homeRes = await fetch(normalizedUrl, {
          headers: { 'User-Agent': 'ForgeIntelligence/1.0 (Competitive Analysis)' },
          signal: AbortSignal.timeout(12000)
        }).catch(() => null);

        let homeHtml = '';
        if (homeRes?.ok) {
          homeHtml = await homeRes.text();
          // Extract title as competitor name
          const titleMatch = homeHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (titleMatch) compName = titleMatch[1].split(/[|–—-]/)[0].trim();
          scraped += `HOMEPAGE:\n${stripHtml(homeHtml).slice(0, 4000)}\n\n`;
        }

        // Find positioning pages — product, solutions, about, pricing
        const linkMatches = homeHtml.match(/href=["'](\/[^"'#?]+)["']/g) || [];
        const positioningPaths = [...new Set(
          linkMatches
            .map(m => m.match(/href=["'](\/[^"'#?]+)["']/)?.[1])
            .filter(Boolean)
            .filter(p => /\/(product|solution|platform|why|about|pricing|enterprise|feature)/i.test(p))
        )].slice(0, 5);

        const fallbackPaths = positioningPaths.length >= 2 ? positioningPaths : [...positioningPaths, '/about', '/products', '/solutions'].slice(0, 4);

        for (const path of fallbackPaths) {
          try {
            const pageUrl = new URL(path, normalizedUrl).href;
            const pageRes = await fetch(pageUrl, {
              headers: { 'User-Agent': 'ForgeIntelligence/1.0 (Competitive Analysis)' },
              signal: AbortSignal.timeout(8000)
            }).catch(() => null);
            if (pageRes?.ok) {
              const pageHtml = await pageRes.text();
              const pageText = stripHtml(pageHtml).slice(0, 3000);
              if (pageText.length > 100) {
                scraped += `PAGE (${path}):\n${pageText}\n\n`;
              }
            }
          } catch { /* skip */ }
        }

        send('detail', { stage: 'scrape', competitor: compUrl, detail: `Scraped ${scraped.length} chars from ${compName}` });
      } catch(e) {
        send('detail', { stage: 'scrape', competitor: compUrl, detail: `Scrape failed: ${e.message} — will use Sonar context only` });
      }

      competitorData.push({ url: compUrl, name: compName, scraped, scrapedLength: scraped.length });
    }

    // ── Tool 1: Positioning Vulnerability Analysis ──
    send('progress', { stage: 'pva', detail: 'Running Positioning Vulnerability Analysis across all competitors...' });
    console.log('[STRATEGY] Tool 1: PVA...');

    const pvaPrompt = `You are a competitive intelligence analyst producing a Positioning Vulnerability Analysis.

BRAND BEING ANALYZED FOR: ${brand.brand_name} (${brand.brand_url})
BRAND CONTEXT: ${JSON.stringify({ marketCategory: pd.marketCategory, competitiveGaps: (pd.competitiveGaps || []).slice(0, 3) }).slice(0, 800)}

COMPETITORS AND THEIR SCRAPED PUBLIC CONTENT:
${competitorData.map(c => `--- ${c.name} (${c.url}) ---\n${c.scraped.slice(0, 5000)}`).join('\n\n')}

TASK: Analyze each competitor's public positioning. For each, identify:
1. OVEREXPOSED CLAIMS: Positioning anchors repeated so heavily they become targets (vendor lock-in objections, pricing backlash, etc.)
2. WEAK CLAIMS: Assertions without proof — vague superlatives, unsubstantiated metrics, promises that don't hold up
3. VULNERABILITY: The strategic opening this creates for ${brand.brand_name}

CONSTRAINTS:
- Every vulnerability MUST be grounded in actual content you can see above. No speculation.
- Quote the competitor's exact language when citing a claim.
- Tone: intelligence briefing, not attack ad. Board-ready.
- Limit to 2-4 vulnerabilities per competitor (highest signal only).

Respond with ONLY valid JSON — no markdown, no code fences:
{
  "competitors": [
    {
      "url": "string",
      "name": "string",
      "vulnerabilities": [
        {
          "type": "overexposed | weak_claim | unsubstantiated",
          "claim": "the exact quote or paraphrased claim from their content",
          "evidence": "where you found it and how prominent it is",
          "vulnerability": "the strategic opening this creates",
          "severity": "high | medium | low"
        }
      ]
    }
  ]
}`;

    const pvaRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: 'You are a JSON API. Respond with valid JSON only — no markdown, no explanation, no code fences.',
      messages: [{ role: 'user', content: pvaPrompt }]
    });

    let pvaData = { competitors: [] };
    try {
      const raw = pvaRes.content[0].text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) pvaData = JSON.parse(jsonMatch[0]);
    } catch(e) { console.log('[STRATEGY] PVA parse warn:', e.message); }

    const pvaCount = pvaData.competitors?.reduce((sum, c) => sum + (c.vulnerabilities?.length || 0), 0) || 0;
    send('detail', { stage: 'pva', detail: `${pvaCount} vulnerabilities identified across ${pvaData.competitors?.length || 0} competitors` });

    // ── Tool 2: Messaging Fault Lines ──
    send('progress', { stage: 'faultlines', detail: 'Extracting Messaging Fault Lines — mapping competitor language...' });
    console.log('[STRATEGY] Tool 2: Messaging Fault Lines...');

    const faultLinesPrompt = `You are a competitive messaging analyst extracting Messaging Fault Lines.

BRAND BEING ANALYZED FOR: ${brand.brand_name} (${brand.brand_url})
BRAND POSITIONING: ${JSON.stringify({ marketCategory: pd.marketCategory, voiceProfile: pd.voiceProfile }).slice(0, 600)}

COMPETITORS AND THEIR SCRAPED PUBLIC CONTENT:
${competitorData.map(c => `--- ${c.name} (${c.url}) ---\n${c.scraped.slice(0, 5000)}`).join('\n\n')}

TASK: For each competitor, extract the EXACT LANGUAGE they use in their public messaging and surface differentiation opportunities for ${brand.brand_name}.

For each fault line identify:
1. THEIR LANGUAGE: The literal phrases, repeated claims, and specific word choices they use
2. FREQUENCY: How prominent this language is (headline-level, repeated across pages, etc.)
3. DIFFERENTIATION ANGLE: A concrete counter-position ${brand.brand_name} can use

CONSTRAINTS:
- Include the competitor's ACTUAL quoted language. Not sentiment. Not vibes. Literal phrases.
- Tone: clinical, not combative. Maps messaging terrain, doesn't bash.
- Every fault line must include quoted language + frequency + counter-position.
- Limit to 2-4 fault lines per competitor (highest signal only).
- Board-ready. A CMO presents this.

Respond with ONLY valid JSON — no markdown, no code fences:
{
  "competitors": [
    {
      "url": "string",
      "name": "string",
      "faultLines": [
        {
          "theirLanguage": "exact quoted phrase or repeated claim",
          "frequency": "how prominent — headline, repeated N times, section headers, etc.",
          "context": "where and how they use it",
          "differentiationAngle": "concrete counter-position for ${brand.brand_name}",
          "priority": "high | medium | low"
        }
      ]
    }
  ]
}`;

    const flRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: 'You are a JSON API. Respond with valid JSON only — no markdown, no explanation, no code fences.',
      messages: [{ role: 'user', content: faultLinesPrompt }]
    });

    let faultLinesData = { competitors: [] };
    try {
      const raw = flRes.content[0].text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) faultLinesData = JSON.parse(jsonMatch[0]);
    } catch(e) { console.log('[STRATEGY] Fault Lines parse warn:', e.message); }

    const flCount = faultLinesData.competitors?.reduce((sum, c) => sum + (c.faultLines?.length || 0), 0) || 0;
    send('detail', { stage: 'faultlines', detail: `${flCount} fault lines mapped across ${faultLinesData.competitors?.length || 0} competitors` });

    // ── Persist per competitor ──
    send('progress', { stage: 'persist', detail: 'Saving competitive intelligence...' });

    for (const comp of competitorData) {
      const pvaForComp = (pvaData.competitors || []).find(c => c.url === comp.url) || { vulnerabilities: [] };
      const flForComp = (faultLinesData.competitors || []).find(c => c.url === comp.url) || { faultLines: [] };

      await pool.query(
        `INSERT INTO competitive_intelligence (brand_profile_id, competitor_url, competitor_name, pva_data, fault_lines_data, scraped_content_length, brain_version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (brand_profile_id, competitor_url)
         DO UPDATE SET competitor_name = $3, pva_data = $4, fault_lines_data = $5, scraped_content_length = $6,
                       brain_version = $7, version = competitive_intelligence.version + 1, updated_at = NOW()`,
        [brandProfileId, comp.url, comp.name, JSON.stringify(pvaForComp.vulnerabilities || []),
         JSON.stringify(flForComp.faultLines || []), comp.scrapedLength, brand.version || 1]
      );
    }

    // Build result
    const result = competitorData.map(comp => ({
      url: comp.url,
      name: comp.name,
      scrapedLength: comp.scrapedLength,
      pva: ((pvaData.competitors || []).find(c => c.url === comp.url) || {}).vulnerabilities || [],
      faultLines: ((faultLinesData.competitors || []).find(c => c.url === comp.url) || {}).faultLines || []
    }));

    console.log(`[STRATEGY] Complete — ${result.length} competitors, ${pvaCount} vulnerabilities, ${flCount} fault lines`);
    send('result', { success: true, cached: false, competitors: result });
    res.end();

  } catch(err) {
    console.error('[STRATEGY] Error:', err);
    send('error', { error: err.message });
    res.end();
  }
});

// GET /api/strategy/competitive-intel/:brandProfileId — fetch cached results
app.get('/api/strategy/competitive-intel/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM competitive_intelligence WHERE brand_profile_id = $1 ORDER BY competitor_name',
      [req.params.brandProfileId]
    );
    res.json({
      success: true,
      competitors: r.rows.map(row => ({
        url: row.competitor_url, name: row.competitor_name,
        pva: row.pva_data, faultLines: row.fault_lines_data,
        scrapedLength: row.scraped_content_length,
        version: row.version, createdAt: row.created_at
      }))
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
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
    const response = await fetch('https://forgeintelligence.ai/api/assets/' + req.params.filename);
    if (!response.ok) throw new Error('Not found');
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', response.headers.get('content-type'));
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(404).send('Asset not found');
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Stage 4 — Content Generator (SSE streaming)
// ─────────────────────────────────────────────────────────────────────────────

// Provision per-brand generated_content table if it doesn't exist
async function ensureGeneratedContentTable(brandProfileId) {
  const safeId = brandProfileId.replace(/-/g, '_');
  const tableName = `generated_content_${safeId}`;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      enriched_brief_id TEXT,
      title TEXT,
      article_json JSONB,
      overall_confidence INTEGER,
      brain_match_score INTEGER,
      hero_image_url TEXT,
      hero_image_prompt TEXT,
      status TEXT DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add new columns to existing tables (idempotent)
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS hero_image_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS hero_image_prompt TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS review_mode TEXT DEFAULT 'approve-to-ship'`).catch(() => {});
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS compliance_status TEXT DEFAULT 'pending'`).catch(() => {});
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS compliance_report JSONB`).catch(() => {});
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`).catch(() => {});
  // Campaign tracking — links articles generated via campaign generator back to their campaign
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS campaign_id UUID`).catch(() => {});
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS campaign_article_index INTEGER`).catch(() => {});
  return tableName;
}

app.get('/api/content-generator/generate', requireAuth, async (req, res) => {
  const { brandProfileId, enrichedBriefId, force, topicPrompt } = req.query;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(keepalive));

  try {
    // ── Brain-First: load all context ────────────────────────────────────────
    const [profileRes, patternsRes, mistakesRes] = await Promise.all([
      pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]),
      pool.query('SELECT pattern_type, description, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8', [brandProfileId]).catch(() => ({ rows: [] })),
      pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC LIMIT 5', [brandProfileId]).catch(() => ({ rows: [] }))
    ]);

    if (!profileRes.rows.length) {
      send('error', 'Brand profile not found. Run Stage 1 first.');
      return res.end();
    }
    const profile = profileRes.rows[0];
    const profileData = profile.profile_data || {};

    // Load GEO brief
    let geoBrief = null;
    try {
      const gbRes = await pool.query(
        'SELECT * FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1',
        [brandProfileId]
      );
      if (gbRes.rows.length) geoBrief = { ...gbRes.rows[0].brief_data, brandName: gbRes.rows[0].brand_name };
    } catch(e) { console.log('[CONTENT-GEN] No geo brief:', e.message); }

    // Load Enriched Brief
    let enrichedBrief = null;
    try {
      const ebQuery = enrichedBriefId
        ? pool.query('SELECT * FROM enriched_briefs WHERE id = $1', [enrichedBriefId])
        : pool.query('SELECT * FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1', [brandProfileId]);
      const ebRes = await ebQuery;
      if (ebRes.rows.length) enrichedBrief = { ...ebRes.rows[0].enriched_data, brandName: ebRes.rows[0].brand_name };
    } catch(e) { console.log('[CONTENT-GEN] No enriched brief:', e.message); }

    // ── Build prompt ─────────────────────────────────────────────────────────
    const systemPromptPath = path.join(__dirname, 'src/agents/stage4_content_generator/system_prompt.md');
    const systemPrompt = fs.existsSync(systemPromptPath)
      ? fs.readFileSync(systemPromptPath, 'utf8')
      : 'You are a content generator. Produce a high-quality long-form article.';

    const trimTo = (obj, maxChars = 8000) => {
      const s = JSON.stringify(obj, null, 2);
      return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated for token budget]' : s;
    };
    // Load Topical Authority Map — strategic context for where this content lives
    let topicalTerritories = [];
    try {
      const gbRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [brandProfileId]
      );
      const topicalMapRaw = gbRes.rows[0]?.brief_data?.topicalAuthorityMap || gbRes.rows[0]?.brief_data?.topicalMap?.gapsByCluster || [];
      topicalTerritories = topicalMapRaw
        .map(t => ({
          topic: t.topic || t.cluster || t.name,
          coverage: (t.coverage || t.rationale || t.description || '').slice(0, 140),
          priority: t.priority || (t.citationProbability >= 70 ? 'high' : t.citationProbability >= 40 ? 'medium' : 'low')
        }))
        .filter(t => t.topic)
        .sort((a, b) => (a.priority === 'high' ? -1 : b.priority === 'high' ? 1 : 0))
        .slice(0, 8);
    } catch(e) { /* silent — non-fatal */ }

    const territoriesBlock = topicalTerritories.length
      ? `\nSTRATEGIC TERRITORIES THIS BRAND OPERATES IN (write as an authority in these territories — never drift outside them):\n${topicalTerritories.map(t => `  • [${t.priority}] ${t.topic}${t.coverage ? ' — ' + t.coverage : ''}`).join('\n')}\n`
      : '';

    // Load Factual Ground — user-verified facts the writer MUST use verbatim
    let factualGround = null;
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg FROM brand_profiles WHERE id = $1`,
        [brandProfileId]
      );
      if (fgRes.rows[0]?.fg) factualGround = fgRes.rows[0].fg;
    } catch(e) { console.log('[CONTENT-GEN] No factual ground:', e.message); }

    const factualGroundBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\n═══════════════════════════════════════════════════════════════════════════
FACTUAL GROUND — USER-VERIFIED FACTS YOU MUST USE VERBATIM
═══════════════════════════════════════════════════════════════════════════

These are NOT scraped from the website. These are direct statements from the brand owner.
They OVERRIDE anything else you know or infer about this company.
When referencing company facts, credentials, or methodology — use these exact phrasings.
NEVER invent credentials, titles, dates, methodology steps, or quotes that contradict this section.
NEVER hedge on what is stated here — these are facts, not suggestions.

${factualGround.whatWeDo ? `WHAT THIS COMPANY DOES (use this language):\n${factualGround.whatWeDo}\n` : ''}
${factualGround.whatWeDontDo ? `WHAT THIS COMPANY DOES NOT DO (never claim otherwise):\n${factualGround.whatWeDontDo}\n` : ''}
${factualGround.companyFacts ? `COMPANY FACTS (only reference these):\n${factualGround.companyFacts}\n` : ''}
${factualGround.methodology ? `METHODOLOGY / APPROACH (describe in these terms):\n${factualGround.methodology}\n` : ''}
${factualGround.foundingStory ? `FOUNDING STORY (reference only these details):\n${factualGround.foundingStory}\n` : ''}
${factualGround.teamComposition ? `TEAM (only reference these people/roles):\n${factualGround.teamComposition}\n` : ''}
${factualGround.quotablePositions ? `QUOTABLE POSITIONS (use these phrases verbatim when making bold claims):\n${factualGround.quotablePositions}\n` : ''}
${factualGround.authors && factualGround.authors.length ? `NAMED AUTHORS (use ONLY these people for author attribution, credentials, and bylines):\n${factualGround.authors.map(a => `  • ${a.name || '[unnamed]'} — ${a.title || ''}\n    LinkedIn: ${a.linkedinUrl || 'N/A'}\n    Bio: ${a.bio || 'N/A'}\n    Credentials: ${a.credentials || 'N/A'}\n    Expertise: ${a.expertise || 'N/A'}`).join('\n\n')}\n` : ''}
═══════════════════════════════════════════════════════════════════════════
`
      : '';

        const userPrompt = `Generate a long-form article using the following Brand Intelligence context.
${topicPrompt ? `\nUSER TOPIC DIRECTION (write the article around this specific topic/angle — this overrides the enriched brief's default topic selection):\n"${topicPrompt}"\n` : ''}${factualGroundBlock}${territoriesBlock}
BRAND PROFILE:
${trimTo(profileData, 6000)}

GEO BRIEF:
${geoBrief ? trimTo(geoBrief, 4000) : 'Not available — infer topical strategy from brand profile.'}

ENRICHED BRIEF:
${enrichedBrief ? (() => {
  // Extract ONLY the fields the writer needs — skip diagnostic bloat (EEAT scores, gaps, injection maps, sonar signals).
  // Full enriched brief is 30-40KB; writer only needs ~3-5KB of article-directing content.
  const slim = {
    enrichedTitle: enrichedBrief.enrichedTitle,
    enrichedH1: enrichedBrief.enrichedH1,
    topic: enrichedBrief.topic,
    enrichedSections: (enrichedBrief.enrichedSections || []).map(s => ({
      heading: s.heading, body: s.body || s.content,
      confidenceTier: s.confidenceTier,
      eeatInjections: s.eeatInjections, smeHooks: s.smeHooks
    })),
    enrichedFAQ: enrichedBrief.enrichedFAQ,
    powerPhrases: enrichedBrief.powerPhrases,
    contentHooks: enrichedBrief.contentHooks,
    authorSchema: enrichedBrief.authorSchema ? { name: enrichedBrief.authorSchema.name, jobTitle: enrichedBrief.authorSchema.jobTitle } : null
  };
  return trimTo(slim, 12000);
})() : 'Not available — use brand profile voice and personas.'}

BRAIN PATTERNS — WHAT WORKS FOR THIS BRAND (extracted from real published content analytics):
${patternsRes.rows.length > 0 ? trimTo(patternsRes.rows, 2000) : 'No patterns extracted yet — generate strong content to seed future patterns.'}

BRAIN MISTAKES — WHAT TO AVOID FOR THIS BRAND (extracted from underperforming published content):
${mistakesRes.rows.length > 0 ? trimTo(mistakesRes.rows, 1500) : 'No mistakes logged yet.'}

CRITICAL: Factual Ground (if present above) is the source of truth for any claim about this company — use it verbatim and never contradict it. Brain patterns reinforce proven angles. Brain mistakes are what to avoid. These are real signals from published content performance — treat them as hard constraints on tone, angle, and format.

Return ONLY valid JSON matching the specified output format. No markdown, no code fences, no commentary.`;

    send('chunk', 'Brain loaded. Building article...');

    // ── Stream from Claude ────────────────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let fullText = '';
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 12000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        const text = chunk.delta.text;
        fullText += text;
        send('chunk', text.replace(/\n/g, '⏎'));
      }
    }

    // ── Parse + persist ───────────────────────────────────────────────────────
    let parsed;
    try {
      const jsonMatch = fullText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : fullText;
      try {
        parsed = JSON.parse(jsonStr);
      } catch(e) {
        // Claude truncated mid-JSON — robust bracket-counting recovery
        const attemptRecovery = (str) => {
          // Strip any trailing partial token/word at the cut point
          let s = str.replace(/,\s*$/, '').replace(/:\s*$/, '').replace(/"[^"]*$/, '"');
          // Count unclosed braces and brackets
          let braces = 0, brackets = 0;
          let inString = false, escape = false;
          for (const ch of s) {
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') braces++;
            else if (ch === '}') braces--;
            else if (ch === '[') brackets++;
            else if (ch === ']') brackets--;
          }
          // Close any open arrays then objects
          s += ']'.repeat(Math.max(0, brackets));
          s += '}'.repeat(Math.max(0, braces));
          return s;
        };
        try {
          const recovered = attemptRecovery(jsonStr);
          parsed = JSON.parse(recovered);
          parsed._truncated = true;
        } catch(e2) {
          // Last resort — try stripping to last complete top-level section
          try {
            const lastBrace = jsonStr.lastIndexOf('},\n');
            if (lastBrace > 100) {
              const trimmed = jsonStr.substring(0, lastBrace + 1) + '] }';
              parsed = JSON.parse(trimmed);
              parsed._truncated = true;
            } else {
              send('error', 'Article generation hit a formatting issue — click Generate again and it\'ll come through clean. (The AI sometimes needs a second take.)');
          console.error('[CONTENT-GEN] JSON parse error:', e.message);
              return res.end();
            }
          } catch(e3) {
            send('error', 'Article generation hit a formatting issue — click Generate again and it\'ll come through clean. (The AI sometimes needs a second take.)');
          console.error('[CONTENT-GEN] JSON parse error:', e.message);
            return res.end();
          }
        }
      }
    } catch(e) {
      send('error', 'Article generation hit a formatting issue — click Generate again and it\'ll come through clean. (The AI sometimes needs a second take.)');
          console.error('[CONTENT-GEN] JSON parse error:', e.message);
      return res.end();
    }

    // Strip LLM scaffolding artifacts (SME Hook, CTA, TODO, NEEDS CITATION, etc.)
    parsed = stripScaffoldingArtifacts(parsed);

    const tableName = await ensureGeneratedContentTable(brandProfileId);
    const contentInsert = await pool.query(
      `INSERT INTO ${tableName} (brand_profile_id, enriched_brief_id, title, article_json, overall_confidence, brain_match_score, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft') RETURNING id`,
      [brandProfileId, enrichedBriefId || null, parsed.title, JSON.stringify(parsed),
       parsed.overallConfidence || null, parsed.brainMatchScore || (() => {
         // Fallback: Claude dropped the field — compute from section confidences
         const sections = parsed.sections || [];
         if (!sections.length) return null;
         const avg = sections.reduce((a, s) => a + (s.confidence || 0), 0) / sections.length;
         return Math.round(avg);
       })()]
    );
    const contentId = contentInsert.rows[0]?.id;

    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      ['stage4_content_generator', brandProfileId, 'success',
       (stream.usage?.input_tokens || 0) + (stream.usage?.output_tokens || 0),
       0]
    ).catch(() => {});

    send('done', JSON.stringify({ ...parsed, contentId }));

    // Fire Flux image generation in parallel — don't block the done event
    (async () => {
      try {
        const streamFirstBody = (parsed.sections?.[0]?.body || parsed.sections?.[0]?.content || '').slice(0, 250);
        const fluxPrompt = await buildImagePrompt(parsed.title, profileData?.voice_profile || {}, streamFirstBody);

        const imageUrl = await generateHeroImage(fluxPrompt);

        // Persist hero image URL + prompt to the content record
        await pool.query(
          `UPDATE ${tableName} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
          [imageUrl, fluxPrompt, contentId]
        ).catch((e) => console.error('[CONTENT-GEN] Image persist failed:', e.message));

        send('image_done', JSON.stringify({ image_url: imageUrl, prompt: fluxPrompt }));
      } catch (imgErr) {
        console.error('[CONTENT-GEN] Image error:', imgErr.message);
        send('image_error', JSON.stringify({ error: imgErr.message }));
      } finally {
        res.end();
      }
    })();

  } catch (err) {
    console.error('[CONTENT-GEN] Error:', err?.message || err);
    console.error('[CONTENT-GEN] Stack:', err?.stack);
    send('error', err.message || 'Generation failed');
    res.end();
  }
});


// ── Campaign Generator ────────────────────────────────────────────────────────

// POST /api/campaign/plan — generate 8 angle profiles
app.post('/api/campaign/plan', requireAuth, async (req, res) => {
  const { brandProfileId, topicPrompt } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

  try {
    // Load brand brain from DB
    const profileResult = await pool.query(
      `SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]
    );
    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Brand profile not found. Run Stage 1 first.' });
    }
    const profileData = profileResult.rows[0].profile_data || profileResult.rows[0];

    // Load GEO brief and enriched brief from DB
    const geoRes = await pool.query(
      `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [brandProfileId]
    );
    const enrichedRes = await pool.query(
      `SELECT enriched_data FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [brandProfileId]
    );

    const geoBrief = geoRes.rows[0]?.brief_data || null;
    const enrichedBrief = enrichedRes.rows[0]?.enriched_data || null;

    const trimTo = (obj, maxChars = 6000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated]' : s;
    };

    const systemPrompt = fs.readFileSync(
      path.join(__dirname, 'src/agents/stage4_campaign_planner/system_prompt.md'), 'utf8'
    );

    const userPrompt = `Generate 8 campaign angle profiles for the following brand brain.
${topicPrompt ? `\nUSER TOPIC DIRECTION: The user wants this campaign focused on: "${topicPrompt}". Build all 8 article angles around this theme. The brain patterns below should inform HOW you approach this topic, not WHETHER you cover it.\n` : ''}
BRAND PROFILE:
${trimTo(profileData, 4000)}

GEO BRIEF:
${geoBrief ? trimTo(geoBrief, 4000) : 'Not available — infer from brand profile.'}

ENRICHED BRIEF:
${enrichedBrief ? trimTo(enrichedBrief, 4000) : 'Not available — infer from brand profile.'}

Return ONLY valid JSON matching the output format. No markdown, no commentary.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = message.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const plan = safeParseLLM(jsonMatch ? jsonMatch[0] : raw, 'object', 'campaign-plan');

    res.json({ success: true, plan });
  } catch (err) {
    console.error('Campaign plan error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/campaign/reset/:id — reset a stalled campaign back to pending
app.post('/api/campaign/reset/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE campaigns SET status = 'pending', updated_at = NOW()
       WHERE id = $1 AND status IN ('generating', 'error')
       RETURNING id, status`,
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Campaign not found or not in a resettable state' });
    }
    // Also reset any stuck article statuses
    await pool.query(
      `UPDATE campaign_articles SET status = 'pending', updated_at = NOW()
       WHERE campaign_id = $1 AND status = 'generating'`,
      [req.params.id]
    ).catch(() => {});
    res.json({ success: true, campaignId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaign/create — save campaign plan to DB

app.post('/api/campaign/create', requireAuth, async (req, res) => {
  const { brandProfileId, plan } = req.body;
  if (!brandProfileId || !plan) return res.status(400).json({ error: 'brandProfileId and plan required' });

  try {
    // Ensure tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand_profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        topic_cluster TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        plan JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_articles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        brand_profile_id TEXT NOT NULL,
        article_index INTEGER NOT NULL,
        angle_profile JSONB NOT NULL,
        week_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        generated_content JSONB,
        image_url TEXT,
        image_prompt TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const campRes = await pool.query(
      `INSERT INTO campaigns (brand_profile_id, name, topic_cluster, plan)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [brandProfileId, plan.campaign_name, plan.topic_cluster, JSON.stringify(plan)]
    );
    const campaignId = campRes.rows[0].id;

    for (const article of plan.articles) {
      await pool.query(
        `INSERT INTO campaign_articles (campaign_id, brand_profile_id, article_index, angle_profile, week_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [campaignId, brandProfileId, article.index, JSON.stringify(article), article.week]
      );
    }

    // Migration safety: add image columns if they don't exist yet
    await pool.query(`ALTER TABLE campaign_articles ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await pool.query(`ALTER TABLE campaign_articles ADD COLUMN IF NOT EXISTS image_prompt TEXT`);

    res.json({ success: true, campaignId });
  } catch (err) {
    console.error('Campaign create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaign/list/:brandProfileId
app.get('/api/campaign/list/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, topic_cluster, status, created_at,
       (SELECT COUNT(*) FROM campaign_articles WHERE campaign_id = campaigns.id AND status = 'complete') as completed_count
       FROM campaigns WHERE brand_profile_id = $1 ORDER BY created_at DESC`,
      [req.params.brandProfileId]
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaign/:id
app.get('/api/campaign/:id', async (req, res) => {
  try {
    const camp = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    const articles = await pool.query(
      `SELECT * FROM campaign_articles WHERE campaign_id = $1 ORDER BY article_index`,
      [req.params.id]
    );
    res.json({ campaign: camp.rows[0], articles: articles.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaign/generate/:id — SSE — generate all pending articles sequentially
app.get('/api/campaign/generate/:id', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Keepalive ping every 30s so Render/proxies don't drop the SSE connection
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(keepalive));

  try {
    const campRes = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    const campaign = campRes.rows[0];
    if (!campaign) { send('error', { message: 'Campaign not found' }); return res.end(); }

    const articlesRes = await pool.query(
      `SELECT * FROM campaign_articles WHERE campaign_id = $1 AND status = 'pending' ORDER BY article_index`,
      [req.params.id]
    );
    const articles = articlesRes.rows;

    const profileResult = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [campaign.brand_profile_id]);
    if (!profileResult.rows.length) { send('error', { message: 'Brand profile not found' }); return res.end(); }
    const profileData = profileResult.rows[0].profile_data || profileResult.rows[0];

    const geoRes = await pool.query(
      `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [campaign.brand_profile_id]
    );
    const enrichedRes = await pool.query(
      `SELECT enriched_data FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [campaign.brand_profile_id]
    );
    const patternsRes = await pool.query(
      `SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 5`,
      [campaign.brand_profile_id]
    );
    const mistakesRes = await pool.query(
      `SELECT mistake_type, description FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [campaign.brand_profile_id]
    );

    const geoBrief = geoRes.rows[0]?.brief_data || null;
    const enrichedBrief = enrichedRes.rows[0]?.enriched_data || null;

    const trimTo = (obj, maxChars = 6000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated]' : s;
    };

    const cgSystemPrompt = fs.readFileSync(
      path.join(__dirname, 'src/agents/stage4_content_generator/system_prompt.md'), 'utf8'
    );

    await pool.query(`UPDATE campaigns SET status = 'generating', updated_at = NOW() WHERE id = $1`, [req.params.id]);

    // ── Flux image generation helper ────────────────────────────────────────────
    const generateArticleImage = async (articleRow, angle, parsed) => {
      try {
        const batchBody = (parsed.sections?.[0]?.body || parsed.sections?.[0]?.content || angle.description || '').slice(0, 250);
        const fluxPrompt = await buildImagePrompt(parsed.title || angle.title, profileData?.voice_profile || {}, batchBody);

        const imageUrl = await generateHeroImage(fluxPrompt);

        const safeId2 = articleRow.brand_profile_id?.replace(/-/g, '_');
        await pool.query(
          `UPDATE generated_content_${safeId2} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
          [imageUrl, fluxPrompt, articleRow.id]
        );
        return imageUrl;
      } catch(e) {
        console.error('[IMG-GEN]', e.message);
        return null;
      }
    };;

    for (const articleRow of articles) {
      const angle = articleRow.angle_profile;
      send('article_start', { index: angle.index, title: angle.title, week: angle.week });

      await pool.query(
        `UPDATE campaign_articles SET status = 'generating', updated_at = NOW() WHERE id = $1`,
        [articleRow.id]
      );

      // Load Topical Authority Map — strategic context for where this content lives
    let topicalTerritories = [];
    try {
      const gbRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [brandProfileId]
      );
      const topicalMapRaw = gbRes.rows[0]?.brief_data?.topicalAuthorityMap || gbRes.rows[0]?.brief_data?.topicalMap?.gapsByCluster || [];
      topicalTerritories = topicalMapRaw
        .map(t => ({
          topic: t.topic || t.cluster || t.name,
          coverage: (t.coverage || t.rationale || t.description || '').slice(0, 140),
          priority: t.priority || (t.citationProbability >= 70 ? 'high' : t.citationProbability >= 40 ? 'medium' : 'low')
        }))
        .filter(t => t.topic)
        .sort((a, b) => (a.priority === 'high' ? -1 : b.priority === 'high' ? 1 : 0))
        .slice(0, 8);
    } catch(e) { /* silent — non-fatal */ }

    const territoriesBlock = topicalTerritories.length
      ? `\nSTRATEGIC TERRITORIES THIS BRAND OPERATES IN (write as an authority in these territories — never drift outside them):\n${topicalTerritories.map(t => `  • [${t.priority}] ${t.topic}${t.coverage ? ' — ' + t.coverage : ''}`).join('\n')}\n`
      : '';

    // Load Factual Ground — user-verified facts the writer MUST use verbatim
    let factualGround = null;
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg FROM brand_profiles WHERE id = $1`,
        [brandProfileId]
      );
      if (fgRes.rows[0]?.fg) factualGround = fgRes.rows[0].fg;
    } catch(e) { console.log('[CONTENT-GEN] No factual ground:', e.message); }

    const factualGroundBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\n═══════════════════════════════════════════════════════════════════════════
FACTUAL GROUND — USER-VERIFIED FACTS YOU MUST USE VERBATIM
═══════════════════════════════════════════════════════════════════════════

These are NOT scraped from the website. These are direct statements from the brand owner.
They OVERRIDE anything else you know or infer about this company.
When referencing company facts, credentials, or methodology — use these exact phrasings.
NEVER invent credentials, titles, dates, methodology steps, or quotes that contradict this section.
NEVER hedge on what is stated here — these are facts, not suggestions.

${factualGround.whatWeDo ? `WHAT THIS COMPANY DOES (use this language):\n${factualGround.whatWeDo}\n` : ''}
${factualGround.whatWeDontDo ? `WHAT THIS COMPANY DOES NOT DO (never claim otherwise):\n${factualGround.whatWeDontDo}\n` : ''}
${factualGround.companyFacts ? `COMPANY FACTS (only reference these):\n${factualGround.companyFacts}\n` : ''}
${factualGround.methodology ? `METHODOLOGY / APPROACH (describe in these terms):\n${factualGround.methodology}\n` : ''}
${factualGround.foundingStory ? `FOUNDING STORY (reference only these details):\n${factualGround.foundingStory}\n` : ''}
${factualGround.teamComposition ? `TEAM (only reference these people/roles):\n${factualGround.teamComposition}\n` : ''}
${factualGround.quotablePositions ? `QUOTABLE POSITIONS (use these phrases verbatim when making bold claims):\n${factualGround.quotablePositions}\n` : ''}
${factualGround.authors && factualGround.authors.length ? `NAMED AUTHORS (use ONLY these people for author attribution, credentials, and bylines):\n${factualGround.authors.map(a => `  • ${a.name || '[unnamed]'} — ${a.title || ''}\n    LinkedIn: ${a.linkedinUrl || 'N/A'}\n    Bio: ${a.bio || 'N/A'}\n    Credentials: ${a.credentials || 'N/A'}\n    Expertise: ${a.expertise || 'N/A'}`).join('\n\n')}\n` : ''}
═══════════════════════════════════════════════════════════════════════════
`
      : '';

        const userPrompt = `Generate a long-form article using the following Brand Intelligence context.

CAMPAIGN ANGLE (follow this precisely):
${JSON.stringify(angle, null, 2)}

BRAND PROFILE:
${trimTo(profileData, 5000)}

GEO BRIEF:
${geoBrief ? trimTo(geoBrief, 3000) : 'Not available.'}

ENRICHED BRIEF:
${enrichedBrief ? trimTo(enrichedBrief, 5000) : 'Not available.'}

BRAIN PATTERNS:
${trimTo(patternsRes.rows, 1500)}

BRAIN MISTAKES:
${trimTo(mistakesRes.rows, 1500)}

IMPORTANT: Use the angle profile above to lock the persona, funnel position, content type, and E-E-A-T focus.
Return ONLY valid JSON matching the content generator output format.`;

      let fullText = '';
      const stream = await anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: cgSystemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          fullText += chunk.delta.text;
          send('chunk', chunk.delta.text);
        }
      }

      let parsed;
      try {
        // Use extractJSON which handles token-truncated responses by closing open structures
        const recovered = extractJSON(fullText, 'object');
        if (!recovered) throw new Error('No valid JSON found in response');
        parsed = JSON.parse(recovered);
      } catch (e) {
        await pool.query(
          `UPDATE campaign_articles SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [articleRow.id]
        );
        send('article_error', { index: angle.index, error: e.message });
        continue;
      }

      // Save article + kick off Flux in parallel — don't await Flux here
      await pool.query(
        `UPDATE campaign_articles SET status = 'complete', generated_content = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(parsed), articleRow.id]
      );

      // ── Mirror into generated_content_{uuid} so article flows through publishing pipeline ──
      // This is what connects campaign articles to publishing_queue, UTM tracking, and analytics.
      try {
        const contentTableName = await ensureGeneratedContentTable(campaign.brand_profile_id);
        parsed = stripScaffoldingArtifacts(parsed);
        const insertedContent = await pool.query(
          `INSERT INTO ${contentTableName}
            (brand_profile_id, title, article_json, overall_confidence, status, campaign_id, campaign_article_index, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6, NOW(), NOW())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            campaign.brand_profile_id,
            parsed.title || angle.title,
            JSON.stringify(parsed),
            parsed.overallConfidence || angle.estimated_confidence || 75,
            campaign.id,
            angle.index
          ]
        );
        const contentId = insertedContent.rows[0]?.id;

        // Stage into publishing_queue with campaign_id so UTM builder can read it
        if (contentId) {
          await pool.query(
            `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, campaign_id, created_at, updated_at)
             VALUES ($1, $2, $3, 'staged', $4, NOW(), NOW())
             ON CONFLICT (content_id) DO NOTHING`,
            [campaign.brand_profile_id, contentId, parsed.title || angle.title, campaign.id]
          );
        }
      } catch (mirrorErr) {
        console.warn('[CAMPAIGN] Mirror to generated_content failed (non-fatal):', mirrorErr.message);
      }

      send('article_done', { index: angle.index, article: parsed });

      // Fire image generation async — emits image_done when ready, never blocks article loop
      generateArticleImage(articleRow, angle, parsed).then(({ imageUrl, fluxPrompt, error }) => {
        if (imageUrl) {
          send('image_done', { index: angle.index, image_url: imageUrl, prompt: fluxPrompt });
        } else {
          send('image_error', { index: angle.index, error: error || 'Image generation failed' });
        }
      });
    }

    await pool.query(`UPDATE campaigns SET status = 'complete', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    send('campaign_done', { campaignId: req.params.id });
    // Stay open 90s for async image_done events, then close gracefully
    setTimeout(() => { clearInterval(keepalive); res.end(); }, 90000);
  } catch (err) {
    console.error('Campaign generate error:', err);
    clearInterval(keepalive);
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    res.end();
  }
});


// ── Stage 5: Compliance Gate
// Ensures compliance columns exist on any generated_content table (idempotent)
async function ensureComplianceColumns(tableName) {
  const cols = [
    ['review_mode',        'TEXT DEFAULT \'approve-to-ship\''],
    ['compliance_status',  'TEXT DEFAULT \'pending\''],
    ['compliance_report',  'JSONB'],
    ['reviewed_at',        'TIMESTAMPTZ'],
  ];
  for (const [col, def] of cols) {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});
  }
}

// ── Stage 5: Compliance Gate ─────────────────────────────────────────────

// GET latest draft article for a brand
app.get('/api/compliance/latest/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;
    // Check if content table exists before querying
    const tableCheck = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [tableName]
    );
    if (!tableCheck.rows.length) {
      return res.json({ success: true, articles: [], message: 'No content generated yet. Run the Content Generator first to create articles for compliance review.' });
    }
    await ensureComplianceColumns(tableName);
    const result = await pool.query(
      `SELECT * FROM ${tableName} ORDER BY created_at DESC LIMIT 10`
    );
    res.json({ success: true, articles: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST compliance critique — Claude reads article + brain mistakes, returns report
app.post('/api/compliance/rewrite-section', requireAuth, async (req, res) => {
  const { sectionBody, suggestion, brandProfileId } = req.body;
  if (!sectionBody || !suggestion) return res.status(400).json({ error: 'sectionBody and suggestion required' });
  try {
    const profileRes = brandProfileId
      ? await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId])
      : { rows: [] };
    const voiceHint = profileRes.rows[0]?.profile_data?.voice_profile?.tone
      ? `Brand tone: ${profileRes.rows[0].profile_data.voice_profile.tone}.`
      : '';
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are an editorial AI. Rewrite the following article section to incorporate the editorial suggestion. Preserve the author's voice and intent. Return only the rewritten section body — no commentary, no preamble, no labels.\n\n${voiceHint}\n\nORIGINAL SECTION:\n${sectionBody}\n\nEDITORIAL SUGGESTION:\n${suggestion}\n\nREWRITTEN SECTION:` }]
    });
    const rewritten = response.content[0]?.text?.trim();
    if (!rewritten) return res.status(500).json({ success: false, error: 'AI returned empty response' });
    res.json({ success: true, rewritten });
  } catch (e) {
    console.error('[REWRITE-SECTION]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});


// POST /api/compliance/rewrite-selection — AI rewrites only the selected text per user instruction
app.post('/api/compliance/rewrite-selection', requireAuth, async (req, res) => {
  const { selectedText, instruction, fullSectionText, sectionHeading, brandProfileId } = req.body;
  if (!selectedText || !instruction) return res.status(400).json({ error: 'selectedText and instruction required' });
  try {
    // Load brand voice profile
    const profileRes = brandProfileId
      ? await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId])
      : { rows: [] };
    const voiceProfile = profileRes.rows[0]?.profile_data?.voiceProfile || profileRes.rows[0]?.profile_data?.voice_profile || null;

    let voiceBlock = '';
    if (voiceProfile) {
      voiceBlock = `\nBRAND VOICE:\n${voiceProfile.summary || ''}`;
      if (voiceProfile.toneAttributes?.length) {
        voiceBlock += `\nTone: ${voiceProfile.toneAttributes.map((t) => `${t.attribute} (${t.score}/10)`).join(', ')}`;
      }
      if (voiceProfile.writingStyle) voiceBlock += `\nStyle: ${voiceProfile.writingStyle}`;
    }

    // Load brain mistakes for this brand
    let mistakesBlock = '';
    try {
      const mistakesRes = await pool.query(
        'SELECT mistake_type, description, human_feedback FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20',
        [brandProfileId]
      );
      if (mistakesRes.rows.length) {
        mistakesBlock = '\nKNOWN MISTAKES TO AVOID:\n' + mistakesRes.rows.map((m) => `- ${m.description}${m.human_feedback ? ' → ' + m.human_feedback : ''}`).join('\n');
      }
    } catch {}

    const systemPrompt = `You are a precision editor. Rewrite ONLY the selected text according to the user's instruction.${voiceBlock}${mistakesBlock}

RULES:
- Return ONLY the rewritten text, nothing else
- No preamble, no labels, no commentary
- Preserve the same approximate length unless the instruction implies otherwise
- Maintain the brand voice described above
- Do not change meaning unless the instruction asks for it
- Match the surrounding context's tone and tense`;

    const userPrompt = `SECTION: "${sectionHeading || 'Untitled'}"\n\nFULL SECTION CONTEXT:\n${fullSectionText || ''}\n\nSELECTED TEXT TO REWRITE:\n"${selectedText}"\n\nINSTRUCTION:\n${instruction}\n\nReturn only the rewritten text:`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const rewrittenText = response.content[0]?.text?.trim();
    if (!rewrittenText) return res.status(500).json({ success: false, error: 'AI returned empty response' });

    // Feed the brain: every user correction is a signal of what the writer got wrong
    if (brandProfileId) {
      pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [
          brandProfileId,
          'user_rewrite',
          `AI wrote: "${selectedText.slice(0, 400)}"${sectionHeading ? ` (in section: ${sectionHeading})` : ''}`,
          `User instruction: "${instruction.slice(0, 400)}" | Corrected to: "${rewrittenText.slice(0, 400)}"`,
          'medium'
        ]
      ).catch(e => console.error('[REWRITE-BRAIN] mistake log error:', e.message));
      console.log(`[REWRITE-BRAIN] Logged correction for brand ${brandProfileId}`);
    }

    res.json({ success: true, rewrittenText });
  } catch (e) {
    console.error('[REWRITE-SELECTION]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/compliance/find-sources', requireAuth, async (req, res) => {
  const { claim, sectionBody } = req.body;
  if (!claim && !sectionBody) return res.status(400).json({ error: 'claim or sectionBody required' });
  try {
    const query = (claim || sectionBody || '').slice(0, 200);

    // Perplexity sonar — use search_results directly, no JSON parsing needed
    let sonarData = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const sonarRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            { role: 'system', content: 'You are a research assistant. Find credible sources.' },
            { role: 'user', content: `Find research, statistics, or studies supporting: "${query}"` }
          ]
        })
      });
      if (sonarRes.status === 429) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!sonarRes.ok) {
        const err = await sonarRes.text();
        console.error('[FIND-SOURCES] Perplexity', sonarRes.status, err.slice(0, 200));
        return res.status(500).json({ success: false, error: `Source search failed (${sonarRes.status}) — try again` });
      }
      sonarData = await sonarRes.json();
      break;
    }

    if (!sonarData) return res.status(500).json({ success: false, error: 'Source search timed out — try again' });

    // search_results has everything we need — title, url, snippet, date
    const searchResults = sonarData.search_results || [];
    const sources = searchResults.slice(0, 3).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.snippet || '',
      year: r.date ? r.date.slice(0, 4) : (r.last_updated ? r.last_updated.slice(0, 4) : ''),
    }));

    if (!sources.length) return res.json({ success: false, error: 'No sources found — try a different section' });

    res.json({ success: true, sources: sources.slice(0, 3) });
  } catch (e) {
    console.error('[FIND-SOURCES] caught:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/compliance/rewrite-section — AI rewrites one section using a compliance suggestion

app.post('/api/compliance/critique', requireAuth, async (req, res) => {
  const { brandProfileId, contentId } = req.body;
  if (!brandProfileId || !contentId) return res.status(400).json({ error: 'brandProfileId and contentId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;

    await ensureComplianceColumns(tableName);
    // Load article
    const articleRes = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!articleRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = articleRes.rows[0];
    const articleJson = article.article_json;

    // Load brand profile + brain mistakes
    const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const brand = brandRes.rows[0];
    const mistakesRes = await pool.query(`SELECT * FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20`, [brandProfileId]).catch(() => ({ rows: [] }));
    const mistakes = mistakesRes.rows;

    const systemPrompt = `You are a compliance and brand voice auditor for the brand "${brand?.brand_name || 'Unknown'}". Analyze this article against the brand profile and known mistakes. Return a JSON compliance report.

The article was written for the brand "${brand?.brand_name || 'Unknown'}" (${brand?.brand_url || 'no URL'}). Do NOT flag brand name usage that correctly references this brand.

CRITICAL RULES:
- ONLY flag claims, phrases, or issues that are EXPLICITLY present in the article text being audited. Do NOT reference, cite, or cross-reference content from other articles, briefs, GEO reports, or any source outside this specific article.
- Every flag must include a "flaggedExcerpt" field containing the EXACT quote from the article that triggered the flag. If you cannot quote it verbatim from THIS article, do not flag it.
- Do NOT hallucinate or infer content. If a section contains no issues, do not flag it.
- The "Known Mistakes" below are BEHAVIORAL PATTERNS to watch for (e.g. "avoid truncated sentences"). They are NOT evidence or sources. Never cite a Known Mistake as proof that a claim exists elsewhere or needs sourcing.
- When flagging a factual claim, explain why the CLAIM ITSELF is unverifiable based on what appears in the article — do not say "referenced in an internal brief" or "found elsewhere in the system."
- SECTION ISOLATION: Each flag must reference content from ONLY the section it is assigned to (by sectionIndex). Do not flag Section 5 for something that appears in Section 4. The flaggedExcerpt must be a verbatim quote from the section identified by the sectionIndex — not from any other section.

Brand Voice Profile:
${JSON.stringify(brand?.profile_data?.voice_profile || {}, null, 2)}

Known Mistakes to Avoid:
${mistakes.map(m => `- ${m.mistake_type}: ${m.human_feedback}`).join('\n') || 'None recorded yet'}

Return ONLY valid JSON in this exact structure:
{
  "overallScore": <0-100>,
  "brandVoiceScore": <0-100>,
  "factualConfidence": <0-100>,
  "autoApprovable": <true if all sections green>,
  "summary": "<2 sentence overall assessment>",
  "flags": [
    {
      "sectionIndex": <zero-based index of the section in the sections array — first section is 0, second is 1, etc>,
      "sectionHeading": "<heading>",
      "severity": "yellow" | "red",
      "type": "brand_voice" | "factual_claim" | "legal_risk" | "sme_required",
      "flaggedExcerpt": "<exact quote from the article that triggered this flag>",
      "reason": "<why flagged>",
      "suggestion": "<recommended fix>"
    }
  ],
  "mistakesApplied": ["<list of mistake patterns that influenced this critique>"]
}`;

    const critiqueRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Article to audit:\n\n${(() => {
          const sections = articleJson?.sections || [];
          return sections.map((s, i) => `[SECTION ${i}] heading: ${s.heading || s.title || 'Untitled'}\n${s.body || s.content || ''}`).join('\n\n---\n\n');
        })()}` }]
      })
    });
    const critiqueData = await critiqueRes.json();
    const rawText = critiqueData.content?.[0]?.text || '{}';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const report = safeParseLLM(rawText, 'object', 'compliance-gate');

    // Normalise sectionIndex to 0-based — Claude sometimes returns 1-based
    if (report.flags?.length && articleJson?.sections?.length) {
      const maxIdx = articleJson.sections.length - 1;
      const anyExceedsBounds = report.flags.some(f => f.sectionIndex > maxIdx);
      if (anyExceedsBounds) {
        report.flags = report.flags.map(f => ({ ...f, sectionIndex: Math.max(0, f.sectionIndex - 1) }));
      }
    }

    // Persist compliance report to article record
    await pool.query(
      `UPDATE ${tableName} SET compliance_report = $1, compliance_status = 'reviewed', updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(report), contentId]
    );

    res.json({ success: true, report });
  } catch (err) {
    console.error('[COMPLIANCE] Critique error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── X (Twitter) OAuth 2.0 with PKCE ──────────────────────────────────────────
const xOAuthStates = new Map(); // state → { brandProfileId, codeVerifier }

app.get('/api/x/auth', requireAuth, (req, res) => {
  const brandProfileId = req.query.brandProfileId || req.query.state?.split('|')[0] || 'system';
  const clientId = process.env.X_OAUTH2CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'X_OAUTH2CLIENT_ID not configured' });

  // PKCE: generate code_verifier and code_challenge
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  xOAuthStates.set(state, { brandProfileId, codeVerifier });
  // Clean up after 10 min
  setTimeout(() => xOAuthStates.delete(state), 600000);

  const redirectUri = process.env.X_REDIRECT_URI || `https://${req.headers.host}/auth/x/callback`;
  const scopes = ['tweet.write', 'tweet.read', 'users.read', 'offline.access'].join('%20');
  const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  res.json({ authUrl });
});

app.get('/auth/x/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/app/integrations?x_error=${error}`);
  if (!code || !state) return res.redirect('/app/integrations?x_error=no_code');

  const stateData = xOAuthStates.get(state);
  if (!stateData) return res.redirect('/app/integrations?x_error=invalid_state');
  xOAuthStates.delete(state);

  const { brandProfileId, codeVerifier } = stateData;
  const clientId = process.env.X_OAUTH2CLIENT_ID;
  const clientSecret = process.env.X_OAUTH2CLIENT_SECRET;
  const redirectUri = process.env.X_REDIRECT_URI || `https://${req.headers.host}/auth/x/callback`;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');

    // Get user info
    let username = '';
    try {
      const meRes = await fetch('https://api.twitter.com/2/users/me', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        username = meData.data?.username || '';
      }
    } catch(e) { console.log('[X-OAUTH] User lookup failed:', e.message); }

    // Store credentials
    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, 'x', $2, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = $2, is_active = true, updated_at = NOW()
    `, [brandProfileId, JSON.stringify({
      oauth2AccessToken: tokenData.access_token,
      oauth2RefreshToken: tokenData.refresh_token,
      oauth2ExpiresIn: tokenData.expires_in,
      oauth2Scope: tokenData.scope,
      username,
      connectedAt: new Date().toISOString()
    })]);

    res.redirect(`/app/integrations?x_connected=true`);
  } catch(err) {
    console.error('[X-OAUTH]', err.message);
    res.redirect(`/app/integrations?x_error=${encodeURIComponent(err.message)}`);
  }
});

// Helper: refresh X OAuth 2.0 token
async function refreshXOAuth2Token(refreshToken) {
  const clientId = process.env.X_OAUTH2CLIENT_ID;
  const clientSecret = process.env.X_OAUTH2CLIENT_SECRET;
  const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  const data = await tokenRes.json();
  if (!data.access_token) throw new Error(data.error_description || 'X token refresh failed');
  return data;
}

// POST dismiss-flag — user dismisses a false-positive flag, writes to brain as training signal
app.post('/api/compliance/dismiss-flag', requireAuth, async (req, res) => {
  const { brandProfileId, contentId, flagType, flagReason, sectionHeading } = req.body;
  if (!brandProfileId || !contentId) return res.status(400).json({ error: 'brandProfileId and contentId required' });
  try {
    await pool.query(
      `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
       VALUES ($1, 'false_positive_flag', $2, $3, 'low')`,
      [
        brandProfileId,
        `AI incorrectly flagged section "${sectionHeading || 'untitled'}" as ${flagType || 'unknown'} — user dismissed`,
        `False positive: ${(flagReason || '').substring(0, 500)}. Do NOT flag similar content in future critiques for this brand.`
      ]
    );
    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms)
       VALUES ('compliance_dismiss', $1, 'success', 0, 0)`,
      [brandProfileId]
    ).catch(() => {});
    res.json({ success: true });
  } catch(e) {
    console.error('[COMPLIANCE] Dismiss flag error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST approve — save human edits, write mistakes to brain, mark approved
app.post('/api/compliance/approve', requireAuth, async (req, res) => {
  const startTime = Date.now();
  const { brandProfileId, contentId, reviewMode, editedSections, decisions } = req.body;
  if (!brandProfileId || !contentId) return res.status(400).json({ error: 'brandProfileId and contentId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;

    await ensureComplianceColumns(tableName);
    // Load original article
    const articleRes = await pool.query(`SELECT * FROM ${tableName} WHERE id = $1`, [contentId]);
    if (!articleRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = articleRes.rows[0];
    let articleJson = article.article_json;

    // Apply human edits to article sections
    if (editedSections && Array.isArray(editedSections)) {
      editedSections.forEach(edit => {
        if (articleJson.sections && articleJson.sections[edit.sectionIndex]) {
          const section = articleJson.sections[edit.sectionIndex];
          const orig = section.body || section.content || '';
          if (orig !== edit.content) {
            // Write to brain_mistakes (brand-scoped)
            pool.query(
              `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
               VALUES ($1, 'human_edit', $2, $3, 'medium')`,
              [
                brandProfileId,
                `Section "${section.heading || 'untitled'}": human reviewer edited content`,
                `Avoid: "${orig.substring(0, 200)}" — prefer: "${edit.content.substring(0, 200)}"`
              ]
            ).catch(e => console.error('[COMPLIANCE] Mistake write error:', e.message));
            // Update whichever field exists
            if (section.body !== undefined) {
              articleJson.sections[edit.sectionIndex].body = edit.content;
            } else {
              articleJson.sections[edit.sectionIndex].content = edit.content;
            }
          }
        }
      });
    }

    // Handle red section decisions
    const finalStatus = reviewMode === 'auto-ship' ? 'approved' :
      decisions && Object.values(decisions).some(d => d === 'rejected') ? 'rejected' : 'approved';

    // Final safety net — strip any LLM scaffolding that slipped past human review
    articleJson = stripScaffoldingArtifacts(articleJson);

    await pool.query(
      `UPDATE ${tableName} SET article_json = $1, compliance_status = $2, review_mode = $3, reviewed_at = NOW(), updated_at = NOW() WHERE id = $4`,
      [JSON.stringify(articleJson), finalStatus, reviewMode || 'approve-to-ship', contentId]
    );

    // Auto-stage into publishing queue on approval
    if (finalStatus === 'approved') {
      const articleTitle = articleJson.title || article.title || 'Untitled Article';
      pool.query(
        `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'staged', NOW(), NOW())
         ON CONFLICT (content_id) DO UPDATE SET
           title = EXCLUDED.title,
           updated_at = NOW()
         WHERE publishing_queue.status = 'staged'`,
        [brandProfileId, contentId, articleTitle]
      ).catch(e => console.error('[QUEUE] Auto-stage error:', e.message));
    }

        await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage5_compliance_gate', brandProfileId, 'success', 0, Date.now()-startTime]).catch(e => console.error('[ACTIVITY LOG]', e.message));
        res.json({ success: true, status: finalStatus, contentId });
  } catch (err) {
    console.error('[COMPLIANCE] Approve error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Stage 6: Publishing & Distribution ───────────────────────────────────────

// Resolve UTM tokens against article + brand context
function resolveUtmParams(template, ctx) {
  const resolved = {};
  for (const [k, v] of Object.entries(template)) {
    resolved[k] = v
      .replace('{campaign_slug}', ctx.campaignSlug || 'forge')
      .replace('{article_slug}', ctx.articleSlug || 'article')
      .replace('{brand_slug}', ctx.brandSlug || 'brand')
      .replace('{channel}', ctx.channel || k);
  }
  return resolved;
}

function buildUtmString(params) {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}


// GET /api/public/articles — list published articles (for public library)
app.get('/api/public/articles', async (req, res) => {
  const { brandSlug } = req.query;
  try {
    let brandFilter = '';
    let brandName = '';
    let values = [];

    if (brandSlug) {
      // Find the brand by slug (derived from brand_url)
      const brandRes = await pool.query(`
        SELECT id, brand_name, brand_url FROM brand_profiles 
        WHERE LOWER(REGEXP_REPLACE(brand_url, '[^a-zA-Z0-9]', '-', 'g')) LIKE $1
        OR LOWER(REGEXP_REPLACE(COALESCE(brand_name, ''), '[^a-zA-Z0-9]', '-', 'g')) LIKE $1
        LIMIT 1
      `, [`%${brandSlug.toLowerCase()}%`]);
      
      if (brandRes.rows.length > 0) {
        brandFilter = 'AND pq.brand_profile_id = $1';
        values = [brandRes.rows[0].id];
        brandName = brandRes.rows[0].brand_name || brandRes.rows[0].brand_url;
      }
    }

    // Get published articles from publishing_queue with status 'published'
    const articlesRes = await pool.query(`
      SELECT 
        pq.id,
        pq.content_id,
        pq.title,
        pq.brand_profile_id,
        pq.published_at,
        pq.hero_image_url,
        bp.brand_name,
        bp.brand_url
      FROM publishing_queue pq
      LEFT JOIN brand_profiles bp ON bp.id = pq.brand_profile_id
      WHERE pq.status = 'published' ${brandFilter}
      ORDER BY pq.published_at DESC NULLS LAST, pq.created_at DESC
      LIMIT 50
    `, values);

    const articles = await Promise.all(articlesRes.rows.map(async (row) => {
      // Build slugs
      const brandSlugVal = (row.brand_url || row.brand_name || 'brand')
        .replace(/https?:\/\//i, '')
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase()
        .replace(/^-+|-+$/g, '');
      
      const articleSlug = (row.title || 'article')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

      // Try to get meta description from generated content
      let metaDescription = '';
      if (row.content_id && row.brand_profile_id) {
        try {
          const safeId = row.brand_profile_id.replace(/-/g, '_');
          const contentRes = await pool.query(
            `SELECT article_json FROM generated_content_${safeId} WHERE id = $1`,
            [row.content_id]
          );
          if (contentRes.rows.length > 0) {
            const articleJson = contentRes.rows[0].article_json || {};
            metaDescription = articleJson.metaDescription || '';
          }
        } catch {}
      }

      return {
        id: row.id,
        title: row.title,
        metaDescription,
        brandSlug: brandSlugVal,
        articleSlug,
        brandName: row.brand_name || row.brand_url || 'Unknown',
        publishedAt: row.published_at,
        heroImageUrl: row.hero_image_url
      };
    }));

    res.json({ success: true, articles, brandName });
  } catch (err) {
    console.error('[Public Articles]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/publishing/queue/:brandProfileId
app.get('/api/publishing/queue/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    // Base queue items
    const result = await pool.query(
      `SELECT pq.*,
              c.name        AS campaign_name,
              c.topic_cluster AS campaign_topic,
              c.status      AS campaign_status,
              bp.brand_url  AS brand_url,
              bp.brand_name AS brand_name
       FROM publishing_queue pq
       LEFT JOIN campaigns c ON c.id = pq.campaign_id
       LEFT JOIN brand_profiles bp ON bp.id = pq.brand_profile_id
       WHERE pq.brand_profile_id = $1
       ORDER BY pq.campaign_id NULLS LAST, pq.created_at ASC`,
      [brandProfileId]
    );

    const items = result.rows;

    // For campaign articles, enrich with week/publish_day/angle from generated_content + campaign_articles
    const safeId = brandProfileId.replace(/-/g, '_');
    const campaignItemIds = items
      .filter(i => i.campaign_id && i.content_id)
      .map(i => i.content_id);

    let angleMap = {};
    if (campaignItemIds.length > 0) {
      // Get campaign_article_index from generated_content
      const gcRes = await pool.query(
        `SELECT id::text, campaign_article_index FROM generated_content_${safeId}
         WHERE id::text = ANY($1) AND campaign_article_index IS NOT NULL`,
        [campaignItemIds]
      ).catch(() => ({ rows: [] }));

      // Build a map of content_id -> article_index
      const indexMap = {};
      for (const row of gcRes.rows) indexMap[row.id] = row.campaign_article_index;

      // For each campaign, get angle_profiles from campaign_articles
      const campaignIds = [...new Set(items.filter(i => i.campaign_id).map(i => i.campaign_id))];
      for (const campId of campaignIds) {
        const caRes = await pool.query(
          `SELECT article_index, angle_profile, week_number FROM campaign_articles WHERE campaign_id = $1`,
          [campId]
        ).catch(() => ({ rows: [] }));
        for (const ca of caRes.rows) {
          angleMap[`${campId}:${ca.article_index}`] = {
            week_number: ca.week_number,
            angle: ca.angle_profile
          };
        }
      }

      // Attach angle data to each item
      for (const item of items) {
        if (item.campaign_id && item.content_id) {
          const idx = indexMap[item.content_id];
          if (idx !== undefined) {
            const key = `${item.campaign_id}:${idx}`;
            const meta = angleMap[key];
            if (meta) {
              item.campaign_article_index = idx;
              item.week_number = meta.week_number;
              item.publish_day = meta.angle?.publish_day || null;
              item.content_type = meta.angle?.content_type || null;
              item.funnel_position = meta.angle?.funnel_position || null;
              item.primary_persona = meta.angle?.primary_persona || null;
            }
          }
        }
      }
    }

    // Fetch Pre-cog scores for all items
    const contentIds = items.filter(i => i.content_id).map(i => i.content_id);
    if (contentIds.length > 0) {
      const precogRes = await pool.query(
        `SELECT id::text, precog_score FROM generated_content_${safeId} WHERE id::text = ANY($1)`,
        [contentIds]
      ).catch(() => ({ rows: [] }));
      const precogMap = {};
      for (const row of precogRes.rows) precogMap[row.id] = row.precog_score;
      for (const item of items) {
        if (item.content_id && precogMap[item.content_id] !== undefined) {
          item.precog_score = precogMap[item.content_id];
        }
      }
    }

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/publishing/queue (all brands — for global queue view)
// POST /api/publishing/backfill-queue — manually stage all approved articles not yet in the queue
app.post('/api/publishing/backfill-queue', async (req, res) => {
  try {
    const bpRows = await pool.query(`SELECT id FROM brand_profiles WHERE is_active = true`);
    let totalStaged = 0;
    for (const bp of bpRows.rows) {
      const safeId = bp.id.replace(/-/g, '_');
      const tableName = `generated_content_${safeId}`;
      const tableExists = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [tableName]
      );
      if (!tableExists.rows.length) continue;
      const approved = await pool.query(
        `SELECT id, title FROM ${tableName} WHERE compliance_status = 'approved'`
      ).catch(() => ({ rows: [] }));
      for (const art of approved.rows) {
        const r = await pool.query(
          `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'staged', NOW(), NOW())
           ON CONFLICT (content_id) DO NOTHING`,
          [bp.id, art.id, art.title || 'Untitled']
        ).catch(() => ({ rowCount: 0 }));
        if (r.rowCount > 0) totalStaged++;
      }
    }
    res.json({ success: true, staged: totalStaged });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/publishing/backfill-queue — manually stage all approved articles not yet in the queue
app.post('/api/publishing/backfill-queue', async (req, res) => {
  try {
    const bpRows = await pool.query(`SELECT id FROM brand_profiles WHERE is_active = true`);
    let totalStaged = 0;
    for (const bp of bpRows.rows) {
      const safeId = bp.id.replace(/-/g, '_');
      const tableName = `generated_content_${safeId}`;
      const tableExists = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [tableName]
      );
      if (!tableExists.rows.length) continue;
      const approved = await pool.query(
        `SELECT id, title FROM ${tableName} WHERE compliance_status = 'approved'`
      ).catch(() => ({ rows: [] }));
      for (const art of approved.rows) {
        const r = await pool.query(
          `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'staged', NOW(), NOW())
           ON CONFLICT (content_id) DO NOTHING`,
          [bp.id, art.id, art.title || 'Untitled']
        ).catch(() => ({ rowCount: 0 }));
        if (r.rowCount > 0) totalStaged++;
      }
    }
    res.json({ success: true, staged: totalStaged });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/publishing/backfill-queue — manually stage all approved articles not yet in the queue
app.post('/api/publishing/backfill-queue', async (req, res) => {
  try {
    const bpRows = await pool.query(`SELECT id FROM brand_profiles WHERE is_active = true`);
    let totalStaged = 0;
    for (const bp of bpRows.rows) {
      const safeId = bp.id.replace(/-/g, '_');
      const tableName = `generated_content_${safeId}`;
      const tableExists = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [tableName]
      );
      if (!tableExists.rows.length) continue;
      const approved = await pool.query(
        `SELECT id, title FROM ${tableName} WHERE compliance_status = 'approved'`
      ).catch(() => ({ rows: [] }));
      for (const art of approved.rows) {
        const r = await pool.query(
          `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'staged', NOW(), NOW())
           ON CONFLICT (content_id) DO NOTHING`,
          [bp.id, art.id, art.title || 'Untitled']
        ).catch(() => ({ rowCount: 0 }));
        if (r.rowCount > 0) totalStaged++;
      }
    }
    res.json({ success: true, staged: totalStaged });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/publishing/queue', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pq.*, bp.brand_name, bp.brand_url
       FROM publishing_queue pq
       LEFT JOIN brand_profiles bp ON bp.id = pq.brand_profile_id
       ORDER BY pq.created_at DESC LIMIT 100`
    );
    res.json({ success: true, items: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/publishing/queue/:itemId
app.patch('/api/publishing/queue/:itemId', async (req, res) => {
  const { itemId } = req.params;
  const { channels, scheduledAt, status, publishResults } = req.body;
  try {
    const fields = [];
    const vals = [];
    let i = 1;
    if (channels !== undefined) { fields.push(`channels = $${i++}`); vals.push(JSON.stringify(channels)); }
    if (scheduledAt !== undefined) { fields.push(`scheduled_at = $${i++}`); vals.push(scheduledAt || null); }
    if (status !== undefined) { fields.push(`status = $${i++}`); vals.push(status); }
    if (publishResults !== undefined) {
      // Merge into existing publish_results, not overwrite
      fields.push(`publish_results = COALESCE(publish_results, '{}'::jsonb) || $${i++}::jsonb`);
      vals.push(JSON.stringify(publishResults));
    }
    fields.push(`updated_at = NOW()`);
    vals.push(itemId);
    await pool.query(`UPDATE publishing_queue SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/publishing/queue/:itemId — removes from Forge queue only
app.delete('/api/publishing/queue/:itemId', requireAuth, async (req, res) => {
  const { itemId } = req.params;
  try {
    await pool.query('DELETE FROM publishing_queue WHERE id = $1', [itemId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/publishing/queue/:id/reset-channel — clear error state for one channel
app.post('/api/publishing/queue/:id/reset-channel', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  try {
    // Remove this channel from publish_results so the card goes back to staged
    const row = await pool.query('SELECT publish_results, brand_profile_id FROM publishing_queue WHERE id = $1', [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Not found' });
    const results = row.rows[0].publish_results || {};
    delete results[channel];
    // If no channels left, reset status to staged
    const hasAnyPublished = Object.values(results).some((r) => r && r.status === 'published');
    const newStatus = hasAnyPublished ? 'partial' : 'staged';
    await pool.query(
      'UPDATE publishing_queue SET publish_results = $1, status = $2, updated_at = NOW() WHERE id = $3',
      [JSON.stringify(results), newStatus, id]
    );
    // Clear from publish_log — single shared table
    await pool.query(
      'DELETE FROM publish_log WHERE queue_item_id = $1 AND channel = $2',
      [id, channel]
    ).catch(() => {});
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/publishing/unpublish — delete from live channel + optionally remove from queue
app.post('/api/publishing/unpublish', requireAuth, async (req, res) => {
  const { queueItemId, channel, deleteFromChannel = true, removeFromQueue = false } = req.body;
  if (!queueItemId || !channel) return res.status(400).json({ error: 'queueItemId and channel required' });

  try {
    // Load publish log entry for this channel
    const logRes = await pool.query(
      'SELECT pl.*, pc.credentials FROM publish_log pl LEFT JOIN publishing_channels pc ON pc.brand_profile_id = pl.brand_profile_id AND pc.channel = pl.channel WHERE pl.queue_item_id = $1 AND pl.channel = $2 ORDER BY pl.attempted_at DESC LIMIT 1',
      [queueItemId, channel]
    );
    if (!logRes.rows.length) return res.status(404).json({ error: 'No publish log entry found for this channel' });
    const row = logRes.rows[0];
    const creds = row.credentials || {};
    let channelResult = { deleted: false, message: 'Not attempted' };

    if (deleteFromChannel) {
      try {
        if (channel === 'linkedin') {
          const postId = row.response_data?.postId || row.published_url?.split('/').pop();
          const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
          if (!postId || !token) throw new Error('Missing LinkedIn post ID or token');
          const encodedId = encodeURIComponent(postId);
          const delRes = await fetch(`https://api.linkedin.com/v2/ugcPosts/${encodedId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' }
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`LinkedIn delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from LinkedIn' };

        } else if (channel === 'x') {
          const tweetId = row.response_data?.tweetId
            || (row.published_url?.match(/\/status\/(\d+)/)?.[1]);
          const { accessToken, accessSecret } = creds;
          const apiKey    = creds.apiKey    || process.env.X_OAUTH1CONSUMER_KEY;
          const apiSecret = creds.apiSecret || process.env.X_OAUTH1CONSUMER_SECRET;
          if (!tweetId) throw new Error('No tweet ID found');
          if (!apiKey || !apiSecret || !accessToken || !accessSecret) throw new Error('Missing X credentials');

          // OAuth 1.0a signature for DELETE
          const tweetUrl = `https://api.twitter.com/2/tweets/${tweetId}`;
          const authHeader = buildXOAuthHeader('DELETE', tweetUrl, apiKey, apiSecret, accessToken, accessSecret);

          const xDelRes = await fetch(tweetUrl, {
            method: 'DELETE',
            headers: { 'Authorization': authHeader }
          });
          if (!xDelRes.ok && xDelRes.status !== 404) throw new Error(`X delete failed: ${xDelRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from X' };

        } else if (channel === 'ghost') {
          const postId = row.response_data?.postId;
          const { adminUrl, adminApiKey } = creds;
          if (!postId || !adminUrl || !adminApiKey) throw new Error('Missing Ghost post ID or credentials');
          const [keyId, keySecret] = adminApiKey.split(':');
          const now = Math.floor(Date.now() / 1000);
          const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
          const p = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
          const sig = createHmac('sha256', Buffer.from(keySecret, 'hex')).update(`${h}.${p}`).digest('base64url');
          const jwt = `${h}.${p}.${sig}`;
          const ghostBase = adminUrl.replace(/\/+$/, '');
          const delRes = await fetch(`${ghostBase}/ghost/api/admin/posts/${postId}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Ghost ${jwt}`, 'Accept-Version': 'v5.0' }
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`Ghost delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from Ghost' };

        } else if (channel === 'wordpress') {
          const postId = row.response_data?.postId;
          const { siteUrl, username, appPassword } = creds;
          if (!postId || !siteUrl) throw new Error('Missing WordPress post ID or credentials');
          const wpUrl = siteUrl.replace(/\/+$/, '');
          const basicAuth = Buffer.from(`${username}:${appPassword}`).toString('base64');
          const delRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${postId}?force=true`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${basicAuth}` }
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`WordPress delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from WordPress' };

        } else if (channel === 'facebook') {
          const postId = row.response_data?.postId;
          const { pageAccessToken } = creds;
          if (!postId || !pageAccessToken) throw new Error('Missing Facebook post ID or token');
          const delRes = await fetch(`https://graph.facebook.com/v21.0/${postId}?access_token=${pageAccessToken}`, {
            method: 'DELETE'
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`Facebook delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from Facebook' };

        } else {
          channelResult = { deleted: false, message: `Channel ${channel} does not support remote delete` };
        }
      } catch (delErr) {
        channelResult = { deleted: false, message: delErr.message };
      }
    }

    // Update publish_log status — if user explicitly requested delete, mark deleted
    // regardless of whether the API call succeeded (expired token etc.)
    // This prevents sync from seeing 'published' and re-checking a post we've intentionally removed
    const finalStatus = deleteFromChannel ? 'deleted' : (channelResult.deleted ? 'deleted' : 'published');
    await pool.query(
      `UPDATE publish_log SET live_status = $1, last_synced_at = NOW()
       WHERE id = (
         SELECT id FROM publish_log
         WHERE queue_item_id = $2 AND channel = $3
         ORDER BY attempted_at DESC LIMIT 1
       )`,
      [finalStatus, queueItemId, channel]
    );

    // Recompute queue status from remaining live publish_log entries
    // Don't blindly set 'staged' — if other channels are still live, it's 'partial'
    const remainingLog = await pool.query(
      `SELECT live_status FROM publish_log WHERE queue_item_id = $1 AND (live_status IS NULL OR live_status != 'deleted')`,
      [queueItemId]
    ).catch(() => ({ rows: [] }));
    const anyStillLive = remainingLog.rows.some(r => !r.live_status || r.live_status === 'published');
    const recomputedStatus = anyStillLive ? 'partial' : 'staged';
    await pool.query(
      `UPDATE publishing_queue SET status = $1, updated_at = NOW() WHERE id = $2`,
      [recomputedStatus, queueItemId]
    ).catch(() => {});

    // If remove from queue entirely
    if (removeFromQueue) {
      await pool.query('DELETE FROM publishing_queue WHERE id = $1', [queueItemId]);
    }

    res.json({ success: true, channel, ...channelResult });
  } catch (err) {
    console.error('[UNPUBLISH]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/publishing/channels/:brandProfileId
app.get('/api/publishing/channels/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const result = await pool.query(
      `SELECT id, brand_profile_id, channel, credentials, utm_template, is_active, last_tested_at, test_status, created_at, updated_at
       FROM publishing_channels WHERE brand_profile_id = $1 ORDER BY channel`,
      [brandProfileId]
    );
    res.json({ success: true, channels: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/publishing/channels — upsert channel connection
app.post('/api/publishing/channels', requireAuth, async (req, res) => {
  const { brandProfileId, channel, credentials, utmTemplate } = req.body;
  if (!brandProfileId || !channel) return res.status(400).json({ error: 'brandProfileId and channel required' });
  try {
    const result = await pool.query(
      `INSERT INTO publishing_channels (brand_profile_id, channel, credentials, utm_template, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (brand_profile_id, channel)
       DO UPDATE SET credentials = $3, utm_template = $4, updated_at = NOW()
       RETURNING id`,
      [brandProfileId, channel, JSON.stringify(credentials || {}), JSON.stringify(utmTemplate || {})]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/publishing/channels/:id
app.delete('/api/publishing/channels/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM publishing_channels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/publishing/publish — publish a queue item to selected channels

// ── LinkedIn OAuth2 Flow ──────────────────────────────────────────────────────
app.get('/api/linkedin/auth', (req, res) => {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.LINKEDIN_REDIRECT_URI || 'https://forgeintelligence.ai/auth/linkedin/callback');
  const brandProfileId = req.query.state?.split('|')[0] || req.query.brandProfileId || 'system';
  const nonce = randomBytes(16).toString('hex');
  // Embed brandProfileId in state so callback knows which brand to save to
  const state = `${brandProfileId}|${nonce}`;
  const scopes = 'openid profile email w_member_social';
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scopes)}`;
  res.json({ authUrl: url });
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/app/integrations?linkedin_error=${error}`);
  if (!code) return res.redirect('/app/integrations?linkedin_error=no_code');
  try {
    const clientId     = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const redirectUri  = process.env.LINKEDIN_REDIRECT_URI || 'https://forgeintelligence.ai/auth/linkedin/callback';
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'Token exchange failed');

    // Get LinkedIn member profile (sub = member URN for posting)
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    const personUrn = `urn:li:person:${profile.sub}`;

    // Fetch company pages user is admin of
    let companyPages = [];
    try {
      const orgsRes = await fetch('https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organizationalTarget~))', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      if (orgsRes.ok) {
        const orgsData = await orgsRes.json();
        companyPages = (orgsData.elements || []).map(el => {
          const org = el['organizationalTarget~'] || {};
          const orgUrn = el.organizationalTarget; // e.g. urn:li:organization:12345
          return {
            urn: orgUrn,
            name: org.localizedName || org.name || 'Company Page',
            vanityName: org.vanityName || null,
            logoUrl: org.logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]?.identifier || null
          };
        });
      }
    } catch (orgErr) {
      console.log('[LinkedIn] Could not fetch orgs (user may not be admin of any):', orgErr.message);
    }

    // Parse brandProfileId from state param
    const stateDecoded = decodeURIComponent(state || '');
    const brandProfileId = stateDecoded.includes('|') ? stateDecoded.split('|')[0] : 'system';

    // Build available targets (personal + company pages)
    const availableTargets = [
      { type: 'personal', urn: personUrn, name: profile.name || 'Personal Profile' },
      ...companyPages.map(p => ({ type: 'company', urn: p.urn, name: p.name, vanityName: p.vanityName, logoUrl: p.logoUrl }))
    ];

    // Default to personal profile, user can switch later
    const selectedTarget = availableTargets[0];

    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, 'linkedin', $2, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = $2, is_active = true, updated_at = NOW()
    `, [brandProfileId, JSON.stringify({
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in,
      authorUrn: selectedTarget.urn,
      selectedTarget,
      availableTargets,
      name: profile.name
    })]);

    res.redirect('/app/integrations?linkedin_connected=true');
  } catch (err) {
    console.error('LinkedIn callback error:', err);
    res.redirect(`/app/integrations?linkedin_error=${encodeURIComponent(err.message)}`);
  }
});


// ── LinkedIn ORG OAuth (Company Pages - separate app required by LinkedIn) ───
app.get('/api/linkedin/org/auth', (req, res) => {
  const clientId = process.env.LINKEDIN_ORG_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'LINKEDIN_ORG_CLIENT_ID not configured' });
  const redirectUri = encodeURIComponent(process.env.LINKEDIN_ORG_REDIRECT_URI || 'https://forgeintelligence.ai/auth/linkedin/org/callback');
  const brandProfileId = req.query.state?.split('|')[0] || req.query.brandProfileId || 'system';
  const nonce = randomBytes(16).toString('hex');
  const state = `${brandProfileId}|${nonce}`;
  const scopes = 'w_organization_social_feed r_organization_social_feed';
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scopes)}`;
  res.redirect(url);
});

app.get('/auth/linkedin/org/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/app/integrations?linkedin_error=${error}`);
  if (!code) return res.redirect('/app/integrations?linkedin_error=no_code');
  try {
    const clientId = process.env.LINKEDIN_ORG_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_ORG_SECRET;
    const redirectUri = process.env.LINKEDIN_ORG_REDIRECT_URI || 'https://forgeintelligence.ai/auth/linkedin/org/callback';
    
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'Token exchange failed');

    // Fetch company pages user is admin of
    const orgsRes = await fetch('https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organizationalTarget~))', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    if (!orgsRes.ok) throw new Error('Failed to fetch organizations');
    
    const orgsData = await orgsRes.json();
    const companyPages = (orgsData.elements || []).map(el => {
      const org = el['organizationalTarget~'] || {};
      const orgUrn = el.organizationalTarget;
      return {
        type: 'company',
        urn: orgUrn,
        name: org.localizedName || org.name || 'Company Page',
        vanityName: org.vanityName || null,
        logoUrl: org.logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]?.identifier || null
      };
    });

    if (companyPages.length === 0) {
      return res.redirect('/app/integrations?linkedin_error=no_company_pages');
    }

    const stateDecoded = decodeURIComponent(state || '');
    const brandProfileId = stateDecoded.includes('|') ? stateDecoded.split('|')[0] : 'system';

    // Default to first company page
    const selectedTarget = companyPages[0];

    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, 'linkedin_org', $2, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = $2, is_active = true, updated_at = NOW()
    `, [brandProfileId, JSON.stringify({
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in,
      connectedAt: new Date().toISOString(),
      authorUrn: selectedTarget.urn,
      availableTargets: companyPages,
      selectedTarget: selectedTarget
    })]);

    res.redirect('/app/integrations?linkedin_org_connected=true');
  } catch (err) {
    console.error('LinkedIn Org callback error:', err);
    res.redirect(`/app/integrations?linkedin_error=${encodeURIComponent(err.message)}`);
  }
});

// ── LinkedIn: Switch posting target (personal vs company page) ───────────────
app.post('/api/linkedin/select-target', requireAuth, async (req, res) => {
  const { brandProfileId, targetUrn } = req.body;
  if (!brandProfileId || !targetUrn) return res.status(400).json({ error: 'brandProfileId and targetUrn required' });
  try {
    const existing = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'linkedin'`,
      [brandProfileId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'LinkedIn not connected' });
    
    const creds = existing.rows[0].credentials;
    const target = (creds.availableTargets || []).find(t => t.urn === targetUrn);
    if (!target) return res.status(400).json({ error: 'Invalid target URN' });

    creds.authorUrn = targetUrn;
    creds.selectedTarget = target;
    
    await pool.query(
      `UPDATE publishing_channels SET credentials = $1, updated_at = NOW() WHERE brand_profile_id = $2 AND channel = 'linkedin'`,
      [JSON.stringify(creds), brandProfileId]
    );
    
    res.json({ success: true, selectedTarget: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────


// ── HubSpot OAuth ────────────────────────────────────────────────────────────
app.get('/api/hubspot/auth', (req, res) => {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'HUBSPOT_CLIENT_ID not configured' });
  
  const redirectUri = encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI || 'https://forgeintelligence.ai/auth/hubspot/callback');
  const brandProfileId = req.query.state?.split('|')[0] || req.query.brandProfileId || 'system';
  const nonce = randomBytes(16).toString('hex');
  const state = `${brandProfileId}|${nonce}`;
  
  // Full CRM + CMS scopes
  const scopes = [
    'cms.knowledge_base.articles.publish',
    'cms.knowledge_base.articles.read', 
    'cms.knowledge_base.articles.write',
    'crm.objects.companies.read',
    'crm.objects.companies.write',
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
    'crm.objects.owners.read',
    'content',
    'oauth'
  ].join('%20');
  
  const url = `https://app.hubspot.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scopes}&state=${encodeURIComponent(state)}`;
  res.json({ authUrl: url });
});

app.get('/auth/hubspot/callback', async (req, res) => {
  const { code, state, error } = req.query;
  console.log(`[HubSpot Callback] code=${code ? 'present' : 'MISSING'} state=${state} error=${error || 'none'}`);
  if (error) {
    console.error(`[HubSpot Callback] OAuth error from HubSpot: ${error}`);
    return res.redirect(`/app/integrations?hubspot_error=${error}`);
  }
  if (!code) return res.redirect('/app/integrations?hubspot_error=no_code');
  
  try {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
    const redirectUri = process.env.HUBSPOT_REDIRECT_URI || 'https://forgeintelligence.ai/auth/hubspot/callback';
    
    // Exchange code for tokens
    const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[HubSpot Callback] Token exchange failed:', JSON.stringify(tokenData));
      throw new Error(tokenData.message || 'Token exchange failed');
    }
    console.log(`[HubSpot Callback] Token exchange success — portal: ${tokenData.hub_id || 'unknown'}`);

    // Get account info (portal ID, hub domain)
    const accountRes = await fetch('https://api.hubapi.com/oauth/v1/access-tokens/' + tokenData.access_token);
    const accountInfo = await accountRes.json();

    // Fetch available blogs (for publishing)
    let blogs = [];
    try {
      const blogsRes = await fetch('https://api.hubapi.com/cms/v3/blogs/posts?limit=1', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      // If we can access blogs API, fetch the actual blog list
      if (blogsRes.ok) {
        const contentGroupsRes = await fetch('https://api.hubapi.com/content/api/v2/blogs', {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        if (contentGroupsRes.ok) {
          const blogsData = await contentGroupsRes.json();
          blogs = (blogsData.objects || []).map(b => ({
            id: b.id,
            name: b.name,
            slug: b.slug,
            absoluteUrl: b.absolute_url
          }));
        }
      }
    } catch (e) { console.log('[HubSpot] Could not fetch blogs:', e.message); }

    // Fetch available knowledge bases
    let knowledgeBases = [];
    try {
      const kbRes = await fetch('https://api.hubapi.com/cms/v3/knowledge-base-articles?limit=1', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      if (kbRes.ok) {
        // Knowledge base access confirmed - would need separate API for KB list
        knowledgeBases = [{ id: 'default', name: 'Default Knowledge Base' }];
      }
    } catch (e) { console.log('[HubSpot] Could not fetch KB:', e.message); }

    // Parse brandProfileId from state
    const stateDecoded = decodeURIComponent(state || '');
    const brandProfileId = stateDecoded.includes('|') ? stateDecoded.split('|')[0] : 'system';

    // Build available targets
    const availableTargets = {
      blogs: blogs,
      knowledgeBases: knowledgeBases
    };
    const selectedBlog = blogs.length > 0 ? blogs[0] : null;
    const selectedKB = knowledgeBases.length > 0 ? knowledgeBases[0] : null;

    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, 'hubspot', $2, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = $2, is_active = true, updated_at = NOW()
    `, [brandProfileId, JSON.stringify({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
      connectedAt: new Date().toISOString(),
      portalId: accountInfo.hub_id,
      hubDomain: accountInfo.hub_domain,
      appId: accountInfo.app_id,
      userId: accountInfo.user_id,
      userEmail: accountInfo.user,
      availableTargets: availableTargets,
      selectedBlog: selectedBlog,
      selectedKB: selectedKB
    })]);

    res.redirect('/app/integrations?hubspot_connected=true');
  } catch (err) {
    console.error('[HubSpot Callback] FULL ERROR:', err.message, err.stack?.slice(0, 300));
    res.redirect(`/app/integrations?hubspot_error=${encodeURIComponent(err.message)}`);
  }
});

// HubSpot token refresh helper
// ── HubSpot: Sync Clerk user to HubSpot CRM (for Forge's own tracking) ───────
async function syncUserToHubSpot(clerkUserId) {
  try {
    // Get system-level HubSpot connection
    const hubspot = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = 'system' AND channel = 'hubspot'`
    );
    if (!hubspot.rows.length) {
      console.log('[HubSpot Sync] No system HubSpot connection');
      return null;
    }
    
    // Fetch user details from Clerk
    const clerkRes = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { 'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}` }
    });
    if (!clerkRes.ok) {
      console.log('[HubSpot Sync] Could not fetch Clerk user:', clerkUserId);
      return null;
    }
    const clerkUser = await clerkRes.json();
    
    const email = clerkUser.email_addresses?.[0]?.email_address;
    if (!email) {
      console.log('[HubSpot Sync] No email for user:', clerkUserId);
      return null;
    }
    
    // Get fresh HubSpot token
    const accessToken = await refreshHubSpotToken('system');
    
    // Check if contact exists
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
        }]
      })
    });
    const searchData = await searchRes.json();
    
    // Build properties
    const firstName = clerkUser.first_name || '';
    const lastName = clerkUser.last_name || '';
    const company = clerkUser.public_metadata?.company || clerkUser.unsafe_metadata?.company || '';
    
    const properties = {
      email,
      firstname: firstName,
      lastname: lastName,
      ...(company && { company }),
      forge_clerk_id: clerkUserId,
      forge_signup_date: clerkUser.created_at ? new Date(clerkUser.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    };
    
    if (searchData.results?.length > 0) {
      // Update existing contact
      const contactId = searchData.results[0].id;
      await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ properties })
      });
      console.log(`[HubSpot Sync] Updated contact ${contactId} for ${email}`);
      return { action: 'updated', contactId, email };
    } else {
      // Create new contact
      const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ properties })
      });
      const created = await createRes.json();
      console.log(`[HubSpot Sync] Created contact ${created.id} for ${email}`);
      return { action: 'created', contactId: created.id, email };
    }
  } catch (err) {
    console.error('[HubSpot Sync] Error:', err.message);
    return null;
  }
}

async function refreshHubSpotToken(brandProfileId) {
  const result = await pool.query(
    `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'hubspot'`,
    [brandProfileId]
  );
  if (!result.rows.length) throw new Error('HubSpot not connected');
  
  const creds = result.rows[0].credentials;
  if (Date.now() < creds.expiresAt - 300000) return creds.accessToken; // Still valid (5 min buffer)
  
  const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Token refresh failed');
  
  creds.accessToken = tokenData.access_token;
  creds.refreshToken = tokenData.refresh_token;
  creds.expiresIn = tokenData.expires_in;
  creds.expiresAt = Date.now() + (tokenData.expires_in * 1000);
  
  await pool.query(
    `UPDATE publishing_channels SET credentials = $1, updated_at = NOW() WHERE brand_profile_id = $2 AND channel = 'hubspot'`,
    [JSON.stringify(creds), brandProfileId]
  );
  
  return creds.accessToken;
}

// ── HubSpot: Publish article to Knowledge Base ───────────────────────────────
app.post('/api/hubspot/publish-article', requireAuth, async (req, res) => {
  const { brandProfileId, articleId, title, body, slug } = req.body;
  if (!brandProfileId || !title || !body) {
    return res.status(400).json({ error: 'brandProfileId, title, and body required' });
  }
  
  try {
    const accessToken = await refreshHubSpotToken(brandProfileId);
    
    // Create knowledge base article
    const articleRes = await fetch('https://api.hubapi.com/cms/v3/blogs/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: title,
        slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        postBody: body,
        state: 'DRAFT' // Start as draft, can be published separately
      })
    });
    
    const article = await articleRes.json();
    if (article.status === 'error') throw new Error(article.message || 'Failed to create article');
    
    res.json({ success: true, articleId: article.id, url: article.url });
  } catch (err) {
    console.error('HubSpot publish error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot: Create/update contact ───────────────────────────────────────────
app.post('/api/hubspot/upsert-contact', async (req, res) => {
  const { brandProfileId, email, properties } = req.body;
  if (!brandProfileId || !email) {
    return res.status(400).json({ error: 'brandProfileId and email required' });
  }
  
  try {
    const accessToken = await refreshHubSpotToken(brandProfileId);
    
    // Try to get existing contact
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
        }]
      })
    });
    const searchData = await searchRes.json();
    
    if (searchData.results?.length > 0) {
      // Update existing contact
      const contactId = searchData.results[0].id;
      const updateRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ properties: properties || {} })
      });
      const updated = await updateRes.json();
      res.json({ success: true, contactId, action: 'updated', contact: updated });
    } else {
      // Create new contact
      const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ properties: { email, ...properties } })
      });
      const created = await createRes.json();
      res.json({ success: true, contactId: created.id, action: 'created', contact: created });
    }
  } catch (err) {
    console.error('HubSpot contact error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot: Log content engagement (for attribution) ───────────────────────
app.post('/api/hubspot/log-engagement', async (req, res) => {
  const { brandProfileId, email, articleUrl, articleTitle, utmParams } = req.body;
  if (!brandProfileId || !email || !articleUrl) {
    return res.status(400).json({ error: 'brandProfileId, email, and articleUrl required' });
  }
  
  try {
    const accessToken = await refreshHubSpotToken(brandProfileId);
    
    // Find contact by email
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
        }]
      })
    });
    const searchData = await searchRes.json();
    
    if (!searchData.results?.length) {
      return res.status(404).json({ error: 'Contact not found in HubSpot' });
    }
    
    const contactId = searchData.results[0].id;
    
    // Log engagement as a note/activity
    const noteRes = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          hs_note_body: `📖 Content Engagement: Viewed "${articleTitle || articleUrl}"\n\nURL: ${articleUrl}\n${utmParams ? `UTM: ${JSON.stringify(utmParams)}` : ''}`,
          hs_timestamp: Date.now()
        },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] // Note to Contact
        }]
      })
    });
    const note = await noteRes.json();
    
    res.json({ success: true, contactId, noteId: note.id });
  } catch (err) {
    console.error('HubSpot engagement error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── HubSpot: Switch publishing target (blog or KB) ──────────────────────────
app.post('/api/hubspot/select-target', requireAuth, async (req, res) => {
  const { brandProfileId, targetType, targetId } = req.body;
  if (!brandProfileId || !targetType || !targetId) {
    return res.status(400).json({ error: 'brandProfileId, targetType, and targetId required' });
  }
  
  try {
    const existing = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'hubspot'`,
      [brandProfileId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'HubSpot not connected' });
    
    const creds = existing.rows[0].credentials;
    
    if (targetType === 'blog') {
      const blog = (creds.availableTargets?.blogs || []).find(b => b.id === targetId);
      if (!blog) return res.status(400).json({ error: 'Invalid blog ID' });
      creds.selectedBlog = blog;
    } else if (targetType === 'kb') {
      const kb = (creds.availableTargets?.knowledgeBases || []).find(k => k.id === targetId);
      if (!kb) return res.status(400).json({ error: 'Invalid KB ID' });
      creds.selectedKB = kb;
    } else {
      return res.status(400).json({ error: 'targetType must be "blog" or "kb"' });
    }
    
    await pool.query(
      `UPDATE publishing_channels SET credentials = $1, updated_at = NOW() WHERE brand_profile_id = $2 AND channel = 'hubspot'`,
      [JSON.stringify(creds), brandProfileId]
    );
    
    res.json({ success: true, selectedBlog: creds.selectedBlog, selectedKB: creds.selectedKB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot: Refresh available targets ───────────────────────────────────────
app.post('/api/hubspot/refresh-targets', requireAuth, async (req, res) => {
  const { brandProfileId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  
  try {
    const accessToken = await refreshHubSpotToken(brandProfileId);
    
    // Fetch blogs
    let blogs = [];
    try {
      const contentGroupsRes = await fetch('https://api.hubapi.com/content/api/v2/blogs', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (contentGroupsRes.ok) {
        const blogsData = await contentGroupsRes.json();
        blogs = (blogsData.objects || []).map(b => ({
          id: b.id,
          name: b.name,
          slug: b.slug,
          absoluteUrl: b.absolute_url
        }));
      }
    } catch (e) { console.log('[HubSpot] Could not fetch blogs:', e.message); }

    // Fetch knowledge bases
    let knowledgeBases = [];
    try {
      const kbRes = await fetch('https://api.hubapi.com/cms/v3/knowledge-base-articles?limit=1', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (kbRes.ok) {
        knowledgeBases = [{ id: 'default', name: 'Default Knowledge Base' }];
      }
    } catch (e) { console.log('[HubSpot] Could not fetch KB:', e.message); }

    // Update stored credentials
    const existing = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'hubspot'`,
      [brandProfileId]
    );
    if (existing.rows.length) {
      const creds = existing.rows[0].credentials;
      creds.availableTargets = { blogs, knowledgeBases };
      if (!creds.selectedBlog && blogs.length > 0) creds.selectedBlog = blogs[0];
      if (!creds.selectedKB && knowledgeBases.length > 0) creds.selectedKB = knowledgeBases[0];
      
      await pool.query(
        `UPDATE publishing_channels SET credentials = $1, updated_at = NOW() WHERE brand_profile_id = $2 AND channel = 'hubspot'`,
        [JSON.stringify(creds), brandProfileId]
      );
    }

    res.json({ success: true, blogs, knowledgeBases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Webflow OAuth ────────────────────────────────────────────────────────────
app.get('/api/webflow/auth', (req, res) => {
  const clientId = process.env.WEBFLOW_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'WEBFLOW_CLIENT_ID not configured' });
  
  const redirectUri = encodeURIComponent(process.env.WEBFLOW_REDIRECT_URI || 'https://forgeintelligence.ai/auth/webflow/callback');
  const brandProfileId = req.query.state?.split('|')[0] || req.query.brandProfileId || 'system';
  const nonce = randomBytes(16).toString('hex');
  const state = `${brandProfileId}|${nonce}`;
  
  // Scopes for Data API
  const scopes = 'sites:read cms:read cms:write';
  
  const url = `https://webflow.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
  res.json({ authUrl: url });
});

app.get('/auth/webflow/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/app/integrations?webflow_error=${error}`);
  if (!code) return res.redirect('/app/integrations?webflow_error=no_code');
  
  try {
    const clientId = process.env.WEBFLOW_CLIENT_ID;
    const clientSecret = process.env.WEBFLOW_CLIENT_SECRET;
    const redirectUri = process.env.WEBFLOW_REDIRECT_URI || 'https://forgeintelligence.ai/auth/webflow/callback';
    
    // Exchange code for token
    const tokenRes = await fetch('https://api.webflow.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error || 'Token exchange failed');

    // Fetch available sites
    const sitesRes = await fetch('https://api.webflow.com/v2/sites', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const sitesData = await sitesRes.json();
    const sites = (sitesData.sites || []).map(s => ({
      id: s.id,
      name: s.displayName || s.shortName,
      shortName: s.shortName,
      previewUrl: s.previewUrl
    }));

    // Fetch collections for each site
    const sitesWithCollections = await Promise.all(sites.map(async (site) => {
      try {
        const collRes = await fetch(`https://api.webflow.com/v2/sites/${site.id}/collections`, {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const collData = await collRes.json();
        site.collections = (collData.collections || []).map(c => ({
          id: c.id,
          name: c.displayName || c.slug,
          slug: c.slug
        }));
      } catch {
        site.collections = [];
      }
      return site;
    }));

    // Parse brandProfileId from state
    const stateDecoded = decodeURIComponent(state || '');
    const brandProfileId = stateDecoded.includes('|') ? stateDecoded.split('|')[0] : 'system';

    // Default to first site and its first collection
    const selectedSite = sitesWithCollections[0] || null;
    const selectedCollection = selectedSite?.collections?.[0] || null;

    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, 'webflow', $2, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = $2, is_active = true, updated_at = NOW()
    `, [brandProfileId, JSON.stringify({
      accessToken: tokenData.access_token,
      connectedAt: new Date().toISOString(),
      sites: sitesWithCollections,
      selectedSite: selectedSite,
      selectedCollection: selectedCollection
    })]);

    res.redirect('/app/integrations?webflow_connected=true');
  } catch (err) {
    console.error('Webflow callback error:', err);
    res.redirect(`/app/integrations?webflow_error=${encodeURIComponent(err.message)}`);
  }
});

// ── Webflow: Switch site/collection target ───────────────────────────────────
app.post('/api/webflow/select-target', requireAuth, async (req, res) => {
  const { brandProfileId, siteId, collectionId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  
  try {
    const existing = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'webflow'`,
      [brandProfileId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Webflow not connected' });
    
    const creds = existing.rows[0].credentials;
    
    if (siteId) {
      const site = (creds.sites || []).find(s => s.id === siteId);
      if (!site) return res.status(400).json({ error: 'Invalid site ID' });
      creds.selectedSite = site;
      // Auto-select first collection of new site
      creds.selectedCollection = site.collections?.[0] || null;
    }
    
    if (collectionId) {
      const collection = (creds.selectedSite?.collections || []).find(c => c.id === collectionId);
      if (!collection) return res.status(400).json({ error: 'Invalid collection ID' });
      creds.selectedCollection = collection;
    }
    
    await pool.query(
      `UPDATE publishing_channels SET credentials = $1, updated_at = NOW() WHERE brand_profile_id = $2 AND channel = 'webflow'`,
      [JSON.stringify(creds), brandProfileId]
    );
    
    res.json({ success: true, selectedSite: creds.selectedSite, selectedCollection: creds.selectedCollection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Search Console OAuth ──────────────────────────────────────────────

// GET /api/gsc/auth — initiate OAuth flow
app.get('/api/gsc/auth', (req, res) => {
  const clientId = process.env.GSC_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  const brandProfileId = req.query.state?.split('|')[0] || req.query.brandProfileId || 'system';
  const nonce = randomBytes(16).toString('hex');
  const state = `${brandProfileId}|${nonce}`;
  const redirectUri = encodeURIComponent(process.env.GSC_REDIRECT_URI || 'https://dev.forgeintelligence.ai/auth/gsc/callback');
  const scope = encodeURIComponent('https://www.googleapis.com/auth/webmasters.readonly');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&state=${encodeURIComponent(state)}&access_type=offline&prompt=consent`;
  res.json({ authUrl: url });
});

// GET /auth/gsc/callback — handle OAuth callback, exchange code for tokens
app.get('/auth/gsc/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/app/integrations?gsc_error=${error}`);
  if (!code) return res.redirect('/app/integrations?gsc_error=no_code');
  try {
    const clientId     = process.env.GSC_CLIENT_ID;
    const clientSecret = process.env.GSC_CLIENT_SECRET;
    const redirectUri  = process.env.GSC_REDIRECT_URI || 'https://dev.forgeintelligence.ai/auth/gsc/callback';

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'Token exchange failed');

    // Fetch list of verified GSC properties for this user
    const sitesRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const sitesData = await sitesRes.json();
    const sites = (sitesData.siteEntry || []).map(s => s.siteUrl);

    const stateDecoded = decodeURIComponent(state || '');
    const brandProfileId = stateDecoded.includes('|') ? stateDecoded.split('|')[0] : 'system';

    // Store tokens + verified sites in publishing_channels
    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, 'gsc', $2, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = $2, is_active = true, updated_at = NOW()
    `, [brandProfileId, JSON.stringify({
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn:    tokenData.expires_in,
      tokenType:    tokenData.token_type,
      verifiedSites: sites,
      connectedAt:  new Date().toISOString()
    })]);

    res.redirect(`/app/integrations?gsc_connected=true`);
  } catch(err) {
    console.error('[GSC callback]', err.message);
    res.redirect(`/app/integrations?gsc_error=${encodeURIComponent(err.message)}`);
  }
});

// Helper: refresh GSC access token using refresh token
async function refreshGSCToken(refreshToken) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET
    })
  });
  const data = await tokenRes.json();
  if (!data.access_token) throw new Error('GSC token refresh failed');
  return data.access_token;
}

// POST /api/analytics/sync-gsc/:brandProfileId — pull GSC data for brand's domain
app.post('/api/analytics/sync-gsc/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  const { days = 28 } = req.body;
  try {
    // Get GSC credentials
    const credRes = await pool.query(
      'SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2 AND is_active = true LIMIT 1',
      [brandProfileId, 'gsc']
    );
    if (!credRes.rows.length) return res.status(400).json({ error: 'GSC not connected for this brand' });
    let creds = credRes.rows[0].credentials;

    // Get brand domain from brand_profiles
    const brandRes = await pool.query('SELECT brand_url, article_base_url FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Determine which GSC property to query
    const brandDomain = (brand.brand_url || brand.article_base_url || '').replace(/https?:\/\//, '').replace(/\/.*/, '').replace(/^www\./, '');
    const verifiedSites = creds.verifiedSites || [];
    const siteUrl = verifiedSites.find(s => s.includes(brandDomain))
      || verifiedSites.find(s => s.includes('sc-domain:'))
      || verifiedSites[0];

    if (!siteUrl) return res.status(400).json({ error: `No verified GSC property found for ${brandDomain}. Verify site ownership in Google Search Console first.` });

    // Refresh token if needed
    let accessToken = creds.accessToken;
    try {
      // Try a test call — if it fails, refresh
      const testRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (testRes.status === 401 && creds.refreshToken) {
        accessToken = await refreshGSCToken(creds.refreshToken);
        // Update stored token
        await pool.query(
          'UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = $3',
          [JSON.stringify({ accessToken }), brandProfileId, 'gsc']
        );
      }
    } catch(e) { console.log('[GSC] Token test error:', e.message); }

    // Date range
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    // Query GSC Search Analytics — by page, last N days
    const gscRes = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate, endDate,
          dimensions: ['page'],
          rowLimit: 500,
          dataState: 'all'
        })
      }
    );
    const gscData = await gscRes.json();
    if (gscData.error) throw new Error(gscData.error.message);

    const rows = gscData.rows || [];
    let synced = 0;

    // Match GSC pages to content_analytics by URL or publishing_queue by title slug
    for (const row of rows) {
      const pageUrl = row.keys[0];
      // Skip /app/ routes — accept all domains matching the brand's GSC property
      try {
        const u = new URL(pageUrl);
        if (u.pathname.startsWith('/app/')) continue;
      } catch { continue; }
      const clicks = Math.round(row.clicks || 0);
      const impressions = Math.round(row.impressions || 0);
      const ctr = parseFloat((row.ctr * 100).toFixed(2));
      const position = parseFloat((row.position || 0).toFixed(1));

      // Try to find matching content_id from publishing_queue by URL slug match
      const urlSlug = pageUrl.replace(/\/$/, '').split('/').pop()?.replace(/\.html$/, '') || '';
      const queueRes = await pool.query(
        `SELECT content_id FROM publishing_queue WHERE brand_profile_id = $1 AND LOWER(REPLACE(REPLACE(title, ' ', '-'), ',', '')) LIKE $2 LIMIT 1`,
        [brandProfileId, `%${urlSlug.slice(0, 20)}%`]
      ).catch(() => ({ rows: [] }));

      const contentId = queueRes.rows[0]?.content_id || `gsc_${Buffer.from(pageUrl).toString('base64').slice(0, 16)}`;

      await pool.query(
        `INSERT INTO content_analytics
          (brand_profile_id, content_id, channel, post_id, impressions, clicks, ctr, engagement_rate,
           reactions, comments, reposts, raw_data, published_at, synced_at)
         VALUES ($1,$2,'gsc',$3,$4,$5,$6,$7,0,0,0,$8,NOW(),NOW())
         ON CONFLICT (brand_profile_id, content_id, channel)
         DO UPDATE SET impressions=$4, clicks=$5, ctr=$6, engagement_rate=$7,
           raw_data=$8, synced_at=NOW()`,
        [brandProfileId, contentId, pageUrl, impressions, clicks, ctr, position,
         JSON.stringify({ pageUrl, clicks, impressions, ctr, position, startDate, endDate, siteUrl })]
      );
      synced++;
    }

    res.json({ success: true, synced, siteUrl, dateRange: { startDate, endDate }, totalRows: rows.length });
  } catch(err) {
    console.error('[GSC-SYNC]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/webflow-seo/:brandProfileId — Webflow content performance via GSC
app.get('/api/analytics/webflow-seo/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    // 1. Get all Webflow-published URLs
    const wfRes = await pool.query(
      `SELECT pl.content_id, pl.published_url, pl.attempted_at, pl.response_data,
              ct.title, ct.hero_image_url
       FROM publish_log pl
       LEFT JOIN generated_content_${brandProfileId.replace(/-/g, '_')} ct ON ct.id::text = pl.content_id
       WHERE pl.brand_profile_id = $1 AND pl.channel = 'webflow' AND pl.status = 'published'
       ORDER BY pl.attempted_at DESC`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // 2. Check GSC connection (before early return so empty state knows)
    const gscCred = await pool.query(
      'SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2 AND is_active = true LIMIT 1',
      [brandProfileId, 'gsc']
    ).catch(() => ({ rows: [] }));
    const gscConnected = gscCred.rows.length > 0;

    if (!wfRes.rows.length) {
      return res.json({ success: true, articles: [], totals: { published: 0, impressions: 0, clicks: 0, avgCtr: 0, avgPosition: 0 }, gscConnected });
    }

    // 3. Get GSC data for all pages
    const gscRes = await pool.query(
      `SELECT content_id, post_id AS page_url, impressions, clicks, ctr, engagement_rate AS position, raw_data
       FROM content_analytics
       WHERE brand_profile_id = $1 AND channel = 'gsc'`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // Build URL lookup from GSC data
    const gscByUrl = {};
    for (const row of gscRes.rows) {
      if (row.page_url) gscByUrl[row.page_url] = row;
    }

    // 4. Match Webflow articles to GSC data by URL
    const articles = wfRes.rows.map(wf => {
      const url = wf.published_url || wf.response_data?.url || '';
      // Try exact match, then slug match
      let gsc = gscByUrl[url] || gscByUrl[url.replace(/\/$/, '')] || null;
      if (!gsc && url) {
        const slug = url.replace(/\/$/, '').split('/').pop();
        gsc = Object.values(gscByUrl).find(g => g.page_url && g.page_url.includes(slug)) || null;
      }
      return {
        content_id: wf.content_id,
        title: wf.title || 'Untitled',
        hero_image_url: wf.hero_image_url || null,
        url,
        published_at: wf.attempted_at,
        impressions: gsc ? (gsc.impressions || 0) : 0,
        clicks: gsc ? (gsc.clicks || 0) : 0,
        ctr: gsc ? (gsc.ctr || 0) : 0,
        position: gsc ? (gsc.position || 0) : 0,
        hasGscData: !!gsc,
      };
    });

    // 5. Compute totals
    const withData = articles.filter(a => a.hasGscData);
    const totals = {
      published: articles.length,
      impressions: articles.reduce((s, a) => s + a.impressions, 0),
      clicks: articles.reduce((s, a) => s + a.clicks, 0),
      avgCtr: withData.length ? parseFloat((withData.reduce((s, a) => s + a.ctr, 0) / withData.length).toFixed(2)) : 0,
      avgPosition: withData.length ? parseFloat((withData.reduce((s, a) => s + a.position, 0) / withData.length).toFixed(1)) : 0,
    };

    res.json({ success: true, articles, totals, gscConnected });
  } catch(e) {
    console.error('[WEBFLOW-SEO]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/gsc/status/:brandProfileId — check connection status + verified sites
app.get('/api/gsc/status/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT credentials, updated_at FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2 AND is_active = true',
      [req.params.brandProfileId, 'gsc']
    );
    if (!r.rows.length) return res.json({ connected: false });
    const creds = r.rows[0].credentials;
    res.json({ connected: true, verifiedSites: creds.verifiedSites || [], connectedAt: creds.connectedAt, updatedAt: r.rows[0].updated_at });
  } catch(e) {
    res.status(500).json({ connected: false, error: e.message });
  }
});

// ── Generate LinkedIn post copy preview ───────────────────────────────────────
app.post('/api/publishing/generate-post-copy', async (req, res) => {
  const { title, headings, readMinutes, articleUrl } = req.body;
  try {
    const copyRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: `Write a LinkedIn post designed to drive link clicks to this B2B article. Goal: make the reader feel they MUST click to get the full answer. Do NOT summarize — create a curiosity gap.

Article title: "${title}"
Sections covered: ${headings || 'not provided'}
Read time: ${readMinutes} min read
Article URL: ${articleUrl}

Structure (follow exactly):
Line 1: One punchy statement of the core tension or counterintuitive insight. Must hook in under 200 characters — this is what shows before 'see more'.
Lines 2-4: 2-3 short lines that deepen the tension or name the specific problem. Do NOT resolve it — leave the answer in the article.
Final line: Exactly this and nothing else: Read more: ${articleUrl}

Hard rules:
- Total post: 500-800 characters including the URL line
- No emojis, no hashtags, no bullet points
- No summarizing the article — create hunger for it
- No ellipsis cutoffs — every sentence complete
- Plain text only

Output only the post text.` }]
    });
    const copy = copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '';
    res.json({ success: true, copy });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/publishing/publish', async (req, res) => {
  // Allow scheduler to call without user auth via adminPassword
  const isCron = req.body?.adminPassword === process.env.ADMIN_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'] });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  }
  const startTime = Date.now();
  const { queueItemId, channels: selectedChannels } = req.body;
  if (!queueItemId) return res.status(400).json({ error: 'queueItemId required' });
  try {
    // Load queue item + article
    const queueRes = await pool.query('SELECT * FROM publishing_queue WHERE id = $1', [queueItemId]);
    if (!queueRes.rows.length) return res.status(404).json({ error: 'Queue item not found' });
    const item = queueRes.rows[0];

    const safeId = item.brand_profile_id.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;
    const contentRes = await pool.query(`SELECT * FROM ${contentTable} WHERE id = $1`, [item.content_id]);
    if (!contentRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = contentRes.rows[0];

    // Load brand profile
    const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [item.brand_profile_id]);
    const brand = brandRes.rows[0] || {};
    const brandSlug = (brand.brand_url || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    const articleSlug = (article.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    // Use BYO domain if configured, otherwise default to Forge article URL
    const articleBaseDomain = process.env.BASE_DOMAIN || 'forgeintelligence.ai';
    const articleBaseUrl = brand.article_base_url
      ? brand.article_base_url.replace(/\/+$/, '')
      : `https://${articleBaseDomain}/articles/${brandSlug}`;
    const articleUrlSuffix = (brand.article_url_suffix || '').trim();
    const forgeArticleUrl = `${articleBaseUrl}/${articleSlug}${articleUrlSuffix}`;

    // Load channel connections for this brand
    const channelsRes = await pool.query(
      'SELECT * FROM publishing_channels WHERE brand_profile_id = $1',
      [item.brand_profile_id]
    );
    const channelMap = {};
    for (const ch of channelsRes.rows) channelMap[ch.channel] = ch;

    const targets = selectedChannels || item.channels || [];
    const results = {};

    // ── Ensure hero image exists before publishing ────────────────────────────
    // Campaign generator doesn't pre-generate images — create one now if missing
    if (!article.hero_image_url) {
      try {
        const aj = article.article_json || {};
        const sections = aj.sections || [];
        const firstBody = (sections[0]?.body || sections[0]?.content || '').slice(0, 300);
        const imgPromptRes = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: `Write a Flux image generation prompt for a B2B editorial hero image for this article: "${article.title}". Context: ${firstBody}. Output only the prompt, no quotes, no preamble. Professional photography style, 16:9, no text in image.` }]
        });
        const fluxPrompt = imgPromptRes.content[0]?.type === 'text'
          ? imgPromptRes.content[0].text.trim()
          : `Professional B2B editorial hero image for: ${article.title}`;

        const imageUrl = await generateHeroImage(fluxPrompt);
        await pool.query(
          `UPDATE ${contentTable} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
          [imageUrl, fluxPrompt, article.id]
        );
        article.hero_image_url = imageUrl;
        console.log(`[PUBLISH] Generated hero image for "${article.title}"`);
      } catch (imgErr) {
        console.warn('[PUBLISH] Hero image generation failed, continuing without:', imgErr.message);
        // Non-fatal — publish continues without image
      }
    }

    // Load existing publish_log entries for this queue item — used to skip already-published channels
    const existingLogRes = await pool.query(
      `SELECT channel FROM publish_log WHERE queue_item_id = $1 AND status = 'published'`,
      [queueItemId]
    ).catch(() => ({ rows: [] }));
    const alreadyPublished = new Set(existingLogRes.rows.map(r => r.channel));

    for (const channel of targets) {
      const chConfig = channelMap[channel];
      if (!chConfig) { results[channel] = { status: 'error', error: 'Channel not connected' }; continue; }

      // Skip channels already successfully published — prevents double-posting
      if (alreadyPublished.has(channel)) {
        results[channel] = { status: 'published', skipped: true, message: 'Already published to this channel' };
        continue;
      }

      // campaign_id is a UUID — derive a readable slug from the queue item's campaign_id
      // Fall back to the campaigns table name if we have it, otherwise use the UUID prefix
      let campaignSlug = 'forge-content';
      if (item.campaign_id) {
        try {
          const campRow = await pool.query('SELECT name FROM campaigns WHERE id = $1', [item.campaign_id]);
          campaignSlug = campRow.rows[0]?.name
            ? campRow.rows[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
            : item.campaign_id.split('-')[0];
        } catch { campaignSlug = item.campaign_id.split('-')[0]; }
      }
      const utmCtx = { channel, brandSlug, articleSlug, campaignSlug };
      // Default UTM template if channel has none configured
      const defaultUtmTemplate = {
        utm_source: '{channel}',
        utm_medium: 'social',
        utm_campaign: '{campaign_slug}',
        utm_content: '{article_slug}'
      };
      // utm_template may come back as a string from DB — parse if needed
      let rawTemplate = chConfig.utm_template;
      if (typeof rawTemplate === 'string') {
        try { rawTemplate = JSON.parse(rawTemplate); } catch { rawTemplate = {}; }
      }
      const utmTemplate = (rawTemplate && Object.keys(rawTemplate).length > 0)
        ? rawTemplate
        : defaultUtmTemplate;
      const utmParams = resolveUtmParams(utmTemplate, utmCtx);
      const utmString = buildUtmString(utmParams);

      const creds = chConfig.credentials || {};

      try {
        if (channel === 'wordpress') {
          // ── Real WordPress REST API publish ──
          const wpUrl = creds.siteUrl?.replace(/\/+$/, '');
          if (!wpUrl || !creds.username || !creds.appPassword) throw new Error('Missing WordPress credentials');

          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const htmlContent = sections.map(s =>
            `${s.heading ? `<h2>${s.heading}</h2>` : ''}<p>${s.body || s.content || ''}</p>`
          ).join('\n');

          const authHeader = 'Basic ' + Buffer.from(`${creds.username}:${creds.appPassword}`).toString('base64');
          const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: article.title,
              content: htmlContent + (utmString ? `\n<!-- UTM: ${utmString} -->` : ''),
              status: 'publish',
              excerpt: sections[0]?.content?.slice(0, 160) || '',
              meta: { forge_utm: utmString, forge_brain: item.brand_profile_id }
            })
          });
          const wpData = await wpRes.json();
          if (!wpRes.ok) throw new Error(wpData.message || 'WordPress publish failed');
          results[channel] = { status: 'published', url: wpData.link, postId: wpData.id, utmParams };

        } else if (channel === 'webflow') {
          // ── Real Webflow CMS publish ──
          const webflowToken = creds.accessToken || creds.apiToken;
          const siteId = creds.selectedSite?.id || creds.siteId;
          const collectionId = creds.selectedCollection?.id || creds.collectionId;
          if (!webflowToken) throw new Error('Webflow not connected — visit Integrations to authorize via OAuth');
          if (!siteId) throw new Error('Webflow site not selected — visit Integrations to pick a site');
          if (!collectionId) throw new Error('Webflow collection not selected — visit Integrations to pick a collection');

          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const bodyHtml = sections.map(s =>
            `${s.heading ? `<h2>${s.heading}</h2>` : ''}<p>${s.body || s.content || ''}</p>`
          ).join('\n');
          const excerpt = (sections[0]?.body || sections[0]?.content || '').slice(0, 160);
          const slug = (article.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

          const wfRes = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${webflowToken}`,
              'Content-Type': 'application/json',
              'accept-version': '1.0.0'
            },
            body: JSON.stringify({
              isArchived: false,
              isDraft: false,
              fieldData: {
                name: article.title || 'Untitled',
                slug,
                excerpt,
                body: bodyHtml,
                'published-on': new Date().toISOString(),
                category: articleJson.category || 'Thought Leadership',
                'forge-utm': utmString,
                'forge-brain-id': item.brand_profile_id,
              }
            })
          });
          const wfData = await wfRes.json();
          if (!wfRes.ok) throw new Error(wfData.message || JSON.stringify(wfData));
          // Build Webflow URL from site info or item response
          // Prefer explicit customDomain, then shortName, then fall back to site ID
          const wfSiteDomain = creds.selectedSite?.customDomain
            || (creds.selectedSite?.shortName ? `${creds.selectedSite.shortName}.webflow.io` : null)
            || siteId;
          // Webflow CMS URLs are just domain/article-slug — collection slug is internal, not in the URL
          const publishedUrl = `https://${wfSiteDomain}/${slug}`;
          results[channel] = { status: 'published', url: publishedUrl, itemId: wfData.id, utmParams };

        } else if (channel === 'hubspot') {
          results[channel] = { status: 'staged', message: 'HubSpot: credentials saved, live API wired in Stage 6.1', utmParams };

        } else if (channel === 'linkedin') {
          // ── Real LinkedIn share via UGC Posts API ──
          const liToken   = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
          const authorUrn = creds.authorUrn   || process.env.LINKEDIN_AUTHOR_URN;
          if (!liToken || !authorUrn) {
            results[channel] = { status: 'staged', message: 'LinkedIn not yet authorized — visit /app/integrations to connect', utmParams };
          } else {
            const articleJson = article.article_json || {};
            const sections = articleJson.sections || [];
            const postCopyOverride = (req.body.postCopy || {})[channel];
            const articleUrl = `${forgeArticleUrl}${utmString ? '?' + utmString : ''}`;

            // Generate or use provided post copy
            let postText = postCopyOverride;
            if (!postText) {
              const wordCount = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
              const readMinutes = Math.max(2, Math.round(wordCount / 200));
              const sectionHeadings = sections.slice(1, 5).map(s => s.heading).filter(Boolean).join(', ');
              try {
                const copyRes = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 400,
                  messages: [{ role: 'user', content: `Write a LinkedIn post designed to drive link clicks to this B2B article. Goal: make the reader feel they MUST click to get the full answer. Do NOT summarize — create a curiosity gap.

Article title: "${article.title}"
Key sections covered: ${sectionHeadings}
Read time: ${readMinutes} min read

Structure (follow exactly):
Line 1: One punchy statement of the core tension or counterintuitive insight. Must hook in under 200 characters — this is what shows before 'see more'.
Lines 2-4: 2-3 short lines that deepen the tension or name the specific problem. Do NOT resolve it — leave the answer in the article.
Final line: Exactly this and nothing else: Read more: ${articleUrl}

Hard rules:
- Total post: 500-800 characters including the URL line
- No emojis, no hashtags, no bullet points
- No summarizing the article — create hunger for it
- No ellipsis cutoffs — every sentence complete
- Plain text only, no markdown

Output only the post text.` }]
                });
                postText = copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '';
              } catch(e) {
                const wordCount2 = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
                const readMin = Math.max(2, Math.round(wordCount2 / 200));
                postText = `${article.title}\n\n${sections.slice(0,3).map(s => s.heading).filter(Boolean).join(' · ')}\n\n${readMin} min read\n\nRead more: ${articleUrl}`;
              }
            }

            const liRes = await fetch('https://api.linkedin.com/v2/ugcPosts', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${liToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
              body: JSON.stringify({
                author: authorUrn,
                lifecycleState: 'PUBLISHED',
                specificContent: {
                  'com.linkedin.ugc.ShareContent': {
                    shareCommentary: { text: postText },
                    shareMediaCategory: 'ARTICLE',
                    media: [{ status: 'READY', originalUrl: articleUrl, title: { text: article.title || 'New Article' } }]
                  }
                },
                visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
              })
            });
            const liData = await liRes.json();
            if (!liRes.ok) throw new Error(liData.message || JSON.stringify(liData));
            const postId = liData.id?.replace('urn:li:ugcPost:', '');
            const postUrl = `https://www.linkedin.com/feed/update/${liData.id}/`;
            results[channel] = { status: 'published', url: postUrl, postId: liData.id, utmParams };
          }

        } else if (channel === 'x') {
          // ── X (Twitter) API v2 publish — OAuth 2.0 preferred, 1.0a fallback ──
          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const articleUrl = forgeArticleUrl;
          const fullTweetUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;
          const excerpt = (sections[0]?.content || sections[0]?.body || article.title || '').slice(0, 250);
          const tweetText = `${excerpt}...\n\n${fullTweetUrl}`;
          const tweetEndpoint = 'https://api.twitter.com/2/tweets';

          let authHeader;
          let twitterHandle = creds.username || 'i';

          if (creds.oauth2AccessToken) {
            // OAuth 2.0 path (preferred — from Connect flow)
            let token = creds.oauth2AccessToken;
            // Try posting; if 401, refresh and retry
            let xRes = await fetch(tweetEndpoint, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: tweetText })
            });
            if (xRes.status === 401 && creds.oauth2RefreshToken) {
              try {
                const refreshed = await refreshXOAuth2Token(creds.oauth2RefreshToken);
                token = refreshed.access_token;
                // Update stored tokens
                await pool.query(
                  `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
                  [JSON.stringify({ oauth2AccessToken: refreshed.access_token, oauth2RefreshToken: refreshed.refresh_token || creds.oauth2RefreshToken }), item.brand_profile_id]
                );
                xRes = await fetch(tweetEndpoint, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: tweetText })
                });
              } catch(e) {
                console.error('[X] Token refresh failed:', e.message);
                // Invalid refresh token — clear tokens so user is prompted to reconnect
                if (e.message && (e.message.includes('invalid') || e.message.includes('revoked') || e.message.includes('expired'))) {
                  await pool.query(
                    `UPDATE publishing_channels SET credentials = credentials - 'oauth2AccessToken' - 'oauth2RefreshToken' WHERE brand_profile_id = $1 AND channel = 'x'`,
                    [item.brand_profile_id]
                  ).catch(() => {});
                  console.error(`[X] Cleared expired tokens for brand ${item.brand_profile_id} — user must reconnect`);
                  throw new Error('X authentication expired. Please reconnect X in Integrations.');
                }
                throw e;
              }
            }
            const xData = await xRes.json();
            if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
            const tweetId = xData.data?.id;
            const tweetUrl2 = `https://x.com/${twitterHandle}/status/${tweetId}`;
            results[channel] = { status: 'published', url: tweetUrl2, tweetId, utmParams };
          } else {
            // OAuth 1.0a fallback (legacy manual tokens)
            const xApiKey       = creds.apiKey       || process.env.X_OAUTH1CONSUMER_KEY;
            const xApiSecret    = creds.apiSecret    || process.env.X_OAUTH1CONSUMER_SECRET;
            const xAccessToken  = creds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
            const xAccessSecret = creds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
            if (!xApiKey || !xApiSecret || !xAccessToken || !xAccessSecret) throw new Error('Missing X credentials — use Connect X to authorize');
            authHeader = buildXOAuthHeader('POST', tweetEndpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret);
            const xRes = await fetch(tweetEndpoint, {
              method: 'POST',
              headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: tweetText })
            });
            const xData = await xRes.json();
            if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
            const tweetId = xData.data?.id;
            try {
              const meRes = await fetch('https://api.twitter.com/2/users/me', { headers: { 'Authorization': authHeader } });
              if (meRes.ok) { twitterHandle = (await meRes.json()).data?.username || 'i'; }
            } catch(e) {}
            const tweetUrl2 = `https://x.com/${twitterHandle}/status/${tweetId}`;
            results[channel] = { status: 'published', url: tweetUrl2, tweetId, utmParams };
          }

        } else if (channel === 'facebook') {
          // ── Facebook publish via Pipedream Connect Proxy ──
          const creds = chConfig.credentials || {};
          const pipedreamAccountId = creds.pipedream_account_id;
          
          const articleUrl = `https://${process.env.BASE_DOMAIN || 'forgeintelligence.ai'}/articles/${brandSlug}/${articleSlug}`;
          const utmUrl = articleUrl + '?' + new URLSearchParams({ ...utmCtx, utm_source: 'facebook', utm_medium: 'social' }).toString();

          // Generate FB post copy via Claude Haiku
          let fbMessage = `${item.title}\n\n${utmUrl}`;
          try {
            const haiku = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 600,
              messages: [{
                role: 'user',
                content: `Write a compelling Facebook post for a company page promoting this article. 2–3 short paragraphs. No hashtag spam — max 3 relevant tags. Include the URL on its own line at the end.\n\nArticle title: ${item.title}\nArticle URL: ${utmUrl}`
              }]
            });
            fbMessage = haiku.content[0]?.text || fbMessage;
          } catch (e) {
            console.warn('[FB] Haiku post copy failed, using fallback:', e.message);
          }

          if (pipedreamAccountId) {
            // Pipedream Connect path — post directly to stored page ID via proxy.
            // Pipedream holds the page access token from the OAuth consent flow.
            // We do NOT call /me/accounts — that requires permissions Pipedream's built-in app doesn't have.
            try {
              const pageId = creds.pageId;
              if (!pageId) {
                throw new Error('No Facebook Page ID configured. Go to Integrations → Facebook → select a page.');
              }
              console.log('[FB-PIPEDREAM] Publishing to page', pageId, 'via proxy account', pipedreamAccountId);

              // Post directly to /{pageId}/feed — Pipedream proxy injects the page token
              const fbRes = await pipedreamProxy({
                externalUserId: item.brand_profile_id,
                accountId: pipedreamAccountId,
                url: `https://graph.facebook.com/v21.0/${pageId}/feed`,
                method: 'POST',
                data: { message: fbMessage, link: utmUrl },
              });

              console.log('[FB-PIPEDREAM] Post response:', JSON.stringify(fbRes).slice(0, 300));
              if (fbRes.error) throw new Error(fbRes.error.message || 'Facebook publish failed');
              const fbPostId = fbRes.id || fbRes.post_id;
              results[channel] = { status: 'published', postId: fbPostId, url: `https://facebook.com/${fbPostId}`, utmParams };
              
              // Cache pageId so next publish skips discovery
              if (!creds.pageId) {
                await pool.query(
                  `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'facebook'`,
                  [JSON.stringify({ pageId, pageName: targetPage.name }), item.brand_profile_id]
                ).catch(() => {});
              }
            } catch(e) {
              console.error('[FB-PIPEDREAM]', e.message);
              throw new Error(e.message);
            }
          } else {
            // Legacy native path — direct pageId + pageAccessToken
            const { pageId, pageAccessToken } = creds;
            if (!pageId || !pageAccessToken) throw new Error('Facebook not connected. Connect via Pipedream in Integrations.');
            
            const fbRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: fbMessage, link: utmUrl, access_token: pageAccessToken })
            });
            const fbData = await fbRes.json();
            if (!fbRes.ok || fbData.error) throw new Error(fbData.error?.message || 'Facebook publish failed');
            const fbPostUrl = `https://www.facebook.com/${fbData.id?.replace('_', '/posts/')}`;
            results[channel] = { status: 'published', url: fbPostUrl, postId: fbData.id, utmParams };
          }

        } else if (channel === 'reddit') {
          // ── Reddit API publish to company subreddit ──
          const { subreddit, accessToken: redditToken, refreshToken, clientId: redditClientId, clientSecret } = chConfig.credentials || {};
          if (!subreddit || !redditToken) throw new Error('Subreddit name and Reddit access token are required');

          const articleUrl = `https://${process.env.BASE_DOMAIN || 'forgeintelligence.ai'}/articles/${brandSlug}/${articleSlug}`;
          const utmUrl = articleUrl + '?' + new URLSearchParams({ ...utmCtx, utm_source: 'reddit', utm_medium: 'social' }).toString();

          // Helper: attempt token refresh if needed
          const tryRefresh = async (token) => {
            if (!refreshToken || !redditClientId || !clientSecret) return token;
            try {
              const r = await fetch('https://www.reddit.com/api/v1/access_token', {
                method: 'POST',
                headers: {
                  'Authorization': 'Basic ' + Buffer.from(`${redditClientId}:${clientSecret}`).toString('base64'),
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent': 'ForgeIntelligence/1.0'
                },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
              });
              const rData = await r.json();
              return rData.access_token || token;
            } catch { return token; }
          };

          let activeToken = redditToken;
          const submitReddit = async (tok) => fetch('https://oauth.reddit.com/api/submit', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${tok}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'ForgeIntelligence/1.0'
            },
            body: new URLSearchParams({
              sr: subreddit.replace(/^r\//, ''),
              kind: 'link',
              title: item.title,
              url: utmUrl,
              resubmit: 'true',
              nsfw: 'false',
              spoiler: 'false'
            })
          });

          let rdRes = await submitReddit(activeToken);
          // If 401, try refresh once
          if (rdRes.status === 401 && refreshToken) {
            activeToken = await tryRefresh(activeToken);
            rdRes = await submitReddit(activeToken);
          }
          const rdData = await rdRes.json();
          const rdErrors = rdData?.json?.errors;
          if (rdErrors && rdErrors.length > 0) throw new Error(rdErrors[0][1] || 'Reddit submit failed');
          if (!rdRes.ok) throw new Error(`Reddit API error: ${rdRes.status}`);

          const rdPostUrl = rdData?.json?.data?.url || `https://www.reddit.com/r/${subreddit.replace(/^r\//, '')}`;
          results[channel] = { status: 'published', url: rdPostUrl, postId: rdData?.json?.data?.id, utmParams };

        } else if (channel === 'medium') {
          // ── Medium API publish ──
          const { integrationToken } = chConfig.credentials || {};
          if (!integrationToken) throw new Error('Medium integration token is required');

          // Get the authenticated user's Medium ID
          const meRes = await fetch('https://api.medium.com/v1/me', {
            headers: { 'Authorization': `Bearer ${integrationToken}`, 'Content-Type': 'application/json' }
          });
          if (!meRes.ok) throw new Error('Medium token invalid or expired');
          const meData = await meRes.json();
          const authorId = meData.data?.id;
          if (!authorId) throw new Error('Could not retrieve Medium author ID');

          const articleUrl = `https://${process.env.BASE_DOMAIN || 'forgeintelligence.ai'}/articles/${brandSlug}/${articleSlug}`;
          const utmUrl = articleUrl + '?' + new URLSearchParams({ ...utmCtx, utm_source: 'medium', utm_medium: 'social' }).toString();

          // Build HTML content from article sections
          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const htmlBody = sections.map(s =>
            `<h2>${s.heading || ''}</h2><p>${(s.body || '').split('\n').join('</p><p>')}</p>`
          ).join('\n');

          const canonicalNote = `<p><em>Originally published at <a href="${utmUrl}">${process.env.BASE_DOMAIN || 'forgeintelligence.ai'}</a></em></p>`;

          const medRes = await fetch(`https://api.medium.com/v1/users/${authorId}/posts`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${integrationToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: article.title,
              contentFormat: 'html',
              content: `<h1>${article.title}</h1>
${htmlBody}
${canonicalNote}`,
              canonicalUrl: utmUrl,
              publishStatus: 'public',
              notifyFollowers: true,
            })
          });
          const medData = await medRes.json();
          if (!medRes.ok || medData.errors) throw new Error(medData.errors?.[0]?.message || 'Medium publish failed');

          results[channel] = { status: 'published', url: medData.data?.url, postId: medData.data?.id, utmParams };

        } else if (channel === 'ghost') {
          // ── Ghost Admin API publish ──
          // Ghost uses JWT auth derived from the Admin API key (format: id:secret)
          const { adminUrl, adminApiKey } = chConfig.credentials || {};
          if (!adminUrl || !adminApiKey) throw new Error('Ghost Admin URL and Admin API Key are required');

          const [keyId, keySecret] = adminApiKey.split(':');
          if (!keyId || !keySecret) throw new Error('Admin API Key must be in format id:secret — copy it directly from Ghost Admin');

          // Build JWT — Ghost uses HS256 with the hex secret decoded to bytes
          const now = Math.floor(Date.now() / 1000);
          const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
          const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
          const secretBytes = Buffer.from(keySecret, 'hex');
          const sig = createHmac('sha256', secretBytes)
            .update(`${header}.${payload}`)
            .digest('base64url');
          const ghostJwt = `${header}.${payload}.${sig}`;

          const ghostBase = adminUrl.replace(/\/+$/, '');
          const articleUrl = forgeArticleUrl;
          // Use resolved utmParams (utm_source, utm_medium, utm_campaign, utm_content) not raw utmCtx tokens
          const utmUrl = utmParams && Object.keys(utmParams).length > 0
            ? articleUrl + '?' + buildUtmString(utmParams)
            : articleUrl;

          // Build HTML from article sections — Ghost v5 accepts HTML via ?source=html
          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const htmlBody = sections.map(s =>
            `<h2>${s.heading || ''}</h2>\n${(s.body || '').split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('\n')}`
          ).join('\n\n');
          const canonicalNote = `<p><em>Originally published at <a href="${utmUrl}">${process.env.BASE_DOMAIN || 'forgeintelligence.ai'}</a></em></p>`;
          const htmlContent = `${htmlBody}\n\n${canonicalNote}`;

          // feature_image: Ghost v5 accepts external URLs directly
          const ghostFeatureImageUrl = article.hero_image_url || null;
          console.log('[GHOST] feature_image:', ghostFeatureImageUrl || '(none)', '| hero_image_url:', article.hero_image_url || '(null)');

          const ghostRes = await fetch(`${ghostBase}/ghost/api/admin/posts/?source=html`, {
            method: 'POST',
            headers: {
              'Authorization': `Ghost ${ghostJwt}`,
              'Content-Type': 'application/json',
              'Accept-Version': 'v5.0'
            },
            body: JSON.stringify({
              posts: [{
                title: article.title,
                html: htmlContent,
                status: 'published',
                canonical_url: utmUrl,
                meta_title: article.title,
                meta_description: (articleJson.metaDescription || '').slice(0, 300),
                ...(ghostFeatureImageUrl && { feature_image: ghostFeatureImageUrl }),
              }]
            })
          });

          const ghostData = await ghostRes.json();
          if (!ghostRes.ok || ghostData.errors) {
            throw new Error(ghostData.errors?.[0]?.message || `Ghost API error ${ghostRes.status}`);
          }

          const ghostPost = ghostData.posts?.[0];
          results[channel] = { status: 'published', url: ghostPost?.url, postId: ghostPost?.id, utmParams };

        } else {
          results[channel] = { status: 'error', error: `Unknown channel: ${channel}` };
        }
      } catch (chErr) {
        results[channel] = { status: 'error', error: chErr.message };
      }

      // Write publish log
      await pool.query(
        `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          queueItemId, item.brand_profile_id, item.content_id, channel,
          results[channel].status,
          JSON.stringify(results[channel]),
          JSON.stringify(utmParams),
          results[channel].url || null,
          results[channel].error || null
        ]
      );
    }

    // Update queue item status
    const allPublished = targets.every(ch => results[ch]?.status === 'published');
    const anyError = targets.some(ch => results[ch]?.status === 'error');
    const newStatus = allPublished ? 'published' : anyError ? 'partial' : 'staged';

    // Strip transient fields before persisting — only store status + url for published/skipped channels
    const persistResults = Object.fromEntries(
      Object.entries(results).map(([ch, r]) => [
        ch,
        (r.status === 'published' || r.skipped)
          ? { status: r.status, ...(r.url ? { url: r.url } : {}), ...(r.itemId ? { itemId: r.itemId } : {}) }
          : r  // keep error detail for genuinely failed channels
      ])
    );
    // Merge new results into existing publish_results — preserves prior channel results
    await pool.query(
      `UPDATE publishing_queue SET
         status = $1,
         channels = $2,
         publish_results = COALESCE(publish_results, '{}'::jsonb) || $3::jsonb,
         published_at = COALESCE($4, published_at),
         updated_at = NOW()
       WHERE id = $5`,
      [newStatus, JSON.stringify(targets), JSON.stringify(persistResults), allPublished ? new Date() : null, queueItemId]
    );

    // Write memory to Brain on any successful publish
    const successfulChannels = targets.filter(ch => results[ch]?.status === 'published' || results[ch]?.status === 'staged');
    if (successfulChannels.length > 0) {
      pool.query(
        `INSERT INTO memories (id, client_id, raw_content, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, NOW())`,
        [
          item.brand_profile_id,
          `Published: ${article.title}`,
          JSON.stringify({ contentId: item.content_id, channels: successfulChannels, brandProfileId: item.brand_profile_id, publishedAt: new Date(), utmResults: results })
        ]
      ).catch(e => console.error('[MEMORY] Write error:', e.message));
    }

        await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage6_publisher', item?.brand_profile_id||null, 'success', 0, Date.now()-startTime]).catch(e => console.error('[ACTIVITY LOG]', e.message));
        res.json({ success: true, status: newStatus, results });
  } catch (err) {
    console.error('[PUBLISH] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Analytics API ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/analytics/sync/:brandProfileId — pull stats from channels, upsert into content_analytics
// Ghost Admin JWT builder
function buildGhostJWT(apiKey) {
  const [keyId, secret] = apiKey.split(':');
  const secretBytes = Buffer.from(secret, 'hex');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
  const sigInput = `${header}.${payload}`;
  const sig = createHmac('sha256', secretBytes).update(sigInput).digest('base64url');
  return `${sigInput}.${sig}`;
}

app.post('/api/analytics/sync/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  // Allow cron/admin bypass with adminPassword, otherwise require Clerk JWT
  const isCron = req.body?.adminPassword === process.env.ADMIN_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'] });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  }
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  const { channel = 'linkedin' } = req.body;
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const synced = [];
    const errors = [];

    if (channel === 'linkedin' || channel === 'all') {
      // Get all LinkedIn published posts from publish_log
      const logRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                ct.title, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'linkedin' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      // Get LinkedIn credentials from publishing_channels (primary) or channel_credentials (legacy)
      const credRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'linkedin' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const creds = credRes.rows[0]?.credentials || {};
      const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;

      for (const row of logRes.rows) {
        try {
          const postId = row.response_data?.postId || row.response_data?.post_id || row.response_data?.id;
          if (!postId || !token) {
            if (!token) continue; // LinkedIn not connected for this brand — skip
            continue;
          }

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};
          let dataSource = 'none';

          // Step 1: Always try socialActions first — available with w_member_social (no MDP needed)
          // Returns likes + comments for both personal and org posts
          try {
            const actRes = await fetch(
              `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postId)}?projection=(likesSummary,commentsSummary,shareSummary)`,
              { headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' } }
            );
            if (actRes.ok) {
              const actData = await actRes.json();
              reactions = actData?.likesSummary?.totalLikes || 0;
              comments  = actData?.commentsSummary?.totalFirstLevelComments || 0;
              reposts   = actData?.shareSummary?.totalShares || 0;
              rawData   = { ...rawData, socialActions: actData };
              dataSource = 'socialActions';
            } else {
              const errBody = await actRes.text().catch(() => '');
              console.error(`[LINKEDIN-SYNC] socialActions ${actRes.status} for ${postId}: ${errBody.slice(0, 200)}`);
              rawData = { ...rawData, socialActionsError: { status: actRes.status, body: errBody.slice(0, 300) } };
            }
          } catch(e) { console.error(`[LINKEDIN-SYNC] socialActions error: ${e.message}`); }

          // Step 2: Try shareStatistics — requires LinkedIn Marketing Developer Platform approval
          // Will return impressions + clicks once MDP is granted; silently skipped until then
          try {
            const encodedPostId = encodeURIComponent(postId);
            const statsRes = await fetch(
              `https://api.linkedin.com/v2/shareStatistics?q=shares&shares[0]=${encodedPostId}&projection=(elements*(totalShareStatistics))`,
              { headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': '202401' } }
            );
            if (statsRes.ok) {
              const statsData = await statsRes.json();
              const stats = statsData?.elements?.[0]?.totalShareStatistics || {};
              // Only use if MDP data is actually present (non-zero impressions)
              if (stats.impressionCount > 0) {
                impressions = stats.impressionCount || 0;
                clicks      = stats.clickCount     || 0;
                // Use MDP reactions if higher (more accurate than socialActions)
                reactions   = Math.max(reactions, stats.likeCount  || 0);
                comments    = Math.max(comments,  stats.commentCount || 0);
                reposts     = Math.max(reposts,   stats.shareCount  || 0);
                rawData     = { ...rawData, shareStatistics: stats };
                dataSource  = 'shareStatistics';
              }
            }
          } catch(e) { console.error(`[LINKEDIN-SYNC] shareStatistics error: ${e.message}`); }

          // Engagement rate: use impressions if available, else use total engagements as proxy
          const totalEngagement = reactions + comments + reposts + clicks;
          const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
          const engagementRate = impressions > 0
            ? parseFloat((totalEngagement / impressions * 100).toFixed(2))
            : 0;

          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
               reactions=EXCLUDED.reactions, comments=EXCLUDED.comments,
               reposts=EXCLUDED.reposts, ctr=EXCLUDED.ctr,
               engagement_rate=EXCLUDED.engagement_rate,
               raw_data=EXCLUDED.raw_data, synced_at=NOW(),
               campaign_id=COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, 'linkedin', postId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, postId, reactions, comments, reposts, impressions, dataSource });
        } catch(e) {
          errors.push({ contentId: row.content_id, error: e.message });
        }
      }
    }

    // ── X (Twitter) analytics ──────────────────────────────────────────────
    if (channel === 'x' || channel === 'all') {
      const xLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'x' AND pl.status = 'published'
           AND (pl.live_status IS NULL OR pl.live_status != 'deleted')
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      );

      const xCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels
         WHERE brand_profile_id = $1 AND channel = 'x' AND is_active = true
         LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const xCreds = xCredRes.rows[0]?.credentials || {};

      for (const row of xLogRes.rows) {
        try {
          const rd = row.response_data || row.queue_results?.x || {};
          const tweetId = rd.tweetId || rd.id
            || (row.published_url?.match(/\/status\/(\d+)/)?.[1]);
          if (!tweetId) {
            errors.push({ contentId: row.content_id, error: 'no_tweet_id_in:' + row.published_url });
            continue;
          }

          // Build auth header — OAuth 2.0 preferred, 1.0a fallback
          const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;
          const queryString = 'tweet.fields=public_metrics,non_public_metrics,created_at,author_id';
          let authHeader;
          if (xCreds.oauth2AccessToken) {
            authHeader = `Bearer ${xCreds.oauth2AccessToken}`;
          } else {
            const xApiKey       = xCreds.apiKey       || process.env.X_OAUTH1CONSUMER_KEY;
            const xApiSecret    = xCreds.apiSecret    || process.env.X_OAUTH1CONSUMER_SECRET;
            const xAccessToken  = xCreds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
            const xAccessSecret = xCreds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
            if (!xApiKey || !xAccessToken) continue; // X not connected
            authHeader = buildXOAuthHeader('GET', endpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret,
              Object.fromEntries(new URLSearchParams(queryString)));
          }

          const tweetRes = await fetch(`${endpoint}?${queryString}`, {
            headers: { 'Authorization': authHeader }
          });

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};

          if (tweetRes.ok) {
            const tweetData = await tweetRes.json();
            const pub  = tweetData.data?.public_metrics     || {};
            const priv = tweetData.data?.non_public_metrics || {};
            impressions = pub.impression_count || 0;
            reactions   = pub.like_count       || 0;
            comments    = pub.reply_count      || 0;
            reposts     = (pub.retweet_count || 0) + (pub.quote_count || 0);
            // url_link_clicks lives in non_public_metrics — falls back gracefully if unavailable
            clicks      = priv.url_link_clicks || priv.user_profile_clicks || 0;
            rawData     = { public_metrics: pub, non_public_metrics: priv };
          } else {
            const errBody = await tweetRes.json().catch(() => ({}));
            errors.push({ contentId: row.content_id, error: errBody?.detail || errBody?.title || `HTTP ${tweetRes.status}` });
            continue;
          }

          const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
          const engagementRate = impressions > 0
            ? parseFloat(((reactions + comments + reposts + clicks) / impressions * 100).toFixed(2))
            : 0;

          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               post_id=EXCLUDED.post_id,
               impressions=GREATEST(content_analytics.impressions, EXCLUDED.impressions),
               clicks=GREATEST(content_analytics.clicks, EXCLUDED.clicks),
               reactions=GREATEST(content_analytics.reactions, EXCLUDED.reactions),
               comments=GREATEST(content_analytics.comments, EXCLUDED.comments),
               reposts=GREATEST(content_analytics.reposts, EXCLUDED.reposts),
               ctr=EXCLUDED.ctr,
               engagement_rate=EXCLUDED.engagement_rate,
               raw_data=EXCLUDED.raw_data, synced_at=NOW(),
               campaign_id=COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, 'x', tweetId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, tweetId, impressions, reactions, comments, reposts, clicks });
        } catch(e) {
          errors.push({ contentId: row.content_id, error: e.message });
        }
      }
    }

    // Ghost sync
    if (channel === 'ghost' || channel === 'all') {
      // Prefer per-brand credentials from publishing_channels, fall back to env vars
      const ghostCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'ghost' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const ghostCreds  = ghostCredRes.rows[0]?.credentials || {};
      const ghostApiKey = ghostCreds.adminApiKey;
      const ghostApiUrl = (ghostCreds.adminUrl || '').replace(/\/+$/, '');
      if (!ghostApiKey || !ghostApiUrl) {
        // Ghost not configured for this brand — skip
      } else {
        const safeId = brandProfileId.replace(/-/g, '_');
        // Fetch all published posts directly from Ghost Admin API
        const jwt = buildGhostJWT(ghostApiKey);
        const ghostListRes = await fetch(
          `${ghostApiUrl}/ghost/api/admin/posts/?limit=all&filter=status:published&fields=id,title,slug,published_at,reading_time&include=count.clicks,count.positive_feedback,count.negative_feedback`,
          { headers: { 'Authorization': `Ghost ${jwt}`, 'Accept-Version': 'v5.0' } }
        );
        if (!ghostListRes.ok) {
          errors.push({ channel: 'ghost', error: `ghost_list_api_${ghostListRes.status}` });
        } else {
          const ghostListData = await ghostListRes.json();
          const ghostPosts = ghostListData.posts || [];

          // Build title->content_id map from publishing_queue
          const queueRes = await pool.query(
            `SELECT content_id, title FROM publishing_queue WHERE brand_profile_id = $1`,
            [brandProfileId]
          ).catch(() => ({ rows: [] }));
          const titleMap = {};
          for (const r of queueRes.rows) {
            if (r.title) titleMap[r.title.toLowerCase().trim()] = r.content_id;
          }

          // Also check publish_log for ghostPostId matches
          const logRes = await pool.query(
            `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at
             FROM publish_log pl
             WHERE pl.brand_profile_id = $1 AND pl.channel = 'ghost'
             ORDER BY pl.attempted_at DESC`,
            [brandProfileId]
          ).catch(() => ({ rows: [] }));
          const postIdMap = {};
          for (const r of logRes.rows) {
            const gid = r.response_data?.ghostPostId || r.response_data?.id;
            if (gid) postIdMap[gid] = r.content_id;
          }

          for (const post of ghostPosts) {
            try {
              const count = post.count || {};
              const clicks           = count.clicks || 0;
              const positiveFeedback = count.positive_feedback || 0;
              const negativeFeedback = count.negative_feedback || 0;
              const readingTime      = post.reading_time || 0;
              const publishedAt      = post.published_at;

              // Match Ghost post to a content_id — try postIdMap first, then title match
              let contentId = postIdMap[post.id]
                || titleMap[post.title?.toLowerCase().trim()]
                || null;

              // If no match, skip — only track Ghost posts Forge published
              if (!contentId) continue;

              await pool.query(
                `INSERT INTO content_analytics
                  (brand_profile_id, content_id, channel, post_id, clicks, positive_feedback, negative_feedback,
                   reading_time, impressions, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1,$2,'ghost',$3,$4,$5,$6,$7,0,0,0,0,0,0,$8,$9,NOW())
                 ON CONFLICT (brand_profile_id, content_id, channel)
                 DO UPDATE SET clicks=$4, positive_feedback=$5, negative_feedback=$6,
                   reading_time=$7, raw_data=$8, published_at=$9, synced_at=NOW()`,
                [brandProfileId, contentId, post.id, clicks, positiveFeedback,
                 negativeFeedback, readingTime, JSON.stringify({ count, ghost_title: post.title }), publishedAt]
              );
              synced.push({ contentId, ghostPostId: post.id, title: post.title, clicks, positiveFeedback, negativeFeedback, readingTime });
            } catch(e) {
              errors.push({ ghostPostId: post.id, channel: 'ghost', error: e.message });
            }
          }
        }
      }
    }

    // ── WordPress sync ─────────────────────────────────────────────────────
    if (channel === 'wordpress' || channel === 'all') {
      const wpLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.title, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'wordpress' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      for (const row of wpLogRes.rows) {
        try {
          const postId = row.response_data?.postId || row.response_data?.id || null;
          const postUrl = row.published_url || row.response_data?.link || '';
          
          // WordPress doesn't have a simple analytics API — record basic publish data
          // Future: Could integrate Jetpack Stats API if available
          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,'wordpress',$3,0,0,0,0,0,0,0,$4,$5,NOW(),$6)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               post_id=COALESCE(EXCLUDED.post_id, content_analytics.post_id),
               raw_data=EXCLUDED.raw_data, synced_at=NOW(),
               campaign_id=COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, postId, 
             JSON.stringify({ title: row.title, url: postUrl, ...row.response_data }), 
             row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, postId, channel: 'wordpress', url: postUrl });
        } catch(e) {
          errors.push({ contentId: row.content_id, channel: 'wordpress', error: e.message });
        }
      }
    }

    // ── Webflow sync ──────────────────────────────────────────────────────
    if (channel === 'webflow' || channel === 'all') {
      const wfLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.title, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'webflow' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      for (const row of wfLogRes.rows) {
        try {
          const itemId = row.response_data?.itemId || row.response_data?.id || row.response_data?._id || null;
          const postUrl = row.published_url || '';
          
          // Webflow doesn't have a public analytics API — record basic publish data
          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,'webflow',$3,0,0,0,0,0,0,0,$4,$5,NOW(),$6)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               post_id=COALESCE(EXCLUDED.post_id, content_analytics.post_id),
               raw_data=EXCLUDED.raw_data, synced_at=NOW(),
               campaign_id=COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, itemId,
             JSON.stringify({ title: row.title, url: postUrl, ...row.response_data }),
             row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, itemId, channel: 'webflow', url: postUrl });
        } catch(e) {
          errors.push({ contentId: row.content_id, channel: 'webflow', error: e.message });
        }
      }
    }

    res.json({ success: true, channel, synced: synced.length, errors: errors.length, data: synced, errs: errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/analytics/dashboard/:brandProfileId — aggregated dashboard stats
app.get('/api/analytics/dashboard/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  const channel = req.query.channel || 'linkedin';
  try {
    const safeId = brandProfileId.replace(/-/g, '_');

    // Totals
    const totals = await pool.query(
      `SELECT
         COUNT(*) as total_posts,
         COALESCE(SUM(impressions),0) as total_impressions,
         COALESCE(SUM(clicks),0) as total_clicks,
         COALESCE(SUM(reactions),0) as total_reactions,
         COALESCE(SUM(comments),0) as total_comments,
         COALESCE(SUM(reposts),0) as total_reposts,
         COALESCE(AVG(NULLIF(ctr,0)),0) as avg_ctr,
         COALESCE(AVG(NULLIF(engagement_rate,0)),0) as avg_engagement_rate,
         MAX(synced_at) as last_synced
       FROM content_analytics
       WHERE brand_profile_id=$1 AND channel=$2`,
      [brandProfileId, channel]
    );

    // Top 5 posts by impressions — DISTINCT on content_id, latest non-deleted publish_log entry
    const top = await pool.query(
      `SELECT DISTINCT ON (ca.content_id)
              ca.content_id, ca.impressions, ca.clicks, ca.reactions,
              ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
              ca.reading_time, ca.positive_feedback, ca.negative_feedback,
              ca.synced_at AS published_at, ca.synced_at, ca.post_id, ca.raw_data,
              pl.published_url, pq.title, pq.hero_image_url
       FROM content_analytics ca
       LEFT JOIN LATERAL (
         SELECT published_url FROM publish_log
         WHERE content_id = ca.content_id AND channel = ca.channel
           AND status = 'published' AND (live_status IS NULL OR live_status != 'deleted')
         ORDER BY attempted_at DESC LIMIT 1
       ) pl ON true
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id=$1 AND ca.channel=$2
       ORDER BY ca.content_id, ca.impressions DESC, ca.reactions DESC
       LIMIT 5`,
      [brandProfileId, channel]
    );

    // 30-day trend (daily impressions)
    const trend = await pool.query(
      `SELECT DATE_TRUNC('day', synced_at) as day,
              SUM(impressions) as impressions,
              SUM(clicks) as clicks,
              SUM(reactions) as reactions
       FROM content_analytics
       WHERE brand_profile_id=$1 AND channel=$2
         AND synced_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE_TRUNC('day', synced_at)
       ORDER BY day ASC`,
      [brandProfileId, channel]
    ).catch(() => ({ rows: [] }));

    // All posts for table — DISTINCT on content_id, latest non-deleted publish_log entry
    const posts = await pool.query(
      `SELECT DISTINCT ON (ca.content_id)
              ca.content_id, ca.impressions, ca.clicks, ca.reactions,
              ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
              ca.reading_time, ca.positive_feedback, ca.negative_feedback,
              ca.synced_at AS published_at, ca.synced_at, ca.channel, ca.post_id, ca.raw_data,
              pl.published_url, pq.title, pq.hero_image_url
       FROM content_analytics ca
       LEFT JOIN LATERAL (
         SELECT published_url FROM publish_log
         WHERE content_id = ca.content_id AND channel = ca.channel
           AND status = 'published' AND (live_status IS NULL OR live_status != 'deleted')
         ORDER BY attempted_at DESC LIMIT 1
       ) pl ON true
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id=$1 AND ca.channel=$2
       ORDER BY ca.content_id, ca.impressions DESC, ca.synced_at DESC`,
      [brandProfileId, channel]
    );

    const t = totals.rows[0];
    res.json({
      success: true,
      channel,
      totals: {
        posts: parseInt(t.total_posts),
        impressions: parseInt(t.total_impressions),
        clicks: parseInt(t.total_clicks),
        reactions: parseInt(t.total_reactions),
        comments: parseInt(t.total_comments),
        reposts: parseInt(t.total_reposts),
        avgCtr: parseFloat(t.avg_ctr).toFixed(2),
        avgEngagementRate: parseFloat(t.avg_engagement_rate).toFixed(2),
        lastSynced: t.last_synced
      },
      trend: trend.rows.map(r => ({
        day: r.day, impressions: parseInt(r.impressions),
        clicks: parseInt(r.clicks), reactions: parseInt(r.reactions)
      })),
      topPosts: top.rows,
      posts: posts.rows
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/analytics/channels/:brandProfileId — which channels have analytics data
app.get('/api/analytics/channels/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  try {
    const result = await pool.query(
      `SELECT channel, COUNT(*) as post_count, SUM(impressions) as impressions, MAX(synced_at) as last_synced
       FROM content_analytics WHERE brand_profile_id=$1
       GROUP BY channel`,
      [brandProfileId]
    );
    res.json({ success: true, channels: result.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── Campaign-level analytics ──────────────────────────────────────────────────
// GET /api/analytics/campaigns/:brandProfileId
// Returns per-campaign aggregated metrics across all channels.
app.get('/api/analytics/campaigns/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    // Aggregate content_analytics by campaign, join campaigns table for name/topic
    const result = await pool.query(
      `SELECT
         ca.campaign_id,
         c.name              AS campaign_name,
         c.topic_cluster,
         c.created_at        AS campaign_created_at,
         COUNT(DISTINCT ca.content_id)              AS article_count,
         COUNT(DISTINCT ca.channel)                 AS channel_count,
         SUM(ca.impressions)                        AS total_impressions,
         SUM(ca.clicks)                             AS total_clicks,
         SUM(ca.reactions)                          AS total_reactions,
         SUM(ca.comments)                           AS total_comments,
         SUM(ca.reposts)                            AS total_reposts,
         CASE WHEN SUM(ca.impressions) > 0
              THEN ROUND((SUM(ca.clicks)::numeric / SUM(ca.impressions) * 100), 2)
              ELSE 0 END                            AS avg_ctr,
         CASE WHEN SUM(ca.impressions) > 0
              THEN ROUND(((SUM(ca.reactions)+SUM(ca.comments)+SUM(ca.reposts)+SUM(ca.clicks))::numeric
                          / SUM(ca.impressions) * 100), 2)
              ELSE 0 END                            AS avg_engagement_rate,
         MAX(ca.synced_at)                          AS last_synced
       FROM content_analytics ca
       LEFT JOIN campaigns c ON c.id = ca.campaign_id
       WHERE ca.brand_profile_id = $1
         AND ca.campaign_id IS NOT NULL
       GROUP BY ca.campaign_id, c.name, c.topic_cluster, c.created_at
       ORDER BY total_impressions DESC`,
      [brandProfileId]
    );

    // Per-campaign breakdown by channel (for channel comparison within a campaign)
    const breakdown = await pool.query(
      `SELECT
         campaign_id,
         channel,
         COUNT(DISTINCT content_id)  AS article_count,
         SUM(impressions)            AS impressions,
         SUM(clicks)                 AS clicks,
         SUM(reactions)              AS reactions,
         SUM(reposts)                AS reposts
       FROM content_analytics
       WHERE brand_profile_id = $1 AND campaign_id IS NOT NULL
       GROUP BY campaign_id, channel
       ORDER BY campaign_id, impressions DESC`,
      [brandProfileId]
    );

    // Per-campaign article leaderboard (top article per campaign by impressions)
    const safeId = brandProfileId.replace(/-/g, '_');
    const leaderboard = await pool.query(
      `SELECT
         ca.campaign_id,
         ca.content_id,
         ca.channel,
         ca.impressions,
         ca.clicks,
         ca.reactions,
         pq.title,
         pl.published_url
       FROM content_analytics ca
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id::text
       LEFT JOIN LATERAL (
         SELECT published_url FROM publish_log
         WHERE content_id = ca.content_id::text AND status = 'published'
           AND (live_status IS NULL OR live_status != 'deleted')
         ORDER BY attempted_at DESC LIMIT 1
       ) pl ON true
       WHERE ca.brand_profile_id = $1 AND ca.campaign_id IS NOT NULL
       ORDER BY ca.campaign_id, ca.impressions DESC`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // Group breakdown and leaderboard by campaign_id for easy frontend consumption
    const breakdownByCampaign = {};
    for (const row of breakdown.rows) {
      const id = row.campaign_id;
      if (!breakdownByCampaign[id]) breakdownByCampaign[id] = [];
      breakdownByCampaign[id].push(row);
    }
    const leaderboardByCampaign = {};
    for (const row of leaderboard.rows) {
      const id = row.campaign_id;
      if (!leaderboardByCampaign[id]) leaderboardByCampaign[id] = [];
      if (leaderboardByCampaign[id].length < 3) leaderboardByCampaign[id].push(row); // top 3 per campaign
    }

    const campaigns = result.rows.map(r => ({
      ...r,
      channels: breakdownByCampaign[r.campaign_id] || [],
      top_articles: leaderboardByCampaign[r.campaign_id] || [],
    }));

    res.json({ success: true, campaigns });
  } catch(e) {
    console.error('[ANALYTICS/CAMPAIGNS]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Forge Intelligence running on port ' + PORT);
});

// ── Scheduled publish runner ──────────────────────────────────────────────────
// Polls every 60 seconds for queue items due to be published.
// Fires the same publish logic as the manual "Publish Now" button.
async function runScheduledPublishes() {
  try {
    const due = await pool.query(
      `SELECT * FROM publishing_queue
       WHERE status = 'scheduled'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 10`
    );
    if (!due.rows.length) return;

    console.log(`[SCHEDULER] ${due.rows.length} item(s) due for publish`);

    for (const item of due.rows) {
      try {
        // Mark as publishing so concurrent ticks don't double-fire
        await pool.query(
          `UPDATE publishing_queue SET status = 'publishing', updated_at = NOW() WHERE id = $1 AND status = 'scheduled'`,
          [item.id]
        );

        // Load channel connections
        const channelsRes = await pool.query(
          'SELECT * FROM publishing_channels WHERE brand_profile_id = $1',
          [item.brand_profile_id]
        );
        const channelMap = {};
        for (const ch of channelsRes.rows) channelMap[ch.channel] = ch;

        const targets = item.channels || [];
        if (!targets.length) {
          await pool.query(
            `UPDATE publishing_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`,
            [item.id]
          );
          console.warn('[SCHEDULER] No channels set on item', item.id);
          continue;
        }

        // Use the existing publish endpoint internally via a fetch to itself
        // This reuses all the channel logic (LinkedIn, X, Ghost, etc.) without duplicating it
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        const publishRes = await fetch(`${baseUrl}/api/publishing/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queueItemId: item.id, channels: targets, adminPassword: process.env.ADMIN_PASSWORD })
        });
        const publishData = await publishRes.json();

        if (publishData.success) {
          console.log(`[SCHEDULER] Published item ${item.id} to ${targets.join(', ')} — status: ${publishData.status}`);
        } else {
          console.error(`[SCHEDULER] Publish failed for item ${item.id}:`, publishData.error);
          await pool.query(
            `UPDATE publishing_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`,
            [item.id]
          );
        }
      } catch (itemErr) {
        console.error(`[SCHEDULER] Error processing item ${item.id}:`, itemErr.message);
        await pool.query(
          `UPDATE publishing_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [item.id]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[SCHEDULER] Poll error:', err.message);
  }
}




// ── Pipedream Connect Proxy helper ────────────────────────────────────────────
// Get a fresh Pipedream OAuth access token (cache for 55 min)
let _pdAccessToken = null;
let _pdTokenExpiresAt = 0;
async function getPipedreamAccessToken() {
  if (_pdAccessToken && Date.now() < _pdTokenExpiresAt) return _pdAccessToken;
  const clientId = process.env.PIPEDREAM_CLIENT_ID;
  const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Pipedream credentials not configured');
  const r = await fetch('https://api.pipedream.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Pipedream auth failed: ' + JSON.stringify(d));
  _pdAccessToken = d.access_token;
  _pdTokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return _pdAccessToken;
}

// Fetch a connected account's credentials from Pipedream's accounts API
// This returns the real OAuth token (including Page access token for facebook_pages)
async function getPipedreamAccountCredentials(accountId, externalUserId) {
  const projectId = process.env.PIPEDREAM_PROJECT_ID;
  const environment = process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'development';
  if (!projectId) throw new Error('PIPEDREAM_PROJECT_ID not configured');
  
  const pdToken = await getPipedreamAccessToken();
  const url = `https://api.pipedream.com/v1/connect/${projectId}/accounts/${accountId}?include_credentials=true&external_user_id=${encodeURIComponent(externalUserId)}`;
  
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${pdToken}`,
      'x-pd-environment': environment,
    }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Pipedream account fetch error ${r.status}: ${JSON.stringify(d)}`);
  return d.data || d;
}

// Proxy an upstream request through Pipedream Connect — handles token refresh transparently
async function pipedreamProxy({ externalUserId, accountId, url, method = 'GET', headers = {}, data }) {
  const projectId = process.env.PIPEDREAM_PROJECT_ID;
  const environment = process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'development';
  if (!projectId) throw new Error('PIPEDREAM_PROJECT_ID not configured');
  
  const pdToken = await getPipedreamAccessToken();
  // URL-safe base64 encode the upstream URL
  const b64Url = Buffer.from(url).toString('base64url');
  const proxyUrl = `https://api.pipedream.com/v1/connect/${projectId}/proxy/${b64Url}?external_user_id=${encodeURIComponent(externalUserId)}&account_id=${encodeURIComponent(accountId)}`;
  
  const r = await fetch(proxyUrl, {
    method: 'POST',  // Proxy always takes POST — upstream method goes in body
    headers: {
      'Authorization': `Bearer ${pdToken}`,
      'x-pd-environment': environment,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: '',  // Using full URL in path
      method,
      headers,
      ...(data !== undefined ? { data } : {}),
    })
  });
  
  const respText = await r.text();
  let respData;
  try { respData = JSON.parse(respText); } catch { respData = respText; }
  if (!r.ok) throw new Error(`Pipedream proxy error ${r.status}: ${typeof respData === 'string' ? respData : JSON.stringify(respData)}`);
  return respData;
}

// ── Pipedream Connect ─────────────────────────────────────────────────────────

// POST /api/pipedream/token
app.post('/api/pipedream/token', requireAuth, async (req, res) => {
  const { brandProfileId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const clientId = process.env.PIPEDREAM_CLIENT_ID;
    const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET;
    const projectId = process.env.PIPEDREAM_PROJECT_ID;
    if (!clientId || !clientSecret || !projectId) return res.status(500).json({ error: 'Pipedream not configured' });
    const authRes = await fetch('https://api.pipedream.com/v1/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    });
    const authData = await authRes.json();
    if (!authData.access_token) throw new Error('Pipedream auth failed');
    const environment = process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'development';
    const tokenRes = await fetch(`https://api.pipedream.com/v1/connect/${projectId}/tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authData.access_token}`,
        'Content-Type': 'application/json',
        'x-pd-environment': environment
      },
      body: JSON.stringify({ external_user_id: brandProfileId, allowed_origins: ['https://dev.forgeintelligence.ai', 'https://forgeintelligence.ai', 'http://localhost:5173'] })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error(JSON.stringify(tokenData));
    res.json({ token: tokenData.token, expiresAt: tokenData.expires_at });
  } catch(e) { console.error('[PD-TOKEN]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/pipedream/account — store account_id after user connects via Pipedream
app.post('/api/pipedream/account', requireAuth, async (req, res) => {
  const { brandProfileId, channel, accountId, appSlug } = req.body;
  if (!brandProfileId || !channel || !accountId) return res.status(400).json({ error: 'missing fields' });
  try {
    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, $2, $3, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE SET credentials = $3, is_active = true, updated_at = NOW()
    `, [brandProfileId, channel, JSON.stringify({ pipedream_account_id: accountId, app_slug: appSlug, connected_via: 'pipedream_connect' })]);
    res.json({ success: true });
  } catch(e) { console.error('[PD-ACCOUNT]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/pipedream/config — send project config to frontend SDK
app.get('/api/pipedream/config', (req, res) => {
  res.json({
    projectId: process.env.PIPEDREAM_PROJECT_ID,
    environment: process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'development',
    oauthAppIds: {
      facebook_pages: process.env.PIPEDREAM_OAUTH_APP_ID_FACEBOOK || null,
      instagram: process.env.PIPEDREAM_OAUTH_APP_ID_INSTAGRAM || null,
    }
  });
});



// ── Review Workflow ───────────────────────────────────────────────────────────

// POST /api/publishing/queue/:id/request-review — generate review token + optionally email a reviewer
app.post('/api/publishing/queue/:id/request-review', requireAuth, async (req, res) => {
  const { reviewerId } = req.body;
  try {
    const token = randomBytes(24).toString('hex');

    // Get article title for the email
    const qItem = await pool.query(
      'SELECT title, brand_profile_id FROM publishing_queue WHERE id = $1',
      [req.params.id]
    );
    const item = qItem.rows[0];

    await pool.query(
      `UPDATE publishing_queue
       SET review_token = $1, review_status = 'pending', review_requested_at = NOW(),
           reviewer_id = $3, updated_at = NOW()
       WHERE id = $2`,
      [token, req.params.id, reviewerId || null]
    );

    const reviewUrl = `https://dev.forgeintelligence.ai/review/${token}`;

    // Send email if reviewer specified
    if (reviewerId && RESEND_API_KEY) {
      const reviewer = await pool.query('SELECT * FROM reviewers WHERE id = $1', [reviewerId]);
      const r = reviewer.rows[0];
      if (r) {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Forge Intelligence <hello@forgeintelligence.ai>',
            to: r.email,
            subject: `Review requested: ${item?.title || 'Article'}`,
            html: `
              <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: #0F172A; color: #F8FAFC; border-radius: 12px;">
                <div style="margin-bottom: 32px;">
                  <span style="font-family: Inter, sans-serif; font-size: 16px; font-weight: 800; color: #3563FF; letter-spacing: -0.02em;">⬡ Forge Intelligence</span>
                </div>
                <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #F8FAFC;">Review requested</h1>
                <p style="color: #94A3B8; margin-bottom: 24px;">Hi ${r.name}, you've been asked to review an article before it goes live.</p>
                <div style="background: #1E293B; border-radius: 8px; padding: 20px 24px; margin-bottom: 28px; border-left: 3px solid #3563FF;">
                  <p style="font-size: 16px; font-weight: 600; color: #F8FAFC; margin: 0;">${item?.title || 'Article for Review'}</p>
                </div>
                <a href="${reviewUrl}" style="display: inline-block; background: #3563FF; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">Review Article →</a>
                <p style="color: #475569; font-size: 12px; margin-top: 32px;">This link is unique to you and expires after your review is submitted. Powered by Forge Intelligence.</p>
              </div>
            `
          })
        });
        const emailData = await emailRes.json();
        console.log('[REVIEW EMAIL]', emailRes.status, JSON.stringify(emailData));
      }
    }

    res.json({ success: true, token, reviewUrl });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/review/:token — load article for reviewer (no auth required)
app.get('/api/review/:token', async (req, res) => {
  try {
    const qRes = await pool.query(
      `SELECT pq.*, bp.brand_name, bp.brand_url
       FROM publishing_queue pq
       LEFT JOIN brand_profiles bp ON bp.id = pq.brand_profile_id
       WHERE pq.review_token = $1`,
      [req.params.token]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'Review link not found or expired' });
    const item = qRes.rows[0];

    // Load article content
    const safeId = item.brand_profile_id.replace(/-/g, '_');
    const artRes = await pool.query(
      `SELECT title, article_json, hero_image_url, overall_confidence, created_at
       FROM generated_content_${safeId} WHERE id = $1`,
      [item.content_id]
    ).catch(() => ({ rows: [] }));

    const article = artRes.rows[0] || {};
    res.json({
      success: true,
      queueId: item.id,
      title: item.title,
      brandName: item.brand_name,
      brandUrl: item.brand_url,
      heroImageUrl: item.hero_image_url || article.hero_image_url,
      articleJson: article.article_json,
      confidence: article.overall_confidence,
      createdAt: item.created_at,
      reviewStatus: item.review_status,
      reviewComment: item.review_comment,
      reviewRequestedAt: item.review_requested_at,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/review/:token — reviewer submits decision
app.post('/api/review/:token', async (req, res) => {
  const { decision, comment } = req.body; // decision: 'approved' | 'changes_requested'
  if (!['approved', 'changes_requested'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision' });
  }
  try {
    const result = await pool.query(
      `UPDATE publishing_queue
       SET review_status = $1, review_comment = $2, review_actioned_at = NOW(), updated_at = NOW()
       WHERE review_token = $3
       RETURNING id, title, brand_profile_id`,
      [decision, comment || null, req.params.token]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Review link not found' });
    res.json({ success: true, decision });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});




// ── Admin Dashboard ───────────────────────────────────────────────────────────

// Ensure agent_activity_log table exists
pool.query(`CREATE TABLE IF NOT EXISTS agent_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  brand_profile_id TEXT,
  status TEXT DEFAULT 'success',
  tokens_used INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(() => {});

// GET /api/admin/activity — recent agent activity log
app.get('/api/admin/activity', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const agentFilter = req.query.agent || null;
  const brandFilter = req.query.brand || null;
  try {
    let query = `SELECT a.* FROM agent_activity_log a WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (agentFilter) { query += ` AND a.agent_name = $${pi++}`; params.push(agentFilter); }
    if (brandFilter) { query += ` AND a.brand_profile_id = $${pi++}`; params.push(brandFilter); }
    query += ` ORDER BY a.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`;
    params.push(limit, offset);
    const result = await pool.query(query, params);
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM agent_activity_log${agentFilter ? ` WHERE agent_name = '${agentFilter}'` : ''}`,
    );
    res.json({ success: true, activity: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/admin/stats — platform-wide stats
// GET /api/admin/mission-control — full platform dashboard data
app.get('/api/admin/mission-control', requireAuth, async (req, res) => {
  try {
    const [
      brandsRes, activityRes, agentBreakdownRes, brainPatternsRes,
      brainMistakesRes, publishRes, integrationsRes, recentActivityRes
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as cnt FROM brand_profiles WHERE is_active = true'),
      pool.query(`SELECT COUNT(*) as total_calls, COALESCE(SUM(tokens_used),0) as total_tokens,
        COALESCE(AVG(latency_ms),0)::int as avg_latency,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
        COUNT(DISTINCT brand_profile_id) as active_brands
        FROM agent_activity_log WHERE created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT agent_name, COUNT(*) as calls, COALESCE(SUM(tokens_used),0) as tokens,
        COALESCE(AVG(latency_ms),0)::int as avg_ms
        FROM agent_activity_log WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY agent_name ORDER BY tokens DESC`),
      pool.query(`SELECT pattern_type, COUNT(*) as cnt FROM brain_patterns GROUP BY pattern_type`),
      pool.query(`SELECT COUNT(*) as total,
        COUNT(CASE WHEN mistake_type = 'false_positive_flag' THEN 1 END) as false_positives,
        COUNT(CASE WHEN mistake_type = 'human_edit' THEN 1 END) as human_edits
        FROM brain_mistakes`),
      pool.query(`SELECT channel, COUNT(*) as total,
        COUNT(CASE WHEN status = 'published' THEN 1 END) as published,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as errors
        FROM publish_log GROUP BY channel ORDER BY total DESC`),
      pool.query(`SELECT channel, COUNT(*) as total,
        COUNT(CASE WHEN is_active THEN 1 END) as active
        FROM publishing_channels GROUP BY channel ORDER BY channel`),
      pool.query(`SELECT agent_name, brand_profile_id, status, tokens_used, latency_ms, created_at
        FROM agent_activity_log ORDER BY created_at DESC LIMIT 20`),
    ]);

    // Total content across all brands
    const brandIds = (await pool.query('SELECT id FROM brand_profiles')).rows;
    let totalContent = 0;
    for (const b of brandIds) {
      const cnt = await pool.query(`SELECT COUNT(*) FROM generated_content_${b.id.replace(/-/g, '_')}`).catch(() => ({ rows: [{ count: 0 }] }));
      totalContent += parseInt(cnt.rows[0].count);
    }

    // Total reach
    const reachRes = await pool.query('SELECT COALESCE(SUM(impressions),0) as total FROM content_analytics').catch(() => ({ rows: [{ total: 0 }] }));

    // Brain pattern breakdown
    const brainBreakdown = {};
    for (const r of brainPatternsRes.rows) brainBreakdown[r.pattern_type] = parseInt(r.cnt);

    const a = activityRes.rows[0];
    const m = brainMistakesRes.rows[0];

    // Table size monitoring — flag tables over 500KB
    const TABLE_SIZE_THRESHOLD_KB = 500;
    let tableSizeAlerts = [];
    try {
      const sizeRes = await pool.query(`
        SELECT t.table_name,
               pg_relation_size(quote_ident(t.table_name)) as size_bytes,
               pg_size_pretty(pg_relation_size(quote_ident(t.table_name))) as size_pretty,
               (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name) as col_count
        FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_name LIKE 'generated_content_%'
        ORDER BY pg_relation_size(quote_ident(t.table_name)) DESC
      `);
      tableSizeAlerts = sizeRes.rows
        .map(r => ({
          table: r.table_name,
          sizeBytes: parseInt(r.size_bytes),
          sizePretty: r.size_pretty,
          overThreshold: parseInt(r.size_bytes) > TABLE_SIZE_THRESHOLD_KB * 1024
        }));
      const overLimit = tableSizeAlerts.filter(t => t.overThreshold);
      if (overLimit.length > 0) {
        console.warn(`[MISSION-CONTROL] ⚠️ ${overLimit.length} content table(s) exceed ${TABLE_SIZE_THRESHOLD_KB}KB: ${overLimit.map(t => t.table + '=' + t.sizePretty).join(', ')}`);
      }
    } catch(e) { console.log('[MISSION-CONTROL] Table size check note:', e.message); }

    res.json({
      success: true,
      platform: {
        totalBrands: parseInt(brandsRes.rows[0].cnt),
        totalContent,
        totalReach: parseInt(reachRes.rows[0].total),
      },
      brain: {
        writingRules: brainBreakdown.writing_rule || 0,
        contentSignals: brainBreakdown.content_signal || 0,
        totalMistakes: parseInt(m.total),
        humanEdits: parseInt(m.human_edits),
        falsePositives: parseInt(m.false_positives),
        totalPatterns: Object.values(brainBreakdown).reduce((s, v) => s + v, 0),
      },
      activity: {
        totalCalls: parseInt(a.total_calls),
        totalTokens: parseInt(a.total_tokens),
        avgLatency: parseInt(a.avg_latency),
        errors: parseInt(a.errors),
        activeBrands: parseInt(a.active_brands),
        agentBreakdown: agentBreakdownRes.rows.map(r => ({
          agent: r.agent_name, calls: parseInt(r.calls),
          tokens: parseInt(r.tokens), avgMs: parseInt(r.avg_ms)
        })),
      },
      publishing: publishRes.rows.map(r => ({
        channel: r.channel, total: parseInt(r.total),
        published: parseInt(r.published), errors: parseInt(r.errors)
      })),
      integrations: integrationsRes.rows.map(r => ({
        channel: r.channel, total: parseInt(r.total), active: parseInt(r.active)
      })),
      recentActivity: recentActivityRes.rows.map(r => ({
        agent: r.agent_name, brand: r.brand_profile_id,
        status: r.status, tokens: r.tokens_used, latency: r.latency_ms,
        createdAt: r.created_at
      })),
      tableSizes: tableSizeAlerts,
    });
  } catch(e) {
    console.error('[MISSION-CONTROL]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const [brands, activity, content, queue] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM brand_profiles'),
      pool.query(`SELECT 
        COUNT(*) as total_calls,
        SUM(tokens_used) as total_tokens,
        AVG(latency_ms) as avg_latency,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        COUNT(DISTINCT brand_profile_id) as active_brands
        FROM agent_activity_log WHERE created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) FROM (
        SELECT id FROM generated_content_${(await pool.query('SELECT id FROM brand_profiles LIMIT 1')).rows[0]?.id?.replace(/-/g,'_') || 'x'} LIMIT 1
      ) t`).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*), COUNT(CASE WHEN status = 'published' THEN 1 END) as published FROM publishing_queue`),
    ]);

    // Get total content across all brands
    const brandIds = (await pool.query('SELECT id FROM brand_profiles')).rows;
    let totalContent = 0;
    for (const b of brandIds) {
      const safeId = b.id.replace(/-/g, '_');
      const cnt = await pool.query(`SELECT COUNT(*) FROM generated_content_${safeId}`).catch(() => ({ rows: [{ count: 0 }] }));
      totalContent += parseInt(cnt.rows[0].count);
    }

    const agentBreakdown = await pool.query(`
      SELECT agent_name, COUNT(*) as calls, SUM(tokens_used) as tokens, AVG(latency_ms) as avg_latency
      FROM agent_activity_log
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY agent_name ORDER BY calls DESC`);

    res.json({
      success: true,
      stats: {
        totalBrands: parseInt(brands.rows[0].count),
      totalReach: (await pool.query(`SELECT COALESCE(SUM(impressions),0) as total FROM content_analytics`).catch(()=>({rows:[{total:0}]}))).rows[0].total,
      avgConfidence: (await (async () => {
        const bIds = (await pool.query('SELECT id FROM brand_profiles')).rows;
        let total = 0, count = 0;
        for (const b of bIds) {
          const s = b.id.replace(/-/g,'_');
          const r = await pool.query(`SELECT AVG(overall_confidence) as avg FROM generated_content_${s} WHERE overall_confidence IS NOT NULL`).catch(()=>({rows:[{avg:null}]}));
          if (r.rows[0].avg) { total += parseFloat(r.rows[0].avg); count++; }
        }
        return count ? total/count : 0;
      })()),
        totalContent,
        totalQueued: parseInt(queue.rows[0].count),
        totalPublished: parseInt(queue.rows[0].published),
        last30Days: {
          totalCalls: parseInt(activity.rows[0].total_calls),
          totalTokens: parseInt(activity.rows[0].total_tokens) || 0,
          avgLatency: Math.round(parseFloat(activity.rows[0].avg_latency) || 0),
          errorCount: parseInt(activity.rows[0].error_count),
          activeBrands: parseInt(activity.rows[0].active_brands),
        },
        agentBreakdown: agentBreakdown.rows,
      }
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// POST /api/admin/seed-brain — pre-seed a brand brain from a URL
app.post('/api/admin/seed-brain', async (req, res) => {
  const { url, brandName } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    // 1. Create brand profile
    const brandInsert = await pool.query(
      `INSERT INTO brand_profiles (id, brand_url, brand_name, version, is_active, cache_status, profile_data, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, 1, true, 'fresh', '{}'::jsonb, NOW(), NOW()) RETURNING id`,
      [url, brandName || url.replace(/https?:\/\//, '').split('/')[0]]
    );
    const brandProfileId = brandInsert.rows[0].id;
    const safeId = brandProfileId.replace(/-/g, '_');

    // 2. Provision brand tables
    await pool.query(`CREATE TABLE IF NOT EXISTS generated_content_${safeId} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      enriched_brief_id TEXT,
      title TEXT,
      article_json JSONB DEFAULT '{}',
      overall_confidence INTEGER,
      brain_match_score INTEGER,
      status VARCHAR(30) DEFAULT 'draft',
      review_mode TEXT DEFAULT 'approve-to-ship',
      compliance_status TEXT DEFAULT 'pending',
      compliance_report JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // 3. Trigger a Context Hub analysis to seed the brain
    const contextRes = await fetch(`https://${req.headers.host}/api/context-hub/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandProfileId, url, autoSave: true })
    });
    const contextData = await contextRes.json().catch(() => ({}));

    res.json({
      success: true,
      brandProfileId,
      brandName: brandName || url,
      contextTriggered: contextRes.ok,
      message: contextRes.ok
        ? 'Brand created and brain analysis triggered'
        : 'Brand created — trigger Context Hub analysis manually'
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── Reviewers ─────────────────────────────────────────────────────────────────

// GET /api/reviewers/:brandProfileId
app.get('/api/reviewers/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM reviewers WHERE brand_profile_id = $1 ORDER BY name ASC',
      [req.params.brandProfileId]
    );
    res.json({ success: true, reviewers: result.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/reviewers — add reviewer
app.post('/api/reviewers', async (req, res) => {
  const { brandProfileId, name, email, title } = req.body;
  if (!brandProfileId || !name || !email) return res.status(400).json({ error: 'brandProfileId, name, email required' });
  try {
    const result = await pool.query(
      'INSERT INTO reviewers (brand_profile_id, name, email, title) VALUES ($1,$2,$3,$4) RETURNING *',
      [brandProfileId, name, email, title || '']
    );
    res.json({ success: true, reviewer: result.rows[0] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /api/reviewers/:id
app.delete('/api/reviewers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reviewers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});



// ── Clerk Auth Middleware ─────────────────────────────────────────────────────

// Verify Clerk JWT and attach userId to req
// ── Brand ownership verification ─────────────────────────────────────────────
// Every authenticated endpoint that takes a brandProfileId MUST call this.
async function verifyBrandAccess(brandProfileId, userId) {
  if (!brandProfileId || !userId) return false;
  if (SUPER_ADMIN_IDS.includes(userId)) return true;
  const r = await pool.query(
    'SELECT id FROM brand_profiles WHERE id = $1 AND clerk_user_id = $2',
    [brandProfileId, userId]
  );
  return r.rows.length > 0;
}


// ── Brand ownership verification ─────────────────────────────────────────────


async function requireAuth(req, res, next) {
  try {
    // Accept token from Authorization header OR ?token= query param (needed for EventSource SSE)
    const authHeader = req.headers.authorization;
    const queryToken = req.query?.token;
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : queryToken;
    if (!rawToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = rawToken;
    if (!clerkJWKS) return res.status(500).json({ error: 'Auth not configured' });
    const { payload } = await jwtVerify(token, clerkJWKS, { algorithms: ['RS256'] });
    req.userId = payload.sub;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Soft auth — attaches userId if present, continues either way (for public + authed routes)
async function softAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (clerkJWKS) {
        const { payload } = await jwtVerify(token, clerkJWKS, { algorithms: ['RS256'] });
        req.userId = payload.sub;
      }
    }
  } catch { /* no-op */ }
  next();
}

// ── Onboarding / GTM Flow ─────────────────────────────────────────────────────

// Add expires_at to brand_profiles for free trial brains
pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {});
pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false`).catch(() => {});
    await pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS clerk_user_id TEXT`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bp_clerk ON brand_profiles(clerk_user_id)`).catch(() => {});
pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS onboard_session_id TEXT`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS payment_events (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    brand_profile_id TEXT NOT NULL,
    order_id TEXT,
    amount NUMERIC(10,2) DEFAULT 99.00,
    currency VARCHAR(10) DEFAULT 'USD',
    source VARCHAR(50) DEFAULT 'paypal',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});

// POST /api/onboard/analyze — landing page entry point
// Creates a UUID, seeds the brain, fires Context Agent, returns session
app.post('/api/onboard/analyze', async (req, res) => {
  const { url, sessionId } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    // Normalise URL
    const brandUrl = url.startsWith('http') ? url : `https://${url}`;
    const brandName = brandUrl.replace(/https?:\/\//, '').split('/')[0].replace(/^www\./, '');

    // Create brand profile with 24hr expiry + session ID for persistence
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // Use ON CONFLICT to handle concurrent scans of the same URL
    const brandInsert = await pool.query(
      `INSERT INTO brand_profiles (id, brand_url, brand_name, version, is_active, cache_status, profile_data, expires_at, is_paid, onboard_session_id, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, 1, true, 'fresh', '{}'::jsonb, $3, false, $4, NOW(), NOW())
       ON CONFLICT (brand_url) WHERE is_active = true
       DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [brandUrl, brandName, expiresAt, sessionId || null]
    );
    const brandProfileId = brandInsert.rows[0].id;
    const safeId = brandProfileId.replace(/-/g, '_');

    // Provision content table
    await pool.query(`CREATE TABLE IF NOT EXISTS generated_content_${safeId} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id TEXT NOT NULL,
      enriched_brief_id TEXT,
      title TEXT,
      article_json JSONB DEFAULT '{}',
      overall_confidence INTEGER,
      brain_match_score INTEGER,
      status VARCHAR(30) DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});

    res.json({ success: true, brandProfileId, brandName, brandUrl, expiresAt });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/onboard/brain/:brandProfileId — check if brain exists and is still valid
app.get('/api/onboard/brain/:brandProfileId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, brand_name, brand_url, expires_at, is_paid FROM brand_profiles WHERE id = $1',
      [req.params.brandProfileId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Brain not found' });
    const brain = result.rows[0];
    const expired = !brain.is_paid && brain.expires_at && new Date(brain.expires_at) < new Date();
    res.json({ success: true, brain: { ...brain, expired } });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── Live Log Endpoints (Mission Control) ──────────────────────────────────────
app.get('/api/admin/logs/stream', requireAuth, (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  // Send last 50 entries as backfill
  const backfill = logBuffer.slice(-50);
  for (const entry of backfill) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  logSSEClients.add(res);
  req.on('close', () => logSSEClients.delete(res));
});

app.get('/api/admin/logs/recent', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const level = req.query.level; // 'error', 'warn', or null for all
  let filtered = logBuffer;
  if (level === 'error') filtered = logBuffer.filter(e => e.isError);
  else if (level === 'warn') filtered = logBuffer.filter(e => e.isWarn);
  res.json({ success: true, logs: filtered.slice(-limit), total: filtered.length });
});

app.get('/api/admin/logs/errors', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ success: true, errors: errorAggregates.slice().reverse(), total: errorAggregates.length });
});


// ── Render Deploy Status (Mission Control) ────────────────────────────────────
app.get('/api/admin/deploys', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const renderKey = process.env.RENDER_API_KEY;
    if (!renderKey) return res.json({ success: true, production: [], development: [] });
    
    const fetchDeploys = async (serviceId, label) => {
      const r = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=10`, {
        headers: { 'Authorization': `Bearer ${renderKey}` }
      });
      const data = await r.json();
      return (data || []).map(d => {
        const dep = d.deploy || d;
        return {
          id: dep.id,
          status: dep.status,
          commitMessage: dep.commit?.message || '',
          commitId: dep.commit?.id?.slice(0, 10) || '',
          createdAt: dep.createdAt,
          finishedAt: dep.finishedAt,
          env: label
        };
      });
    };

    const prodId = process.env.PRODUCTION_SERVICE_ID || 'srv-d73bct6a2pns73a8c65g';
    const devId = process.env.DEVELOPMENT_SERVICE_ID || 'srv-d726u7ea2pns739kopmg';

    const [production, development] = await Promise.all([
      fetchDeploys(prodId, 'production').catch(() => []),
      fetchDeploys(devId, 'development').catch(() => [])
    ]);

    res.json({ success: true, production, development });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/onboard/paypal-success — called after PayPal payment confirmed
// Removes expiry, marks as paid, unlocks all stages
app.post('/api/onboard/paypal-success', async (req, res) => {
  const { brandProfileId, orderId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    await pool.query(
      `UPDATE brand_profiles SET is_paid = true, expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [brandProfileId]
    );
    await pool.query(
      `INSERT INTO payment_events (brand_profile_id, order_id, amount, currency, source) VALUES ($1, $2, 99.00, 'USD', 'paypal')`,
      [brandProfileId, orderId || null]
    ).catch(() => {});
    console.log('[PAYPAL] Payment confirmed — brandProfileId:', brandProfileId, 'orderId:', orderId);
    res.json({ success: true, unlocked: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// GET /api/auth/me — returns the authenticated user's brand profile
// Optional ?brand_id=xxx — tethers an existing brand to this user on first sign-in
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const brandId = req.query.brand_id || null;
    const isSuperAdmin = SUPER_ADMIN_IDS.includes(req.userId);

    // If brand_id provided and user has no brand yet, tether it
    if (brandId && !isSuperAdmin) {
      const existing = await pool.query(
        `SELECT id FROM brand_profiles WHERE clerk_user_id = $1 LIMIT 1`,
        [req.userId]
      );
      if (!existing.rows.length) {
        await pool.query(
          `UPDATE brand_profiles SET clerk_user_id = $1, updated_at = NOW() WHERE id = $2 AND (clerk_user_id IS NULL)`,
          [req.userId, brandId]
        );
        console.log(`[AUTH] Tethered brand ${brandId} to user ${req.userId}`);
      }
    }

    // Super admin: return ALL brands + auto-tether orphans
    if (isSuperAdmin) {
      // Auto-tether orphan brain ONLY if brand_id explicitly passed (from onboard/gate flow)
      if (brandId) {
        const tethered = await pool.query(
          `UPDATE brand_profiles SET clerk_user_id = $1, updated_at = NOW()
           WHERE id = $2 AND clerk_user_id IS NULL RETURNING id, brand_name`,
          [req.userId, brandId]
        );
        if (tethered.rows.length > 0) {
          console.log(`[AUTH] Tethered brand ${tethered.rows[0].brand_name} (${brandId}) to super admin ${req.userId}`);
        }
      }

      const allBrands = await pool.query(
        `SELECT id, brand_url, brand_name, is_paid, is_active, updated_at 
         FROM brand_profiles WHERE is_active = true ORDER BY updated_at DESC`
      );
      // If brand_id specified, use that; otherwise first one
      let activeBrand = allBrands.rows[0] || null;
      if (brandId) {
        const match = allBrands.rows.find(b => b.id === brandId);
        if (match) activeBrand = match;
      }
      console.log(`[AUTH] Super admin ${req.userId} — ${allBrands.rows.length} brands available`);
      // Fire-and-forget: sync user to HubSpot CRM
      syncUserToHubSpot(req.userId).catch(() => {});
      return res.json({
        success: true,
        userId: req.userId,
        isSuperAdmin: true,
        brand: activeBrand,
        allBrands: allBrands.rows.map(b => ({
          id: b.id,
          brandName: b.brand_name || b.brand_url,
          brandUrl: b.brand_url,
          isPaid: b.is_paid || false,
        })),
        isPaid: true, // Super admins always paid
      });
    }

    // Regular user flow
    const allUserBrands = await pool.query(
      `SELECT id, brand_url, brand_name, is_paid, updated_at FROM brand_profiles WHERE clerk_user_id = $1 AND is_active = true ORDER BY updated_at DESC`,
      [req.userId]
    );
    let result = { rows: allUserBrands.rows.slice(0, 1) };
    // No tethered brand — only tether if brand_id explicitly provided (from GateModal/onboard flow)
    if (!result.rows.length && brandId) {
      const candidate = await pool.query(
        `SELECT * FROM brand_profiles WHERE id = $1 AND (clerk_user_id IS NULL OR clerk_user_id = $2) AND is_active = true LIMIT 1`,
        [brandId, req.userId]
      );
      if (candidate.rows.length) {
        await pool.query(
          `UPDATE brand_profiles SET clerk_user_id = $1, updated_at = NOW() WHERE id = $2`,
          [req.userId, candidate.rows[0].id]
        );
        result = candidate;
        console.log(`[AUTH] Tethered brand ${candidate.rows[0].id} to user ${req.userId} (explicit brand_id)`);
      }
    }
    // Fire-and-forget: sync user to HubSpot CRM
    syncUserToHubSpot(req.userId).catch(() => {});
    
    res.json({
      success: true,
      userId: req.userId,
      isSuperAdmin: isSuperAdmin,
      brand: result.rows[0] || null,
      allBrands: allUserBrands.rows.map(b => ({
        id: b.id,
        brandName: b.brand_name || b.brand_url,
        brandUrl: b.brand_url,
        isPaid: b.is_paid || false,
      })),
      isPaid: isSuperAdmin || result.rows[0]?.is_paid || false,
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ── Promo Codes ───────────────────────────────────────────────────────────────

// Promo redemptions table
pool.query(`CREATE TABLE IF NOT EXISTS promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  brand_profile_id TEXT NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(code, brand_profile_id)
)`).catch(() => {});

// Promo codes stored server-side — never expose to client
const PROMO_CODES = new Map([
  ['FORGEFRIEND',   { discount: 100, description: 'Friend of Forge' }],
  ['EARLYBIRD',     { discount: 100, description: 'Early Access' }],
  ['SANDBOX100',    { discount: 100, description: 'Sandbox Group Internal' }],
]);

// POST /api/promo/validate — validate a promo code (unlimited use)
app.post('/api/promo/validate', softAuth, async (req, res) => {
  const { code, brandProfileId: providedId } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const normalised = code.trim().toUpperCase();
  const promo = PROMO_CODES.get(normalised);
  if (!promo) return res.json({ valid: false, message: 'Invalid promo code' });

  // Resolve brandProfileId — use provided, or look up from auth token
  let brandProfileId = providedId;
  if (!brandProfileId && req.userId) {
    const lookup = await pool.query(
      'SELECT id FROM brand_profiles WHERE clerk_user_id = $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1',
      [req.userId]
    );
    if (lookup.rows.length) brandProfileId = lookup.rows[0].id;
  }
  // No global fallback — brandProfileId must come from frontend or auth token
  // Without it, the promo validates but is_paid does NOT flip (logged as warning)

  // Apply — mark brand as paid
  if (promo.discount === 100 && brandProfileId) {
    await pool.query(
      `UPDATE brand_profiles SET is_paid = true, expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [brandProfileId]
    );
    console.log(`[PROMO] ${normalised} applied to brand ${brandProfileId} — ${promo.description}`);
  } else if (promo.discount === 100) {
    console.warn(`[PROMO] ${normalised} validated but no brandProfileId found — is_paid NOT set`);
  }

  res.json({ valid: true, discount: promo.discount, message: `Code applied — ${promo.description}` });
});



// POST /api/admin/reset-brand-paid — dev only, resets is_paid for testing
app.post('/api/admin/reset-brand-paid', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && !req.body.adminPassword === process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { brandProfileId, adminPassword } = req.body;
  if (adminPassword !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(
      `UPDATE brand_profiles SET is_paid = false, expires_at = NOW() + INTERVAL '24 hours', clerk_user_id = NULL, updated_at = NOW() WHERE id = $1`,
      [brandProfileId]
    );
    await pool.query(
      `DELETE FROM promo_redemptions WHERE brand_profile_id = $1`,
      [brandProfileId]
    );
    res.json({ success: true, message: 'Brand reset to free tier + promo redemptions cleared' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});




// ── Perplexity webhook drain — receives usage events ──────────────────────────
app.post('/api/webhooks/perplexity', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const drainToken = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
    if (!drainToken || drainToken !== process.env.PERPLEXITY_DRAIN_TOKEN) {
      return res.status(403).json({ error: 'Invalid drain token' });
    }
    console.log('[Perplexity webhook]', JSON.stringify(req.body).slice(0, 500));
    const payload = req.body || {};
    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      ['perplexity_webhook', null, 'success', payload.tokens_used || 0, payload.duration_ms || 0]
    ).catch(() => {});
    res.json({ received: true });
  } catch(e) {
    console.error('[Perplexity webhook] Error:', e.message);
    res.json({ received: true });
  }
});

// ── fal.ai webhook drain — receives event logs from fal.ai dashboard ─────────
app.post('/api/webhooks/fal', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const drainToken = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
    if (!drainToken || drainToken !== process.env.FAL_DRAIN_TOKEN) {
      return res.status(403).json({ error: 'Invalid drain token' });
    }
    console.log('[fal.ai webhook]', JSON.stringify(req.body).slice(0, 500));
    const payload = req.body || {};
    const endpoint = payload.endpoint || payload.model || 'unknown';
    const status = payload.status === 'OK' || payload.status === 200 ? 'success' : (payload.status || 'received');
    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      ['fal_webhook', null, String(status), 0, payload.duration_ms || 0]
    ).catch(() => {});
    res.json({ received: true });
  } catch(e) {
    console.error('[fal.ai webhook] Error:', e.message);
    res.json({ received: true });
  }
});

// ── Manual Metrics Input — for channels without API access yet ────────────────
app.post('/api/analytics/manual', requireAuth, async (req, res) => {
  const { brandProfileId, contentId, channel, impressions, clicks, reactions, comments, reposts } = req.body;
  if (!brandProfileId || !contentId || !channel) {
    return res.status(400).json({ success: false, error: 'brandProfileId, contentId, and channel required' });
  }
  try {
    await pool.query(
      `INSERT INTO content_analytics (brand_profile_id, content_id, channel, impressions, clicks, reactions, comments, reposts, synced_at, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), '{"source":"manual"}')
       ON CONFLICT (content_id, channel)
       DO UPDATE SET
         impressions = GREATEST(content_analytics.impressions, EXCLUDED.impressions),
         clicks = GREATEST(content_analytics.clicks, EXCLUDED.clicks),
         reactions = GREATEST(content_analytics.reactions, EXCLUDED.reactions),
         comments = GREATEST(content_analytics.comments, EXCLUDED.comments),
         reposts = GREATEST(content_analytics.reposts, EXCLUDED.reposts),
         synced_at = NOW(),
         raw_data = jsonb_set(COALESCE(content_analytics.raw_data, '{}'), '{source}', '"manual"')`,
      [brandProfileId, contentId, channel, impressions || 0, clicks || 0, reactions || 0, comments || 0, reposts || 0]
    );
    console.log(`[ANALYTICS] Manual metrics saved: ${channel} for ${contentId} — ${impressions} impr, ${clicks} clicks`);
    res.json({ success: true });
  } catch(e) {
    console.error('[ANALYTICS] Manual save error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Sitemap.xml ──────────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  const isProduction = req.hostname === 'forgeintelligence.ai';
  if (!isProduction) return res.status(404).send('No sitemap for dev');

  const urls = [
    { loc: 'https://forgeintelligence.ai/', priority: '1.0', changefreq: 'weekly', lastmod: new Date().toISOString() },
    { loc: 'https://forgeintelligence.ai/product', priority: '0.9', changefreq: 'weekly', lastmod: new Date().toISOString() },
  ];

  // Pull the Forge Intelligence brand's own published articles so Google indexes them.
  // Only this brand's articles (not customer brands) — customer articles live on their own domains.
  try {
    const brandRes = await pool.query(`SELECT id, brand_name FROM brand_profiles WHERE brand_name = 'Forge Intelligence' LIMIT 1`);
    if (brandRes.rows.length) {
      const brand = brandRes.rows[0];
      const safeId = brand.id.replace(/-/g, '_');
      const brandSlug = (brand.brand_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const articlesRes = await pool.query(
        `SELECT title, created_at, updated_at FROM generated_content_${safeId} WHERE compliance_status IN ('approved', 'ready') ORDER BY created_at DESC LIMIT 500`
      ).catch(() => ({ rows: [] }));
      for (const a of articlesRes.rows) {
        const articleSlug = (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
        if (articleSlug) {
          urls.push({
            loc: `https://forgeintelligence.ai/articles/${brandSlug}/${articleSlug}`,
            priority: '0.7',
            changefreq: 'monthly',
            lastmod: (a.updated_at || a.created_at || new Date()).toISOString ? new Date(a.updated_at || a.created_at).toISOString() : new Date().toISOString()
          });
        }
      }
    }
  } catch(e) {
    console.error('[SITEMAP] article enumeration failed (non-fatal):', e.message);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(xml);
});

// ── Robots.txt — block crawlers on dev, allow on production ──────────────────
app.get('/robots.txt', (req, res) => {
  const host = req.headers.host || '';
  const isDev = host.includes('dev.');
  res.type('text/plain');
  res.send(isDev
    ? 'User-agent: *\nDisallow: /'
    : 'User-agent: *\nAllow: /\nDisallow: /app/\nSitemap: https://forgeintelligence.ai/sitemap.xml'
  );
});

// ── Neon SQL Relay ────────────────────────────────────────────────────────────
app.post('/api/admin/relay', express.json({ limit: '500kb' }), async (req, res) => {
  const { adminPassword, query, values } = req.body;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const result = await pool.query(query, values || []);
    return res.json({ success: true, rows: result.rows, rowCount: result.rowCount });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Content Import (Bring Your Own Article) ──────────────────────────────────

// POST /api/content/import — parse + score an externally written article
app.post('/api/content/import', requireAuth, async (req, res) => {
  const { brandProfileId, url, rawText, title: manualTitle } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  if (!url && !rawText) return res.status(400).json({ error: 'url or rawText required' });

  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;

    // 1. Get content — scrape URL or use raw text
    let rawContent = rawText || '';
    let sourceTitle = manualTitle || '';

    if (url && !rawText) {
      try {
        const fetchRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForgeIntelligence/1.0)' },
          signal: AbortSignal.timeout(8000)
        });
        const html = await fetchRes.text();
        // Strip HTML tags, extract readable text
        rawContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s{3,}/g, '\n\n')
          .trim()
          .slice(0, 12000);

        // Try to extract title from <title> tag
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) sourceTitle = titleMatch[1].replace(/\s*(\||\u2013|\u2014|-).*$/, '').trim();
      } catch(e) {
        return res.status(400).json({ error: `Could not fetch URL: ${e.message}` });
      }
    }

    // 2. Load brand profile for Brain context
    const brandRes = await pool.query(
      'SELECT brand_name, brand_url, voice_profile, personas, competitive_gaps FROM brand_profiles WHERE id = $1',
      [brandProfileId]
    );
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // 3. Load brain patterns + mistakes
    const patternsRes = await pool.query(
      'SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8',
      [brandProfileId]
    ).catch(() => ({ rows: [] }));
    const mistakesRes = await pool.query(
      'SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 6',
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // 4. Claude Sonnet: parse + audit the article against the Brain
    const auditPrompt = `You are the Forge Intelligence Brain Auditor. An article was written OUTSIDE of Forge and is being imported for scoring.

BRAND: ${brand.brand_name} (${brand.brand_url})
VOICE PROFILE: ${JSON.stringify(brand.voice_profile || {}).slice(0, 500)}
BRAIN PATTERNS (what works): ${patternsRes.rows.map(p => p.description).join('; ').slice(0, 600)}
BRAIN MISTAKES (what fails): ${mistakesRes.rows.map(m => m.description).join('; ').slice(0, 400)}

IMPORTED ARTICLE TITLE: ${sourceTitle || 'Unknown'}

IMPORTED CONTENT:
${rawContent.slice(0, 6000)}

Your job:
1. Parse this article into structured sections
2. Score it against the brand brain
3. Identify voice deviations, missing depth, and structural issues
4. Be honest. This was written outside the system. Show it.

Return ONLY valid JSON:
{
  "title": "article title",
  "metaDescription": "one sentence summary",
  "overallConfidence": 0-100,
  "brainMatchScore": 0-100,
  "voiceDeviationScore": 0-100,
  "importVerdict": "brief honest verdict (1-2 sentences)",
  "sections": [
    {
      "heading": "section heading",
      "body": "section body text",
      "confidence": 0-100,
      "flags": ["flag1", "flag2"]
    }
  ],
  "brainFlags": ["top-level issues the brain detected"],
  "suggestions": ["concrete improvements the brain recommends"]
}`;

    const auditRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: auditPrompt }]
      })
    });
    const auditData = await auditRes.json();
    const auditText = auditData.content?.[0]?.text || '';
    const parsed = JSON.parse(auditText.replace(/```json|```/g, '').trim());

    // 5. Insert into generated_content as 'imported' status
    const cleanedParsed = stripScaffoldingArtifacts(parsed);
    const insertRes = await pool.query(
      `INSERT INTO ${tableName} (brand_profile_id, title, article_json, overall_confidence, brain_match_score, status, review_mode, compliance_status)
       VALUES ($1, $2, $3, $4, $5, 'staged', 'approve-to-ship', 'pending') RETURNING id`,
      [
        brandProfileId,
        cleanedParsed.title || sourceTitle || 'Imported Article',
        JSON.stringify({
          ...cleanedParsed,
          importedFrom: url || 'manual',
          importedAt: new Date().toISOString()
        }),
        parsed.overallConfidence || 50,
        parsed.brainMatchScore || 50
      ]
    );
    const contentId = insertRes.rows[0].id;

    // 6. Stage in publishing queue
    await pool.query(
      `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'staged', NOW(), NOW())
       ON CONFLICT (content_id) DO NOTHING`,
      [brandProfileId, contentId, parsed.title || sourceTitle]
    );

    res.json({
      success: true,
      contentId,
      title: parsed.title || sourceTitle,
      overallConfidence: parsed.overallConfidence,
      brainMatchScore: parsed.brainMatchScore,
      voiceDeviationScore: parsed.voiceDeviationScore,
      importVerdict: parsed.importVerdict,
      brainFlags: parsed.brainFlags || [],
      suggestions: parsed.suggestions || [],
      sectionCount: parsed.sections?.length || 0
    });

  } catch(e) {
    console.error('[CONTENT-IMPORT]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Topic Ideas ───────────────────────────────────────────────────────────────

// GET /api/topic-ideas/:brandProfileId
app.get('/api/topic-ideas/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM topic_ideas WHERE brand_profile_id = $1 ORDER BY created_at DESC`,
      [req.params.brandProfileId]
    );
    res.json({ success: true, ideas: r.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/topic-ideas
app.post('/api/topic-ideas', requireAuth, async (req, res) => {
  const { brandProfileId, topic, note } = req.body;
  if (!brandProfileId || !topic?.trim()) return res.status(400).json({ error: 'brandProfileId and topic required' });
  try {
    const r = await pool.query(
      `INSERT INTO topic_ideas (brand_profile_id, topic, note) VALUES ($1, $2, $3) RETURNING *`,
      [brandProfileId, topic.trim(), note?.trim() || null]
    );
    res.json({ success: true, idea: r.rows[0] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// PATCH /api/topic-ideas/:id — update status (idea → in_progress → generated)
app.patch('/api/topic-ideas/:id', requireAuth, async (req, res) => {
  const { status, topic, note } = req.body;
  try {
    const updates = []; const params = []; let pi = 1;
    if (status) { updates.push(`status = $${pi++}`); params.push(status); }
    if (topic) { updates.push(`topic = $${pi++}`); params.push(topic); }
    if (note !== undefined) { updates.push(`note = $${pi++}`); params.push(note); }
    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);
    await pool.query(`UPDATE topic_ideas SET ${updates.join(', ')} WHERE id = $${pi}`, params);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /api/topic-ideas/:id
app.delete('/api/topic-ideas/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM topic_ideas WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Content Library ───────────────────────────────────────────────────────────

// GET /api/content-library — returns all generated content across all brands or filtered by brand
app.get('/api/content-library', requireAuth, async (req, res) => {
  const { brandProfileId, status, search, campaign, limit = 50, offset = 0 } = req.query;
  try {
    // Get all brands or just the requested one
    const brandsRes = brandProfileId
      ? await pool.query('SELECT id, brand_name, brand_url FROM brand_profiles WHERE id = $1', [brandProfileId])
      : await pool.query('SELECT id, brand_name, brand_url FROM brand_profiles WHERE is_active = true ORDER BY created_at DESC');

    const brands = brandsRes.rows;
    const allItems = [];

    for (const brand of brands) {
      const safeId = brand.id.replace(/-/g, '_');
      const tableName = `generated_content_${safeId}`;

      // Check table exists
      const tableExists = await pool.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [tableName]
      );
      if (!tableExists.rows[0].exists) continue;

      // Build query with filters
      const conditions = ['1=1'];
      const params = [];
      let pi = 1;

      if (status && status !== 'all') {
        conditions.push(`COALESCE(pq.status, 'draft') = $${pi++}`);
        params.push(status);
      }
      if (search) {
        conditions.push(`gc.title ILIKE $${pi++}`);
        params.push(`%${search}%`);
      }
      if (campaign) {
        conditions.push(`gc.campaign_id = $${pi++}`);
        params.push(campaign);
      }

      const rows = await pool.query(`
        SELECT
          gc.id,
          gc.title,
          gc.overall_confidence,
          gc.brain_match_score,
          gc.compliance_status,
          gc.hero_image_url,
          gc.campaign_id,
          gc.created_at,
          gc.updated_at,
          gc.article_json->>'metaDescription' AS meta_description,
          COALESCE(pq.status, 'draft') AS queue_status,
          pq.published_at,
          pq.id AS queue_id,
          ARRAY_AGG(DISTINCT pl.channel) FILTER (WHERE pl.live_status = 'published') AS published_channels,
          ARRAY_AGG(DISTINCT pl.published_url) FILTER (WHERE pl.published_url IS NOT NULL) AS live_urls,
          MAX(ca.impressions) AS impressions,
          MAX(ca.clicks) AS clicks,
          '${brand.id}' AS brand_profile_id,
          '${brand.brand_name || brand.brand_url}' AS brand_name,
          '${brand.brand_url}' AS brand_url
        FROM ${tableName} gc
        LEFT JOIN publishing_queue pq ON pq.content_id = gc.id::text::text
        LEFT JOIN publish_log pl ON pl.content_id = gc.id::text
        LEFT JOIN content_analytics ca ON ca.content_id = gc.id::text AND ca.brand_profile_id = '${brand.id}'
        WHERE ${conditions.join(' AND ')}
        GROUP BY gc.id, gc.title, gc.overall_confidence, gc.brain_match_score,
          gc.compliance_status, gc.hero_image_url, gc.campaign_id,
          gc.created_at, gc.updated_at, gc.article_json,
          pq.status, pq.published_at, pq.id
        ORDER BY gc.created_at DESC
      `, params).catch(() => ({ rows: [] }));

      allItems.push(...rows.rows);
    }

    // Sort all by created_at desc, apply pagination
    allItems.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const total = allItems.length;
    const paginated = allItems.slice(Number(offset), Number(offset) + Number(limit));

    res.json({ success: true, items: paginated, total, limit: Number(limit), offset: Number(offset) });
  } catch(e) {
    console.error('[CONTENT-LIBRARY]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GEO Citation Tracker ──────────────────────────────────────────────────────

// DB table for citations
// Created in initDB — added below to migration

// GET /api/geo/debug/:brandProfileId — diagnostic endpoint, remove after debugging
app.get('/api/geo/debug/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  const out = { brandProfileId, env: {}, db: {}, apiTest: {} };

  // Check env vars
  out.env.hasOpenAI = !!process.env.OPENAI_API_KEY;
  out.env.hasPerplexity = !!process.env.PERPLEXITY_API_KEY;

  // Check geo_citations rows
  try {
    const r = await pool.query(
      'SELECT engine, query, is_cited, checked_at FROM geo_citations WHERE brand_profile_id = $1 ORDER BY checked_at DESC LIMIT 10',
      [brandProfileId]
    );
    out.db.rowCount = r.rows.length;
    out.db.recentRows = r.rows;
  } catch(e) { out.db.error = e.message; }

  // Check brand + articles
  try {
    const brandRes = await pool.query('SELECT id, brand_name, brand_url, article_base_url FROM brand_profiles WHERE id = $1', [brandProfileId]);
    out.brand = brandRes.rows[0] || null;
    if (out.brand) {
      const safeId = brandProfileId.replace(/-/g, '_');
      const artRes = await pool.query(`SELECT id, title FROM generated_content_${safeId} ORDER BY created_at DESC LIMIT 3`).catch(() => ({ rows: [] }));
      out.db.recentArticles = artRes.rows;
    }
  } catch(e) { out.brand = { error: e.message }; }

  // Test one OpenAI call
  if (process.env.OPENAI_API_KEY) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 12000);
      const oRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', tools: [{ type: 'web_search_preview' }], input: 'What is Forge Intelligence?' }),
        signal: controller.signal
      });
      const oData = await oRes.json();
      out.apiTest.openai = { status: oRes.status, hasOutput: !!oData.output, error: oData.error || null, rawKeys: Object.keys(oData) };
    } catch(e) { out.apiTest.openai = { error: e.message }; }
  }

  // Test one Perplexity call
  if (process.env.PERPLEXITY_API_KEY) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 12000);
      const pRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: 'What is Forge Intelligence?' }], max_tokens: 100 }),
        signal: controller.signal
      });
      const pData = await pRes.json();
      out.apiTest.perplexity = { status: pRes.status, hasContent: !!pData.choices?.[0]?.message?.content, error: pData.error || null };
    } catch(e) { out.apiTest.perplexity = { error: e.message }; }
  }

  res.json(out);
});

// POST /api/geo/track/:brandProfileId — fire-and-forget citation check
// Responds immediately, processes in background to avoid Render timeout
// ═══════════════════════════════════════════════════════════════════════════
// GEO CHERRY-PICK ARCHITECTURE — New endpoints for topic selection + brief building
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/geo/opportunities/:brandProfileId — latest session's opportunities
app.get('/api/geo/opportunities/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    // Get most recent session_id for this brand
    const latestSession = await pool.query(
      `SELECT discovery_session_id FROM geo_opportunities
       WHERE brand_profile_id = $1 AND discovery_session_id IS NOT NULL
       ORDER BY discovered_at DESC LIMIT 1`,
      [brandProfileId]
    );
    if (!latestSession.rows.length) return res.json({ success: true, opportunities: [], sessionId: null });

    const sessionId = latestSession.rows[0].discovery_session_id;

    // Auto-expire: mark 'discovered' opportunities older than 24h as 'ignored'
    await pool.query(
      `UPDATE geo_opportunities SET status = 'ignored', status_changed_at = NOW()
       WHERE brand_profile_id = $1 AND status = 'discovered'
         AND discovered_at < NOW() - INTERVAL '24 hours'`,
      [brandProfileId]
    );

    const opps = await pool.query(
      `SELECT id, topic, platform_scores, avg_score, quick_win, topical_authority_context,
              status, discovered_at, status_changed_at
       FROM geo_opportunities
       WHERE brand_profile_id = $1 AND discovery_session_id = $2
       ORDER BY quick_win DESC, avg_score DESC`,
      [brandProfileId, sessionId]
    );
    res.json({
      success: true,
      sessionId,
      opportunities: opps.rows.map(r => ({
        id: r.id, topic: r.topic,
        platformScores: (() => {
          const ps = r.platform_scores || {};
          return {
            chatgpt: ps.chatgpt || ps['ChatGPT'] || 0,
            perplexity: ps.perplexity || ps['Perplexity'] || 0,
            aiOverviews: ps.aiOverviews || ps['google ai overviews'] || ps['Google AI Overviews'] || ps['aio'] || 0,
            gemini: ps.gemini || ps['Gemini'] || 0
          };
        })(), avgScore: parseFloat(r.avg_score),
        quickWin: r.quick_win,
        topicalAuthority: r.topical_authority_context ? JSON.parse(r.topical_authority_context) : null,
        status: r.status, discoveredAt: r.discovered_at, statusChangedAt: r.status_changed_at
      }))
    });
  } catch(e) {
    console.error('[GEO-OPP-LIST]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/geo/opportunities/build-briefs — Stage 2.1 Brief Builder
// Body: { opportunityIds: string[], brandProfileId: string }
app.post('/api/geo/opportunities/build-briefs', requireAuth, express.json(), async (req, res) => {
  const { opportunityIds, brandProfileId } = req.body;
  if (!Array.isArray(opportunityIds) || !opportunityIds.length) {
    return res.status(400).json({ success: false, error: 'opportunityIds required' });
  }
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });

  try {
    const profileRes = await pool.query(
      `SELECT id, brand_url, brand_name, version, profile_data, settings FROM brand_profiles WHERE id = $1`,
      [brandProfileId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ success: false, error: 'Brand not found' });
    const profile = profileRes.rows[0];
    const pd = profile.profile_data || {};
    const voiceProfile = pd.voice_profile || pd.voiceProfile || {};
    const personas = pd.personas || [];

    // Fetch brain context for the brief builder
    const patternsRes = await pool.query(
      `SELECT pattern_type, description FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [brandProfileId]
    );
    const brainContext = patternsRes.rows.length
      ? 'BRAIN PATTERNS (respect these):\n' + patternsRes.rows.map(p => `- [${p.pattern_type}] ${p.description}`).join('\n')
      : 'No brain patterns yet.';

    // Also pull Factual Ground for context
    const fg = (profile.settings || {}).factualGround || {};
    const factualContext = [
      fg.whatWeDo && `What we do: ${fg.whatWeDo}`,
      fg.whatWeDontDo && `What we don't do: ${fg.whatWeDontDo}`,
      fg.methodology && `Methodology: ${fg.methodology.slice(0, 400)}`
    ].filter(Boolean).join('\n\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build briefs CONCURRENTLY — was serial, which made a 9-brief batch take ~90s of
    // wall-clock and left it wide open to being killed mid-run by a Render redeploy
    // (which gives the old instance only ~30s SIGTERM grace before SIGKILL).
    // Now total wall-clock ≈ slowest single Anthropic call (~10-15s). Much smaller window.
    const results = await Promise.allSettled(opportunityIds.map(async (oppId) => {
      const oppRes = await pool.query(
        `SELECT * FROM geo_opportunities WHERE id = $1 AND brand_profile_id = $2`,
        [oppId, brandProfileId]
      );
      if (!oppRes.rows.length) return null;
      const opp = oppRes.rows[0];
      let authorityWriteup = null;
      try {
        authorityWriteup = opp.topical_authority_context ? JSON.parse(opp.topical_authority_context) : null;
      } catch {
        // Malformed TAC — treat as absent. Don't let one bad row kill the whole batch.
      }

      try {
        const briefRes = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 6144,
          messages: [{ role: 'user', content: `You are the Topic Brief Builder (Stage 2.1) for Forge Intelligence.

BRAND: ${profile.brand_name}
VOICE: ${JSON.stringify(voiceProfile).slice(0, 400)}
PERSONAS: ${JSON.stringify(personas).slice(0, 400)}

${factualContext ? 'FACTUAL GROUND (use verbatim):\n' + factualContext + '\n\n' : ''}${brainContext}

TOPIC THE USER SELECTED: "${opp.topic}"
PLATFORM SCORES: ${JSON.stringify(opp.platform_scores)}
QUICK WIN: ${opp.quick_win}
TOPICAL AUTHORITY CONTEXT: ${authorityWriteup ? JSON.stringify(authorityWriteup).slice(0, 600) : 'N/A'}

Build a GEO-optimized content brief for THIS SPECIFIC TOPIC. Return ONLY valid JSON:
{
  "h1": "string — compelling H1 with topic + differentiated angle",
  "executiveSummary": "string — 2-3 sentences on what this article accomplishes",
  "h2s": [{"heading":"string","intent":"string explaining why this section exists","geoAnchor":"string — key phrase for AI citation"}],
  "entities": ["string"],
  "faqStructure": [{"question":"string","answerDirection":"string"}],
  "geoAnchors": ["string"],
  "schemaRequirements": ["string"],
  "targetPlatforms": ["string"],
  "briefRationale": "string — why this angle, for this brand, now"
}

Generate 5-7 H2s that build a coherent argument. Align entities with schema requirements.`
          }]
        });

        let briefData;
        try {
          const raw = briefRes.content[0].text;
          const json = extractJSON(raw, 'object');
          briefData = JSON.parse(json);
        } catch(parseErr) {
          console.log('[STAGE-2.1] parse warn for', opp.topic, ':', parseErr.message);
          briefData = {
            h1: opp.topic, executiveSummary: 'Brief generation incomplete — retry needed.',
            h2s: [], entities: [], faqStructure: [], geoAnchors: [],
            schemaRequirements: [], targetPlatforms: [], briefRationale: 'parse-error'
          };
        }

        // Persist the brief
        const briefInsert = await pool.query(
          `INSERT INTO geo_topic_briefs (opportunity_id, brand_profile_id, brief_data, brain_version, status)
           VALUES ($1, $2, $3, $4, 'briefed') RETURNING id, created_at`,
          [oppId, brandProfileId, JSON.stringify(briefData), profile.version || 1]
        );

        // Flip opportunity to "briefed"
        await pool.query(
          `UPDATE geo_opportunities SET status = 'briefed', status_changed_at = NOW() WHERE id = $1`,
          [oppId]
        );

        return {
          briefId: briefInsert.rows[0].id,
          opportunityId: oppId,
          topic: opp.topic,
          briefData,
          createdAt: briefInsert.rows[0].created_at
        };
      } catch(briefErr) {
        console.error('[STAGE-2.1] brief build failed for', opp.topic, ':', briefErr.message);
        return null;
      }
    }));

    const builtBriefs = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    // Log activity
    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1, $2, $3, $4, $5)`,
      ['stage2_1_brief_builder', brandProfileId, 'success', builtBriefs.length * 3000, 0]
    ).catch(() => {});

    res.json({ success: true, briefs: builtBriefs, builtCount: builtBriefs.length });
  } catch(e) {
    console.error('[STAGE-2.1]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/geo/topic-briefs/:brandProfileId — briefed topics (includes backlog)
app.get('/api/geo/topic-briefs/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const statusFilter = req.query.status;  // optional: 'briefed' | 'backlog' | 'enriched'
    const sql = statusFilter
      ? `SELECT tb.*, opp.topic, opp.quick_win, opp.avg_score
         FROM geo_topic_briefs tb
         JOIN geo_opportunities opp ON opp.id = tb.opportunity_id
         WHERE tb.brand_profile_id = $1 AND tb.status = $2 AND tb.superseded_by IS NULL
         ORDER BY tb.created_at DESC`
      : `SELECT tb.*, opp.topic, opp.quick_win, opp.avg_score
         FROM geo_topic_briefs tb
         JOIN geo_opportunities opp ON opp.id = tb.opportunity_id
         WHERE tb.brand_profile_id = $1 AND tb.superseded_by IS NULL
         ORDER BY tb.created_at DESC`;
    const params = statusFilter ? [req.params.brandProfileId, statusFilter] : [req.params.brandProfileId];
    const r = await pool.query(sql, params);
    console.log(`[CG-BRIEFS] Returning ${r.rows.length} rows for brand ${req.params.brandProfileId || brandProfileId}`);
    res.json({
      success: true,
      briefs: r.rows.map(row => ({
        id: row.id, opportunityId: row.opportunity_id, topic: row.topic,
        briefData: row.brief_data, quickWin: row.quick_win,
        avgScore: parseFloat(row.avg_score), status: row.status,
        brainVersion: row.brain_version, createdAt: row.created_at
      }))
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/geo/topic-brief/:id/backlog
app.post('/api/geo/topic-brief/:id/backlog', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE geo_topic_briefs SET status = 'backlog', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/geo/topic-brief/:id/resurface
app.post('/api/geo/topic-brief/:id/resurface', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE geo_topic_briefs SET status = 'briefed', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/geo/opportunities/mark-ignored — sweep called when user leaves GEO page
// Marks any still-'discovered' opps in the session as 'ignored' (brain food)
app.post('/api/geo/opportunities/mark-ignored', requireAuth, express.json(), async (req, res) => {
  try {
    const { brandProfileId, sessionId } = req.body;
    if (!brandProfileId || !sessionId) return res.status(400).json({ success: false, error: 'params required' });
    const r = await pool.query(
      `UPDATE geo_opportunities SET status = 'ignored', status_changed_at = NOW()
       WHERE brand_profile_id = $1 AND discovery_session_id = $2 AND status = 'discovered'
       RETURNING id, topic, quick_win`,
      [brandProfileId, sessionId]
    );
    // Write brain signal — "user rejected these quick wins" is useful context
    for (const ignored of r.rows) {
      if (ignored.quick_win) {
        await pool.query(
          `INSERT INTO brain_patterns (id, brand_profile_id, pattern_type, description, confidence_score, created_at)
           VALUES (gen_random_uuid(), $1, 'user_rejection', $2, 0.3, NOW())
           ON CONFLICT DO NOTHING`,
          [brandProfileId, `User did not select Quick Win topic "${ignored.topic}" when surfaced. Consider deprioritizing this angle.`]
        ).catch(() => {});
      }
    }
    res.json({ success: true, ignoredCount: r.rowCount });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/content-generator/enriched-briefs/:brandProfileId
// Returns all enriched briefs for a brand, with topic context + cherry-pick session info.
// Content Generator uses this to show the user their full batch of enriched work,
// not just the "latest" one (which was picking blindly in the old architecture).
app.get('/api/content-generator/enriched-briefs/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    const safeId = brandProfileId.replace(/-/g, '_');
    console.log(`[CG-BRIEFS] Request for brand ${brandProfileId}`);
    // Complete picture: every enriched brief (with or without article) + every article whose
    // enriched brief has been deleted (legacy orphans from pre-cherry-pick DELETE-all behavior).
    const r = await pool.query(
      `(
        SELECT
           eb.id::text as id, eb.brand_profile_id, eb.brand_name, eb.version, eb.confidence_score,
           eb.created_at, eb.brain_version,
           eb.enriched_data->>'topicBriefId' as topic_brief_id,
           eb.enriched_data->>'enrichedTitle' as enriched_title,
           eb.enriched_data->>'enrichedH1' as enriched_h1,
           opp.topic as topic,
           opp.discovery_session_id as discovery_session_id,
           opp.quick_win as quick_win,
           gc.id as article_id,
           gc.title as article_title,
           gc.compliance_status as article_status,
           gc.status as article_publish_status,
           pq.status as queue_status,
           false as is_orphan
         FROM enriched_briefs eb
         LEFT JOIN geo_topic_briefs tb ON tb.id::text = eb.enriched_data->>'topicBriefId'
         LEFT JOIN geo_opportunities opp ON opp.id = tb.opportunity_id
         LEFT JOIN generated_content_${safeId} gc ON gc.enriched_brief_id::text = eb.id::text
         LEFT JOIN publishing_queue pq ON pq.content_id = gc.id::text
         WHERE eb.brand_profile_id = $1
      )
      UNION ALL
      (
        SELECT
           gc.enriched_brief_id as id,
           gc.brand_profile_id,
           NULL as brand_name,
           NULL as version,
           NULL as confidence_score,
           gc.created_at, NULL as brain_version,
           NULL as topic_brief_id,
           gc.title as enriched_title,
           gc.title as enriched_h1,
           gc.title as topic,
           NULL as discovery_session_id,
           false as quick_win,
           gc.id as article_id,
           gc.title as article_title,
           gc.compliance_status as article_status,
           gc.status as article_publish_status,
           pq.status as queue_status,
           true as is_orphan
         FROM generated_content_${safeId} gc
         LEFT JOIN publishing_queue pq ON pq.content_id = gc.id::text
         WHERE gc.brand_profile_id = $1
           AND gc.enriched_brief_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM enriched_briefs eb WHERE eb.id::text = gc.enriched_brief_id::text
           )
      )
      ORDER BY created_at DESC
      LIMIT 30`,
      [brandProfileId]
    );
    res.json({
      success: true,
      briefs: r.rows.map(row => ({
        id: row.id,
        brandProfileId: row.brand_profile_id,
        brandName: row.brand_name,
        version: row.version,
        confidenceScore: row.confidence_score,
        createdAt: row.created_at,
        brainVersion: row.brain_version,
        topicBriefId: row.topic_brief_id,
        topic: row.topic,
        enrichedTitle: row.enriched_title,
        enrichedH1: row.enriched_h1,
        discoverySessionId: row.discovery_session_id,
        quickWin: row.quick_win,
        // Article generation state for batch progress UI
        hasArticle: !!row.article_id,
        articleId: row.article_id,
        articleTitle: row.article_title,
        articleStatus: row.article_status,
        articlePublishStatus: row.article_publish_status,
        queueStatus: row.queue_status,  // 'published' means it's shipped to channels
        isOrphan: !!row.is_orphan  // article whose enriched brief has been deleted (legacy)
      }))
    });
  } catch(e) {
    console.error('[CG-BRIEFS]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});


app.post('/api/geo/track/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  // Allow cron/admin bypass with adminPassword, otherwise require Clerk JWT
  const isCron = req.body?.adminPassword === process.env.ADMIN_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'] });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  }
  if (!isCron && !(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  const { contentId } = req.body;

  // Respond immediately — client polls /api/geo/citations for results
  res.json({ success: true, status: 'running' });

  // Process in background
  (async () => {
    try {
      const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (!brandRes.rows.length) return;
      const brand = brandRes.rows[0];
      const brandDomain = (brand.brand_url || brand.article_base_url || '').replace(/https?:\/\//, '').replace(/\/.*/, '').replace(/^www\./, '');
      const brandName = brand.brand_name || brand.brand_url;

      const safeId = brandProfileId.replace(/-/g, '_');
      const artQuery = contentId
        ? `SELECT id, title, article_json FROM generated_content_${safeId} WHERE id = $1`
        : `SELECT id, title, article_json FROM generated_content_${safeId} ORDER BY created_at DESC LIMIT 5`;
      const artParams = contentId ? [contentId] : [];
      const articlesRes = await pool.query(artQuery, artParams).catch(() => ({ rows: [] }));

      const fetchWithTimeout = (url, opts, ms = 30000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
      };

      await Promise.allSettled(articlesRes.rows.map(async article => {
        const sections = article.article_json?.sections || [];
        const title = article.title || 'Untitled';
        // Extract meaningful topic keywords from title for natural GEO queries
        const topicWords = title.replace(/[^a-zA-Z0-9 ]/g, '').split(' ')
          .filter(w => w.length > 4 && !['about','using','your','with','that','this','from','have','will','what','when','where','which'].includes(w.toLowerCase()))
          .slice(0, 5).join(' ');
        const probeQuestions = [
          title,                                                    // exact article title — tests direct citation
          `${brandName} ${topicWords}`.trim(),                      // brand + topic — tests brand authority on this subject
          `What is ${brandName}?`,                                  // brand awareness query
        ].filter(Boolean).slice(0, 3);

        await Promise.allSettled(probeQuestions.map(async question => {

          // ── Perplexity Sonar ──────────────────────────────────────────────
          if (process.env.PERPLEXITY_API_KEY) {
            try {
              const pRes = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: question }], max_tokens: 400 })
              });
              const pData = await pRes.json();
              const pText = pData.choices?.[0]?.message?.content || '';
              const citations = pData.citations || [];
              const isCited = citations.some(u => u.includes(brandDomain)) || pText.toLowerCase().includes(brandDomain.toLowerCase());
              let citedSection = null;
              if (isCited) {
                for (const s of sections) {
                  const body = (s.body || s.content || '').toLowerCase();
                  if (pText.toLowerCase().split(' ').filter(w => w.length > 6 && body.includes(w)).length > 3) { citedSection = s.heading; break; }
                }
              }
              await pool.query(
                `INSERT INTO geo_citations (brand_profile_id, content_id, engine, query, is_cited, cited_url, cited_section, response_snippet, raw_citations, checked_at)
                 VALUES ($1,$2,'perplexity',$3,$4,$5,$6,$7,$8,NOW())
                 ON CONFLICT (brand_profile_id, content_id, engine, query)
                 DO UPDATE SET is_cited=$4, cited_url=$5, cited_section=$6, response_snippet=$7, raw_citations=$8, checked_at=NOW()`,
                [brandProfileId, article.id, question, isCited,
                 citations.find(u => u.includes(brandDomain)) || null,
                 citedSection, pText.slice(0, 300), JSON.stringify(citations)]
              ).catch(() => {});
            } catch(e) { console.error('[GEO-PERPLEXITY]', e.message); }
          }

          // ── OpenAI web search ─────────────────────────────────────────────
          if (process.env.OPENAI_API_KEY) {
            try {
              const oRes = await fetchWithTimeout('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: 'gpt-4o-mini',
                  tools: [{ type: 'web_search_preview' }],
                  input: question
                })
              });
              const oData = await oRes.json();
              // Responses API: find message item in output array, extract text + annotations
              const msgItem = oData.output?.find(o => o.type === 'message');
              const textContent = msgItem?.content?.find(c => c.type === 'output_text');
              const outputText = textContent?.text || oData.output_text || '';
              const annotations = textContent?.annotations || [];
              const urlCitations = annotations
                .filter(a => a.type === 'url_citation')
                .map(a => a.url || a.url_citation?.url || '');
              const isCited = urlCitations.some(u => u.includes(brandDomain)) || outputText.toLowerCase().includes(brandDomain.toLowerCase());
              let citedSection = null;
              if (isCited) {
                for (const s of sections) {
                  const body = (s.body || s.content || '').toLowerCase();
                  if (outputText.toLowerCase().split(' ').filter(w => w.length > 6 && body.includes(w)).length > 3) { citedSection = s.heading; break; }
                }
              }
              await pool.query(
                `INSERT INTO geo_citations (brand_profile_id, content_id, engine, query, is_cited, cited_url, cited_section, response_snippet, raw_citations, checked_at)
                 VALUES ($1,$2,'chatgpt',$3,$4,$5,$6,$7,$8,NOW())
                 ON CONFLICT (brand_profile_id, content_id, engine, query)
                 DO UPDATE SET is_cited=$4, cited_url=$5, cited_section=$6, response_snippet=$7, raw_citations=$8, checked_at=NOW()`,
                [brandProfileId, article.id, question, isCited,
                 urlCitations.find(u => u.includes(brandDomain)) || null,
                 citedSection, outputText.slice(0, 300), JSON.stringify(urlCitations)]
              ).catch(e => console.error('[GEO-DB]', e.message));
            } catch(e) { console.error('[GEO-OPENAI]', e.message); }
          }
        }));
      }));

      console.log(`[GEO-TRACK] Complete for ${brandProfileId} — ${articlesRes.rows.length} articles checked`);
    } catch(e) {
      console.error('[GEO-TRACK] Background error:', e.message);
    }
  })();
});

// GET /api/geo/citations/:brandProfileId — get all citation results
app.get('/api/geo/citations/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const safeId = brandProfileId.replace(/-/g, '_');

    const r = await pool.query(
      `SELECT gc.*, pq.title as queue_title
       FROM geo_citations gc
       LEFT JOIN publishing_queue pq ON pq.content_id = gc.content_id
       WHERE gc.brand_profile_id = $1
       ORDER BY gc.checked_at DESC`,
      [brandProfileId]
    );

    // Build a title map from generated_content table (covers articles not yet in queue)
    const contentIds = [...new Set(r.rows.map(row => row.content_id))];
    const titleMap = {};
    if (contentIds.length) {
      const placeholders = contentIds.map((_, i) => `$${i + 1}`).join(',');
      const titleRes = await pool.query(
        `SELECT id, title FROM generated_content_${safeId} WHERE id IN (${placeholders})`,
        contentIds
      ).catch(() => ({ rows: [] }));
      for (const row of titleRes.rows) titleMap[row.id] = row.title;
    }

    // Aggregate by content_id only — one row per article across all engines
    const summary = {};
    for (const row of r.rows) {
      const key = row.content_id;
      const title = row.queue_title || titleMap[row.content_id] || 'Untitled';
      if (!summary[key]) {
        summary[key] = {
          content_id: row.content_id,
          title,
          engines: [],
          totalChecks: 0,
          citations: 0,
          citedSections: [],
          lastChecked: row.checked_at,
          citedUrls: []
        };
      }
      summary[key].totalChecks++;
      if (!summary[key].engines.includes(row.engine)) summary[key].engines.push(row.engine);
      if (row.is_cited) {
        summary[key].citations++;
        if (row.cited_section && !summary[key].citedSections.includes(row.cited_section))
          summary[key].citedSections.push(row.cited_section);
        if (row.cited_url && !summary[key].citedUrls.includes(row.cited_url))
          summary[key].citedUrls.push(row.cited_url);
      }
    }

    res.json({ success: true, citations: Object.values(summary), raw: r.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Decay Monitoring Agent ───────────────────────────────────────────────────
async function runDecayMonitoring() {
  try {
    // Get all brands
    const brandsRes = await pool.query('SELECT id FROM brand_profiles WHERE is_active = true');
    for (const brand of brandsRes.rows) {
      const brandProfileId = brand.id;
      try {
        // Get all articles with analytics, published 14+ days ago, with at least 1 impression
        const articlesRes = await pool.query(
          `SELECT ca.content_id, ca.channel, ca.impressions, ca.clicks, ca.reactions,
                  ca.synced_at, ca.published_at, pq.title
           FROM content_analytics ca
           LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
           WHERE ca.brand_profile_id = $1
             AND ca.published_at < NOW() - INTERVAL '14 days'
             AND (ca.impressions > 0 OR ca.clicks > 0)
           ORDER BY ca.content_id, ca.channel`,
          [brandProfileId]
        ).catch(() => ({ rows: [] }));

        for (const row of articlesRes.rows) {
          // Get historical peak for this article/channel
          const peakRes = await pool.query(
            `SELECT MAX(impressions) as peak_imp, MAX(clicks) as peak_clicks
             FROM content_analytics
             WHERE content_id = $1 AND channel = $2`,
            [row.content_id, row.channel]
          ).catch(() => ({ rows: [{}] }));

          const peakImpressions = parseInt(peakRes.rows[0]?.peak_imp || 0);
          const peakClicks = parseInt(peakRes.rows[0]?.peak_clicks || 0);
          const currentImpressions = row.impressions || 0;
          const currentClicks = row.clicks || 0;

          // Calculate decay score (0 = no decay, 1 = full decay)
          const impDecay = peakImpressions > 0 ? 1 - (currentImpressions / peakImpressions) : 0;
          const clickDecay = peakClicks > 0 ? 1 - (currentClicks / peakClicks) : 0;
          const decayScore = Math.max(impDecay, clickDecay);

          // Flag if decay > 50% and article is older than 14 days
          if (decayScore >= 0.5) {
            // Generate recommended action via Haiku
            let recommendedAction = 'Refresh and republish — engagement has dropped significantly.';
            try {
              const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 120,
                  messages: [{ role: 'user', content: `Article "${row.title || 'Untitled'}" on ${row.channel} has decayed ${Math.round(decayScore * 100)}% from peak engagement. In one sentence, recommend the best action: refresh content, change headline, republish on different channel, or add internal links. Be specific and actionable.` }]
                })
              });
              const aiData = await aiRes.json();
              if (aiData.content?.[0]?.text) recommendedAction = aiData.content[0].text.trim();
            } catch(e) { /* use default */ }

            // Upsert decay alert
            await pool.query(
              `INSERT INTO decay_alerts
                (brand_profile_id, content_id, channel, title, peak_impressions, peak_clicks,
                 current_impressions, current_clicks, decay_score, status, recommended_action, detected_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,NOW())
               ON CONFLICT (content_id, channel) DO UPDATE SET
                 current_impressions=$7, current_clicks=$8, decay_score=$9,
                 recommended_action=$10, detected_at=NOW(), status='active'`,
              [brandProfileId, row.content_id, row.channel, row.title || 'Untitled',
               peakImpressions, peakClicks, currentImpressions, currentClicks,
               decayScore, recommendedAction]
            ).catch(() => {});

            // Write to brain_mistakes so pattern extractor learns
            await pool.query(
              `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, severity)
               VALUES ($1, 'content_decay', $2, $3)
               ON CONFLICT DO NOTHING`,
              [brandProfileId,
               `"${row.title || 'Untitled'}" decayed ${Math.round(decayScore * 100)}% on ${row.channel} after 14 days`,
               decayScore >= 0.8 ? 'high' : 'medium']
            ).catch(() => {});
          } else {
            // Mark as resolved if previously flagged
            await pool.query(
              `UPDATE decay_alerts SET status='resolved', resolved_at=NOW()
               WHERE content_id=$1 AND channel=$2 AND status='active'`,
              [row.content_id, row.channel]
            ).catch(() => {});
          }
        }
        console.log(`[DECAY] Checked ${articlesRes.rows.length} articles for ${brandProfileId}`);
      } catch(e) { console.error('[DECAY] Brand error:', e.message); }
    }
  } catch(e) { console.error('[DECAY] Run error:', e.message); }
}

// GET /api/analytics/decay/:brandProfileId
app.get('/api/analytics/decay/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM decay_alerts WHERE brand_profile_id = $1 AND status = 'active'
       ORDER BY decay_score DESC`,
      [req.params.brandProfileId]
    );
    res.json({ success: true, alerts: r.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/analytics/decay/:brandProfileId/resolve/:contentId
app.post('/api/analytics/decay/:brandProfileId/resolve/:contentId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE decay_alerts SET status='resolved', resolved_at=NOW()
       WHERE brand_profile_id=$1 AND content_id=$2`,
      [req.params.brandProfileId, req.params.contentId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Start scheduler — runs 30s after boot then every 60s
setTimeout(() => {
  runScheduledPublishes();
  setInterval(runScheduledPublishes, 60 * 1000);
  // Decay monitoring runs every 6 hours
  runDecayMonitoring();
  setInterval(runDecayMonitoring, 6 * 60 * 60 * 1000);
}, 30 * 1000);

console.log('[SCHEDULER] Scheduled publish runner active — polling every 60s');
console.log('[SCHEDULER] Decay monitoring active — running every 6 hours');

// ── Performance Digest ─────────────────────────────────────────────────────
// Scheduled: POST /api/digest/send-all (EasyCron, admin key)
// Or per-brand:               POST /api/digest/send/:brandProfileId (requireAuth)

const sendDigestForBrand = async (brandProfileId) => {
  const safeId = brandProfileId.replace(/-/g, '_');

  // Load brand + check opt-out
  const brandRes = await pool.query(
    `SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]
  );
  if (!brandRes.rows.length) return { skipped: 'brand_not_found' };
  const brand = brandRes.rows[0];
  if (brand.digest_unsubscribed) return { skipped: 'unsubscribed' };
  if (!brand.is_paid) return { skipped: 'not_paid' };
  if (!brand.clerk_user_id) return { skipped: 'no_clerk_user' };

  // Get user email from Clerk
  const clerkRes = await fetch(`https://api.clerk.com/v1/users/${brand.clerk_user_id}`, {
    headers: { 'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}` }
  });
  if (!clerkRes.ok) return { skipped: 'clerk_fetch_failed' };
  const clerkUser = await clerkRes.json();
  const email = clerkUser.email_addresses?.[0]?.email_address;
  if (!email) return { skipped: 'no_email' };

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return { skipped: 'resend_not_configured' };

  const brandName = brand.brand_name || brand.brand_url || 'Your Brand';
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // ── Gather digest data ──────────────────────────────────────────────────────

  // 1. Brain activity this week
  const patternsAdded = await pool.query(
    `SELECT COUNT(*) FROM brain_patterns WHERE brand_profile_id = $1 AND created_at > $2`,
    [brandProfileId, oneWeekAgo]
  ).catch(() => ({ rows: [{ count: 0 }] }));
  const mistakesLogged = await pool.query(
    `SELECT COUNT(*) FROM brain_mistakes WHERE brand_profile_id = $1 AND created_at > $2`,
    [brandProfileId, oneWeekAgo]
  ).catch(() => ({ rows: [{ count: 0 }] }));
  const newPatterns = parseInt(patternsAdded.rows[0].count) || 0;
  const newMistakes = parseInt(mistakesLogged.rows[0].count) || 0;

  // 2. Top performer this week
  const topPerformer = await pool.query(
    `SELECT ca.content_id, pq.title, ca.impressions, ca.clicks, ca.engagement_rate, ca.channel
     FROM content_analytics ca
     LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
     WHERE ca.brand_profile_id = $1 AND ca.synced_at > $2 AND ca.impressions > 0
     ORDER BY ca.impressions DESC LIMIT 1`,
    [brandProfileId, oneWeekAgo]
  ).catch(() => ({ rows: [] }));
  const top = topPerformer.rows[0] || null;

  // 3. Decay alerts this week
  const decayAlerts = await pool.query(
    `SELECT COUNT(*) FROM decay_alerts WHERE brand_profile_id = $1 AND status = 'active' AND detected_at > $2`,
    [brandProfileId, oneWeekAgo]
  ).catch(() => ({ rows: [{ count: 0 }] }));
  const decayCount = parseInt(decayAlerts.rows[0].count) || 0;

  // 4. Pipeline CTA — what should they do next?
  const stagedCount = await pool.query(
    `SELECT COUNT(*) FROM publishing_queue WHERE brand_profile_id = $1 AND status = 'staged'`,
    [brandProfileId]
  ).catch(() => ({ rows: [{ count: 0 }] }));
  const staged = parseInt(stagedCount.rows[0].count) || 0;

  // Total articles ever generated — useful for new users
  const totalContent = await pool.query(
    `SELECT COUNT(*) FROM generated_content_${safeId}`
  ).catch(() => ({ rows: [{ count: 0 }] }));
  const totalArticles = parseInt(totalContent.rows[0].count) || 0;

  // Brand age — always send in first 30 days regardless of activity
  const brandAge = (Date.now() - new Date(brand.created_at).getTime()) / (1000 * 60 * 60 * 24);
  const isNewBrand = brandAge <= 30;

  // Skip only if truly nothing to say AND not a new brand
  const hasActivity = newPatterns > 0 || newMistakes > 0 || top || decayCount > 0 || staged > 0 || totalArticles > 0;
  if (!hasActivity && !isNewBrand) {
    return { skipped: 'nothing_to_report' };
  }

  // Ensure unsubscribe token exists
  if (!brand.digest_unsubscribe_token) {
    const token = randomBytes(24).toString('hex');
    await pool.query(`UPDATE brand_profiles SET digest_unsubscribe_token = $1 WHERE id = $2`, [token, brandProfileId]);
    brand.digest_unsubscribe_token = token;
  }

  const baseDomain = process.env.BASE_DOMAIN ? `https://${process.env.BASE_DOMAIN}` : 'https://forgeintelligence.ai';
  const unsubUrl = `${baseDomain}/api/digest/unsubscribe/${brand.digest_unsubscribe_token}`;
  const appUrl = `${baseDomain}/app`;

  // ── Build email HTML ────────────────────────────────────────────────────────
  const fmt = (n) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n);

  const brainSection = (newPatterns > 0 || newMistakes > 0) ? `
    <div style="background:#1E293B;border-radius:10px;padding:20px 24px;margin-bottom:20px;border-left:3px solid #3563FF;">
      <p style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;margin:0 0 12px;">Brain Activity This Week</p>
      <table cellpadding="0" cellspacing="0" border="0"><tr>
        ${newPatterns > 0 ? `<td style="padding-right:32px;vertical-align:top;"><span style="font-size:28px;font-weight:700;color:#3563FF;letter-spacing:-0.02em;display:block;">${newPatterns}</span><span style="font-size:12px;color:#94A3B8;display:block;margin-top:2px;">new pattern${newPatterns !== 1 ? 's' : ''} learned</span></td>` : ''}
        ${newMistakes > 0 ? `<td style="vertical-align:top;"><span style="font-size:28px;font-weight:700;color:#F59E0B;letter-spacing:-0.02em;display:block;">${newMistakes}</span><span style="font-size:12px;color:#94A3B8;display:block;margin-top:2px;">mistake${newMistakes !== 1 ? 's' : ''} logged</span></td>` : ''}
      </tr></table>
    </div>` : '';

  const topSection = top ? `
    <div style="background:#1E293B;border-radius:10px;padding:20px 24px;margin-bottom:20px;border-left:3px solid #22C55E;">
      <p style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;margin:0 0 12px;">Top Performer</p>
      <p style="font-size:14px;font-weight:600;color:#F8FAFC;margin:0 0 8px;">${top.title || 'Untitled'}</p>
      <p style="font-size:12px;color:#94A3B8;margin:6px 0 0;line-height:1.6;">
        ${[top.impressions ? `${fmt(top.impressions)} impressions` : '', top.clicks ? `${fmt(top.clicks)} clicks` : '', top.engagement_rate ? `${parseFloat(top.engagement_rate).toFixed(1)}% engagement` : ''].filter(Boolean).join(' &nbsp;&middot;&nbsp; ')}
      </p>
    </div>` : '';

  const decaySection = decayCount > 0 ? `
    <div style="background:#1E293B;border-radius:10px;padding:20px 24px;margin-bottom:20px;border-left:3px solid #EF4444;">
      <p style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;margin:0 0 8px;">Decay Alerts</p>
      <p style="font-size:14px;color:#F8FAFC;margin:0;">${decayCount} article${decayCount !== 1 ? 's' : ''} dropped 50%+ in engagement — <a href="${appUrl}/performance" style="color:#3563FF;text-decoration:none;">review in Performance →</a></p>
    </div>` : '';

  let ctaText, ctaHref, ctaLabel;
  if (staged > 0) {
    ctaText = `You have ${staged} article${staged !== 1 ? 's' : ''} staged and ready for review.`;
    ctaHref = `${appUrl}/compliance-gate`;
    ctaLabel = `Review in Compliance Gate →`;
  } else if (totalArticles === 0) {
    ctaText = `Your Brain is ready. Run your first content generation to see it in action.`;
    ctaHref = `${appUrl}/content-generator`;
    ctaLabel = `Generate your first article →`;
  } else if (!top) {
    ctaText = `Sync your analytics after publishing to keep your Brain learning.`;
    ctaHref = `${appUrl}/performance`;
    ctaLabel = `Open Performance Dashboard →`;
  } else {
    ctaText = `Keep the loop going — publish, sync, and let your Brain compound.`;
    ctaHref = `${appUrl}/performance`;
    ctaLabel = `Open Performance Dashboard →`;
  }

  const html = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:40px 24px;background:#0F172A;color:#F8FAFC;border-radius:12px;">
      <div style="margin-bottom:28px;">
        <img src="https://forgeintelligence.ai/forge-logo-white.png" alt="Forge Intelligence" style="height:28px;width:auto;" />
      </div>
      <h1 style="font-size:22px;font-weight:700;margin:0 0 6px;color:#F8FAFC;letter-spacing:-0.02em;">Your Brain — Weekly Report</h1>
      <p style="color:#64748B;font-size:13px;margin:0 0 28px;">${brandName} · Week ending ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>

      ${brainSection}
      ${topSection}
      ${decaySection}

      <div style="background:#1E293B;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
        <p style="font-size:13px;color:#94A3B8;margin:0 0 14px;">${ctaText}</p>
        <a href="${ctaHref}" style="display:inline-block;background:#3563FF;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">${ctaLabel}</a>
      </div>

      <p style="color:#334155;font-size:11px;margin:0;line-height:1.6;">
        You're receiving this because you have an active Forge Intelligence subscription. &nbsp;
        <a href="${unsubUrl}" style="color:#475569;text-decoration:underline;">Unsubscribe from weekly digest</a>
      </p>
    </div>
  `;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Forge Intelligence <hello@forgeintelligence.ai>',
      to: email,
      subject: `Your Forge Brain — Weekly Intelligence Report`,
      html
    })
  });
  const emailData = await emailRes.json();
  if (!emailRes.ok) throw new Error(`Resend error: ${JSON.stringify(emailData)}`);

  console.log(`[DIGEST] Sent to ${email} for brand ${brandProfileId}`);
  return { sent: true, email };
}

app.post('/api/digest/send/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const result = await sendDigestForBrand(req.params.brandProfileId);
    res.json({ success: true, result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});




// POST /api/digest/send-all — EasyCron weekly trigger (admin password protected)
app.post('/api/digest/send-all', async (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const brands = await pool.query(
      `SELECT id FROM brand_profiles WHERE is_paid = true AND is_active = true AND (digest_unsubscribed IS NULL OR digest_unsubscribed = false)`
    );
    const results = [];
    for (const brand of brands.rows) {
      try {
        const result = await sendDigestForBrand(brand.id);
        results.push({ id: brand.id, ...result });
      } catch(e) {
        results.push({ id: brand.id, error: e.message });
      }
      // Rate limit — Resend free tier is 2 req/sec
      await new Promise(r => setTimeout(r, 600));
    }
    const sent = results.filter(r => r.sent).length;
    const skipped = results.filter(r => r.skipped).length;
    console.log(`[DIGEST] Batch complete — ${sent} sent, ${skipped} skipped`);
    res.json({ success: true, sent, skipped, results });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/digest/unsubscribe/:token — one-click unsubscribe (no auth)
app.get('/api/digest/unsubscribe/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE brand_profiles SET digest_unsubscribed = true WHERE digest_unsubscribe_token = $1 RETURNING brand_name, brand_url`,
      [req.params.token]
    );
    if (!result.rows.length) {
      return res.status(404).send('<p style="font-family:sans-serif;padding:40px;">Link not found or already unsubscribed.</p>');
    }
    const brand = result.rows[0];
    res.send(`
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:80px auto;padding:40px;background:#0F172A;color:#F8FAFC;border-radius:12px;text-align:center;">
        <span style="font-size:15px;font-weight:800;color:#3563FF;">⬡ Forge Intelligence</span>
        <h2 style="margin:24px 0 12px;font-size:20px;">Unsubscribed</h2>
        <p style="color:#94A3B8;font-size:14px;line-height:1.7;margin:0 0 24px;">
          ${brand.brand_name || brand.brand_url} will no longer receive weekly digest emails.<br/>
          You can re-enable this anytime in Brand Settings.
        </p>
        <a href="https://forgeintelligence.ai/app/brand-settings" style="display:inline-block;background:#1E293B;color:#94A3B8;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;">Back to Brand Settings</a>
      </div>
    `);
  } catch(e) {
    res.status(500).send('<p style="font-family:sans-serif;padding:40px;">Something went wrong. Please try again.</p>');
  }
});

app.post('/api/utils/shorten-url', async (req, res) => {
  const { url, tags } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const BITLY_TOKEN = process.env.BITLY_ACCESS_TOKEN;
  if (!BITLY_TOKEN) return res.status(500).json({ error: 'Bitly not configured' });
  try {
    const payload = { long_url: url };
    if (tags && Array.isArray(tags) && tags.length > 0) payload.tags = tags.map(t => String(t).slice(0, 50));
    const r = await fetch('https://api-ssl.bitly.com/v4/shorten', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BITLY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || 'Bitly error');
    res.json({ shortUrl: d.link });
  } catch(e) {
    // Non-fatal — return original URL if Bitly fails
    res.json({ shortUrl: url, fallback: true });
  }
});



// ── Outreach ───────────────────────────────────────────────────────────────────

// POST /api/outreach/contacts — bulk insert contacts (admin only)
app.post('/api/outreach/contacts', async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array required' });
  try {
    let inserted = 0;
    for (const c of contacts) {
      await pool.query(
        `INSERT INTO outreach_contacts (first_name, last_name, email, company, title, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (email) DO NOTHING`,
        [c.first_name, c.last_name || null, c.email, c.company || null, c.title || null, c.notes || null]
      );
      inserted++;
    }
    res.json({ success: true, inserted });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/outreach/contacts — list contacts (admin only)
app.get('/api/outreach/contacts', async (req, res) => {
  if (req.query?.adminPassword !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT * FROM outreach_contacts ORDER BY created_at DESC');
    res.json({ success: true, contacts: r.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/outreach/send — cron-triggered send to all pending contacts
app.post('/api/outreach/send', async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  try {
    const pending = await pool.query(
      `SELECT * FROM outreach_contacts WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
    );
    if (!pending.rows.length) return res.json({ success: true, sent: 0, message: 'No pending contacts' });
    // Respond immediately so EasyCron doesn't time out — sends happen in background
    res.json({ success: true, queued: pending.rows.length, message: `Sending to ${pending.rows.length} contacts` });
    const sent = []; const errors = [];
    for (const contact of pending.rows) {
      try {
        const firstName = contact.first_name;
        const unsubUrl = `https://forgeintelligence.ai/unsubscribe?email=${encodeURIComponent(contact.email)}`;
        const html = `<div style="font-family:Inter,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:0;background:#ffffff;color:#1E293B">
  <div style="padding:40px 0 8px;display:flex;align-items:center;gap:10px"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3563FF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/></svg><span style="font-size:16px;font-weight:600;color:#1E293B;letter-spacing:-0.01em">Forge Intelligence</span></div>
  <div style="padding:32px 0;border-top:1px solid #E2E8F0;margin-top:24px">
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7">Hi ${firstName},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7">Most B2B marketing teams are operating on fragmented intelligence — competitive context in one tool, audience signals in another, content strategy in a third. None of it talks to each other, so nothing compounds.</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7">Forge Intelligence is the unified workspace that fixes that. Brand context, audience signals, content generation, compliance review, and performance analytics — one platform, one Brain that gets smarter with every publish cycle.</p>
    <p style="margin:0 0 32px;font-size:15px;line-height:1.7">Drop your URL and get a free brand intelligence profile in about 60 seconds. No pitch call required.</p>
    <a href="https://forgeintelligence.ai/?utm_source=outreach&utm_medium=email&utm_campaign=cold-outreach&utm_content=${encodeURIComponent(contact.email)}" style="display:inline-block;background:#3563FF;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:14px;font-weight:600">Scan your brand free →</a>
  </div>
  <div style="padding:24px 0;border-top:1px solid #E2E8F0">
    <p style="margin:0 0 4px;font-size:14px;color:#1E293B;font-weight:600">Brian</p>
    <p style="margin:0 0 2px;font-size:13px;color:#475569">Founder, Forge Intelligence</p>
    <a href="https://forgeintelligence.ai" style="font-size:13px;color:#3563FF;text-decoration:none">forgeintelligence.ai</a>
  </div>
  <div style="padding:16px 0;border-top:1px solid #E2E8F0">
    <p style="margin:0;font-size:11px;color:#94A3B8">You're receiving this because you were identified as someone who might find Forge Intelligence relevant. <a href="${unsubUrl}" style="color:#94A3B8">Unsubscribe</a></p>
  </div>
</div>`;
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Brian at Forge Intelligence <brian@forgeintelligence.ai>',
            to: [contact.email],
            reply_to: 'brian@forgeintelligence.ai',
            subject: 'Your brand intelligence is scattered across 8 tools',
            html
          })
        });
        const emailData = await emailRes.json();
        if (!emailRes.ok) throw new Error(emailData.message || JSON.stringify(emailData));
        await pool.query(`UPDATE outreach_contacts SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [contact.id]);
        await pool.query(`INSERT INTO outreach_log (contact_id, email, subject, resend_id, status, sent_at) VALUES ($1,$2,$3,$4,'sent',NOW())`,
          [contact.id, contact.email, 'Your brand intelligence is scattered across 8 tools', emailData.id || null]);
        sent.push(contact.email);
        console.log(`[OUTREACH] Sent to ${contact.email}`);
        await new Promise(r => setTimeout(r, 100));
      } catch(e) {
        console.error(`[OUTREACH] Failed for ${contact.email}:`, e.message);
        await pool.query(`INSERT INTO outreach_log (contact_id, email, subject, status, error_message, sent_at) VALUES ($1,$2,$3,'error',$4,NOW())`,
          [contact.id, contact.email, 'Your brand intelligence is scattered across 8 tools', e.message]);
        errors.push({ email: contact.email, error: e.message });
      }
    }
    console.log(`[OUTREACH] Done — ${sent.length} sent, ${errors.length} errors`);
  } catch(e) { console.error('[OUTREACH]', e.message); }
});

// GET /unsubscribe — one-click unsubscribe
app.get('/unsubscribe', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).send('Missing email');
  try {
    await pool.query(`UPDATE outreach_contacts SET status='unsubscribed', unsubscribed_at=NOW(), updated_at=NOW() WHERE email=$1`, [email]);
    res.send('<html><body style="font-family:Inter,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1E293B"><p style="font-size:18px;font-weight:600">You\'ve been unsubscribed.</p><p style="color:#475569">You won\'t receive any further emails from Forge Intelligence.</p><a href="https://forgeintelligence.ai" style="color:#3563FF">\u2190 forgeintelligence.ai</a></body></html>');
  } catch(e) { res.status(500).send('Error processing unsubscribe'); }
});

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});


