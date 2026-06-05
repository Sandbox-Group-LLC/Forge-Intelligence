import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from 'crypto';
import { jwtVerify } from 'jose';
import puppeteer from 'puppeteer-core';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { pool } from './src/server/db.js';
import { extractJSON, safeParseLLM } from './src/server/llm-json.js';
import { resolveUtmParams, buildUtmString } from './src/server/utm.js';
import { truncateStr, truncateAtSentence, stripSocialMarkdown } from './src/server/text.js';
import { clerkJWKS, SUPER_ADMIN_IDS, verifyBrandAccess, requireAuth, requireApiKeyScope, softAuth, mcpAuth, hashApiKey, lookupApiKey } from './src/server/auth.js';
import { callZernio, zernioPublish, getOrCreateZernioProfile, zernioGuard } from './src/server/zernio.js';

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


const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 1200000 }); // 20min

async function initDB() {
  // ── Idempotency check: skip the destructive id-column migration if it's already done ──
  // The legacy migration converts brand_profiles.id and geo_briefs.brand_profile_id from
  // UUID to TEXT. Once that's done, repeating the DROP/ALTER/RECREATE sequence on every
  // restart is wasteful (the DROP phase silently destroys the FK, and if any orphan rows
  // exist in geo_briefs the re-CREATE at the end fails — leaving the table FK-less for
  // the lifetime of the process). Check state first; only run the legacy path if needed.
  try {
    const stateCheck = await pool.query(`
      SELECT
        (SELECT data_type FROM information_schema.columns
          WHERE table_name = 'brand_profiles' AND column_name = 'id') AS bp_id_type,
        (SELECT data_type FROM information_schema.columns
          WHERE table_name = 'geo_briefs' AND column_name = 'brand_profile_id') AS gb_fk_type,
        EXISTS(SELECT 1 FROM pg_constraint
          WHERE conname = 'geo_briefs_brand_profile_id_fkey'
            AND conrelid = 'geo_briefs'::regclass) AS fk_exists
    `);
    const s = stateCheck.rows[0] || {};
    if (s.bp_id_type === 'text' && s.gb_fk_type === 'text' && s.fk_exists) {
      // All-good path — the migration ran successfully on a previous boot. No-op.
    } else {
      // Need to run (or re-run) the legacy migration. Before recreating the FK, surface any
      // orphan geo_briefs rows clearly — the previous catch block lumped FK violations under
      // the message "id already TEXT or table not yet created" which is actively misleading.
      try {
        await pool.query(`ALTER TABLE geo_briefs DROP CONSTRAINT IF EXISTS geo_briefs_brand_profile_id_fkey`);
        await pool.query(`ALTER TABLE brand_profiles DROP CONSTRAINT IF EXISTS brand_profiles_pkey`);
        await pool.query(`ALTER TABLE brand_profiles ALTER COLUMN id TYPE TEXT USING id::text`);
        await pool.query(`ALTER TABLE geo_briefs ALTER COLUMN brand_profile_id TYPE TEXT USING brand_profile_id::text`);
        await pool.query(`ALTER TABLE brand_profiles ADD PRIMARY KEY (id)`);

        // Detect orphans before adding FK (which would fail if any exist)
        const orphans = await pool.query(`
          SELECT gb.brand_profile_id, COUNT(*) AS row_count
          FROM geo_briefs gb
          LEFT JOIN brand_profiles bp ON bp.id = gb.brand_profile_id
          WHERE bp.id IS NULL
          GROUP BY gb.brand_profile_id
        `);
        if (orphans.rows.length > 0) {
          console.warn(`NeonDB: WARNING — ${orphans.rows.length} orphan brand_profile_id(s) in geo_briefs blocking FK recreation. Cleaning before adding FK.`);
          for (const row of orphans.rows) {
            console.warn(`  orphan: brand_profile_id=${row.brand_profile_id} (${row.row_count} rows)`);
          }
          await pool.query(`
            DELETE FROM geo_briefs
            WHERE brand_profile_id IN (
              SELECT gb.brand_profile_id FROM geo_briefs gb
              LEFT JOIN brand_profiles bp ON bp.id = gb.brand_profile_id
              WHERE bp.id IS NULL
            )
          `);
        }

        await pool.query(`ALTER TABLE geo_briefs ADD CONSTRAINT geo_briefs_brand_profile_id_fkey FOREIGN KEY (brand_profile_id) REFERENCES brand_profiles(id) ON DELETE CASCADE`);
        console.log('NeonDB: id + geo_briefs.brand_profile_id migrated to TEXT, FK with ON DELETE CASCADE recreated');
      } catch(e) {
        console.error('NeonDB: legacy id-column migration failed:', e.message);
      }
    }
  } catch(e) {
    // State-check itself failed — likely tables don't exist yet (first-time install)
    console.log('NeonDB: id-column migration deferred (tables not yet created):', e.message);
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

    // api_keys — narrow-scoped authentication tokens for machine-to-machine integrations
    // (e.g., Frank/ForgeOS reporting edits back via /api/content/import). Keys are SHA-256
    // hashed at rest, never stored in plaintext. Each key is scoped to specific brand IDs
    // and endpoint scopes so a leaked key can't be used against unauthorized brands or endpoints.
    await pool.query(`CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key_hash TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      brand_profile_ids UUID[] NOT NULL DEFAULT '{}',
      scopes TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      last_used_ip TEXT,
      revoked_at TIMESTAMPTZ
    )`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL`).catch(() => {});

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

    // ── scrape_log — observability for every URL Forge fetches ──────────────
    // Every call to forgeScrape() writes one row here. Lets us answer "did
    // sandbox-gtm.com fail because Bright Data was down, or because the URL
    // 404'd?" without bisecting through code. Read endpoint at
    // /api/admin/scrape-log.
    await pool.query(`CREATE TABLE IF NOT EXISTS scrape_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      status_code INTEGER,
      body_size INTEGER,
      latency_ms INTEGER,
      success BOOLEAN NOT NULL,
      caller TEXT,
      error TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_scrape_log_created ON scrape_log(created_at DESC)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_scrape_log_caller ON scrape_log(caller, created_at DESC)`).catch(() => {});
    console.log('NeonDB: scrape_log table ensured');

    // Campaign analytics migrations
    await pool.query(`ALTER TABLE content_analytics ADD COLUMN IF NOT EXISTS campaign_id UUID`).catch(() => {});
    await pool.query(`ALTER TABLE publishing_queue ADD COLUMN IF NOT EXISTS campaign_id UUID`).catch(() => {});

    // ── User Alerts & Support Tickets (topbar bell + Get Help form) ──
    await pool.query(`CREATE TABLE IF NOT EXISTS user_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id TEXT NOT NULL,
      brand_profile_id TEXT,
      severity TEXT NOT NULL DEFAULT 'error',
      area TEXT,
      short_message TEXT NOT NULL,
      raw_message TEXT,
      http_status INT,
      url TEXT,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_alerts_user_created
      ON user_alerts (clerk_user_id, created_at DESC)`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS support_tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id TEXT NOT NULL,
      brand_profile_id TEXT,
      user_email TEXT,
      category TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      attached_alert_ids JSONB DEFAULT '[]',
      user_agent TEXT,
      page_url TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
      ON support_tickets (status, created_at DESC)`).catch(() => {});
    console.log('NeonDB: user_alerts + support_tickets tables ensured');
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
      keyTakeaway: articleJson.keyTakeaway || null,
      faqs: Array.isArray(articleJson.faqs) ? articleJson.faqs : [],
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
    const queueRes = await pool.query('SELECT * FROM publishing_queue WHERE id = $1', [queueItemId]);
    if (!queueRes.rows.length) return res.status(404).json({ error: 'Queue item not found' });

    // Mark any previous log entry for this channel as 'republishing'. We
    // ALSO have to roll this back if the inner publish call fails — otherwise
    // the row stays in 'republishing' forever and the UI thinks the operation
    // is still in flight (Brian hit this after a disconnect/reconnect when
    // the server-to-server publish call was 401'ing).
    await pool.query(
      "UPDATE publish_log SET live_status = 'republishing' WHERE queue_item_id = $1 AND channel = $2",
      [queueItemId, channel]
    );

    // Forward to main publish route. The publish handler accepts EITHER a
    // Clerk bearer token OR an adminPassword for cron-style server-to-server
    // calls. We're already past requireAuth on the outer republish call so
    // the user is verified — using adminPassword here is the right shape for
    // the server-to-server hop. Without it the fetch lands on the 401 path
    // and the publish never runs.
    const publishRes = await fetch(`${process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}/api/publishing/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queueItemId,
        channels: [channel],
        adminPassword: process.env.ADMIN_RELAY_PASSWORD,
      })
    });
    const publishData = await publishRes.json();

    if (publishRes.ok && publishData.success) {
      return res.json({ success: true, result: publishData.results?.[channel] });
    }

    // Inner publish failed — unstick the 'republishing' state so the queue
    // card doesn't show "republishing…" forever. Reset to NULL (the canonical
    // "no live status known" value, same as a fresh log row).
    await pool.query(
      "UPDATE publish_log SET live_status = NULL WHERE queue_item_id = $1 AND channel = $2 AND live_status = 'republishing'",
      [queueItemId, channel]
    ).catch(() => {});

    const errMsg = publishData?.error || `Republish failed (HTTP ${publishRes.status})`;
    console.error(`[REPUBLISH] queueItemId=${queueItemId} channel=${channel} status=${publishRes.status} error=${errMsg}`);
    return res.status(500).json({ error: errMsg });
  } catch (err) {
    // Catch-path: also unstick the row if the fetch itself threw.
    await pool.query(
      "UPDATE publish_log SET live_status = NULL WHERE queue_item_id = $1 AND channel = $2 AND live_status = 'republishing'",
      [queueItemId, channel]
    ).catch(() => {});
    console.error('[REPUBLISH]', err.message);
    return res.status(500).json({ error: err.message });
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
// ── Brand Preview Page ────────────────────────────────────────────────────────
// Magazine-style bespoke-brief page for prospect outreach. URL:
//   https://forgeintelligence.ai/preview/<brand-uuid>
// Gated by UUID knowledge (128 bits of entropy — same pattern Dropbox/Notion use).
// Renders businessProfile + competitors + strategic recommendations from profile_data
// as a designed report, not a dashboard. Noindex'd so it doesn't get crawled or leak.
app.get('/preview/:brandId', async (req, res) => {
  const { brandId } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brandId)) {
    return res.status(404).send('Not found');
  }
  try {
    const r = await pool.query(
      `SELECT id, brand_name, brand_url, logo_url, profile_data FROM brand_profiles WHERE id = $1`,
      [brandId]
    );
    if (!r.rows.length) return res.status(404).send('Not found');
    const brand = r.rows[0];
    const pd = brand.profile_data || {};
    const bp = pd.businessProfile || {};
    const competitors = Array.isArray(pd.discoveredCompetitors) ? pd.discoveredCompetitors : [];
    const moats = Array.isArray(pd.strategicMoats) ? pd.strategicMoats : [];
    const gaps = Array.isArray(pd.competitiveGaps) ? pd.competitiveGaps : [];
    const recs = Array.isArray(pd.strategicRecommendations) ? pd.strategicRecommendations : [];
    const marketCategory = pd.marketCategory || '';

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const brandName = esc(brand.brand_name);
    const brandDomain = (brand.brand_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const logoUrl = brand.logo_url || '';
    const previewUrl = `https://forgeintelligence.ai/preview/${brandId}`;
    const generatedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Strip any bare-domain cruft in competitor URLs and dedupe by hostname
    const cleanCompetitors = [...new Set(competitors.map(c => {
      try {
        return new URL(c.startsWith('http') ? c : 'https://' + c).hostname.replace(/^www\./, '');
      } catch { return null; }
    }).filter(Boolean))].slice(0, 8);

    // Prioritize: high-priority gaps first, cap at 5 for visual rhythm
    const sortedGaps = [...gaps].sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.priority] ?? 3) - (order[b.priority] ?? 3);
    }).slice(0, 5);

    // Top recs by impact/effort ratio — high-impact + low/medium effort surface first
    const sortedRecs = [...recs].sort((a, b) => {
      const impactScore = { high: 3, medium: 2, low: 1 };
      const effortPenalty = { low: 0, medium: 1, high: 2 };
      const sa = (impactScore[a.impact] || 0) - (effortPenalty[a.effort] || 0);
      const sb = (impactScore[b.impact] || 0) - (effortPenalty[b.effort] || 0);
      return sb - sa;
    }).slice(0, 6);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow, noarchive" />
  <title>${brandName} — Brand Intelligence Brief by Forge</title>
  <meta name="description" content="A bespoke brand intelligence brief prepared by Forge Intelligence for ${brandName}." />
  <link rel="canonical" href="${previewUrl}" />
  <style>
    :root {
      --ink: #0A0E1A;
      --ink-soft: #2B3346;
      --ink-muted: #6B7489;
      --paper: #FAFAF7;
      --paper-soft: #F3F2EC;
      --accent: #3563FF;
      --accent-soft: #E8EEFF;
      --gold: #B8944D;
      --rule: #D8D6CC;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: 'Charter', 'Iowan Old Style', 'Palatino Linotype', Palatino, 'URW Palladio L', Georgia, serif;
      background: var(--paper);
      color: var(--ink);
      line-height: 1.6;
      font-size: 17px;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 760px; margin: 0 auto; padding: 60px 32px 100px; }

    /* Masthead */
    .masthead {
      border-bottom: 3px double var(--ink);
      padding-bottom: 24px;
      margin-bottom: 48px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
    }
    .masthead .pub {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }
    .masthead .pub strong { color: var(--ink); }
    .masthead .date {
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }

    /* Hero */
    .hero { margin-bottom: 56px; }
    .hero .issue {
      font-family: 'Inter', sans-serif;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 20px;
    }
    .hero h1 {
      font-size: 54px;
      line-height: 1.05;
      letter-spacing: -0.02em;
      font-weight: 400;
      margin-bottom: 24px;
      color: var(--ink);
    }
    .hero .dek {
      font-size: 21px;
      line-height: 1.45;
      color: var(--ink-soft);
      font-style: italic;
      max-width: 620px;
    }
    .hero .logo-row {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--rule);
    }
    .hero .logo-row img {
      height: 40px;
      width: auto;
      max-width: 160px;
      object-fit: contain;
    }
    .hero .logo-row .domain {
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      color: var(--ink-muted);
    }

    /* Section styling */
    section { margin-bottom: 72px; }
    .section-label {
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 12px;
    }
    h2 {
      font-size: 34px;
      line-height: 1.15;
      letter-spacing: -0.015em;
      font-weight: 400;
      margin-bottom: 20px;
      color: var(--ink);
    }
    h3 {
      font-size: 20px;
      line-height: 1.3;
      font-weight: 500;
      margin-bottom: 10px;
      color: var(--ink);
      letter-spacing: -0.005em;
    }
    p { margin-bottom: 18px; color: var(--ink-soft); }
    p.lead { font-size: 19px; line-height: 1.55; color: var(--ink); }

    /* Drop cap on first paragraph of business profile */
    .dropcap::first-letter {
      font-size: 72px;
      line-height: 0.85;
      float: left;
      margin-right: 10px;
      margin-top: 6px;
      margin-bottom: -6px;
      font-weight: 500;
      color: var(--gold);
    }

    /* Market category callout */
    .market-callout {
      border-left: 3px solid var(--gold);
      padding: 16px 20px;
      background: var(--paper-soft);
      margin: 32px 0;
      font-size: 16px;
    }
    .market-callout .label {
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--ink-muted);
      margin-bottom: 4px;
    }
    .market-callout .value {
      font-family: 'Inter', sans-serif;
      font-size: 16px;
      font-weight: 500;
      color: var(--ink);
    }

    /* Facts grid */
    .facts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 24px;
      margin: 32px 0;
      padding: 28px 0;
      border-top: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule);
    }
    .fact .label {
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .fact .value {
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: var(--ink);
    }

    /* Competitor chips */
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .chip {
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      padding: 6px 12px;
      border: 1px solid var(--rule);
      border-radius: 4px;
      color: var(--ink-soft);
      background: white;
    }

    /* Moats — numbered */
    .moat, .gap, .rec {
      position: relative;
      padding: 24px 0;
      border-top: 1px solid var(--rule);
    }
    .moat:last-child, .gap:last-child, .rec:last-child { border-bottom: 1px solid var(--rule); }
    .moat .num, .gap .num, .rec .num {
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.18em;
      color: var(--gold);
      text-transform: uppercase;
      margin-bottom: 12px;
      display: inline-block;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--gold);
    }
    .moat .capability { font-weight: 500; color: var(--ink); margin-bottom: 6px; font-size: 17px; line-height: 1.4; }
    .moat .protects-label, .gap .owner-label, .rec .meta-label {
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      margin-top: 14px;
      margin-bottom: 4px;
    }
    .moat .protects, .gap .owner, .rec .meta {
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      color: var(--ink-soft);
    }

    /* Gaps — priority badges */
    .gap .priority {
      display: inline-block;
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      padding: 3px 10px;
      border-radius: 3px;
      margin-left: 8px;
      vertical-align: middle;
    }
    .priority-high { background: #FEE2E2; color: #991B1B; }
    .priority-medium { background: #FEF3C7; color: #92400E; }
    .priority-low { background: #DBEAFE; color: #1E40AF; }
    .gap .topic { font-weight: 500; color: var(--ink); font-size: 17px; line-height: 1.4; display: inline; }
    .gap .whitespace { margin-top: 14px; color: var(--ink-soft); font-style: italic; }

    /* Recs — unified badge system.
       All three badges (category, impact, effort) share a consistent shape and
       typography. Color treatment is the only signal of severity:
       - Category: accent (always, identifies the type of move)
       - Impact: traffic-light tinted by level (high=green, medium=amber, low=grey)
       - Effort: same traffic-light, inverted (low effort=green, high=amber)
       The dot prefix gives each badge a colored anchor that reads instantly. */
    .rec .rec-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 14px;
    }
    .rec .tag,
    .rec [class*="tag-"] {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 6px;
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      line-height: 1.2;
    }
    .rec .tag::before,
    .rec [class*="tag-"]::before {
      content: '';
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
      opacity: 0.85;
    }
    /* Category — accent-tinted, neutral signal of the move type */
    .tag-category { background: var(--accent-soft); color: var(--accent); }
    /* Impact — green (high) → amber (medium) → grey (low) */
    .tag-impact-high   { background: #D1FAE5; color: #047857; }
    .tag-impact-medium { background: #FEF3C7; color: #92400E; }
    .tag-impact-low    { background: #F3F4F6; color: #4B5563; }
    /* Effort — INVERTED: low effort (good!) reads green, high effort reads amber */
    .tag-effort-low    { background: #D1FAE5; color: #047857; }
    .tag-effort-medium { background: #F3F4F6; color: #4B5563; }
    .tag-effort-high   { background: #FEF3C7; color: #92400E; }
    .rec .title { font-weight: 500; color: var(--ink); font-size: 19px; line-height: 1.35; margin-bottom: 10px; }
    .rec .description { color: var(--ink-soft); font-size: 16px; }

    /* CTA */
    .cta-block {
      margin-top: 80px;
      padding: 40px;
      background: var(--ink);
      color: var(--paper);
      border-radius: 6px;
      text-align: center;
    }
    .cta-block .cta-label {
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 14px;
    }
    .cta-block h3 {
      color: white;
      font-size: 26px;
      font-weight: 400;
      line-height: 1.25;
      margin-bottom: 14px;
      letter-spacing: -0.01em;
    }
    .cta-block p {
      color: #B4BAC7;
      max-width: 480px;
      margin: 0 auto 24px;
      font-size: 16px;
    }
    .cta-block a {
      display: inline-block;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 14px 28px;
      background: var(--accent);
      color: white;
      text-decoration: none;
      border-radius: 4px;
      transition: background 0.15s;
    }
    .cta-block a:hover { background: #2449D4; }

    /* Colophon */
    .colophon {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid var(--rule);
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      letter-spacing: 0.1em;
      color: var(--ink-muted);
      text-align: center;
    }
    .colophon a { color: var(--ink-soft); text-decoration: none; border-bottom: 1px solid var(--rule); }

    @media (max-width: 640px) {
      .wrap { padding: 32px 20px 80px; }
      .hero h1 { font-size: 38px; }
      .hero .dek { font-size: 18px; }
      h2 { font-size: 26px; }
      .facts-grid { grid-template-columns: 1fr; }
      .masthead { flex-direction: column; align-items: flex-start; gap: 10px; }
    }
  </style>
</head>
<body>
  <div class="wrap">

    <header class="masthead">
      <div class="pub">A <strong>FORGE INTELLIGENCE</strong> BRAND BRIEF</div>
      <div class="date">${generatedDate}</div>
    </header>

    <section class="hero">
      <div class="issue">Prepared for ${brandName}</div>
      <h1>${bp.whatTheyDo ? esc(bp.whatTheyDo.split(/[—.]/, 1)[0].trim()) : brandName}</h1>
      ${bp.targetBuyer ? `<p class="dek">${esc(bp.targetBuyer)}</p>` : ''}
      <div class="logo-row">
        ${logoUrl ? `<img src="${esc(logoUrl)}" alt="${brandName} logo" onerror="this.style.display='none'" />` : ''}
        <span class="domain">${esc(brandDomain)}</span>
      </div>
    </section>

    ${bp.whatTheyDo ? `
    <section>
      <div class="section-label">The Business</div>
      <h2>What we see when we read your site</h2>
      <p class="lead dropcap">${esc(bp.whatTheyDo)}</p>
      ${marketCategory ? `
      <div class="market-callout">
        <div class="label">Market Category</div>
        <div class="value">${esc(marketCategory)}</div>
      </div>` : ''}
      <div class="facts-grid">
        ${bp.targetBuyer ? `<div class="fact"><div class="label">Target Buyer</div><div class="value">${esc(bp.targetBuyer)}</div></div>` : ''}
        ${bp.geography ? `<div class="fact"><div class="label">Geography</div><div class="value">${esc(bp.geography)}</div></div>` : ''}
        ${bp.companyScale ? `<div class="fact"><div class="label">Company Scale</div><div class="value">${esc(bp.companyScale)}</div></div>` : ''}
        ${bp.revenueModel ? `<div class="fact"><div class="label">Revenue Model</div><div class="value">${esc(bp.revenueModel)}</div></div>` : ''}
      </div>
    </section>` : ''}

    ${cleanCompetitors.length ? `
    <section>
      <div class="section-label">The Competitive Set</div>
      <h2>Who you're actually up against</h2>
      <p>Forge identified these domains as the competitive field your content has to win attention from. Some are named publicly. Others surfaced through semantic comparison of language and positioning.</p>
      <div class="chip-row">
        ${cleanCompetitors.map(c => `<span class="chip">${esc(c)}</span>`).join('')}
      </div>
    </section>` : ''}

    ${moats.length ? `
    <section>
      <div class="section-label">Strategic Moats</div>
      <h2>What you have that most don't</h2>
      <p>These are the structural advantages Forge identified in your positioning — capabilities or stances that protect specific business outcomes.</p>
      ${moats.slice(0, 4).map((m, i) => `
        <div class="moat">
          <span class="num">Moat ${String(i + 1).padStart(2, '0')}</span>
          <div class="capability">${esc(m.capability || '')}</div>
          ${m.rationale ? `<p style="margin-top: 10px; color: var(--ink-soft); font-size: 16px;">${esc(m.rationale)}</p>` : ''}
          ${m.protects ? `<div class="protects-label">Protects</div><div class="protects">${esc(m.protects)}</div>` : ''}
        </div>
      `).join('')}
    </section>` : ''}

    ${sortedGaps.length ? `
    <section>
      <div class="section-label">Competitive Gaps</div>
      <h2>Where the conversation is moving without you</h2>
      <p>These are content territories and positioning angles where competitors are building authority and you are not yet present. Each represents a defensible opportunity — the question is priority and pace.</p>
      ${sortedGaps.map((g, i) => `
        <div class="gap">
          <span class="num">Gap ${String(i + 1).padStart(2, '0')}</span>
          <div>
            <span class="topic">${esc(g.topic || '')}</span>
            <span class="priority priority-${esc(g.priority || 'medium')}">${esc(g.priority || 'medium')}</span>
          </div>
          ${g.ownedBy ? `<div class="owner-label">Currently owned by</div><div class="owner">${esc(g.ownedBy)}</div>` : ''}
          ${g.whitespaceOpportunity ? `<p class="whitespace">${esc(g.whitespaceOpportunity)}</p>` : ''}
        </div>
      `).join('')}
    </section>` : ''}

    ${sortedRecs.length ? `
    <section>
      <div class="section-label">Strategic Recommendations</div>
      <h2>What Forge would do first, if we were running this</h2>
      <p>Ranked by impact-to-effort ratio. High-impact moves with lower effort surface first. Each recommendation is anchored to a specific gap, moat, or positioning observation above.</p>
      ${sortedRecs.map((r, i) => `
        <div class="rec">
          <span class="num">Recommendation ${String(i + 1).padStart(2, '0')}</span>
          <div class="rec-meta">
            ${r.category ? `<span class="tag tag-category">${esc(r.category)}</span>` : ''}
            ${r.impact ? `<span class="tag tag-impact-${esc(r.impact)}">Impact ${esc(r.impact)}</span>` : ''}
            ${r.effort ? `<span class="tag tag-effort-${esc(r.effort)}">Effort ${esc(r.effort)}</span>` : ''}
          </div>
          <div class="title">${esc(r.title || '')}</div>
          ${r.description ? `<p class="description">${esc(r.description)}</p>` : ''}
        </div>
      `).join('')}
    </section>` : ''}

    <div class="cta-block">
      <div class="cta-label">What this becomes</div>
      <h3>This brief is the starting point. Open your full profile to see the deeper layer.</h3>
      <p>What you see above is the surface. Inside Forge, your full brand profile includes the GEO Strategist, content generation in your voice, and a brain that compounds with every article. Open it to explore.</p>
      <a href="https://forgeintelligence.ai/app/context-hub?brand=${esc(brandId)}&utm_source=preview&utm_medium=brief&utm_campaign=${esc(brandId.slice(0, 8))}">Open your full brand profile →</a>
    </div>

    <div class="colophon">
      Generated by <a href="https://forgeintelligence.ai">Forge Intelligence</a> · ${generatedDate}
    </div>

  </div>
</body>
</html>`;

    res.type('text/html; charset=utf-8');
    res.send(html);
  } catch(e) {
    console.error('[preview]', e.message);
    res.status(500).send('An error occurred rendering the preview.');
  }
});


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

    // ── Canonicalize URL via 301 redirect ────────────────────────────────────
    // Same article was accessible at /articles/forge-intelligence/... AND
    // /articles/forgeintelligence-ai/... — Google saw two copies and flagged
    // "Duplicate without user-selected canonical". Force the canonical brand_url-based
    // slug for any request that came in via a different valid slug. The publish flow,
    // sitemap, and IndexNow all use the brand_url-based form, so this is the SSOT.
    const canonicalBrandSlug = (matchedBrand.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    if (canonicalBrandSlug && brandSlug !== canonicalBrandSlug) {
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return res.redirect(301, `/articles/${canonicalBrandSlug}/${articleSlug}${qs}`);
    }

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
    // Meta description: clamp at 155 chars so Bing + Google don't truncate mid-sentence.
    // Truncate at word boundary + add ellipsis if the raw source exceeds the ceiling.
    const rawDescription = aj.metaDescription || (aj.sections?.[0]?.body || aj.sections?.[0]?.content || '');
    let clampedDescription = rawDescription.trim();
    if (clampedDescription.length > 155) {
      const sliced = clampedDescription.slice(0, 152);
      const lastSpace = sliced.lastIndexOf(' ');
      clampedDescription = (lastSpace > 120 ? sliced.slice(0, lastSpace) : sliced) + '…';
    }
    const description = clampedDescription.replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const imageUrl = article.hero_image_url || '';
    const artBaseDomain = process.env.BASE_DOMAIN || 'forgeintelligence.ai';

    // ── Publisher identity check ──────────────────────────────────────────
    // Forge Intelligence's OWN brand articles should be indexed on forgeintelligence.ai
    // (they're Forge's content, on Forge's domain, and we WANT AI citation here).
    // All other brands are customers previewing their content — we must NOT let crawlers
    // index these pages on our domain. Canonical points at the customer's real domain
    // if known; noindex meta is injected unconditionally so even non-canonical-respecting
    // crawlers (some AI crawlers) still get the directive.
    const FORGE_OWN_BRAND_ID = 'cde5feeb-b3d7-4990-adee-a54977ab9c52';
    const isForgeOwnContent = matchedBrand.id === FORGE_OWN_BRAND_ID;

    // Build canonical URL. For Forge own: forgeintelligence.ai. For customers: their real domain.
    let canonicalUrl;
    if (isForgeOwnContent) {
      canonicalUrl = `https://${artBaseDomain}/articles/${brandSlug}/${articleSlug}`;
    } else if (matchedBrand.article_base_url && matchedBrand.article_base_url.trim()) {
      // Customer has explicitly configured an article_base_url (e.g., Sandbox-XM's sandbox-xm.com/articles)
      const base = matchedBrand.article_base_url.replace(/\/+$/, '');
      canonicalUrl = `${base}/${articleSlug}`;
    } else if (matchedBrand.brand_url) {
      // No article_base_url set — fall back to just the brand root. Better than pointing at Forge.
      const rootUrl = matchedBrand.brand_url.startsWith('http')
        ? matchedBrand.brand_url.replace(/\/+$/, '')
        : `https://${matchedBrand.brand_url.replace(/\/+$/, '')}`;
      canonicalUrl = rootUrl;
    } else {
      // Last resort — still use Forge URL but noindex will prevent indexing anyway
      canonicalUrl = `https://${artBaseDomain}/articles/${brandSlug}/${articleSlug}`;
    }

    const brandName = (matchedBrand.brand_name || matchedBrand.profile_data?.voice_profile?.brand_name || brandSlug).replace(/"/g, '&quot;');
    const authorName = (matchedBrand.profile_data?.voice_profile?.author_name || brandName).replace(/"/g, '&quot;');
    const wordCount = (aj.sections || []).reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
    const readMinutes = Math.max(1, Math.round(wordCount / 200));

    const html = await fs.promises.readFile(path.join(__dirname, 'dist', 'index.html'), 'utf8');
    // ── Build JSON-LD schema for Google ──
    // For customer previews (noindex), we skip schema emission entirely. Emitting
    // Article/FAQPage/BreadcrumbList schemas on a noindex page just creates confusing
    // signal — crawlers that DO crawl the page see rich schemas pointing at Forge as
    // publisher, contradicting the canonical + noindex directives. Cleaner to emit
    // nothing and let the customer's real domain be the sole schema source.
    let ldJsonScript = '';
    if (isForgeOwnContent) try {
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

      // ── Article / BlogPosting schema (existing) ──
      // Enriched with keywords + about arrays when generator produces them
      const articleKeywords = Array.isArray(aj.keywords) ? aj.keywords : [];
      const articleAbout = Array.isArray(aj.about) ? aj.about.map(t => ({ "@type": "Thing", "name": t })) : [];

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
        "inLanguage": "en-US",
        ...(articleKeywords.length ? { "keywords": articleKeywords } : {}),
        ...(articleAbout.length ? { "about": articleAbout } : {}),
      };
      ldJsonScript = `\n  <script type="application/ld+json">${JSON.stringify(ldJson, null, 2)}</script>`;

      // ── FAQPage schema — HIGHEST GEO impact ──
      // LLMs (ChatGPT, Claude, Perplexity) preferentially cite FAQPage-structured content
      // when answering user questions. Articles without FAQs compete using unstructured prose.
      // Generator emits `faqs: [{question, answer}]` at article creation time.
      const faqs = Array.isArray(aj.faqs) ? aj.faqs.filter(f => f?.question && f?.answer) : [];
      if (faqs.length) {
        const faqSchema = {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          "mainEntity": faqs.map(f => ({
            "@type": "Question",
            "name": String(f.question).trim(),
            "acceptedAnswer": {
              "@type": "Answer",
              "text": String(f.answer).trim()
            }
          }))
        };
        ldJsonScript += `\n  <script type="application/ld+json">${JSON.stringify(faqSchema, null, 2)}</script>`;
      }

      // ── BreadcrumbList schema — site hierarchy context for LLMs ──
      // Helps LLMs understand where this article sits in the brand's knowledge graph.
      const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": brandName, "item": realUrl },
          { "@type": "ListItem", "position": 2, "name": "Articles", "item": `https://${artBaseDomain}/articles/${brandSlug}` },
          { "@type": "ListItem", "position": 3, "name": article.title, "item": canonicalUrl }
        ]
      };
      ldJsonScript += `\n  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema, null, 2)}</script>`;
    } catch(e) {
      console.error('[ARTICLE-SSR] JSON-LD build failed (non-fatal):', e.message);
    }

    const publishedTime = article.created_at ? new Date(article.created_at).toISOString() : new Date().toISOString();
    const modifiedTime = article.updated_at ? new Date(article.updated_at).toISOString() : publishedTime;
    // Robots directive — indexable for Forge's own content, noindex for customer previews.
    // noindex is a hard directive (all crawlers respect it); nofollow prevents link-graph
    // pollution; noarchive prevents Google/Bing from caching the page.
    const robotsMeta = isForgeOwnContent
      ? 'index, follow, max-image-preview:large, max-snippet:-1'
      : 'noindex, nofollow, noarchive';

    const ogTags = `
  <title>${title} | ${brandName}</title>
  <meta name="description" content="${description}" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta name="robots" content="${robotsMeta}" />
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
    // Table-aware: GFM markdown tables (including the single-line-flat shape
    // that Content Generator sometimes emits, e.g. article 63ed73dd-…) get
    // promoted to real <table> markup so AI crawlers cite them as tabular
    // data instead of seeing literal pipe characters in a paragraph.
    const ssrTryParseTable = (raw) => {
      if (!raw.includes('|')) return null;
      if (!/\|\s*:?-{3,}:?\s*\|/.test(raw)) return null;
      const cells = raw.split('|').map(c => c.trim());
      const isSep = (c) => /^:?-{3,}:?$/.test(c);
      const sepStart = cells.findIndex(isSep);
      if (sepStart === -1) return null;
      let sepEnd = sepStart;
      while (sepEnd < cells.length && isSep(cells[sepEnd])) sepEnd++;
      const colCount = sepEnd - sepStart;
      if (colCount < 1) return null;
      const headers = [];
      for (let i = sepStart - 1; i >= 0 && headers.length < colCount; i--) {
        if (cells[i].length > 0) headers.unshift(cells[i]);
      }
      if (headers.length !== colCount) return null;
      const after = cells.slice(sepEnd);
      let idx = 0;
      while (idx < after.length && after[idx].length === 0) idx++;
      const rows = [];
      while (idx + colCount <= after.length) {
        rows.push(after.slice(idx, idx + colCount));
        idx += colCount;
        while (idx < after.length && after[idx].length === 0) idx++;
      }
      if (rows.length === 0) return null;
      return { headers, rows };
    };
    const ssrRenderParagraph = (para) => {
      const table = ssrTryParseTable(para);
      if (table) {
        const thead = `<thead><tr>${table.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${table.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
        return `<table>${thead}${tbody}</table>`;
      }
      return `<p>${para.trim().replace(/\n/g, '<br>')}</p>`;
    };
    const sectionsHtml = (aj.sections || []).map(s => {
      const heading = (s.heading || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const body = (s.body || s.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const paragraphs = body.split(/\n\n+/).map(ssrRenderParagraph).join('\n');
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

// ── Articles library SSR — canonical + robots ─────────────────────────────
// Google flagged "Duplicate without user-selected canonical" on
// /articles/forgeintelligence-ai because the SPA shell served at both
// /articles and /articles/:brandSlug had no <link rel="canonical">. The
// per-article route at line 1880 already does the full SSR treatment; this
// extends the same pattern to the library views so Search Console sees one
// canonical Articles URL per publisher.
app.get('/articles/:brandSlug', async (req, res) => {
  const { brandSlug } = req.params;
  try {
    const brandsRes = await pool.query('SELECT id, brand_url, brand_name, profile_data FROM brand_profiles');
    let matchedBrand = null;
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

    // Force canonical brand slug — same SSOT logic as the article route.
    const canonicalBrandSlug = (matchedBrand.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    if (canonicalBrandSlug && brandSlug !== canonicalBrandSlug) {
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return res.redirect(301, `/articles/${canonicalBrandSlug}${qs}`);
    }

    const artBaseDomain = process.env.BASE_DOMAIN || 'forgeintelligence.ai';
    const FORGE_OWN_BRAND_ID = 'cde5feeb-b3d7-4990-adee-a54977ab9c52';
    const isForgeOwnContent = matchedBrand.id === FORGE_OWN_BRAND_ID;
    const brandName = (matchedBrand.brand_name || matchedBrand.profile_data?.voice_profile?.brand_name || brandSlug).replace(/"/g, '&quot;');

    // Canonical resolution mirrors the per-article route at line 1953:
    //   - Forge's own library is canonical to itself (forgeintelligence.ai)
    //   - Customer libraries canonical at the customer's article_base_url or
    //     brand root, since the Forge-hosted library is a preview, not the
    //     publisher.
    let canonicalUrl;
    if (isForgeOwnContent) {
      canonicalUrl = `https://${artBaseDomain}/articles/${brandSlug}`;
    } else if (matchedBrand.article_base_url && matchedBrand.article_base_url.trim()) {
      canonicalUrl = matchedBrand.article_base_url.replace(/\/+$/, '');
    } else if (matchedBrand.brand_url) {
      const rootUrl = matchedBrand.brand_url.startsWith('http')
        ? matchedBrand.brand_url.replace(/\/+$/, '')
        : `https://${matchedBrand.brand_url.replace(/\/+$/, '')}`;
      canonicalUrl = rootUrl;
    } else {
      canonicalUrl = `https://${artBaseDomain}/articles/${brandSlug}`;
    }

    const robotsMeta = isForgeOwnContent
      ? 'index, follow, max-image-preview:large, max-snippet:-1'
      : 'noindex, nofollow, noarchive';

    const titleStr = `${brandName} — Articles`;
    const descStr = `Browse articles from ${brandName}.`.replace(/"/g, '&quot;');

    const headTags = `
  <title>${titleStr}</title>
  <meta name="description" content="${descStr}" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta name="robots" content="${robotsMeta}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${brandName}" />
  <meta property="og:title" content="${titleStr}" />
  <meta property="og:description" content="${descStr}" />
  <meta property="og:url" content="${canonicalUrl}" />`;

    const html = await fs.promises.readFile(path.join(__dirname, 'dist', 'index.html'), 'utf8');
    const injected = html
      .replace(/<title>[^<]*<\/title>/, '')
      .replace('<head>', '<head>' + headTags);
    res.set('Cache-Control', 'no-cache');
    return res.send(injected);
  } catch(e) {
    console.error('[ARTICLES-LIBRARY-SSR]', e.message);
    return res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  }
});

// Bare /articles renders the same component as /articles/:brandSlug for the
// union of all brands. That's the duplicate Google flagged. Redirect to
// Forge's canonical brand library so there is exactly one indexable Articles
// URL on this domain. Customer brand libraries remain reachable via their own
// brand-scoped URL (and get noindex'd per the handler above).
app.get('/articles', async (req, res) => {
  const FORGE_OWN_BRAND_ID = 'cde5feeb-b3d7-4990-adee-a54977ab9c52';
  try {
    const forgeBrand = await pool.query(
      'SELECT brand_url FROM brand_profiles WHERE id = $1',
      [FORGE_OWN_BRAND_ID]
    );
    const brandUrl = forgeBrand.rows[0]?.brand_url || '';
    const forgeSlug = brandUrl
      .replace(/https?:\/\//, '')
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase()
      .replace(/^-+|-+$/g, '');
    if (forgeSlug) {
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return res.redirect(301, `/articles/${forgeSlug}${qs}`);
    }
  } catch(e) {
    console.error('[ARTICLES-BARE-SSR]', e.message);
  }
  return res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ── Marketing pages SSR — inject real content so scrapers + crawlers see it ──
// Without this, SPA shell returns 1538 bytes of empty <div id="root"></div>
// Forge's own scraper AND Google both need real HTML to extract product info.

// FAQ pairs — source of truth for both the rendered HTML body AND the FAQPage JSON-LD schema.
// AI engines (Google, Bing, Perplexity, ChatGPT) parse FAQPage schema as Q&A pairs and cite them
// directly in answers. Each Q is phrased the way a buyer would search; each A leads with a
// definitional sentence and includes a named Forge concept the engine can attribute.
const FAQ_PAIRS = [
  // What it is — define the category
  { q: "What's the difference between AI content generation and AI content intelligence?", a: "AI content generation produces output. AI content intelligence builds the strategic worldview that makes the output worth producing. Generation tools take a prompt and write an article. Intelligence systems extract competitive gaps, audience blind spots, and topical whitespace first — then condition every word against that worldview. Forge inverts the order: intelligence is upstream of generation." },
  { q: "What is a Context Agent Architecture?", a: "A Context Agent Architecture is a sequenced system of specialized AI agents where each stage conditions the next. Forge's pipeline runs eight: Context Hub, GEO Strategist, Authenticity Enricher, Content Generator, Compliance Gate, Publishing Queue, Performance Dashboard, and Brain Memory. By stage four, the model isn't writing from a prompt. It's writing from a fully constructed competitive worldview." },
  { q: "What is Generative Engine Optimization (GEO) and how is it different from SEO?", a: "GEO optimizes content to be cited by AI engines like ChatGPT, Perplexity, and Gemini. SEO optimizes content to rank in search results. Different inputs, different ranking signals, different success metrics. SEO rewards keyword authority and backlinks. GEO rewards distinctive concepts, named frameworks, and citeable definitions that AI engines can attribute back to you. Same goal — visibility — different game." },
  { q: "What is Voice of Market and how is it different from Share of Voice?", a: "Share of Voice measures how often your brand shows up versus competitors. It's a backward-looking scoreboard. Voice of Market measures the unspoken market tension no competitor has named yet — the strategic angle that hasn't been claimed. Share of voice tells you where you stand. Voice of market tells you where to attack. One is a metric. The other is an advantage." },
  { q: 'What does "compounding" mean in B2B content operations?', a: "Compounding content operations get smarter every cycle through an explicit feedback loop. Performance data writes back into strategy via Brain Memory — the 8th and final agent in Forge's Context Agent Architecture. Patterns that worked become reusable templates. Mistakes get flagged and avoided. The system never starts from scratch. Every published article makes the next one easier to brief, faster to write, and more likely to convert." },
  { q: "What does it mean for an AI content tool to be stateful?", a: "A stateful AI content tool remembers everything across sessions: brand voice rules, founder facts, competitive positioning, what content converted, what failed. In Forge's Context Agent Architecture this is implemented through Brain Memory — the 8th agent that writes patterns back after every cycle. Most AI tools are stateless: each session is a fresh prompt with no history. Stateful systems compound. Stateless ones repeat themselves." },
  { q: "What is brand brain memory in an AI content system?", a: "Brand brain memory is the persistent intelligence layer that stores everything an AI content system has ever learned: voice rules, founder facts, positioning claims, performance patterns, competitive context. In Forge's Context Agent Architecture this layer is named Brain Memory — the 8th and final agent that writes patterns back after every cycle. Without it, the system restarts from zero each session. The brain is the moat — not the model." },
  { q: "What is a citation heat map?", a: "A citation heat map is a per-section, per-FAQ view of where AI engines actually pull from in your content corpus. It distinguishes prose authority — when engines cite specific paragraphs — from domain authority, when they cite the URL without quoting. It also surfaces FAQ ROI: which questions actually get picked up as AI answers and which ones engines ignore." },
  // What it isn't — reframe the incumbents
  { q: "Why do AI content tools get worse the longer you use them?", a: "Most don't get worse — they stay exactly the same. Every AI content tool is stateless. Each session starts from zero, with no memory of what worked, what failed, or what your competitive position looked like last quarter. Output gets repetitive because there's no compounding learning. Forge inverts that entirely with Brain Memory — the 8th agent in its Context Agent Architecture — writing performance patterns back into the brand profile after every cycle." },
  { q: "Why does AI content sound generic even when the brief is good?", a: "Briefs describe topics. They don't capture the competitive worldview required to write content that differentiates. A brief tells the model what to write about. It doesn't tell the model what your competitors are weak on, where you have right-to-win, or which angles only you can defend. Without that context, even the best models produce content that any competitor could have written." },
  { q: "Why isn't faster content faster ROI?", a: "Content velocity only compounds when each piece adds intelligence to the next. Volume without intelligence produces faster mediocrity, not faster results. Ten articles that don't differentiate your positioning cost more than two that do — they consume editorial bandwidth, fragment topical authority, and train your audience to ignore you. Speed is a feature only after intelligence is solved." },
  { q: "What's the difference between AI content tools and AI content infrastructure?", a: "A tool executes prompts. Infrastructure compounds intelligence across cycles. Tools are bought to solve a specific task: write a blog post, summarize a transcript, draft a social caption. Infrastructure is bought to build a long-term capability: persistent brand memory, competitive intelligence, performance feedback, and topical authority that grows every quarter. Different purchase decision. Different outcomes. Different commercial relationship." },
  { q: "What's the limit of agentic AI in content marketing?", a: "Agents fail without state. Most agentic AI in content marketing chains together prompts but loses everything between sessions — every agent restarts the conversation. That's not autonomy, that's amnesia. Real agentic content systems require persistent memory across sequenced agents — the pattern Forge calls Context Agent Architecture. Without that scaffolding, agents produce coordinated mediocrity faster than humans can review it." },
  { q: "What's the difference between content marketing and content intelligence operations?", a: "Content marketing executes the plan. Content intelligence operations decides the plan. Marketing teams produce calendars, ship articles, and measure traffic. Intelligence operations runs upstream: scoping competitive gaps, identifying audience blind spots, mapping topical authority whitespace, deciding what content to ship and what to skip. Most companies have content marketing. Almost none have content intelligence. That gap is where the moat sits." },
  { q: "Why does most AI-generated B2B content get ignored by AI engines?", a: "AI engines cite content with distinctive concepts, named frameworks, and original definitions — content the engine can attribute back to a specific source. Most AI-generated B2B content has none of that. It paraphrases the same topics every competitor covers, with no original framework worth quoting. The fix isn't better prompts. It's a competitive worldview before generation, so the output contains things only your brand could have said." },
  // How it works — method/decision frame
  { q: "Why is the brief more important than the model in B2B content?", a: "Models converge. Briefs differentiate. Claude, GPT-4, and Gemini all produce competent prose from a strong brief. None of them can compensate for a brief that lacks competitive context, audience specificity, or strategic angle. The intelligence is upstream of generation. A weak brief with the best model in the world still produces forgettable content. A strong brief makes any modern model look brilliant." },
  { q: "How do you measure ROI of AI content beyond cost-per-article?", a: "Cost-per-article is the wrong unit. The right metrics: AI citation rate (how often engines cite your content), cited section breakdown (which sections get pulled), pipeline contribution per article, and competitive gap closure. A $200 article that gets cited weekly by ChatGPT for a high-intent query is worth more than 50 articles that fade into the volume noise. Measure outcomes, not output." },
  { q: "When should you NOT use AI content generation?", a: "When you don't have a competitive worldview to write from. AI content generation amplifies whatever you feed it — including the absence of strategy. Without competitive intelligence, audience clarity, and a defensible positioning angle, generated content sounds exactly like every competitor's generated content. The right move is to invest in intelligence first. Faster mediocrity isn't a win." },
  { q: "Why don't AI content tools learn from the content that converted?", a: "Most don't have a feedback loop. They generate content, hand it off, and forget. Performance data lives in analytics tools that the content system never reads. So the same patterns that failed get tried again. The same titles that flopped get rewritten. Forge closes that loop: engagement and citation data write back into the brain, conditioning every future generation." },
  { q: "How should mid-market B2B teams structure briefs for AI content generation?", a: "The order matters. Competitive intelligence first — what gaps exist, where you have right-to-win. Topical territory second — what conversations you can claim that competitors can't. Voice rules third — how your brand sounds, what it never says. Topic and angle last. Most teams flip this: they start with the topic and bolt on context. The result is generic content with brand paint." },
  // Decision-frame addition (May 6 evening). Surfaced from v10 brain rescan as top whitespace gap.
  { q: "How do you assess if your B2B content team is AI-ready?", a: "AI readiness for content teams isn't about whether the tools work — it's about whether your team has the upstream conditions to make AI output meaningful. Forge's five-dimension framework: brand intelligence depth, content brief discipline, performance feedback structure, voice rule clarity, and competitive worldview. Teams strong on all five get distinctive output from any AI model. Teams weak on any one dimension get generic content competitors could have written." }
];

// HTML body version — visible to crawlers in the SSR'd root div. Each Q&A is an h2/p pair so
// keyword-focused crawlers (not just FAQPage-aware ones) extract the content cleanly.
const FAQ_BODY_HTML = `
  <h1>Forge Intelligence FAQ</h1>
  <p>Twenty questions about AI content. Each answer leads with a definition and includes a named concept Forge has staked.</p>
${FAQ_PAIRS.map(p => `  <h2>${p.q.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h2>\n  <p>${p.a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('\n')}
`;

// FAQPage JSON-LD — machine-readable Q&A schema. AI engines parse this directly and use it
// as candidate answers for relevant queries. Critical for citation; bare HTML alone won't trigger
// the same FAQPage classification.
const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": FAQ_PAIRS.map(p => ({
    "@type": "Question",
    "name": p.q,
    "acceptedAnswer": { "@type": "Answer", "text": p.a }
  }))
};

const MARKETING_META = {
  '/': {
    title: 'Forge Intelligence — Brand Intelligence That Compounds',
    // Meta description: 150 chars. Bing truncates at 160; Google at ~155. Keep strongest hook + specific claim.
    description: 'Forge extracts competitive intelligence from brand websites using an 8-stage AI pipeline. Intelligence compounds. The content proves it.',
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
    // 155-char ceiling — dropped the agent name list (it's in the page body already).
    description: 'Eight specialized AI agents. One compounding intelligence system. Each stage conditions the next — from brand scrape to published content that cites.',
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
  },
  '/faq': {
    title: 'Frequently Asked Questions — AI Content Intelligence | Forge Intelligence',
    // 155-char ceiling. Lead with the category-defining hook.
    description: 'AI content generation produces output. AI content intelligence builds the worldview that makes the output worth producing. Twenty answers from Forge.',
    bodyContent: FAQ_BODY_HTML
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
// Branded OG card — 2500x1313 (aspect ratio 1.904:1, same as 1200x630). Social platforms scale as needed.
const DEFAULT_OG_IMAGE = 'https://forgeintelligence.ai/og-card.png';

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
  <meta property="og:image:width" content="2500" />
  <meta property="og:image:height" content="1313" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapedTitle}" />
  <meta name="twitter:description" content="${escapedDesc}" />
  <meta name="twitter:image" content="${ogImage}" />
  <script type="application/ld+json">${JSON.stringify(ORG_JSON_LD)}</script>
  <script type="application/ld+json">${JSON.stringify(WEBSITE_JSON_LD)}</script>${pathOverride === '/faq' ? `
  <script type="application/ld+json">${JSON.stringify(FAQ_JSON_LD)}</script>` : ''}`;
  // Inject head tags AND body content. Content sits inside #root so React hydrates over it on the client.
  const withMeta = html.replace(/<title>[^<]*<\/title>/, '').replace('<head>', '<head>' + headTags);
  const withBody = withMeta.replace('<div id="root"></div>', `<div id="root"><div style="position:absolute;left:-99999px;top:-99999px" aria-hidden="true">${meta.bodyContent}</div></div>`);
  return withBody;
}

app.get(['/', '/product', '/faq'], async (req, res, next) => {
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
//
// Claude-powered extraction (post-#98 regex tool was honest but brittle —
// modern frameworks use Tailwind utilities, CSS modules with hash suffixes,
// BEM, or styled-components — none of which match the narrow regex patterns
// the old tool relied on). This pass hands rendered HTML to Claude Haiku
// and asks for structural identification regardless of naming convention.
// Claude can read class="c-hero__inner", class="Hero_section__a1b2c", or
// class="text-3xl font-bold mb-8" and tell us which is the hero. For
// utility-class-only sites (Tailwind), Claude returns null for fields
// that have no stable class to extract; the existing hardcoded defaults
// kick in for those fields and the extraction count drops, which the
// honest-failure framework from #98 already surfaces in the UI.
app.post('/api/brand-settings/:brandProfileId/scrape-template', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { articleUrl, catalogUrl } = req.body;
  if (!articleUrl) return res.status(400).json({ error: 'articleUrl required' });
  try {
    // Same threshold semantics as the regex version — # of fields Claude
    // successfully extracted (non-null) needs to clear the bar.
    const MIN_ARTICLE_EXTRACTED = 3;

    // We grade extraction by regions located in the rendered HTML, not by
    // stable class names found. Article pages have 6 regions (nav, hero,
    // body, backLink, cta, footer); catalogs have 3 (grid, card, meta).
    // A region counts as "located" when Claude can identify it by any
    // means — semantic class, data-testid, HTML5 landmark, or unambiguous
    // content match — even if no stable class is available. That's the
    // honest measure of "did we read the page" vs. the prior count of
    // "did we find inheritable class names," which is always zero on
    // utility-class sites regardless of whether content was extractable.
    const ARTICLE_TOTAL = 6;
    const CATALOG_TOTAL = 3;

    // HTML fetching goes through forgeScrape — single workhorse via Bright
    // Data Web Unlocker. Replaces the old direct-fetch + Jina + SPA-shell-
    // heuristic chain. Bright Data auto-detects JS rendering, handles
    // anti-bot, and returns the rendered DOM in one call.

    // Strip script + style + inline-svg noise before sending to Claude —
    // these bytes don't carry structural info and just eat into the prompt
    // budget. We keep the cap at 50k chars after stripping so a richer
    // article page still fits comfortably.
    const cleanHtml = (html) => html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    const claudeExtractArticle = async (html) => {
      const cleaned = cleanHtml(html).slice(0, 50000);
      const prompt = `You are extracting structural regions from a published article page. The output drives a content template: a "class" field provides a CSS hook for sites that have stable class names; a "found" boolean records whether the region exists in the page at all.

For each region:
- "class" / "*Class": a stable, semantic CSS class string. Return null if the only available classes are utility classes (Tailwind: text-3xl, mb-8, flex), hash-suffixed CSS modules (Hero_section__a1b2c), or styled-components hashes (sc-bdVaJa). Don't guess.
- "found": true if you can locate this region in the HTML by ANY means — a semantic class name, a data-testid attribute, an HTML5 landmark like <nav>/<article>/<main>/<footer>, an ARIA role, or unambiguous content (e.g. a <header> with a logo + links is clearly nav, an <h1> followed by paragraphs is clearly the article hero+body). Return false only when the region truly isn't present in the page.

It's normal and expected for "class" to be null while "found" is true on modern sites that use utility CSS — that means the region exists but has no inheritable class hook. Both signals matter independently.

Return ONLY valid JSON in this exact shape (no markdown, no commentary):
{
  "nav":      { "class": "string|null", "found": true|false, "linksHtml": "first 800 chars of nav inner HTML or empty string" },
  "hero":     { "sectionClass": "string|null", "eyebrowClass": "string|null", "metaClass": "string|null", "imageWrapClass": "string|null", "found": true|false },
  "body":     { "sectionClass": "string|null", "bodyClass": "string|null", "found": true|false },
  "backLink": { "class": "string|null", "text": "the link's text content if present, else empty string", "found": true|false },
  "cta":      { "class": "string|null", "found": true|false },
  "footer":   { "class": "string|null", "found": true|false }
}

Field meanings:
- nav: site primary navigation, usually <nav> or <header>'s top bar
- hero: the wrapper around the article title + meta (eyebrow = small kicker/category; meta = byline/date; imageWrap = hero image wrapper)
- body: the prose container holding article paragraphs
- backLink: a "Back to articles" / "View all" link at the top or bottom
- cta: a call-to-action box at the article's end (newsletter signup, demo CTA, etc.)
- footer: site footer

ARTICLE HTML (truncated to 50000 chars, scripts/styles/svg stripped):
${cleaned}`;

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = msg.content[0]?.text || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Claude returned no JSON');
      return JSON.parse(jsonMatch[0]);
    };

    const claudeExtractCatalog = async (html) => {
      const cleaned = cleanHtml(html).slice(0, 50000);
      const prompt = `You are extracting structural regions from an article catalog / index page. The output drives a content template: a "class" field provides a CSS hook for sites that have stable class names; a "found" boolean records whether the region exists in the page at all.

For each region:
- "class" / "*Class": a stable, semantic CSS class string. Return null if classes are utility classes (Tailwind), hash-suffixed CSS modules, or styled-components hashes. Don't guess.
- "found": true if you can locate this region in the HTML by ANY means — semantic class, data-testid, HTML5 landmark, ARIA role, or unambiguous structural pattern (e.g. repeated card-like wrappers under a single parent is clearly the grid). Return false only when the region truly isn't present.

It's normal for "class" to be null while "found" is true on modern utility-CSS sites — the region exists, just without an inheritable class hook.

Return ONLY valid JSON in this exact shape:
{
  "grid": { "class": "string|null", "found": true|false },
  "card": { "class": "string|null", "imageClass": "string|null", "bodyClass": "string|null", "found": true|false },
  "meta": { "categoryClass": "string|null", "readMoreClass": "string|null", "found": true|false }
}

Field meanings:
- grid: the list/grid wrapper that contains all article cards
- card: a single article card / preview wrapper (image area + body area)
- meta: per-card metadata — category tag + "Read more"/"→" link

CATALOG HTML (truncated to 50000 chars, scripts/styles/svg stripped):
${cleaned}`;

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = msg.content[0]?.text || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Claude returned no JSON');
      return JSON.parse(jsonMatch[0]);
    };

    // Build the persisted template from Claude's output, applying the
    // existing hardcoded fallbacks for any field Claude marked null.
    // "extracted" counts regions Claude was able to locate in the HTML
    // (claude[region].found === true) — not class-name hits. On Tailwind
    // sites class strings are usually null while regions are still
    // located via data-testid / semantic tags, which is the correct
    // success state for downstream Smart Export.
    const buildArticleTemplate = (claude, sourceUrl) => {
      let extracted = 0;
      const located = (region) => {
        if (region?.found === true) { extracted++; return true; }
        return false;
      };
      const pickClass = (val, fallback) => (typeof val === 'string' && val.trim()) ? val.trim() : fallback;
      located(claude?.nav);
      located(claude?.hero);
      located(claude?.body);
      located(claude?.backLink);
      located(claude?.cta);
      located(claude?.footer);
      const tpl = {
        type: 'article',
        scrapedAt: new Date().toISOString(),
        sourceUrl,
        nav: {
          class: pickClass(claude?.nav?.class, 'navbar'),
          linksHtml: typeof claude?.nav?.linksHtml === 'string' ? claude.nav.linksHtml.slice(0, 800) : '',
        },
        hero: {
          sectionClass:   pickClass(claude?.hero?.sectionClass,   'article-hero'),
          eyebrowClass:   pickClass(claude?.hero?.eyebrowClass,   'article-hero-eyebrow'),
          metaClass:      pickClass(claude?.hero?.metaClass,      'article-meta'),
          imageWrapClass: pickClass(claude?.hero?.imageWrapClass, 'article-hero-image'),
        },
        body: {
          sectionClass: pickClass(claude?.body?.sectionClass, 'article-body-section'),
          bodyClass:    pickClass(claude?.body?.bodyClass,    'article-body'),
        },
        backLink: {
          class: pickClass(claude?.backLink?.class, 'article-back'),
          text: (typeof claude?.backLink?.text === 'string' && claude.backLink.text.trim()) ? claude.backLink.text.trim() : 'Back to Articles',
          href: catalogUrl || '/',
        },
        cta:    { class: pickClass(claude?.cta?.class,    'article-cta-section') },
        footer: { class: pickClass(claude?.footer?.class, 'site-footer') },
      };
      return { tpl, extracted, totalTrackable: ARTICLE_TOTAL };
    };

    const buildCatalogTemplate = (claude, sourceUrl) => {
      let extracted = 0;
      const located = (region) => {
        if (region?.found === true) { extracted++; return true; }
        return false;
      };
      const pickClass = (val, fallback) => (typeof val === 'string' && val.trim()) ? val.trim() : fallback;
      located(claude?.grid);
      located(claude?.card);
      located(claude?.meta);
      const tpl = {
        type: 'catalog',
        scrapedAt: new Date().toISOString(),
        sourceUrl,
        grid: { class: pickClass(claude?.grid?.class, 'articles-grid') },
        card: {
          class:      pickClass(claude?.card?.class,      'article-card'),
          imageClass: pickClass(claude?.card?.imageClass, 'article-card-image'),
          bodyClass:  pickClass(claude?.card?.bodyClass,  'article-card-body'),
        },
        meta: {
          categoryClass: pickClass(claude?.meta?.categoryClass, 'article-category'),
          readMoreClass: pickClass(claude?.meta?.readMoreClass, 'article-read-more'),
        },
      };
      return { tpl, extracted, totalTrackable: CATALOG_TOTAL };
    };

    // Run scrape for one URL via forgeScrape (Bright Data Web Unlocker),
    // then hand the rendered HTML to Claude for structural extraction.
    const runScrape = async (url, type) => {
      const fetched = await forgeScrape(url, {
        caller: type === 'article' ? 'site-template-article' : 'site-template-catalog',
        metadata: { brandProfileId },
      });

      if (!fetched.success || !fetched.html) {
        console.warn(`[SCRAPE-TEMPLATE] forgeScrape failed for ${url}: ${fetched.error}`);
        return { tpl: null, extracted: 0, totalTrackable: type === 'article' ? ARTICLE_TOTAL : CATALOG_TOTAL, source: fetched.source };
      }

      try {
        const claude = type === 'article' ? await claudeExtractArticle(fetched.html) : await claudeExtractCatalog(fetched.html);
        const built = type === 'article' ? buildArticleTemplate(claude, url) : buildCatalogTemplate(claude, url);
        return { ...built, source: fetched.source };
      } catch (e) {
        console.warn(`[SCRAPE-TEMPLATE] Claude extraction failed for ${url}: ${e.message}`);
        // Honest failure: don't fabricate a "successful" template from
        // hardcoded defaults if Claude couldn't read the HTML at all.
        return { tpl: null, extracted: 0, totalTrackable: type === 'article' ? ARTICLE_TOTAL : CATALOG_TOTAL, source: fetched.source };
      }
    };

    const article = await runScrape(articleUrl, 'article');
    const catalog = catalogUrl ? await runScrape(catalogUrl, 'catalog') : null;

    if (!article.tpl || article.extracted < MIN_ARTICLE_EXTRACTED) {
      console.log(`[SCRAPE-TEMPLATE] insufficient extraction (claude): ${article.extracted}/${article.totalTrackable} from ${article.source || 'no source'} for ${articleUrl}`);
      return res.json({
        success: false,
        error: 'template_extraction_insufficient',
        warning: `Couldn't locate article structure in ${articleUrl}${article.source ? ` (read via ${article.source})` : ''}: only ${article.extracted} of ${article.totalTrackable} regions found. Likely causes: the page didn't fully render before we captured it, or this isn't a standard article layout. Smart Export will fall back to generic semantic HTML.`,
        extracted: { article: article.extracted, articleTotal: article.totalTrackable, source: article.source },
      });
    }

    const existing = await pool.query('SELECT settings FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const currentSettings = existing.rows[0]?.settings || {};
    const newSettings = {
      ...currentSettings,
      siteTemplate: {
        article: article.tpl,
        catalog: catalog?.tpl || null,
        lastScrapedAt: new Date().toISOString(),
        extraction: {
          article: { extracted: article.extracted, total: article.totalTrackable, source: article.source, engine: 'claude' },
          catalog: catalog ? { extracted: catalog.extracted, total: catalog.totalTrackable, source: catalog.source, engine: 'claude' } : null,
        },
      },
    };

    await pool.query(
      'UPDATE brand_profiles SET settings = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(newSettings), brandProfileId]
    );

    console.log(`[SCRAPE-TEMPLATE] OK (claude): article ${article.extracted}/${article.totalTrackable} via ${article.source}${catalog ? `, catalog ${catalog.extracted}/${catalog.totalTrackable} via ${catalog.source}` : ''}`);
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

// POST /api/campaign/:id/archive — bulk archive an entire campaign
// Refuses unless every queue item in the campaign is status='published'.
app.post('/api/campaign/:id/archive', requireAuth, async (req, res) => {
  try {
    const campaignId = req.params.id;

    // Fetch campaign + its queue items
    const campRes = await pool.query('SELECT id, brand_profile_id, name, status FROM campaigns WHERE id = $1', [campaignId]);
    if (!campRes.rows.length) return res.status(404).json({ success: false, error: 'Campaign not found' });
    const camp = campRes.rows[0];

    if (!(await verifyBrandAccess(camp.brand_profile_id, req.userId))) return res.status(403).json({ error: 'Access denied' });

    const itemsRes = await pool.query(
      `SELECT id, status, publish_results FROM publishing_queue WHERE campaign_id = $1`,
      [campaignId]
    );
    const items = itemsRes.rows;
    if (items.length === 0) return res.status(400).json({ success: false, error: 'Campaign has no queue items' });

    // "Published enough to archive" = has at least one non-meta key in publish_results.
    // The status field alone is unreliable: 'partial' means some channels failed but the
    // article still went out somewhere, and Brian wants those archive-able. Items already
    // 'archived' are skipped (they're effectively done from the campaign's perspective).
    const hasResults = (pr) => pr && typeof pr === 'object' &&
      Object.keys(pr).filter(k => !k.startsWith('__')).length > 0;
    const blockers = items.filter(i => i.status !== 'archived' && !hasResults(i.publish_results));
    if (blockers.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot archive: ${blockers.length} of ${items.length} articles have no publish results yet`,
        unpublishedCount: blockers.length,
        totalCount: items.length
      });
    }

    // All clear — archive non-archived items + mark campaign archived
    const updRes = await pool.query(
      `UPDATE publishing_queue SET status = 'archived', updated_at = NOW()
       WHERE campaign_id = $1 AND status != 'archived'
       RETURNING id`,
      [campaignId]
    );
    await pool.query(
      `UPDATE campaigns SET status = 'archived', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    res.json({ success: true, archivedCount: updRes.rowCount, campaignName: camp.name });
  } catch(e) {
    console.error('[CAMPAIGN-ARCHIVE]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/campaign/:id/unarchive — restore an archived campaign
// Items go back to status='published' (since archive only allowed when all were published).
app.post('/api/campaign/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const campaignId = req.params.id;

    const campRes = await pool.query('SELECT id, brand_profile_id, name FROM campaigns WHERE id = $1', [campaignId]);
    if (!campRes.rows.length) return res.status(404).json({ success: false, error: 'Campaign not found' });
    const camp = campRes.rows[0];

    if (!(await verifyBrandAccess(camp.brand_profile_id, req.userId))) return res.status(403).json({ error: 'Access denied' });

    const upd = await pool.query(
      `UPDATE publishing_queue SET status = 'published', updated_at = NOW()
       WHERE campaign_id = $1 AND status = 'archived'
       RETURNING id`,
      [campaignId]
    );
    await pool.query(
      `UPDATE campaigns SET status = 'complete', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    res.json({ success: true, restoredCount: upd.rowCount, campaignName: camp.name });
  } catch(e) {
    console.error('[CAMPAIGN-UNARCHIVE]', e);
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
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
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
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
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

    // ── SCORING ALGORITHM (v2: citation-predictive rebalance) ──
    // Citation predictors now account for ~45/100, brand fidelity ~50/100, history 5/100.
    // Empirically: articles that score high on the new dimensions get cited; articles
    // that score high only on brand-fidelity dimensions look like prior content but
    // don't get pulled by AI engines because they don't add new structure to the
    // citation graph (no definitional language, no external authority, no worksheet).
    let score = 35; // Base (was 50; rebalanced down to make room for citation dims)
    const breakdown = {};

    // Pre-compute reusable text views.
    const title = content.title || '';
    const titleLower = title.toLowerCase();
    const bodyText = sections.map(s => (s.body || s.content || '').toLowerCase()).join(' ');
    const bodyTextRaw = sections.map(s => s.body || s.content || '').join('\n\n');

    // Pull positioning classification + strategic_injection geo_opportunities once.
    let positioningPatterns = [];
    let strategicInjectionTopics = [];
    try {
      const pcRes = await pool.query(`
        SELECT pattern_type, description
        FROM brain_patterns
        WHERE brand_profile_id = $1 AND pattern_type = 'positioning_classification'
      `, [brandProfileId]);
      positioningPatterns = pcRes.rows;
    } catch(e) { /* best-effort */ }
    try {
      // Match on topic OR derived keywords from intent_signals.
      const goRes = await pool.query(`
        SELECT topic, intent_signals->>'source' as source, intent_signals->>'deliverable' as deliverable, avg_score
        FROM geo_opportunities
        WHERE brand_profile_id = $1 AND intent_signals->>'source' LIKE 'strategic_injection%'
      `, [brandProfileId]);
      strategicInjectionTopics = goRes.rows;
    } catch(e) { /* best-effort */ }

    // ───── A. Structure (0-10, was 0-15) ─────
    const wordCount = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
    const sectionCount = sections.length;
    const hasHeadings = sections.filter(s => s.heading).length;

    let structureScore = 0;
    if (wordCount >= 800 && wordCount <= 2500) structureScore += 4;  // wider range; citable longform allowed
    else if (wordCount >= 500 && wordCount <= 3000) structureScore += 2;
    if (sectionCount >= 3 && sectionCount <= 10) structureScore += 3;  // wider; references/FAQ sections OK
    else if (sectionCount >= 2) structureScore += 1;
    if (hasHeadings >= 3) structureScore += 3;
    else if (hasHeadings >= 1) structureScore += 1;

    breakdown.structure = { score: structureScore, max: 10, wordCount, sectionCount, hasHeadings };
    score += structureScore;

    // ───── B. Title (0-10, was 0-15) ─────
    let titleScore = 0;
    if (title.length >= 30 && title.length <= 80) titleScore += 3;  // wider range allowed
    if (/\d/.test(title)) titleScore += 2;
    if (/how|why|what|guide|tips|secrets|mistakes/i.test(title)) titleScore += 3;
    if (!/\?$/.test(title) && title.length > 0) titleScore += 2;

    breakdown.title = { score: titleScore, max: 10, length: title.length };
    score += titleScore;

    // ───── C. Pattern Match (0-15, was 0-20) ─────
    let patternScore = 0;
    const matchedPatterns = [];

    for (const p of patterns) {
      const desc = (p.description || '').toLowerCase();
      const keywords = desc.split(' ').filter(w => w.length > 4).slice(0, 5);
      const matches = keywords.filter(k => titleLower.includes(k) || bodyText.includes(k));
      if (matches.length >= 2) {
        patternScore += Math.min(3, (p.success_rate || 0.5) * 4);
        matchedPatterns.push({ type: p.pattern_type, confidence: p.confidence_score });
      }
    }
    patternScore = Math.min(15, patternScore);
    breakdown.patternMatch = { score: patternScore, max: 15, matchedPatterns };
    score += patternScore;

    // ───── D. Anti-pattern Penalty (-10 to 0, unchanged) ─────
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

    // ───── E. History (0-5, was 0-10) ─────
    let historyScore = 0;
    if (stats.total_posts > 0) {
      if (stats.total_posts >= 20) historyScore += 3;
      else if (stats.total_posts >= 10) historyScore += 2;
      else if (stats.total_posts >= 5) historyScore += 1;
      if (stats.avg_engagement > 0.03) historyScore += 2;
      else if (stats.avg_engagement > 0.01) historyScore += 1;
    }
    breakdown.history = {
      score: historyScore,
      max: 5,
      totalPosts: parseInt(stats.total_posts) || 0,
      avgEngagement: parseFloat(stats.avg_engagement) || 0,
      avgImpressions: parseInt(stats.avg_impressions) || 0
    };
    score += historyScore;

    // ───── F. NEW: Category-Defining Language (0-10) ─────
    // Articles that define a coined term get cited as the source of record.
    // Heuristic: title contains a Forge OWNED concept (from positioning_classification),
    // body contains a definitional construction ("X is...", "X means..."), or title
    // uses category-creation language like "is not" / "vs" / "the difference between".
    let categoryDefiningScore = 0;
    const ownedTerms = [];
    const contestedTerms = [];
    for (const p of positioningPatterns) {
      // Storage format: 'OWNED — TERM: OWNED. ...' or 'CONTESTED — TERM: CONTESTED. ...'
      // Capture term between the verdict prefix and the first colon.
      const m = (p.description || '').match(/^(OWNED|CONTESTED)\s*[—\-]\s*([^:]+):/i);
      if (m) {
        const term = m[2].trim().toLowerCase();
        if (m[1].toUpperCase() === 'OWNED') ownedTerms.push(term);
        else contestedTerms.push(term);
      }
    }
    const ownedInTitle = ownedTerms.filter(t => titleLower.includes(t));
    if (ownedInTitle.length > 0) categoryDefiningScore += 5;
    // Definitional construction in body
    const definitionalRx = /\b(is not|vs\.?|versus|the difference between|defined as|means that|refers to)\b/i;
    if (definitionalRx.test(title)) categoryDefiningScore += 3;
    if (/^[A-Z][^.!?]*\b(is|means|refers to)\b/m.test(bodyTextRaw.slice(0, 500))) categoryDefiningScore += 2;
    categoryDefiningScore = Math.min(10, categoryDefiningScore);
    breakdown.categoryDefining = {
      score: categoryDefiningScore,
      max: 10,
      ownedTermsInTitle: ownedInTitle,
      hasDefinitionalLanguage: definitionalRx.test(title)
    };
    score += categoryDefiningScore;

    // ───── G. NEW: External Authoritative Citations (0-8) ─────
    // Articles that cite real external sources get pulled into citation graphs.
    // Heuristic: count markdown links AND footnote markers AND raw URLs in body.
    const mdLinkCount = (bodyTextRaw.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g) || []).length;
    const footnoteRefCount = (bodyTextRaw.match(/\[\^\d+\]/g) || []).length;
    const rawUrlCount = (bodyTextRaw.match(/https?:\/\/[^\s)]+/g) || []).length;
    const externalCitations = mdLinkCount + Math.min(footnoteRefCount, rawUrlCount); // approx unique sources
    let externalCitationsScore = 0;
    if (externalCitations >= 3) externalCitationsScore = 8;
    else if (externalCitations >= 2) externalCitationsScore = 6;
    else if (externalCitations >= 1) externalCitationsScore = 3;
    breakdown.externalCitations = {
      score: externalCitationsScore,
      max: 8,
      mdLinkCount,
      footnoteRefCount,
      rawUrlCount,
      estimatedSources: externalCitations
    };
    score += externalCitationsScore;

    // ───── H. NEW: Worksheet/Checklist Sections (0-7) ─────
    // Numbered lists, decision trees, evaluation frameworks get pulled verbatim
    // by AI engines for "how do I X" queries. Bonus for ≥3 list items in any one section.
    let worksheetScore = 0;
    const hasNumberedList = /^(\d+\.|\*\*\d|##\s*\d|\d\)\s)/m;
    const hasChecklistMarker = /^\s*[-*]\s+\[\s*[xX ]\s*\]/m;
    let worksheetSections = 0;
    for (const s of sections) {
      const body = s.body || s.content || '';
      if (hasNumberedList.test(body) && body.split('\n').filter(l => /^\d+\.\s|^\*\*\d/.test(l)).length >= 3) {
        worksheetSections += 1;
      } else if (hasChecklistMarker.test(body)) {
        worksheetSections += 1;
      }
    }
    if (worksheetSections >= 2) worksheetScore = 7;
    else if (worksheetSections === 1) worksheetScore = 5;
    breakdown.worksheetSections = {
      score: worksheetScore,
      max: 7,
      sectionsWithLists: worksheetSections
    };
    score += worksheetScore;

    // ───── I. NEW: OWNED vs CONTESTED Term Alignment (0-8) ─────
    // Articles that use OWNED terms outright AND avoid bare CONTESTED claims
    // (or reframe them with disambiguation) align with the brain's positioning
    // strategy. CONTESTED terms used without reframe = penalty (Averi/Tofu/Jasper
    // also use those terms; engines get confused which brand owns them).
    let ownedAlignmentScore = 0;
    const ownedInBody = ownedTerms.filter(t => bodyText.includes(t));
    const contestedInBody = contestedTerms.filter(t => bodyText.includes(t));
    // Owned coverage: percent of owned terms that appear in body (max 5)
    if (ownedTerms.length > 0) {
      const ownedCoverage = ownedInBody.length / ownedTerms.length;
      ownedAlignmentScore += Math.round(ownedCoverage * 5);
    }
    // Contested handling: if contested term appears, look for disambiguation language
    // within ~120 chars of it (e.g. "not just X but Y", "different from X").
    let contestedReframed = 0;
    for (const t of contestedInBody) {
      const idx = bodyText.indexOf(t);
      const window = bodyText.slice(Math.max(0, idx - 60), Math.min(bodyText.length, idx + t.length + 120));
      if (/\b(not|different|vs\.?|versus|isn't|is not|unlike|beyond|more than)\b/i.test(window)) {
        contestedReframed += 1;
      }
    }
    if (contestedInBody.length === 0) ownedAlignmentScore += 3;  // clean
    else if (contestedReframed === contestedInBody.length) ownedAlignmentScore += 3;  // all reframed
    else if (contestedReframed > 0) ownedAlignmentScore += 1;  // partial
    // else +0 — contested terms used as if owned, hurts citation clarity
    ownedAlignmentScore = Math.min(8, ownedAlignmentScore);
    breakdown.ownedTermAlignment = {
      score: ownedAlignmentScore,
      max: 8,
      ownedTermsUsed: ownedInBody,
      contestedTermsPresent: contestedInBody,
      contestedReframed
    };
    score += ownedAlignmentScore;

    // ───── J. NEW: Strategic Geo Opportunity Match (0-7) ─────
    // Articles aligned with strategic_injection geo_opportunities are betting on
    // verified whitespace. Articles on auto-discovered topics may overlap with
    // existing competitor coverage.
    // Match geo_opportunity to article. Tighter than v2.0: need a high-density overlap
    // (>=50% of opportunity's distinctive keywords) AND >=3 absolute matches. This stops
    // generic terms like 'ai content' from matching every article to a random opportunity.
    const STOPWORDS = new Set(['about','after','again','against','also','because','being','between','could','during','every','first','from','having','their','these','those','through','under','until','what','when','where','which','while','with','your','this','that','than','they','them','have','will','just','more','only','some','such','make','than','then','here','into','like','over','many','must','same','should']);
    let geoOppScore = 0;
    let matchedOpportunity = null;
    let bestMatch = { count: 0, density: 0 };
    for (const opp of strategicInjectionTopics) {
      const oppTopic = (opp.topic || '').toLowerCase();
      const oppKeywords = oppTopic.split(/\W+/).filter(w => w.length > 4 && !STOPWORDS.has(w));
      if (oppKeywords.length === 0) continue;
      const matches = oppKeywords.filter(k => titleLower.includes(k));
      const density = matches.length / oppKeywords.length;
      if (matches.length >= 3 && density >= 0.5 && (matches.length > bestMatch.count || density > bestMatch.density)) {
        bestMatch = { count: matches.length, density };
        const isPillar = (opp.deliverable || '').includes('pillar');
        geoOppScore = isPillar ? 7 : 5;
        matchedOpportunity = { topic: opp.topic, deliverable: opp.deliverable, source: opp.source, matchCount: matches.length, density: density.toFixed(2) };
      }
    }
    breakdown.geoOpportunityMatch = {
      score: geoOppScore,
      max: 7,
      matchedOpportunity
    };
    score += geoOppScore;

    // ───── K. NEW: Whitespace Freshness (0-5) ─────
    // Best-effort signal: if no other Forge article on this topic exists in the
    // last 90 days AND the brain has flagged it as "fresh whitespace" via
    // strategic_injection, give a small bonus. This is a cheap proxy for the
    // expensive Sonar live-check we'd ideally do per article.
    let whitespaceScore = 0;
    try {
      const dupRes = await pool.query(`
        SELECT COUNT(*) as cnt FROM ${contentTable}
        WHERE id != $1
          AND created_at > NOW() - INTERVAL '90 days'
          AND title ILIKE '%' || $2 || '%'
      `, [contentId, ownedInTitle[0] || title.split(' ').slice(0, 3).join(' ')]);
      const dupCount = parseInt(dupRes.rows[0]?.cnt || 0);
      if (dupCount === 0 && matchedOpportunity) whitespaceScore = 5;
      else if (dupCount === 0) whitespaceScore = 3;
      else if (dupCount === 1) whitespaceScore = 1;
    } catch(e) { /* best-effort */ }
    breakdown.whitespaceFreshness = {
      score: whitespaceScore,
      max: 5
    };
    score += whitespaceScore;

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

// POST /api/domain/check — pre-scan claim check for Landing page
// Returns { claimed: boolean, reason: string, ownedByUser: bool, reservedBySession: bool }
// Logic:
//   1. If no active brand_profile exists for the URL OR it's expired → not claimed (fair game)
//   2. If the row has a clerk_user_id (paid user owns it) → claimed, must sign in
//   3. If the row has only onboard_session_id AND it matches caller's sessionId → not claimed (your own scan)
//   4. If onboard_session_id differs AND expires_at > NOW() → claimed (24h reservation by another scanner)
app.post('/api/domain/check', async (req, res) => {
  const { url, sessionId } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const brandUrl = url.startsWith('http') ? url : `https://${url}`;
  try {
    const r = await pool.query(
      `SELECT id, clerk_user_id, onboard_session_id, expires_at, brand_name
       FROM brand_profiles
       WHERE brand_url = $1 AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY version DESC LIMIT 1`,
      [brandUrl]
    );
    if (!r.rows.length) {
      return res.json({ claimed: false, reason: 'not_scanned' });
    }
    const row = r.rows[0];
    if (row.clerk_user_id) {
      return res.json({
        claimed: true,
        ownedByUser: true,
        reason: 'owned_by_account',
        message: 'This domain is already claimed by an active Forge account. If this is your brand, sign in to access it. If you believe this is an error, contact hello@forgeintelligence.ai with proof of domain ownership.'
      });
    }
    if (row.onboard_session_id && sessionId && row.onboard_session_id === sessionId) {
      return res.json({ claimed: false, reason: 'your_own_scan', brandId: row.id });
    }
    if (row.onboard_session_id && row.expires_at) {
      const expiresAt = new Date(row.expires_at);
      const hoursRemaining = Math.max(0, Math.round((expiresAt - new Date()) / 36e5));
      return res.json({
        claimed: true,
        reservedBySession: true,
        reason: 'reserved_by_other_session',
        hoursRemaining,
        message: `Someone else scanned this domain in the past 24 hours and has ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'} to claim it. After that the reservation expires and you can scan it. If you believe this is an error (e.g. you own this domain), contact hello@forgeintelligence.ai to dispute.`
      });
    }
    // No clerk_user_id, no matching session, no other session — conservative: treat as not claimed
    return res.json({ claimed: false, reason: 'no_owner_or_session' });
  } catch (e) {
    console.error('[DOMAIN-CHECK]', e.message);
    return res.status(500).json({ error: 'check failed', claimed: false });
  }
});

// ── Quick Start: synthesize a brand profile from a Founder Brief ──────────
// Used when the founder has no marketing website (typical Lovable / vibe-coding
// audience). We skip Firecrawl, Sonar, and the cache check; Claude generates
// the full BrandProfile JSON from the structured Founder Brief alone.
//
// Each Quick Start gets a synthetic brand_url ("quickstart://<uuid>") so the
// `idx_bp_active_url` unique-by-active index never collides with real domains
// and so /app/context-hub re-analyze never tries to re-scrape a non-existent
// site. Anonymous-session semantics (24h expiry, onboard_session_id) match the
// URL-based flow exactly so Clerk signup can later claim these rows.
function quickStartTruncate(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.length > maxLength ? value.slice(0, maxLength).trim() + '…' : value;
}

async function handleQuickStartSynthesis(req, res) {
  const startTime = Date.now();
  try {
    const fg = req.body.factualGround || {};
    const required = ['brandName', 'whatWeDo', 'whatWeDoNot', 'competitors'];
    for (const k of required) {
      if (typeof fg[k] !== 'string' || fg[k].trim().length === 0) {
        return res.status(400).json({ success: false, error: `factualGround.${k} is required` });
      }
    }

    const brandName = fg.brandName.trim();
    const sessionId = req.body.sessionId || null;
    const syntheticBrandUrl = `quickstart://${randomUUID()}`;

    const briefLines = [
      `**Brand Name:** ${brandName}`,
      ``,
      `**What we actually do (founder's own words):**`,
      quickStartTruncate(fg.whatWeDo, 2000),
      ``,
      `**What we explicitly do NOT do (out of scope, common misconceptions):**`,
      quickStartTruncate(fg.whatWeDoNot, 2000),
      ``,
      `**Competitors / who buyers also evaluate:**`,
      quickStartTruncate(fg.competitors, 1500),
    ];
    if (fg.foundingStory && fg.foundingStory.trim()) {
      briefLines.push('', `**Founding story:**`, quickStartTruncate(fg.foundingStory, 1500));
    }
    if (fg.methodology && fg.methodology.trim()) {
      briefLines.push('', `**Methodology / approach:**`, quickStartTruncate(fg.methodology, 1500));
    }
    if (fg.teamComposition && fg.teamComposition.trim()) {
      briefLines.push('', `**Team composition:**`, quickStartTruncate(fg.teamComposition, 1000));
    }
    if (fg.quotablePositions && fg.quotablePositions.trim()) {
      briefLines.push('', `**Quotable positions / hot takes:**`, quickStartTruncate(fg.quotablePositions, 1500));
    }
    if (fg.namedAuthors && fg.namedAuthors.trim()) {
      briefLines.push('', `**Named authors (real humans to attribute):**`, quickStartTruncate(fg.namedAuthors, 800));
    }
    const founderBrief = briefLines.join('\n');

    const prompt = `You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

The following brand context was provided DIRECTLY by the founder via a Quick Start form. There is no website to scrape and no third-party signals. Generate a complete brand profile using ONLY the provided information.

CRITICAL RULES:
- Do NOT hallucinate details not present in the Founder Brief. If you don't know something, say so or omit it — never invent personas, competitors, or positioning that isn't supported by the brief.
- The "What we explicitly do NOT do" content is INTENTIONAL — those non-actions surface as strategicMoats, NOT as competitiveGaps. competitiveGaps should be derived from what the brand CAN compete on but isn't yet talking about.
- discoveredCompetitors must come from the founder's competitors list verbatim. Do not invent additional competitors.
- For visualStyle / accentColor: with no website to inspect, use conservative defaults grounded in the brand category. Mark accentColor as a descriptor like 'neutral slate' or 'deep indigo' rather than guessing a hex.

## FOUNDER BRIEF

${founderBrief}

Return ONLY valid JSON (no markdown, no explanation, no newlines inside string values — use spaces instead):
{
  "brandName": "${brandName.replace(/"/g, '\\"')}",
  "voiceProfile": {
    "summary": "string",
    "toneAttributes": [{ "attribute": "string", "score": 0-100, "description": "string" }],
    "writingStyle": "string",
    "keyPhrases": ["string"],
    "industry": "string",
    "positioning": "string — one tight sentence: what they do, for whom, why they win",
    "targetPersona": "string — primary buyer in plain language",
    "visualStyle": "string — conservative descriptor since there's no site to inspect",
    "accentColor": "string — descriptor like 'deep indigo' or 'neutral slate', not a guessed hex"
  },
  "personas": [{
    "id": "string", "name": "string", "role": "string",
    "painPoints": ["string"], "triggers": ["string"],
    "skepticism": "string", "motivations": ["string"]
  }],
  "thirdPartySignals": [],
  "competitiveGaps": [{ "topic": "string", "ownedBy": "string or null", "whitespaceOpportunity": "string", "priority": "high|medium|low" }],
  "strategicMoats": [{ "capability": "string — drawn directly from 'What we do NOT do'", "rationale": "string", "protects": "string" }],
  "strategicRecommendations": [{ "id": "string", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }],
  "campaignArcs": [{ "id": "string", "title": "string", "thesis": "string", "acts": [{ "actNumber": 1, "actTitle": "string", "actPremise": "string" }], "recommendedLength": "number 3-8", "targetPersona": "string" }],
  "businessProfile": {
    "whatTheyDo": "string — drawn from 'What we actually do'",
    "productsOrServices": ["string"],
    "revenueModel": "string",
    "targetBuyer": "string",
    "companyScale": "string",
    "geography": "string"
  },
  "discoveredCompetitors": ["string — verbatim from founder's competitors list"],
  "marketCategory": "string"
}
Requirements: 5 toneAttributes, 2-3 personas, 0 thirdPartySignals (no website to inspect), 3-5 competitiveGaps (real missed opportunities), 1-4 strategicMoats (one per item in 'What we do NOT do'), 4-6 strategicRecommendations, 2-4 campaignArcs, 1 businessProfile (all fields required). Ground every field in the Founder Brief.`;

    let profileData;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }]
        });
        const raw = message.content[0].text;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { lastErr = new Error('Claude returned no valid JSON'); continue; }
        try {
          profileData = safeParseLLM(jsonMatch[0], 'object', 'quick-start');
          break;
        } catch (parseErr) {
          const fixed = jsonMatch[0].replace(/:\s*"([\s\S]*?)"/g, (m, val) => ': "' + val.replace(/\n/g, ' ').replace(/\r/g, ' ') + '"');
          profileData = JSON.parse(fixed);
          break;
        }
      } catch (e) { lastErr = e; }
    }
    if (!profileData) {
      console.error('[QUICK-START] Claude synthesis failed:', lastErr?.message);
      return res.status(502).json({ success: false, error: 'Synthesis failed', details: lastErr?.message || 'Unknown error' });
    }

    // Stamp Quick Start provenance into the JSONB so downstream tooling can
    // distinguish profiles built from a Founder Brief vs. ones built from a
    // real website scan, without requiring a schema migration.
    profileData.source = 'quick-start';
    profileData.factualGround = {
      brandName,
      whatWeDo: quickStartTruncate(fg.whatWeDo, 4000),
      whatWeDoNot: quickStartTruncate(fg.whatWeDoNot, 4000),
      competitors: quickStartTruncate(fg.competitors, 2000),
      foundingStory: quickStartTruncate(fg.foundingStory || '', 4000),
      methodology: quickStartTruncate(fg.methodology || '', 3000),
      teamComposition: quickStartTruncate(fg.teamComposition || '', 2000),
      quotablePositions: quickStartTruncate(fg.quotablePositions || '', 3000),
      namedAuthors: quickStartTruncate(fg.namedAuthors || '', 1500),
      logoUrl: typeof fg.logoUrl === 'string' ? fg.logoUrl.slice(0, 500) : '',
    };

    // Build directive — what the founder is going to build on Lovable. Drives
    // the BUILD DIRECTIVE section of the prompt-pack so Lovable knows what to
    // build before it processes how the brand behaves. Optional at the
    // analyze-time level (the form gates the description; we only persist
    // what's actually present).
    const biIn = req.body.buildIntent || {};
    if (typeof biIn.description === 'string' && biIn.description.trim().length > 0) {
      const allowedProductTypes = new Set(['marketing-site', 'saas-app', 'landing-page', 'waitlist', 'internal-tool', 'not-sure']);
      const productType = (typeof biIn.productType === 'string' && allowedProductTypes.has(biIn.productType))
        ? biIn.productType
        : 'not-sure';
      profileData.buildIntent = {
        description: quickStartTruncate(biIn.description, 4000),
        productType,
      };
    }

    const id = randomUUID();
    const logoUrl = typeof fg.logoUrl === 'string' && fg.logoUrl.trim() ? fg.logoUrl.trim() : '';
    const expiresClause = req.userId ? 'NULL' : "NOW() + INTERVAL '24 hours'";
    const inserted = await pool.query(
      `INSERT INTO brand_profiles
         (id, brand_url, brand_name, version, is_active, cache_status, profile_data, logo_url, clerk_user_id, onboard_session_id, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 1, true, 'fresh', $4, $5, $6, $7, ${expiresClause}, NOW(), NOW())
       RETURNING *`,
      [id, syntheticBrandUrl, brandName, JSON.stringify(profileData), logoUrl, req.userId || null, sessionId]
    );
    const r = inserted.rows[0];
    const latencyMs = Date.now() - startTime;
    console.log(`[QUICK-START] Created brand ${r.id} for "${brandName}" in ${latencyMs}ms`);

    return res.json({
      success: true,
      cached: false,
      data: {
        id: r.id,
        brandUrl: r.brand_url,
        brandName: r.brand_name,
        version: r.version,
        isActive: r.is_active,
        cacheStatus: r.cache_status,
        latencyMs,
        discoveredCompetitors: Array.isArray(profileData.discoveredCompetitors) ? profileData.discoveredCompetitors : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        ...profileData,
      },
    });
  } catch (err) {
    console.error('[QUICK-START]', err.message);
    return res.status(500).json({ success: false, error: 'Internal error', details: err.message });
  }
}

app.post('/api/context-hub/analyze', softAuth, async (req, res) => {
  const { brandUrl, competitorUrls = [], audienceNotes = '', strategicNotes = '', checkBrainFirst = true, saveToBrain = true } = req.body;

  // ── Quick Start branch ────────────────────────────────────────────────────
  // No website to scrape — the founder gave us a structured Founder Brief
  // (factualGround) and we synthesize a profile from those fields alone.
  // Skips Firecrawl, Sonar, and cache check (each Quick Start run gets a
  // synthetic unique brand_url so it never collides with a real domain).
  if (!brandUrl && req.body.factualGround && typeof req.body.factualGround === 'object') {
    return handleQuickStartSynthesis(req, res);
  }

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
    // Claim-gate aware: only return cached data if the caller is authorized to see it.
    //   - The signed-in account that owns it (clerk_user_id match)
    //   - The anonymous session that originally scanned it (onboard_session_id match) AND within 24h window
    // Everyone else gets 409 with a human-readable message. This prevents User B from reading
    // User A's scan inside the 24h window; after 24h the row is expired and not considered active.
    if (checkBrainFirst) {
      const existing = await pool.query(
        `SELECT * FROM brand_profiles
         WHERE brand_url = $1 AND is_active = true
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const callerSessionId = req.body.sessionId || null;
        const callerUserId = req.userId || null;

        const isOwnerByAccount = r.clerk_user_id && callerUserId && r.clerk_user_id === callerUserId;
        const isOwnerBySession = r.onboard_session_id && callerSessionId && r.onboard_session_id === callerSessionId;

        if (isOwnerByAccount || isOwnerBySession) {
          await pool.query(`UPDATE brand_profiles SET cache_status = 'cached' WHERE id = $1`, [r.id]);
          console.log(`[Context Hub] Cache hit for ${brandUrl} (authorized: ${isOwnerByAccount ? 'account' : 'session'})`);
          return res.json({ success: true, cached: true, data: {
            id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
            version: r.version, isActive: r.is_active, cacheStatus: 'cached',
            createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
          }});
        }

        // Unauthorized cache hit — someone else has an active claim/reservation.
        if (r.clerk_user_id) {
          return res.status(409).json({
            success: false,
            reason: 'owned_by_account',
            message: 'This domain is already claimed by an active Forge account. If this is your brand, sign in. If you believe this is an error, contact hello@forgeintelligence.ai with proof of domain ownership.'
          });
        }
        if (r.onboard_session_id && r.expires_at) {
          const expiresAt = new Date(r.expires_at);
          const hoursRemaining = Math.max(0, Math.round((expiresAt - new Date()) / 36e5));
          return res.status(409).json({
            success: false,
            reason: 'reserved_by_other_session',
            hoursRemaining,
            message: `Someone else scanned this domain in the past 24 hours and has ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'} left to claim it. After that the reservation expires. If you believe this is an error, contact hello@forgeintelligence.ai to dispute.`
          });
        }
        // Orphan row with no owner info — treat as not claimed; let the scan proceed
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
    // Two-tier fetch per page via getBrandPageContent:
    //   Tier A: Jina Reader (semantic markdown — fast, free, the common case)
    //   Tier B: forgeScrape (BD Tier 1 → Tier 2 cascade) + local Readability+Turndown
    // Pages: homepage + up to 8 high-signal subpages discovered via sitemap.xml
    // (link-extraction fallback). All fetched in parallel; every attempt logged
    // to scrape_log with caller='context-hub'.
    console.log(`[Context Hub] Tool 1.5: Scraping website content for ${brandUrl}...`);
    let scrapedContent = '';
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
      const inputUrl = scrapeInputUrl.startsWith('http') ? scrapeInputUrl : `https://${scrapeInputUrl}`;
      const u = new URL(inputUrl);
      workingBaseUrl = `${u.protocol}//${u.host}`;

      // Fetch the homepage first so we can seed subpage discovery with its
      // already-fetched content — avoids a redundant homepage fetch inside
      // discoverSubpages on SPAs where Jina has already returned clean
      // markdown. Net latency: home fetch (~5-10s Jina, longer on Tier B)
      // then parallel subpage fan-out.
      const homeContent = await getBrandPageContent(workingBaseUrl, { caller: 'context-hub' });

      const subpages = await discoverSubpages(workingBaseUrl, 8, {
        seedMarkdown: homeContent?.success ? homeContent.markdown : null,
      });

      // Fan out to all discovered subpages in parallel.
      const subContents = subpages.length
        ? await Promise.all(subpages.map(pageUrl =>
            getBrandPageContent(pageUrl, { caller: 'context-hub' }).catch(err => ({ success: false, markdown: null, source: 'error', error: err?.message }))
          ))
        : [];

      // Concatenate per-page markdown (20 KB per page) into the section
      // siteContentSection consumes. Tagged by URL + source so downstream
      // Claude can attribute claims to specific pages.
      if (homeContent?.success && homeContent.markdown) {
        scrapedContent += `HOMEPAGE (${workingBaseUrl}, via ${homeContent.source}):\n${homeContent.markdown.slice(0, 20000)}\n\n`;
      } else {
        console.log(`[Context Hub] Homepage fetch failed — ${homeContent?.error || 'no detail'}`);
      }
      for (let i = 0; i < subContents.length; i++) {
        const p = subContents[i];
        if (p?.success && p.markdown) {
          scrapedContent += `PAGE (${subpages[i]}, via ${p.source}):\n${p.markdown.slice(0, 20000)}\n\n`;
        }
      }

      const okPages = (homeContent?.success ? 1 : 0) + subContents.filter(p => p?.success).length;
      console.log(`[Context Hub] Scraped ${scrapedContent.length} chars from ${okPages} page(s) (base: ${workingBaseUrl}, discovered: ${subpages.length})`);
    } catch(e) {
      console.log(`[Context Hub] Scraper error (non-fatal):`, e.message);
    }

    const scraperSuccess = scrapedContent.length > 200;
    const siteContentSection = scraperSuccess
      ? `\n\nACTUAL WEBSITE CONTENT (scraped — use this as primary source, do NOT guess from domain name):\n${scrapedContent.slice(0, 100000)}`
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
  "competitiveGaps": [{ "topic": "string — a topic where competitors own the conversation AND the brand could plausibly compete. Do NOT include topics the brand explicitly and strategically excludes (e.g., 'we don't execute projects', 'we don't take commissions', 'we don't build X') — those are moats, not gaps. A competitiveGap is a real missed opportunity, not a deliberate positioning choice.", "ownedBy": "string or null", "whitespaceOpportunity": "string", "priority": "high|medium|low" }],
  "strategicMoats": [{ "capability": "string — something the brand deliberately does NOT do, stated on their site or implied by positioning. Examples: 'Does not execute projects (planning-only layer)', 'Does not take vendor commissions', 'No long-term contracts'", "rationale": "string — why this non-action is strategically valuable to them", "protects": "string — what this moat protects: independence, pricing power, trust, speed, etc." }],
  "strategicRecommendations": [{ "id": "string", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }],
  "campaignArcs": [{ "id": "string — short kebab-case slug", "title": "string — name of the campaign series, evocative not generic", "thesis": "string — 1-2 sentence core argument of the whole series. THIS is what the brand is claiming, not a summary of what will be covered. Should be provocative, ownable, and tied to the brand's real point-of-view.", "acts": [{ "actNumber": 1, "actTitle": "string", "actPremise": "string — what this act establishes, proves, or resolves in the narrative" }], "recommendedLength": "number — how many distinct acts you think this arc needs (3-8). Campaign Generator will expand this into an 8-article scheduler-compatible series regardless of act count.", "targetPersona": "string — which of the brand's personas this arc is primarily aimed at" }],
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
Requirements: 5 toneAttributes, 2-3 personas, 4-6 thirdPartySignals, 3-5 competitiveGaps (ACTUAL missed opportunities, not strategic non-choices), 0-4 strategicMoats (include only if the brand explicitly states what they don't do as a strategy — some brands won't have any), 4-6 strategicRecommendations, 2-4 campaignArcs (each is a narrative series the brand could publish; focus on storylines that prove a thesis, challenge industry conventions, or crystallize the brand's worldview — not topic lists. Think of each arc as a season of television: a single argument told across multiple acts with payoff in the final act), 1 businessProfile (all fields required). Use the ICP and market context provided to make personas and gaps highly specific. For visualStyle and accentColor: infer carefully from the brand website design, color palette, imagery, and overall aesthetic — these feed directly into AI hero image generation and must reflect the real brand identity. For industry, positioning, and targetPersona: be specific and commercially precise, not generic.`;

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

    // ── Stamp server-side time on every signal ────────────────────────────
    // The schema asks the LLM for a 'lastChecked' ISO8601 date per signal, but
    // the LLM has no current-date awareness and routinely hallucinates dates
    // 6-18 months in the past (matching its training-data prior). Override
    // every signal's lastChecked with the actual scan time. Server clock is
    // the only source of truth here — never trust LLM-supplied timestamps for
    // anything user-facing or audit-relevant.
    if (Array.isArray(profileData.thirdPartySignals)) {
      const nowIso = new Date().toISOString();
      profileData.thirdPartySignals = profileData.thirdPartySignals.map(sig => ({
        ...sig,
        lastChecked: nowIso
      }));
    }

    if (saveToBrain) {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const resolvedBrandName = (profileData.brandName && !uuidPattern.test(profileData.brandName))
        ? profileData.brandName : brandName;

      // Check if brand already exists — UPDATE in place to preserve UUID and all content references
      const existing = await pool.query(
        `SELECT id, version, profile_data FROM brand_profiles WHERE brand_url = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );

      let r;
      if (existing.rows.length > 0) {
        // UPDATE existing — preserves UUID, content tables, queue, analytics, brain data
        const ex = existing.rows[0];

        // ── Preserve customer-managed fields across rescan ───────────────────────
        // The rescan synthesizes a fresh profileData from scratch, but customers may
        // have manually corrected fields (wrong persona, missed competitor, brand
        // domain quirk) or the founder may have stamped strategic_injections. Without
        // preservation every rescan wipes those edits — a trust killer that makes
        // customers afraid to rerun their own brain.
        //
        // Two-tier preservation:
        //   1) `strategic_injections`: append-only log, copied verbatim
        //   2) `manual_overrides`: JSONB whose top-level keys overwrite the
        //      synthesized fields. Example:
        //        {"discoveredCompetitors": [...corrected list...]}
        //      lets a customer permanently override what Context Hub re-derives.
        const oldProfile = ex.profile_data || {};
        const preservedKeys = [];
        if (oldProfile.strategic_injections) {
          profileData.strategic_injections = oldProfile.strategic_injections;
          preservedKeys.push('strategic_injections');
        }
        if (oldProfile.manual_overrides && typeof oldProfile.manual_overrides === 'object') {
          profileData.manual_overrides = oldProfile.manual_overrides;
          for (const [k, v] of Object.entries(oldProfile.manual_overrides)) {
            if (k === 'manual_overrides' || k === 'strategic_injections') continue;
            profileData[k] = v;
          }
          preservedKeys.push(`manual_overrides(${Object.keys(oldProfile.manual_overrides).length})`);
        }

        const updated = await pool.query(
          `UPDATE brand_profiles SET profile_data = $1, brand_name = $2, version = $3, cache_status = 'fresh', updated_at = NOW()
           WHERE id = $4 RETURNING *`,
          [JSON.stringify(profileData), resolvedBrandName, ex.version + 1, ex.id]
        );
        r = updated.rows[0];
        const preservedNote = preservedKeys.length ? ` [preserved: ${preservedKeys.join(', ')}]` : '';
        console.log(`[Context Hub] Updated existing brand ${r.id} to v${r.version}${preservedNote}`);
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
    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage1_context_agent', null, 'success', (message?.usage?.input_tokens||0)+(message?.usage?.output_tokens||0), Date.now()-startTime]).catch(()=>{});
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

// PATCH /api/email-campaign/email/:id
// Update an individual email within a campaign. Brand-scoped via campaign join.
// Allowed fields: body, ps, cta_text, cta_url_placeholder, subject_lines.
app.patch('/api/email-campaign/email/:id', requireAuth, async (req, res) => {
  const { body, ps, cta_text, cta_url_placeholder, subject_lines } = req.body || {};

  const fieldsProvided = [body, ps, cta_text, cta_url_placeholder, subject_lines].some(v => v !== undefined);
  if (!fieldsProvided) return res.status(400).json({ error: 'No editable fields provided' });

  try {
    const check = await pool.query(
      `SELECT e.id, c.brand_profile_id
         FROM email_campaign_emails e
         JOIN email_campaigns c ON c.id = e.campaign_id
        WHERE e.id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Email not found' });

    // Build dynamic UPDATE only for provided fields
    const sets = [];
    const vals = [];
    let i = 1;
    if (body !== undefined)                  { sets.push(`body = $${i++}`);                vals.push(body); }
    if (ps !== undefined)                    { sets.push(`ps = $${i++}`);                  vals.push(ps || null); }
    if (cta_text !== undefined)              { sets.push(`cta_text = $${i++}`);            vals.push(cta_text); }
    if (cta_url_placeholder !== undefined)   { sets.push(`cta_url_placeholder = $${i++}`); vals.push(cta_url_placeholder); }
    if (subject_lines !== undefined)         { sets.push(`subject_lines = $${i++}`);       vals.push(JSON.stringify(subject_lines)); }
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);

    const upd = await pool.query(
      `UPDATE email_campaign_emails SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    res.json({ success: true, email: upd.rows[0] });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] PATCH email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-campaign/email/:id/resolve-flag
// Mark a flag resolved with action: 'edited' | 'cited' | 'dismissed'.
// Resolution stored in flag_resolutions JSONB keyed by flag index. The
// flag itself stays in flags array — UI uses resolution to show
// strikethrough + status badge, preserving audit trail.
app.post('/api/email-campaign/email/:id/resolve-flag', requireAuth, async (req, res) => {
  const { flagIndex, action, citationUrl, dismissReason } = req.body || {};
  if (typeof flagIndex !== 'number') return res.status(400).json({ error: 'flagIndex (number) required' });
  if (!['edited', 'cited', 'dismissed'].includes(action)) return res.status(400).json({ error: 'action must be edited|cited|dismissed' });
  if (action === 'cited' && !citationUrl) return res.status(400).json({ error: 'citationUrl required for action=cited' });
  if (action === 'dismissed' && !dismissReason) return res.status(400).json({ error: 'dismissReason required for action=dismissed' });

  try {
    const resolution = {
      action,
      resolvedAt: new Date().toISOString(),
      ...(citationUrl && { citationUrl }),
      ...(dismissReason && { dismissReason })
    };

    const result = await pool.query(
      `UPDATE email_campaign_emails
          SET flag_resolutions = COALESCE(flag_resolutions, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb),
              updated_at = NOW()
        WHERE id = $3
        RETURNING flag_resolutions`,
      [String(flagIndex), JSON.stringify(resolution), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Email not found' });
    res.json({ success: true, flag_resolutions: result.rows[0].flag_resolutions });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] resolve-flag error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-campaign/email/:id/dismiss-flag-as-false-positive
// Same as resolve-flag with action='dismissed', but ALSO writes a brain_mistakes
// row so future Compliance Gate runs learn this pattern is a false-positive
// for the brand. Closes the feedback loop on AI-generated flags.
app.post('/api/email-campaign/email/:id/dismiss-flag-as-false-positive', requireAuth, async (req, res) => {
  const { flagIndex, reason } = req.body || {};
  if (typeof flagIndex !== 'number') return res.status(400).json({ error: 'flagIndex (number) required' });
  if (!reason || reason.length < 10) return res.status(400).json({ error: 'reason (min 10 chars) required' });

  try {
    const check = await pool.query(
      `SELECT e.flags, c.brand_profile_id
         FROM email_campaign_emails e
         JOIN email_campaigns c ON c.id = e.campaign_id
        WHERE e.id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Email not found' });

    const flags = check.rows[0].flags || [];
    const flag = flags[flagIndex];
    if (!flag) return res.status(400).json({ error: `flagIndex ${flagIndex} not found in flags` });

    const resolution = {
      action: 'dismissed',
      resolvedAt: new Date().toISOString(),
      dismissReason: reason,
      flagType: flag.type,
      flagDetail: flag.detail,
      writtenToBrainMistakes: true
    };
    await pool.query(
      `UPDATE email_campaign_emails
          SET flag_resolutions = COALESCE(flag_resolutions, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb),
              updated_at = NOW()
        WHERE id = $3`,
      [String(flagIndex), JSON.stringify(resolution), req.params.id]
    );

    await pool.query(
      `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity, created_at)
       VALUES ($1, $2, $3, $4, 'medium', NOW())`,
      [
        check.rows[0].brand_profile_id,
        `compliance_false_positive:${flag.type}`,
        `Compliance Gate flagged: "${flag.detail}". User dismissed as false positive.`,
        `False positive: ${reason.slice(0, 500)}. Do NOT flag similar content in future critiques for this brand.`
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[EMAIL CAMPAIGN] dismiss-flag-as-false-positive error:', err.message);
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

// ── Date-grounding for LLM prompts ─────────────────────────────────────
// Every prompt that generates user-facing content MUST prepend this block.
// Without it the model defaults to its training-data prior (heavily 2024-2025)
// and will write 'in 2025' / '2024 trends' even when it's actually 2026.
// Returns a multi-line string to splice into prompts: "TODAY IS Saturday, April 25, 2026..."
function dateContext() {
  const now = new Date();
  const formatted = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
  const isoDate = now.toISOString().slice(0, 10);
  const year = now.getFullYear();
  return `TODAY IS ${formatted} (ISO: ${isoDate}). The current year is ${year}. ` +
    `When you reference dates, time periods, or 'recent' events, anchor them to this date — ` +
    `do not assume an earlier year. If you write phrases like 'in ${year - 1}' or 'this year', ` +
    `they must be accurate against ${year}, not your training cutoff.`;
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

    // ── Factual Ground + Strategic Moats injection ───────────────────────────
    // GEO Strategist previously read only Context Hub's profile_data. That meant user-saved
    // corrections (what they actually do, deliberate non-choices, verified competitors) didn't
    // influence topic discovery. Topics that contradicted the brand's own stated positioning
    // could surface as "opportunities" — wasting downstream work. Load both here so Tool 1
    // (Topical Authority Mapper) can respect them.
    const factualGround = profile.settings?.factualGround || null;
    const strategicMoats = Array.isArray(pd.strategicMoats) ? pd.strategicMoats : [];
    const factualGroundBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\nUSER-VERIFIED FACTS (authoritative — topics must not contradict these):
${factualGround.whatWeDo ? `- What this brand does: ${String(factualGround.whatWeDo).slice(0, 400)}\n` : ''}${factualGround.whatWeDontDo ? `- What this brand does NOT do: ${String(factualGround.whatWeDontDo).slice(0, 400)}\n` : ''}${factualGround.competitors?.length ? `- Verified competitors (use these, ignore Context Hub's discoveries if they conflict): ${(Array.isArray(factualGround.competitors) ? factualGround.competitors : [factualGround.competitors]).slice(0, 8).join(', ')}\n` : ''}${factualGround.methodology ? `- Methodology/frameworks: ${String(factualGround.methodology).slice(0, 300)}\n` : ''}`
      : '';
    const strategicMoatsBlock = strategicMoats.length
      ? `\nSTRATEGIC MOATS (things the brand deliberately does NOT do — do NOT suggest topics in these areas, they are intentional exclusions, not gaps):
${strategicMoats.map(m => `- ${m.capability}${m.rationale ? ` (${String(m.rationale).slice(0, 120)})` : ''}`).join('\n')}`
      : '';

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
${topicFocus ? 'FOCUS: ' + topicFocus : ''}${factualGroundBlock}${strategicMoatsBlock}

Identify 8-12 topical gaps where this brand has low AI citation probability vs competitors. Topics must be consistent with the USER-VERIFIED FACTS above and must NOT fall inside the STRATEGIC MOATS (those are intentional exclusions, not opportunities).

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
TOP GEO OPPORTUNITIES: ${JSON.stringify(geoOpportunities.slice(0, 8))}${factualGround?.competitors?.length ? `\nVERIFIED COMPETITORS (use these, do not include entities from different companies with similar names): ${(Array.isArray(factualGround.competitors) ? factualGround.competitors : [factualGround.competitors]).slice(0, 8).join(', ')}` : ''}

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

      // Ignore propagation — if the user has already dismissed a very similar topic,
      // don't resurface it under a near-duplicate name. Checks for:
      //  (1) any previously-ignored topic whose trigram similarity ≥ 0.55 to this one, OR
      //  (2) any previously-ignored topic that contains / is contained in this one (substring).
      // If found, insert with status='ignored' so the user's prior decision propagates.
      let inheritedStatus = 'discovered';
      try {
        const dupRes = await pool.query(
          `SELECT id, topic FROM geo_opportunities
           WHERE brand_profile_id = $1
             AND status = 'ignored'
             AND (LOWER(topic) = LOWER($2)
                  OR LOWER(topic) LIKE '%' || LOWER($2) || '%'
                  OR LOWER($2) LIKE '%' || LOWER(topic) || '%'
                  OR similarity(LOWER(topic), LOWER($2)) >= 0.55)
           LIMIT 1`,
          [brandProfileId, opp.topic]
        );
        if (dupRes.rows.length > 0) {
          inheritedStatus = 'ignored';
          console.log(`[GEO] ignore-propagate: "${opp.topic}" inherits ignored from "${dupRes.rows[0].topic}"`);
        }
      } catch(e) {
        // pg_trgm extension may not be installed — fall back to substring-only check
        if (e.message && e.message.includes('similarity')) {
          try {
            const fbRes = await pool.query(
              `SELECT id, topic FROM geo_opportunities
               WHERE brand_profile_id = $1 AND status = 'ignored'
                 AND (LOWER(topic) = LOWER($2)
                      OR LOWER(topic) LIKE '%' || LOWER($2) || '%'
                      OR LOWER($2) LIKE '%' || LOWER(topic) || '%')
               LIMIT 1`,
              [brandProfileId, opp.topic]
            );
            if (fbRes.rows.length > 0) {
              inheritedStatus = 'ignored';
              console.log(`[GEO] ignore-propagate (fallback): "${opp.topic}" inherits ignored from "${fbRes.rows[0].topic}"`);
            }
          } catch(e2) { /* give up silently — default to 'discovered' */ }
        }
      }

      try {
        const insertRes = await pool.query(
          `INSERT INTO geo_opportunities (
            brand_profile_id, brain_version, topic, platform_scores, avg_score, quick_win,
            topical_authority_context, intent_signals, status, discovery_session_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, $9)
          RETURNING id`,
          [
            brandProfileId, profile.version || 1, opp.topic,
            JSON.stringify(platforms), avgScore.toFixed(2), !!opp.quickWin,
            authorityContext, JSON.stringify({ entities: entitySchema.filter(e => e.priority === 'high').slice(0, 5) }),
            discoverySessionId, inheritedStatus
          ]
        );
        persistedOpportunities.push({ ...opp, id: insertRes.rows[0].id, avgScore, status: inheritedStatus });
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

    // Load factualGround EARLY so we can disambiguate the Sonar call below. Without this,
    // Sonar gets only the brand name and URL, which for generic-sounding names like "Forge" or
    // "Apex" or "Nova" causes it to pull data from similarly-named unrelated companies. Real
    // bug that bit us: Sonar conflated Forge Intelligence (Portland, 2025, Brian Morgan) with
    // Forge.AI (Cambridge, 2017, Jim and Greg) and polluted the enriched brief with the wrong
    // founding story, wrong named experts, wrong location. Downstream content generation would
    // have embedded those hallucinations. Factual ground fixes it at the source.
    let earlyFactualGround = null;
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg FROM brand_profiles WHERE id = $1`,
        [brandProfileId]
      );
      if (fgRes.rows[0]?.fg) earlyFactualGround = fgRes.rows[0].fg;
    } catch(e) { /* silent — enricher continues with empty disambiguation */ }

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

    // Build disambiguation block from factual ground. Each line is a hard filter — Sonar is
    // instructed to only return data compatible with these known facts. Empty facts = no block,
    // which gracefully falls back to legacy behavior for brands that haven't set factual ground.
    const fgAuthor = earlyFactualGround?.authors?.[0]?.name || '';
    const fgAuthorTitle = earlyFactualGround?.authors?.[0]?.title || '';
    const fgCompanyFacts = earlyFactualGround?.companyFacts || '';
    const fgFoundingStory = earlyFactualGround?.foundingStory || '';
    const fgWhatWeDo = earlyFactualGround?.whatWeDo || '';
    const fgWhatWeDontDo = earlyFactualGround?.whatWeDontDo || '';
    const disambiguationBlock = (fgAuthor || fgCompanyFacts || fgFoundingStory)
      ? `\n\nKNOWN FACTS ABOUT THIS SPECIFIC COMPANY (use as disambiguation filter — do NOT return data that contradicts these):\n${fgAuthor ? `- Founder/leader: ${fgAuthor}${fgAuthorTitle ? ` (${fgAuthorTitle})` : ''}\n` : ''}${fgCompanyFacts ? `- Company facts: ${fgCompanyFacts.slice(0, 400)}\n` : ''}${fgFoundingStory ? `- Founding story: ${fgFoundingStory.slice(0, 400)}\n` : ''}${fgWhatWeDo ? `- What they do: ${fgWhatWeDo.slice(0, 300)}\n` : ''}${fgWhatWeDontDo ? `- What they DO NOT do: ${fgWhatWeDontDo.slice(0, 200)}\n` : ''}\nIf any information you find (founding year, location, named founders, business focus) contradicts the facts above, it belongs to a DIFFERENT company with a similar name — return empty arrays rather than that data. Only return information that matches or is consistent with the known facts.`
      : '';

    let sonarSignals = {};
    try {
      const sonarRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{
            role: 'user',
            content: `Research ${brandName} (${brandUrl}) — specifically this company and NO OTHER similarly-named company.${disambiguationBlock}

Return ONLY valid JSON (no markdown):
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
Return empty arrays if not found. Be factual and accurate. When in doubt, return less rather than potentially wrong data.`
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

    // Post-Sonar validation: if factual ground is set, cross-check returned foundingStory
    // against known facts. Simple year/location conflict detection — drops obviously wrong data
    // rather than letting it flow through the pipeline. Belt-and-suspenders behind the prompt-
    // level disambiguation above.
    if (earlyFactualGround && sonarSignals.foundingStory) {
      const knownText = (fgCompanyFacts + ' ' + fgFoundingStory).toLowerCase();
      const returnedStory = (sonarSignals.foundingStory || '').toLowerCase();
      // Extract 4-digit years from both
      const knownYears = knownText.match(/\b(19|20)\d{2}\b/g) || [];
      const returnedYears = returnedStory.match(/\b(19|20)\d{2}\b/g) || [];
      // If we have known years and returned years, and they don't overlap, drop the founding story
      if (knownYears.length > 0 && returnedYears.length > 0) {
        const overlap = returnedYears.some(y => knownYears.includes(y));
        if (!overlap) {
          console.log(`[ENRICH] Dropping Sonar foundingStory — year mismatch. Known: ${knownYears.join(',')} vs returned: ${returnedYears.join(',')}`);
          sonarSignals.foundingStory = '';
          sonarSignals.namedExperts = []; // named experts likely also from wrong company
        }
      }
    }

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
        { role: 'user', content: `${dateContext()}

E-E-A-T scoring task for ${brandName} (${brandUrl}).

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

CRITICAL SHAPE RULE for eeatInjections: this field is an array of PLAIN ENGLISH PROSE STRINGS ONLY — never JSON objects, never structured data. Each string is the actual text the writer should weave into the article body. Convert each relevant INJECTION above into a natural-language instruction by taking ONLY its suggestedContent field and rewriting it as a prose direction. Example: if an injection has {"type":"sme_quote","suggestedContent":"Open with a Lili Gil Valletta pull quote..."}, the eeatInjection string becomes "Open with a pull quote from Lili Gil Valletta establishing the revenue framing, followed by parenthetical credentials (UN, WEF, TED)." DO NOT copy the JSON keys, braces, or field names into the string.

Respond with this exact JSON structure:
{"enrichedTitle":"","enrichedH1":"","enrichedSections":[{"heading":"","eeatInjections":["prose string only"],"confidenceFlag":"green|yellow|red","flagReason":null,"smeRequired":false}],"enrichedFAQ":[{"q":"","a":"","eeatSignal":""}],"overallConfidence":0,"readyForStage4":true,"humanReviewItems":[]}` },
      ]
    });

    let assembledBrief = {};
    try {
      const ab = extractJSON(assemblerRes.content[0].text, 'object');
      if (!ab) throw new Error('No JSON in Tool 4');
      assembledBrief = JSON.parse(ab);
    } catch(e) { console.log('[ENRICH] Tool 4 parse warn:', e.message, '| raw:', assemblerRes.content[0].text.slice(0,200)); assembledBrief = { enrichedSections: [], overallConfidence: 0, readyForStage4: false }; }

    // ── Sanitize eeatInjections: catch any raw-JSON leakage ─────────────────────
    // Defensive: even with a tightened prompt, Sonnet occasionally returns injectionMap objects
    // as stringified JSON inside eeatInjections instead of prose strings. This unwraps any that
    // slipped through into plain-English directives so Content Gen doesn't ingest raw JSON.
    const unwrapInjection = (item) => {
      if (typeof item !== 'string') {
        // If it's somehow an object, pull suggestedContent
        if (item && typeof item === 'object' && typeof item.suggestedContent === 'string') return item.suggestedContent;
        return String(item);
      }
      const trimmed = item.trim();
      // Detect stringified JSON object — starts with { and contains quoted "suggestedContent" key
      if (trimmed.startsWith('{') && /"suggestedContent"\s*:/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed.suggestedContent === 'string') return parsed.suggestedContent;
        } catch { /* fall through to return original */ }
      }
      return item;
    };
    if (Array.isArray(assembledBrief.enrichedSections)) {
      let unwrapCount = 0;
      assembledBrief.enrichedSections = assembledBrief.enrichedSections.map(s => {
        if (!s || !Array.isArray(s.eeatInjections)) return s;
        const cleaned = s.eeatInjections.map(inj => {
          const unwrapped = unwrapInjection(inj);
          if (unwrapped !== inj) unwrapCount++;
          return unwrapped;
        });
        return { ...s, eeatInjections: cleaned };
      });
      if (unwrapCount > 0) {
        console.log(`[ENRICH] Unwrapped ${unwrapCount} raw-JSON injections into prose directives`);
      }
    }

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

    // ── Author propagation (Phase 1 authorship handoff) ─────────────────
    // The brief carries an optional assignedAuthor snapshot from the GEO Strategist.
    // We propagate it into enrichedData so the Content Generator (next stage) can
    // condition on this specific SME without doing brand-level lookup. If no
    // assignedAuthor was set at brief time, this is null and downstream falls
    // back to factualGround.authors[0] as before (backward compat).
    const assignedAuthor = (geoBrief && geoBrief.assignedAuthor) ? geoBrief.assignedAuthor : null;
    if (assignedAuthor && assignedAuthor.name) {
      finalAuthorSchema = {
        '@type': 'Person',
        name: assignedAuthor.name,
        jobTitle: assignedAuthor.title || finalAuthorSchema?.jobTitle || null,
        description: assignedAuthor.bio || finalAuthorSchema?.description || null,
        knowsAbout: assignedAuthor.expertise
          ? assignedAuthor.expertise.split(',').map(s => s.trim()).filter(Boolean)
          : (finalAuthorSchema?.knowsAbout || []),
        sameAs: assignedAuthor.linkedinUrl ? [assignedAuthor.linkedinUrl] : (finalAuthorSchema?.sameAs || []),
        ...(assignedAuthor.credentials ? {
          hasCredential: assignedAuthor.credentials.split(/[,.]/).map(s => s.trim()).filter(Boolean)
        } : {})
      };
      console.log(`[ENRICH] authorSchema overridden by assignedAuthor: ${assignedAuthor.name}`);
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
      // This guarantees our deterministic schema wins over whatever Tool 4 hallucinated.
      // Phase 1: If brief had an assignedAuthor, that author overrode finalAuthorSchema above.
      authorSchema: finalAuthorSchema,
      authorSchemaMarkup: finalAuthorSchema,
      // Carry the full assigned author snapshot through to the generator stage
      assignedAuthor,
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

    // Competitors source: prefer factualGround.competitors (user-verified) when present,
    // otherwise use Context Hub's discoveredCompetitors. Field shape can be:
    //   - string (newline or comma separated, textarea input from Brand Settings UI)
    //   - string[] (legacy)
    //   - {name, url}[] (earlier experiment)
    const rawFg = brand.settings?.factualGround?.competitors;
    let fgList = [];
    if (Array.isArray(rawFg)) {
      fgList = rawFg;
    } else if (typeof rawFg === 'string') {
      fgList = rawFg.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    }
    const fgUrls = fgList
      .map(c => (typeof c === 'object' && c?.url) ? c.url : String(c).trim())
      .filter(u => /^https?:\/\//.test(u) || /\.[a-z]{2,}/i.test(u))
      .map(u => /^https?:\/\//.test(u) ? u : `https://${u}`);
    const competitors = fgUrls.length ? fgUrls : (pd.discoveredCompetitors || []);

    if (!competitors.length) {
      send('error', { error: 'No competitors discovered. Run Context Hub first to discover competitors.' });
      return res.end();
    }

    send('progress', { stage: 'init', detail: `${competitors.length} competitors: ${competitors.join(', ')}` });

    // ── Cache check ──
    // Previously checked staleness via existing.rows[0].brain_version. That was the FIRST row
    // (newest by created_at), so a single fresh row would mask all stale rows and the user got
    // mixed v5/v11 data returned. Now: consider the cache stale if ANY row is older than the
    // current brand version, OR if any row's competitor_url is no longer in the current
    // competitors list (user removed a competitor from factualGround → should purge that row).
    if (!force) {
      const existing = await pool.query(
        'SELECT * FROM competitive_intelligence WHERE brand_profile_id = $1 ORDER BY created_at DESC',
        [brandProfileId]
      );
      if (existing.rows.length > 0) {
        const brandV = brand.version || 1;
        const currentCompetitorSet = new Set(competitors.map(c => {
          try { return new URL(c).hostname.replace(/^www\./, ''); } catch { return c; }
        }));
        const anyStale = existing.rows.some(r => (r.brain_version || 1) < brandV);
        const anyOrphan = existing.rows.some(r => {
          try { return !currentCompetitorSet.has(new URL(r.competitor_url).hostname.replace(/^www\./, '')); } catch { return true; }
        });
        const freshRows = existing.rows.filter(r => (r.brain_version || 1) >= brandV && (() => {
          try { return currentCompetitorSet.has(new URL(r.competitor_url).hostname.replace(/^www\./, '')); } catch { return false; }
        })());

        if (!anyStale && !anyOrphan && freshRows.length === existing.rows.length) {
          // All rows are fresh and match current competitor list — return cached
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

        // Purge stale + orphan rows so the fresh analysis below doesn't blend with them
        const stalePurge = await pool.query(
          'DELETE FROM competitive_intelligence WHERE brand_profile_id = $1 AND (brain_version < $2 OR brain_version IS NULL) RETURNING id',
          [brandProfileId, brandV]
        );
        const orphanPurge = await pool.query(
          `DELETE FROM competitive_intelligence WHERE brand_profile_id = $1 AND NOT (competitor_url = ANY($2::text[])) RETURNING id`,
          [brandProfileId, Array.from(new Set([...competitors, ...competitors.map(c => { try { return 'https://' + new URL(c).hostname; } catch { return c; } })]))]
        );
        const purgedTotal = (stalePurge.rows.length || 0) + (orphanPurge.rows.length || 0);
        if (purgedTotal > 0) {
          console.log(`[BRAND-INTEL] Purged ${stalePurge.rows.length} stale + ${orphanPurge.rows.length} orphan cache rows for brand ${brandProfileId}`);
          send('progress', { stage: 'cache', detail: `Purged ${purgedTotal} stale/orphan cache rows — running fresh` });
        } else {
          send('progress', { stage: 'cache', detail: 'Brain updated since last analysis — running fresh' });
        }
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
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'Forge-Intelligence-Server/1.0' },
      body: JSON.stringify({
        from: 'Forge Intelligence <hello@forgeintelligence.ai>',
        to: ['hello@forgeintelligence.ai'],
        subject: 'New early access request: ' + email,
        html: '<p>New early access request from <strong>' + email + '</strong></p>',
      }),
    });
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'Forge-Intelligence-Server/1.0' },
      body: JSON.stringify({
        from: 'Forge Intelligence <hello@forgeintelligence.ai>',
        to: [email],
        subject: "You're on the list.",
        html: `<div style="font-family:Inter,system-ui,sans-serif;background:#0F1720;color:#F8FAFC;padding:48px 32px;max-width:520px;margin:0 auto;border-radius:12px">
  <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#3563FF;margin:0 0 24px">Forge Intelligence</p>
  <h1 style="font-size:24px;font-weight:600;margin:0 0 16px;line-height:1.3">You're on the list.</h1>
  <p style="color:#94A3B8;font-size:15px;line-height:1.7;margin:0 0 24px">Thanks for your interest in Forge Intelligence. We'll reach out when early access opens.</p>
  <p style="color:#94A3B8;font-size:15px;line-height:1.7;margin:0">Questions? <a href="mailto:hello@forgeintelligence.ai" style="color:#3563FF;text-decoration:none">hello@forgeintelligence.ai</a></p>
  <p style="margin:40px 0 0;font-size:12px;color:#475569">© 2026 Forge Intelligence LLC</p>
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
  const { brandProfileId, enrichedBriefId, force, topicPrompt, mandatories, constraints, audience, ctaTarget, desiredAction, wordCountTarget } = req.query;
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
${(() => {
  const assigned = enrichedBrief?.assignedAuthor;
  const authorsToUse = (assigned && assigned.name) ? [assigned] : (factualGround.authors || []);
  return authorsToUse.length ? `NAMED AUTHOR${authorsToUse.length > 1 ? 'S' : ''} (use ${authorsToUse.length > 1 ? 'ONLY these people' : 'this person'} for author attribution, credentials, and bylines):\n${authorsToUse.map(a => `  • ${a.name || '[unnamed]'} — ${a.title || ''}\n    LinkedIn: ${a.linkedinUrl || 'N/A'}\n    Bio: ${a.bio || 'N/A'}\n    Credentials: ${a.credentials || 'N/A'}\n    Expertise: ${a.expertise || 'N/A'}`).join('\n\n')}\n` : '';
})()}
═══════════════════════════════════════════════════════════════════════════
`
      : '';

    // Self-as-case-study detection: when the brand's own name appears in Brain
    // pattern evidence/tags or Factual Ground, the brand IS the proof source
    // for at least one claim in this article. Flag it so the system prompt's
    // "Self-as-Case-Study Rule" fires and the writer drops epistemic hedges on
    // first-party validated outcomes. (Alpha shipped with blanket humility to
    // keep brands from over-claiming; mature brand brains earn the right to
    // stand on their documented evidence.)
    const brandName = profileData?.brand_name || profile.brand_name || '';
    const brandHost = (() => {
      try { return new URL(profileData?.brand_url || profile.brand_url || '').hostname.replace(/^www\./, ''); }
      catch { return ''; }
    })();
    const selfAsCaseStudy = brandName && [
      ...patternsRes.rows.map(p => `${p.description || ''} ${JSON.stringify(p.tags || '')}`),
      JSON.stringify(factualGround || {})
    ].some(text => {
      const hay = text.toLowerCase();
      return hay.includes(brandName.toLowerCase()) || (brandHost && hay.includes(brandHost.toLowerCase()));
    });
    const selfAsCaseStudyBlock = selfAsCaseStudy
      ? `\nSELF-AS-CASE-STUDY DETECTED: Brain evidence or Factual Ground references "${brandName}" directly. Apply the Self-as-Case-Study Rule from the system prompt — drop epistemic hedges on first-party validated outcomes, let the architectural claim stand. Keep hedges for unverified third-party claims.\n`
      : '';

        const userPrompt = `Generate a long-form article using the following Brand Intelligence context.
${topicPrompt ? `\nUSER TOPIC DIRECTION (write the article around this specific topic/angle — this overrides the enriched brief's default topic selection):\n"${topicPrompt}"\n` : ''}${(mandatories || constraints || audience || ctaTarget || desiredAction || wordCountTarget) ? `\nUSER MANDATORIES & CONSTRAINTS (the user-supplied non-negotiables for this article — every section must respect these. Treat as harder than brand patterns):\n${mandatories ? `- MANDATORIES (must include): ${mandatories}\n` : ''}${constraints ? `- CONSTRAINTS (must NOT do): ${constraints}\n` : ''}${audience ? `- TARGET AUDIENCE: ${audience}\n` : ''}${ctaTarget ? `- CTA TARGET URL/PATH: ${ctaTarget} — every CTA in the article should reference this destination.\n` : ''}${desiredAction ? `- DESIRED READER ACTION: ${desiredAction} — shape the article and conclusion to drive toward this specific next step.\n` : ''}${wordCountTarget ? `- TARGET LENGTH: approximately ${wordCountTarget} words. Do not pad — depth over filler.\n` : ''}` : ''}${selfAsCaseStudyBlock}${factualGroundBlock}${territoriesBlock}
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


// ─────────────────────────────────────────────────────────────────────────────
// Stage 4.7 — Ads Generator (Google Ads RSA asset pack)
// ─────────────────────────────────────────────────────────────────────────────
// Generates a complete Google Search campaign asset pack — headlines,
// descriptions, paths, sitelinks, callouts, match-typed keywords — anchored
// to the brand's brain patterns, GEO territories, and Factual Ground. Packs
// are persisted to generated_ad_packs so the UI can show a history drawer
// (no more pump-and-dump). Future stages add P-Max asset variants and
// Google Ads API publishing.
async function ensureGeneratedAdPacksTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generated_ad_packs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_profile_id UUID NOT NULL,
      topic TEXT NOT NULL,
      final_url TEXT,
      pack_data JSONB NOT NULL,
      overages INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gap_brand_created ON generated_ad_packs(brand_profile_id, created_at DESC)`).catch(() => {});
}

app.post('/api/ads-generator/rsa', requireAuth, async (req, res) => {
  const { brandProfileId, topic, finalUrl } = req.body || {};
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  if (!topic || !String(topic).trim()) return res.status(400).json({ success: false, error: 'topic required' });

  try {
    const [profileRes, patternsRes, mistakesRes, gbRes] = await Promise.all([
      pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]),
      pool.query('SELECT pattern_type, description, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8', [brandProfileId]).catch(() => ({ rows: [] })),
      pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC LIMIT 5', [brandProfileId]).catch(() => ({ rows: [] })),
      pool.query('SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1', [brandProfileId]).catch(() => ({ rows: [] })),
    ]);

    if (!profileRes.rows.length) return res.status(404).json({ success: false, error: 'Brand profile not found' });
    const profile = profileRes.rows[0];
    const profileData = profile.profile_data || {};
    const factualGround = profile.settings?.factualGround || null;

    const territories = (gbRes.rows[0]?.brief_data?.topicalAuthorityMap || [])
      .slice(0, 6)
      .map(t => t.topic || t.cluster || t.name)
      .filter(Boolean);

    const voice = profileData.voice_profile || {};
    const personas = (profileData.personas || []).slice(0, 2);

    const systemPrompt = `You are the Ads Generator for Forge Intelligence. You produce complete Google Search campaign asset packs — the full set Google now requires for a Search ad to run: headlines, descriptions, display paths, sitelinks, callouts, and keywords. Every asset is anchored to a brand's intelligence layer (brain patterns, GEO territories, voice profile, Factual Ground).

OUTPUT — return ONLY valid JSON (no markdown, no code fences, no commentary):
{
  "headlines": [
    { "text": "≤30 char headline", "anchor": "one-line brain/voice rationale" }
    // exactly 15 headlines
  ],
  "descriptions": [
    { "text": "≤90 char description", "anchor": "one-line rationale" }
    // exactly 4 descriptions
  ],
  "paths": ["≤15 char path1", "≤15 char path2"],
  "sitelinks": [
    {
      "linkText": "≤25 char clickable link label",
      "description1": "≤35 char benefit/detail line 1",
      "description2": "≤35 char benefit/detail line 2",
      "finalUrl": "destination URL — leave empty string if the ad's Final URL should be used"
    }
    // exactly 6 sitelinks
  ],
  "callouts": ["≤25 char non-clickable promo phrase", /* exactly 8 callouts */],
  "keywords": {
    "broad":  ["broad-match keyword phrase", /* 8-12 entries */],
    "phrase": ["phrase-match keyword phrase", /* 8-12 entries */],
    "exact":  ["exact-match keyword phrase", /* 8-12 entries */]
  },
  "notes": "1-2 sentences on the angle strategy across the pack"
}

HARD CONSTRAINTS — CHARACTER BUDGETS ARE ABSOLUTE CEILINGS, NOT TARGETS:

Headlines:
- AIM for 22-28 characters. HARD CEILING is 30 — anything 31+ is REJECTED.
- Before submitting each headline, count characters letter-by-letter (including spaces and punctuation). If your count is 30 or under, submit. If 31 or higher, REWRITE — shorter words, drop articles ("the", "a"), drop conjunctions, drop punctuation, drop trailing periods.
- Example PASS: "Context decay is the bug." (24 chars). FAIL: "Context decay is the silent bug killing your stack." (52 chars).
- Spaces count. "AI Content Intelligence" = 23 chars including spaces.

Descriptions:
- AIM for 75-85 characters. HARD CEILING is 90 — anything 91+ is REJECTED.
- Same counting protocol: count chars before submitting. Rewrite anything over 90.
- Example PASS: "An 8-stage intelligence pipeline that conditions every word before generation." (80 chars). FAIL: "An 8-stage Context Agent Architecture that conditions every word before generation, powered by your brain." (108 chars).
- If a sentence won't fit, split the idea or pick the punchier half. Do NOT submit a long version "for review" — that's a fail.

Sitelinks:
- linkText: AIM 18-22 chars, HARD CEILING 25 (Google clips past 25). Action phrasing — "See Pricing", "Read the May 7 Pillar", "Book a Demo".
- description1 + description2: AIM 28-32 chars each, HARD CEILING 35 each. Treat as two short benefit lines that complement the link, NOT a sentence split across two lines.
- finalUrl: leave as "" unless this sitelink deserves a different page than the ad's main Final URL (most sitelinks should differ — that's the point).
- Example PASS: linkText "See the Pillar Article" (22), desc1 "May 7-8 Google AI Mode chain" (28), desc2 "Architecture, not volume" (24).
- Exactly 6 sitelinks. Cover different intent paths (proof, pricing, product, founder story, latest pillar, FAQ).

Callouts:
- AIM 15-20 chars, HARD CEILING 25 each. Non-clickable promo phrases — short, punchy, benefit-led.
- No articles ("the", "a"). No trailing punctuation.
- Example PASS: "8-Stage Pipeline" (16), "Brand-Voice Locked" (18), "No Generic AI Slop" (18).
- Exactly 8 callouts. Mix: feature, differentiator, social proof, urgency, brand-voice statement.

Keywords:
- 8-12 keywords per match type (broad, phrase, exact). 24-36 total across all three.
- Plain keyword text only — NO match-type syntax. Do NOT wrap in quotes, brackets, or +modifiers. The downstream system applies the match type from the JSON key.
- broad: looser variants, problem-language, persona pain phrases. e.g. "ai content that ranks", "fix generic ai copy".
- phrase: 2-4 word commercial-intent phrases. e.g. "context agent architecture", "ai content intelligence platform".
- exact: 1-3 word high-intent brand and category terms. e.g. "forge intelligence", "context agent architecture".
- Lowercase. Do not duplicate the same phrase across match types unless intentional (e.g. brand terms in all three is fine).

Path fields:
- HARD CEILING 15 characters each. URL-safe (letters, numbers, hyphens only). Lowercase.

Other:
- Exact counts: 15 headlines, 4 descriptions, 2 paths, 6 sitelinks, 8 callouts, 24-36 keywords total.
- Each headline / sitelink / callout must be DIFFERENT in angle — do not paraphrase the same line repeatedly. Cover: feature, benefit, persona pain, proof point, CTA, brand-voice statement, differentiator, urgency, named framework, social proof, question, comparison.
- Never use competitor names unless explicitly in the brand's competitive gap map.
- Never fabricate stats, awards, or credentials.

COUNTING DISCIPLINE: The character budget is the single most common failure mode for AI-generated Google Ads. Treat every submission as something you've personally counted. When in doubt, write shorter.

VOICE: match the brand's voice profile. Do not write generic "best-in-class" filler.

BRAIN-FIRST: weave the strongest brain patterns into headlines/descriptions. Reference Factual Ground language verbatim where it fits the character budget. Brand-coined terms from the GEO territories are high-value anchors for Quality Score and AI synthesis.`;

    const userPrompt = `BRAND: ${profile.brand_name || profileData.brand_name || profile.brand_url}
TOPIC / AD GROUP THEME: "${String(topic).trim()}"
${finalUrl ? `FINAL URL: ${finalUrl}\n` : ''}
VOICE PROFILE:
${JSON.stringify({ tone: voice.tone, formality_score: voice.formality_score, confidence_score: voice.confidence_score, signature_phrases: voice.signature_phrases }, null, 2)}

PRIMARY PERSONAS (write to their pain):
${personas.map(p => `  • ${p.persona_name || p.name || 'unnamed'} — ${p.pain_points || p.painPoint || p.pain || ''}`).join('\n') || '(none)'}

STRATEGIC TERRITORIES (these are your authority anchors — use the language):
${territories.length ? territories.map(t => `  • ${t}`).join('\n') : '(none)'}

BRAIN PATTERNS — WHAT WORKS (use these to anchor headlines/descriptions):
${patternsRes.rows.length ? JSON.stringify(patternsRes.rows.slice(0, 8), null, 2) : '(no patterns extracted yet)'}

BRAIN MISTAKES — WHAT TO AVOID:
${mistakesRes.rows.length ? JSON.stringify(mistakesRes.rows.slice(0, 5), null, 2) : '(none)'}

${factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : Array.isArray(v) && v.length)) ? `FACTUAL GROUND — USE VERBATIM WHERE IT FITS:
${factualGround.whatWeDo ? `- WHAT THIS COMPANY DOES: ${factualGround.whatWeDo}\n` : ''}${factualGround.methodology ? `- METHODOLOGY: ${String(factualGround.methodology).slice(0, 600)}\n` : ''}${factualGround.quotablePositions ? `- QUOTABLE POSITIONS: ${factualGround.quotablePositions}\n` : ''}${factualGround.companyFacts ? `- COMPANY FACTS: ${String(factualGround.companyFacts).slice(0, 400)}\n` : ''}` : ''}

Return ONLY the JSON object specified in the system prompt.`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const aiRes = await client.messages.create({
      model: 'claude-sonnet-4-6',
      // Bumped from 3000 → 4500 to fit expanded asset pack (sitelinks + callouts
      // + keywords nearly double the JSON payload vs RSA-only).
      max_tokens: 4500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = aiRes.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    let parsed;
    try { parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw); }
    catch (e) {
      console.error('[ADS-GEN] JSON parse failed:', e.message, raw.slice(0, 300));
      return res.status(502).json({ success: false, error: 'Generator returned malformed JSON — try again.' });
    }

    // Server-side char-limit enforcement. Flag any overages instead of silently
    // truncating — the user needs to know if Claude blew a budget so they can
    // regen rather than ship a clipped asset.
    const mkAsset = (text, anchor, cap) => {
      const t = String(text || '').trim();
      return { text: t, anchor: String(anchor || '').trim(), length: t.length, overLimit: t.length > cap };
    };
    const headlines = (parsed.headlines || []).map(h => mkAsset(h.text, h.anchor, 30));
    const descriptions = (parsed.descriptions || []).map(d => mkAsset(d.text, d.anchor, 90));
    const paths = (parsed.paths || []).slice(0, 2).map(p => String(p || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 15));

    const sitelinks = (parsed.sitelinks || []).map(s => {
      const linkText = String(s.linkText || '').trim();
      const description1 = String(s.description1 || '').trim();
      const description2 = String(s.description2 || '').trim();
      return {
        linkText, description1, description2,
        finalUrl: String(s.finalUrl || '').trim(),
        linkTextLength: linkText.length,
        description1Length: description1.length,
        description2Length: description2.length,
        overLimit: linkText.length > 25 || description1.length > 35 || description2.length > 35,
      };
    });

    const callouts = (parsed.callouts || []).map(c => {
      const t = String(c || '').trim();
      return { text: t, length: t.length, overLimit: t.length > 25 };
    });

    // Keywords: trim, lowercase, dedupe-within-match-type, strip stray syntax
    // (e.g. quotes/brackets) so the user can apply match types cleanly downstream.
    const cleanKeywordList = (arr) => {
      const seen = new Set();
      return (arr || [])
        .map(k => String(k || '').trim().toLowerCase().replace(/^[\["+]+|["+\]]+$/g, '').trim())
        .filter(k => k && !seen.has(k) && (seen.add(k), true));
    };
    const keywords = {
      broad: cleanKeywordList(parsed.keywords?.broad),
      phrase: cleanKeywordList(parsed.keywords?.phrase),
      exact: cleanKeywordList(parsed.keywords?.exact),
    };

    const overages =
      [...headlines, ...descriptions].filter(x => x.overLimit).length +
      sitelinks.filter(s => s.overLimit).length +
      callouts.filter(c => c.overLimit).length;

    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1, $2, $3, $4, $5)`,
      ['stage4_7_ads_generator', brandProfileId, overages ? 'partial' : 'success',
       (aiRes.usage?.input_tokens || 0) + (aiRes.usage?.output_tokens || 0), 0]
    ).catch(() => {});

    const pack = {
      headlines,
      descriptions,
      paths,
      sitelinks,
      callouts,
      keywords,
      notes: String(parsed.notes || '').trim(),
      finalUrl: finalUrl || '',
      topic: String(topic).trim(),
      generatedAt: new Date().toISOString(),
    };

    // Persist so the FE can show a history drawer and the user can open prior
    // packs without regenerating (saves token spend on re-runs of the same topic).
    let packId = null;
    try {
      await ensureGeneratedAdPacksTable();
      const insRes = await pool.query(
        `INSERT INTO generated_ad_packs (brand_profile_id, topic, final_url, pack_data, overages)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [brandProfileId, pack.topic, pack.finalUrl || null, JSON.stringify(pack), overages]
      );
      packId = insRes.rows[0]?.id || null;
    } catch (e) { console.error('[ADS-GEN] persist failed (non-fatal):', e.message); }

    res.json({ success: true, packId, pack, overages });
  } catch (e) {
    console.error('[ADS-GEN]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads-generator/recent/:brandProfileId — list past packs for the drawer
app.get('/api/ads-generator/recent/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    await ensureGeneratedAdPacksTable();
    const r = await pool.query(
      `SELECT id, topic, final_url, pack_data, overages, created_at
       FROM generated_ad_packs
       WHERE brand_profile_id = $1
       ORDER BY created_at DESC LIMIT 30`,
      [brandProfileId]
    );
    res.json({ success: true, packs: r.rows.map(row => ({
      id: row.id,
      topic: row.topic,
      finalUrl: row.final_url || '',
      overages: row.overages || 0,
      createdAt: row.created_at,
      pack: row.pack_data,
    })) });
  } catch (e) {
    console.error('[ADS-GEN-RECENT]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/ads-generator/pack/:packId — prune a single saved pack
app.delete('/api/ads-generator/pack/:packId', requireAuth, async (req, res) => {
  const { packId } = req.params;
  try {
    // Verify the pack belongs to a brand the user has access to before deleting.
    const ownerRes = await pool.query(`SELECT brand_profile_id FROM generated_ad_packs WHERE id = $1`, [packId]);
    if (!ownerRes.rows.length) return res.status(404).json({ error: 'Pack not found' });
    if (!(await verifyBrandAccess(ownerRes.rows[0].brand_profile_id, req.userId))) return res.status(403).json({ error: 'Access denied' });
    await pool.query(`DELETE FROM generated_ad_packs WHERE id = $1`, [packId]);
    res.json({ success: true });
  } catch (e) {
    console.error('[ADS-GEN-DELETE]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// Mirrors Content Generator's brain-loading + SSE pattern but produces 4 short-form
// posts targeted at one platform (x or instagram). 1:1 imagery, brand voice enforced,
// inline edit + queue path (no Compliance Gate). See plan ce10e39398346f2c.

async function ensureSocialPostsTable() {
  // Idempotent — schema also defined in init-schema.sql but this guarantees the table
  // exists on dev branches that haven't run init-schema.sql since shipping social gen.
  await pool.query(`CREATE TABLE IF NOT EXISTS generated_social_posts (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    brand_profile_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    angle TEXT,
    hook TEXT,
    body TEXT NOT NULL,
    hashtags JSONB DEFAULT '[]'::jsonb,
    cta TEXT,
    char_count INTEGER,
    confidence INTEGER,
    confidence_tier TEXT,
    confidence_reason TEXT,
    brain_match_score INTEGER,
    image_url TEXT,
    image_prompt TEXT,
    status TEXT DEFAULT 'draft',
    user_edited_body TEXT,
    source_brief_id TEXT,
    source_topic TEXT,
    brain_version INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gsp_brand_created ON generated_social_posts(brand_profile_id, created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gsp_batch ON generated_social_posts(batch_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gsp_platform ON generated_social_posts(brand_profile_id, platform)`).catch(() => {});
  // Capture which campaignArc was used for the batch so the Recent Batches drawer
  // can show it. Idempotent ALTERs — safe on existing tables.
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS arc_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS arc_title TEXT`).catch(() => {});
  // Direct-publish (May 5, 2026) — X first, IG to follow with its own flow.
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS published_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE generated_social_posts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`).catch(() => {});
}
ensureSocialPostsTable().catch(e => console.error('[SOCIAL-GEN] Table init error:', e.message));

// activeStreams: dedupe SSE keys so a user clicking Generate twice doesn't double-fire.
// Same Map used by Email Campaign generator.
const activeStreams = (typeof globalThis.__activeStreams === 'object' && globalThis.__activeStreams)
  ? globalThis.__activeStreams
  : (globalThis.__activeStreams = new Map());

// Build a Flux Schnell image prompt tuned for SOCIAL composition (1:1, single subject,
// brand color palette, type-friendly negative space). Different shape than buildImagePrompt()
// which is editorial 16:9. Takes the writer's per-post imagePromptHint as the seed concept
// so each post gets imagery matched to its angle, not generic brand stock.
async function buildSocialImagePrompt(post, voiceProfile = {}, brandName = '') {
  const visualStyle = voiceProfile.visualStyle || voiceProfile.visual_style || voiceProfile.brand_aesthetic || '';
  const accentColor = voiceProfile.accentColor || voiceProfile.accent_color || voiceProfile.brand_color || '';
  const tone = voiceProfile.summary || voiceProfile.writingStyle || '';

  const hint = post?.imagePromptHint || post?.hook || post?.body?.slice(0, 200) || '';
  const angle = post?.angle || 'general';

  const brandContext = [
    brandName && `Brand: ${brandName}`,
    visualStyle && `Visual style: ${visualStyle}`,
    accentColor && `Brand accent: ${accentColor}`,
    tone && `Tone: ${tone}`,
  ].filter(Boolean).join('\n');

  const instruction = `Write a one-sentence Flux Schnell image prompt for a SQUARE (1:1) social media post. The image must work scrolling on phones — single focal subject, strong silhouette, type-friendly negative space, NOT a busy editorial scene.

Post concept: ${hint}
Post angle: ${angle}
${brandContext ? brandContext + '\n' : ''}
Rules:
- One sentence describing a clear, graphic, scroll-stopping visual.
- Single dominant subject. Strong composition. Centered or rule-of-thirds.
- 1:1 square aspect ratio in mind. Avoid wide cinematic compositions.
- Reflect the brand's accent color in the lighting or palette if specified.
- Concrete sensory details — no "professional", "polished", "corporate", "stock photo".
- No illustrations, 3D renders, cartoons. No text, no logos, no UI elements.
- NEVER interpret the brand name literally.
- Output only the prompt. No quotes, no preamble.`;

  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: instruction }]
    });
    return res.content[0]?.type === 'text'
      ? res.content[0].text.trim()
      : `A clean square composition with a single focal subject illuminated by natural light, related to ${hint}, scroll-stopping social composition`;
  } catch (e) {
    console.error('[SOCIAL-IMG-PROMPT]', e.message);
    return `A clean square composition with a single focal subject illuminated by natural light, related to ${hint}, scroll-stopping social composition`;
  }
}

// fal.ai Ideogram v2 wrapper for square social images. Mirrors generateHeroImage but with 1:1.
async function generateSocialImage(prompt) {
  const falRes = await fetch('https://fal.run/fal-ai/ideogram/v2', {
    method: 'POST',
    headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspect_ratio: '1:1',
      style: 'realistic',
      expand_prompt: true,
      negative_prompt: HERO_IMAGE_NEGATIVE_PROMPT,
      num_images: 1
    })
  });
  if (!falRes.ok) throw new Error(`fal.ai social ${falRes.status}: ${await falRes.text()}`);
  const falData = await falRes.json();
  const imageUrl = falData?.images?.[0]?.url;
  if (!imageUrl) throw new Error('No image URL returned from fal.ai');
  return imageUrl;
}

app.get('/api/social-generator/generate', requireAuth, async (req, res) => {
  const { brandProfileId, platform, topicPrompt, briefId, mandatories, constraints, audience, ctaTarget, desiredAction, arcId } = req.query;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  if (!platform || (platform !== 'x' && platform !== 'instagram')) {
    return res.status(400).json({ success: false, error: 'platform must be x or instagram' });
  }
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  // Duplicate stream guard — keyed by brand+platform so user can run X and IG concurrently
  const streamKey = `${brandProfileId}:social-${platform}`;
  if (activeStreams.has(streamKey)) {
    const existing = activeStreams.get(streamKey);
    const elapsed = Math.floor((Date.now() - existing.startedAt) / 1000);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`event: busy\ndata: ${JSON.stringify({ message: `Social generation already running for ${platform}`, elapsed })}\n\n`);
    return res.end();
  }
  activeStreams.set(streamKey, { startedAt: Date.now(), userId: req.userId });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(keepalive); activeStreams.delete(streamKey); });

  try {
    await ensureSocialPostsTable();

    // ── Brain-First: load all context (mirrors content-generator) ──
    const [profileRes, patternsRes, mistakesRes] = await Promise.all([
      pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]),
      pool.query('SELECT pattern_type, description, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 8', [brandProfileId]).catch(() => ({ rows: [] })),
      pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC LIMIT 8', [brandProfileId]).catch(() => ({ rows: [] }))
    ]);

    if (!profileRes.rows.length) {
      send('error', 'Brand profile not found.');
      clearInterval(keepalive); activeStreams.delete(streamKey);
      return res.end();
    }
    const profile = profileRes.rows[0];
    const profileData = profile.profile_data || {};
    const voiceProfile = profileData.voiceProfile || profileData.voice_profile || {};
    const personas = profileData.personas || [];
    const brandName = profile.brand_name || '';

    // Optional enriched brief (secondary path — most social posts come from typed angle)
    let enrichedBrief = null;
    if (briefId) {
      try {
        const ebRes = await pool.query('SELECT enriched_data, brand_name FROM enriched_briefs WHERE id = $1 AND brand_profile_id = $2', [briefId, brandProfileId]);
        if (ebRes.rows.length) enrichedBrief = ebRes.rows[0].enriched_data;
      } catch(e) { console.log('[SOCIAL-GEN] brief load skipped:', e.message); }
    }

    // Strategic territories — same source as content generator
    let topicalTerritories = [];
    try {
      const gbRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [brandProfileId]
      );
      const topicalMapRaw = gbRes.rows[0]?.brief_data?.topicalAuthorityMap || gbRes.rows[0]?.brief_data?.topicalMap?.gapsByCluster || [];
      topicalTerritories = topicalMapRaw
        .map(t => ({ topic: t.topic || t.cluster || t.name, priority: t.priority || (t.citationProbability >= 70 ? 'high' : 'medium') }))
        .filter(t => t.topic).slice(0, 6);
    } catch(e) { /* silent */ }

    // Factual ground — same source as content generator
    const factualGround = profile.settings?.factualGround || null;
    const fgBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
      ? `\nFACTUAL GROUND (use verbatim, never contradict):\n${factualGround.whatWeDo ? `- What we do: ${factualGround.whatWeDo}\n` : ''}${factualGround.whatWeDontDo ? `- What we DON'T do: ${factualGround.whatWeDontDo}\n` : ''}${factualGround.quotablePositions ? `- Quotable positions: ${factualGround.quotablePositions}\n` : ''}${factualGround.companyFacts ? `- Company facts: ${String(factualGround.companyFacts).slice(0, 400)}\n` : ''}`
      : '';

    // Load system prompt
    const systemPromptPath = path.join(__dirname, 'src/agents/stage4_social_generator/system_prompt.md');
    const systemPrompt = fs.existsSync(systemPromptPath)
      ? fs.readFileSync(systemPromptPath, 'utf8')
      : 'You are a short-form social writer. Produce 4 platform-native posts.';

    const trimTo = (obj, maxChars = 2000) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return s.length > maxChars ? s.substring(0, maxChars) + '\n...[truncated]' : s;
    };

    // Optional arc context — inject thesis + acts if user selected an arc.
    // Also captures arc title so it can be persisted on each post for the Recent Batches drawer.
    let arcBlock = '';
    let selectedArcTitle = null;
    if (arcId) {
      try {
        const allArcs = (profileData.campaignArcs || []);
        const arc = allArcs.find(a => a.id === arcId);
        if (arc) {
          selectedArcTitle = arc.title || null;
          const actsText = Array.isArray(arc.acts)
            ? arc.acts.map(a => `  Act ${a.actNumber}: ${a.actTitle} — ${a.actPremise}`).join('\n')
            : '';
          arcBlock = `\nBRAND NARRATIVE ARC (the brand arc this post series should advance):\nArc: "${arc.title}"\nThesis: ${arc.thesis}${actsText ? `\nActs:\n${actsText}` : ''}\nTarget persona: ${arc.targetPersona || 'primary'}\nThe posts must feel like they belong inside this arc — advancing the thesis, not contradicting it.\n`;
        }
      } catch(e) { console.log('[SOCIAL-GEN] arc inject skipped:', e.message); }
    }

    const userPrompt = `${dateContext()}\n\nGenerate exactly 4 ${platform.toUpperCase()} posts using the following brand intelligence.\n\nPLATFORM: ${platform}\n${platform === 'x' ? 'HARD CONSTRAINT: every X post body must be at or below 280 characters INCLUDING any inline characters. Count before you emit. If you find yourself at 270+ chars, cut it down. The X API rejects over-limit posts outright.\n' : 'HARD CONSTRAINT: every Instagram caption must be at or below 300 characters total. Stay below 150 when possible — audience disengages past that.\n'}BRAND: ${brandName}\n${topicPrompt ? `\nTOPIC / ANGLE THE USER WANTS COVERED:\n"${topicPrompt}"\n` : ''}${arcBlock}${(mandatories || constraints || audience || ctaTarget || desiredAction) ? `\nUSER MANDATORIES & CONSTRAINTS:\n${mandatories ? `- MUST INCLUDE: ${mandatories}\n` : ''}${constraints ? `- MUST NOT: ${constraints}\n` : ''}${audience ? `- AUDIENCE: ${audience}\n` : ''}${ctaTarget ? `- CTA TARGET: ${ctaTarget}\n` : ''}${desiredAction ? `- DESIRED ACTION: ${desiredAction}\n` : ''}` : ''}${fgBlock}\n\nBRAND VOICE PROFILE:\n${trimTo(voiceProfile, 1500)}\n\nPERSONAS:\n${trimTo(personas.slice(0, 2), 1000)}\n${topicalTerritories.length ? `\nSTRATEGIC TERRITORIES (stay inside these):\n${topicalTerritories.map(t => `- [${t.priority}] ${t.topic}`).join('\n')}\n` : ''}\nBRAIN PATTERNS — what works for this brand:\n${patternsRes.rows.length ? trimTo(patternsRes.rows, 1500) : 'No patterns yet.'}\n\nBRAIN MISTAKES — what to avoid:\n${mistakesRes.rows.length ? trimTo(mistakesRes.rows, 1000) : 'No mistakes logged yet.'}\n${enrichedBrief ? `\nENRICHED BRIEF CONTEXT:\n${trimTo({ title: enrichedBrief.enrichedTitle, hooks: enrichedBrief.contentHooks, powerPhrases: enrichedBrief.powerPhrases }, 1500)}\n` : ''}\nReturn ONLY valid JSON matching the {posts: [...]} schema in the system prompt. No markdown, no commentary.`;

    send('chunk', 'Brain loaded. Drafting 4 posts...');
    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1, $2, $3, $4, $5)', ['stage4_5_social_generator_start', brandProfileId, 'started', 0, 0]).catch(() => {});

    // Stream from Claude
    let fullText = '';
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        fullText += chunk.delta.text;
        send('chunk', chunk.delta.text.replace(/\n/g, '⏎'));
      }
    }

    let parsed;
    try {
      parsed = safeParseLLM(fullText, 'object', 'social-generator');
    } catch(e) {
      console.error('[SOCIAL-GEN] Parse failed:', e.message);
      send('error', 'Generation hit a formatting issue — click Generate again.');
      clearInterval(keepalive); activeStreams.delete(streamKey);
      return res.end();
    }

    const posts = Array.isArray(parsed?.posts) ? parsed.posts.slice(0, 4) : [];
    if (!posts.length) {
      send('error', 'No posts returned. Click Generate to retry.');
      clearInterval(keepalive); activeStreams.delete(streamKey);
      return res.end();
    }

    // Persist all 4 with shared batch_id
    const batchId = randomUUID();
    const persisted = [];
    for (const post of posts) {
      const charCount = (post.body || '').length;
      const insertRes = await pool.query(
        `INSERT INTO generated_social_posts
          (brand_profile_id, batch_id, platform, angle, hook, body, hashtags, cta, char_count,
           confidence, confidence_tier, confidence_reason, brain_match_score,
           source_brief_id, source_topic, brain_version, arc_id, arc_title, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft')
         RETURNING id`,
        [
          brandProfileId, batchId, platform,
          post.angle || null, post.hook || null, post.body || '',
          JSON.stringify(post.hashtags || []), post.cta || null, charCount,
          post.confidence || null, post.confidenceTier || null, post.confidenceReason || null,
          post.brainMatchScore || null,
          briefId || null, topicPrompt || null, profile.version || 1,
          (arcId || null), (typeof selectedArcTitle === 'string' ? selectedArcTitle : null)
        ]
      );
      persisted.push({
        id: insertRes.rows[0].id,
        ...post,
        charCount,
        batchId,
        platform
      });
    }

    send('done', JSON.stringify({ batchId, platform, posts: persisted }));

    // Fire 4 image generations in parallel — non-blocking, emit image_done per post
    (async () => {
      try {
        await Promise.all(persisted.map(async (p) => {
          try {
            const imgPrompt = await buildSocialImagePrompt(p, voiceProfile, brandName);
            const imageUrl = await generateSocialImage(imgPrompt);
            await pool.query(
              `UPDATE generated_social_posts SET image_url = $1, image_prompt = $2, updated_at = NOW() WHERE id = $3`,
              [imageUrl, imgPrompt, p.id]
            ).catch(() => {});
            send('image_done', JSON.stringify({ post_id: p.id, image_url: imageUrl, prompt: imgPrompt }));
          } catch(imgErr) {
            console.error(`[SOCIAL-IMG] post ${p.id}:`, imgErr.message);
            send('image_error', JSON.stringify({ post_id: p.id, error: imgErr.message }));
          }
        }));
      } finally {
        clearInterval(keepalive);
        activeStreams.delete(streamKey);
        res.end();
      }
    })();

    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1, $2, $3, $4, $5)',
      ['stage4_5_social_generator', brandProfileId, 'success',
       (stream.usage?.input_tokens || 0) + (stream.usage?.output_tokens || 0), 0]
    ).catch(() => {});

  } catch (err) {
    console.error('[SOCIAL-GEN] Error:', err?.message || err);
    send('error', err.message || 'Generation failed');
    clearInterval(keepalive);
    activeStreams.delete(streamKey);
    res.end();
  }
});

// GET /api/social-generator/arcs/:brandProfileId — return campaign arcs from brand profile
app.get('/api/social-generator/arcs/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const r = await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Brand not found' });
    const arcs = (r.rows[0].profile_data || {}).campaignArcs || [];
    res.json({ success: true, arcs });
  } catch(e) {
    console.error('[SOCIAL-ARCS]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/social-generator/regenerate-arcs/:brandProfileId
// Generates a fresh set of campaignArcs[] for the brand's profile_data
// WITHOUT a full Context Hub rescan. The Social Generator UI calls this
// when the user wants alternate narrative angles to choose from.
//
// Body (all optional):
//   leanIntoMoats:    string[]  — strategicMoat capabilities to emphasize
//   leanIntoPersonas: string[]  — persona IDs to emphasize
//   leanIntoGaps:     string[]  — competitiveGap topics to emphasize
//   guidance:         string    — free-text nudge (max 500 chars)
//
// Returns: { success: true, arcs: CampaignArc[] }
//
// Persistence: REPLACES profile_data.campaignArcs with the new set.
// Old arcs are not preserved (no brain_history table yet — add audit
// when that table exists).
app.post('/api/social-generator/regenerate-arcs/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });

  const {
    leanIntoMoats = [],
    leanIntoPersonas = [],
    leanIntoGaps = [],
    guidance = ''
  } = req.body || {};

  // Validate guidance length defensively
  const cleanGuidance = String(guidance || '').slice(0, 500).trim();

  try {
    // Load brand profile
    const pr = await pool.query('SELECT brand_name, profile_data FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Brand not found' });
    const profile = pr.rows[0];
    const pd = profile.profile_data || {};

    const personas = pd.personas || [];
    const moats = pd.strategicMoats || [];
    const gaps = pd.competitiveGaps || [];
    const voiceProfile = pd.voiceProfile || pd.voice_profile || {};
    const existingArcs = pd.campaignArcs || [];

    // Build emphasis blocks. If user selected specific moats/personas/gaps,
    // surface them first and most prominently. Otherwise pass the whole list
    // (model picks angles itself, equivalent to current Context Hub flow).
    const moatsForPrompt = leanIntoMoats.length
      ? moats.filter(m => leanIntoMoats.includes(m.capability))
      : moats;
    const personasForPrompt = leanIntoPersonas.length
      ? personas.filter(p => leanIntoPersonas.includes(p.id))
      : personas;
    const gapsForPrompt = leanIntoGaps.length
      ? gaps.filter(g => leanIntoGaps.includes(g.topic))
      : gaps;

    const emphasisBlock = (leanIntoMoats.length || leanIntoPersonas.length || leanIntoGaps.length)
      ? `\nUSER-SPECIFIED EMPHASIS (lean into these, not the others):\n` +
        (leanIntoMoats.length ? `\nMoats: ${leanIntoMoats.join(', ')}\n` : '') +
        (leanIntoPersonas.length ? `Personas: ${leanIntoPersonas.join(', ')}\n` : '') +
        (leanIntoGaps.length ? `Gaps: ${leanIntoGaps.join(', ')}\n` : '')
      : '';

    const guidanceBlock = cleanGuidance ? `\nUSER GUIDANCE: ${cleanGuidance}\n` : '';

    const existingTitles = existingArcs.map(a => a.title).filter(Boolean);
    const avoidBlock = existingTitles.length
      ? `\nAVOID REPRODUCING EXISTING ARC TITLES OR THESES. The user already has these and wants ALTERNATE angles:\n${existingTitles.map(t => `  - "${t}"`).join('\n')}\n`
      : '';

    const prompt = `You are generating fresh CAMPAIGN ARCS for a brand's content strategy. These arcs will be picked by the brand's social-post generator as the spine of multi-post sequences — each arc is a sustained narrative the brand argues across many short-form posts.

BRAND: ${profile.brand_name}

VOICE PROFILE:
${JSON.stringify(voiceProfile, null, 2).slice(0, 1500)}

PERSONAS (these are who the brand speaks to):
${JSON.stringify(personasForPrompt, null, 2).slice(0, 2000)}

STRATEGIC MOATS (what the brand deliberately does NOT do — leverage as positioning):
${JSON.stringify(moatsForPrompt, null, 2).slice(0, 1500)}

COMPETITIVE GAPS (topics where peers own the conversation and the brand could plausibly win):
${JSON.stringify(gapsForPrompt, null, 2).slice(0, 2000)}
${emphasisBlock}${guidanceBlock}${avoidBlock}
TASK: Write 3-5 fresh campaign arcs. Each arc must be:
- A narrative spine the brand can argue for weeks/months
- Ownable — something the brand specifically can claim, not generic
- Provocative — a real point of view, not a topic survey
- Tied to one persona primarily

OUTPUT ONLY valid JSON matching this schema exactly. No prose before or after.

{
  "campaignArcs": [
    {
      "id": "kebab-case-slug",
      "title": "Evocative name of the campaign series (not generic)",
      "thesis": "1-2 sentence core claim of the whole series. Provocative, ownable, tied to the brand's POV. NOT a summary of what will be covered — the argument itself.",
      "acts": [
        { "actNumber": 1, "actTitle": "string", "actPremise": "what this act establishes, proves, or resolves" }
      ],
      "recommendedLength": 4,
      "targetPersona": "persona id from the input"
    }
  ]
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    // Parse Claude's response. Strip code fences if present, then try direct
    // parse first — normal case. Only if that fails, apply careful escaping
    // INSIDE string values for bare control chars (the rare hardening case).
    let raw = msg.content?.[0]?.text || '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let parsed;
    try {
      // First attempt: parse as-is. Claude's JSON is usually valid.
      parsed = JSON.parse(raw);
    } catch (firstErr) {
      // Fallback: escape bare control chars but ONLY inside double-quoted
      // string regions. The original blanket replace was destroying
      // structural whitespace between tokens (\n between { and "key")
      // and producing invalid JSON.
      try {
        let inString = false;
        let escaped = false;
        let out = '';
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i];
          if (inString) {
            if (escaped) {
              out += ch;
              escaped = false;
            } else if (ch === '\\') {
              out += ch;
              escaped = true;
            } else if (ch === '"') {
              out += ch;
              inString = false;
            } else if (ch === '\n') {
              out += '\\n';
            } else if (ch === '\r') {
              out += '\\r';
            } else if (ch === '\t') {
              out += '\\t';
            } else if (ch.charCodeAt(0) < 0x20) {
              // strip other control chars inside strings
            } else {
              out += ch;
            }
          } else {
            if (ch === '"') inString = true;
            out += ch;
          }
        }
        parsed = JSON.parse(out);
      } catch (secondErr) {
        console.error('[REGEN-ARCS] JSON parse failed (both attempts):', firstErr.message, '/', secondErr.message, 'raw start:', raw.slice(0, 300));
        return res.status(500).json({ success: false, error: 'Model returned invalid JSON. Please try again.' });
      }
    }

    const newArcs = parsed.campaignArcs || [];
    if (!Array.isArray(newArcs) || newArcs.length === 0) {
      return res.status(500).json({ success: false, error: 'Model returned no arcs. Please try again.' });
    }

    // Persist: jsonb_set replaces only the campaignArcs key, preserves everything else
    await pool.query(
      `UPDATE brand_profiles
          SET profile_data = jsonb_set(COALESCE(profile_data, '{}'::jsonb), '{campaignArcs}', $1::jsonb),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(newArcs), brandProfileId]
    );

    console.log(`[REGEN-ARCS] Brand ${brandProfileId.slice(0,8)}… generated ${newArcs.length} fresh arcs`);
    res.json({ success: true, arcs: newArcs });
  } catch (e) {
    console.error('[REGEN-ARCS] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/social-generator/recent/:brandProfileId — list recent batches
app.get('/api/social-generator/recent/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    await ensureSocialPostsTable();
    const r = await pool.query(
      `SELECT id, batch_id, platform, angle, hook, body, hashtags, cta, char_count,
              confidence, confidence_tier, confidence_reason, brain_match_score,
              image_url, image_prompt, status, user_edited_body, source_topic,
              arc_id, arc_title, published_url, published_at,
              created_at, updated_at
       FROM generated_social_posts
       WHERE brand_profile_id = $1
       ORDER BY created_at DESC LIMIT 80`,
      [brandProfileId]
    );
    // Group by batch_id
    const batches = {};
    for (const row of r.rows) {
      const bid = row.batch_id;
      if (!batches[bid]) batches[bid] = {
        // FE expects snake_case here — mirror Postgres column names exactly so
        // the type definition in SocialGeneratorPage.tsx works without remapping.
        batch_id: bid,
        platform: row.platform,
        created_at: row.created_at,
        source_topic: row.source_topic || null,
        arc_id: row.arc_id || null,
        arc_title: row.arc_title || null,
        posts: []
      };
      batches[bid].posts.push(row);
    }
    res.json({ success: true, batches: Object.values(batches) });
  } catch(e) {
    console.error('[SOCIAL-LIST]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/social-generator/edit/:postId — inline edit, captures delta as brain_mistake.
// Accepts both 'user_edited_body' (current FE field name) and 'body' (legacy/scripts) for the
// new text. Stores edits in user_edited_body without overwriting the original generator output
// in post.body, so brain delta-mistake calculations stay anchored to the true original.
// Returns the full updated post via RETURNING * so FE.onUpdate(d.post) re-renders cleanly.
app.post('/api/social-generator/edit/:postId', requireAuth, async (req, res) => {
  const { postId } = req.params;
  const { body, user_edited_body, hashtags, cta } = req.body;
  // FE sends user_edited_body; older clients/scripts may send body — accept either.
  const newBodyInput = typeof user_edited_body === 'string' ? user_edited_body
                     : typeof body === 'string' ? body : null;
  try {
    // Look up post + verify access
    const r = await pool.query('SELECT * FROM generated_social_posts WHERE id = $1', [postId]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Post not found' });
    const post = r.rows[0];
    if (!(await verifyBrandAccess(post.brand_profile_id, req.userId))) return res.status(403).json({ success: false, error: 'Access denied' });

    const newBody = newBodyInput !== null ? newBodyInput : (post.user_edited_body || post.body);
    const newHashtags = Array.isArray(hashtags) ? hashtags : (post.hashtags || []);
    const newCta = typeof cta === 'string' ? cta : post.cta;
    const newCharCount = newBody.length;

    // Hard char limit on X. Reject early so users get a useful error at edit time.
    if (post.platform === 'x' && newCharCount > 280) {
      return res.status(400).json({ success: false, error: `X posts must be 280 characters or fewer. This edit is ${newCharCount}.`, charCount: newCharCount });
    }

    // Brain feedback: if body changed vs the original generator output, log as a mistake.
    if (newBody !== post.body && post.body) {
      pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
         VALUES ($1, 'social_human_edit', $2, $3, 'medium')`,
        [
          post.brand_profile_id,
          `${post.platform} ${post.angle || 'post'}: human reviewer edited body`,
          `Avoid: "${(post.body || '').substring(0, 200)}" — prefer: "${newBody.substring(0, 200)}"`
        ]
      ).catch(e => console.error('[SOCIAL-EDIT] mistake write:', e.message));
    }

    // Persist edit. user_edited_body always carries the latest text; original post.body untouched.
    const upd = await pool.query(
      `UPDATE generated_social_posts
       SET user_edited_body = $1, hashtags = $2, cta = $3, char_count = $4,
           status = CASE WHEN status = 'published' THEN 'published' ELSE 'edited' END,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [newBody, JSON.stringify(newHashtags), newCta, newCharCount, postId]
    );

    res.json({ success: true, post: upd.rows[0], body: newBody, hashtags: newHashtags, cta: newCta, charCount: newCharCount });
  } catch(e) {
    console.error('[SOCIAL-EDIT]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/social-generator/publish-x/:postId — direct-publish a single social
// post to X (Twitter) using the brand's stored OAuth credentials in publishing_channels.
//
// Why this exists separate from the article publish flow at /api/publishing/publish/:itemId:
// - Social posts have no URL append, no UTM injection, no title fallback — the body IS the tweet.
// - No queue staging, no campaign machinery, no per-channel selection (X-only here).
// - One post = one network call, ship-or-fail. Status flip + URL store on success.
//
// Auth path mirrors the article flow's X handler (L10049 region in this file):
// OAuth 2.0 token from publishing_channels.credentials, refresh on 401, OAuth 1.0a fallback.
app.post('/api/social-generator/publish-x/:postId', requireAuth, async (req, res) => {
  const { postId } = req.params;
  try {
    // Load the post + verify brand access
    const r = await pool.query('SELECT * FROM generated_social_posts WHERE id = $1', [postId]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Post not found' });
    const post = r.rows[0];
    if (post.platform !== 'x') return res.status(400).json({ success: false, error: 'This endpoint publishes X posts only.' });
    if (!(await verifyBrandAccess(post.brand_profile_id, req.userId))) return res.status(403).json({ success: false, error: 'Access denied' });
    if (post.status === 'published' && post.published_url) {
      return res.json({ success: true, alreadyPublished: true, url: post.published_url, post });
    }

    // Use the latest user-edited body if present, else the original body
    const tweetText = (post.user_edited_body || post.body || '').trim();
    if (!tweetText) return res.status(400).json({ success: false, error: 'Post has no body to publish.' });
    if (tweetText.length > 280) return res.status(400).json({ success: false, error: `Post is ${tweetText.length} chars; X requires ≤280. Edit the post and try again.` });

    // Pull X creds for this brand
    const channelRes = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'x'`,
      [post.brand_profile_id]
    );
    if (!channelRes.rows.length) {
      return res.status(400).json({ success: false, error: 'X is not connected for this brand. Connect it in Integrations first.', code: 'X_NOT_CONNECTED' });
    }
    const creds = channelRes.rows[0].credentials || {};

    const tweetEndpoint = 'https://api.twitter.com/2/tweets';
    let tweetId, twitterHandle = creds.username || 'i';

    // ── Media upload: prefer brand's OAuth 2.0 user-context token (same user uploads + posts) ──
    // X enforces user-level ownership of media on tweet POST — the user that uploads must be
    // the same user that attaches. So we upload using the brand's own token. Requires
    // media.write scope on the OAuth 2.0 token (added 2026-05-05 to the OAuth scope list).
    //
    // Fallback: if the brand reconnected before media.write was added (no media.write in
    // scope), try the system OAuth 1.0a creds. Only succeeds if brand's OAuth 2.0 user is
    // the same person as the system OAuth 1.0a user (@makemysandbox). Otherwise X rejects
    // the attach with 'One or more parameters to your request was invalid'.
    let mediaIds = [];
    if (post.image_url) {
      const oauth2Token = creds.oauth2AccessToken;
      const oauth2HasMediaWrite = (creds.oauth2Scope || '').includes('media.write');

      if (oauth2Token && oauth2HasMediaWrite) {
        // Preferred path: brand's own OAuth 2.0 token with media.write scope
        try {
          const mediaId = await uploadXMedia({ imageUrl: post.image_url, oauth2Token });
          mediaIds = [mediaId];
        } catch(e) {
          console.error('[X-SOCIAL] OAuth2 media upload failed:', e.message);
          return res.status(500).json({ success: false, error: `Image upload to X failed: ${e.message}`, code: 'X_MEDIA_UPLOAD_FAILED' });
        }
      } else {
        // Fallback: system OAuth 1.0a creds. Only succeeds if brand's user == system user.
        const k1 = process.env.X_OAUTH1CONSUMER_KEY;
        const s1 = process.env.X_OAUTH1CONSUMER_SECRET;
        const t1 = process.env.X_OAUTH1ACCESS_TOKEN;
        const ts1 = process.env.X_OAUTH1ACCESS_SECRET;
        if (!k1 || !s1 || !t1 || !ts1) {
          return res.status(400).json({
            success: false,
            error: 'Reconnect X to enable image uploads. Open Integrations and reconnect your X account to grant the new media permission.',
            code: 'X_MEDIA_RECONNECT_REQUIRED'
          });
        }
        try {
          // v1.1 media upload endpoint (despite v2 working elsewhere, v2 /2/media/upload doesn't
          // accept multipart-friendly additional_owners). The OAuth 1.0a signature is computed
          // against the v1.1 URL.
          const mediaUploadEndpoint = 'https://upload.twitter.com/1.1/media/upload.json';
          const mediaAuthHeader = buildXOAuthHeader('POST', mediaUploadEndpoint, k1, s1, t1, ts1);

          // Look up the brand's X user ID so we can grant them attach permission via
          // additional_owners. Without this, X rejects the cross-user tweet POST. Cache the
          // result back into credentials so future publishes skip this lookup.
          let brandUserId = creds.userId || null;
          if (!brandUserId && creds.username) {
            try {
              const lookupUrl = `https://api.x.com/2/users/by/username/${encodeURIComponent(creds.username)}`;
              const lookupAuth = buildXOAuthHeader('GET', lookupUrl, k1, s1, t1, ts1);
              const lr = await fetch(lookupUrl, { headers: { Authorization: lookupAuth } });
              if (lr.ok) {
                const ld = await lr.json();
                brandUserId = ld?.data?.id || null;
                if (brandUserId) {
                  // Cache for next time
                  await pool.query(
                    `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
                    [JSON.stringify({ userId: brandUserId }), post.brand_profile_id]
                  );
                }
              }
            } catch (lookupErr) {
              console.error('[X-SOCIAL] User ID lookup failed (non-fatal):', lookupErr.message);
            }
          }

          const mediaId = await uploadXMedia({
            imageUrl: post.image_url,
            oauth1Header: mediaAuthHeader,
            additionalOwners: brandUserId || undefined,
          });
          mediaIds = [mediaId];
        } catch(e) {
          console.error('[X-SOCIAL] OAuth1 fallback media upload failed:', e.message);
          return res.status(400).json({
            success: false,
            error: 'Reconnect X to enable image uploads. Your X connection was authorized before image support was added — open Integrations to reconnect.',
            code: 'X_MEDIA_RECONNECT_REQUIRED'
          });
        }
      }
    }

    if (creds.oauth2AccessToken) {
      // OAuth 2.0 path — preferred for the tweet POST. Try posting; if 401, refresh and retry.
      let token = creds.oauth2AccessToken;
      const tweetBody = mediaIds.length
        ? { text: tweetText, media: { media_ids: mediaIds } }
        : { text: tweetText };
      let xRes = await fetch(tweetEndpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(tweetBody)
      });
      if (xRes.status === 401 && creds.oauth2RefreshToken) {
        try {
          const refreshed = await refreshXOAuth2Token(creds.oauth2RefreshToken);
          token = refreshed.access_token;
          await pool.query(
            `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
            [JSON.stringify({ oauth2AccessToken: refreshed.access_token, oauth2RefreshToken: refreshed.refresh_token || creds.oauth2RefreshToken }), post.brand_profile_id]
          );
          // Media was uploaded via OAuth 1.0a system creds before the OAuth 2.0 refresh —
          // media_ids tied to app, not user token, so they survive the user's token refresh.
          // Just retry the tweet POST with the same body shape.
          const tweetBodyRetry = mediaIds.length
            ? { text: tweetText, media: { media_ids: mediaIds } }
            : { text: tweetText };
          xRes = await fetch(tweetEndpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(tweetBodyRetry)
          });
        } catch(e) {
          console.error('[X-SOCIAL] Token refresh failed:', e.message);
          if (e.message && (e.message.includes('invalid') || e.message.includes('revoked') || e.message.includes('expired'))) {
            await pool.query(
              `UPDATE publishing_channels SET credentials = credentials - 'oauth2AccessToken' - 'oauth2RefreshToken' WHERE brand_profile_id = $1 AND channel = 'x'`,
              [post.brand_profile_id]
            ).catch(() => {});
            return res.status(401).json({ success: false, error: 'X authentication expired. Please reconnect X in Integrations.', code: 'X_AUTH_EXPIRED' });
          }
          throw e;
        }
      }
      const xData = await xRes.json();
      if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
      tweetId = xData.data?.id;
    } else {
      // OAuth 1.0a fallback — legacy manual tokens
      const xApiKey       = creds.apiKey       || process.env.X_OAUTH1CONSUMER_KEY;
      const xApiSecret    = creds.apiSecret    || process.env.X_OAUTH1CONSUMER_SECRET;
      const xAccessToken  = creds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
      const xAccessSecret = creds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
      if (!xApiKey || !xApiSecret || !xAccessToken || !xAccessSecret) {
        return res.status(400).json({ success: false, error: 'X is not connected for this brand. Connect it in Integrations first.', code: 'X_NOT_CONNECTED' });
      }
      // OAuth 1.0a tweet POST (legacy fallback when no OAuth 2.0 creds for the brand).
      // Media was already uploaded upstream via the system OAuth 1.0a creds; mediaIds is populated.
      const authHeader = buildXOAuthHeader('POST', tweetEndpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret);
      const tweetBody1 = mediaIds.length
        ? { text: tweetText, media: { media_ids: mediaIds } }
        : { text: tweetText };
      const xRes = await fetch(tweetEndpoint, {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(tweetBody1)
      });
      const xData = await xRes.json();
      if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
      tweetId = xData.data?.id;
      try {
        const meRes = await fetch('https://api.twitter.com/2/users/me', { headers: { 'Authorization': authHeader } });
        if (meRes.ok) twitterHandle = (await meRes.json()).data?.username || 'i';
      } catch(e) {}
    }

    const publishedUrl = `https://x.com/${twitterHandle}/status/${tweetId}`;

    // Persist
    const upd = await pool.query(
      `UPDATE generated_social_posts SET status = 'published', published_url = $1, published_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [publishedUrl, postId]
    );
    res.json({ success: true, url: publishedUrl, tweetId, post: upd.rows[0] });
  } catch(e) {
    console.error('[X-SOCIAL]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Campaign Generator ────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// enrichAngleForCampaign — per-angle lightweight enrichment for Campaign Generator
// ─────────────────────────────────────────────────────────────────────────────
// Campaigns generate 8 articles from 8 distinct angles. Previously the whole campaign
// shared one enriched brief (from whatever the latest Enricher run happened to produce),
// which meant 7 of 8 articles got a brief that didn't match the angle — articles were
// "raw-dogged" with just angle + brand profile, bypassing the brain injection layer.
//
// This helper calls Sonnet 4.6 with the angle + brand brain + factual ground + brain
// patterns to synthesize a per-angle enrichedBrief in the same shape Content Gen expects
// (enrichedTitle, enrichedH1, enrichedSections, enrichedFAQ, powerPhrases, contentHooks).
// It is NOT the full 8-tool Enricher (Sonar scrape, EEAT scoring, gap analysis etc.) —
// that's ~60s per angle and stateful. This is the injection-surface subset, ~8-12s per
// angle and deterministic, giving campaign articles the same brain-directing structure
// as per-topic briefs without the full pipeline cost.
async function enrichAngleForCampaign({ angle, profileData, factualGround, brainPatterns, brainMistakes, brandName }) {
  const fgBlock = factualGround && Object.values(factualGround).some(v => v && (typeof v === 'string' ? v.trim() : (Array.isArray(v) && v.length)))
    ? `FACTUAL GROUND (verbatim, do not contradict):
${factualGround.whatWeDo ? `- What this company does: ${factualGround.whatWeDo}\n` : ''}${factualGround.whatWeDontDo ? `- What this company does NOT do: ${factualGround.whatWeDontDo}\n` : ''}${factualGround.companyFacts ? `- Company facts: ${factualGround.companyFacts}\n` : ''}${factualGround.foundingStory ? `- Founding: ${factualGround.foundingStory}\n` : ''}${factualGround.methodology ? `- Methodology: ${factualGround.methodology}\n` : ''}${(() => {
  const list = factualGround.authors || [];
  return list.length ? `- ${list.length > 1 ? 'Named authors/SMEs' : 'Assigned author'}: ${list.map(a => `${a.name} (${a.title || 'unspecified'})`).join('; ')}\n` : '';
})()}`
    : '';
  const patternsBlock = brainPatterns?.length
    ? `BRAIN PATTERNS (successful approaches — emulate these):\n${brainPatterns.slice(0,5).map(p => `- [${p.pattern_type}] ${p.description}`).join('\n')}`
    : '';
  const mistakesBlock = brainMistakes?.length
    ? `BRAIN MISTAKES (avoid these — hard constraints):\n${brainMistakes.slice(0,5).map(m => `- [${m.mistake_type}] ${m.description}`).join('\n')}`
    : '';
  const voiceBlock = profileData?.voiceProfile
    ? `VOICE PROFILE (tone + style anchors):\n${JSON.stringify(profileData.voiceProfile, null, 2).slice(0, 1500)}`
    : '';
  const personaName = angle.persona?.name || angle.persona || 'the target persona';

  const systemPrompt = `You are a content strategist producing a per-angle enriched brief for a long-form B2B article. Your output directs the article writer on exactly what to cover, what angle to take, what authority signals to inject, and what the brand's user-verified facts are. Every field must be specific to THIS angle and THIS brand — never generic.

Output STRICT JSON matching this schema (no markdown, no commentary):
{
  "enrichedTitle": "SEO-optimized meta title, 55-70 chars, format: 'Primary phrase | Brand' or 'Primary phrase — Brand'",
  "enrichedH1": "on-page headline, declarative, 7-14 words, more punchy than the meta title",
  "topic": "core topic of the article in 3-8 words",
  "enrichedSections": [
    { "heading": "H2 section heading", "body": "2-3 sentences summarizing what the writer should cover in this section — be SPECIFIC to this angle", "confidenceTier": "high|medium|low", "eeatInjections": ["Specific proof point, named source, data point, or expertise signal the writer should weave in"], "smeHooks": ["Quote-worthy position the SME can stand behind"] }
  ],
  "enrichedFAQ": [{ "q": "FAQ question this article should answer", "a": "Concise 1-2 sentence answer" }],
  "powerPhrases": ["Short, declarative phrases the writer should use verbatim — ~5 words each, specific to brand voice"],
  "contentHooks": ["Opening-paragraph hooks that would grab ${personaName}"],
  "authorSchema": { "name": "author name from factual ground authors, or null", "jobTitle": "author job title, or null" }
}

Requirements: 4-6 enrichedSections, 3-5 enrichedFAQ, 4-6 powerPhrases, 2-3 contentHooks.`;

  const userPrompt = `Produce the enriched brief for this specific campaign angle:

ANGLE:
${JSON.stringify(angle, null, 2)}

BRAND: ${brandName}

${voiceBlock}

${fgBlock}

${patternsBlock}

${mistakesBlock}

Return ONLY the JSON object.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const raw = message.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = safeParseLLM(match ? match[0] : raw, 'object', 'campaign-angle-enrichment');

  // Attach author schema from factualGround if the LLM didn't emit one
  if ((!parsed.authorSchema || !parsed.authorSchema.name) && factualGround?.authors?.length) {
    const fallbackAuthor = factualGround.authors[0];
    parsed.authorSchema = {
      name: fallbackAuthor.name || null,
      jobTitle: fallbackAuthor.title || null
    };
  }

  // Sanitize eeatInjections + smeHooks: unwrap any stringified JSON back to its suggestedContent prose.
  const unwrapLeakedJSON = (item) => {
    if (typeof item !== 'string') {
      if (item && typeof item === 'object' && typeof item.suggestedContent === 'string') return item.suggestedContent;
      return typeof item === 'string' ? item : String(item);
    }
    const trimmed = item.trim();
    if (trimmed.startsWith('{') && /"suggestedContent"\s*:/.test(trimmed)) {
      try {
        const p = JSON.parse(trimmed);
        if (p && typeof p.suggestedContent === 'string') return p.suggestedContent;
      } catch { /* pass */ }
    }
    return item;
  };
  if (Array.isArray(parsed.enrichedSections)) {
    parsed.enrichedSections = parsed.enrichedSections.map(s => ({
      ...s,
      eeatInjections: Array.isArray(s?.eeatInjections) ? s.eeatInjections.map(unwrapLeakedJSON) : [],
      smeHooks: Array.isArray(s?.smeHooks) ? s.smeHooks.map(unwrapLeakedJSON) : []
    }));
  }
  return parsed;
}

// GET /api/campaign/arcs/:brandProfileId — list Context Hub-generated campaign arcs
// Returns the campaignArcs array from Context Hub's output. If none exist (brand scanned before
// campaignArcs were added to the schema), returns []. UI will prompt user to re-scan Context Hub
// or fall back to the custom-prompt flow.
app.get('/api/campaign/arcs/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT profile_data->'campaignArcs' as arcs, brand_name FROM brand_profiles WHERE id = $1`,
      [req.params.brandProfileId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Brand profile not found' });
    const arcs = Array.isArray(r.rows[0].arcs) ? r.rows[0].arcs : [];
    res.json({ success: true, arcs, brandName: r.rows[0].brand_name });
  } catch (err) {
    console.error('[CAMPAIGN-ARCS]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaign/plan — generate 8 campaign angle profiles
// Accepts EITHER:
//   { brandProfileId, campaignArcId }  — Context Hub arc expansion (preferred path)
//   { brandProfileId, topicPrompt }    — user-typed custom campaign prompt (power user path)
//   { brandProfileId }                 — no direction; planner infers from brand brain (legacy/fallback)
app.post('/api/campaign/plan', requireAuth, async (req, res) => {
  const { brandProfileId, topicPrompt, campaignArcId } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

  try {
    const profileResult = await pool.query(
      `SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]
    );
    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Brand profile not found. Run Stage 1 first.' });
    }
    const profileData = profileResult.rows[0].profile_data || {};

    // Resolve the campaign arc if an id was provided
    let selectedArc = null;
    if (campaignArcId) {
      const arcs = Array.isArray(profileData.campaignArcs) ? profileData.campaignArcs : [];
      selectedArc = arcs.find(a => a.id === campaignArcId) || null;
      if (!selectedArc) {
        return res.status(404).json({ error: 'Campaign arc not found. It may have been deleted or the brand was rescanned. Pick a different arc or use a custom topic prompt.' });
      }
    }

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

    // Build the direction block — arc expansion is the strongest signal, custom prompt is medium, nothing is fallback.
    let directionBlock = '';
    if (selectedArc) {
      directionBlock = `\nCAMPAIGN ARC — EXPAND THIS INTO 8 ARTICLES:
The user has selected a Context Hub-generated narrative arc for this campaign. You MUST expand this arc's thesis and acts into exactly 8 distinct but narratively-connected articles, scheduled 2/week across 4 weeks. Think of it as a season of television: the same thesis told across 8 episodes, each building on the last.

ARC TITLE: ${selectedArc.title}
ARC THESIS: ${selectedArc.thesis}
TARGET PERSONA: ${selectedArc.targetPersona || 'infer from brand'}
NATURAL ACT STRUCTURE (${selectedArc.recommendedLength || selectedArc.acts?.length || 3} acts):
${(selectedArc.acts || []).map(a => `  Act ${a.actNumber} — ${a.actTitle}: ${a.actPremise}`).join('\n')}

EXPANSION GUIDANCE:
- If the arc has 3 acts: expand to roughly 3+3+2 or 2+3+3 articles per act, so each act gets multi-article development.
- If 4-5 acts: each act gets ~2 articles, with the opening and closing acts possibly getting 1 or 3 depending on narrative weight.
- If 6-8 acts: roughly 1 article per act, with the 1-2 strongest acts getting a supporting companion piece.
- Each article must be a distinct angle/persona-funnel combination BUT must build on the arc's thesis and the act it sits within.
- Article 1 = opening salvo establishing the problem. Articles 7-8 = payoff/resolution. Middle = progressive proof, case studies, contrarian takes, depth dives.
- Reference which act each article belongs to in its description so the campaign scheduler can maintain narrative coherence.
`;
    } else if (topicPrompt) {
      directionBlock = `\nUSER TOPIC DIRECTION: The user wants this campaign focused on: "${topicPrompt}". Build all 8 article angles around this theme. The brain patterns below should inform HOW you approach this topic, not WHETHER you cover it.\n`;
    }

    const userPrompt = `Generate 8 campaign angle profiles for the following brand brain.
${directionBlock}
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

    // Annotate the plan with the arc context so the UI can show which arc drove this campaign
    if (selectedArc) plan.sourceArc = { id: selectedArc.id, title: selectedArc.title, thesis: selectedArc.thesis };

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
    const patternsRes = await pool.query(
      `SELECT pattern_type, description, success_rate, confidence_score, tags FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY COALESCE(success_rate, confidence_score) DESC LIMIT 10`,
      [campaign.brand_profile_id]
    );
    const mistakesRes = await pool.query(
      `SELECT mistake_type, description FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [campaign.brand_profile_id]
    );

    const geoBrief = geoRes.rows[0]?.brief_data || null;
    // NOTE: we deliberately do NOT load a single "latest enriched brief" here anymore —
    // each of the 8 articles gets its OWN per-angle enriched brief synthesized from the
    // angle profile + factual ground + brain patterns. See enrichAngleForCampaign below.
    // Prior behavior: 7-of-8 articles received a brief that didn't match their angle,
    // which defeated the whole point of the brain injection layer.

    // Load Factual Ground once — it's brand-level, identical for all 8 articles.
    let campaignFactualGround = null;
    try {
      const fgRes = await pool.query(
        `SELECT settings->'factualGround' as fg FROM brand_profiles WHERE id = $1`,
        [campaign.brand_profile_id]
      );
      if (fgRes.rows[0]?.fg) campaignFactualGround = fgRes.rows[0].fg;
    } catch(e) { /* non-fatal */ }

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

      // ── Per-angle enrichment ────────────────────────────────────────────────
      // Synthesize an enriched brief specific to THIS angle so the writer has proper
      // brain-directing structure (sections, FAQ, power phrases, hooks) rather than
      // inheriting a stale brief from a prior topic.
      send('article_progress', { index: angle.index, stage: 'enriching', label: 'Building per-angle intelligence brief' });
      let enrichedBrief = null;
      try {
        enrichedBrief = await enrichAngleForCampaign({
          angle,
          profileData,
          factualGround: campaignFactualGround,
          brainPatterns: patternsRes.rows,
          brainMistakes: mistakesRes.rows,
          brandName: profileData?.brandName || profileResult.rows[0].brand_name || ''
        });
        console.log(`[CAMPAIGN] Angle ${angle.index} enriched: "${enrichedBrief?.enrichedH1 || enrichedBrief?.enrichedTitle || '(untitled)'}"`);
      } catch(enrichErr) {
        console.error(`[CAMPAIGN] Per-angle enrichment failed for angle ${angle.index}: ${enrichErr.message} — falling back to angle-only generation`);
        enrichedBrief = null;
      }

      // Load Topical Authority Map — strategic context for where this content lives
    let topicalTerritories = [];
    try {
      const gbRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [campaign.brand_profile_id]
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
        [campaign.brand_profile_id]
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
${(() => {
  const assigned = enrichedBrief?.assignedAuthor;
  const authorsToUse = (assigned && assigned.name) ? [assigned] : (factualGround.authors || []);
  return authorsToUse.length ? `NAMED AUTHOR${authorsToUse.length > 1 ? 'S' : ''} (use ${authorsToUse.length > 1 ? 'ONLY these people' : 'this person'} for author attribution, credentials, and bylines):\n${authorsToUse.map(a => `  • ${a.name || '[unnamed]'} — ${a.title || ''}\n    LinkedIn: ${a.linkedinUrl || 'N/A'}\n    Bio: ${a.bio || 'N/A'}\n    Credentials: ${a.credentials || 'N/A'}\n    Expertise: ${a.expertise || 'N/A'}`).join('\n\n')}\n` : '';
})()}
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
  const { sectionBody, suggestion, brandProfileId, source } = req.body;
  if (!sectionBody || !suggestion) return res.status(400).json({ error: 'sectionBody and suggestion required' });
  try {
    const profileRes = brandProfileId
      ? await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId])
      : { rows: [] };
    const voiceHint = profileRes.rows[0]?.profile_data?.voice_profile?.tone
      ? `Brand tone: ${profileRes.rows[0].profile_data.voice_profile.tone}.`
      : '';

    // Citation integration block — only added when a source is provided. Previously
    // this endpoint silently dropped the `source` param the UI was sending, so even
    // after the user clicked Find Sources and picked one, the rewrite ran without
    // ever seeing the URL. Users had to manually paste the citation, and the stitch
    // was awkward 9/10 times — the 90% rework rate. This block makes the citation
    // a first-class input with explicit integration rules.
    let citationBlock = '';
    if (source && source.url) {
      const titleClean = (source.title || '').replace(/\s+/g, ' ').trim();
      const yearStr = source.year ? ` (${source.year})` : '';
      const domainStr = source.domain ? ` — ${source.domain}` : '';
      citationBlock = `\n\nCITATION TO INTEGRATE:\nTitle: "${titleClean}"${yearStr}\nURL: ${source.url}${domainStr}\n\nINTEGRATION RULES:\n- Add the citation as a markdown link inline at the most natural anchor point (after the claim it supports)\n- Format options: text inline as ([Title](URL)), or for direct attribution: "According to [Title](URL), ..."\n- Match the surrounding sentence rhythm — do not stitch the URL in awkwardly or as a parenthetical after the section is otherwise complete\n- Preserve all other prose unchanged. The citation is the ONLY structural change.`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are an editorial AI. Rewrite the following article section to incorporate the editorial suggestion${source ? ' AND integrate the provided citation cleanly' : ''}. Preserve the author's voice and intent. Return only the rewritten section body — no commentary, no preamble, no labels.\n\n${voiceHint}\n\nORIGINAL SECTION:\n${sectionBody}\n\nEDITORIAL SUGGESTION:\n${suggestion}${citationBlock}\n\nREWRITTEN SECTION:` }]
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

// ── Source citation agent ──────────────────────────────────────────────────────
// Called from Compliance Gate when a user clicks "Find Sources" on a factual_claim or legal_risk flag.
// Uses Perplexity sonar-pro (reasoning model) to find sources that actually SUPPORT the claim,
// with prompt-level guidance on what counts as credible, result-level filtering for quality,
// and brand/domain context so it doesn't return self-citations or cross-company contamination.
//
// Known low-quality source domains — we drop these before returning to the user. Not an exhaustive
// list; it's the ones that most commonly show up as noise in citation searches.
const LOW_QUALITY_CITATION_DOMAINS = new Set([
  'quora.com', 'answers.yahoo.com', 'reddit.com', 'stackexchange.com',
  'wikihow.com', 'ehow.com', 'ask.com',
  // AI content farms / SEO spam that often crowd the top results
  'contentatscale.ai', 'seowriting.ai', 'copyai.com',
  // LinkedIn posts are user-generated opinion — not a citation-grade source (LinkedIn company
  // pages/articles are fine, but /pulse/ and /posts/ URLs come back as random user posts)
]);

async function findCitationSources({ claim, sectionBody, brandProfileId, maxResults = 3 }) {
  // Pull brand context for self-domain exclusion.
  let brandDomain = '';
  if (brandProfileId) {
    try {
      const r = await pool.query('SELECT brand_url FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (r.rows[0]) {
        const rawUrl = r.rows[0].brand_url || '';
        brandDomain = rawUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      }
    } catch(e) { /* non-fatal */ }
  }

  const claimText = (claim || '').trim().slice(0, 500);
  const sectionContext = (sectionBody || '').trim().slice(0, 800);

  const systemPrompt = `You are a citation researcher finding sources for a B2B thought-leadership article. Return sources that ACTUALLY SUPPORT the specific claim — not just topically-related articles. Prioritize in this order:
1. Primary sources (peer-reviewed research, government data, original surveys, SEC filings, company earnings reports)
2. Industry research firms (Gartner, Forrester, IDC, McKinsey, Deloitte, HubSpot/Salesforce/similar with original data)
3. Established trade publications (HBR, MIT Sloan, Wall Street Journal, Bloomberg, industry-leader publications)
4. Authoritative trade publications with named authors and clear methodology

Avoid: forums (Quora, Reddit, Stack Exchange), personal blogs, AI-generated content farms, press release aggregators, Wikipedia (except for well-sourced definitional claims), and LinkedIn user posts. Avoid sources older than 3 years for trend claims; older sources are acceptable for definitional or historical claims.

If the claim is definitional (e.g. "X is defined as..."), return authoritative definitional sources. If statistical (e.g. "73% of..."), return the primary survey/study. If a trend (e.g. "X is growing"), return recent industry reports. If a company-specific claim, return that company's own statement or filing.`;

  const claimTypeHints = [];
  if (/\b\d+\s*%|\b\d+x|\b\d+-fold/.test(claimText)) claimTypeHints.push('STATISTICAL — return the primary survey or study containing this exact data point.');
  if (/\bis defined as|means that|refers to\b/i.test(claimText)) claimTypeHints.push('DEFINITIONAL — return an authoritative industry or academic definition source.');
  if (/\bincreasing|growing|declining|trending|shift toward\b/i.test(claimText)) claimTypeHints.push('TREND — return recent (past 24 months) industry reports with data.');
  if (/\breport(ed)?|announced|stated\b/i.test(claimText) && /[A-Z][a-zA-Z]+\s+(Inc|LLC|Corp|Ltd)/.test(claimText)) claimTypeHints.push("COMPANY-SPECIFIC — return that company's own press release, earnings, or official blog.");

  const userMessage = `CLAIM TO SUPPORT:\n"${claimText}"\n\nCONTEXT (surrounding article text, for understanding — do NOT cite this):\n${sectionContext}\n${claimTypeHints.length ? '\nCLAIM TYPE: ' + claimTypeHints.join(' ') : ''}`;

  let sonarData = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const sonarRes = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        search_recency_filter: 'year',
      })
    });
    if (sonarRes.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!sonarRes.ok) {
      const err = await sonarRes.text();
      console.error('[FIND-SOURCES] Perplexity', sonarRes.status, err.slice(0, 200));
      throw new Error(`Source search failed (${sonarRes.status})`);
    }
    sonarData = await sonarRes.json();
    break;
  }
  if (!sonarData) throw new Error('Source search timed out');

  const searchResults = sonarData.search_results || [];
  const getDomain = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
  const seenDomains = new Set();
  const filtered = [];
  for (const r of searchResults) {
    const url = r.url || '';
    if (!url) continue;
    const domain = getDomain(url);
    if (brandDomain && domain === brandDomain) continue;
    if (seenDomains.has(domain)) continue;
    if (LOW_QUALITY_CITATION_DOMAINS.has(domain)) continue;
    if (domain === 'linkedin.com' && /\/(pulse|posts)\//i.test(url)) continue;
    seenDomains.add(domain);
    filtered.push({
      title: r.title || '',
      url,
      snippet: r.snippet || '',
      year: r.date ? String(r.date).slice(0, 4) : (r.last_updated ? String(r.last_updated).slice(0, 4) : ''),
      domain,
    });
    if (filtered.length >= maxResults) break;
  }
  console.log(`[FIND-SOURCES] claim="${claimText.slice(0,80)}..." returned=${filtered.length} (from ${searchResults.length} raw)`);
  return filtered;
}

app.post('/api/compliance/find-sources', requireAuth, async (req, res) => {
  const { claim, sectionBody, brandProfileId } = req.body;
  if (!claim && !sectionBody) return res.status(400).json({ error: 'claim or sectionBody required' });
  try {
    const sources = await findCitationSources({ claim, sectionBody, brandProfileId, maxResults: 3 });
    if (!sources.length) {
      return res.json({ success: false, error: 'No credible sources found for this claim. Try rewriting without a citation, or rephrase to be less specific.' });
    }
    res.json({ success: true, sources });
  } catch (e) {
    console.error('[FIND-SOURCES] caught:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── One-shot verify-and-rewrite ────────────────────────────────────────────────
// The asymmetric-friction fix: instead of forcing the user through find-sources →
// pick → click apply → manually verify the citation got integrated cleanly (the 4-step
// flow that produced a 90% rework rate), this endpoint does all of it in one call.
// Sonar finds the top source, the rewriter integrates the citation inline using the
// same prompt rules as the manual flow, and the response is a one-click-applicable
// section body. The user reviews and approves — they don't assemble.
//
// Falls back to soften-without-citation behavior if Sonar returns no qualifying source,
// so the UX is graceful when the claim genuinely can't be verified.
app.post('/api/compliance/verify-and-rewrite', requireAuth, async (req, res) => {
  const { sectionBody, claim, suggestion, brandProfileId, sectionHeading } = req.body;
  if (!sectionBody || !claim || !suggestion) {
    return res.status(400).json({ error: 'sectionBody, claim, and suggestion required' });
  }
  try {
    // Step 1: Sonar lookup. maxResults=1 — we want the single best source, not a menu.
    let topSource = null;
    try {
      const sources = await findCitationSources({ claim, sectionBody, brandProfileId, maxResults: 1 });
      topSource = sources[0] || null;
    } catch(searchErr) {
      // Sonar failure should not block the rewrite — fall through to soften path.
      console.warn('[VERIFY-AND-REWRITE] Sonar lookup failed, falling back to soften:', searchErr.message);
    }

    // Step 2: Pull voice context.
    const profileRes = brandProfileId
      ? await pool.query('SELECT profile_data FROM brand_profiles WHERE id = $1', [brandProfileId])
      : { rows: [] };
    const voiceHint = profileRes.rows[0]?.profile_data?.voice_profile?.tone
      ? `Brand tone: ${profileRes.rows[0].profile_data.voice_profile.tone}.`
      : '';

    // Step 3: Build prompt — citation block when source found, soften block when not.
    let citationBlock = '';
    let mode = 'softened';
    if (topSource && topSource.url) {
      mode = 'cited';
      const titleClean = (topSource.title || '').replace(/\s+/g, ' ').trim();
      const yearStr = topSource.year ? ` (${topSource.year})` : '';
      const domainStr = topSource.domain ? ` — ${topSource.domain}` : '';
      citationBlock = `\n\nVERIFIED SOURCE TO INTEGRATE:\nTitle: "${titleClean}"${yearStr}\nURL: ${topSource.url}${domainStr}\n\nINTEGRATION RULES:\n- Add the citation as a markdown link inline at the most natural anchor point (after the claim it supports)\n- Format options: "([Title](URL))" inline, or "According to [Title](URL), ..." for direct attribution\n- Match surrounding sentence rhythm — do not stitch the URL in awkwardly\n- Preserve all other prose unchanged. The citation is the ONLY structural change.`;
    } else {
      citationBlock = `\n\nNO VERIFIED SOURCE FOUND — SOFTEN THE CLAIM:\n- Rewrite to remove specific named-third-party assertions that can't be verified\n- Use hedged language like "organizations including [name] have explored this area publicly" or "this is a well-documented topic across industry research"\n- Do NOT invent or infer URLs, dates, or publication titles\n- Preserve all other prose unchanged.`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `You are an editorial AI. Rewrite the following article section to incorporate the editorial suggestion. ${mode === 'cited' ? 'A verified source has been provided — integrate it cleanly.' : 'No verified source was found — soften the claim instead of fabricating one.'} Preserve the author's voice and intent. Return only the rewritten section body — no commentary, no preamble, no labels.\n\n${voiceHint}\n\nSECTION HEADING: ${sectionHeading || 'Untitled'}\n\nORIGINAL SECTION:\n${sectionBody}\n\nFLAGGED CLAIM:\n"${claim}"\n\nEDITORIAL SUGGESTION:\n${suggestion}${citationBlock}\n\nREWRITTEN SECTION:` }]
    });
    const rewritten = response.content[0]?.text?.trim();
    if (!rewritten) return res.status(500).json({ success: false, error: 'AI returned empty response' });

    res.json({
      success: true,
      rewritten,
      mode,                  // 'cited' or 'softened'
      source: topSource,     // null when softened, full source object when cited
    });
  } catch (e) {
    console.error('[VERIFY-AND-REWRITE]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

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

    // Build the article-to-audit text once — reused on retry
    const articleAuditText = (() => {
      const sections = articleJson?.sections || [];
      return sections.map((s, i) => `[SECTION ${i}] heading: ${s.heading || s.title || 'Untitled'}\n${s.body || s.content || ''}`).join('\n\n---\n\n');
    })();

    // Attempt 1: standard prompt
    const callCritique = async (extraGuidance = '') => {
      const userContent = extraGuidance
        ? `${extraGuidance}\n\nArticle to audit:\n\n${articleAuditText}`
        : `Article to audit:\n\n${articleAuditText}`;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }]
        })
      });
      return resp.json();
    };

    let critiqueData = await callCritique();
    let rawText = critiqueData.content?.[0]?.text || '{}';
    let stopReason = critiqueData.stop_reason || 'unknown';
    if (stopReason === 'max_tokens') {
      console.warn(`[COMPLIANCE] Critique hit max_tokens ceiling on attempt 1 — response truncated. Article ${contentId} has ${(articleJson?.sections || []).length} sections / ${Math.round(JSON.stringify(articleJson).length / 1024)}kb`);
    }

    let report;
    try {
      report = safeParseLLM(rawText, 'object', 'compliance-gate');
    } catch (parseErr) {
      // Attempt 2: retry with stricter JSON directive. The most common parse failure on 'end_turn'
      // responses is unescaped inner double quotes or literal newlines inside flaggedExcerpt strings
      // (Claude quotes article text verbatim and occasionally forgets to escape).
      console.warn(`[COMPLIANCE] Attempt 1 parse failed (${parseErr.message}, stop_reason=${stopReason}). Retrying with strict JSON directive...`);
      const retryGuidance = `IMPORTANT JSON OUTPUT REQUIREMENTS:
- Return a single JSON object. No markdown code fences. No prose before or after.
- Every string value MUST have all inner double quotes escaped as \\".
- Every string value MUST have all literal newlines escaped as \\n (never raw line breaks inside a string).
- When quoting article excerpts in flaggedExcerpt, you MAY paraphrase if the verbatim quote contains characters that would complicate escaping.
- Validate your JSON is parseable before responding.`;
      const retryData = await callCritique(retryGuidance);
      const retryRaw = retryData.content?.[0]?.text || '{}';
      const retryStop = retryData.stop_reason || 'unknown';
      console.warn(`[COMPLIANCE] Retry stop_reason=${retryStop}, first 200: ${retryRaw.slice(0, 200).replace(/\n/g, ' ')}`);
      try {
        report = safeParseLLM(retryRaw, 'object', 'compliance-gate-retry');
        rawText = retryRaw;
        stopReason = retryStop;
        console.log(`[COMPLIANCE] Retry succeeded for article ${contentId}`);
      } catch (retryErr) {
        console.error(`[COMPLIANCE] Both attempts failed for article ${contentId}. Attempt 1: ${parseErr.message} | Retry: ${retryErr.message} | Retry raw first 800:`, retryRaw.slice(0, 800));
        return res.status(502).json({
          success: false,
          error: retryStop === 'max_tokens'
            ? 'Compliance review response was truncated even after retry. Article may be too long — try splitting into two articles.'
            : `Compliance review could not produce parseable JSON after retry. This can happen if the article contains tricky punctuation. Retry once more, or manually approve if you've reviewed the draft.`,
          stopReason: retryStop,
          // Include a preview of the raw response so the UI can optionally show it for manual review
          rawPreview: retryRaw.slice(0, 1500)
        });
      }
    }

    // Empty-object guard: if the parse succeeded but the report has no real fields, treat that
    // as a failure too. Silent {} write was the original bug shape.
    const hasAnyContent = report && (
      typeof report.overallScore === 'number' ||
      typeof report.summary === 'string' && report.summary.trim().length > 0 ||
      Array.isArray(report.flags)
    );
    if (!hasAnyContent) {
      console.error(`[COMPLIANCE] Parsed report is empty for article ${contentId}. stop_reason=${stopReason}, raw first 400:`, rawText.slice(0, 400));
      return res.status(502).json({
        success: false,
        error: 'Compliance review returned an empty response. This usually means the article is too long or the model hit an internal limit. Please retry.',
        stopReason
      });
    }

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
  // 2026-05-05: re-added 'media.write' after web research confirmed it IS a valid X
  // OAuth 2.0 scope (multiple X dev community posts confirm /2/media/upload works with
  // OAuth 2.0 + media.write). The dev console scope picker doesn't list it but X's
  // authorize endpoint accepts it. Earlier bisect dropped this concurrent with a host
  // swap — the host swap was the actual regression; the scope removal was a false positive.
  // With media.write, brands upload media + post tweets via their own OAuth 2.0 token,
  // eliminating the cross-account problem with system OAuth 1.0a creds.
  const scopes = ['tweet.write', 'tweet.read', 'users.read', 'offline.access', 'media.write'].join('%20');
  // X migrated the OAuth endpoints to x.com — the legacy twitter.com/i/oauth2/authorize
  // still serves but chains through their domain-migration redirect, which breaks the
  // session cookie set during login (cookie lands on one domain, next redirect targets
  // the other → "to use this app you have to be logged in" infinite loop). Use the
  // canonical x.com URL throughout the OAuth path. See:
  //   https://developer.x.com/en/docs/authentication/oauth-2-0/authorization-code
  const authUrl = `https://x.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

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
    const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
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
    console.error('[X-OAUTH]', err.message, '| query:', JSON.stringify(req.query));
    res.redirect(`/app/integrations?x_error=${encodeURIComponent(err.message)}`);
  }
});

// Helper: upload an image to X v2 media endpoint, return media_id_string.
// Used by the social-generator publish flow to attach the AI-generated square image
// to a tweet. X v2 (POST /2/media/upload) requires:
// - OAuth 2.0 user-context with media.write scope (preferred for our flow), OR
// - OAuth 1.0a user-context (legacy fallback)
// X rejects OAuth 2.0 application-only and bare bearer tokens for this endpoint.
//
// The endpoint is multipart/form-data with fields: media (binary), media_category, media_type.
// For tweet images we use 'tweet_image' — X then makes the media_id immediately attachable
// to a tweet via the {media: {media_ids: [id]}} field on POST /2/tweets.
async function uploadXMedia({ imageUrl, oauth2Token, oauth1Header, additionalOwners }) {
  // Upload an image to X and return the media_id_string.
  //
  // Why v1.1: X's v2 /2/media/upload demands `additional_owners` as a JSON array, which can't
  // be expressed in multipart form-data (the only way to send binary). v1.1 accepts a
  // comma-separated string in multipart, and v1.1 media_ids are fully accepted by the v2
  // /2/tweets POST endpoint (same underlying media system).
  //
  // additional_owners (optional) — comma-separated X user IDs that are explicitly granted
  // permission to attach this media to their own tweets. Required when the brand's OAuth 2.0
  // user (the one posting the tweet) is different from the user whose creds upload the media
  // (the system @makemysandbox via env-var OAuth 1.0a). Without this, X rejects the tweet
  // POST with "One or more parameters to your request was invalid."

  // 1. Fetch the image bytes from the source URL (Forge's image generation pipeline)
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

  // 2. Build multipart body + select endpoint. Branch by auth method because
  //    X enforced v1.1 deprecation for OAuth 2.0 tokens on 2026-05-13 (last
  //    successful publish via v1.1+OAuth2 was 06:06 UTC; subsequent attempts
  //    returned 403 empty body with NO Forge code change between them — X-side
  //    rollout). v1.1 still accepts OAuth 1.0a signatures, so the env-var
  //    fallback path keeps using it.
  //
  //    OAuth 2.0 path: v2 /media/upload, binary 'media' part + 'media_category'.
  //    OAuth 1.0a path: v1.1 /media/upload.json, base64 'media_data' + optional 'additional_owners'.
  //    additional_owners is only meaningful for the cross-user v1.1 path (system
  //    user uploads, brand user attaches). On OAuth 2.0 the uploader IS the
  //    attacher, so additional_owners is irrelevant and v2 doesn't accept it.
  const boundary = '----ForgeMediaBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  let body, uploadUrl, authHeader;

  if (oauth2Token) {
    // v2 endpoint expects binary 'media' part + 'media_category' text part
    const parts = [];
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="media_category"${CRLF}${CRLF}tweet_image${CRLF}`, 'utf8'));
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="media"; filename="image.png"${CRLF}Content-Type: image/png${CRLF}${CRLF}`, 'utf8'));
    parts.push(imgBuffer);
    parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'));
    body = Buffer.concat(parts);
    uploadUrl = 'https://api.x.com/2/media/upload';
    authHeader = `Bearer ${oauth2Token}`;
  } else if (oauth1Header) {
    // v1.1 endpoint expects base64 'media_data' + optional 'additional_owners'
    const partsList = [];
    if (additionalOwners) {
      partsList.push(`--${boundary}${CRLF}Content-Disposition: form-data; name="additional_owners"${CRLF}${CRLF}${additionalOwners}${CRLF}`);
    }
    partsList.push(`--${boundary}${CRLF}Content-Disposition: form-data; name="media_data"${CRLF}${CRLF}${imgBuffer.toString('base64')}${CRLF}`);
    const head = Buffer.from(partsList.join(''), 'utf8');
    const tail = Buffer.from(`--${boundary}--${CRLF}`, 'utf8');
    body = Buffer.concat([head, tail]);
    uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
    authHeader = oauth1Header;
  } else {
    throw new Error('No auth header for media upload');
  }

  const headers = {
    'Authorization': authHeader,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
  };

  const upRes = await fetch(uploadUrl, { method: 'POST', headers, body });
  const rawText = await upRes.text();
  let upData = {};
  try { upData = JSON.parse(rawText); } catch {}
  if (!upRes.ok) {
    console.error('[X-MEDIA-DIAG] HTTP', upRes.status, '| raw body:', rawText.slice(0, 500));
    console.error('[X-MEDIA-DIAG] auth method:', oauth1Header ? 'oauth1' : 'oauth2');
    if (oauth1Header) {
      console.error('[X-MEDIA-DIAG] env vars set?',
        'CK=' + (process.env.X_OAUTH1CONSUMER_KEY ? 'yes(' + process.env.X_OAUTH1CONSUMER_KEY.length + ')' : 'NO'),
        'CS=' + (process.env.X_OAUTH1CONSUMER_SECRET ? 'yes(' + process.env.X_OAUTH1CONSUMER_SECRET.length + ')' : 'NO'),
        'AT=' + (process.env.X_OAUTH1ACCESS_TOKEN ? 'yes(' + process.env.X_OAUTH1ACCESS_TOKEN.length + ')' : 'NO'),
        'AS=' + (process.env.X_OAUTH1ACCESS_SECRET ? 'yes(' + process.env.X_OAUTH1ACCESS_SECRET.length + ')' : 'NO')
      );
      console.error('[X-MEDIA-DIAG] auth header (first 200 chars):', oauth1Header.slice(0, 200));
    }
    const err = (upData.errors && upData.errors[0] && upData.errors[0].message) || upData.detail || upData.title || rawText.slice(0, 200) || `HTTP ${upRes.status}`;
    throw new Error(`X media upload failed: ${err}`);
  }
  const mediaId = upData.media_id_string || upData.data?.id || upData.media_id || upData.id;
  if (!mediaId) throw new Error(`X media upload returned no media id: ${JSON.stringify(upData)}`);
  return mediaId;
}
// Helper: refresh X OAuth 2.0 token
async function refreshXOAuth2Token(refreshToken) {
  const clientId = process.env.X_OAUTH2CLIENT_ID;
  const clientSecret = process.env.X_OAUTH2CLIENT_SECRET;
  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
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
  const { brandProfileId, contentId, reviewMode, editedSections, decisions, editedFaqs } = req.body;
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

    // Apply human edits to FAQs (separate field from sections, separate edit surface).
    // Same brain_mistakes write pattern so the model learns from FAQ corrections too.
    // editedFaqs format: [{ index, question, answer }] — both fields independently editable.
    if (editedFaqs && Array.isArray(editedFaqs) && Array.isArray(articleJson.faqs)) {
      editedFaqs.forEach(edit => {
        const faq = articleJson.faqs[edit.index];
        if (!faq) return;
        const origQ = faq.question || '';
        const origA = faq.answer || '';
        const newQ = edit.question != null ? edit.question : origQ;
        const newA = edit.answer != null ? edit.answer : origA;
        if (origQ !== newQ || origA !== newA) {
          pool.query(
            `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity)
             VALUES ($1, 'human_edit_faq', $2, $3, 'medium')`,
            [
              brandProfileId,
              `FAQ ${edit.index + 1}: human reviewer edited Q/A`,
              `Avoid Q: "${origQ.substring(0, 150)}" / A: "${origA.substring(0, 200)}" — prefer Q: "${newQ.substring(0, 150)}" / A: "${newA.substring(0, 200)}"`
            ]
          ).catch(e => console.error('[COMPLIANCE] FAQ mistake write error:', e.message));
          articleJson.faqs[edit.index] = { ...faq, question: newQ, answer: newA };
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
       ORDER BY pq.campaign_id NULLS LAST, pq.created_at DESC`,
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

    // Also remove the channel from publishing_queue.publish_results JSONB.
    // The PUBLISHED TO panel in the UI iterates over publish_results, so
    // until this entry is cleared the unpublished channel keeps showing up
    // (with whatever live_status the most recent log row has — including
    // 'published' if a republish followed the unpublish). The reset-channel
    // endpoint at server.js:9806 does this same write; mirroring here.
    if (deleteFromChannel) {
      const qrRow = await pool.query(
        'SELECT publish_results FROM publishing_queue WHERE id = $1',
        [queueItemId]
      ).catch(() => ({ rows: [] }));
      if (qrRow.rows.length) {
        const updatedResults = qrRow.rows[0].publish_results || {};
        delete updatedResults[channel];
        await pool.query(
          'UPDATE publishing_queue SET publish_results = $1 WHERE id = $2',
          [JSON.stringify(updatedResults), queueItemId]
        ).catch(() => {});
      }
    }

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
    // The website channel's bearerToken is a shown-once secret — never echo it
    // back to the browser. Replace it with a non-secret existence flag + last-4
    // so the UI can render "configured" / a masked value without the raw token.
    const channels = result.rows.map(row => {
      if (row.channel === 'website' && row.credentials && typeof row.credentials === 'object') {
        const { bearerToken, ...rest } = row.credentials;
        return {
          ...row,
          credentials: {
            ...rest,
            bearerTokenSet: !!bearerToken,
            ...(bearerToken ? { bearerTokenLast4: String(bearerToken).slice(-4) } : {}),
          },
        };
      }
      return row;
    });
    res.json({ success: true, channels });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/publishing/channels — upsert channel connection
// ── My Website channel (channel = 'website') ─────────────────────────────
// Lets users publish Forge-generated articles directly to their own
// self-hosted site via an authenticated webhook. Forge stores three pieces
// of state per brand under publishing_channels.credentials:
//
//   endpointUrl   — full POST target on the user's site
//   format        — 'html' | 'markdown' | 'both'
//   bearerToken   — server-generated, prefix `forge_pub_`
//
// Token is shown to the user ONCE on generate/rotate, then masked in all
// subsequent reads. Same pattern as GitHub PATs, Stripe restricted keys.
//
// Save / generate / test / delete are split into separate endpoints so the
// token survives an endpoint-URL edit (it would otherwise be wiped by the
// wholesale-overwrite in /api/publishing/channels).

// POST /api/integrations/website/:brandProfileId/config
// Body: { endpointUrl, format }
// JSONB-merges into credentials so any existing bearerToken is preserved.
app.post('/api/integrations/website/:brandProfileId/config', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  const { endpointUrl, format } = req.body;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  if (!endpointUrl || !/^https?:\/\//i.test(endpointUrl)) {
    return res.status(400).json({ error: 'endpointUrl must be a full http(s) URL' });
  }
  if (format && !['html', 'markdown', 'both'].includes(format)) {
    return res.status(400).json({ error: "format must be 'html', 'markdown', or 'both'" });
  }
  try {
    const merge = { endpointUrl: endpointUrl.replace(/\/+$/, ''), format: format || 'both' };
    await pool.query(
      `INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
       VALUES ($1, 'website', $2::jsonb, true, NOW())
       ON CONFLICT (brand_profile_id, channel)
       DO UPDATE SET credentials = publishing_channels.credentials || $2::jsonb,
                     is_active = true, updated_at = NOW()`,
      [brandProfileId, JSON.stringify(merge)]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/integrations/website/:brandProfileId/generate-token
// Generates a fresh forge_pub_<32-hex> token, JSONB-merges into credentials,
// returns the plaintext token EXACTLY ONCE. Caller is responsible for
// surfacing a "save this now, you won't see it again" UI.
app.post('/api/integrations/website/:brandProfileId/generate-token', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const bearerToken = `forge_pub_${randomBytes(32).toString('hex')}`;
    await pool.query(
      `INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
       VALUES ($1, 'website', $2::jsonb, true, NOW())
       ON CONFLICT (brand_profile_id, channel)
       DO UPDATE SET credentials = publishing_channels.credentials || $2::jsonb,
                     is_active = true, updated_at = NOW()`,
      [brandProfileId, JSON.stringify({ bearerToken })]
    );
    res.json({ success: true, bearerToken });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/integrations/website/:brandProfileId/test
// Sends a sample payload at the configured endpoint with the stored token.
// Does NOT write to publish_log — this is for user-side validation only.
// Returns { ok, status, latencyMs, responseBody, error? }.
app.post('/api/integrations/website/:brandProfileId/test', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    const r = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'website' LIMIT 1`,
      [brandProfileId]
    );
    const creds = r.rows[0]?.credentials || {};
    if (!creds.endpointUrl) return res.status(400).json({ ok: false, error: 'endpointUrl not configured' });
    if (!creds.bearerToken) return res.status(400).json({ ok: false, error: 'bearerToken not generated yet' });

    const samplePayload = {
      test: true,
      slug: 'forge-test-publish',
      title: 'Forge Test Publish — Hello from your website integration',
      excerpt: 'This is a test payload sent from Forge to verify your receiver is wired up correctly. Ignore or delete after confirming.',
      heroImageUrl: 'https://forgeintelligence.ai/og-default.png',
      canonical: `${creds.endpointUrl}/articles/forge-test-publish`,
      publishedAt: new Date().toISOString(),
      meta: { description: 'Forge test publish', ogImage: 'https://forgeintelligence.ai/og-default.png' },
      // Structured Q&A — always present (empty array on real publishes with no FAQs).
      faqs: [{ question: 'Where do FAQs come from?', answer: 'When an article has FAQs, Forge sends them here as a structured array AND embeds them inside html/markdown.' }],
      // NOTE: mirrors the REAL publish shape exactly — body-only fragment, no
      // <article>/<h1> wrapper (the title is the separate `title` field above),
      // sections start at <h2>/##, and FAQs ride inside as an article-faqs
      // section. Keep in sync with the channel === 'website' publish handler.
      ...(creds.format !== 'markdown' && {
        html: '<h2>Quick sanity check</h2><p>This is the article body, sent exactly as a real publish: heading/paragraph blocks with no outer wrapper and no title baked in (the title is the separate "title" field above). If you can read this on your site, your receiver is parsing the <code>html</code> field correctly.</p>\n<section class="article-faqs">\n<h2>Frequently asked questions</h2>\n<h3>Where do FAQs come from?</h3>\n<p>When an article has FAQs, Forge appends them to html and markdown as this section.</p>\n</section>'
      }),
      ...(creds.format !== 'html' && {
        markdown: '## Quick sanity check\n\nThis is the article body, sent exactly as a real publish: `##` sections with no `#` title (the title is the separate "title" field). If you can read this on your site, your receiver is parsing the `markdown` field correctly.\n\n## Frequently asked questions\n\n### Where do FAQs come from?\n\nWhen an article has FAQs, Forge appends them to html and markdown as this section.'
      }),
    };

    const start = Date.now();
    let resp, bodyText = '';
    try {
      resp = await fetch(creds.endpointUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${creds.bearerToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Forge-Intelligence/1.0',
        },
        body: JSON.stringify(samplePayload),
        signal: AbortSignal.timeout(15000),
      });
      bodyText = (await resp.text()).slice(0, 2000);
    } catch (e) {
      return res.json({ ok: false, error: `request failed: ${e.message}`, latencyMs: Date.now() - start });
    }
    res.json({
      ok: resp.ok,
      status: resp.status,
      latencyMs: Date.now() - start,
      responseBody: bodyText,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/integrations/website/:brandProfileId
// Soft-disconnect — marks is_active = false but preserves credentials so a
// user who reconnects within the same session doesn't have to regenerate.
app.delete('/api/integrations/website/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    await pool.query(
      `UPDATE publishing_channels SET is_active = false, updated_at = NOW()
       WHERE brand_profile_id = $1 AND channel = 'website'`,
      [brandProfileId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/publishing/channels', requireAuth, async (req, res) => {
  const { brandProfileId, channel, credentials, utmTemplate } = req.body;
  if (!brandProfileId || !channel) return res.status(400).json({ error: 'brandProfileId and channel required' });

  // Per-channel credential format validation. The actual publish endpoints all check
  // format at runtime, but failing at save-time is much friendlier — the user gets
  // an immediate "that's not the right value" instead of a delayed publish failure
  // hours or days later. Specifically guards against the failure mode where someone
  // pastes a password (or anything else) into a field expecting a structured token.
  if (channel === 'ghost' && credentials) {
    const { adminUrl, adminApiKey } = credentials;
    if (adminApiKey) {
      // Ghost Admin API Keys are id:secret format — 24 hex chars, colon, 64 hex chars.
      // We don't validate the exact lengths (Ghost may change that) but we DO check
      // the id:hex shape to catch the password-in-key-field mistake.
      const m = String(adminApiKey).trim().match(/^([0-9a-f]{16,32}):([0-9a-f]{32,128})$/i);
      if (!m) {
        return res.status(400).json({
          success: false,
          error: 'Ghost Admin API Key must be in format id:secret (hex strings separated by a colon). Copy it directly from Ghost Admin → Settings → Integrations → your custom integration. Do NOT paste your Ghost account password.',
          code: 'GHOST_ADMIN_KEY_INVALID_FORMAT'
        });
      }
    }
    if (adminUrl && !/^https?:\/\//i.test(String(adminUrl).trim())) {
      return res.status(400).json({
        success: false,
        error: 'Ghost Admin URL must start with http:// or https://',
        code: 'GHOST_ADMIN_URL_INVALID'
      });
    }
  }

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

// Targeted update for Reddit allowedSubreddits / defaultSubreddit. We can't reuse
// POST /api/publishing/channels because that wholesale-overwrites credentials —
// it would wipe the Zernio account ID. This endpoint does a JSONB merge so the
// OAuth credentials are preserved.
//
// Body: { brandProfileId, allowedSubreddits: string[], defaultSubreddit?: string }
// Subreddit names are normalized to bare form (no leading 'r/') and validated
// against Reddit's actual naming rules.
app.post('/api/publishing/channels/reddit/allowed-subreddits', requireAuth, async (req, res) => {
  const { brandProfileId, allowedSubreddits, defaultSubreddit } = req.body;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  if (!Array.isArray(allowedSubreddits)) return res.status(400).json({ success: false, error: 'allowedSubreddits must be an array' });

  // Reddit subreddit names: 3-21 chars, letters/numbers/underscores only, not starting with underscore.
  const validateSubName = (raw) => {
    const name = String(raw || '').trim().replace(/^r\//i, '').replace(/^\//, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_]{2,20}$/.test(name)) return null;
    return name;
  };

  const normalized = [];
  const invalid = [];
  for (const raw of allowedSubreddits) {
    const v = validateSubName(raw);
    if (v) {
      if (!normalized.includes(v)) normalized.push(v);  // dedupe
    } else {
      invalid.push(raw);
    }
  }
  if (invalid.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Invalid subreddit names: ${invalid.join(', ')}. Subreddit names must be 3-21 characters, letters/numbers/underscores only, not starting with an underscore.`,
      code: 'REDDIT_SUBREDDIT_NAME_INVALID'
    });
  }

  let normalizedDefault = null;
  if (defaultSubreddit !== undefined && defaultSubreddit !== null && String(defaultSubreddit).trim()) {
    normalizedDefault = validateSubName(defaultSubreddit);
    if (!normalizedDefault) {
      return res.status(400).json({ success: false, error: 'defaultSubreddit name is invalid' });
    }
    if (!normalized.includes(normalizedDefault)) {
      return res.status(400).json({ success: false, error: 'defaultSubreddit must be in allowedSubreddits' });
    }
  }

  try {
    // JSONB merge: keep all existing credential fields (zernioAccountId, OAuth tokens, etc.),
    // overwrite only allowedSubreddits + defaultSubreddit.
    const result = await pool.query(
      `UPDATE publishing_channels
         SET credentials = COALESCE(credentials, '{}'::jsonb)
                         || jsonb_build_object('allowedSubreddits', $3::jsonb, 'defaultSubreddit', $4::jsonb),
             updated_at = NOW()
       WHERE brand_profile_id = $1 AND channel = $2
       RETURNING id, credentials->'allowedSubreddits' as allowed, credentials->>'defaultSubreddit' as default_sub`,
      [brandProfileId, 'reddit', JSON.stringify(normalized), JSON.stringify(normalizedDefault)]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Reddit channel not found for this brand. Connect Reddit via Integrations first.' });
    }
    res.json({ success: true, allowedSubreddits: result.rows[0].allowed || [], defaultSubreddit: result.rows[0].default_sub || null });
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

// ── LinkedIn OAuth2 Flow (legacy — Zernio connect at bottom of file) ─────────
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


// ── Zernio OAuth Proxy ───────────────────────────────────────────────────────
// White-label OAuth flow: customer clicks Connect on Integrations card, we proxy
// through Zernio, customer authorizes on the platform (LinkedIn/Facebook/X/etc),
// Zernio redirects them back to our callback, we save zernioAccountId to creds.
//
// Each Forge brand gets its own Zernio profile (created on first connect, stored
// on brand_profiles.zernio_profile_id). Profile groups all of that brand's
// connected accounts together inside Zernio.


// 1) Kickoff: customer clicks Connect, we get an authUrl from Zernio + redirect.
app.get('/api/zernio/connect/:platform', async (req, res) => {
  const { platform } = req.params;
  const { brandProfileId } = req.query;
  if (!brandProfileId) return res.status(400).send('brandProfileId required');
  if (!process.env.ZERNIO_API_KEY) return res.status(500).send('ZERNIO_API_KEY not configured');

  try {
    // Verify brand exists; auth happens via Clerk session for the human-facing redirect
    const brandRes = await pool.query('SELECT id FROM brand_profiles WHERE id = $1', [brandProfileId]);
    if (!brandRes.rows.length) return res.status(404).send('Brand not found');

    const profileId = await getOrCreateZernioProfile(brandProfileId);

    // Where Zernio sends the user after they finish OAuth. Same host as the kickoff
    // request so dev/prod each return to themselves. Pass brandProfileId + platform
    // forward as query so the callback knows what to write.
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    const redirectUrl = `${baseUrl}/auth/zernio/callback?brandProfileId=${encodeURIComponent(brandProfileId)}&platform=${encodeURIComponent(platform)}`;

    const params = new URLSearchParams({ profileId, redirectUrl });
    const cr = await callZernio('GET', `/connect/${platform}?${params.toString()}`);
    if (!cr.ok) {
      console.error(`[Zernio] /connect/${platform} failed:`, cr.status, cr.raw?.slice(0, 300));
      return res.redirect(`/app/integrations?zernio_error=${encodeURIComponent('connect_failed')}`);
    }
    const authUrl = cr.parsed?.authUrl;
    if (!authUrl) return res.redirect(`/app/integrations?zernio_error=${encodeURIComponent('no_auth_url')}`);

    res.redirect(authUrl);
  } catch (e) {
    console.error('[Zernio connect]', e);
    res.redirect(`/app/integrations?zernio_error=${encodeURIComponent(e.message)}`);
  }
});

// 2) Callback: Zernio redirects user here after platform OAuth completes.
app.get('/auth/zernio/callback', async (req, res) => {
  const { brandProfileId, platform } = req.query;
  if (!brandProfileId || !platform) return res.redirect('/app/integrations?zernio_error=missing_params');

  try {
    // Look up the brand's Zernio profile so we can scope the accounts query
    const r = await pool.query('SELECT zernio_profile_id FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const profileId = r.rows[0]?.zernio_profile_id;
    if (!profileId) return res.redirect('/app/integrations?zernio_error=no_profile');

    // Pull all accounts and find the newly-connected one for this profile + platform.
    // Pick the most recently created — Zernio's /accounts doesn't accept a profileId
    // filter we can rely on, so filter client-side.
    const accRes = await callZernio('GET', '/accounts');
    if (!accRes.ok) {
      console.error('[Zernio callback] /accounts failed:', accRes.status, accRes.raw?.slice(0, 300));
      return res.redirect(`/app/integrations?zernio_error=${encodeURIComponent('accounts_fetch_failed')}`);
    }
    const accounts = accRes.parsed?.accounts || [];
    const matches = accounts
      .filter(a => a.platform === platform)
      .filter(a => {
        const pid = typeof a.profileId === 'object' ? a.profileId?._id : a.profileId;
        return pid === profileId;
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    if (!matches.length) {
      console.warn(`[Zernio callback] no ${platform} account found for profile ${profileId}`);
      return res.redirect(`/app/integrations?zernio_error=${encodeURIComponent('account_not_found')}`);
    }

    const acc = matches[0];
    const meta = acc.metadata || {};
    const newCreds = {
      zernioAccountId: acc._id,
      zernioProfileId: profileId,
      zernioPlatform: platform,
      zernioDisplayName: acc.displayName || acc.username || meta.pageInfo?.name || meta.organizationInfo?.name || 'Connected account',
      zernioConnectedAt: new Date().toISOString(),
      // Mirror a few fields into the existing creds shape so legacy code that reads
      // creds.name / creds.authorUrn keeps working until we fully migrate it.
      name: acc.displayName || meta.pageInfo?.name || meta.organizationInfo?.name || acc.username || 'Connected via Zernio'
    };

    // MERGE — preserve existing creds keys so manual fields aren't wiped
    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, $2, $3, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = publishing_channels.credentials || EXCLUDED.credentials,
            is_active = true,
            updated_at = NOW()
    `, [brandProfileId, platform, JSON.stringify(newCreds)]);

    res.redirect(`/app/integrations?zernio_connected=${encodeURIComponent(platform)}`);
  } catch (e) {
    console.error('[Zernio callback]', e);
    res.redirect(`/app/integrations?zernio_error=${encodeURIComponent(e.message)}`);
  }
});

// 3) Disconnect: remove the Zernio-managed account.
app.post('/api/zernio/disconnect', requireAuth, async (req, res) => {
  const { brandProfileId, platform } = req.body;
  if (!brandProfileId || !platform) return res.status(400).json({ error: 'brandProfileId and platform required' });
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });

  try {
    const r = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2`,
      [brandProfileId, platform]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Channel not connected' });
    const creds = r.rows[0].credentials || {};
    const accountId = typeof creds === 'string' ? JSON.parse(creds).zernioAccountId : creds.zernioAccountId;
    if (!accountId) return res.status(400).json({ error: 'No Zernio account on this channel' });

    // Delete the account on Zernio
    const dr = await callZernio('DELETE', `/accounts/${accountId}`);
    if (!dr.ok && dr.status !== 404) {
      console.error('[Zernio disconnect] DELETE failed:', dr.status, dr.raw?.slice(0, 300));
      // Continue anyway — we still want to clean up Forge's row
    }

    // Strip Zernio-specific keys from creds (preserve everything else)
    await pool.query(
      `UPDATE publishing_channels
         SET credentials = credentials - 'zernioAccountId' - 'zernioProfileId' - 'zernioPlatform' - 'zernioDisplayName' - 'zernioConnectedAt',
             is_active = (credentials - 'zernioAccountId' - 'zernioProfileId') ? 'accessToken',
             updated_at = NOW()
       WHERE brand_profile_id = $1 AND channel = $2`,
      [brandProfileId, platform]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('[Zernio disconnect]', e);
    res.status(500).json({ error: e.message });
  }
});


// HubSpot integration removed 2026-05-09. The HubSpot public API gates
// email-template creation behind Marketing Hub Pro+ at every endpoint we
// could reach (legacy v2, modern v3 source-code, snippets, sales templates).
// Sales Hub Starter and Free can only create email templates via HubSpot's
// internal UI, which has stricter scope checks than any public API.
//
// Replaced with an in-app 'Copy for HubSpot' button on each email card
// in the Email Campaign Generator. User clicks copy, opens HubSpot
// Sales > Templates > New > Source view, pastes. Two clicks, no OAuth,
// no paywalls, no API rate limits.

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
    const copy = stripSocialMarkdown(copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '');
    res.json({ success: true, copy });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/publishing/publish', async (req, res) => {
  // Allow scheduler to call without user auth via adminPassword
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
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

    // Article-only queue: load from the per-brand generated_content_* table.
    // (Social-post queue items removed in the May 2 unwind.)
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
    // Campaign generator doesn't pre-generate images — create one now if missing.
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

    // Load existing publish_log entries for this queue item — used to skip already-published channels.
    // Critical: also require live_status to still be live. After an unpublish, status stays
    // 'published' (it really did publish, that's history) but live_status flips to 'deleted'.
    // The old query (status='published' alone) treated unpublished-then-republished targets as
    // duplicates and silently skipped them with a fake "Already published" response — the toast
    // would say success but nothing actually hit the channel.
    const existingLogRes = await pool.query(
      `SELECT channel FROM publish_log
       WHERE queue_item_id = $1
         AND status = 'published'
         AND (live_status IS NULL OR live_status = 'published')`,
      [queueItemId]
    ).catch(() => ({ rows: [] }));
    const alreadyPublished = new Set(existingLogRes.rows.map(r => r.channel));

    for (const channel of targets) {
      const chConfig = channelMap[channel];
      if (!chConfig) { results[channel] = { status: 'error', error: 'Channel not connected' }; continue; }

      // Skip channels already successfully published — prevents double-posting.
      // Pull the prior published URL from the publish_log so the response object has
      // it (FE needs url to render the View post link). Without this, the response
      // object has no url for the skipped channel and the FE falls back to no-link.
      if (alreadyPublished.has(channel)) {
        let priorUrl = null;
        try {
          const pr = await pool.query(
            `SELECT published_url FROM publish_log
             WHERE queue_item_id = $1 AND channel = $2 AND status = 'published'
             ORDER BY attempted_at DESC LIMIT 1`,
            [queueItemId, channel]
          );
          priorUrl = pr.rows[0]?.published_url || null;
        } catch {}
        results[channel] = {
          status: 'published',
          skipped: true,
          message: 'Already published to this channel',
          ...(priorUrl ? { url: priorUrl } : {}),
        };
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
          // ── Zernio-routed LinkedIn publish (preferred) ──
          // If this brand has been migrated to Zernio (zernioAccountId set on the
          // channel credentials), route through Zernio's API. Otherwise fall through
          // to the legacy direct LinkedIn UGC Posts API. Per-brand opt-in.
          if (creds.zernioAccountId) {
            try {
              const articleJson = article.article_json || {};
              const sections = articleJson.sections || [];
              const postCopyOverride = (req.body.postCopy || {})[channel];
              const articleUrl = `${forgeArticleUrl}${utmString ? '?' + utmString : ''}`;

              // Generate post copy the same way as the legacy path so behavior matches.
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
                  postText = stripSocialMarkdown(copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '');
                } catch(e) {
                  postText = `${article.title}\n\n${sections.slice(0,3).map(s => s.heading).filter(Boolean).join(' · ')}\n\nRead more: ${articleUrl}`;
                }
              }

              const zr = await zernioPublish({
                platform: 'linkedin',
                accountId: creds.zernioAccountId,
                content: postText
              });
              results[channel] = {
                status: 'published',
                url: zr.postUrl,
                postId: zr.postId,
                // Zernio's internal _id — needed by analytics sync for Zernio lookups
                zernioPostId: zr.zernioPostId,
                via: 'zernio',
                utmParams
              };
              // Write publish_log entry HERE (the one at the end of the for-loop body
              // is skipped by `continue` below). Without this, publish_log stays empty
              // for Zernio publishes — breaking analytics sync, unpublish, and the
              // 'Live'/'Deleted' chips in the queue UI that read from publish_log.
              await pool.query(
                `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                  queueItemId, item.brand_profile_id, item.content_id, channel,
                  'published',
                  JSON.stringify(results[channel]),
                  JSON.stringify(utmParams),
                  zr.postUrl,
                  null
                ]
              ).catch(e => console.error('[PUBLISH] zernio publish_log insert failed:', e.message));
              continue;  // skip the legacy direct-API code below
            } catch (zerr) {
              // Zernio failed — record the error and fall through to legacy path so we have a fallback.
              // If creds.zernioOnly is set, throw instead of falling through.
              if (creds.zernioOnly) {
                throw zerr;
              }
              console.warn(`[PUBLISH] Zernio LinkedIn publish failed, falling back to direct API: ${zerr.message}`);
              // continue into legacy block below
            }
          }

          // ── Legacy direct LinkedIn UGC Posts API (fallback) ──
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
                postText = stripSocialMarkdown(copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '');
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
          const articleUrl = forgeArticleUrl;
          const fullTweetUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

          // Priority 1: user-edited/generated post copy from the UI (postCopy[channel]).
          // Priority 2: fallback to a trimmed title + URL that fits X's 280-char limit.
          //
          // X length math note: X auto-wraps every URL into t.co, which counts as exactly
          // 23 characters in X's tweet length count regardless of the real URL length.
          // So we compute X-equivalent length by replacing every URL with 23 placeholder
          // chars before measuring — otherwise long UTM-laden URLs (200+ chars) make our
          // math think the title has zero room and we ship "GE" + URL or just a bare URL.
          const URL_RE = /https?:\/\/[^\s]+/g;
          const xLen = (s) => s.replace(URL_RE, 'x'.repeat(23)).length;
          const X_URL_COST = 23;

          const postCopyOverride = (req.body.postCopy || {})[channel];
          let tweetText;
          if (postCopyOverride && postCopyOverride.trim()) {
            tweetText = postCopyOverride.trim();
            // Hard enforce 280 limit using X-aware character counting
            if (xLen(tweetText) > 280) {
              console.warn(`[X] Post copy was ${xLen(tweetText)} X-chars, truncating to 280`);
              // Find the LAST URL in the text — typically at end after "\n\nRead more: "
              const urls = [...tweetText.matchAll(URL_RE)];
              const lastUrlMatch = urls[urls.length - 1];
              if (lastUrlMatch && lastUrlMatch.index > 0) {
                const urlPart = lastUrlMatch[0];
                const bodyPart = tweetText.slice(0, lastUrlMatch.index).trim();
                const maxBody = 280 - X_URL_COST - 2; // 2 for \n\n separator
                tweetText = bodyPart.slice(0, Math.max(0, maxBody)).trim() + '\n\n' + urlPart;
              } else {
                tweetText = tweetText.slice(0, 277) + '...';
              }
            }
          } else {
            // Fallback — title-first, fits under 280. Use X_URL_COST not the raw URL length.
            const titleMax = 280 - X_URL_COST - 2; // 2 for \n\n separator
            const titleTrimmed = (article.title || '').slice(0, Math.max(0, titleMax));
            tweetText = `${titleTrimmed}\n\n${fullTweetUrl}`;
          }
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
          const creds = chConfig.credentials || {};

          // ── Priority 0: Zernio publish path ──
          if (creds.zernioAccountId) {
            const articleUrl = forgeArticleUrl;
            const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;
            const fbPostCopyOverride = (req.body.postCopy || {})[channel];
            let fbMessage;
            if (fbPostCopyOverride && fbPostCopyOverride.trim()) {
              fbMessage = fbPostCopyOverride.trim();
            } else {
              fbMessage = `${article.title}\n\n${utmUrl}`;
              try {
                const haiku = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 600,
                  messages: [{ role: 'user', content: `Write a compelling Facebook post for a company page promoting this article. 2–3 short paragraphs. No hashtag spam — max 3 relevant tags. Include the URL ${utmUrl} naturally.\n\nPlain text only — Facebook does not render markdown. Do not use # for headings or **double asterisks** for emphasis.\n\nArticle title: ${article.title}\n\nArticle excerpt: ${(article.article_json?.sections?.[0]?.body || '').slice(0, 500)}` }]
                });
                fbMessage = stripSocialMarkdown(haiku.content[0]?.text) || fbMessage;
              } catch(e) {
                console.warn('[FB-ZERNIO] Haiku post copy failed:', e.message);
              }
            }

            try {
              const zr = await zernioPublish({
                platform: 'facebook',
                accountId: creds.zernioAccountId,
                content: fbMessage
              });
              results[channel] = {
                status: 'published',
                url: zr.postUrl,
                postId: zr.postId,
                // Zernio's internal _id — needed by analytics sync for Zernio lookups.
                // Zernio's /analytics endpoint expects this, NOT the Facebook platform URN
                // (pageId_postId). Without it, the sync hits 404 on every Zernio-published
                // Facebook post — which is what was happening before this was added.
                zernioPostId: zr.zernioPostId,
                via: 'zernio',
                utmParams
              };
              await pool.query(
                `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [queueItemId, item.brand_profile_id, item.content_id, channel, 'published',
                 JSON.stringify(results[channel]), JSON.stringify(utmParams), zr.postUrl, null]
              ).catch(e => console.error('[PUBLISH] zernio facebook publish_log insert failed:', e.message));
              continue;
            } catch(zerr) {
              if (creds.zernioOnly || creds.provider === 'zernio') {
                throw new Error(`Facebook via Zernio: ${zerr.message}`);
              }
              console.error('[FB-ZERNIO] Failed, falling through to legacy:', zerr.message);
            }
          }

          // ── Legacy: Pipedream / direct Graph API paths ──
          const pipedreamAccountId = creds.pipedream_account_id;

          // ─── Priority 1: Pipedream workflow URL (global env var, multi-tenant) ───
          // Pipedream's connector AI builder gave us a workflow URL that uses the right
          // Facebook Pages connector with proper scopes. The workflow URL is global Forge
          // infrastructure (env var, not per-brand) — every customer's publish hits the same
          // URL. Pipedream looks up which customer's stored Facebook OAuth tokens to use via
          // the x-pd-external-user-id header (which is the brand_profile_id, set during the
          // existing Connect flow when the customer authorized Pipedream's pre-approved app).
          const pipedreamWorkflowUrl = process.env.FACEBOOK_PIPEDREAM_WORKFLOW_URL;
          if (pipedreamWorkflowUrl && pipedreamAccountId) {
            const articleUrlWf = forgeArticleUrl;
            const utmUrlWf = `${articleUrlWf}${utmString ? '?' + utmString : ''}`;
            const fbPostCopyOverrideWf = (req.body.postCopy || {})[channel];
            let fbMessageWf;
            if (fbPostCopyOverrideWf && fbPostCopyOverrideWf.trim()) {
              fbMessageWf = fbPostCopyOverrideWf.trim();
            } else {
              fbMessageWf = `${article.title}\n\n${utmUrlWf}`;
              try {
                const haiku = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 600,
                  messages: [{ role: 'user', content: `Write a compelling Facebook post for a company page promoting this article. 2–3 short paragraphs. No hashtag spam — max 3 relevant tags. Include the URL ${utmUrlWf} naturally.\n\nPlain text only — Facebook does not render markdown. Do not use # for headings or **double asterisks** for emphasis.\n\nArticle title: ${article.title}\n\nArticle excerpt: ${(article.article_json?.sections?.[0]?.body || '').slice(0, 500)}` }]
                });
                fbMessageWf = stripSocialMarkdown(haiku.content[0]?.text) || fbMessageWf;
              } catch (e) {
                console.warn('[FB] Haiku post copy failed:', e.message);
              }
            }
            try {
              // Pipedream Connect lookup: x-pd-external-user-id tells Pipedream which customer's
              // stored OAuth credentials to use when the workflow's Facebook step fires.
              // pageId comes from creds.pageId (set when customer picked a Page after OAuth).
              const wfRes = await fetch(pipedreamWorkflowUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-pd-external-user-id': item.brand_profile_id,
                  'x-pd-environment': process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'production',
                },
                body: JSON.stringify({
                  pageId: creds.pageId || null,
                  title: article.title,
                  message: fbMessageWf,
                  link: utmUrlWf,
                  forgeMeta: { brandProfileId: item.brand_profile_id, contentId: item.content_id, queueItemId: queueItemId, publishedAt: new Date().toISOString() }
                }),
              });
              const wfData = await wfRes.json().catch(() => ({}));
              if (!wfRes.ok || wfData.error || wfData.success === false) {
                throw new Error(wfData.error || wfData.message || `Pipedream workflow returned ${wfRes.status}`);
              }
              const fbPostId = wfData.postId || wfData.id || null;
              const fbPostUrl = wfData.url || (fbPostId ? `https://facebook.com/${fbPostId}` : null);
              results[channel] = { status: 'published', postId: fbPostId, url: fbPostUrl, utmParams, via: 'pipedream-workflow' };
              continue;  // skip the legacy path — we've already published via workflow
            } catch(e) {
              console.error('[FB-WORKFLOW]', e.message);
              throw new Error(e.message);
            }
          }

          // Legacy path: pipedreamProxy via Pipedream Connect (existing infrastructure) — falls through if no workflow URL.
                    
          const articleUrl = forgeArticleUrl;
          const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

          // Priority 1: user-edited/generated post copy from the UI.
          // Priority 2: generate via Haiku at publish time.
          // Priority 3 (fallback): title + URL.
          const fbPostCopyOverride = (req.body.postCopy || {})[channel];
          let fbMessage;
          if (fbPostCopyOverride && fbPostCopyOverride.trim()) {
            fbMessage = fbPostCopyOverride.trim();
          } else {
            fbMessage = `${article.title}\n\n${utmUrl}`;
            try {
              const haiku = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                messages: [{
                  role: 'user',
                  content: `Write a compelling Facebook post for a company page promoting this article. 2–3 short paragraphs. No hashtag spam — max 3 relevant tags. Include the URL on its own line at the end.\n\nPlain text only — Facebook does not render markdown. Do not use # for headings or **double asterisks** for emphasis.\n\nArticle title: ${article.title}\nArticle URL: ${utmUrl}`
                }]
              });
              fbMessage = stripSocialMarkdown(haiku.content[0]?.text) || fbMessage;
            } catch (e) {
              console.warn('[FB] Haiku post copy failed, using fallback:', e.message);
            }
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
              
              // Page ID is set via Integrations page picker (/api/facebook/pipedream/select-page), no runtime discovery needed.
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
          // ── Reddit publish via Zernio — brand-owned subreddits ONLY ──
          // Reddit is NOT like LinkedIn/Facebook. The destination is per-post and
          // posting to the wrong sub gets brands banned. So we enforce two rules:
          //   1) The brand must have an allowedSubreddits[] in their channel creds,
          //      populated via the Integrations UI. Each entry is a subreddit name
          //      the brand has explicit permission to post in (typically subs they mod
          //      or actively contribute to).
          //   2) The publish call must specify which subreddit from that allowlist
          //      to target this time (publishOptions.reddit.subreddit). If unspecified,
          //      we default to the FIRST allowed subreddit.
          //
          // Anything outside the allowlist is rejected with a clear error so brands
          // can't accidentally post to r/marketing or any random sub Zernio might
          // have a default for.

          if (!creds.zernioAccountId) {
            throw new Error('Reddit must be connected via Zernio. Visit /app/integrations to connect.');
          }

          const allowedSubreddits = Array.isArray(creds.allowedSubreddits) ? creds.allowedSubreddits.filter(Boolean) : [];
          if (allowedSubreddits.length === 0) {
            throw new Error('No allowed subreddits configured. Add subreddits you have permission to post in under Integrations → Reddit → Allowed subreddits.');
          }

          // Per-publish target selection. Order of precedence:
          //   1) req.body.publishOptions.reddit.subreddit (per-publish picker, future Phase 4)
          //   2) creds.defaultSubreddit (brand default set in Integrations)
          //   3) first entry in allowedSubreddits (sane fallback)
          const requestedSub = (req.body.publishOptions?.reddit?.subreddit || creds.defaultSubreddit || allowedSubreddits[0] || '').replace(/^r\//, '');
          if (!allowedSubreddits.map(s => s.replace(/^r\//, '')).includes(requestedSub)) {
            throw new Error(`Subreddit '${requestedSub}' is not in your allowed list. Add it under Integrations → Reddit → Allowed subreddits before publishing.`);
          }

          const articleUrl = forgeArticleUrl;
          const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

          // For Reddit link posts, `content` is the post TITLE (not a body). Reddit titles
          // are permanent and capped at 300 chars. The article URL handles the rest — Reddit
          // fetches OG preview from it. No Haiku body generation needed for link posts.
          //
          // User override flow: if postCopy[reddit] is set, use its first line as the title.
          // Otherwise default to the article title verbatim.
          const postCopyOverride = (req.body.postCopy || {})[channel];
          const redditTitle = (postCopyOverride && postCopyOverride.trim().split('\n')[0].slice(0, 300)) || (article.title || '').slice(0, 300);
          let redditText = redditTitle;  // back-compat name in case anything below references it

          // Skip Haiku generation — link post only needs the title.
          if (false) {
            const articleJson = article.article_json || {};
            const sections = articleJson.sections || [];
            try {
              const copyRes = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                messages: [{ role: 'user', content: `Write a Reddit text-post body for r/${requestedSub} promoting this article. Format: 2-3 short paragraphs that introduce the core insight without giving away the answer. End with a single line: "Full breakdown: ${utmUrl}"\n\nTone: conversational, like a practitioner sharing what they learned, NOT corporate marketing. No hashtags, no emojis, no headlines, no marketing-speak.\n\nArticle title: ${article.title}\nKey sections: ${sections.slice(1,4).map(s => s.heading).filter(Boolean).join(', ')}\n\nOutput only the post body, plain text.` }]
              });
              redditText = copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '';
            } catch(e) {
              console.warn('[REDDIT-ZERNIO] Haiku post copy failed:', e.message);
              redditText = `${article.title}\n\n${utmUrl}`;
            }
          }

          // Zernio's /posts API for Reddit takes the subreddit via platformSpecificData.
          // We can't use zernioPublish() helper because Reddit needs platformSpecificData;
          // inline the callZernio() request. See Zernio_API_Docs L9430+ for Reddit schema:
          // when platformSpecificData.url is set, content becomes the post title (link post).
          // For text posts, omit url and content's first line becomes the title.
          try {
            const zResult = await callZernio('POST', '/posts', {
              content: redditTitle,
              publishNow: true,
              platforms: [{
                platform: 'reddit',
                accountId: creds.zernioAccountId,
                platformSpecificData: {
                  subreddit: requestedSub,
                  url: utmUrl  // presence of url makes this a link post; content becomes the title
                }
              }]
            });

            if (!zResult.ok) {
              throw new Error(`Zernio reddit publish failed (${zResult.status}): ${zResult.raw?.slice(0, 300) || 'no body'}`);
            }
            const post = zResult.parsed?.post;
            const platformResult = (post?.platforms || []).find(p => p.platform === 'reddit');
            if (!platformResult || platformResult.status !== 'published') {
              const errMsg = platformResult?.error || platformResult?.platformSpecificData?.lastError || 'Zernio did not publish';
              throw new Error(`Reddit (Zernio): ${errMsg}`);
            }

            results[channel] = {
              status: 'published',
              url: platformResult.platformPostUrl,
              postId: platformResult.platformPostId || post._id,
              subreddit: requestedSub,
              via: 'zernio',
              utmParams
            };

            // Write publish_log inside the dispatch (continue skips the loop-end writer).
            await pool.query(
              `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                queueItemId, item.brand_profile_id, item.content_id, channel,
                'published',
                JSON.stringify(results[channel]),
                JSON.stringify(utmParams),
                platformResult.platformPostUrl,
                null
              ]
            ).catch(e => console.error('[PUBLISH] reddit zernio publish_log insert failed:', e.message));
            continue;
          } catch (rzerr) {
            // No fallback for Reddit — if Zernio fails, the publish fails. We don't have
            // direct OAuth tokens for migrated brands, and even if we did, the brand-owned
            // allowlist guarantee would still be the right safety bound.
            throw rzerr;
          }

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

          const articleUrl = forgeArticleUrl;
          const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

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

        } else if (channel === 'website') {
          // ── My Website webhook publish ──
          // POSTs the article to the customer-configured endpoint with a
          // bearer token. The customer's receiver is responsible for storing
          // / rendering the content. We include both html and markdown in
          // the payload by default (format='both'); customers can narrow
          // to one if they want a smaller payload.
          if (!creds.endpointUrl) throw new Error('My Website: endpointUrl not configured');
          if (!creds.bearerToken) throw new Error('My Website: bearerToken not generated');

          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const faqs = Array.isArray(articleJson.faqs) ? articleJson.faqs.filter(f => f?.question && f?.answer) : [];
          const htmlContent = sections.map(s =>
            `${s.heading ? `<h2>${s.heading}</h2>` : ''}<p>${s.body || s.content || ''}</p>`
          ).join('\n') + (faqs.length
            ? `\n<section class="article-faqs">\n<h2>Frequently asked questions</h2>\n${faqs.map(f => `<h3>${f.question}</h3>\n<p>${f.answer}</p>`).join('\n')}\n</section>`
            : '');
          const markdownContent = sections.map(s =>
            `${s.heading ? `## ${s.heading}\n\n` : ''}${s.body || s.content || ''}`
          ).join('\n\n') + (faqs.length
            ? `\n\n## Frequently asked questions\n\n${faqs.map(f => `### ${f.question}\n\n${f.answer}`).join('\n\n')}`
            : '');
          // Prefer the article's own meta description for excerpt — it's the
          // hand-curated short summary. Falls back to a slice of the first
          // section body only when the description is missing. Without this
          // preference, receivers that render `excerpt` as a subtitle/lead
          // end up showing the first paragraph twice (once as subtitle,
          // once as the opening body paragraph).
          const excerpt = (articleJson.metaDescription || '').trim()
            || (sections[0]?.body || sections[0]?.content || '').replace(/<[^>]+>/g, '').slice(0, 200);

          const payload = {
            slug: articleSlug,
            title: article.title,
            excerpt,
            heroImageUrl: article.hero_image_url || articleJson.hero_image_url || null,
            canonical: forgeArticleUrl,
            publishedAt: new Date().toISOString(),
            meta: {
              description: articleJson.metaDescription || excerpt,
              ogImage: article.hero_image_url || articleJson.hero_image_url || null,
              utm: utmParams,
            },
            // Structured Q&A — always present (empty array if none). The same
            // FAQs are also embedded in html/markdown above; this field is for
            // receivers that want to render/store them without parsing markup.
            faqs: faqs.map(f => ({ question: f.question, answer: f.answer })),
            ...(creds.format !== 'markdown' && { html: htmlContent }),
            ...(creds.format !== 'html' && { markdown: markdownContent }),
          };

          const start = Date.now();
          const r = await fetch(creds.endpointUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${creds.bearerToken}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Forge-Intelligence/1.0',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
          });
          const respText = (await r.text()).slice(0, 2000);
          if (!r.ok) throw new Error(`Receiver returned HTTP ${r.status}: ${respText.slice(0, 300)}`);

          // If the receiver returns JSON with a `url` field, use it as the
          // published_url so the Publishing Queue's "View on site" link works.
          let publishedUrl = null;
          try {
            const parsed = JSON.parse(respText);
            if (typeof parsed?.url === 'string') publishedUrl = parsed.url;
          } catch { /* receiver returned non-JSON, that's fine */ }
          if (!publishedUrl) publishedUrl = payload.canonical;

          results[channel] = {
            status: 'published',
            url: publishedUrl,
            postId: payload.slug,
            latencyMs: Date.now() - start,
            utmParams,
          };

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

    // Strip transient fields before persisting. CRITICAL: skipped channels are
    // EXCLUDED from persistResults entirely — their state is already in the JSONB
    // from the original publish call. Including them would let the shallow-merge
    // operator (||) overwrite their existing url-bearing entry with a status-only
    // shape (the bug that wrecked X and LinkedIn URLs in real data on May 5–6).
    const persistResults = Object.fromEntries(
      Object.entries(results)
        .filter(([_ch, r]) => !r.skipped)
        .map(([ch, r]) => [
          ch,
          r.status === 'published'
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

    // Mirror status onto the parent generated_content_<brand> row so the
    // Performance Dashboard (which filters on content.status='published')
    // sees it. Before this, the publish endpoint updated publishing_queue
    // + publish_log + memories but left content.status stuck at 'draft' —
    // every successfully-published article was invisible in analytics
    // until manual SQL backfill.
    //
    // Brand-scoped table name: generated_content_{brand_profile_id-with-dashes-as-underscores}.
    // Wrapped in try/catch — channel publishes already succeeded; status
    // sync is best-effort and a write failure here shouldn't 500 the
    // response.
    if (allPublished || newStatus === 'published') {
      try {
        const brandTable = `generated_content_${item.brand_profile_id.replace(/-/g, '_')}`;
        await pool.query(
          `UPDATE ${brandTable}
              SET status = 'published',
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('draft', 'pending_review')`,
          [item.content_id]
        );
      } catch (e) {
        console.error('[PUBLISH] Parent content status sync failed:', e.message);
      }
    }

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
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
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
      const logRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                ct.title, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'linkedin' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      const credRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'linkedin' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const creds = credRes.rows[0]?.credentials || {};
      const isZernio = creds.provider === 'zernio' && !!process.env.ZERNIO_API_KEY;
      const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
      console.log(`[Analytics/LinkedIn] Found ${logRes.rows.length} published posts, provider=${isZernio ? 'zernio' : 'legacy'}, hasToken=${!!token}`);

      for (const row of logRes.rows) {
        try {
          const rd = row.response_data || {};
          const postId = rd.postId || rd.post_id || rd.id;
          // Zernio's internal _id, populated for posts published after the
          // Zernio migration. Pre-migration posts have null here; sync routes
          // them via legacy LinkedIn API fallback below.
          const zernioPostId = rd.zernioPostId || rd.zernio_post_id || null;
          if (!postId) { errors.push({ contentId: row.content_id, error: 'no_post_id' }); continue; }

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};
          let dataSource = 'none';

          // Use Zernio analytics ONLY when:
          //   1. Brand is migrated to Zernio (provider === 'zernio')
          //   2. This specific post has a Zernio _id (i.e. was published through Zernio)
          // Pre-Zernio posts on Zernio-routed brands fall through to legacy fallback.
          if (isZernio && zernioPostId) {
            // ── Zernio Analytics path (uses Zernio _id, NOT platform URN) ──
            let analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(zernioPostId)}`);
            // Zernio analytics are eventually-consistent — the first GET often returns
            // 202 (accepted, still computing). Re-poll a couple times so a manual
            // refresh resolves freshly-published posts on the spot instead of parking
            // them pending until the user happens to refresh again.
            for (let zAttempt = 0; analyticsRes.status === 202 && zAttempt < 2; zAttempt++) {
              await new Promise(r => setTimeout(r, 1500));
              analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(zernioPostId)}`);
              console.log(`[Analytics/LinkedIn] 202 re-poll #${zAttempt + 1} for ${zernioPostId}: HTTP ${analyticsRes.status}`);
            }
            console.log(`[Analytics/LinkedIn] Zernio analytics for ${zernioPostId} (URN ${postId}): HTTP ${analyticsRes.status}`);

            if (analyticsRes.status === 202) {
              // Ensure a placeholder content_analytics row exists so the article
              // appears in Performance Dashboard while we wait for Zernio. DO NOTHING
              // on conflict — never clobber real metrics that arrived in a later sync.
              await pool.query(
                `INSERT INTO content_analytics
                   (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1, $2, 'linkedin', $3, 0, 0, 0, 0, 0, 0, 0, $4::jsonb, COALESCE($5, NOW()), NOW())
                 ON CONFLICT (content_id, channel) DO NOTHING`,
                [brandProfileId, row.content_id, postId, JSON.stringify({ pending: true, zernioPostId }), row.published_at]
              ).catch(e => console.error('[Analytics/LinkedIn] pending placeholder failed:', e.message));
              console.log(`[Analytics/LinkedIn] Sync pending for ${zernioPostId} — placeholder inserted, will retry next sync`);
              continue;
            }
            if (analyticsRes.status === 424) {
              console.log(`[Analytics/LinkedIn] All platforms failed for ${zernioPostId}`);
              errors.push({ contentId: row.content_id, error: 'zernio_analytics_424' });
              continue;
            }
            if (!analyticsRes.ok) {
              console.log(`[Analytics/LinkedIn] Zernio analytics error: ${analyticsRes.status}`, analyticsRes.raw?.slice(0, 200));
              errors.push({ contentId: row.content_id, error: `zernio_analytics_${analyticsRes.status}` });
              continue;
            }

            const analytics = analyticsRes.parsed;
            // Zernio analytics response shape (verified via probe): metrics live at
            // analytics.platformAnalytics[].analytics for the LinkedIn entry, OR at
            // analytics.analytics as the rolled-up post-level metrics.
            const platformAnalytics = analytics?.platformAnalytics || [];
            const liEntry = platformAnalytics.find(p => p.platform === 'linkedin');
            const liMetrics = liEntry?.analytics
              || analytics?.analytics
              || analytics?.post?.analytics
              || {};

            impressions = liMetrics.impressions || liMetrics.views || liMetrics.impression_count || 0;
            clicks      = liMetrics.clicks || liMetrics.link_clicks || liMetrics.clickCount || 0;
            reactions   = liMetrics.likes || liMetrics.reactions || liMetrics.likeCount || 0;
            comments    = liMetrics.comments || liMetrics.replies || liMetrics.commentCount || 0;
            reposts     = liMetrics.shares || liMetrics.reposts || liMetrics.repostCount || liMetrics.shareCount || 0;
            rawData     = { zernio: analytics };
            dataSource  = 'zernio';
            console.log(`[Analytics/LinkedIn] Zernio metrics for ${zernioPostId}: ${impressions} impr, ${reactions} likes, ${comments} comments, ${reposts} shares, ${clicks} clicks`);

          } else if (token) {
            // ── Legacy direct LinkedIn API path ──
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
              }
            } catch(e) { /* socialActions unavailable */ }

            try {
              const encodedPostId = encodeURIComponent(postId);
              const statsRes = await fetch(
                `https://api.linkedin.com/v2/shareStatistics?q=shares&shares[0]=${encodedPostId}&projection=(elements*(totalShareStatistics))`,
                { headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': '202401' } }
              );
              if (statsRes.ok) {
                const statsData = await statsRes.json();
                const stats = statsData?.elements?.[0]?.totalShareStatistics || {};
                if (stats.impressionCount > 0) {
                  impressions = stats.impressionCount || 0;
                  clicks      = stats.clickCount     || 0;
                  reactions   = Math.max(reactions, stats.likeCount  || 0);
                  comments    = Math.max(comments,  stats.commentCount || 0);
                  reposts     = Math.max(reposts,   stats.shareCount  || 0);
                  rawData     = { ...rawData, shareStatistics: stats };
                  dataSource  = 'shareStatistics';
                }
              }
            } catch(e) { /* MDP not approved */ }
          } else {
            console.log(`[Analytics/LinkedIn] No credentials — skipping ${postId}`);
            continue;
          }

          if (dataSource === 'none') {
            console.log(`[Analytics/LinkedIn] No data returned for ${postId} — skipping`);
            continue;
          }

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
               impressions      = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.impressions ELSE content_analytics.impressions END,
               clicks           = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.clicks      ELSE content_analytics.clicks      END,
               ctr              = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.ctr         ELSE content_analytics.ctr         END,
               engagement_rate  = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.engagement_rate ELSE content_analytics.engagement_rate END,
               reactions        = GREATEST(COALESCE(content_analytics.reactions, 0), EXCLUDED.reactions),
               comments         = GREATEST(COALESCE(content_analytics.comments, 0),  EXCLUDED.comments),
               reposts          = GREATEST(COALESCE(content_analytics.reposts, 0),   EXCLUDED.reposts),
               raw_data         = (COALESCE(content_analytics.raw_data, '{}'::jsonb) - 'pending') || EXCLUDED.raw_data,
               synced_at        = NOW(),
               campaign_id      = COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
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

      const xHasOAuth2 = !!xCreds.oauth2AccessToken;
      const xHasOAuth1 = !!(xCreds.apiKey || process.env.X_OAUTH1CONSUMER_KEY)
        && !!(xCreds.accessToken || process.env.X_OAUTH1ACCESS_TOKEN);
      const xSyncedStart = synced.length;
      const xErrorsStart = errors.length;
      console.log(`[Analytics/X] Found ${xLogRes.rows.length} published posts for brand=${brandProfileId}, oauth2=${xHasOAuth2}, oauth1=${xHasOAuth1}`);

      // Fail fast if no credentials at all — otherwise the per-row loop hits
      // the silent `if (!xApiKey || !xAccessToken) continue;` for every tweet
      // and the response comes back synced=0, errors=[] which is
      // indistinguishable from "nothing to sync."
      if (xLogRes.rows.length > 0 && !xHasOAuth2 && !xHasOAuth1) {
        console.warn(`[Analytics/X] No credentials configured (no OAuth2 token, no OAuth1 fallback) — skipping all ${xLogRes.rows.length} eligible posts`);
        errors.push({ channel: 'x', error: 'no_x_credentials_configured', detail: 'Connect X in Integrations or configure X_OAUTH1CONSUMER_KEY / X_OAUTH1ACCESS_TOKEN env vars.' });
      } else {
        // Track refresh state across the loop: refresh at most once per sync
        // call so a permanently-bad refresh_token can't burn a request per
        // tweet. Mirrors the publish path's pattern (server.js:11038-11071).
        let xRefreshAttempted = false;
        let xAuthHardFailed = false;
        for (const row of xLogRes.rows) {
          if (xAuthHardFailed) break;
          try {
            const rd = row.response_data || row.queue_results?.x || {};
            const tweetId = rd.tweetId || rd.id
              || (row.published_url?.match(/\/status\/(\d+)/)?.[1]);
            if (!tweetId) {
              console.warn(`[Analytics/X] no_tweet_id_in: ${row.published_url || '(no published_url)'} content=${row.content_id}`);
              errors.push({ contentId: row.content_id, error: 'no_tweet_id_in:' + row.published_url });
              continue;
            }

            // Build auth header — OAuth 2.0 preferred, 1.0a fallback
            const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;
            const queryString = 'tweet.fields=public_metrics,non_public_metrics,created_at,author_id';
            let authHeader;
            let usedOAuth2 = false;
            if (xCreds.oauth2AccessToken) {
              authHeader = `Bearer ${xCreds.oauth2AccessToken}`;
              usedOAuth2 = true;
            } else {
              const xApiKey       = xCreds.apiKey       || process.env.X_OAUTH1CONSUMER_KEY;
              const xApiSecret    = xCreds.apiSecret    || process.env.X_OAUTH1CONSUMER_SECRET;
              const xAccessToken  = xCreds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
              const xAccessSecret = xCreds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
              if (!xApiKey || !xAccessToken) {
                // Defense-in-depth — the pre-loop check above should have caught
                // this. If only some rows hit here it means brand credentials
                // are partial; surface it instead of silently skipping.
                console.warn(`[Analytics/X] missing OAuth1 creds mid-loop for tweet=${tweetId} content=${row.content_id} — skipping`);
                errors.push({ contentId: row.content_id, error: 'no_x_credentials_for_row' });
                continue;
              }
              authHeader = buildXOAuthHeader('GET', endpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret,
                Object.fromEntries(new URLSearchParams(queryString)));
            }

            let tweetRes = await fetch(`${endpoint}?${queryString}`, {
              headers: { 'Authorization': authHeader }
            });

            // 401 with OAuth 2.0 → access token expired. Try a one-shot
            // refresh, persist the new token, retry the request once.
            // Mirrors the publish-path refresh at server.js:11038-11071.
            if (tweetRes.status === 401 && usedOAuth2 && xCreds.oauth2RefreshToken && !xRefreshAttempted) {
              xRefreshAttempted = true;
              try {
                const refreshed = await refreshXOAuth2Token(xCreds.oauth2RefreshToken);
                xCreds.oauth2AccessToken = refreshed.access_token;
                if (refreshed.refresh_token) xCreds.oauth2RefreshToken = refreshed.refresh_token;
                await pool.query(
                  `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
                  [JSON.stringify({ oauth2AccessToken: xCreds.oauth2AccessToken, oauth2RefreshToken: xCreds.oauth2RefreshToken }), brandProfileId]
                );
                console.log(`[Analytics/X] Refreshed OAuth2 token mid-sync for brand=${brandProfileId}, retrying tweet=${tweetId}`);
                tweetRes = await fetch(`${endpoint}?${queryString}`, {
                  headers: { 'Authorization': `Bearer ${xCreds.oauth2AccessToken}` }
                });
              } catch(e) {
                console.error(`[Analytics/X] Token refresh failed for brand=${brandProfileId}: ${e.message}`);
                const msg = (e.message || '').toLowerCase();
                if (msg.includes('invalid') || msg.includes('revoked') || msg.includes('expired')) {
                  await pool.query(
                    `UPDATE publishing_channels SET credentials = credentials - 'oauth2AccessToken' - 'oauth2RefreshToken' WHERE brand_profile_id = $1 AND channel = 'x'`,
                    [brandProfileId]
                  ).catch(() => {});
                  console.error(`[Analytics/X] Cleared expired tokens for brand=${brandProfileId} — user must reconnect`);
                  errors.push({ channel: 'x', error: 'x_auth_expired', detail: 'X authentication expired. Please reconnect X in Integrations.' });
                } else {
                  errors.push({ contentId: row.content_id, error: 'token_refresh_failed:' + e.message });
                }
                // No point hammering api.twitter.com with a dead token for the
                // remaining tweets — break out and let the next sync retry.
                xAuthHardFailed = true;
                break;
              }
            }

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
              const reason = errBody?.detail || errBody?.title || `HTTP ${tweetRes.status}`;
              console.warn(`[Analytics/X] tweet=${tweetId} content=${row.content_id} → HTTP ${tweetRes.status}: ${reason}`);
              errors.push({ contentId: row.content_id, error: reason });
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
            console.warn(`[Analytics/X] content=${row.content_id} threw: ${e.message}`);
            errors.push({ contentId: row.content_id, error: e.message });
          }
        }
      }

      const xSyncedDelta = synced.length - xSyncedStart;
      const xErrorsDelta = errors.length - xErrorsStart;
      console.log(`[Analytics/X] Done for brand=${brandProfileId}: synced=${xSyncedDelta}, errors=${xErrorsDelta}, eligible=${xLogRes.rows.length}`);
    }

    // ── Facebook analytics (via Zernio) ─────────────────────────────────────
    if (channel === 'facebook' || channel === 'all') {
      const fbLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'facebook' AND pl.status = 'published'
           AND (pl.live_status IS NULL OR pl.live_status != 'deleted')
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      const fbCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'facebook' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const fbCreds = fbCredRes.rows[0]?.credentials || {};
      const fbIsZernio = fbCreds.provider === 'zernio' && !!process.env.ZERNIO_API_KEY;
      const fbToken = fbCreds.pageAccessToken;
      console.log(`[Analytics/Facebook] Found ${fbLogRes.rows.length} published posts, provider=${fbIsZernio ? 'zernio' : 'legacy'}`);

      for (const row of fbLogRes.rows) {
        try {
          const rd = row.response_data || {};
          const postId = rd.postId || rd.post_id || rd.id;
          // Zernio's internal _id (separate from the Facebook platform URN).
          // Populated for posts published after the zernioPostId capture landed
          // in the publish handler. Older Zernio posts have null here and route
          // to the legacy Graph API fallback below.
          const zernioPostId = rd.zernioPostId || rd.zernio_post_id || null;
          if (!postId) { errors.push({ contentId: row.content_id, error: 'no_post_id' }); continue; }

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};
          let dataSource = 'none';

          // Use Zernio analytics ONLY when this specific post has a Zernio _id —
          // Zernio's /analytics endpoint expects its internal _id, NOT the
          // Facebook platform URN (pageId_postId). Posts published before the
          // zernioPostId fix have no _id stored, so they route through the
          // legacy Graph API fallback even if the brand is Zernio-routed.
          if (fbIsZernio && zernioPostId) {
            const analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(zernioPostId)}`);
            console.log(`[Analytics/Facebook] Zernio analytics for ${zernioPostId} (URN ${postId}): HTTP ${analyticsRes.status}`);

            if (analyticsRes.status === 202) {
              await pool.query(
                `INSERT INTO content_analytics
                   (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1, $2, 'facebook', $3, 0, 0, 0, 0, 0, 0, 0, $4::jsonb, COALESCE($5, NOW()), NOW())
                 ON CONFLICT (content_id, channel) DO NOTHING`,
                [brandProfileId, row.content_id, postId, JSON.stringify({ pending: true }), row.published_at]
              ).catch(e => console.error('[Analytics/Facebook] pending placeholder failed:', e.message));
              console.log(`[Analytics/Facebook] Sync pending for ${postId} — placeholder inserted, will retry next sync`);
              continue;
            }
            if (analyticsRes.status === 424 || !analyticsRes.ok) {
              errors.push({ contentId: row.content_id, error: `zernio_analytics_${analyticsRes.status}` });
              continue;
            }

            const analytics = analyticsRes.parsed;
            const platforms = analytics?.post?.platforms || analytics?.platforms || [];
            const fbMetrics = platforms.find(p => p.platform === 'facebook')?.analytics
              || analytics?.post?.analytics
              || analytics?.analytics
              || analytics || {};

            impressions = fbMetrics.impressions || fbMetrics.views || fbMetrics.reach || fbMetrics.impression_count || 0;
            clicks      = fbMetrics.clicks || fbMetrics.link_clicks || fbMetrics.post_clicks || 0;
            reactions   = fbMetrics.likes || fbMetrics.reactions || fbMetrics.total_reactions || 0;
            comments    = fbMetrics.comments || fbMetrics.comment_count || 0;
            reposts     = fbMetrics.shares || fbMetrics.reposts || fbMetrics.share_count || 0;
            rawData     = { zernio: analytics };
            dataSource  = 'zernio';
            console.log(`[Analytics/Facebook] Zernio metrics for ${postId}: ${impressions} impr, ${reactions} reactions, ${comments} comments, ${reposts} shares, ${clicks} clicks`);

          } else if (fbToken && fbCreds.pageId) {
            // Legacy direct Graph API path
            try {
              const fbRes = await fetch(
                `https://graph.facebook.com/v19.0/${postId}/insights?metric=post_impressions,post_clicks,post_reactions_like_total&access_token=${fbToken}`
              );
              if (fbRes.ok) {
                const fbData = await fbRes.json();
                for (const metric of (fbData.data || [])) {
                  const val = metric.values?.[0]?.value || 0;
                  if (metric.name === 'post_impressions') impressions = val;
                  if (metric.name === 'post_clicks') clicks = val;
                  if (metric.name === 'post_reactions_like_total') reactions = val;
                }
                rawData = { graphApi: fbData };
                dataSource = 'graphApi';
              }
            } catch(e) { /* Graph API unavailable */ }
          } else {
            continue;
          }

          if (dataSource === 'none') continue;

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
               impressions      = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.impressions ELSE content_analytics.impressions END,
               clicks           = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.clicks      ELSE content_analytics.clicks      END,
               ctr              = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.ctr         ELSE content_analytics.ctr         END,
               engagement_rate  = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.engagement_rate ELSE content_analytics.engagement_rate END,
               reactions        = GREATEST(COALESCE(content_analytics.reactions, 0), EXCLUDED.reactions),
               comments         = GREATEST(COALESCE(content_analytics.comments, 0),  EXCLUDED.comments),
               reposts          = GREATEST(COALESCE(content_analytics.reposts, 0),   EXCLUDED.reposts),
               raw_data         = (COALESCE(content_analytics.raw_data, '{}'::jsonb) - 'pending') || EXCLUDED.raw_data,
               synced_at        = NOW(),
               campaign_id      = COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, 'facebook', postId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, postId, reactions, comments, reposts, impressions, dataSource });
        } catch(e) {
          errors.push({ contentId: row.content_id, error: e.message });
        }
      }
    }

    // ── Reddit analytics (Zernio-only) ──
    // Forge's Reddit publishing always routes through Zernio (no legacy direct OAuth path
    // for Reddit — Phase 1 of the Reddit wire-up was Zernio-first by design). So this
    // branch only handles the Zernio analytics pull.
    if (channel === 'reddit' || channel === 'all') {
      const rdLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.title, ct.campaign_id
           FROM publish_log pl
           LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
          WHERE pl.brand_profile_id = $1 AND pl.channel = 'reddit' AND pl.status = 'published'
            AND (pl.live_status IS NULL OR pl.live_status != 'deleted')
          ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      const rdCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'reddit' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const rdCreds = rdCredRes.rows[0]?.credentials || {};
      const rdIsZernio = !!rdCreds.zernioAccountId && !!process.env.ZERNIO_API_KEY;
      console.log(`[Analytics/Reddit] Found ${rdLogRes.rows.length} published posts, provider=${rdIsZernio ? 'zernio' : 'unsupported'}`);

      for (const row of rdLogRes.rows) {
        try {
          const rd = row.response_data || {};
          const postId = rd.postId || rd.post_id || rd.id;
          if (!postId) { errors.push({ contentId: row.content_id, error: 'no_post_id' }); continue; }

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};
          let dataSource = 'none';

          if (rdIsZernio) {
            const analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(postId)}`);
            console.log(`[Analytics/Reddit] Zernio analytics for ${postId}: HTTP ${analyticsRes.status}`);

            if (analyticsRes.status === 202) {
              await pool.query(
                `INSERT INTO content_analytics
                   (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1, $2, 'reddit', $3, 0, 0, 0, 0, 0, 0, 0, $4::jsonb, COALESCE($5, NOW()), NOW())
                 ON CONFLICT (content_id, channel) DO NOTHING`,
                [brandProfileId, row.content_id, postId, JSON.stringify({ pending: true }), row.published_at]
              ).catch(e => console.error('[Analytics/Reddit] pending placeholder failed:', e.message));
              console.log(`[Analytics/Reddit] Sync pending for ${postId} — placeholder inserted, will retry next sync`);
              continue;
            }
            if (analyticsRes.status === 424 || !analyticsRes.ok) {
              errors.push({ contentId: row.content_id, error: `zernio_analytics_${analyticsRes.status}` });
              continue;
            }

            const analytics = analyticsRes.parsed;
            const platforms = analytics?.post?.platforms || analytics?.platforms || [];
            const rdMetrics = platforms.find(p => p.platform === 'reddit')?.analytics
              || analytics?.post?.analytics
              || analytics?.analytics
              || analytics || {};

            // Reddit metric name mapping. Reddit's terminology differs from LI/FB:
            //   upvotes/score → reactions (positive engagement)
            //   crossposts    → reposts (closest analog — someone reshared to another sub)
            //   views         → impressions (Zernio surfaces this if Reddit returned it)
            //   comments      → comments (1:1)
            // Reddit's `score` is upvotes minus downvotes; we prefer raw upvotes when available
            // and fall back to score. Downvotes get parked in raw_data for later analysis.
            impressions = rdMetrics.impressions || rdMetrics.views || rdMetrics.view_count || 0;
            clicks      = rdMetrics.clicks || rdMetrics.link_clicks || rdMetrics.url_clicks || 0;
            reactions   = rdMetrics.upvotes || rdMetrics.ups || rdMetrics.score || rdMetrics.likes || 0;
            comments    = rdMetrics.comments || rdMetrics.num_comments || rdMetrics.comment_count || 0;
            reposts     = rdMetrics.crossposts || rdMetrics.num_crossposts || rdMetrics.shares || 0;
            rawData     = { zernio: analytics };
            dataSource  = 'zernio';
            console.log(`[Analytics/Reddit] Zernio metrics for ${postId}: ${impressions} views, ${reactions} upvotes, ${comments} comments, ${reposts} crossposts, ${clicks} clicks`);
          } else {
            console.log(`[Analytics/Reddit] No Zernio account on Reddit channel — skipping ${postId}`);
            continue;
          }

          if (dataSource === 'none') continue;

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
               impressions      = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.impressions ELSE content_analytics.impressions END,
               clicks           = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.clicks      ELSE content_analytics.clicks      END,
               ctr              = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.ctr         ELSE content_analytics.ctr         END,
               engagement_rate  = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.engagement_rate ELSE content_analytics.engagement_rate END,
               reactions        = GREATEST(COALESCE(content_analytics.reactions, 0), EXCLUDED.reactions),
               comments         = GREATEST(COALESCE(content_analytics.comments, 0),  EXCLUDED.comments),
               reposts          = GREATEST(COALESCE(content_analytics.reposts, 0),   EXCLUDED.reposts),
               raw_data         = (COALESCE(content_analytics.raw_data, '{}'::jsonb) - 'pending') || EXCLUDED.raw_data,
               synced_at        = NOW(),
               campaign_id      = COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, 'reddit', postId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, postId, reactions, comments, reposts, impressions, dataSource });
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
    // GSC math bug fix: for channel='gsc', the engagement_rate column stores search-ranking position
    // (schema overload — see sync-gsc handler). Simple AVG(position) gives equal weight to a page with
    // 1 impression at rank #50 and a page with 10,000 impressions at rank #3 — wildly overstating
    // average rank. Same problem for AVG(ctr). Google Search Console's own dashboard uses
    // impression-weighted math: SUM(metric * impressions) / SUM(impressions). Branch here so GSC
    // matches what Brian sees in GSC directly; other channels keep their existing behavior.
    const isGsc = channel === 'gsc';
    const ctrExpr = isGsc
      ? `CASE WHEN COALESCE(SUM(impressions),0) > 0 THEN SUM(clicks)::float * 100.0 / SUM(impressions) ELSE 0 END`
      : `COALESCE(AVG(NULLIF(ctr,0)),0)`;
    const engExpr = isGsc
      ? `CASE WHEN COALESCE(SUM(impressions),0) > 0 THEN SUM(engagement_rate * impressions)::float / SUM(impressions) ELSE 0 END`
      : `COALESCE(AVG(NULLIF(engagement_rate,0)),0)`;

    const totals = await pool.query(
      `SELECT
         COUNT(*) as total_posts,
         COALESCE(SUM(impressions),0) as total_impressions,
         COALESCE(SUM(clicks),0) as total_clicks,
         COALESCE(SUM(reactions),0) as total_reactions,
         COALESCE(SUM(comments),0) as total_comments,
         COALESCE(SUM(reposts),0) as total_reposts,
         ${ctrExpr} as avg_ctr,
         ${engExpr} as avg_engagement_rate,
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
          body: JSON.stringify({ queueItemId: item.id, channels: targets, adminPassword: process.env.ADMIN_RELAY_PASSWORD })
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
    // Preserve per-channel auxiliary state across reconnects. Previously this endpoint
    // wrote the whole credentials object fresh on every OAuth completion, wiping
    // state like Facebook's selected pageId/pageName when users hit "Reconnect".
    // Now: read existing credentials, overwrite only the Pipedream-owned keys.
    const existing = await pool.query(
      'SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2',
      [brandProfileId, channel]
    );
    const prev = existing.rows[0]?.credentials || {};
    const merged = {
      ...prev,
      pipedream_account_id: accountId,
      app_slug: appSlug,
      connected_via: 'pipedream_connect'
    };
    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active, updated_at)
      VALUES ($1, $2, $3, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE SET credentials = $3, is_active = true, updated_at = NOW()
    `, [brandProfileId, channel, JSON.stringify(merged)]);
    res.json({ success: true });
  } catch(e) { console.error('[PD-ACCOUNT]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/facebook/pipedream/list-pages?brandProfileId=...
// Lists the Facebook Pages the connected Pipedream account admins. Required because Pipedream
// OAuth completes at the user level — it doesn't know which Page the user wants to publish to.
// Returns [{ id, name, category, access_token }] so the UI can render a picker.
// DIAGNOSTIC: GET /api/admin/facebook/diag?brandProfileId=...&adminPassword=...
// Returns raw /me, /me/accounts, /me/permissions from the Graph API through the Pipedream proxy.
// Exists purely for debugging why no Pages are being returned — useful when user is admin of Pages
// but the OAuth token can't see them (scope/permission issue at the Meta level, not a Forge bug).
app.get('/api/admin/facebook/diag', async (req, res) => {
  const { brandProfileId, adminPassword } = req.query;
  if (adminPassword !== process.env.ADMIN_RELAY_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const r = await pool.query(
      'SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2',
      [brandProfileId, 'facebook']
    );
    if (!r.rows.length) return res.status(404).json({ error: 'no facebook channel' });
    const accountId = r.rows[0].credentials?.pipedream_account_id;
    if (!accountId) return res.status(400).json({ error: 'no pipedream account linked' });

    const results = {};
    for (const [label, url] of [
      ['me', 'https://graph.facebook.com/v21.0/me?fields=id,name,email'],
      ['accounts', 'https://graph.facebook.com/v21.0/me/accounts?fields=id,name,category,tasks,access_token&limit=100'],
      ['permissions', 'https://graph.facebook.com/v21.0/me/permissions'],
    ]) {
      try {
        results[label] = await pipedreamProxy({ externalUserId: brandProfileId, accountId, url, method: 'GET' });
      } catch (e) {
        results[label] = { error: e.message };
      }
    }
    res.json({ accountId, brandProfileId, results });
  } catch (e) {
    console.error('[FB-DIAG]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/facebook/pipedream/list-pages', requireAuth, async (req, res) => {
  const brandProfileId = req.query.brandProfileId;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const r = await pool.query(
      'SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2',
      [brandProfileId, 'facebook']
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Facebook not connected for this brand' });
    const creds = r.rows[0].credentials || {};
    const accountId = creds.pipedream_account_id;
    if (!accountId) return res.status(400).json({ error: 'No Pipedream account linked. Connect Facebook via Integrations first.' });

    const graphRes = await pipedreamProxy({
      externalUserId: brandProfileId,
      accountId,
      url: 'https://graph.facebook.com/v21.0/me/accounts?fields=id,name,category,tasks',
      method: 'GET',
    });
    if (graphRes.error) {
      console.error('[FB-LIST-PAGES] Graph error:', graphRes.error);
      return res.status(502).json({ error: graphRes.error.message || 'Facebook returned an error' });
    }
    const pages = (graphRes.data || []).map(p => ({
      id: p.id, name: p.name, category: p.category,
      canPost: Array.isArray(p.tasks) ? p.tasks.includes('CREATE_CONTENT') : true
    }));
    res.json({ pages, selectedPageId: creds.pageId || null });
  } catch(e) {
    console.error('[FB-LIST-PAGES]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/facebook/pipedream/select-page
// Persists the chosen pageId + pageName to publishing_channels.credentials so the publisher can use it.
app.post('/api/facebook/pipedream/select-page', requireAuth, async (req, res) => {
  const { brandProfileId, pageId, pageName } = req.body;
  if (!brandProfileId || !pageId) return res.status(400).json({ error: 'brandProfileId and pageId required' });
  try {
    await pool.query(
      `UPDATE publishing_channels SET credentials = credentials || $1, updated_at = NOW()
       WHERE brand_profile_id = $2 AND channel = 'facebook'`,
      [JSON.stringify({ pageId, pageName: pageName || null }), brandProfileId]
    );
    res.json({ success: true, pageId, pageName });
  } catch(e) {
    console.error('[FB-SELECT-PAGE]', e.message);
    res.status(500).json({ error: e.message });
  }
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
          headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'Forge-Intelligence-Server/1.0' },
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
          AND (t.table_name LIKE 'generated_content_%' OR t.table_name = 'generated_social_posts')
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
// POST /api/admin/backfill-facebook-zernio-ids — one-shot backfill
// Repairs publish_log rows for Facebook posts published via Zernio BEFORE
// the zernioPostId capture landed (PR #111). Those rows have the Facebook
// platform URN (pageId_postId) in response_data.postId but no zernioPostId,
// so the analytics sync can't look them up via Zernio's /analytics endpoint
// (which expects Zernio's internal _id, not the platform URN).
//
// Strategy: list the brand's Zernio posts, find each one's platform-specific
// post ID, match against our stored Facebook URNs, and merge the discovered
// Zernio _id into response_data.
//
// Always defaults to dryRun:true — returns the proposed mapping without
// touching the database. Call with body {dryRun: false} to actually update.
//
// Query: ?adminPassword=<...>
// Body:  { brandProfileId: string, dryRun?: boolean (default true) }
//
// Response:
//   {
//     unmappedRows: [{ id, postId, attempted_at }],
//     zernioPostsScanned: number,
//     matched: [{ rowId, urn, zernioPostId }],
//     unmatched: [{ rowId, urn }],
//     updated: number,
//     zernioSampleShape: object | null   // first Zernio post raw, for debugging
//   }
app.post('/api/admin/backfill-facebook-zernio-ids', async (req, res) => {
  if (req.query.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { brandProfileId, dryRun = true } = req.body || {};
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  if (!process.env.ZERNIO_API_KEY) return res.status(500).json({ error: 'ZERNIO_API_KEY not configured' });

  try {
    // 1. Find Facebook publish_log rows missing zernioPostId.
    const unmappedRes = await pool.query(
      `SELECT id, content_id, response_data, attempted_at
       FROM publish_log
       WHERE brand_profile_id = $1
         AND channel = 'facebook'
         AND status = 'published'
         AND response_data IS NOT NULL
         AND response_data ->> 'zernioPostId' IS NULL
         AND response_data ->> 'postId' IS NOT NULL
       ORDER BY attempted_at DESC`,
      [brandProfileId]
    );
    const unmappedRows = unmappedRes.rows.map(r => ({
      id: r.id,
      postId: r.response_data?.postId,
      attempted_at: r.attempted_at,
    }));
    if (!unmappedRows.length) {
      return res.json({ unmappedRows: [], zernioPostsScanned: 0, matched: [], unmatched: [], updated: 0, message: 'no rows needing backfill' });
    }

    // 2. Get the brand's Facebook Zernio accountId.
    const credRes = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'facebook' AND is_active = true LIMIT 1`,
      [brandProfileId]
    );
    const zernioAccountId = credRes.rows[0]?.credentials?.zernioAccountId;
    if (!zernioAccountId) return res.status(400).json({ error: 'brand has no Facebook zernioAccountId — not a Zernio brand' });

    // 3. Enumerate the brand's posts from Zernio. Pagination convention is
    // unverified — try the most common shape (page/limit). Cap at 10 pages
    // (~1000 posts) so we don't loop forever if the API doesn't paginate as
    // expected. If we end up with zero posts on page 1, return the raw
    // response shape for diagnostic.
    const zernioPosts = [];
    let zernioSampleShape = null;
    let page = 1;
    const PAGE_LIMIT = 10;
    while (page <= PAGE_LIMIT) {
      const listRes = await callZernio('GET', `/posts?accountId=${encodeURIComponent(zernioAccountId)}&page=${page}&limit=100`);
      if (!listRes.ok) {
        return res.json({
          error: `Zernio GET /posts returned ${listRes.status}`,
          zernioRaw: listRes.raw?.slice(0, 500),
          unmappedRows,
        });
      }
      // Tolerate a few common response shapes.
      const parsed = listRes.parsed;
      const batch = Array.isArray(parsed) ? parsed
        : (parsed?.posts || parsed?.data || parsed?.items || []);
      if (!zernioSampleShape && batch.length) zernioSampleShape = batch[0];
      if (!batch.length) break;
      zernioPosts.push(...batch);
      if (batch.length < 100) break;
      page++;
    }

    // 4. Build a map of every platform postId we can pull off any Zernio post.
    // Walk each post's platform-specific fields tolerantly — different platforms
    // surface the ID under different keys (platformPostId, postId, urn, id).
    const urnToZernioId = new Map();
    for (const post of zernioPosts) {
      const zid = post._id || post.id;
      if (!zid) continue;
      // Pull every plausible platform-post-id field on the Zernio post.
      const candidates = [];
      const platforms = post.platforms || post.platformAnalytics || post.platformPosts || [];
      for (const p of platforms) {
        if (p?.platform !== 'facebook') continue;
        if (p.platformPostId) candidates.push(p.platformPostId);
        if (p.postId)         candidates.push(p.postId);
        if (p.id)             candidates.push(p.id);
        if (p.urn)            candidates.push(p.urn);
      }
      // Some Zernio response shapes inline the IDs on the post itself.
      if (post.platformPostId) candidates.push(post.platformPostId);
      for (const c of candidates) {
        if (typeof c === 'string' && c.length) urnToZernioId.set(c, zid);
      }
    }

    // 5. Match unmapped rows to discovered Zernio _ids.
    const matched = [];
    const unmatched = [];
    for (const row of unmappedRows) {
      const zid = urnToZernioId.get(row.postId);
      if (zid) matched.push({ rowId: row.id, urn: row.postId, zernioPostId: zid });
      else     unmatched.push({ rowId: row.id, urn: row.postId });
    }

    // 6. If not a dry run, write the matches back into response_data.
    let updated = 0;
    if (!dryRun && matched.length) {
      for (const m of matched) {
        await pool.query(
          `UPDATE publish_log
           SET response_data = response_data || jsonb_build_object('zernioPostId', $1::text)
           WHERE id = $2`,
          [m.zernioPostId, m.rowId]
        );
        updated++;
      }
    }

    res.json({
      dryRun,
      unmappedRows,
      zernioPostsScanned: zernioPosts.length,
      matched,
      unmatched,
      updated,
      zernioSampleShape,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/backfill-linkedin-zernio-ids — one-shot backfill
// LinkedIn analogue of /api/admin/backfill-facebook-zernio-ids. Repairs
// publish_log rows for LinkedIn posts published via Zernio BEFORE the
// zernioPostId capture landed — and, critically, posts whose pre-Zernio
// LinkedIn access token was wiped when the brand was reconnected through
// Zernio (the credential clobber fixed in the same branch). Those rows hold
// the LinkedIn share URN (urn:li:share:<id>) in response_data.postId but no
// zernioPostId, so the analytics sync skips them with "No credentials —
// skipping": there's no Zernio _id to look up and no LinkedIn token for the
// legacy fallback.
//
// Strategy: list the brand's Zernio posts, pull each LinkedIn post's platform
// id (full URN or numeric share id), match against our stored URNs (full value
// OR numeric tail), and merge the discovered Zernio _id into
// response_data.zernioPostId so future syncs route them via the Zernio path.
//
// Defaults to dryRun:true — returns the proposed mapping plus a raw Zernio post
// sample (zernioSampleShape) WITHOUT touching the DB. Run dryRun first as the
// probe to verify Zernio's response shape; call with {dryRun:false} to write.
//
// Query: ?adminPassword=<...>
// Body:  { brandProfileId: string, dryRun?: boolean (default true) }
app.post('/api/admin/backfill-linkedin-zernio-ids', async (req, res) => {
  if (req.query.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { brandProfileId, dryRun = true } = req.body || {};
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  if (!process.env.ZERNIO_API_KEY) return res.status(500).json({ error: 'ZERNIO_API_KEY not configured' });

  // Normalize a LinkedIn share id to its numeric tail so a stored full URN
  // (urn:li:share:123) matches a Zernio-side numeric id (123) and vice versa.
  const numericTail = (v) => (typeof v === 'string' ? (v.match(/(\d{6,})\s*$/)?.[1] || null) : null);

  try {
    // 1. LinkedIn publish_log rows missing zernioPostId.
    const unmappedRes = await pool.query(
      `SELECT id, content_id, response_data, attempted_at
       FROM publish_log
       WHERE brand_profile_id = $1
         AND channel = 'linkedin'
         AND status = 'published'
         AND response_data IS NOT NULL
         AND response_data ->> 'zernioPostId' IS NULL
         AND response_data ->> 'postId' IS NOT NULL
       ORDER BY attempted_at DESC`,
      [brandProfileId]
    );
    const unmappedRows = unmappedRes.rows.map(r => ({
      id: r.id,
      postId: r.response_data?.postId,
      attempted_at: r.attempted_at,
    }));
    if (!unmappedRows.length) {
      return res.json({ unmappedRows: [], zernioPostsScanned: 0, matched: [], unmatched: [], updated: 0, message: 'no rows needing backfill' });
    }

    // 2. The brand's LinkedIn Zernio accountId.
    const credRes = await pool.query(
      `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'linkedin' AND is_active = true LIMIT 1`,
      [brandProfileId]
    );
    const zernioAccountId = credRes.rows[0]?.credentials?.zernioAccountId;
    if (!zernioAccountId) return res.status(400).json({ error: 'brand has no LinkedIn zernioAccountId — not a Zernio brand' });

    // 3. Enumerate the brand's Zernio posts (same pagination convention as the
    // Facebook backfill — unverified, capped at 10 pages).
    const zernioPosts = [];
    let zernioSampleShape = null;
    let page = 1;
    const PAGE_LIMIT = 10;
    while (page <= PAGE_LIMIT) {
      const listRes = await callZernio('GET', `/posts?accountId=${encodeURIComponent(zernioAccountId)}&page=${page}&limit=100`);
      if (!listRes.ok) {
        return res.json({ error: `Zernio GET /posts returned ${listRes.status}`, zernioRaw: listRes.raw?.slice(0, 500), unmappedRows });
      }
      const parsed = listRes.parsed;
      const batch = Array.isArray(parsed) ? parsed : (parsed?.posts || parsed?.data || parsed?.items || []);
      if (!zernioSampleShape && batch.length) zernioSampleShape = batch[0];
      if (!batch.length) break;
      zernioPosts.push(...batch);
      if (batch.length < 100) break;
      page++;
    }

    // 4. Map every LinkedIn platform id we can find (full value AND numeric tail) → Zernio _id.
    const idToZernioId = new Map();
    const addKey = (k, zid) => { if (typeof k === 'string' && k.length) idToZernioId.set(k, zid); };
    for (const post of zernioPosts) {
      const zid = post._id || post.id;
      if (!zid) continue;
      const platforms = post.platforms || post.platformAnalytics || post.platformPosts || [];
      const candidates = [];
      for (const p of platforms) {
        if (p?.platform !== 'linkedin') continue;
        for (const key of ['platformPostId', 'postId', 'id', 'urn']) if (p[key]) candidates.push(p[key]);
      }
      if (post.platformPostId) candidates.push(post.platformPostId);
      for (const c of candidates) {
        addKey(c, zid);
        const tail = numericTail(c);
        if (tail) addKey(tail, zid);
      }
    }

    // 5. Match unmapped rows — try the full stored URN, then its numeric tail.
    const matched = [];
    const unmatched = [];
    for (const row of unmappedRows) {
      const tail = numericTail(row.postId);
      const zid = idToZernioId.get(row.postId) || (tail ? idToZernioId.get(tail) : null);
      if (zid) matched.push({ rowId: row.id, urn: row.postId, zernioPostId: zid });
      else     unmatched.push({ rowId: row.id, urn: row.postId });
    }

    // 6. Write matches back into response_data unless this is a dry run.
    let updated = 0;
    if (!dryRun && matched.length) {
      for (const m of matched) {
        await pool.query(
          `UPDATE publish_log
           SET response_data = response_data || jsonb_build_object('zernioPostId', $1::text)
           WHERE id = $2`,
          [m.zernioPostId, m.rowId]
        );
        updated++;
      }
    }

    res.json({ dryRun, unmappedRows, zernioPostsScanned: zernioPosts.length, matched, unmatched, updated, zernioSampleShape });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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




// ── forgeScrape — the one scrape primitive ─────────────────────────────────
// Every URL Forge fetches for content/intelligence purposes goes through
// here. Two-tier under the hood:
//
//   Tier 1: Bright Data Web Unlocker (cheap, fast, returns HTTP response)
//   Tier 2: Bright Data Scraping Browser (CDP via puppeteer-core; real
//           browser that JS-renders the page) — auto-fallback when Tier 1
//           returns an SPA shell.
//
// Replaces the per-feature fetcher zoo (custom HTTP + Jina + Sonar) that
// produced "0 of 10 patterns" failures on every modern SPA.
//
// Returns: { success, status, html, source, latencyMs, error }
//
// Logs every attempt to scrape_log so we can audit reliability without
// reading server logs. Tier 1 + Tier 2 attempts for the same URL log as
// separate rows so the chain is visible.
//
// Required env:
//   BRIGHTDATA_API_KEY        — bearer token (from BD dashboard → Settings)
//   BRIGHTDATA_UNLOCKER_ZONE  — Unlocker zone name (e.g. 'forge_intelligence')
//   BRIGHTDATA_BROWSER_AUTH   — Scraping Browser auth string (format:
//                               'brd-customer-<CUSTOMER_ID>-zone-<ZONE>:<PASSWORD>')
//                               OPTIONAL — if missing, Tier 2 is skipped and
//                               an SPA-shell response from Tier 1 returns as-is.

// Tier 2 (Scraping Browser) — CDP connection via puppeteer-core. We don't
// bundle Chromium; we connect to Bright Data's remote browser over WebSocket.
// (puppeteer is imported at the top of the file alongside other ESM imports.)

const SPA_SHELL_RE = /<body[^>]*>\s*(?:<noscript>[\s\S]*?<\/noscript>\s*)?<div\s+id=["'](?:root|__next|app|svelte|nuxt)["'][^>]*>\s*<\/div>/i;
function looksLikeSpaShell(html) {
  if (!html) return false;
  if (SPA_SHELL_RE.test(html)) return true;
  // Fallback heuristic: tiny body content (after stripping scripts/styles)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return false;
  const cleanedBody = bodyMatch[1]
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .trim();
  return cleanedBody.length < 500;
}

async function _logScrape(row) {
  try {
    await pool.query(
      `INSERT INTO scrape_log (url, source, status_code, body_size, latency_ms, success, caller, error, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.url, row.source, row.status_code ?? null, row.body_size ?? null, row.latency_ms ?? null,
       row.success, row.caller ?? 'unknown', row.error ?? null, JSON.stringify(row.metadata ?? {})]
    );
  } catch { /* logging is best-effort */ }
}

async function _tryUnlocker(url, { format, timeout, country, caller, metadata }) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  const startTime = Date.now();
  if (!apiKey || !zone) {
    const err = 'Bright Data Unlocker not configured (BRIGHTDATA_API_KEY / BRIGHTDATA_UNLOCKER_ZONE missing)';
    await _logScrape({ url, source: 'brightdata_unlocker', success: false, latency_ms: 0, caller, error: err, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_unlocker', latencyMs: 0, error: err };
  }
  try {
    const body = { zone, url, format };
    if (country) body.country = country;
    if (format === 'markdown') body.data_format = 'markdown';
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), timeout);
    let resp;
    try {
      resp = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally { clearTimeout(tid); }
    const responseBody = await resp.text();
    const latencyMs = Date.now() - startTime;
    await _logScrape({
      url, source: 'brightdata_unlocker',
      status_code: resp.status, body_size: responseBody.length, latency_ms: latencyMs,
      success: resp.ok, caller,
      metadata: { ...(metadata ?? {}), body_sample: resp.ok ? responseBody.slice(0, 15000) : undefined },
      error: resp.ok ? null : `HTTP ${resp.status}: ${responseBody.slice(0, 200)}`,
    });
    if (!resp.ok) {
      return { success: false, status: resp.status, html: null, source: 'brightdata_unlocker', latencyMs, error: `HTTP ${resp.status}: ${responseBody.slice(0, 200)}` };
    }
    return { success: true, status: resp.status, html: responseBody, source: 'brightdata_unlocker', latencyMs, error: null };
  } catch (e) {
    const latencyMs = Date.now() - startTime;
    await _logScrape({ url, source: 'brightdata_unlocker', success: false, latency_ms: latencyMs, caller, error: e.message, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_unlocker', latencyMs, error: e.message };
  }
}

async function _tryScrapingBrowser(url, { timeout, caller, metadata }) {
  const browserAuth = process.env.BRIGHTDATA_BROWSER_AUTH;
  const startTime = Date.now();
  if (!browserAuth) {
    const err = 'Bright Data Scraping Browser not configured (BRIGHTDATA_BROWSER_AUTH missing)';
    await _logScrape({ url, source: 'brightdata_browser', success: false, latency_ms: 0, caller, error: err, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_browser', latencyMs: 0, error: err };
  }
  let browser = null;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://${browserAuth}@brd.superproxy.io:9222`,
      // Each connection is single-shot; tear down promptly.
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeout);
    // Block heavy resources we don't need for DOM extraction. Cuts bandwidth
    // cost (Scraping Browser is bandwidth-billed) ~70% on most sites.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    // Wait for actual article-shaped content, not just any DOM. The previous
    // heuristic (root has children + 1KB innerHTML) fires the moment the
    // layout shell mounts — well before the article body actually renders,
    // which is why Tier 2 was returning 10KB pages with no article in them.
    // Now: require an h1 with real text AND at least 3 paragraphs. If that
    // doesn't fire within 15s we take what we have rather than fail.
    try {
      await page.waitForFunction(() => {
        const h1 = document.querySelector('h1');
        const paragraphs = document.querySelectorAll('p').length;
        return h1 && h1.textContent.trim().length > 10 && paragraphs >= 3;
      }, { timeout: 15_000 });
    } catch { /* content heuristic didn't fire — continue with what we have */ }
    const html = await page.content();
    await browser.close();
    browser = null;
    const latencyMs = Date.now() - startTime;
    await _logScrape({
      url, source: 'brightdata_browser',
      status_code: 200, body_size: html.length, latency_ms: latencyMs,
      success: true, caller,
      metadata: { ...(metadata ?? {}), body_sample: html.slice(0, 15000) },
    });
    return { success: true, status: 200, html, source: 'brightdata_browser', latencyMs, error: null };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch {} }
    const latencyMs = Date.now() - startTime;
    await _logScrape({ url, source: 'brightdata_browser', success: false, latency_ms: latencyMs, caller, error: e.message, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_browser', latencyMs, error: e.message };
  }
}

async function forgeScrape(url, opts = {}) {
  const {
    format = 'raw',           // 'raw' = HTML, 'markdown' = cleaned content
    timeout = 60000,          // ms — Bright Data can take 5-15s on complex sites
    country = null,           // optional ISO country code for geo-targeting
    caller = 'unknown',       // string identifier for the log
    metadata = {},
    render = 'auto',          // 'auto' = Unlocker → Browser fallback on SPA shell
                              // 'always' = skip Unlocker, go straight to Browser
                              // 'never' = Unlocker only, no fallback
  } = opts;

  // 'always': caller knows this is a JS-heavy site, skip Tier 1
  if (render === 'always') {
    return await _tryScrapingBrowser(url, { timeout, caller, metadata });
  }

  // Tier 1: Web Unlocker
  const unlockerResult = await _tryUnlocker(url, { format, timeout, country, caller, metadata });

  // 'never': don't fall back even if shell detected
  if (render === 'never') return unlockerResult;

  // 'auto': fall back to Scraping Browser when Tier 1 returned a SPA shell
  // OR when Tier 1 failed entirely (network/HTTP error). Markdown format
  // skips the shell-detection branch since the body is reformatted text,
  // not HTML.
  if (format !== 'raw') return unlockerResult;
  const needsBrowser = !unlockerResult.success || looksLikeSpaShell(unlockerResult.html);
  if (!needsBrowser) return unlockerResult;

  console.log(`[forgeScrape] Tier 1 ${unlockerResult.success ? 'returned shell' : 'failed'} for ${url} (caller=${caller}) — escalating to Scraping Browser`);
  const browserResult = await _tryScrapingBrowser(url, { timeout, caller, metadata });
  // If browser also failed, return whichever attempt produced more useful
  // content (browser preferred when both have errors, since it's the
  // higher-tier tool).
  if (browserResult.success) return browserResult;
  return unlockerResult.success ? unlockerResult : browserResult;
}

// ── getBrandPageContent — Stage 1 page-content primitive ───────────────────
// Returns clean markdown for a single brand page. Two-tier:
//
//   Tier A: Jina Reader (r.jina.ai) — semantic content extraction with built-in
//           JS rendering. Returns markdown directly. Fast on the common case.
//   Tier B: forgeScrape (Tier 1 → Tier 2 cascade) + local Mozilla Readability
//           + Turndown. For sites Jina can't reach (rate-limit, geo-block,
//           outright failure) — we render via Bright Data and extract locally.
//
// Returns { success, markdown, source, latencyMs, error }
//   source: 'jina_reader' | 'brightdata_unlocker' | 'brightdata_browser'
//
// Every attempt is logged to scrape_log with caller='context-hub' for audit.
const _turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '_' });
function htmlToMarkdown(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) return '';
    return _turndown.turndown(article.content).trim();
  } catch {
    return '';
  }
}

async function getBrandPageContent(url, { caller = 'context-hub', metadata = {}, jinaTimeout = 15000 } = {}) {
  // ── Tier A: Jina Reader ──────────────────────────────────────────────────
  const jinaStart = Date.now();
  try {
    // X-With-Links-Summary asks Jina to append a "Links/Buttons:" section
    // after the readability-extracted markdown. Crucial for SPA marketing
    // pages: readability drops the <nav>/<header> region, so without this
    // header the markdown contains content-area links only — missing the
    // primary nav (pricing, blog, book-demo, etc.) that we need for
    // subpage discovery. The appended section uses standard [text](url)
    // syntax, so our existing extractMarkdownLinks regex picks it up
    // automatically.
    const headers = { 'Accept': 'text/plain', 'X-With-Links-Summary': 'true' };
    if (process.env.JINA_API_KEY) headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), jinaTimeout);
    let resp;
    try {
      resp = await fetch(`https://r.jina.ai/${url}`, { headers, signal: ac.signal });
    } finally { clearTimeout(tid); }
    const latencyMs = Date.now() - jinaStart;
    if (resp.ok) {
      const markdown = (await resp.text()).trim();
      const usable = markdown.length > 500;
      await _logScrape({
        url, source: 'jina_reader', status_code: resp.status, body_size: markdown.length,
        latency_ms: latencyMs, success: usable, caller,
        metadata: { ...metadata, body_sample: markdown.slice(0, 2000) },
        error: usable ? null : `markdown under threshold (${markdown.length} chars)`,
      });
      if (usable) return { success: true, markdown, source: 'jina_reader', latencyMs, error: null };
    } else {
      await _logScrape({
        url, source: 'jina_reader', status_code: resp.status, body_size: 0,
        latency_ms: latencyMs, success: false, caller, metadata,
        error: `HTTP ${resp.status}`,
      });
    }
  } catch (e) {
    await _logScrape({
      url, source: 'jina_reader', success: false, latency_ms: Date.now() - jinaStart,
      caller, metadata, error: e.message,
    });
  }

  // ── Tier B: forgeScrape → Readability + Turndown ─────────────────────────
  // forgeScrape logs its own attempts (Tier 1 + Tier 2 rows) — no double-log here.
  const fetched = await forgeScrape(url, { caller, metadata });
  if (!fetched.success || !fetched.html) {
    return { success: false, markdown: null, source: fetched.source, latencyMs: fetched.latencyMs, error: fetched.error || 'forgeScrape returned no html' };
  }
  const markdown = htmlToMarkdown(fetched.html, url);
  if (markdown.length < 200) {
    return { success: false, markdown: null, source: fetched.source, latencyMs: fetched.latencyMs, error: `Readability extracted ${markdown.length} chars (under threshold)` };
  }
  return { success: true, markdown, source: fetched.source, latencyMs: fetched.latencyMs, error: null };
}

// ── discoverSubpages — sitemap.xml first, link-extraction fallback ─────────
// Returns up to `max` same-origin URLs likely to contain brand-defining
// content (about, customers, pricing, integrations, FAQ, etc.). Skips noise
// (login, legal, blog post slugs, search/tag/category aggregates) and
// non-page assets (.css, .js, images, fonts, JSON, etc.).
//
// Discovery priority:
//   1. sitemap.xml (most reliable, follows sitemapindex)
//   2. seedMarkdown — parse [text](url) links from already-fetched home
//      content. Avoids a redundant homepage fetch when the caller already
//      has Jina markdown in hand.
//   3. seedHtml — parse <a href> links from already-fetched home HTML
//      (forgeScrape fallback path).
//   4. Last resort: forgeScrape the homepage just to get its links. Tight
//      20s timeout — we'd rather return [] than spend 60s here.
function rankBrandPages(urls) {
  const HIGH = /\/(about|story|mission|team|company|why-us|our-)/i;
  const MED  = /\/(product|service|customer|case-stud|pricing|integration|faq|how-it-works|solution|platform)/i;
  // Block non-page assets and admin/auth/legal noise. Asset extensions are
  // the common bleed source — link-extraction picks up <link rel="stylesheet">,
  // <link rel="icon">, font preconnects, etc. We reject them here as a
  // belt-and-suspenders alongside the anchor-only regex in extractAnchorHrefs.
  const SKIP_PATH = /\/(login|signup|sign-in|sign-up|legal|privacy|terms|cookie|sitemap|robots|admin|account|password|settings|cart|checkout|search\?|tag\/|tags\/|category\/|categories\/|author\/|feed|rss|wp-json|wp-admin|api\/)/i;
  const SKIP_EXT  = /\.(css|js|mjs|cjs|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|pdf|xml|json|txt|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|zip|gz)(\?|$)/i;
  const seen = new Set();
  const scored = [];
  for (const raw of urls) {
    // Strip fragment, query, AND trailing slash so /about and /about/ dedupe
    // and don't appear as two distinct subpages.
    const u = raw.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '');
    if (!u || seen.has(u) || SKIP_PATH.test(u) || SKIP_EXT.test(u)) continue;
    seen.add(u);
    scored.push({ url: u, score: HIGH.test(u) ? 3 : MED.test(u) ? 2 : 1 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.url);
}

// Extract only anchor-tag hrefs (<a href="...">) from HTML — ignores
// <link>, <img>, <script>, <iframe>, etc. The naive /href="[^"]+"/ regex
// scoops up stylesheet links, favicon preconnects, and font URLs, which
// then ride through ranking as fake "subpages."
function extractAnchorHrefs(html) {
  return [...html.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
}

// Extract URLs from Markdown link syntax [text](url) — used when we already
// have Jina markdown for the homepage and want to skip a second fetch.
function extractMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]);
}

async function discoverSubpages(baseUrl, max = 8, { seedMarkdown = null, seedHtml = null } = {}) {
  const baseHost = new URL(baseUrl).host;
  const origin = new URL(baseUrl).origin;
  const sameOrigin = (u) => { try { return new URL(u).host === baseHost; } catch { return false; } };
  // Strip fragment and trailing slash for comparison/dedup. Without this,
  // [See How It Works](https://example.com/#capabilities) escapes the
  // baseUrl filter (URL with fragment !== baseUrl) and rides through as
  // a "subpage" — even though it's literally the homepage with an anchor.
  const canonical = (u) => u.replace(/#.*$/, '').replace(/\/+$/, '');
  const baseCanonical = canonical(baseUrl);
  const normalize = (u) => u.startsWith('/') ? origin + u : u;
  const isPage = (u) => /^https?:\/\//i.test(u) && sameOrigin(u) && canonical(u) !== baseCanonical;

  // Step 1: sitemap.xml (handles sitemapindex by following the first child)
  try {
    const sm = await fetch(new URL('/sitemap.xml', baseUrl).href, { signal: AbortSignal.timeout(8000) });
    if (sm.ok) {
      let xml = await sm.text();
      let urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
      if (/<sitemapindex/i.test(xml) && urls.length) {
        try {
          const child = await fetch(urls[0], { signal: AbortSignal.timeout(8000) });
          if (child.ok) {
            const cx = await child.text();
            urls = [...cx.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
          }
        } catch { /* child fetch failed — fall through with index URLs */ }
      }
      const ranked = rankBrandPages(urls.filter(sameOrigin).filter(u => u !== baseUrl && u !== `${baseUrl}/`));
      if (ranked.length) return ranked.slice(0, max);
    }
  } catch { /* sitemap missing/slow — fall through to link extraction */ }

  // Step 2: parse Jina markdown the caller already fetched. Cheap, zero
  // additional latency. Works for any site Jina could read.
  if (seedMarkdown) {
    const links = extractMarkdownLinks(seedMarkdown).map(normalize).filter(isPage);
    const ranked = rankBrandPages(links);
    if (ranked.length) return ranked.slice(0, max);
  }

  // Step 3: parse anchor hrefs from HTML the caller already has (Tier B path).
  if (seedHtml) {
    const links = extractAnchorHrefs(seedHtml).map(normalize).filter(isPage);
    const ranked = rankBrandPages(links);
    if (ranked.length) return ranked.slice(0, max);
  }

  // Step 4: last resort — forgeScrape the homepage just for its links.
  // Tight 20s timeout: if the home is a slow SPA we'd rather return [] than
  // spend 60s on a discovery fetch that the analyze handler already paid
  // separately for as primary content.
  try {
    const home = await forgeScrape(baseUrl, { caller: 'context-hub-discover', timeout: 20000 });
    if (home.success && home.html) {
      const links = extractAnchorHrefs(home.html).map(normalize).filter(isPage);
      return rankBrandPages(links).slice(0, max);
    }
  } catch { /* all discovery paths failed — caller continues with home only */ }

  return [];
}

// ── POST /api/forge-scrape — cross-app scrape service ──────────────────────
// Exposes the internal forgeScrape primitive over HTTP so other apps (SYSOI,
// Sandbox-GTM, etc.) can scrape through Forge's single Bright Data account +
// scrape_log. Service-to-service auth via a shared secret (NOT a Clerk user
// token). See FORGESCRAPE-AS-A-SERVICE.md for the integration guide.
//
// Env: FORGE_SCRAPE_SERVICE_KEY — long random shared secret (openssl rand -hex 32),
//      set here AND in each calling app. Calling apps also set FORGE_SCRAPE_URL
//      (= https://forgeintelligence.ai/api/forge-scrape) on their side.
//
// Note on SSRF: the actual page fetch happens inside Bright Data's network, not
// from the FI server, so a target URL can't reach FI's own infra/metadata. The
// host guard below is defense-in-depth + abuse/cost prevention, not the only
// barrier.

// Dependency-free per-key fixed-window rate limiter. Bright Data is usage-billed;
// this caps a runaway loop in a calling app. Only valid keys reach this Map
// (auth runs first), so it holds at most a handful of entries.
const _forgeScrapeHits = new Map(); // key -> { count, windowStart }
const FORGE_SCRAPE_RATE_PER_MIN = Number(process.env.FORGE_SCRAPE_RATE_PER_MIN) || 60;
function _forgeScrapeRateLimited(key) {
  const now = Date.now();
  const windowMs = 60_000;
  const entry = _forgeScrapeHits.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    _forgeScrapeHits.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > FORGE_SCRAPE_RATE_PER_MIN;
}

app.post('/api/forge-scrape', express.json({ limit: '16kb' }), async (req, res) => {
  // 1) Service auth — constant-time compare. Length pre-check because
  //    timingSafeEqual throws on unequal-length buffers.
  const provided = req.get('X-Forge-Scrape-Key') || '';
  const expected = process.env.FORGE_SCRAPE_SERVICE_KEY || '';
  if (!expected) {
    console.error('[forge-scrape] FORGE_SCRAPE_SERVICE_KEY not set — rejecting all requests');
    return res.status(503).json({ success: false, error: 'Service not configured' });
  }
  const ok = provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) return res.status(401).json({ success: false, error: 'Unauthorized' });

  // 2) Rate limit (per shared key)
  if (_forgeScrapeRateLimited(expected)) {
    return res.status(429).json({ success: false, error: `Rate limit exceeded (${FORGE_SCRAPE_RATE_PER_MIN}/min)` });
  }

  // 3) Input validation
  const { url, format = 'raw', render = 'auto', country = null, timeout = 60000, caller } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ success: false, error: 'url required' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ success: false, error: 'invalid url' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ success: false, error: 'http/https only' });
  // SSRF guard — reject localhost / RFC1918 / link-local / metadata hosts
  const host = parsed.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0)/i.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return res.status(400).json({ success: false, error: 'host not allowed' });
  }

  // 4) Clamp caller-settable knobs
  const safeTimeout = Math.min(Math.max(Number(timeout) || 60000, 5000), 90000);
  const safeRender = ['auto', 'always', 'never'].includes(render) ? render : 'auto';
  const safeFormat = ['raw', 'markdown'].includes(format) ? format : 'raw';

  // 5) Delegate to the primitive — caller tag namespaced so scrape_log shows
  //    which external app drove the request (and the cost).
  try {
    const result = await forgeScrape(url, {
      format: safeFormat,
      render: safeRender,
      country: country || null,
      timeout: safeTimeout,
      caller: `svc:${String(caller || 'external').slice(0, 40)}`,
      metadata: { service: true },
    });
    res.json(result);
  } catch (e) {
    console.error('[forge-scrape]', e.message);
    res.status(500).json({ success: false, status: null, html: null, source: null, error: e.message });
  }
});


// ── Onboarding / GTM Flow ─────────────────────────────────────────────────────

// 7-day full-access trial: scoped per-user, applies to new signups only.
// Mechanic: trial starts at the EARLIEST created_at across all of a user's
// brand_profiles, BUT only for users whose first brand was created after the
// ship marker below. Existing free-tier users (clerk_user_id set, all brands
// created before the marker) stay in their current 24h-expires_at limbo.
const TRIAL_LAUNCH_MARKER = process.env.TRIAL_LAUNCH_MARKER || '2026-05-02T00:00:00Z';
const TRIAL_DAYS = 7;

/**
 * Derive trial state for a clerk_user_id.
 * Returns { active: bool, daysRemaining: number, trialStartedAt: ISO|null,
 *           trialEndsAt: ISO|null, eligible: bool }
 *
 * Rules:
 *   - Super admins: always {active:true, eligible:true} (other code already
 *     short-circuits on isSuperAdmin so this is mostly defensive)
 *   - User has at least one brand created at or after TRIAL_LAUNCH_MARKER
 *     -> eligible. Trial start = MIN(created_at) of their brands. End =
 *     start + 7 days. Active iff end > now.
 *   - User's brands all predate the marker -> not eligible (existing free
 *     tier). Returns {active:false, eligible:false}.
 */
async function getUserTrialState(clerkUserId) {
  if (!clerkUserId) return { active: false, eligible: false, daysRemaining: 0, trialStartedAt: null, trialEndsAt: null };
  try {
    // Trial start = MIN(trial_started_at) across user's brands. trial_started_at is
    // stamped at tether time (when Clerk signup completes and the user claims a brand),
    // so the timer fires from signup, NOT from anonymous scan time. Lead capture
    // happens via Clerk before any timer starts.
    const r = await pool.query(
      `SELECT MIN(trial_started_at) AS first_trial_start
       FROM brand_profiles
       WHERE clerk_user_id = $1 AND is_active = true`,
      [clerkUserId]
    );
    const firstTrialStart = r.rows[0]?.first_trial_start;
    if (!firstTrialStart) {
      // No trial_started_at on any brand — user signed up before this feature shipped,
      // OR something went wrong with tether stamping. Either way, not in trial.
      return { active: false, eligible: false, daysRemaining: 0, trialStartedAt: null, trialEndsAt: null };
    }
    const launchDate = new Date(TRIAL_LAUNCH_MARKER);
    const startDate = new Date(firstTrialStart);
    if (startDate < launchDate) {
      // Trial stamped before launch marker (shouldn't happen for new signups but
      // defensive). Treat as not eligible.
      return { active: false, eligible: false, daysRemaining: 0, trialStartedAt: null, trialEndsAt: null };
    }
    const endDate = new Date(startDate.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const now = new Date();
    const active = endDate > now;
    const msRemaining = endDate.getTime() - now.getTime();
    const daysRemaining = active ? Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000))) : 0;
    return {
      active,
      eligible: true,
      daysRemaining,
      trialStartedAt: startDate.toISOString(),
      trialEndsAt: endDate.toISOString(),
    };
  } catch (e) {
    console.warn('[TRIAL] getUserTrialState error:', e.message);
    return { active: false, eligible: false, daysRemaining: 0, trialStartedAt: null, trialEndsAt: null };
  }
}

// Add expires_at to brand_profiles for free trial brains
pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {});
pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false`).catch(() => {});
    await pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS clerk_user_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bp_clerk ON brand_profiles(clerk_user_id)`).catch(() => {});
pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS onboard_session_id TEXT`).catch(() => {});
  pool.query(`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS zernio_profile_id TEXT`).catch(() => {});
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


// ── User-facing Alerts (topbar bell) ─────────────────────────────────────────
// Scoped to clerk_user_id from the JWT. Never returns rows from other users.
// short_message is the only field shown to end users; raw_message is admin-only.
async function getActiveBrandIdForUser(userId) {
  if (!userId) return null;
  try {
    const r = await pool.query(
      `SELECT id FROM brand_profiles WHERE clerk_user_id = $1 AND is_active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [userId]
    );
    return r.rows[0]?.id || null;
  } catch { return null; }
}

// POST /api/alerts — store a client-reported alert
app.post('/api/alerts', requireAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { severity, area, shortMessage, rawMessage, httpStatus, url } = req.body || {};
    if (!shortMessage || typeof shortMessage !== 'string') {
      return res.status(400).json({ error: 'shortMessage required' });
    }
    const allowedSev = ['error', 'warn', 'info'];
    const sev = allowedSev.includes(severity) ? severity : 'error';
    const shortMsg = truncateStr(shortMessage, 200);
    const rawMsg = truncateStr(rawMessage, 2000);
    const areaStr = truncateStr(area, 80);
    const urlStr = truncateStr(url, 500);
    const status = (typeof httpStatus === 'number' && Number.isFinite(httpStatus)) ? httpStatus : null;
    const brandId = await getActiveBrandIdForUser(req.userId);

    // De-dupe: same (user, short_message, area) inserted in last 60s -> return existing
    const dup = await pool.query(
      `SELECT id, clerk_user_id, brand_profile_id, severity, area, short_message,
              http_status, url, read_at, created_at
         FROM user_alerts
         WHERE clerk_user_id = $1
           AND short_message = $2
           AND (area IS NOT DISTINCT FROM $3)
           AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY created_at DESC LIMIT 1`,
      [req.userId, shortMsg, areaStr]
    );
    if (dup.rows[0]) {
      return res.json({ success: true, alert: dup.rows[0], deduped: true });
    }

    const ins = await pool.query(
      `INSERT INTO user_alerts
         (clerk_user_id, brand_profile_id, severity, area, short_message, raw_message, http_status, url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, clerk_user_id, brand_profile_id, severity, area, short_message,
                 http_status, url, read_at, created_at`,
      [req.userId, brandId, sev, areaStr, shortMsg, rawMsg, status, urlStr]
    );
    res.json({ success: true, alert: ins.rows[0] });
  } catch (e) {
    console.error('POST /api/alerts error:', e.message);
    res.status(500).json({ success: false, error: 'Failed to store alert' });
  }
});

// GET /api/alerts — last 50 alerts for current user, last 14 days
app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query(
      `SELECT id, severity, area, short_message, http_status, url, read_at, created_at
         FROM user_alerts
         WHERE clerk_user_id = $1
           AND created_at > NOW() - INTERVAL '14 days'
         ORDER BY created_at DESC
         LIMIT 50`,
      [req.userId]
    );
    const alerts = result.rows.map(r => ({
      id: r.id,
      severity: r.severity,
      area: r.area,
      shortMessage: r.short_message,
      httpStatus: r.http_status,
      url: r.url,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
    const unreadCount = alerts.filter(a => !a.readAt).length;
    res.json({ success: true, alerts, unreadCount });
  } catch (e) {
    console.error('GET /api/alerts error:', e.message);
    res.status(500).json({ success: false, error: 'Failed to load alerts' });
  }
});

// POST /api/alerts/read — mark alerts read (ids[] or all)
app.post('/api/alerts/read', requireAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string') : null;
    if (ids && ids.length > 0) {
      await pool.query(
        `UPDATE user_alerts SET read_at = NOW()
           WHERE clerk_user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
        [req.userId, ids]
      );
    } else {
      await pool.query(
        `UPDATE user_alerts SET read_at = NOW()
           WHERE clerk_user_id = $1 AND read_at IS NULL`,
        [req.userId]
      );
    }
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/alerts/read error:', e.message);
    res.status(500).json({ success: false, error: 'Failed to mark read' });
  }
});

// POST /api/support/ticket — submit a support request (Get Help form)
app.post('/api/support/ticket', requireAuth, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { category, subject, body, attachedAlertIds } = req.body || {};
    if (!subject || typeof subject !== 'string') return res.status(400).json({ error: 'subject required' });
    if (!body || typeof body !== 'string') return res.status(400).json({ error: 'body required' });
    const allowedCat = ['bug', 'question', 'feature', 'other'];
    const cat = allowedCat.includes(category) ? category : 'other';
    const subj = truncateStr(subject.trim(), 120);
    const bodyStr = truncateStr(body.trim(), 2000);
    const alertIds = Array.isArray(attachedAlertIds)
      ? attachedAlertIds.filter(x => typeof x === 'string').slice(0, 20)
      : [];
    const userAgent = truncateStr(req.headers['user-agent'] || '', 500);
    const pageUrl = truncateStr(req.body?.pageUrl || req.headers['referer'] || '', 500);
    const userEmail = truncateStr(req.body?.userEmail || '', 200);

    // Look up active brand for context
    const brandQ = await pool.query(
      `SELECT id, brand_name, brand_url FROM brand_profiles
        WHERE clerk_user_id = $1 AND is_active = true
        ORDER BY updated_at DESC LIMIT 1`,
      [req.userId]
    );
    const brand = brandQ.rows[0] || null;

    const ins = await pool.query(
      `INSERT INTO support_tickets
         (clerk_user_id, brand_profile_id, user_email, category, subject, body,
          attached_alert_ids, user_agent, page_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING id, created_at`,
      [req.userId, brand?.id || null, userEmail, cat, subj, bodyStr,
       JSON.stringify(alertIds), userAgent, pageUrl]
    );
    const ticketId = ins.rows[0].id;

    // Pull attached alerts to embed in the email
    let attached = [];
    if (alertIds.length > 0) {
      const ar = await pool.query(
        `SELECT id, severity, area, short_message, raw_message, http_status, url, created_at
           FROM user_alerts
           WHERE clerk_user_id = $1 AND id = ANY($2::uuid[])
           ORDER BY created_at DESC`,
        [req.userId, alertIds]
      );
      attached = ar.rows;
    }

    // Fire-and-forget Resend email to Brian. Failures must NOT fail the request.
    if (RESEND_API_KEY) {
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const alertsHtml = attached.length
        ? `<ul style="padding-left:18px;margin:8px 0">` + attached.map(a => `
            <li style="margin:6px 0">
              <strong>[${esc(a.severity)}]</strong>
              <em>${esc(a.area || '-')}</em>
              — ${esc(a.short_message)}
              ${a.http_status ? `<span style="color:#94a3b8"> (HTTP ${esc(a.http_status)})</span>` : ''}
              <div style="font-size:11px;color:#94a3b8">${esc(new Date(a.created_at).toISOString())} · ${esc(a.url || '')}</div>
              ${a.raw_message ? `<pre style="background:#0F1720;color:#E2E8F0;padding:8px;border-radius:6px;font-size:11px;white-space:pre-wrap;margin:4px 0">${esc(String(a.raw_message).slice(0, 500))}</pre>` : ''}
            </li>`).join('') + `</ul>`
        : '<p style="color:#94a3b8;font-size:13px">No alerts attached.</p>';
      const html = `<div style="font-family:Inter,system-ui,sans-serif;color:#0F1720;max-width:680px">
        <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#3563FF;margin:0 0 12px">Forge Intelligence — Support Ticket</p>
        <h1 style="font-size:20px;margin:0 0 8px">${esc(subj)}</h1>
        <p style="font-size:12px;color:#64748b;margin:0 0 16px">Ticket <code>${esc(ticketId)}</code> · Category: <strong>${esc(cat)}</strong></p>
        <table style="font-size:13px;color:#1e293b;border-collapse:collapse;margin-bottom:16px">
          <tr><td style="padding:4px 12px 4px 0;color:#64748b">User</td><td>${esc(userEmail || '(no email)')}<br><code style="font-size:11px;color:#94a3b8">${esc(req.userId)}</code></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#64748b">Brand</td><td>${esc(brand?.brand_name || '-')} <code style="font-size:11px;color:#94a3b8">${esc(brand?.id || '')}</code><br><span style="font-size:11px;color:#94a3b8">${esc(brand?.brand_url || '')}</span></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#64748b">Page</td><td><code style="font-size:11px">${esc(pageUrl)}</code></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#64748b">User Agent</td><td style="font-size:11px;color:#64748b">${esc(userAgent)}</td></tr>
        </table>
        <h3 style="font-size:14px;margin:16px 0 6px">Description</h3>
        <div style="white-space:pre-wrap;background:#F8FAFC;border:1px solid #E2E8F0;padding:12px;border-radius:8px;font-size:13px;line-height:1.6">${esc(bodyStr)}</div>
        <h3 style="font-size:14px;margin:16px 0 6px">Attached alerts (${attached.length})</h3>
        ${alertsHtml}
      </div>`;
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RESEND_API_KEY,
          'Content-Type': 'application/json',
          'User-Agent': 'Forge-Intelligence-Server/1.0',
        },
        body: JSON.stringify({
          from: 'Forge Alerts <alerts@forgeintelligence.ai>',
          to: ['brian@sandbox-xm.com'],
          reply_to: userEmail || undefined,
          subject: `[Forge Support] ${cat}: ${subj}`,
          html,
        }),
      }).then(r => {
        if (!r.ok) r.text().then(t => console.error('Support ticket email failed:', r.status, t.slice(0, 200)));
      }).catch(err => console.error('Support ticket email error:', err.message));
    } else {
      console.log('Support ticket created (no RESEND_API_KEY, email skipped):', ticketId);
    }

    res.json({ success: true, ticketId });
  } catch (e) {
    console.error('POST /api/support/ticket error:', e.message);
    res.status(500).json({ success: false, error: 'Failed to submit ticket' });
  }
});

// GET /api/admin/support/tickets — super-admin only
app.get('/api/admin/support/tickets', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query(
      `SELECT t.id, t.clerk_user_id, t.brand_profile_id, t.user_email, t.category,
              t.subject, t.body, t.attached_alert_ids, t.user_agent, t.page_url,
              t.status, t.created_at, bp.brand_name
         FROM support_tickets t
         LEFT JOIN brand_profiles bp ON bp.id = t.brand_profile_id
         ORDER BY t.created_at DESC
         LIMIT 100`
    );
    res.json({ success: true, tickets: r.rows, total: r.rows.length });
  } catch (e) {
    console.error('GET /api/admin/support/tickets error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
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


// sendTrialWelcomeEmail — fire-and-forget 7-day-trial welcome email, sent once
// when a regular user first tethers a brand. Callers wrap in .catch(); this is
// defensive throughout and resolves quietly on any missing config or failure,
// so it can never break the tether/auth path. Idempotency is enforced per-user
// via brand_profiles.welcome_email_sent_at (trial scope is per-user, not
// per-brand), so a user only ever receives one.
async function sendTrialWelcomeEmail(clerkUserId, brandName) {
  try {
    if (!clerkUserId || !RESEND_API_KEY || !process.env.CLERK_SECRET_KEY) return;

    // Already sent? (Any of the user's brands carrying the marker counts.)
    const already = await pool.query(
      `SELECT 1 FROM brand_profiles WHERE clerk_user_id = $1 AND welcome_email_sent_at IS NOT NULL LIMIT 1`,
      [clerkUserId]
    );
    if (already.rows.length) return;

    // Pull email + first name from Clerk.
    const clerkRes = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { 'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}` }
    });
    if (!clerkRes.ok) return;
    const clerkUser = await clerkRes.json();
    const email = clerkUser.email_addresses?.[0]?.email_address;
    if (!email) return;
    const firstName = (clerkUser.first_name || '').trim() || 'there';
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const brand = (brandName || '').trim();

    const subject = 'Welcome to Forge Intelligence: your 7-day trial is live';
    const html = `<div style="font-family:Inter,system-ui,sans-serif;color:#0F1720;max-width:560px;line-height:1.6">
      <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#3563FF;margin:0 0 14px">Forge Intelligence</p>
      <h1 style="font-size:22px;margin:0 0 12px">Welcome, ${esc(firstName)}.</h1>
      <p style="font-size:15px;margin:0 0 14px">Your 7-day full-access trial${brand ? ` for <strong>${esc(brand)}</strong>` : ''} is live. Every stage of the platform is open, from Context Hub through Publishing and Performance.</p>
      <p style="font-size:15px;margin:0 0 14px">A good first move: run a Context Hub analysis, then let the GEO Strategist surface the topics worth owning. The system gets sharper with every cycle, so the sooner you publish, the faster it compounds.</p>
      <p style="font-size:15px;margin:0 0 20px"><a href="https://forgeintelligence.ai/app/context-hub" style="color:#3563FF;font-weight:600;text-decoration:none">Jump back in &rarr;</a></p>
      <p style="font-size:13px;color:#64748b;margin:0">Questions? Just reply to this email.</p>
    </div>`;

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Forge-Intelligence-Server/1.0',
      },
      body: JSON.stringify({
        from: 'Forge Intelligence <hello@forgeintelligence.ai>',
        to: email,
        subject,
        html,
      }),
    });
    if (!sendRes.ok) return; // don't mark sent if Resend rejected it

    // Mark sent across the user's brands so we never double-send.
    await pool.query(
      `UPDATE brand_profiles SET welcome_email_sent_at = NOW() WHERE clerk_user_id = $1 AND welcome_email_sent_at IS NULL`,
      [clerkUserId]
    );
  } catch (e) {
    console.error('[sendTrialWelcomeEmail]', e.message);
  }
}

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
        const tether1Res = await pool.query(
          `UPDATE brand_profiles SET clerk_user_id = $1, trial_started_at = COALESCE(trial_started_at, NOW()), updated_at = NOW() WHERE id = $2 AND (clerk_user_id IS NULL) RETURNING brand_name`,
          [req.userId, brandId]
        );
        if (tether1Res.rows.length > 0) {
          console.log(`[AUTH] Tethered brand ${brandId} to user ${req.userId} (trial timer started)`);
          // Fire-and-forget: trial welcome email (idempotency-guarded inside)
          sendTrialWelcomeEmail(req.userId, tether1Res.rows[0].brand_name).catch(() => {});
        }
      }
    }

    // Super admin: return ALL brands + auto-tether orphans
    if (isSuperAdmin) {
      // Auto-tether orphan brain ONLY if brand_id explicitly passed (from onboard/gate flow)
      if (brandId) {
        const tethered = await pool.query(
          `UPDATE brand_profiles SET clerk_user_id = $1, trial_started_at = COALESCE(trial_started_at, NOW()), updated_at = NOW()
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
    // Per-user trial state — applies to all brands this user owns
    const trialState = await getUserTrialState(req.userId);
    let result = { rows: allUserBrands.rows.slice(0, 1) };
    // No tethered brand — only tether if brand_id explicitly provided (from GateModal/onboard flow)
    if (!result.rows.length && brandId) {
      const candidate = await pool.query(
        `SELECT * FROM brand_profiles WHERE id = $1 AND (clerk_user_id IS NULL OR clerk_user_id = $2) AND is_active = true LIMIT 1`,
        [brandId, req.userId]
      );
      if (candidate.rows.length) {
        await pool.query(
          `UPDATE brand_profiles SET clerk_user_id = $1, trial_started_at = COALESCE(trial_started_at, NOW()), updated_at = NOW() WHERE id = $2`,
          [req.userId, candidate.rows[0].id]
        );
        result = candidate;
        console.log(`[AUTH] Tethered brand ${candidate.rows[0].id} to user ${req.userId} (trial timer started, explicit brand_id)`);
        // Fire-and-forget: trial welcome email (idempotency-guarded inside)
        sendTrialWelcomeEmail(req.userId, candidate.rows[0].brand_name).catch(() => {});
      }
    }
    // Fire-and-forget: sync user to HubSpot CRM
    
    res.json({
      success: true,
      userId: req.userId,
      isSuperAdmin: isSuperAdmin,
      brand: result.rows[0] || null,
      allBrands: allUserBrands.rows.map(b => ({
        id: b.id,
        brandName: b.brand_name || b.brand_url,
        brandUrl: b.brand_url,
        // isPaid reflects EFFECTIVE access: true if paid OR trial active.
        // FE pages keep checking isPaid via useApp() and get the right answer
        // for both 'permanently paid' and 'trial-active' states.
        isPaid: (b.is_paid || trialState.active) || false,
      })),
      isPaid: isSuperAdmin || result.rows[0]?.is_paid || trialState.active || false,
      trial: {
        active: trialState.active,
        eligible: trialState.eligible,
        daysRemaining: trialState.daysRemaining,
        endsAt: trialState.trialEndsAt,
      },
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
  ['NANGO',         { discount: 100, description: 'Nango Partnership' }],
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



// POST /api/admin/mark-unpublished — flip a (content_id, channel) pair back to
// "not yet published" across every place the publishing system tracks state.
// Manual SQL against publish_log alone was insufficient because the UI reads
// `publishing_queue.publish_results` (JSONB per-channel map) to render the
// "channel X is published" badge. Mirrors the per-channel reset path the
// /api/publishing/queue/:id/reset-channel endpoint already implements at
// server.js:9806 — same DB writes, but keyed on content_id instead of
// queue_item_id so the operator doesn't have to look up the join.
//
// Auth: adminPassword (same shape as other /api/admin/* endpoints).
//
// Body: { contentId: string (UUID), channel: string, adminPassword: string }
//
// Effects on success:
//   - publishing_queue.publish_results[channel] removed
//   - publishing_queue.status recomputed → 'partial' if any other channel
//     still published, else 'staged' (so the queue card resurfaces as
//     ready-to-republish)
//   - publish_log rows for (content_id, channel) deleted
// GET /api/admin/scrape-log — recent forgeScrape activity for observability.
// No more "did the scrape fail because of X or Y?" guessing — answer is
// always a SQL query away. Filterable by caller (which feature triggered
// the scrape) and url substring.
//
// Auth: adminPassword query param (?adminPassword=...) — matches the
// existing /api/admin/* shape so ops can hit it from a browser without
// needing a Clerk token.
//
// Query params:
//   adminPassword — required
//   caller        — optional, filters by caller string ('context-hub',
//                   'site-template', etc.)
//   url           — optional, ILIKE substring match against the URL
//   limit         — default 100, max 500
app.get('/api/admin/scrape-log', async (req, res) => {
  if (req.query.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { caller, url } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const conditions = [];
  const params = [];
  if (caller) { conditions.push(`caller = $${params.length + 1}`); params.push(caller); }
  if (url) { conditions.push(`url ILIKE $${params.length + 1}`); params.push(`%${url}%`); }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);
  try {
    const r = await pool.query(
      `SELECT id, url, source, status_code, body_size, latency_ms, success, caller, error, metadata, created_at
       FROM scrape_log
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    // Summary stats over the returned window
    const total = r.rows.length;
    const successes = r.rows.filter(row => row.success).length;
    const avgLatency = total ? Math.round(r.rows.reduce((s, row) => s + (row.latency_ms || 0), 0) / total) : 0;
    res.json({
      success: true,
      summary: { total, successes, failures: total - successes, successRate: total ? (successes / total) : 0, avgLatencyMs: avgLatency },
      rows: r.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//
// Idempotent: zero rows is a 200 with queueItemsAffected=0.
app.post('/api/admin/mark-unpublished', async (req, res) => {
  const { contentId, channel, adminPassword } = req.body || {};
  if (adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!contentId || typeof contentId !== 'string') {
    return res.status(400).json({ error: 'contentId required' });
  }
  if (!channel || typeof channel !== 'string') {
    return res.status(400).json({ error: 'channel required' });
  }

  try {
    // Find every queue item that has a publish_log row for this (contentId, channel).
    // Same content_id can have multiple log rows from prior republish attempts; we
    // touch every queue item linked to any of them so the system fully forgets the
    // publish across the board.
    const logRes = await pool.query(
      `SELECT DISTINCT queue_item_id, published_url
         FROM publish_log
        WHERE content_id = $1 AND channel = $2 AND queue_item_id IS NOT NULL`,
      [contentId, channel]
    );

    const queueItemIds = logRes.rows.map(r => r.queue_item_id);
    const queueResults = [];

    for (const queueItemId of queueItemIds) {
      const row = await pool.query(
        'SELECT publish_results, status FROM publishing_queue WHERE id = $1',
        [queueItemId]
      );
      if (!row.rows.length) continue;
      const results = row.rows[0].publish_results || {};
      const hadEntry = Object.prototype.hasOwnProperty.call(results, channel);
      delete results[channel];
      const hasAnyPublished = Object.values(results).some(
        r => r && r.status === 'published'
      );
      const newStatus = hasAnyPublished ? 'partial' : 'staged';
      await pool.query(
        'UPDATE publishing_queue SET publish_results = $1, status = $2, updated_at = NOW() WHERE id = $3',
        [JSON.stringify(results), newStatus, queueItemId]
      );
      queueResults.push({
        queueItemId,
        previousStatus: row.rows[0].status,
        newStatus,
        publishResultsHadChannel: hadEntry,
      });
    }

    // Clear publish_log rows for this content+channel. DELETE (not soft-delete)
    // matches the reset-channel endpoint's behavior — full forget so the next
    // publish writes fresh log rows from scratch.
    const delRes = await pool.query(
      'DELETE FROM publish_log WHERE content_id = $1 AND channel = $2 RETURNING id',
      [contentId, channel]
    );

    console.log(`[ADMIN/MARK-UNPUBLISHED] contentId=${contentId} channel=${channel} queueItemsTouched=${queueResults.length} logRowsDeleted=${delRes.rows.length}`);

    return res.json({
      success: true,
      contentId,
      channel,
      queueItemsAffected: queueResults.length,
      queueResults,
      publishLogRowsDeleted: delRes.rows.length,
      message: queueResults.length === 0 && delRes.rows.length === 0
        ? 'No publishing state found for this content+channel — already unpublished or never published.'
        : `Cleared ${queueResults.length} queue item(s) and ${delRes.rows.length} publish_log row(s). Channel is now ready to republish.`,
    });
  } catch (err) {
    console.error('[ADMIN/MARK-UNPUBLISHED]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reset-brand-paid — dev only, resets is_paid for testing
app.post('/api/admin/reset-brand-paid', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && !req.body.adminPassword === process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { brandProfileId, adminPassword } = req.body;
  if (adminPassword !== process.env.ADMIN_RELAY_PASSWORD) return res.status(403).json({ error: 'Forbidden' });
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

  const now = new Date().toISOString();

  // Static public surface — every route in src/main.tsx that's intended for
  // public indexing. Anything gated (/app/*) or post-signup (/welcome) is
  // deliberately omitted.
  const urls = [
    { loc: 'https://forgeintelligence.ai/',               priority: '1.0',  changefreq: 'weekly',  lastmod: now },
    { loc: 'https://forgeintelligence.ai/product',        priority: '0.9',  changefreq: 'weekly',  lastmod: now },
    { loc: 'https://forgeintelligence.ai/about',          priority: '0.85', changefreq: 'monthly', lastmod: now },
    { loc: 'https://forgeintelligence.ai/faq',            priority: '0.85', changefreq: 'monthly', lastmod: now },
    { loc: 'https://forgeintelligence.ai/docs',           priority: '0.7',  changefreq: 'monthly', lastmod: now },
    { loc: 'https://forgeintelligence.ai/privacy',        priority: '0.3',  changefreq: 'yearly',  lastmod: now },
    { loc: 'https://forgeintelligence.ai/terms',          priority: '0.3',  changefreq: 'yearly',  lastmod: now },
    { loc: 'https://forgeintelligence.ai/acceptable-use', priority: '0.3',  changefreq: 'yearly',  lastmod: now },
  ];

  // Doc slugs — hand-mirrored from src/docs/index.ts. Server-side enumeration
  // would need a TS loader; cheaper to keep this list in sync at PR-review time
  // (it grows ~1 entry per integration shipped).
  const docSlugs = ['my-website'];
  for (const slug of docSlugs) {
    urls.push({
      loc: `https://forgeintelligence.ai/docs/${slug}`,
      priority: '0.6',
      changefreq: 'monthly',
      lastmod: now,
    });
  }

  // Pull the Forge Intelligence brand's own published articles so Google indexes them.
  // Only this brand's articles (not customer brands) — customer articles live on their own domains.
  try {
    const brandRes = await pool.query(`SELECT id, brand_name, brand_url FROM brand_profiles WHERE brand_name = 'Forge Intelligence' LIMIT 1`);
    if (brandRes.rows.length) {
      const brand = brandRes.rows[0];
      const safeId = brand.id.replace(/-/g, '_');
      // Canonical slug must match the publish flow's brand_url-based slug (server.js L10184).
      // Mismatch causes Google Search Console to flag "Duplicate without user-selected canonical"
      // because the published/shared URLs and the sitemap point at different paths.
      const brandSlug = (brand.brand_url || brand.brand_name || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
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
// ── IndexNow integration ──────────────────────────────────────────────────────
// IndexNow is Bing/Yandex/Seznam's push-indexing protocol. POST a URL → crawler
// prioritizes it within hours instead of waiting days for organic discovery.
// Google does NOT honor IndexNow (yet) but everyone else in the IndexNow consortium does.
//
// Implementation: https://www.indexnow.org/documentation
//   1. Host the key at /{key}.txt returning the key as plaintext
//   2. POST URLs to api.indexnow.org/IndexNow with { host, key, keyLocation, urlList }
//   3. 200 = accepted; 4xx = problem with request; 5xx = rate-limit or outage
const INDEXNOW_KEY = 'c50321f04adc5a3a3566504b015a97fb33e2805391f92827';

app.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.type('text/plain');
  res.send(INDEXNOW_KEY);
});

// Helper: submit a batch of URLs to IndexNow. Returns the HTTP status code.
async function submitToIndexNow(urls, host = 'forgeintelligence.ai') {
  if (!Array.isArray(urls) || urls.length === 0) return { status: 0, error: 'no urls' };
  const payload = {
    host,
    key: INDEXNOW_KEY,
    keyLocation: `https://${host}/${INDEXNOW_KEY}.txt`,
    urlList: urls.slice(0, 10000)  // IndexNow caps at 10k per request
  };
  try {
    const r = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const body = await r.text().catch(() => '');
    return { status: r.status, body: body.slice(0, 500), submitted: payload.urlList.length };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

// POST /api/admin/indexnow/backfill — submit every Forge Intelligence article to IndexNow.
// Gated by ADMIN_RELAY_PASSWORD. Use this after SEO hygiene fixes to force re-crawl.
app.post('/api/admin/indexnow/backfill', express.json({ limit: '50kb' }), async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    // Forge Intelligence's own brand — customer brand articles are noindexed on forgeintelligence.ai
    // so we never submit them here. Their real domains should be pinging IndexNow on their own.
    const FORGE_OWN_BRAND_ID = 'cde5feeb-b3d7-4990-adee-a54977ab9c52';
    const brandRes = await pool.query(
      `SELECT brand_name, brand_url FROM brand_profiles WHERE id = $1`,
      [FORGE_OWN_BRAND_ID]
    );
    if (!brandRes.rows.length) return res.status(404).json({ error: 'Forge Intelligence brand not found' });

    const safeId = FORGE_OWN_BRAND_ID.replace(/-/g, '_');
    // Canonical slug — must match publish flow + sitemap (brand_url-based)
    const brandSlug = (brandRes.rows[0].brand_url || brandRes.rows[0].brand_name || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');

    const articlesRes = await pool.query(
      `SELECT id, title FROM generated_content_${safeId}
       WHERE compliance_status IN ('approved', 'ready')
       ORDER BY created_at DESC LIMIT 500`
    );

    const articleUrls = articlesRes.rows.map(a => {
      const slug = (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      return `https://forgeintelligence.ai/articles/${brandSlug}/${slug}`;
    }).filter(Boolean);

    // Also include marketing pages so their updated descriptions get picked up
    const marketingUrls = [
      'https://forgeintelligence.ai/',
      'https://forgeintelligence.ai/product',
      'https://forgeintelligence.ai/faq',
      'https://forgeintelligence.ai/articles'
    ];

    const urls = [...marketingUrls, ...articleUrls];
    const result = await submitToIndexNow(urls);

    res.json({
      success: result.status >= 200 && result.status < 300,
      submitted: urls.length,
      articleCount: articleUrls.length,
      marketingPageCount: marketingUrls.length,
      indexNowResponse: result
    });
  } catch(e) {
    console.error('[IndexNow backfill]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/indexnow/submit — submit arbitrary URLs (for targeted re-crawls)
app.post('/api/admin/indexnow/submit', express.json({ limit: '100kb' }), async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  if (!urls.length) return res.status(400).json({ error: 'urls array required' });
  const result = await submitToIndexNow(urls);
  res.json({ success: result.status >= 200 && result.status < 300, indexNowResponse: result });
});


app.get('/robots.txt', async (req, res) => {
  const host = req.headers.host || '';
  const isDev = host.includes('dev.');
  res.type('text/plain');

  if (isDev) {
    res.send('User-agent: *\nDisallow: /');
    return;
  }

  // ── Customer preview paths — block crawling ─────────────────────────
  // Customer brand articles are previewable on forgeintelligence.ai but must NOT be
  // indexed. Dynamically disallow /articles/<brand-slug>/ for every brand except
  // Forge Intelligence's own. This is a belt-and-suspenders measure alongside the
  // noindex meta tag injected at the article SSR layer.
  const FORGE_OWN_BRAND_ID = 'cde5feeb-b3d7-4990-adee-a54977ab9c52';
  let customerDisallows = '';
  try {
    const brandsRes = await pool.query(
      `SELECT id, brand_url, brand_name FROM brand_profiles WHERE id != $1`,
      [FORGE_OWN_BRAND_ID]
    );
    const slugs = new Set();
    for (const b of brandsRes.rows) {
      // Same slug derivation as the article router uses (L1264-ish)
      const s1 = (b.brand_url || '').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const s2 = (b.brand_name || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      if (s1) slugs.add(s1.replace(/^-+|-+$/g, ''));
      if (s2) slugs.add(s2.replace(/^-+|-+$/g, ''));
    }
    customerDisallows = [...slugs].filter(Boolean).map(s => `Disallow: /articles/${s}/`).join('\n');
  } catch(e) {
    console.warn('[robots.txt] customer brand lookup failed:', e.message);
  }

  // Explicit per-crawler allow-list. Passive `Allow: /` with wildcard was permitting crawlers
  // but not signaling discovery preference. Naming each AI crawler explicitly raises the
  // likelihood of indexation (particularly for young domains like forgeintelligence.ai where
  // GPTBot/ClaudeBot are slower to crawl). Covers:
  //   • AI search crawlers: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, anthropic-ai,
  //     PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, Bytespider,
  //     Amazonbot, cohere-ai, CCBot, FacebookBot, meta-externalagent, Omgili, Bingbot-AI
  //   • Traditional search: Googlebot, Bingbot, DuckDuckBot, Slurp (Yahoo), YandexBot
  //   • Wildcard fallback for anything else: allow all, same as before.
  const aiCrawlers = [
    'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
    'ClaudeBot', 'anthropic-ai', 'Claude-Web',
    'PerplexityBot', 'Perplexity-User',
    'Google-Extended',
    'Applebot-Extended',
    'Bytespider',
    'Amazonbot',
    'cohere-ai',
    'CCBot',
    'FacebookBot', 'meta-externalagent',
    'Omgilibot', 'Omgili',
    'DiffBot',
    'YouBot',
  ];
  const searchCrawlers = ['Googlebot', 'Bingbot', 'DuckDuckBot', 'Slurp', 'YandexBot', 'Applebot'];

  const allowBlock = (ua) => `User-agent: ${ua}\nAllow: /\nDisallow: /app/\nDisallow: /api/\n${customerDisallows ? customerDisallows + '\n' : ''}`;

  const lines = [
    '# Forge Intelligence — robots.txt',
    '# AI crawlers and search engines explicitly welcomed. App routes and API are blocked from all.',
    '',
    ...aiCrawlers.map(allowBlock),
    ...searchCrawlers.map(allowBlock),
    '# Default — permissive for everything else',
    'User-agent: *',
    'Allow: /',
    'Disallow: /app/',
    'Disallow: /api/',
    ...(customerDisallows ? customerDisallows.split('\n') : []),
    '',
    'Sitemap: https://forgeintelligence.ai/sitemap.xml'
  ];

  res.send(lines.join('\n'));
});

// ── API Key Management ────────────────────────────────────────────────────────
// Admin endpoints for minting, listing, and revoking API keys. Gated by adminPassword
// since key management is privileged (a key grants long-lived access without user rotation).


const MCP_TOOLS = [
  {
    name: 'list_email_campaigns',
    description: 'List email campaigns saved in Forge for the authorized brand. Returns campaign id, target persona, campaign type, status, number of emails, and the brief summary. Use this first to find the campaign you want, then call list_emails_in_campaign to see individual emails.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['complete', 'pending', 'draft', 'all'], description: 'Filter by status. Default: complete.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max campaigns to return. Default 20.' }
      }
    },
    requiredScope: 'mcp:campaigns:read'
  },
  {
    name: 'list_emails_in_campaign',
    description: 'List the emails inside a specific email campaign. Returns each email index, send day, subject line variants (benefit/curiosity/pattern_interrupt), preview text, CTA, status, and the strategic job each email is meant to do. Use this to see what is in a campaign before pulling the full copy of one email.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'The campaign id from list_email_campaigns.' }
      },
      required: ['campaign_id']
    },
    requiredScope: 'mcp:emails:read'
  },
  {
    name: 'get_email_copy',
    description: 'Get the full copy of a single email — ready to paste into Attio, an email client, or anywhere else. Returns subject line variants, preview text, body, CTA text + URL placeholder, optional PS, and the strategic job the email performs.',
    inputSchema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'The email id from list_emails_in_campaign.' },
        subject_variant: { type: 'string', enum: ['benefit', 'curiosity', 'pattern_interrupt', 'all'], description: 'Which subject variant to highlight. Default all.' }
      },
      required: ['email_id']
    },
    requiredScope: 'mcp:emails:read'
  }
];

async function mcpToolListCampaigns({ args, brandIds }) {
  const status = (args.status && args.status !== 'all') ? args.status : null;
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
  const params = [brandIds];
  let where = `brand_profile_id = ANY($1::text[])`;
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  else { where += ` AND status = 'complete'`; }
  const result = await pool.query(
    `SELECT c.id, c.brand_profile_id, c.status, c.brief, c.created_at,
            (SELECT COUNT(*) FROM email_campaign_emails e WHERE e.campaign_id = c.id) AS email_count
       FROM email_campaigns c WHERE ${where}
       ORDER BY c.created_at DESC LIMIT ${limit}`,
    params
  );
  return result.rows.map(r => {
    const brief = (typeof r.brief === 'string'
      ? (() => { try { return JSON.parse(r.brief); } catch { return {}; } })()
      : (r.brief || {}));
    return {
      campaign_id: r.id,
      brand_profile_id: r.brand_profile_id,
      status: r.status,
      target_persona: brief.target_persona || null,
      campaign_type: brief.campaign_type || null,
      smart_goal: brief.smart_goal || null,
      pain_point: brief.pain_point ? String(brief.pain_point).slice(0, 300) : null,
      email_count: parseInt(r.email_count, 10) || 0,
      created_at: r.created_at
    };
  });
}

async function mcpToolListEmails({ args, brandIds }) {
  const campaignId = args.campaign_id;
  if (!campaignId || typeof campaignId !== 'string') throw new Error('campaign_id required');
  const cRes = await pool.query(
    `SELECT id, brand_profile_id, brief, status FROM email_campaigns
      WHERE id = $1 AND brand_profile_id = ANY($2::text[]) LIMIT 1`,
    [campaignId, brandIds]
  );
  if (cRes.rows.length === 0) throw new Error('campaign not found or not accessible');
  const eRes = await pool.query(
    `SELECT id, email_index, job, send_day, subject_lines, preview_text, cta_text, status
       FROM email_campaign_emails WHERE campaign_id = $1 ORDER BY email_index ASC`,
    [campaignId]
  );
  return {
    campaign_id: campaignId,
    campaign_status: cRes.rows[0].status,
    emails: eRes.rows.map(e => ({
      email_id: e.id,
      email_index: e.email_index,
      send_day: e.send_day,
      job: e.job,
      subject_lines: typeof e.subject_lines === 'string'
        ? (() => { try { return JSON.parse(e.subject_lines); } catch { return {}; } })()
        : (e.subject_lines || {}),
      preview_text: e.preview_text,
      cta_text: e.cta_text,
      status: e.status
    }))
  };
}

async function mcpToolGetEmail({ args, brandIds }) {
  const emailId = args.email_id;
  if (!emailId || typeof emailId !== 'string') throw new Error('email_id required');
  const variant = args.subject_variant || 'all';
  const r = await pool.query(
    `SELECT e.*, c.brand_profile_id
       FROM email_campaign_emails e JOIN email_campaigns c ON c.id = e.campaign_id
      WHERE e.id = $1 AND c.brand_profile_id = ANY($2::text[]) LIMIT 1`,
    [emailId, brandIds]
  );
  if (r.rows.length === 0) throw new Error('email not found or not accessible');
  const e = r.rows[0];
  const subjects = typeof e.subject_lines === 'string'
    ? (() => { try { return JSON.parse(e.subject_lines); } catch { return {}; } })()
    : (e.subject_lines || {});
  return {
    email_id: e.id,
    campaign_id: e.campaign_id,
    email_index: e.email_index,
    send_day: e.send_day,
    job: e.job,
    preview_text: e.preview_text,
    body: e.body,
    cta_text: e.cta_text,
    cta_url_placeholder: e.cta_url_placeholder,
    ps: e.ps,
    confidence_score: e.confidence_score,
    status: e.status,
    subject_lines: variant === 'all' ? subjects : { [variant]: subjects[variant] }
  };
}

app.post('/mcp', express.json({ limit: '256kb' }), mcpAuth, async (req, res) => {
  const rpc = req.body || {};
  const id = rpc.id !== undefined ? rpc.id : null;
  const method = rpc.method;
  const sendError = (code, message, data) => res.json({
    jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) }
  });
  const sendResult = (result) => res.json({ jsonrpc: '2.0', id, result });

  try {
    if (rpc.jsonrpc !== '2.0') return sendError(-32600, 'Invalid Request: jsonrpc must be "2.0"');
    if (!method) return sendError(-32600, 'Invalid Request: method required');

    if (method === 'initialize') {
      return sendResult({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-intelligence-mcp', version: '0.1.0' }
      });
    }

    if (method === 'tools/list') {
      const allowed = MCP_TOOLS
        .filter(t => req.apiKeyAuth.scopes.includes(t.requiredScope))
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return sendResult({ tools: allowed });
    }

    if (method === 'tools/call') {
      const params = rpc.params || {};
      const toolName = params.name;
      const args = params.arguments || {};
      const tool = MCP_TOOLS.find(t => t.name === toolName);
      if (!tool) return sendError(-32601, `Unknown tool: ${toolName}`);
      if (!req.apiKeyAuth.scopes.includes(tool.requiredScope)) return sendError(-32000, `Missing scope: ${tool.requiredScope}`);
      const brandIds = req.apiKeyAuth.brandIds;
      if (!brandIds || brandIds.length === 0) return sendError(-32000, 'API key has no associated brands');

      try {
        let toolResult;
        if (toolName === 'list_email_campaigns') toolResult = await mcpToolListCampaigns({ args, brandIds });
        else if (toolName === 'list_emails_in_campaign') toolResult = await mcpToolListEmails({ args, brandIds });
        else if (toolName === 'get_email_copy') toolResult = await mcpToolGetEmail({ args, brandIds });
        else return sendError(-32601, `Tool '${toolName}' has no implementation`);

        return sendResult({
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
          isError: false
        });
      } catch (toolErr) {
        console.error(`[MCP tool ${toolName}]`, toolErr.message);
        return sendResult({
          content: [{ type: 'text', text: `Tool error: ${toolErr.message}` }],
          isError: true
        });
      }
    }

    return sendError(-32601, `Method not found: ${method}`);
  } catch(e) {
    console.error('[MCP]', e.message);
    return sendError(-32603, 'Internal error', { message: e.message });
  }
});

app.get('/mcp', (req, res) => {
  res.json({
    server: 'forge-intelligence-mcp',
    version: '0.1.0',
    transport: 'http',
    protocol: 'JSON-RPC 2.0',
    auth: 'Bearer token in Authorization header (or X-Api-Key)',
    docs: 'POST { jsonrpc: "2.0", id: 1, method: "tools/list" } with auth header',
    tools: MCP_TOOLS.map(({ name, description }) => ({ name, description }))
  });
});

// POST /api/admin/api-keys — mint a new key. Plaintext returned ONCE; thereafter only hash.
// Body: { adminPassword, label, brandProfileIds: [uuid], scopes: [string], env?: 'live'|'test' }
app.post('/api/admin/api-keys', express.json({ limit: '50kb' }), async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const { label, brandProfileIds, scopes, env } = req.body;
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'label required' });
  if (!Array.isArray(brandProfileIds) || brandProfileIds.length === 0) return res.status(400).json({ error: 'brandProfileIds must be a non-empty array' });
  if (!Array.isArray(scopes) || scopes.length === 0) return res.status(400).json({ error: 'scopes must be a non-empty array' });
  const envPrefix = env === 'test' ? 'test' : 'live';
  try {
    const keySuffix = randomBytes(32).toString('hex');
    const plaintext = `fik_${envPrefix}_${keySuffix}`;
    const keyHash = hashApiKey(plaintext);
    const r = await pool.query(
      `INSERT INTO api_keys (key_hash, label, brand_profile_ids, scopes)
       VALUES ($1, $2, $3, $4) RETURNING id, label, created_at`,
      [keyHash, label, brandProfileIds, scopes]
    );
    res.json({
      success: true,
      id: r.rows[0].id,
      label: r.rows[0].label,
      key: plaintext,
      warning: 'Store this key securely. It will not be shown again.',
      createdAt: r.rows[0].created_at
    });
  } catch(e) {
    console.error('[API-KEY mint]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/api-keys?adminPassword=... — list (metadata only, no plaintext)
app.get('/api/admin/api-keys', async (req, res) => {
  if (req.query?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const r = await pool.query(
      `SELECT id, label, brand_profile_ids, scopes, created_at, last_used_at, last_used_ip, revoked_at
       FROM api_keys ORDER BY created_at DESC`
    );
    res.json({ success: true, keys: r.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/api-keys/:id — revoke (soft-delete via revoked_at)
app.delete('/api/admin/api-keys/:id', express.json({ limit: '10kb' }), async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const r = await pool.query(
      `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id, label`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Key not found or already revoked' });
    res.json({ success: true, revoked: r.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Neon SQL Relay ────────────────────────────────────────────────────────────
app.post('/api/admin/relay', express.json({ limit: '500kb' }), async (req, res) => {
  const { adminPassword, query, values } = req.body;
  if (adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const result = await pool.query(query, values || []);
    return res.json({ success: true, rows: result.rows, rowCount: result.rowCount });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Zernio Test Endpoints (dev-only) ──────────────────────────────────────────
// Three diagnostic endpoints that exercise the Zernio social media API with
// per-stage signal. Reject on production host so we can't accidentally fire
// these against forgeintelligence.ai. Same adminPassword gate as /api/admin/relay.
// Once Zernio is validated as the Pipedream replacement, these come out and the
// real integration ships into the publishing pipeline as a normal vendor.




// GET-style — list profiles. Lightest possible test: validates key + reachability.
app.post('/api/admin/zernio/profiles', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const result = await callZernio('GET', '/profiles');
    res.json({ success: true, stage: 'list-profiles', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'list-profiles', error: e.message });
  }
});

// List connected accounts — gives us the LinkedIn account_id for the post step.
app.post('/api/admin/zernio/accounts', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const result = await callZernio('GET', '/accounts');
    res.json({ success: true, stage: 'list-accounts', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'list-accounts', error: e.message });
  }
});

// Create a post. Pass through full body (minus adminPassword) so we can test
// publishNow vs scheduledFor vs draft from a single endpoint.
app.post('/api/admin/zernio/post', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { adminPassword, ...postBody } = req.body;
    const result = await callZernio('POST', '/posts', postBody);
    res.json({ success: true, stage: 'create-post', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'create-post', error: e.message });
  }
});

// Test: probe Zernio's /connect/:platform to see what an OAuth-start response looks like.
app.post('/api/admin/zernio/probe-connect', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { platform, profileId, returnUrl, ...extras } = req.body;
    const params = new URLSearchParams();
    if (profileId) params.set('profileId', profileId);
    if (returnUrl) params.set('returnUrl', returnUrl);
    // Forward any extra body keys as query params for probing
    for (const [k, v] of Object.entries(extras)) {
      if (k !== 'adminPassword' && typeof v === 'string') params.set(k, v);
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    const result = await callZernio('GET', `/connect/${platform}${qs}`);
    res.json({ success: true, stage: 'probe-connect', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'probe-connect', error: e.message });
  }
});

// Test the connect endpoint to see what shape Zernio's OAuth init looks like.
// Body: { profileId, platform, redirectUrl?, state? }
app.post('/api/admin/zernio/connect-test', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { profileId, platform, redirectUrl, state } = req.body;
    if (!profileId || !platform) return res.status(400).json({ success: false, error: 'profileId + platform required' });

    const params = new URLSearchParams({ profileId });
    if (redirectUrl) params.set('redirectUrl', redirectUrl);
    if (state) params.set('state', state);

    const path = `/connect/${platform}?${params.toString()}`;
    const result = await callZernio('GET', path);
    res.json({ success: true, stage: 'connect-init', path, ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'connect-init', error: e.message });
  }
});

// Create a Zernio profile (needed to associate accounts with a Forge brand).
// Body: { name, description? }
app.post('/api/admin/zernio/create-profile', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const result = await callZernio('POST', '/profiles', { name, description });
    res.json({ success: true, stage: 'create-profile', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'create-profile', error: e.message });
  }
});

// ── Production Zernio OAuth proxy ────────────────────────────────────────────
// Three-step flow:
//   1. POST /api/zernio/connect → returns authUrl, customer redirects to LinkedIn
//   2. LinkedIn → Zernio's callback (out of band)
//   3. GET /integrations/zernio/callback → Zernio bounces back, we save zernioAccountId



// POST /api/admin/zernio/raw — Generic Zernio API probe for admin debugging.
// Body: { adminPassword, method: 'GET'|'POST'|..., path: '/analytics?postId=...', body?: {...} }
// Used to validate API behavior without redeploying. Live tool, not test-only.
app.post('/api/admin/zernio/raw', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { method = 'GET', path, body } = req.body;
    if (!path) return res.status(400).json({ success: false, error: 'path required' });
    const result = await callZernio(method, path, body);
    res.json({ success: true, request: { method, path, body }, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/zernio/connect', requireAuth, async (req, res) => {
  try {
    const { brandProfileId, platform } = req.body;
    if (!brandProfileId || !platform) return res.status(400).json({ success: false, error: 'brandProfileId + platform required' });
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ success: false, error: 'Access denied' });
    if (!process.env.ZERNIO_API_KEY) return res.status(500).json({ success: false, error: 'ZERNIO_API_KEY not configured' });

    const zernioProfileId = await getOrCreateZernioProfile(brandProfileId);

    // Encode brandProfileId + platform in redirectUrl. Zernio echoes redirectUrl as-is, so
    // the query string round-trips through the OAuth flow back to us.
    const reqHost = req.headers.host || 'forgeintelligence.ai';
    const proto = reqHost.includes('localhost') ? 'http' : 'https';
    const redirectUrl = `${proto}://${reqHost}/integrations/zernio/callback?brand=${encodeURIComponent(brandProfileId)}&platform=${encodeURIComponent(platform)}&zernio_profile_id=${encodeURIComponent(zernioProfileId)}`;

    const params = new URLSearchParams({ profileId: zernioProfileId, redirectUrl });
    const result = await callZernio('GET', `/connect/${platform}?${params.toString()}`);

    if (!result.ok) return res.status(result.status).json({ success: false, error: `Zernio /connect failed: ${result.raw?.slice(0, 200)}` });
    const authUrl = result.parsed?.authUrl;
    if (!authUrl) return res.status(500).json({ success: false, error: 'Zernio /connect response missing authUrl' });

    res.json({ success: true, authUrl, zernioProfileId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Public callback. Zernio bounces here after the user authorizes.
app.get('/integrations/zernio/callback', async (req, res) => {
  try {
    const { brand, platform, zernio_profile_id, error } = req.query;
    if (error || !brand || !platform) {
      return res.redirect(`/app/integrations?connected=error&reason=${encodeURIComponent(error || 'missing-params')}`);
    }

    // Find the newest matching account in this brand's Zernio profile.
    const accountsRes = await callZernio('GET', '/accounts');
    if (!accountsRes.ok) {
      console.error('[ZERNIO-CALLBACK] accounts list failed:', accountsRes.status, accountsRes.raw?.slice(0, 200));
      return res.redirect(`/app/integrations?connected=error&reason=accounts-list-failed`);
    }

    const allAccounts = accountsRes.parsed?.accounts || [];
    const platformAccounts = allAccounts.filter(a => a.platform === platform);
    console.log(`[ZERNIO-CALLBACK] Total accounts: ${allAccounts.length}, ${platform} accounts: ${platformAccounts.length}, zernio_profile_id from query: ${zernio_profile_id}`);
    if (platformAccounts.length > 0) {
      console.log(`[ZERNIO-CALLBACK] First ${platform} account profileId:`, JSON.stringify(platformAccounts[0].profileId), 'type:', typeof platformAccounts[0].profileId);
    }

    const accounts = platformAccounts
      .filter(a => {
        const pid = (a.profileId && typeof a.profileId === 'object') ? a.profileId._id : a.profileId;
        const match = pid === zernio_profile_id;
        if (!match && platformAccounts.length > 0) {
          console.log(`[ZERNIO-CALLBACK] Profile ID mismatch: account pid="${pid}" vs query="${zernio_profile_id}"`);
        }
        return match;
      })
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

    if (!accounts.length) {
      // Fallback: if profile ID matching fails but there's exactly one account for this platform, use it
      if (platformAccounts.length > 0) {
        console.log(`[ZERNIO-CALLBACK] Profile ID filter found 0 matches but ${platformAccounts.length} ${platform} accounts exist — using newest`);
        const fallback = platformAccounts.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0];
        accounts.push(fallback);
      } else {
        console.log(`[ZERNIO-CALLBACK] No ${platform} accounts found at all`);
        return res.redirect(`/app/integrations?connected=error&reason=no-account-found`);
      }
    }
    const newAccount = accounts[0];

    // Merge zernioAccountId into existing credentials (don't clobber other keys).
    const existing = await pool.query(
      `SELECT id, credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2`,
      [brand, platform]
    );
    const existingCreds = existing.rows.length
      ? (typeof existing.rows[0].credentials === 'string' ? JSON.parse(existing.rows[0].credentials || '{}') : (existing.rows[0].credentials || {}))
      : {};
    const creds = JSON.stringify({ ...existingCreds, provider: 'zernio', zernioAccountId: newAccount._id, zernioProfileId: zernio_profile_id, platform, accountName: newAccount.name || newAccount.username || platform });
    if (existing.rows.length) {
      await pool.query(
        `UPDATE publishing_channels SET credentials = $1::jsonb, is_active = true, updated_at = NOW() WHERE id = $2`,
        [creds, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_active) VALUES ($1, $2, $3::jsonb, true)`,
        [brand, platform, creds]
      );
    }

    res.redirect(`/app/integrations?connected=zernio:${platform}`);
  } catch (e) {
    console.error('[ZERNIO-CALLBACK]', e.message);
    res.redirect(`/app/integrations?connected=error&reason=${encodeURIComponent(e.message.slice(0, 100))}`);
  }
});

// ── Content Import (Bring Your Own Article) ──────────────────────────────────

// POST /api/content/import — parse + score an externally written article.
// Accepts auth via Clerk JWT (UI) OR API key (Frank/ForgeOS and similar machine integrations).
// API-key path requires scope 'content:import' + brand must be in the key's allowed list.
app.post('/api/content/import', requireAuth, requireApiKeyScope('content:import'), async (req, res) => {
  const { brandProfileId, url, rawText, title: manualTitle, originalContentId, editReason } = req.body;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  if (!url && !rawText) return res.status(400).json({ error: 'url or rawText required' });

  // Edit-reconciliation mode: if originalContentId is provided, we're importing
  // an externally-edited version of a Forge-generated article. The audit shifts
  // from 'score this net-new piece' to 'diff this edit vs. the draft and extract
  // brain-worthy deltas.' Powered by Frank (ForgeOS webmaster) who edits articles
  // before publishing them to Sandbox-XM and whose edits we want to learn from.
  let originalArticle = null;
  if (originalContentId) {
    try {
      const safeIdLookup = brandProfileId.replace(/-/g, '_');
      const origRes = await pool.query(
        `SELECT id, title, article_json FROM generated_content_${safeIdLookup} WHERE id = $1`,
        [originalContentId]
      );
      if (origRes.rows.length) {
        originalArticle = origRes.rows[0];
      }
    } catch(e) {
      // Non-fatal — fall through to standard audit mode if original not found
      console.warn('[IMPORT] originalContentId lookup failed:', e.message);
    }
  }

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

    // 2. Load brand profile for Brain context.
    // voice_profile lives inside profile_data JSONB (not as a top-level column) — extract it here.
    // personas/competitive_gaps were previously SELECTed but never used in the audit prompt, so dropped.
    const brandRes = await pool.query(
      `SELECT brand_name, brand_url, profile_data->'voice_profile' as voice_profile
       FROM brand_profiles WHERE id = $1`,
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

    // 4. Claude Sonnet: parse + audit. Two modes:
    //   (a) standard import — score an outside article against the brand brain
    //   (b) edit-reconciliation — compare Frank's edit to the Forge draft and
    //       extract brain-worthy deltas (patterns Frank applied, mistakes he caught)
    const originalBody = originalArticle
      ? (originalArticle.article_json?.sections || [])
          .map(s => `### ${s.heading || ''}\n${s.body || s.content || ''}`)
          .join('\n\n').slice(0, 6000)
      : '';

    const auditPrompt = originalArticle ? `You are the Forge Intelligence Brain Auditor in EDIT-RECONCILIATION mode.

Frank, an external editor (ForgeOS), reviewed and edited a Forge-generated article before publishing. Your job is to extract brain-worthy signal from Frank's edits — not to score the article, but to learn from the delta.

BRAND: ${brand.brand_name} (${brand.brand_url})
VOICE PROFILE: ${JSON.stringify(brand.voice_profile || {}).slice(0, 500)}
EXISTING BRAIN PATTERNS: ${patternsRes.rows.map(p => p.description).join('; ').slice(0, 600)}
EXISTING BRAIN MISTAKES: ${mistakesRes.rows.map(m => m.description).join('; ').slice(0, 400)}

ARTICLE TITLE: ${originalArticle.title}
EDITOR'S STATED REASON: ${editReason || '(not provided)'}

═══ FORGE DRAFT (original) ═══
${originalBody}

═══ FRANK'S EDIT (published version) ═══
${rawContent.slice(0, 6000)}

Your job:
1. Identify what Frank CHANGED between the draft and the published version.
2. For each meaningful change, classify: is it a PATTERN (something Frank improved that Forge should do next time) or a MISTAKE (something Forge got wrong that Frank had to fix)?
3. Ignore purely cosmetic edits (whitespace, punctuation, inline typos). Focus on structural, voice, factual, or strategic changes.
4. Be specific. 'Frank tightened the intro' is useless. 'Frank removed hedging language (maybe, perhaps, somewhat) that softened the core claim' is useful.
5. Skip changes that are one-off (specific to this article only). Only surface patterns Forge could apply going forward.

CRITICAL — TWO SEPARATE OUTPUTS:
- The "sections" array reproduces the PUBLISHED ARTICLE PROSE VERBATIM. Each section is one H2/H3 from Frank's published version. The "body" field contains the EXACT prose Frank published under that heading, copied word-for-word from the published version above. Do NOT summarize. Do NOT describe what Frank changed. Do NOT write meta-commentary about Frank's pipeline operations or page infrastructure. The "body" field is the actual article content as a reader would encounter it on the page.
- The "brainPatterns" and "brainMistakes" arrays are where you describe Frank's changes and edits. ALL change-analysis goes in those fields, NEVER in section bodies.
- If a heading in Frank's published version is purely structural (e.g. a TL;DR block, FAQ, or CTA box), the body field still contains the literal text that appears under that heading on the page — not a description of why it was added.

Return ONLY valid JSON:
{
  "title": "article title",
  "editSummary": "1-2 sentence summary of what Frank changed overall",
  "editImpactScore": 0-100,
  "sections": [
    {
      "heading": "section heading from Frank's published version",
      "body": "VERBATIM PROSE under that heading from Frank's published version — the literal article text as published, not a description of changes. If you find yourself writing 'Frank added' or 'Forge's draft did X', you are doing this WRONG — that goes in brainPatterns/brainMistakes instead.",
      "confidence": 0-100,
      "flags": []
    }
  ],
  "brainPatterns": [
    {
      "pattern_type": "voice|structural|factual|strategic",
      "description": "specific, actionable pattern Forge should apply next time",
      "evidence": "quote or paraphrase of the Frank edit that demonstrates it"
    }
  ],
  "brainMistakes": [
    {
      "mistake_type": "voice|structural|factual|strategic",
      "description": "specific mistake Forge made that Frank had to fix",
      "severity": "low|medium|high",
      "evidence": "quote from the Forge draft showing the mistake"
    }
  ]
}` : `You are the Forge Intelligence Brain Auditor. An article was written OUTSIDE of Forge and is being imported for scoring.

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
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: auditPrompt }]
      })
    });
    const auditData = await auditRes.json();
    const auditText = auditData.content?.[0]?.text || '';
    const parsed = JSON.parse(auditText.replace(/```json|```/g, '').trim());

    // 5. Insert (net-new) or UPDATE (edit-reconciliation) into generated_content.
    //    Edit-reconciliation preserves the original article's id + queue placement
    //    so Frank's edit replaces the draft in-place rather than spawning a dup.
    const cleanedParsed = stripScaffoldingArtifacts(parsed);
    let contentId;
    if (originalArticle) {
      // Merge cleanedParsed (which has Frank's edited sections) into the existing article_json,
      // preserving any fields we don't want to overwrite (keyTakeaway, faqs, hero_image, etc.
      // unless Frank's audit produced new values).
      const mergedJson = {
        ...(originalArticle.article_json || {}),
        ...cleanedParsed,
        editedBy: 'external_editor',
        editedAt: new Date().toISOString(),
        editReason: editReason || null,
        editImpactScore: parsed.editImpactScore || null,
      };
      await pool.query(
        `UPDATE ${tableName} SET article_json = $1, title = $2, updated_at = NOW() WHERE id = $3`,
        [JSON.stringify(mergedJson), cleanedParsed.title || originalArticle.title, originalArticle.id]
      );
      contentId = originalArticle.id;
    } else {
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
      contentId = insertRes.rows[0].id;
    }

    // 6. Stage in publishing queue (only for net-new imports, not edit-reconciliation
    //    — edit-reconciliation updates an EXISTING article, it doesn't create a new queue item)
    if (!originalArticle) {
      await pool.query(
        `INSERT INTO publishing_queue (brand_profile_id, content_id, title, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'staged', NOW(), NOW())
         ON CONFLICT (content_id) DO NOTHING`,
        [brandProfileId, contentId, parsed.title || sourceTitle]
      );
    }

    // 7. Close the learning loop — stage brain contributions from this import/edit.
    //    Uses source_channel='external_editor' so Brian can filter these in review
    //    and they don't silently influence future generations until promoted.
    let brainPatternsAdded = 0;
    let brainMistakesAdded = 0;
    try {
      if (originalArticle && Array.isArray(parsed.brainPatterns)) {
        for (const p of parsed.brainPatterns) {
          if (!p?.description) continue;
          const description = String(p.description).slice(0, 1000);
          const evidence = p.evidence ? String(p.evidence).slice(0, 500) : null;
          const tags = [p.pattern_type || 'general', 'source:external_editor'].filter(Boolean);
          await pool.query(
            `INSERT INTO brain_patterns (brand_profile_id, pattern_type, description, confidence_score, success_rate, tags, source_channel, example_titles)
             VALUES ($1, $2, $3, 50, 0, $4, 'external_editor', $5)`,
            [brandProfileId, p.pattern_type || 'voice', evidence ? `${description}\n\nEvidence: ${evidence}` : description, JSON.stringify(tags), JSON.stringify([originalArticle.title])]
          );
          brainPatternsAdded++;
        }
      }
      if (originalArticle && Array.isArray(parsed.brainMistakes)) {
        for (const m of parsed.brainMistakes) {
          if (!m?.description) continue;
          const description = String(m.description).slice(0, 1000);
          const evidence = m.evidence ? String(m.evidence).slice(0, 500) : null;
          await pool.query(
            `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, human_feedback, severity, guardrail_created)
             VALUES ($1, $2, $3, $4, $5, false)`,
            [brandProfileId, m.mistake_type || 'voice', evidence ? `${description}\n\nEvidence: ${evidence}` : description, `source: external_editor | article: ${originalArticle.title}`, m.severity || 'medium']
          );
          brainMistakesAdded++;
        }
      }
    } catch(brainErr) {
      // Brain writes are best-effort — don't fail the import if they error
      console.error('[IMPORT] brain write failed (non-fatal):', brainErr.message);
    }

    res.json({
      success: true,
      contentId,
      editMode: !!originalArticle,
      brainPatternsAdded,
      brainMistakesAdded,
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

// POST /api/topic-ideas/bulk — push a list of topics in one round-trip.
// Used by the Ads Generator to send Google-flagged "low-volume" keywords
// straight into the Topic Queue as content opportunities (the GEO play:
// keywords with no search volume are uncommoditized territory the brand
// should be creating content for, not bidding ads on).
// Dedupes against the brand's existing ideas by case-insensitive topic match
// to keep repeated pushes idempotent.
app.post('/api/topic-ideas/bulk', requireAuth, async (req, res) => {
  const { brandProfileId, topics, note: defaultNote } = req.body || {};
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  if (!Array.isArray(topics) || !topics.length) return res.status(400).json({ success: false, error: 'topics array required' });

  try {
    const existing = await pool.query(
      `SELECT LOWER(topic) AS t FROM topic_ideas WHERE brand_profile_id = $1`,
      [brandProfileId]
    );
    const seen = new Set(existing.rows.map(r => r.t));
    const toInsert = [];
    for (const item of topics) {
      const topic = String((typeof item === 'string' ? item : item?.topic) || '').trim();
      if (!topic) continue;
      const key = topic.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const note = String((typeof item === 'object' ? item?.note : '') || defaultNote || '').trim() || null;
      toInsert.push({ topic, note });
    }
    if (!toInsert.length) return res.json({ success: true, inserted: 0, skipped: topics.length });

    // Single multi-row INSERT — atomic, one round-trip
    const values = toInsert.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
    const params = [brandProfileId, ...toInsert.flatMap(t => [t.topic, t.note])];
    const r = await pool.query(
      `INSERT INTO topic_ideas (brand_profile_id, topic, note) VALUES ${values} RETURNING id, topic`,
      params
    );
    res.json({ success: true, inserted: r.rows.length, skipped: topics.length - r.rows.length, ideas: r.rows });
  } catch(e) {
    console.error('[TOPIC-IDEAS-BULK]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
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
    if (!latestSession.rows.length) {
      // No discovery sessions yet, but check for strategic injections —
      // they're valid opportunities even without a discovery run.
      const injOnly = await pool.query(
        `SELECT id, topic, platform_scores, avg_score, quick_win, topical_authority_context,
                status, discovered_at, status_changed_at,
                intent_signals->>'source' AS source,
                intent_signals->>'deliverable' AS deliverable,
                intent_signals->>'priority' AS priority
         FROM geo_opportunities
         WHERE brand_profile_id = $1
           AND status NOT IN ('ignored', 'archived')
           AND intent_signals->>'source' LIKE 'strategic_injection%'
         ORDER BY avg_score DESC, quick_win DESC`,
        [brandProfileId]
      );
      return res.json({
        success: true,
        sessionId: null,
        opportunities: injOnly.rows.map(r => ({
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
          topicalAuthority: (() => {
          // Defensive: topical_authority_context may be JSON object, JSON string, or plain text
          // (older inserts and admin/relay inserts have stored plain strings here). Wrap in
          // try/catch so a single bad row never breaks the entire endpoint response.
          const v = r.topical_authority_context;
          if (!v) return null;
          if (typeof v === 'object') return v;
          try { return JSON.parse(v); }
          catch { return { note: String(v) }; }
        })(),
          status: r.status, discoveredAt: r.discovered_at, statusChangedAt: r.status_changed_at,
          source: r.source || null,
          deliverable: r.deliverable || null,
          priority: r.priority || null,
          isInjection: true
        }))
      });
    }

    const sessionId = latestSession.rows[0].discovery_session_id;

    // Auto-expire: mark 'discovered' opportunities older than 24h as 'ignored'
    // EXCEPT founder-injected ones — those are explicit strategic priorities, not
    // discovery noise, so they shouldn't time out at 24h.
    await pool.query(
      `UPDATE geo_opportunities SET status = 'ignored', status_changed_at = NOW()
       WHERE brand_profile_id = $1 AND status = 'discovered'
         AND discovered_at < NOW() - INTERVAL '24 hours'
         AND (intent_signals->>'source' IS NULL
              OR intent_signals->>'source' NOT LIKE 'strategic_injection%')`,
      [brandProfileId]
    );

    // Surface BOTH the latest discovery session's opportunities AND any strategic
    // injections (regardless of which session they belong to). Strategic injections
    // are founder-curated and represent the highest-value opportunities in the
    // database — hiding them behind a session filter defeats their purpose.
    const opps = await pool.query(
      `SELECT id, topic, platform_scores, avg_score, quick_win, topical_authority_context,
              status, discovered_at, status_changed_at,
              intent_signals->>'source' AS source,
              intent_signals->>'deliverable' AS deliverable,
              intent_signals->>'priority' AS priority
       FROM geo_opportunities
       WHERE brand_profile_id = $1
         AND status NOT IN ('ignored', 'archived')
         AND (discovery_session_id = $2
              OR intent_signals->>'source' LIKE 'strategic_injection%')
       ORDER BY
         CASE WHEN intent_signals->>'source' LIKE 'strategic_injection%' THEN 0 ELSE 1 END,
         avg_score DESC,
         quick_win DESC`,
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
        topicalAuthority: (() => {
          // Defensive: topical_authority_context may be JSON object, JSON string, or plain text
          // (older inserts and admin/relay inserts have stored plain strings here). Wrap in
          // try/catch so a single bad row never breaks the entire endpoint response.
          const v = r.topical_authority_context;
          if (!v) return null;
          if (typeof v === 'object') return v;
          try { return JSON.parse(v); }
          catch { return { note: String(v) }; }
        })(),
        status: r.status, discoveredAt: r.discovered_at, statusChangedAt: r.status_changed_at,
        // Founder-injected metadata: lets the UI badge pillar topics, FAQs, and priority levels
        source: r.source || null,
        deliverable: r.deliverable || null,
        priority: r.priority || null,
        isInjection: !!(r.source && r.source.startsWith('strategic_injection'))
      }))
    });
  } catch(e) {
    console.error('[GEO-OPP-LIST]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/factual-ground/authors/:brandProfileId — return the author roster
// Used by GEO Strategist's Build Briefs UI to populate the author selector.
// Returns the structured authors array straight from settings.factualGround.authors.
app.get('/api/factual-ground/authors/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  try {
    const r = await pool.query(`SELECT settings FROM brand_profiles WHERE id = $1`, [brandProfileId]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Brand not found' });
    const fg = (r.rows[0].settings || {}).factualGround || {};
    const authors = Array.isArray(fg.authors) ? fg.authors : [];
    return res.json({ success: true, authors });
  } catch (e) {
    console.error('[FG_AUTHORS] list error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/geo/opportunities/build-briefs — Stage 2.1 Brief Builder
// Body: { opportunityIds: string[], brandProfileId: string, assignedAuthorId?: string }
//
// AUTHORSHIP HANDOFF (Phase 1):
// At this exact transition (GEO Strategist → Auth Enrichment), the operator
// optionally assigns an SME author to the batch of briefs being built. The
// author snapshot is embedded in brief_data.assignedAuthor so all downstream
// stages (Auth Enrichment, Content Generation, Compliance Gate, Publishing)
// can read the SME from one place. We snapshot at brief time rather than just
// referencing the author ID — this protects against author records being
// edited later from changing the historical context briefs were built under.
// If assignedAuthorId is omitted, briefs ship without an author and downstream
// defaults to brand-level factualGround.authors[0] as before (backward compat).
app.post('/api/geo/opportunities/build-briefs', requireAuth, express.json(), async (req, res) => {
  const { opportunityIds, brandProfileId, assignedAuthorId } = req.body;
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

    // ── Author assignment (optional) ─────────────────────────────────────
    // Resolve assignedAuthorId → full author snapshot from factualGround.authors.
    // If the ID isn't found we silently skip — never block brief building over
    // an author lookup miss; downstream agents fall back to brand defaults.
    const allAuthors = Array.isArray(fg.authors) ? fg.authors : [];
    const assignedAuthor = (assignedAuthorId && typeof assignedAuthorId === 'string')
      ? (allAuthors.find(a => a && a.id === assignedAuthorId) || null)
      : null;
    const authorContext = assignedAuthor
      ? `ASSIGNED SME AUTHOR (build the brief from this person's vantage; their expertise should shape the angle):\n` +
        `  Name: ${assignedAuthor.name || ''}\n` +
        `  Title: ${assignedAuthor.title || ''}\n` +
        `  Expertise: ${assignedAuthor.expertise || ''}\n` +
        `  Credentials: ${assignedAuthor.credentials || ''}\n` +
        (assignedAuthor.bio ? `  Background: ${String(assignedAuthor.bio).slice(0, 600)}\n` : '')
      : '';

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
          messages: [{ role: 'user', content: `${dateContext()}

You are the Topic Brief Builder (Stage 2.1) for Forge Intelligence.

BRAND: ${profile.brand_name}
VOICE: ${JSON.stringify(voiceProfile).slice(0, 400)}
PERSONAS: ${JSON.stringify(personas).slice(0, 400)}

${factualContext ? 'FACTUAL GROUND (use verbatim):\n' + factualContext + '\n\n' : ''}${authorContext ? authorContext + '\n\n' : ''}${brainContext}

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

        // Persist the brief — embed the assigned author snapshot in brief_data
        // so downstream stages can read SME context from one place. Snapshot
        // captures the author's state at brief time, not a live reference.
        const briefDataWithAuthor = assignedAuthor
          ? { ...briefData, assignedAuthor: { ...assignedAuthor } }
          : briefData;
        const briefInsert = await pool.query(
          `INSERT INTO geo_topic_briefs (opportunity_id, brand_profile_id, brief_data, brain_version, status)
           VALUES ($1, $2, $3, $4, 'briefed') RETURNING id, created_at`,
          [oppId, brandProfileId, JSON.stringify(briefDataWithAuthor), profile.version || 1]
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
          briefData: briefDataWithAuthor,
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

// POST /api/geo/topic-brief/from-topic — Stage 2.1 entry point for user-typed topics
// Body: { brandProfileId, topic, refinement? }
//
// Lets a user enter the pipeline at brief-creation without first running the
// GEO Strategist. Useful when the user already knows what they want to write
// about (e.g., an exec passes down a topic) — they type it on the Content
// Generator page, hit "Build brief →", and we drop them at the Authenticity
// Enricher with a fresh topic brief ready to enrich.
//
// We materialize a synthetic geo_opportunities row so the schema constraints
// (geo_topic_briefs.opportunity_id NOT NULL → geo_opportunities) keep
// holding. Downstream code that joins topic briefs to opportunities by ID
// continues to work unchanged.
app.post('/api/geo/topic-brief/from-topic', requireAuth, express.json(), async (req, res) => {
  const { brandProfileId, topic, refinement } = req.body || {};
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });
  if (!topic || !topic.trim()) return res.status(400).json({ success: false, error: 'topic required' });

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

    // Same brain + factual context as the standard Build Briefs path
    const patternsRes = await pool.query(
      `SELECT pattern_type, description FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [brandProfileId]
    );
    const brainContext = patternsRes.rows.length
      ? 'BRAIN PATTERNS (respect these):\n' + patternsRes.rows.map(p => `- [${p.pattern_type}] ${p.description}`).join('\n')
      : 'No brain patterns yet.';
    const fg = (profile.settings || {}).factualGround || {};
    const factualContext = [
      fg.whatWeDo && `What we do: ${fg.whatWeDo}`,
      fg.whatWeDontDo && `What we don't do: ${fg.whatWeDontDo}`,
      fg.methodology && `Methodology: ${fg.methodology.slice(0, 400)}`
    ].filter(Boolean).join('\n\n');

    // 1) Materialize a synthetic opportunity row so the FK on geo_topic_briefs
    //    holds. Source is implicit (no quick_win, no platform_scores, no TAC)
    //    — downstream readers treat it as a hand-entered topic.
    const oppInsert = await pool.query(
      `INSERT INTO geo_opportunities (brand_profile_id, brain_version, topic, status, status_changed_at)
       VALUES ($1, $2, $3, 'briefed', NOW()) RETURNING id`,
      [brandProfileId, profile.version || 1, topic.trim()]
    );
    const opportunityId = oppInsert.rows[0].id;

    // 2) Run the brief builder. Prompt mirrors /api/geo/opportunities/build-briefs
    //    so output shape stays identical and downstream parsers don't drift.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const briefRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6144,
      messages: [{ role: 'user', content: `${dateContext()}

You are the Topic Brief Builder (Stage 2.1) for Forge Intelligence.

BRAND: ${profile.brand_name}
VOICE: ${JSON.stringify(voiceProfile).slice(0, 400)}
PERSONAS: ${JSON.stringify(personas).slice(0, 400)}

${factualContext ? 'FACTUAL GROUND (use verbatim):\n' + factualContext + '\n\n' : ''}${brainContext}

TOPIC THE USER ENTERED: "${topic.trim()}"
${refinement && refinement.trim() ? `USER REFINEMENT / ANGLE NOTES: "${refinement.trim()}"\n` : ''}
NOTE: This topic was entered by the user directly (not surfaced by the GEO Strategist).
There are no platform scores or topical-authority context for it yet — build the brief
from the brand voice, personas, factual ground, and brain patterns above. If the topic
is off-strategy for the brand, build it anyway but flag the tension in briefRationale.

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
      briefData = JSON.parse(extractJSON(raw, 'object'));
    } catch (parseErr) {
      console.log('[FROM-TOPIC] parse warn for', topic, ':', parseErr.message);
      briefData = {
        h1: topic.trim(), executiveSummary: 'Brief generation incomplete — retry needed.',
        h2s: [], entities: [], faqStructure: [], geoAnchors: [],
        schemaRequirements: [], targetPlatforms: [], briefRationale: 'parse-error'
      };
    }

    // 3) Persist the brief
    const briefInsert = await pool.query(
      `INSERT INTO geo_topic_briefs (opportunity_id, brand_profile_id, brief_data, brain_version, status)
       VALUES ($1, $2, $3, $4, 'briefed') RETURNING id, created_at`,
      [opportunityId, brandProfileId, JSON.stringify(briefData), profile.version || 1]
    );

    res.json({
      success: true,
      briefId: briefInsert.rows[0].id,
      opportunityId,
      topic: topic.trim(),
      briefData,
      createdAt: briefInsert.rows[0].created_at
    });
  } catch (e) {
    console.error('[FROM-TOPIC] error:', e.message);
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
    console.log(`[CG-BRIEFS] Returning ${r.rows.length} rows for brand ${req.params.brandProfileId}`);
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

    // Ensure the per-brand generated_content table exists before JOINing against it.
    // Fresh brands (scanned but no article ever generated) don't have this table yet —
    // attempting the JOIN throws "relation does not exist" and the whole endpoint returns
    // an empty array, which hides all their enriched briefs from the Content Generator UI.
    // CREATE TABLE IF NOT EXISTS is idempotent and cheap; safer than query-order optimism.
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
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
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
        const faqs = Array.isArray(article.article_json?.faqs) ? article.article_json.faqs : [];

        // ── Probe query construction — stable, article-anchored, natural user phrasing ──
        // Previously: queries were title-derived and reconstructed every run, producing
        // awkward keyword mashups ("Forge Intelligence Bottleneck Production Intelligence MidMarket Teams")
        // and breaking week-over-week comparability since titles change.
        //
        // Now: FAQ questions are the primary probe source — they're the literal questions
        // a user would type into ChatGPT/Perplexity, written at article creation time and
        // stable across probe runs. Plus the title itself and a canonical brand query.
        const faqQueries = faqs
          .map(f => f?.question)
          .filter(q => typeof q === 'string' && q.length > 10 && q.length < 200)
          .slice(0, 3);  // cap at 3 FAQ probes to control per-article API cost

        // Extract 3-5 meaningful topic keywords from title for brand-anchored probe.
        // Why brand-anchored? Young domains need the brand signal in the query for Perplexity
        // to pull their corpus — a bare topical query ("content operations problem") returns
        // generic competitors, not the brand. Previous implementation did this with ugly
        // mashups; this version phrases it naturally using 3-5 content words from the title.
        const titleWords = (title || '').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/)
          .filter(w => w.length > 4 && !['about','using','your','with','that','this','from','have','will','what','when','where','which','their','these','those','would','could','should','content'].includes(w.toLowerCase()))
          .slice(0, 4);
        const brandAnchoredQuery = titleWords.length >= 2
          ? `${brandName} ${titleWords.join(' ')}`.trim()
          : null;

        const probeQuestions = [
          ...faqQueries,                                            // natural user questions from the article's FAQ block
          title,                                                    // exact article title — tests pure topical authority
          brandAnchoredQuery,                                       // brand + topic keywords — tests brand authority on this subject (young domains need this)
          `What is ${brandName}?`,                                  // brand awareness query (stable across all articles)
        ].filter(Boolean).slice(0, 5);  // hard cap per article

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
                const respWords = pText.toLowerCase().split(' ');
                // 1) Section bodies — existing fuzzy match (3+ words >6 chars overlapping)
                for (const s of sections) {
                  const body = (s.body || s.content || '').toLowerCase();
                  if (respWords.filter(w => w.length > 6 && body.includes(w)).length > 3) { citedSection = s.heading; break; }
                }
                // 2) FAQs — articles get cited for FAQ content too; same threshold
                if (!citedSection) {
                  for (const f of faqs) {
                    const body = `${f?.question || ''} ${f?.answer || ''}`.toLowerCase();
                    if (respWords.filter(w => w.length > 6 && body.includes(w)).length > 3) {
                      const q = (f?.question || '').trim();
                      citedSection = q.length > 60 ? `FAQ: ${q.slice(0, 60)}…` : `FAQ: ${q}`;
                      break;
                    }
                  }
                }
                // 3) Fallback — cited but no content match. Distinguish URL citation from text mention.
                if (!citedSection) {
                  citedSection = citations.some(u => u.includes(brandDomain)) ? 'Article URL cited' : 'Brand mention';
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
                const respWords = outputText.toLowerCase().split(' ');
                // 1) Section bodies — existing fuzzy match (3+ words >6 chars overlapping)
                for (const s of sections) {
                  const body = (s.body || s.content || '').toLowerCase();
                  if (respWords.filter(w => w.length > 6 && body.includes(w)).length > 3) { citedSection = s.heading; break; }
                }
                // 2) FAQs — articles get cited for FAQ content too; same threshold
                if (!citedSection) {
                  for (const f of faqs) {
                    const body = `${f?.question || ''} ${f?.answer || ''}`.toLowerCase();
                    if (respWords.filter(w => w.length > 6 && body.includes(w)).length > 3) {
                      const q = (f?.question || '').trim();
                      citedSection = q.length > 60 ? `FAQ: ${q.slice(0, 60)}…` : `FAQ: ${q}`;
                      break;
                    }
                  }
                }
                // 3) Fallback — cited but no content match. Distinguish URL citation from text mention.
                if (!citedSection) {
                  citedSection = urlCitations.some(u => u.includes(brandDomain)) ? 'Article URL cited' : 'Brand mention';
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

// Background re-sync for Zernio "pending" analytics. Zernio's /analytics is
// eventually-consistent and returns 202 for freshly-published posts, which the
// sync handler parks as pending:true placeholders. Without this job they'd only
// resolve when a user manually refreshes the Performance dashboard. Every 30 min
// we re-sync just the brands that still have pending rows — reusing the real
// /api/analytics/sync endpoint via the adminPassword cron bypass so all
// per-channel logic (and the 202 re-poll) is shared. Brands drop out of the set
// as their posts resolve, so this self-limits.
async function runAnalyticsResync() {
  try {
    const brandsRes = await pool.query(
      `SELECT DISTINCT brand_profile_id FROM content_analytics WHERE raw_data->>'pending' = 'true' LIMIT 50`
    );
    if (!brandsRes.rows.length) return;
    console.log(`[AnalyticsResync] ${brandsRes.rows.length} brand(s) with pending analytics — re-syncing`);
    const baseUrl = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
    for (const { brand_profile_id } of brandsRes.rows) {
      try {
        const r = await fetch(`${baseUrl}/api/analytics/sync/${brand_profile_id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'all', adminPassword: process.env.ADMIN_RELAY_PASSWORD })
        });
        const d = await r.json().catch(() => ({}));
        console.log(`[AnalyticsResync] ${brand_profile_id}: HTTP ${r.status}, synced=${d.synced ?? '?'}`);
      } catch (e) {
        console.error(`[AnalyticsResync] ${brand_profile_id} failed:`, e.message);
      }
    }
  } catch (e) {
    console.error('[AnalyticsResync]', e.message);
  }
}

// Start scheduler — runs 30s after boot then every 60s
setTimeout(() => {
  runScheduledPublishes();
  setInterval(runScheduledPublishes, 60 * 1000);
  // Decay monitoring runs every 6 hours
  runDecayMonitoring();
  setInterval(runDecayMonitoring, 6 * 60 * 60 * 1000);
  // Pending-analytics re-sync runs every 30 minutes
  runAnalyticsResync();
  setInterval(runAnalyticsResync, 30 * 60 * 1000);
}, 30 * 1000);

console.log('[SCHEDULER] Scheduled publish runner active — polling every 60s');
console.log('[SCHEDULER] Decay monitoring active — running every 6 hours');
console.log('[SCHEDULER] Pending-analytics re-sync active — running every 30 minutes');

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
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'Forge-Intelligence-Server/1.0' },
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

// Admin-password version for manual fires from CLI/scripts — same logic, no Clerk JWT required.
app.post('/api/admin/digest/send/:brandProfileId', async (req, res) => {
  const { adminPassword } = req.body || {};
  if (adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
  if (adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
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
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
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
  if (req.query?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT * FROM outreach_contacts ORDER BY created_at DESC');
    res.json({ success: true, contacts: r.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/outreach/send — cron-triggered send to all pending contacts
app.post('/api/outreach/send', async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
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
          headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'Forge-Intelligence-Server/1.0' },
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

// ── Lovable Integration ──────────────────────────────────────────────────────
// POST /api/forge/prompt-pack/lovable
// Turns a Brand Intelligence Profile into a deterministic, URL-encoded prompt
// for Lovable's public Build-with-URL flow. No LLM calls — pure templating.
// Spec: docs/LOVABLE_INTEGRATION.md (FI-LOVABLE-001).

const LOVABLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOVABLE_URL_SAFE_LIMIT = 12000;
const LOVABLE_MAX_PROMPT_CHARS = 50000;
const LOVABLE_SUPPORTED_APP_TYPES = new Set([
  'content-command-center',
  'geo-monitor',
  'campaign-planner',
  'brand-voice-studio',
]);

function lovableTruncate(value, maxLength) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 16)).trim() + '... [truncated]';
}

function lovableSafeJoin(arr, maxLength) {
  if (!Array.isArray(arr)) return '';
  return lovableTruncate(arr.map(v => (v == null ? '' : String(v))).filter(Boolean).join(', '), maxLength);
}

function lovableHasData(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function lovableFormatVoice(voice, compact) {
  if (!lovableHasData(voice)) return null;
  const tones = Array.isArray(voice.toneAttributes) ? voice.toneAttributes : [];
  const scoreFor = (label) => {
    const hit = tones.find(t => String(t.attribute || '').toLowerCase() === label);
    return hit && typeof hit.score === 'number' ? hit.score : null;
  };
  const formality = scoreFor('formality');
  const confidence = scoreFor('confidence');
  const complexity = scoreFor('complexity');
  const phrases = Array.isArray(voice.keyPhrases) ? voice.keyPhrases : [];
  const summary = typeof voice.summary === 'string' ? voice.summary : '';
  const style = typeof voice.writingStyle === 'string' ? voice.writingStyle : '';
  const phraseCap = compact ? 240 : 1200;
  const summaryCap = compact ? 600 : 4000;
  const styleCap = compact ? 400 : 2000;
  return {
    formality: formality != null ? `${formality}/10` : 'not measured',
    confidence: confidence != null ? `${confidence}/10` : 'not measured',
    complexity: complexity != null ? `${complexity}/10` : 'not measured',
    brandVocab: phrases.length ? lovableSafeJoin(phrases, phraseCap) : 'none recorded',
    antiPatterns: 'generic corporate copy, hype language, AI-generated cliches',
    toneSummary: summary ? lovableTruncate(summary, summaryCap) : (style ? lovableTruncate(style, styleCap) : 'voice profile present but no summary recorded'),
  };
}

function lovableFormatPersonas(personas, compact) {
  if (!Array.isArray(personas) || personas.length === 0) return null;
  const max = compact ? 3 : personas.length;
  const perPersonaCap = compact ? 500 : 2000;
  const blocks = personas.slice(0, max).map((p, i) => {
    const name = p.name || p.role || `Persona ${i + 1}`;
    const role = p.role || '';
    const pains = lovableSafeJoin(p.painPoints || [], 240);
    const triggers = lovableSafeJoin(p.triggers || [], 240);
    const skepticism = lovableTruncate(p.skepticism || '', 200);
    const block = [
      `- ${name}${role && role !== name ? ` (${role})` : ''}`,
      pains ? `  Pain points: ${pains}` : '',
      triggers ? `  Triggers: ${triggers}` : '',
      skepticism ? `  Skepticism: ${skepticism}` : '',
    ].filter(Boolean).join('\n');
    return lovableTruncate(block, perPersonaCap);
  });
  return blocks.join('\n');
}

function lovableFormatWhitespace(gaps, compact) {
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  const cap = compact ? 1500 : 6000;
  const lines = gaps.slice(0, compact ? 6 : gaps.length).map(g => {
    const topic = g.topic || 'Untitled gap';
    const opp = g.whitespaceOpportunity || g.opportunity || '';
    const owned = g.ownedBy ? ` (currently owned by ${g.ownedBy})` : ' (unclaimed)';
    return `- ${topic}${owned}${opp ? ` — ${opp}` : ''}`;
  });
  return lovableTruncate(lines.join('\n'), cap);
}

function lovableFormatThirdParty(signals, compact) {
  if (!Array.isArray(signals) || signals.length === 0) return null;
  const cap = compact ? 1200 : 5000;
  const lines = signals.slice(0, compact ? 8 : signals.length).map(s => {
    const src = s.source || 'unknown source';
    const type = s.signalType || s.type || 'signal';
    const val = s.value != null ? String(s.value) : '';
    return `- [${src}] ${type}${val ? `: ${val}` : ''}`;
  });
  return lovableTruncate(lines.join('\n'), cap);
}

function lovableFormatGeo(geoBrief, compact) {
  if (!lovableHasData(geoBrief)) return null;
  const opps = Array.isArray(geoBrief.geoOpportunitiesNorm)
    ? geoBrief.geoOpportunitiesNorm
    : (Array.isArray(geoBrief.geoOpportunities) ? geoBrief.geoOpportunities : []);
  if (!opps.length) return null;
  const cap = compact ? 1200 : 5000;
  const lines = opps.slice(0, compact ? 6 : opps.length).map(o => {
    const topic = o.topic || o.query || 'Untitled opportunity';
    const cp = typeof o.citationProbability === 'number' ? ` (citation probability ${Math.round(o.citationProbability * 100)}%)` : '';
    return `- ${topic}${cp}`;
  });
  return lovableTruncate(lines.join('\n'), cap);
}

function lovableSection(label, content, fallback) {
  if (content && String(content).trim().length > 0) return content;
  return fallback || `No ${label.toLowerCase()} data available yet. Design this section to be populated later.`;
}

function lovableBuildContentCommandCenter(ctx) {
  const {
    brandName, appTypeDescription, voice, personas, whitespace, thirdParty, geo,
    unclaimed, brandColors, customNotes, brandProfileId,
  } = ctx;
  const voiceBlock = voice
    ? `- Formality: ${voice.formality}\n- Confidence: ${voice.confidence}\n- Complexity: ${voice.complexity}\n- Brand vocabulary: ${voice.brandVocab}\n- Anti-patterns to avoid: ${voice.antiPatterns}\n- Tone summary: ${voice.toneSummary}`
    : lovableSection('voice profile', null);

  const personasBlock = lovableSection('personas', personas);
  const whitespaceBlock = lovableSection('competitive whitespace', whitespace);
  const thirdPartyBlock = lovableSection('third-party voice', thirdParty);
  const geoBlock = lovableSection('GEO opportunities', geo);

  const notesBlock = customNotes && String(customNotes).trim().length > 0
    ? `\n## ADDITIONAL OPERATOR NOTES\n${lovableTruncate(customNotes, 1500)}\n`
    : '';

  return `You are building a production Brand Intelligence Command Center for ${brandName}.

## APP CONCEPT
A ${appTypeDescription} that helps ${brandName}'s marketing team turn brand intelligence into shipped content. The app must feel like a strategic GTM operating system, not a generic AI content generator.

## BRAND VOICE (apply to ALL UI copy and generated content)
${voiceBlock}

## TARGET PERSONAS
${personasBlock}
(Each persona: role, pain points, trigger events, skepticism objections)

## COMPETITIVE WHITESPACE
${whitespaceBlock}
Unclaimed positioning territory: ${unclaimed || 'derive from whitespace block above'}

## THIRD-PARTY VOICE THEMES
Top customer language patterns from reviews, complaints, testimonials:
${thirdPartyBlock}

## AI SEARCH / GEO OPPORTUNITIES
Top citation opportunities to optimize for:
${geoBlock}

## REQUIRED SCREENS
1. Dashboard — brand health, content velocity, AI citation score
2. Brand Brain — voice profile, personas, whitespace (read-only)
3. Content Generator — articles/social/email with confidence scores
4. Campaign Planner — 8-article campaign with rotating angles
5. AI Citation Monitor — track GEO opportunities and citation status
6. Approval Queue — review with E-E-A-T flags before publish

## DATA MODEL (use Supabase — Lovable native)
- brand_context (singleton, holds profile passed in this prompt)
- generated_content (id, type, body, confidence_scores, status, created_at)
- campaigns (id, topic_cluster, article_count, status)
- citation_opportunities (id, prompt, current_status, target_status)

## CORE WORKFLOW
1. User opens dashboard.
2. User reviews the Brand Brain.
3. User selects a topic cluster or content opportunity.
4. App generates a campaign plan.
5. User reviews generated content with confidence scores, source needs, and E-E-A-T flags.
6. User approves or edits outputs.
7. Approved content moves into publishing queue.

## INTEGRATIONS
- Supabase for persistence (Lovable native)
- Resend for content preview emails
- Stripe (optional, for app monetization)

## VISUAL DIRECTION
- Match brand colors: ${brandColors}
- Typography: clean sans-serif, generous spacing
- UI copy tone: matches brand voice profile above
- Avoid generic AI-app aesthetics (no purple gradients, no robot icons)

## SUCCESS CRITERIA
A marketer at ${brandName} should say "this knows our brand better than our agency does" within 2 minutes of opening the app.
${notesBlock}
## TECHNICAL NOTES
Forge Intelligence API base: https://api.forgeintelligence.ai/v1
Brand Profile ID: ${brandProfileId}
(Optional: prompt user for FORGE_API_KEY env var to enable live content generation. If not provided, scaffold with static brand data from this prompt.)`;
}

// Directive-led prompt — used when the brand profile carries a buildIntent
// (Quick Start brains). Lovable reads what to build FIRST, then the brand
// intelligence acts as design + voice guardrails for that specific build —
// rather than the legacy structure where we prescribed a Content Command
// Center concept and force-fit every brand into it.
function lovableProductTypeLabel(productType) {
  switch (productType) {
    case 'marketing-site': return 'a marketing site';
    case 'saas-app': return 'a SaaS app';
    case 'landing-page': return 'a landing page';
    case 'waitlist': return 'a waitlist';
    case 'internal-tool': return 'an internal tool';
    default: return 'a product';
  }
}

function lovableBuildWithDirective(ctx, buildIntent) {
  const {
    brandName, voice, personas, whitespace, thirdParty,
    brandColors, customNotes, brandProfileId, factualGround,
  } = ctx;

  const directiveDescription = lovableTruncate(buildIntent.description || '', 4000);
  const productType = buildIntent.productType && buildIntent.productType !== 'not-sure'
    ? buildIntent.productType
    : null;
  const productLabel = lovableProductTypeLabel(productType);

  const voiceBlock = voice
    ? `- Formality: ${voice.formality}\n- Confidence: ${voice.confidence}\n- Complexity: ${voice.complexity}\n- Brand vocabulary: ${voice.brandVocab}\n- Anti-patterns to avoid: ${voice.antiPatterns}\n- Tone summary: ${voice.toneSummary}`
    : lovableSection('voice profile', null);

  const personasBlock = lovableSection('personas', personas);
  const whitespaceBlock = lovableSection('competitive whitespace', whitespace);
  const thirdPartyBlock = lovableSection('third-party voice', thirdParty);

  // Founder-Brief fields (only present on Quick Start brains) — pass through
  // verbatim so Lovable can echo the founder's own words rather than the
  // Stage-1 synthesized paraphrase. The factualGround block lives inside the
  // brand profile JSONB; missing on URL-based brains, gracefully skipped.
  const fg = factualGround || {};
  const fgWhatWeDo = typeof fg.whatWeDo === 'string' && fg.whatWeDo.trim() ? lovableTruncate(fg.whatWeDo, 1500) : '';
  const fgWhatWeDoNot = typeof fg.whatWeDoNot === 'string' && fg.whatWeDoNot.trim() ? lovableTruncate(fg.whatWeDoNot, 1500) : '';
  const fgCompetitors = typeof fg.competitors === 'string' && fg.competitors.trim() ? lovableTruncate(fg.competitors, 1000) : '';
  const fgFoundingStory = typeof fg.foundingStory === 'string' && fg.foundingStory.trim() ? lovableTruncate(fg.foundingStory, 1500) : '';
  const fgQuotablePositions = typeof fg.quotablePositions === 'string' && fg.quotablePositions.trim() ? lovableTruncate(fg.quotablePositions, 1200) : '';
  const fgNamedAuthors = typeof fg.namedAuthors === 'string' && fg.namedAuthors.trim() ? lovableTruncate(fg.namedAuthors, 600) : '';

  const notesBlock = customNotes && String(customNotes).trim().length > 0
    ? `\n## ADDITIONAL OPERATOR NOTES\n${lovableTruncate(customNotes, 1500)}\n`
    : '';

  // Build the brand-intelligence section line by line so we only emit fields
  // that actually have content (URL-based brains skip the founder-brief lines,
  // Quick Start brains keep them).
  const biLines = [`Brand: ${brandName}`];
  if (fgWhatWeDo) biLines.push(`What this product does: ${fgWhatWeDo}`);
  if (fgWhatWeDoNot) biLines.push(`What it does NOT do (strategic moats — do not contradict): ${fgWhatWeDoNot}`);
  biLines.push(`Voice profile:\n${voiceBlock}`);
  biLines.push(`Target personas:\n${personasBlock}`);
  if (whitespaceBlock && whitespaceBlock !== 'No data available') biLines.push(`Competitive whitespace:\n${whitespaceBlock}`);
  if (fgCompetitors) biLines.push(`Competitors: ${fgCompetitors}`);
  if (fgFoundingStory) biLines.push(`Founding story: ${fgFoundingStory}`);
  if (fgQuotablePositions) biLines.push(`Brand positions: ${fgQuotablePositions}`);
  if (fgNamedAuthors) biLines.push(`Attributed authors: ${fgNamedAuthors}`);
  if (thirdPartyBlock && thirdPartyBlock !== 'No data available') biLines.push(`Third-party voice themes:\n${thirdPartyBlock}`);
  const brandIntelligence = biLines.join('\n\n');

  return `You are building ${productLabel} for ${brandName}.

## BUILD DIRECTIVE
${directiveDescription}${productType ? `\nProduct type: ${productType}` : ''}

## BRAND INTELLIGENCE — provided by Forge Intelligence
The brand intelligence below is DESIGN + VOICE guardrails for the build directive above. It tells you HOW the brand behaves, not WHAT to build. Apply the voice to all UI copy. Honor the personas in the navigation, onboarding, and core flows. Respect what the brand explicitly does NOT do — those are strategic moats and must not appear as product features.

${brandIntelligence}

## VISUAL DIRECTION
- Match brand colors: ${brandColors}
- Typography: clean sans-serif, generous spacing
- UI copy tone: matches brand voice profile above
- Avoid generic AI-app aesthetics (no purple gradients, no robot icons)
${notesBlock}
## TECHNICAL NOTES
Forge Intelligence Brand Profile ID: ${brandProfileId}
Forge Intelligence API base: https://api.forgeintelligence.ai/v1
(Optional: prompt user for FORGE_API_KEY env var if the build needs live brand-aware content generation. Otherwise scaffold with the static brand data from this prompt.)`;
}

function lovableStubPrompt(appType, brandName, brandProfileId) {
  return `[Lovable prompt template TODO]
appType "${appType}" is recognized but not yet shipped in v1. Only "content-command-center" is fully built. Tracked as a post-ship follow-up in docs/LOVABLE_INTEGRATION.md §11.

Brand: ${brandName}
Brand Profile ID: ${brandProfileId}`;
}

function lovableRecommendedAppName(appType, brandName) {
  const friendly = brandName && brandName !== 'this brand' ? brandName : 'Your Brand';
  switch (appType) {
    case 'content-command-center': return `${friendly} Content Intelligence Command Center`;
    case 'geo-monitor':              return `${friendly} GEO Citation Monitor`;
    case 'campaign-planner':         return `${friendly} Campaign Planner`;
    case 'brand-voice-studio':       return `${friendly} Brand Voice Studio`;
    default:                          return `${friendly} Lovable App`;
  }
}

function lovableAppTypeDescription(appType) {
  switch (appType) {
    case 'content-command-center': return 'Brand Intelligence Command Center';
    case 'geo-monitor':            return 'GEO Citation Monitor';
    case 'campaign-planner':       return 'Campaign Planner';
    case 'brand-voice-studio':     return 'Brand Voice Studio';
    default:                        return 'brand-aware marketing application';
  }
}

app.post('/api/forge/prompt-pack/lovable', requireAuth, async (req, res) => {
  const { brandProfileId, appType: rawAppType, compact: rawCompact, customNotes } = req.body || {};

  if (!brandProfileId || typeof brandProfileId !== 'string') {
    return res.status(400).json({ success: false, error: 'Invalid request', details: 'brandProfileId is required' });
  }
  if (!LOVABLE_UUID_RE.test(brandProfileId)) {
    return res.status(400).json({ success: false, error: 'Invalid request', details: 'brandProfileId must be a valid UUID' });
  }

  const appType = (typeof rawAppType === 'string' && rawAppType.trim()) ? rawAppType.trim() : 'content-command-center';
  if (!LOVABLE_SUPPORTED_APP_TYPES.has(appType)) {
    return res.status(400).json({ success: false, error: 'Invalid request', details: `appType "${appType}" is not supported` });
  }
  const compact = rawCompact === false ? false : true;

  try {
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) {
      return res.status(403).json({ success: false, error: 'Access denied', details: 'You do not have access to this brand profile' });
    }

    const profileRes = await pool.query(
      'SELECT id, brand_name, brand_url, logo_url, profile_data, settings FROM brand_profiles WHERE id = $1',
      [brandProfileId]
    );
    if (!profileRes.rows.length) {
      return res.status(404).json({ success: false, error: 'Brand profile not found', details: `No brand profile with id ${brandProfileId}` });
    }
    const row = profileRes.rows[0];
    const pd = row.profile_data || {};
    const settings = row.settings || {};
    const business = pd.businessProfile || {};

    const brandName = row.brand_name || business.companyName || pd.brandName || 'this brand';
    const voice = lovableFormatVoice(pd.voiceProfile || {}, compact);
    const personas = lovableFormatPersonas(pd.personas || [], compact);
    const whitespace = lovableFormatWhitespace(pd.competitiveGaps || pd.competitiveWhitespace || [], compact);
    const thirdParty = lovableFormatThirdParty(pd.thirdPartySignals || [], compact);

    // Best-effort supplementary briefs — never block the response on them
    let geoBriefData = null;
    let enrichedBriefData = null;
    try {
      const geoRes = await pool.query(
        'SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1',
        [brandProfileId]
      );
      if (geoRes.rows.length) geoBriefData = geoRes.rows[0].brief_data || null;
    } catch (e) { /* table may not exist or query may fail — non-blocking */ }
    try {
      const enrRes = await pool.query(
        'SELECT enriched_data FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [brandProfileId]
      );
      if (enrRes.rows.length) enrichedBriefData = enrRes.rows[0].enriched_data || null;
    } catch (e) { /* non-blocking */ }

    const geoFormatted = lovableFormatGeo(geoBriefData || {}, compact);

    const brandColors = (settings.brandColors && Array.isArray(settings.brandColors))
      ? lovableSafeJoin(settings.brandColors, 200)
      : 'derive from the brand voice profile; lean clean, professional, signal-forward';

    const recommendedAppName = lovableRecommendedAppName(appType, brandName);
    const appTypeDescription = lovableAppTypeDescription(appType);

    let prompt;
    // Directive-led path: brand profile carries an explicit BUILD DIRECTIVE
    // (Quick Start brains). Tells Lovable what to build before processing
    // how the brand behaves. Falls through to legacy content-command-center
    // path for URL-based brains that pre-date the directive flow.
    if (pd.buildIntent && typeof pd.buildIntent.description === 'string' && pd.buildIntent.description.trim().length > 0) {
      prompt = lovableBuildWithDirective({
        brandName,
        voice,
        personas,
        whitespace,
        thirdParty,
        brandColors,
        customNotes: typeof customNotes === 'string' ? customNotes : '',
        brandProfileId,
        factualGround: pd.factualGround || null,
      }, pd.buildIntent);
    } else if (appType === 'content-command-center') {
      prompt = lovableBuildContentCommandCenter({
        brandName,
        appTypeDescription,
        voice,
        personas,
        whitespace,
        thirdParty,
        geo: geoFormatted,
        unclaimed: pd.unclaimedTerritory || '',
        brandColors,
        customNotes: typeof customNotes === 'string' ? customNotes : '',
        brandProfileId,
      });
    } else {
      prompt = lovableStubPrompt(appType, brandName, brandProfileId);
    }

    // Hard guard against accidental Lovable-side rejection. The packer should
    // already be well under this even with compact:false on a rich profile.
    if (prompt.length > LOVABLE_MAX_PROMPT_CHARS) {
      prompt = prompt.slice(0, LOVABLE_MAX_PROMPT_CHARS - 32).trim() + '\n\n[truncated to Lovable 50K cap]';
    }

    const encodedPrompt = encodeURIComponent(prompt);
    const buildUrl = `https://lovable.dev/?autosubmit=true#prompt=${encodedPrompt}`;
    const isUrlSafe = buildUrl.length <= LOVABLE_URL_SAFE_LIMIT;

    const brainConsumption = {
      voiceProfile: lovableHasData(pd.voiceProfile),
      personas: Array.isArray(pd.personas) && pd.personas.length > 0,
      competitiveWhitespace: Array.isArray(pd.competitiveGaps) && pd.competitiveGaps.length > 0,
      geoBrief: lovableHasData(geoBriefData),
      thirdPartyVoice: Array.isArray(pd.thirdPartySignals) && pd.thirdPartySignals.length > 0,
      enrichedBrief: lovableHasData(enrichedBriefData),
    };

    return res.json({
      success: true,
      data: {
        platform: 'lovable',
        brandProfileId,
        appType,
        recommendedAppName,
        prompt,
        promptLength: prompt.length,
        encodedPrompt,
        encodedLength: encodedPrompt.length,
        buildUrl,
        isUrlSafe,
        fallbackRequired: !isUrlSafe,
        brainConsumption,
      },
    });
  } catch (err) {
    console.error('[LOVABLE-PACK]', err.message);
    return res.status(500).json({ success: false, error: 'Internal error', details: err.message });
  }
});

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});


