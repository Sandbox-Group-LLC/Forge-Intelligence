import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from 'crypto';
import { jwtVerify } from 'jose';
import { pool } from './src/server/db.js';
import { extractJSON, safeParseLLM } from './src/server/llm-json.js';
import { resolveUtmParams, buildUtmString } from './src/server/utm.js';
import { truncateStr, truncateAtSentence, stripSocialMarkdown, quickStartTruncate, stripScaffoldingArtifacts, stripEmDashes } from './src/server/text.js';
import { clerkJWKS, SUPER_ADMIN_IDS, verifyBrandAccess, requireAuth, requireApiKeyScope, softAuth, mcpAuth, hashApiKey, lookupApiKey } from './src/server/auth.js';
import { callZernio, zernioPublish, getOrCreateZernioProfile, zernioGuard } from './src/server/zernio.js';
import { forgeScrape, getBrandPageContent, discoverSubpages, _forgeScrapeRateLimited, FORGE_SCRAPE_RATE_PER_MIN } from './src/server/scrape.js';
import { anthropic, dateContext } from './src/server/llm.js';
import { CITATION_ENGINES, isCited, findCitedSection, urlHasDomain, coldScan, extractDomain } from './src/server/geoProbe.js';
import { installLogCapture, logBuffer, logSSEClients, errorAggregates } from './src/server/logging.js';
import { recordAudit } from './src/server/audit.js';
import {
  LOVABLE_UUID_RE, LOVABLE_URL_SAFE_LIMIT, LOVABLE_MAX_PROMPT_CHARS, LOVABLE_SUPPORTED_APP_TYPES,
  lovableSafeJoin, lovableHasData, lovableFormatVoice, lovableFormatPersonas, lovableFormatWhitespace,
  lovableFormatThirdParty, lovableFormatGeo, lovableBuildContentCommandCenter, lovableBuildWithDirective,
  lovableStubPrompt, lovableRecommendedAppName, lovableAppTypeDescription,
} from './src/server/lovable.js';
import { buildXOAuthHeader, uploadXMedia, refreshXOAuth2Token } from './src/server/x.js';
import { generateHeroImage, buildImagePrompt, buildSocialImagePrompt, generateSocialImage } from './src/server/images.js';
import { MARKETING_META, renderMarketingPage } from './src/server/marketing.js';
import { findCitationSources } from './src/server/citations.js';
import { normalizeGeoData } from './src/server/geo.js';
import { buildGhostJWT } from './src/server/ghost.js';
import { PROMO_CODES } from './src/server/promo.js';
import complianceRouter from './src/server/routes/compliance.js';
import emailCampaignRouter from './src/server/routes/email-campaign.js';
import socialGeneratorRouter from './src/server/routes/social-generator.js';
import { ensureGeneratedContentTable } from './src/server/content-table.js';
import campaignRouter from './src/server/routes/campaign.js';
import topicIdeasRouter from './src/server/routes/topic-ideas.js';
import precogRouter from './src/server/routes/precog.js';
import geoStrategistRouter from './src/server/routes/geo-strategist.js';
import analyticsRouter from './src/server/routes/analytics.js';
import contextHubRouter from './src/server/routes/context-hub.js';
import contentRouter from './src/server/routes/content.js';
import publishingQueueRouter from './src/server/routes/publishing-queue.js';
import publishingChannelsRouter from './src/server/routes/publishing-channels.js';
import publishingPublishRouter from './src/server/routes/publishing-publish.js';
import { runScheduledPublishes } from './src/server/routes/publishing-publish.js';
import { pipedreamProxy } from './src/server/pipedream.js';
import zernioRouter from './src/server/routes/zernio.js';
import zernioAdminRouter from './src/server/routes/zernio-admin.js';
import videoRouter from './src/server/routes/video.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── Live Log Ring Buffer ──────────────────────────────────────────────────────
// Ring buffer, error aggregation, and console capture now live in
// src/server/logging.js. installLogCapture() patches console.{log,error,warn}
// before anything that should be captured; the log-admin routes below read
// logBuffer / logSSEClients / errorAggregates directly.
installLogCapture();


// ── X OAuth 1.0a helper (verified working) ───────────────────────────────────
// buildXOAuthHeader / uploadXMedia / refreshXOAuth2Token moved to
// src/server/x.js (imported at top).



const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;


// anthropic client + dateContext now live in src/server/llm.js (imported above).
// The bare `Anthropic` class import is kept for the few handlers that spin up a
// short-timeout client of their own.

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

// Video Generator — user-uploaded product screenshots. Registered BEFORE the
// global express.json() so its larger body limit applies (base64 images are a
// few MB; the global parser is 100kb). Auth + brand-scoped; uploads land in S3
// under forge-uploads/<brand>/ and the client gets back a durable key it passes
// to /api/video/generate. See src/server/video.js (uploadUserShot).
app.post('/api/video/upload-shot', express.json({ limit: '12mb' }), requireAuth, async (req, res) => {
  try {
    const { brandProfileId, imageBase64, contentType } = req.body || {};
    if (!brandProfileId || typeof imageBase64 !== 'string') return res.status(400).json({ error: 'brandProfileId and imageBase64 are required' });
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const ct = String(contentType || 'image/png');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(ct)) return res.status(400).json({ error: 'unsupported image type (png/jpeg/webp)' });
    const buf = Buffer.from(imageBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty image' });
    if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'image too large (max 8MB)' });
    const { uploadUserShot } = await import('./src/server/video.js');
    const { key, url } = await uploadUserShot(buf, brandProfileId, ct);
    res.json({ key, url });
  } catch (e) {
    console.error('[VIDEO] upload-shot error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.json());

// ── Hero image generation — Ideogram v2 via fal.ai ───────────────────────────
// Swapped from Flux Schnell (4-step distilled, plastic skin, "Kim K" vibe on humans)
// to Ideogram v2 (realistic style, built-in MagicPrompt expansion, reliable faces/hands).
// Cost: ~$0.08/image vs $0.003 prior. Quality difference is enormous for B2B marketing imagery.
// Image helpers (generateHeroImage / buildImagePrompt / buildSocialImagePrompt
// / generateSocialImage + HERO_IMAGE_NEGATIVE_PROMPT) moved to
// src/server/images.js (imported at top).


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
app.use('/api/publishing', publishingQueueRouter); // queue CRUD/lifecycle -> src/server/routes/publishing-queue.js

// ── Republish to a specific channel ──────────────────────────────────────────
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// ── Get publish log for a queue item ─────────────────────────────────────────
// (publishing-queue route moved to src/server/routes/publishing-queue.js)


// ── On-demand hero image regeneration ────────────────────────────────────────
app.use('/api/content', contentRouter); // 6 routes (mixed auth, per-route) -> src/server/routes/content.js


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
// Marketing/SEO SSR (FAQ content, JSON-LD, MARKETING_META, renderMarketingPage)
// moved to src/server/marketing.js (imported at top).

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
// (content route moved to src/server/routes/content.js)

// (content route moved to src/server/routes/content.js)

// ── Context Agent API ─────────────────────────────────────────────────────────

app.use('/api/context-hub', contextHubRouter); // 5 routes (mixed auth, per-route) -> src/server/routes/context-hub.js

// (context-hub route/helper moved to src/server/routes/context-hub.js)

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
// (content route moved to src/server/routes/content.js)


// PATCH /api/content/:brandSafeId/:contentId — inline article edit from preview modal
// (content route moved to src/server/routes/content.js)

// PATCH /api/publishing/queue/:id/title — inline title edit
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// POST /api/publishing/queue/:id/archive
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// POST /api/publishing/queue/:id/unarchive
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// POST /api/campaign/:id/archive — bulk archive an entire campaign
// Refuses unless every queue item in the campaign is status='published'.
app.use('/api/campaign', campaignRouter); // 9 routes (mixed auth, per-route) -> src/server/routes/campaign.js

// POST /api/campaign/:id/unarchive — restore an archived campaign
// Items go back to status='published' (since archive only allowed when all were published).
// (campaign route/helper moved to src/server/routes/campaign.js)

// GET /api/analytics/patterns/:brandProfileId
app.use('/api/analytics', analyticsRouter); // 11 routes (mixed auth, per-route) -> src/server/routes/analytics.js


// ── Brain Distill — convert human edits into writing rules ───────────────────
app.post('/api/brain/distill/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'], clockTolerance: '30s' });
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
// (analytics route/helper moved to src/server/routes/analytics.js)

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

app.use('/api/precog', requireAuth, precogRouter); // 5 routes -> src/server/routes/precog.js

// GET /api/precog/score/:brandProfileId/:contentId — Get cached score
// (precog route moved to src/server/routes/precog.js)

// POST /api/precog/batch — Score all unscored content for a brand
// (precog route moved to src/server/routes/precog.js)

// (precog route moved to src/server/routes/precog.js)

// (precog route moved to src/server/routes/precog.js)

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

// (context-hub route/helper moved to src/server/routes/context-hub.js)

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
// quickStartTruncate moved to src/server/text.js (imported at top).

// (context-hub route/helper moved to src/server/routes/context-hub.js)

// (context-hub route/helper moved to src/server/routes/context-hub.js)



// GET /api/context-hub/brand/:brandId — fetch brand profile by ID (unauthenticated, for URL-based recovery)
// (context-hub route/helper moved to src/server/routes/context-hub.js)


// ── Email Campaign Tables ──────────────────────────────────────────────────
// Created in initDB — see payment_events block above

// ── Stage 4.6 — Email Campaign Generator ──────────────────────────────────

// POST /api/email-campaign/create — save brief + create campaign record
app.use('/api/email-campaign', requireAuth, emailCampaignRouter); // 9 routes -> src/server/routes/email-campaign.js

// ── GEO data normalizer — shared by fresh + cached responses ─────────────────
// normalizeGeoData moved to src/server/geo.js (imported at top).

// ── GEO Strategist API (Stage 2) ──────────────────────────────────────────────

// Extracts the first complete JSON object or array from a string — handles trailing text/markdown
// stripScaffoldingArtifacts moved to src/server/text.js (imported at top).

// ── Date-grounding for LLM prompts ─────────────────────────────────────
// Every prompt that generates user-facing content MUST prepend this block.
// Without it the model defaults to its training-data prior (heavily 2024-2025)
// and will write 'in 2025' / '2024 trends' even when it's actually 2026.
// Returns a multi-line string to splice into prompts: "TODAY IS Saturday, April 25, 2026..."
// dateContext moved to src/server/llm.js

app.use('/api/geo-strategist', geoStrategistRouter); // 3 routes (mixed auth, per-route) -> src/server/routes/geo-strategist.js

// (geo-strategist route moved to src/server/routes/geo-strategist.js)

// (geo-strategist route moved to src/server/routes/geo-strategist.js)



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

    // ── Measured + brain context blocks ──────────────────────────────────────
    // The enricher historically loaded the brain tables and the full geo brief
    // and then used almost none of it: brain patterns/mistakes reached zero
    // prompts, and citationProbe / topical gaps / competitorAnalysis /
    // strategicMoats were invisible to every tool. Build the blocks once here;
    // Tools 2-4 inject them below. citationProbe + the raw topical gaps live on
    // the brand-level geo_briefs row (the per-topic brief doesn't carry them),
    // so load that row regardless of which brief path ran above. All
    // best-effort — absent data renders as an empty block.
    let geoMeasured = null;
    try {
      const gmRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`,
        [brandProfileId]
      );
      geoMeasured = gmRes.rows[0]?.brief_data || null;
    } catch(e) { /* enrichment proceeds without measured context */ }
    const citationProbe = geoMeasured?.citationProbe || null;
    const rawTopicalGaps = Array.isArray(geoMeasured?.topicalMap?.gapsByCluster) ? geoMeasured.topicalMap.gapsByCluster : [];
    const briefTopicLc = String(geoBrief?.topic || geoBrief?.h1 || '').toLowerCase();
    const matchedGap = briefTopicLc ? rawTopicalGaps.find(g => {
      const t = String(g.topic || '').toLowerCase();
      return t && (briefTopicLc.includes(t) || t.includes(briefTopicLc));
    }) : null;

    const probeBlock = citationProbe ? `
MEASURED AI VISIBILITY (live engine probe — ground truth): the brand appeared in ${citationProbe.visibility}% of ${citationProbe.totalChecks} AI answers (${Object.entries(citationProbe.byEngine || {}).map(([id, v]) => `${id} ${v.available ? v.pct + '%' : 'n/a'}`).join(' · ')}). WHO AI CITES INSTEAD: ${(citationProbe.sources || []).slice(0, 8).map(s => s.domain).join(', ') || 'none captured'}. E-E-A-T injections must give this brand the citable authority those incumbent sources currently hold.` : '';
    const topicAngleBlock = matchedGap ? `
TOPIC ANGLE (from the topical authority map): pillar cluster "${matchedGap.cluster || 'n/a'}" — information-gain angle: ${String(matchedGap.informationGainAngle || matchedGap.rationale || '').slice(0, 300)}. Every injection should reinforce THIS unique angle, not generic authority.` : '';

    const competitorAnalysisArr = Array.isArray(pd.competitorAnalysis) ? pd.competitorAnalysis : [];
    const strategicMoatsArr = Array.isArray(pd.strategicMoats) ? pd.strategicMoats : [];
    const competitorBlock = competitorAnalysisArr.length ? `
COMPETITOR SITE COVERAGE (measured — crawled from their actual websites): ${competitorAnalysisArr.map(c => `${c.url}: ${c.positioning || ''}${(c.signatureClaims || []).length ? ` — claims: ${c.signatureClaims.join(' | ')}` : ''}`).join('\n')}
Score authoritativeness and trust RELATIVE to these measured competitor claims; a gap should name the evidence that would beat them.` : '';
    const moatsBlock = strategicMoatsArr.length ? `
STRATEGIC MOATS (deliberate non-actions — treat as trust signals to amplify, never as gaps): ${strategicMoatsArr.map(m => m.capability).join('; ')}` : '';
    const brainBlock = (brainPatterns.length || brainMistakes.length) ? `
BRAIN PATTERNS (proven for this brand — reuse these angles and structures): ${JSON.stringify(brainPatterns).slice(0, 1200)}
BRAIN MISTAKES (do NOT repeat for this brand): ${JSON.stringify(brainMistakes).slice(0, 800)}` : '';

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

SCRAPED SIGNALS: ${JSON.stringify(sonarSignals).slice(0, 2400)}
STAGE 1 SIGNALS: ${JSON.stringify(thirdPartySignals).slice(0, 1200)}${competitorBlock}${moatsBlock}${brainBlock}${manualCtx}

Score Experience, Expertise, Authoritativeness, Trustworthiness 0-100. List gaps where score < 60. List smeSignals found.

Respond with this exact JSON structure:
{"scores":{"experience":{"score":0,"rationale":"","evidence":[]},"expertise":{"score":0,"rationale":"","evidence":[]},"authoritativeness":{"score":0,"rationale":"","evidence":[]},"trustworthiness":{"score":0,"rationale":"","evidence":[]}},"overallEEATScore":0,"gaps":[{"dimension":"","gapType":"sme_credentials|awards|case_studies|original_research|customer_proof|author_authority|founding_story|certifications","severity":"high|medium|low","tooltip":"","placeholder":"","whyItMatters":""}],"smeSignals":[{"type":"award|certification|case_study|research|quote|expert|media|client|story","value":"","confidence":0,"source":"scraped|manual","injectionPoint":""}]}` },
      ]
    });

    let scorerData = {};
    try {
      const sd = extractJSON(scorerRes?.content?.[0]?.text || '', 'object');
      if (!sd) throw new Error('No JSON in Tool 2');
      scorerData = JSON.parse(sd);
    } catch(e) { console.log('[ENRICH] Tool 2 parse warn:', e.message, '| stop:', scorerRes?.stop_reason, '| raw:', (scorerRes?.content?.[0]?.text || '').slice(0,200)); scorerData = { scores: {}, gaps: [], smeSignals: [], overallEEATScore: 0 }; }

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

VOICE: ${JSON.stringify(voiceProfile).slice(0, 1200)}
PERSONAS: ${JSON.stringify(personas).slice(0, 1500)}
SME SIGNALS: ${JSON.stringify(scorerData.smeSignals || []).slice(0, 1200)}
GEO TOPICS: ${geoBrief ? JSON.stringify((geoBrief.h2s || []).slice(0,8)) : '[]'}${probeBlock}${topicAngleBlock}${brainBlock}${manualCtx}

Map E-E-A-T signals to content sections. Generate hooks. Build author schema. When MEASURED AI VISIBILITY is present, target the injections at what would make THIS brand citable where the incumbent sources are today; when a TOPIC ANGLE is present, the injections and hooks must reinforce that information-gain angle.

Respond with this exact JSON structure:
{"voiceConsistencyScore":0,"injectionMap":[{"section":"","injectionType":"sme_quote|stat|case_study|first_person_hook|customer_voice|founding_story|award_mention|certification_reference","suggestedContent":"","persona":"","eeatDimension":"experience|expertise|authoritativeness|trustworthiness","confidence":0}],"powerPhrases":[],"authorSchema":{"name":null,"title":null,"expertise":[],"credentials":[],"sameAs":[]},"contentHooks":[{"hook":"","persona":"","type":"curiosity|pain_point|stat|story|contrarian"}]}` },
      ]
    });

    let injectionData = {};
    try {
      const id2 = extractJSON(injectionRes?.content?.[0]?.text || '', 'object');
      if (!id2) throw new Error('No JSON in Tool 3');
      injectionData = JSON.parse(id2);
    } catch(e) { console.log('[ENRICH] Tool 3 parse warn:', e.message, '| stop:', injectionRes?.stop_reason, '| raw:', (injectionRes?.content?.[0]?.text || '').slice(0,200)); injectionData = { injectionMap: [], powerPhrases: [], authorSchema: {}, contentHooks: [] }; }

    // ── Tool 4: Enriched Brief Assembler ─────────────────────────────────────
    send('progress', { stage: 4, label: 'Enriched Brief Assembler', detail: 'Compiling enriched H1, sections, FAQs, schema markup...' });
    console.log('[ENRICH] Tool 4: Enriched Brief Assembler...');

    const assemblerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: 'You are a JSON API. You must respond with valid JSON only — no markdown, no explanation, no code fences.',
      messages: [
        { role: 'user', content: `Enriched brief assembly task for ${brandName}.

EEAT SCORES: ${JSON.stringify(scorerData.scores || {}).slice(0, 1200)}
INJECTIONS: ${JSON.stringify(injectionData.injectionMap || []).slice(0, 1600)}
POWER PHRASES: ${JSON.stringify(injectionData.powerPhrases || []).slice(0, 400)}
AUTHOR SCHEMA: ${JSON.stringify(injectionData.authorSchema || {}).slice(0, 400)}
GEO H2S: ${geoBrief ? JSON.stringify((geoBrief.h2s || []).slice(0,10)) : '[]'}
HIGH GAPS: ${JSON.stringify(gaps.filter(g => g.severity === 'high').map(g => g.gapType))}${topicAngleBlock}${brainBlock}

Assemble enriched brief. Flag sections green/yellow/red by confidence. Mark smeRequired where needed.

CRITICAL SHAPE RULE for eeatInjections: this field is an array of PLAIN ENGLISH PROSE STRINGS ONLY — never JSON objects, never structured data. Each string is the actual text the writer should weave into the article body. Convert each relevant INJECTION above into a natural-language instruction by taking ONLY its suggestedContent field and rewriting it as a prose direction. Example: if an injection has {"type":"sme_quote","suggestedContent":"Open with a Lili Gil Valletta pull quote..."}, the eeatInjection string becomes "Open with a pull quote from Lili Gil Valletta establishing the revenue framing, followed by parenthetical credentials (UN, WEF, TED)." DO NOT copy the JSON keys, braces, or field names into the string.

Respond with this exact JSON structure:
{"enrichedTitle":"","enrichedH1":"","enrichedSections":[{"heading":"","eeatInjections":["prose string only"],"confidenceFlag":"green|yellow|red","flagReason":null,"smeRequired":false}],"enrichedFAQ":[{"q":"","a":"","eeatSignal":""}],"overallConfidence":0,"readyForStage4":true,"humanReviewItems":[]}` },
      ]
    });

    let assembledBrief = {};
    try {
      const ab = extractJSON(assemblerRes?.content?.[0]?.text || '', 'object');
      if (!ab) throw new Error('No JSON in Tool 4');
      assembledBrief = JSON.parse(ab);
    } catch(e) { console.log('[ENRICH] Tool 4 parse warn:', e.message, '| stop:', assemblerRes?.stop_reason, '| raw:', (assemblerRes?.content?.[0]?.text || '').slice(0,200)); assembledBrief = { enrichedSections: [], overallConfidence: 0, readyForStage4: false }; }

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
// ensureGeneratedContentTable moved to src/server/content-table.js (imported at top).

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
    // ── Brain-First: load all context ──────────────���───��─────────────────────
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
    // Load Topical Authority Map — strategic context for where this content lives.
    // Also extract the MEASURED layer off the same row (citationProbe lives on the
    // brand-level geo_briefs brief_data) — previously it sat inside the JSONB the
    // 4000-char trimTo could randomly truncate away, so the writer never reliably
    // saw who AI actually cites or where the brand is invisible.
    let topicalTerritories = [];
    let cgCitationProbe = null;
    try {
      const gbRes = await pool.query(
        `SELECT brief_data FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [brandProfileId]
      );
      cgCitationProbe = gbRes.rows[0]?.brief_data?.citationProbe || null;
      // Prefer the RAW gaps (they carry cluster + informationGainAngle); the
      // normalized topicalAuthorityMap drops both.
      const topicalMapRaw = gbRes.rows[0]?.brief_data?.topicalMap?.gapsByCluster || gbRes.rows[0]?.brief_data?.topicalAuthorityMap || [];
      topicalTerritories = topicalMapRaw
        .map(t => ({
          topic: t.topic || t.cluster || t.name,
          coverage: (t.coverage || t.rationale || t.description || '').slice(0, 140),
          cluster: t.cluster || null,
          angle: (t.informationGainAngle || '').slice(0, 160),
          priority: t.priority || (t.geoCitationScore >= 70 || t.citationProbability >= 70 ? 'high' : t.geoCitationScore >= 40 || t.citationProbability >= 40 ? 'medium' : 'low')
        }))
        .filter(t => t.topic)
        .sort((a, b) => (a.priority === 'high' ? -1 : b.priority === 'high' ? 1 : 0))
        .slice(0, 8);
    } catch(e) { /* silent — non-fatal */ }

    const territoriesBlock = topicalTerritories.length
      ? `\nSTRATEGIC TERRITORIES THIS BRAND OPERATES IN (write as an authority in these territories — never drift outside them):\n${topicalTerritories.map(t => `  • [${t.priority}]${t.cluster ? ` (${t.cluster})` : ''} ${t.topic}${t.coverage ? ' — ' + t.coverage : ''}${t.angle ? `\n    Information-gain angle (the unique claim THIS brand makes here — the article must deliver it): ${t.angle}` : ''}`).join('\n')}\n`
      : '';

    const cgMeasuredBlock = cgCitationProbe
      ? `\nMEASURED AI VISIBILITY (live engine probe — this is the gap the article exists to close): the brand appeared in ${cgCitationProbe.visibility}% of ${cgCitationProbe.totalChecks} AI answers (${Object.entries(cgCitationProbe.byEngine || {}).map(([id, v]) => `${id} ${v.available ? v.pct + '%' : 'n/a'}`).join(' · ')}). WHO AI CITES INSTEAD: ${(cgCitationProbe.sources || []).slice(0, 8).map(s => s.domain).join(', ') || 'none captured'}. Write the piece those incumbent sources would have to cite — more specific, better evidenced, more extractable than what they publish.\n`
      : '';
    const cgCompetitors = Array.isArray(profileData?.competitorAnalysis) ? profileData.competitorAnalysis : [];
    const cgCompetitorBlock = cgCompetitors.length
      ? `\nCOMPETITOR SITE COVERAGE (measured — crawled from their actual websites): ${cgCompetitors.map(c => `${c.url}: ${c.positioning || ''}${(c.signatureClaims || []).length ? ` — claims: ${c.signatureClaims.join(' | ')}` : ''}`).join('\n')}\nDo not echo their claims; write what they demonstrably cannot say.\n`
      : '';
    const cgMoats = Array.isArray(profileData?.strategicMoats) ? profileData.strategicMoats : [];
    const cgMoatsBlock = cgMoats.length
      ? `\nSTRATEGIC MOATS (deliberate non-actions — reference as trust signals where natural, never as weaknesses): ${cgMoats.map(m => m.capability).join('; ')}\n`
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
${topicPrompt ? `\nUSER TOPIC DIRECTION (write the article around this specific topic/angle — this overrides the enriched brief's default topic selection):\n"${topicPrompt}"\n` : ''}${(mandatories || constraints || audience || ctaTarget || desiredAction || wordCountTarget) ? `\nUSER MANDATORIES & CONSTRAINTS (the user-supplied non-negotiables for this article — every section must respect these. Treat as harder than brand patterns):\n${mandatories ? `- MANDATORIES (must include): ${mandatories}\n` : ''}${constraints ? `- CONSTRAINTS (must NOT do): ${constraints}\n` : ''}${audience ? `- TARGET AUDIENCE: ${audience}\n` : ''}${ctaTarget ? `- CTA TARGET URL/PATH: ${ctaTarget} — every CTA in the article should reference this destination.\n` : ''}${desiredAction ? `- DESIRED READER ACTION: ${desiredAction} — shape the article and conclusion to drive toward this specific next step.\n` : ''}${wordCountTarget ? `- TARGET LENGTH: approximately ${wordCountTarget} words. Do not pad — depth over filler.\n` : ''}` : ''}${selfAsCaseStudyBlock}${factualGroundBlock}${territoriesBlock}${cgMeasuredBlock}${cgCompetitorBlock}${cgMoatsBlock}
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

    // Deterministic em-dash backstop — the prompt forbids them outright, but the
    // model keeps emitting them, so guarantee zero ship by stripping every field.
    if (parsed && typeof parsed === 'object') {
      for (const k of ['title', 'metaDescription', 'keyTakeaway']) {
        if (typeof parsed[k] === 'string') parsed[k] = stripEmDashes(parsed[k]);
      }
      if (Array.isArray(parsed.sections)) {
        parsed.sections = parsed.sections.map(s => ({
          ...s,
          ...(typeof s.heading === 'string' ? { heading: stripEmDashes(s.heading) } : {}),
          ...(typeof s.body === 'string' ? { body: stripEmDashes(s.body) } : {}),
          ...(typeof s.content === 'string' ? { content: stripEmDashes(s.content) } : {}),
        }));
      }
      if (Array.isArray(parsed.faqs)) {
        parsed.faqs = parsed.faqs.map(f => ({
          ...f,
          ...(typeof f.question === 'string' ? { question: stripEmDashes(f.question) } : {}),
          ...(typeof f.answer === 'string' ? { answer: stripEmDashes(f.answer) } : {}),
        }));
      }
    }

    // Guarantee the TL;DR (keyTakeaway) is never missing. It's the article's
    // required TL;DR block — rendered at the top of every publish path — and the
    // prompt mandates it, but if the model still omits it, synthesize a publishable
    // fallback from the meta description / opening so a TL;DR ALWAYS exists in the
    // stored article_json. Logged so model misses are visible.
    if (parsed && typeof parsed === 'object' && !String(parsed.keyTakeaway || '').trim()) {
      const firstBody = Array.isArray(parsed.sections)
        ? String(parsed.sections.find(s => (s.body || s.content || '').trim())?.body
            || parsed.sections.find(s => (s.body || s.content || '').trim())?.content || '').trim()
        : '';
      const fallback = String(parsed.metaDescription || '').trim()
        || (firstBody ? truncateAtSentence(firstBody, 300) : '')
        || (parsed.title ? `${parsed.title}.` : '');
      parsed.keyTakeaway = stripEmDashes(fallback);
      console.warn('[CONTENT-GEN] keyTakeaway missing from model output — synthesized TL;DR fallback');
    }

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

    // Prefer the RAW gaps (they carry cluster + informationGainAngle — the
    // brand-coined claims that make the strongest ad anchors); the normalized
    // map drops both. Also pull the measured probe off the same row: its
    // brand-free buyer questions ARE search queries, and the invisible ones
    // are exactly the intent the keywords should capture.
    const adsBrief = gbRes.rows[0]?.brief_data || {};
    const territories = (adsBrief.topicalMap?.gapsByCluster || adsBrief.topicalAuthorityMap || [])
      .slice(0, 6)
      .map(t => ({ topic: t.topic || t.cluster || t.name, angle: (t.informationGainAngle || '').slice(0, 120) }))
      .filter(t => t.topic);
    const adsProbe = adsBrief.citationProbe || null;
    const adsInvisibleQs = adsProbe
      ? (adsProbe.perQuestion || []).filter(r => {
          const checked = Object.values(r.engines || {}).filter(s => s !== 'error');
          return checked.length > 0 && !checked.some(s => s === 'cited' || s === 'mentioned');
        }).map(r => r.question).slice(0, 6)
      : [];
    const adsCompetitors = Array.isArray(profileData.competitorAnalysis) ? profileData.competitorAnalysis : [];

    // voiceProfile is the canonical key (voice_profile is a legacy alias), and
    // the profile schema's fields are summary/toneAttributes/writingStyle/
    // keyPhrases — the old picked subset (tone/formality_score/
    // signature_phrases) doesn't exist on the schema, so the VOICE block had
    // been rendering empty.
    const voice = profileData.voiceProfile || profileData.voice_profile || {};
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
${JSON.stringify({ summary: voice.summary, toneAttributes: (voice.toneAttributes || []).map(a => a.attribute || a).slice(0, 5), writingStyle: voice.writingStyle, keyPhrases: (voice.keyPhrases || []).slice(0, 8), positioning: voice.positioning }, null, 2)}

PRIMARY PERSONAS (write to their pain):
${personas.map(p => `  • ${p.persona_name || p.name || 'unnamed'} — ${Array.isArray(p.painPoints) ? p.painPoints.slice(0, 3).join('; ') : (p.painPoints || p.pain_points || p.painPoint || p.pain || '')}`).join('\n') || '(none)'}

STRATEGIC TERRITORIES (these are your authority anchors — use the language):
${territories.length ? territories.map(t => `  • ${t.topic}${t.angle ? ` — unique angle: ${t.angle}` : ''}`).join('\n') : '(none)'}
${adsInvisibleQs.length ? `\nMEASURED SEARCH INTENT (live engine probe — buyer questions where the brand is INVISIBLE in AI answers today; these are real queries, mine them for keywords and headline angles):\n${adsInvisibleQs.map(q => `  • "${q}"`).join('\n')}\n` : ''}${adsCompetitors.length ? `\nCOMPETITOR SITE COVERAGE (measured — crawled from their actual websites; differentiate, never echo):\n${adsCompetitors.map(c => `  • ${c.url}: ${c.positioning || ''}${(c.signatureClaims || []).length ? ` — claims: ${c.signatureClaims.slice(0, 2).join(' | ')}` : ''}`).join('\n')}\n` : ''}

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

// ensureSocialPostsTable + /api/social-generator/* routes moved to src/server/routes/social-generator.js

// activeStreams (shared SSE registry) moved to src/server/streams.js (imported at top).

// Build a Flux Schnell image prompt tuned for SOCIAL composition (1:1, single subject,
// brand color palette, type-friendly negative space). Different shape than buildImagePrompt()
// which is editorial 16:9. Takes the writer's per-post imagePromptHint as the seed concept
// so each post gets imagery matched to its angle, not generic brand stock.
// buildSocialImagePrompt + generateSocialImage moved to src/server/images.js (imported at top).

app.use('/api/social-generator', requireAuth, socialGeneratorRouter); // 6 routes -> src/server/routes/social-generator.js

app.use('/api/video', requireAuth, videoRouter); // 3 routes (video generation: storyboard -> TTS -> Lambda render) -> src/server/routes/video.js

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
// (campaign route/helper moved to src/server/routes/campaign.js)
// (campaign route/helper moved to src/server/routes/campaign.js)

// POST /api/campaign/plan — generate 8 campaign angle profiles
// Accepts EITHER:
//   { brandProfileId, campaignArcId }  — Context Hub arc expansion (preferred path)
//   { brandProfileId, topicPrompt }    — user-typed custom campaign prompt (power user path)
//   { brandProfileId }                 — no direction; planner infers from brand brain (legacy/fallback)
// (campaign route/helper moved to src/server/routes/campaign.js)


// POST /api/campaign/reset/:id — reset a stalled campaign back to pending
// (campaign route/helper moved to src/server/routes/campaign.js)

// POST /api/campaign/create — save campaign plan to DB

// (campaign route/helper moved to src/server/routes/campaign.js)

// GET /api/campaign/list/:brandProfileId
// (campaign route/helper moved to src/server/routes/campaign.js)

// GET /api/campaign/:id
// (campaign route/helper moved to src/server/routes/campaign.js)

// GET /api/campaign/generate/:id — SSE — generate all pending articles sequentially
// (campaign route/helper moved to src/server/routes/campaign.js)


// ── Stage 5: Compliance Gate
// Ensures compliance columns exist on any generated_content table (idempotent)
// ensureComplianceColumns moved to src/server/routes/compliance.js

// ── Stage 5: Compliance Gate ─────────────────────────────────────────────

app.use('/api/compliance', requireAuth, complianceRouter); // 8 routes -> src/server/routes/compliance.js

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
// uploadXMedia + refreshXOAuth2Token moved to src/server/x.js (imported at top).

// /api/compliance/dismiss-flag + /approve moved to src/server/routes/compliance.js


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
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// GET /api/publishing/queue (all brands — for global queue view)
// POST /api/publishing/backfill-queue — manually stage all approved articles not yet in the queue
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// POST /api/publishing/backfill-queue — manually stage all approved articles not yet in the queue
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// POST /api/publishing/backfill-queue — manually stage all approved articles not yet in the queue
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// PATCH /api/publishing/queue/:itemId
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// DELETE /api/publishing/queue/:itemId — removes from Forge queue only
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// POST /api/publishing/queue/:id/reset-channel — clear error state for one channel
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// POST /api/publishing/unpublish — delete from live channel + optionally remove from queue
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

// GET /api/publishing/channels/:brandProfileId
app.use('/api/publishing', publishingChannelsRouter); // channels CRUD -> src/server/routes/publishing-channels.js

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

// (publishing-channels route moved to src/server/routes/publishing-channels.js)

// Targeted update for Reddit allowedSubreddits / defaultSubreddit. We can't reuse
// POST /api/publishing/channels because that wholesale-overwrites credentials —
// it would wipe the Zernio account ID. This endpoint does a JSONB merge so the
// OAuth credentials are preserved.
//
// Body: { brandProfileId, allowedSubreddits: string[], defaultSubreddit?: string }
// Subreddit names are normalized to bare form (no leading 'r/') and validated
// against Reddit's actual naming rules.
// (publishing-channels route moved to src/server/routes/publishing-channels.js)

// DELETE /api/publishing/channels/:id
// (publishing-channels route moved to src/server/routes/publishing-channels.js)

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
app.use('/api/zernio', zernioRouter); // 3 routes (mixed auth) -> src/server/routes/zernio.js

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
// (zernio route moved to src/server/routes/zernio.js)


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
// (analytics route/helper moved to src/server/routes/analytics.js)
// (analytics route/helper moved to src/server/routes/analytics.js)

// GET /api/analytics/webflow-seo/:brandProfileId — Webflow content performance via GSC
// (analytics route/helper moved to src/server/routes/analytics.js)

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
app.use('/api/publishing', publishingPublishRouter); // dispatcher -> src/server/routes/publishing-publish.js

// (publish dispatcher moved to src/server/routes/publishing-publish.js)

// ══════════════════════════════════════════════════════════════════════════════
// ── Analytics API ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/analytics/sync/:brandProfileId — pull stats from channels, upsert into content_analytics
// Ghost Admin JWT builder
// buildGhostJWT moved to src/server/ghost.js (imported at top).

// (analytics route/helper moved to src/server/routes/analytics.js)

// GET /api/analytics/dashboard/:brandProfileId — aggregated dashboard stats
// (analytics route/helper moved to src/server/routes/analytics.js)

// GET /api/analytics/channels/:brandProfileId — which channels have analytics data
// (analytics route/helper moved to src/server/routes/analytics.js)


// ── Campaign-level analytics ──────────────────────────────────────────────────
// GET /api/analytics/campaigns/:brandProfileId
// Returns per-campaign aggregated metrics across all channels.
// (analytics route/helper moved to src/server/routes/analytics.js)

app.listen(PORT, '0.0.0.0', function () {
  console.log('Forge Intelligence running on port ' + PORT);
});

// ── Scheduled publish runner ──────────────────────────────────────────────────
// Polls every 60 seconds for queue items due to be published.
// Fires the same publish logic as the manual "Publish Now" button.
// (runScheduledPublishes moved to src/server/routes/publishing-publish.js, exported)
// (Pipedream client moved to src/server/pipedream.js)
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
// (publishing-queue route moved to src/server/routes/publishing-queue.js)

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
app.get('/api/admin/activity', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
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

app.get('/api/admin/stats', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
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
  // Gated by the master relay password (fails closed if no body parser ran:
  // undefined !== password). Creates brand profiles + provisions tables, so it
  // must never be reachable unauthenticated.
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) return res.status(403).json({ error: 'Forbidden' });
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

    recordAudit({ req, actorLabel: 'admin-relay-password', action: 'brand.seed', targetType: 'brand', targetId: brandProfileId, brandProfileId,
      summary: `Seeded brand ${brandName || url}`, metadata: { url } });
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




// ── forgeScrape — the one scrape primitive ─────────���───────────────────────
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

// Rate-limit state for the cross-app scrape service lives in scrape.js
// (_forgeScrapeHits + FORGE_SCRAPE_RATE_PER_MIN, the latter imported above).

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
      // Auto-tether orphan brain ONLY on an EXPLICIT claim (?claim=true). A bare
      // brand_id rides in on passive page loads (preview links, deep links, brand
      // picker) and must NOT trigger a tether — doing so vacuumed every anonymous
      // scan into the super-admin account and permanently blocked the real founder
      // from reclaiming it (their claim no-ops on the clerk_user_id IS NULL guard).
      // brand_id alone now only SELECTS which brand to view (handled below).
      const explicitClaim = req.query.claim === 'true' || req.query.claim === '1';
      if (brandId && explicitClaim) {
        const tethered = await pool.query(
          `UPDATE brand_profiles SET clerk_user_id = $1, trial_started_at = COALESCE(trial_started_at, NOW()), updated_at = NOW()
           WHERE id = $2 AND clerk_user_id IS NULL RETURNING id, brand_name`,
          [req.userId, brandId]
        );
        if (tethered.rows.length > 0) {
          console.log(`[AUTH] Super admin ${req.userId} explicitly claimed orphan brand ${tethered.rows[0].brand_name} (${brandId})`);
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
// PROMO_CODES moved to src/server/promo.js (imported at top).

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
  // (Removed a dead precedence-buggy NODE_ENV-gated check — `!x === y` always
  // evaluated false. The unconditional password gate below is the real guard.)
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
    recordAudit({ req, actorLabel: 'admin-relay-password', action: 'brand.reset_paid', targetType: 'brand', targetId: brandProfileId, brandProfileId,
      summary: 'Brand reset to free tier + promo redemptions cleared' });
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
// (analytics route/helper moved to src/server/routes/analytics.js)

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
    { loc: 'https://forgeintelligence.ai/scan',           priority: '0.8',  changefreq: 'monthly', lastmod: now },
    { loc: 'https://forgeintelligence.ai/about',          priority: '0.85', changefreq: 'monthly', lastmod: now },
    { loc: 'https://forgeintelligence.ai/faq',            priority: '0.85', changefreq: 'monthly', lastmod: now },
    { loc: 'https://forgeintelligence.ai/articles',       priority: '0.8',  changefreq: 'weekly',  lastmod: now },
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
      // The brand's article-library index — article details were in the sitemap
      // but their listing page wasn't.
      urls.push({ loc: `https://forgeintelligence.ai/articles/${brandSlug}`, priority: '0.75', changefreq: 'weekly', lastmod: now });
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
    recordAudit({ req, actorLabel: 'admin-relay-password', action: 'relay.query', targetType: 'relay',
      summary: `Relay query (${result.rowCount} rows)`, metadata: { sqlPreview: String(query || '').slice(0, 500), rowCount: result.rowCount } });
    return res.json({ success: true, rows: result.rows, rowCount: result.rowCount });
  } catch(e) {
    recordAudit({ req, actorLabel: 'admin-relay-password', action: 'relay.query', targetType: 'relay',
      summary: `Relay query FAILED`, metadata: { sqlPreview: String(query || '').slice(0, 500), error: e.message } });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Audit Log (Settings → Audit Log) ──────────────────────────────────────────
// Super-admin-only read + CSV export of the security/GDPR evidence trail.
// Strict gate (the logs/stream pattern), never the client-only MC hide.
app.get('/api/admin/audit-log', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { actor, action, targetType, brandProfileId, from, to, format } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const where = []; const params = []; let i = 1;
    if (actor) { where.push(`(actor_clerk_user_id = $${i} OR actor_email = $${i})`); params.push(actor); i++; }
    if (action) { where.push(`action = $${i}`); params.push(action); i++; }
    if (targetType) { where.push(`target_type = $${i}`); params.push(targetType); i++; }
    if (brandProfileId) { where.push(`brand_profile_id = $${i}`); params.push(brandProfileId); i++; }
    if (from) { where.push(`created_at >= $${i}`); params.push(from); i++; }
    if (to) { where.push(`created_at <= $${i}`); params.push(to); i++; }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';

    if (format === 'csv') {
      const cols = ['created_at','actor_clerk_user_id','actor_email','action','target_type','target_id','brand_profile_id','summary','ip'];
      const r = await pool.query(`SELECT ${cols.join(', ')} FROM audit_log ${wh} ORDER BY created_at DESC LIMIT 5000`, params);
      const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [cols.join(',')].concat(r.rows.map(row => cols.map(c => esc(row[c])).join(','))).join('\n');
      // Exporting the audit log is itself an audited event.
      recordAudit({ req, action: 'audit_log.export', targetType: 'audit_log',
        summary: `Exported ${r.rows.length} audit rows (CSV)`, metadata: { filters: { actor, action, targetType, brandProfileId, from, to }, rowCount: r.rows.length } });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(csv);
    }

    const [rowsRes, countRes] = await Promise.all([
      pool.query(`SELECT * FROM audit_log ${wh} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`, [...params, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS n FROM audit_log ${wh}`, params),
    ]);
    res.json({ success: true, rows: rowsRes.rows, total: countRes.rows[0].n, limit, offset });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/admin/audit-log/actions — distinct action vocab for the filter dropdown.
app.get('/api/admin/audit-log/actions', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query(`SELECT DISTINCT action FROM audit_log ORDER BY action`);
    res.json({ success: true, actions: r.rows.map(x => x.action) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── DSAR — Data Subject Access / Erasure (GDPR Art. 15/17/20, issue #25) ──────
// Super-admin-operated for now (not self-service). Covers Forge's reachable
// third-party-PII surface: reviewers (email+name), support_tickets (email), and
// Factual Ground authors (name/linkedin, JSONB on brand_profiles). Names buried
// in free text (competitorAnalysis, personas, article bodies) are NOT
// key-erasable and are returned as a manual-review note rather than silently
// missed. Every call writes to the audit log (DSAR is the first real writer).
const DSAR_UNREACHED_NOTE = 'Free-text surfaces (competitor analysis, personas, generated article bodies) are not key-searchable and require manual review if the subject may appear there.';

async function dsarFind(email, name) {
  const e = (email || '').trim().toLowerCase();
  const n = (name || '').trim().toLowerCase();
  const out = { reviewers: [], supportTickets: [], factualGroundAuthors: [] };

  if (e || n) {
    const rv = await pool.query(
      `SELECT id, brand_profile_id, name, email, title, created_at FROM reviewers
       WHERE ($1 <> '' AND lower(email) = $1) OR ($2 <> '' AND lower(name) = $2)`,
      [e, n]
    ).catch(() => ({ rows: [] }));
    out.reviewers = rv.rows;
  }
  if (e) {
    const st = await pool.query(
      `SELECT id, brand_profile_id, user_email, subject, status, created_at FROM support_tickets WHERE lower(user_email) = $1`,
      [e]
    ).catch(() => ({ rows: [] }));
    out.supportTickets = st.rows;
  }
  // Factual Ground authors: scan brands with an authors array, match by name or linkedin.
  const br = await pool.query(
    `SELECT id, brand_name, settings->'factualGround'->'authors' AS authors
     FROM brand_profiles WHERE jsonb_typeof(settings->'factualGround'->'authors') = 'array'`
  ).catch(() => ({ rows: [] }));
  for (const row of br.rows) {
    const authors = Array.isArray(row.authors) ? row.authors : [];
    const matches = authors.filter(a =>
      (n && (a.name || '').trim().toLowerCase() === n) ||
      (e && (a.linkedinUrl || '').toLowerCase().includes(e)) // rare, but check
    );
    if (matches.length) out.factualGroundAuthors.push({ brand_profile_id: row.id, brand_name: row.brand_name, matches });
  }
  return out;
}

app.post('/api/admin/dsar/lookup', requireAuth, express.json(), async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  const { email, name } = req.body || {};
  if (!email && !name) return res.status(400).json({ error: 'email or name required' });
  try {
    const found = await dsarFind(email, name);
    const counts = {
      reviewers: found.reviewers.length,
      supportTickets: found.supportTickets.length,
      factualGroundAuthors: found.factualGroundAuthors.reduce((s, b) => s + b.matches.length, 0),
    };
    recordAudit({ req, action: 'dsar.access', targetType: 'person', targetId: (email || name),
      summary: `DSAR lookup — ${counts.reviewers} reviewer(s), ${counts.supportTickets} ticket(s), ${counts.factualGroundAuthors} author(s)`,
      metadata: { email: email || null, name: name || null, counts } });
    res.json({ success: true, subject: { email: email || null, name: name || null }, counts, data: found, note: DSAR_UNREACHED_NOTE });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admin/dsar/erase', requireAuth, express.json(), async (req, res) => {
  if (!SUPER_ADMIN_IDS.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  const { email, name, confirm } = req.body || {};
  if (!email && !name) return res.status(400).json({ error: 'email or name required' });
  if (confirm !== true) return res.status(400).json({ error: 'confirm:true required (run lookup first)' });
  const e = (email || '').trim().toLowerCase();
  const n = (name || '').trim().toLowerCase();
  try {
    const result = { reviewersDeleted: 0, supportTicketsRedacted: 0, authorsRemoved: 0, brandsTouched: [] };

    const rv = await pool.query(
      `DELETE FROM reviewers WHERE ($1 <> '' AND lower(email) = $1) OR ($2 <> '' AND lower(name) = $2) RETURNING id`,
      [e, n]
    );
    result.reviewersDeleted = rv.rowCount;

    if (e) {
      const st = await pool.query(
        `UPDATE support_tickets SET user_email = NULL, subject = '[erased per DSAR]', body = '[erased per DSAR]'
         WHERE lower(user_email) = $1 RETURNING id`,
        [e]
      );
      result.supportTicketsRedacted = st.rowCount;
    }

    // Remove matching authors from each brand's factualGround.authors JSONB.
    const br = await pool.query(
      `SELECT id, settings->'factualGround'->'authors' AS authors
       FROM brand_profiles WHERE jsonb_typeof(settings->'factualGround'->'authors') = 'array'`
    );
    for (const row of br.rows) {
      const authors = Array.isArray(row.authors) ? row.authors : [];
      const kept = authors.filter(a => !(
        (n && (a.name || '').trim().toLowerCase() === n) ||
        (e && (a.linkedinUrl || '').toLowerCase().includes(e))
      ));
      if (kept.length !== authors.length) {
        await pool.query(
          `UPDATE brand_profiles SET settings = jsonb_set(settings, '{factualGround,authors}', $2::jsonb), updated_at = NOW() WHERE id = $1`,
          [row.id, JSON.stringify(kept)]
        );
        result.authorsRemoved += (authors.length - kept.length);
        result.brandsTouched.push(row.id);
      }
    }

    recordAudit({ req, action: 'dsar.erase', targetType: 'person', targetId: (email || name),
      summary: `DSAR erasure — ${result.reviewersDeleted} reviewer(s) deleted, ${result.supportTicketsRedacted} ticket(s) redacted, ${result.authorsRemoved} author(s) removed`,
      metadata: { email: email || null, name: name || null, result } });
    res.json({ success: true, subject: { email: email || null, name: name || null }, result, note: DSAR_UNREACHED_NOTE });
  } catch (e2) { res.status(500).json({ success: false, error: e2.message }); }
});

// ── Zernio Test Endpoints (dev-only) ──────────────────────────────────────────
// Three diagnostic endpoints that exercise the Zernio social media API with
// per-stage signal. Reject on production host so we can't accidentally fire
// these against forgeintelligence.ai. Same adminPassword gate as /api/admin/relay.
// Once Zernio is validated as the Pipedream replacement, these come out and the
// real integration ships into the publishing pipeline as a normal vendor.




// GET-style — list profiles. Lightest possible test: validates key + reachability.
app.use('/api/admin/zernio', zernioAdminRouter); // 7 routes -> src/server/routes/zernio-admin.js

// List connected accounts — gives us the LinkedIn account_id for the post step.
// (zernio-admin route moved to src/server/routes/zernio-admin.js)

// Create a post. Pass through full body (minus adminPassword) so we can test
// publishNow vs scheduledFor vs draft from a single endpoint.
// (zernio-admin route moved to src/server/routes/zernio-admin.js)

// Test: probe Zernio's /connect/:platform to see what an OAuth-start response looks like.
// (zernio-admin route moved to src/server/routes/zernio-admin.js)

// Test the connect endpoint to see what shape Zernio's OAuth init looks like.
// Body: { profileId, platform, redirectUrl?, state? }
// (zernio-admin route moved to src/server/routes/zernio-admin.js)

// Create a Zernio profile (needed to associate accounts with a Forge brand).
// Body: { name, description? }
// (zernio-admin route moved to src/server/routes/zernio-admin.js)

// ── Production Zernio OAuth proxy ────────────────────────────────────────────
// Three-step flow:
//   1. POST /api/zernio/connect → returns authUrl, customer redirects to LinkedIn
//   2. LinkedIn → Zernio's callback (out of band)
//   3. GET /integrations/zernio/callback → Zernio bounces back, we save zernioAccountId



// POST /api/admin/zernio/raw — Generic Zernio API probe for admin debugging.
// Body: { adminPassword, method: 'GET'|'POST'|..., path: '/analytics?postId=...', body?: {...} }
// Used to validate API behavior without redeploying. Live tool, not test-only.
// (zernio-admin route moved to src/server/routes/zernio-admin.js)

// (zernio route moved to src/server/routes/zernio.js)

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
// (content route moved to src/server/routes/content.js)

// ── Topic Ideas ───────────────────────────────────────────────────────────────

// GET /api/topic-ideas/:brandProfileId
app.use('/api/topic-ideas', requireAuth, topicIdeasRouter); // 5 routes -> src/server/routes/topic-ideas.js

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
  out.env.hasGemini = !!process.env.GEMINI_API_KEY;
  out.env.hasSerpAPI = !!process.env.SERPAPI_KEY;

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

  // Test one Gemini call (Search grounding) — diagnosing why Gemini returns 0% on every scan.
  if (process.env.GEMINI_API_KEY) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 12000);
      const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'What are the best running shoe brands?' }] }], tools: [{ google_search: {} }] }),
        signal: controller.signal
      });
      const gData = await gRes.json();
      const cand = gData.candidates?.[0];
      const text = (cand?.content?.parts || []).map(p => p.text || '').join(' ');
      out.apiTest.gemini = {
        status: gRes.status,
        error: gData.error ? { code: gData.error.code, message: String(gData.error.message || '').slice(0, 300), status: gData.error.status } : null,
        textLen: text.length,
        textSnippet: text.slice(0, 160),
        groundingChunks: (cand?.groundingMetadata?.groundingChunks || []).length,
        finishReason: cand?.finishReason || null,
        rawKeys: Object.keys(gData),
      };
    } catch(e) { out.apiTest.gemini = { error: e.message }; }
  }

  // Test the AI-Overview SERP provider. Prefer ValueSERP (cheaper); dump the
  // live ai_overview shape so we can confirm field paths after switching.
  out.env.hasValueSerp = !!process.env.VALUESERP_API_KEY;
  if (process.env.VALUESERP_API_KEY) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15000);
      const vRes = await fetch(`https://api.valueserp.com/search?api_key=${process.env.VALUESERP_API_KEY}&q=${encodeURIComponent('best running shoe brands')}&include_ai_overview=true&google_domain=google.com&device=desktop`, { signal: controller.signal });
      const vData = await vRes.json();
      const ov = vData.ai_overview;
      out.apiTest.valueserp = {
        status: vRes.status,
        success: vData.request_info?.success ?? null,
        error: vData.request_info?.success === false ? String(vData.request_info?.message || '').slice(0, 200) : null,
        hasAiOverview: !!ov,
        aiOverviewKeys: ov ? Object.keys(ov) : [],
        sample: ov ? JSON.stringify(ov).slice(0, 500) : null,  // shape confirmation
      };
    } catch(e) { out.apiTest.valueserp = { error: e.message }; }
  } else if (process.env.SERPAPI_KEY) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15000);
      const sRes = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent('best running shoe brands')}&api_key=${process.env.SERPAPI_KEY}`, { signal: controller.signal });
      const sData = await sRes.json();
      out.apiTest.serpapi = {
        status: sRes.status,
        error: sData.error || null,
        hasAiOverview: !!sData.ai_overview,
        aiOverviewKeys: sData.ai_overview ? Object.keys(sData.ai_overview) : [],
        references: (sData.ai_overview?.references || []).length,
      };
    } catch(e) { out.apiTest.serpapi = { error: e.message }; }
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
  const { brandProfileId, topic, refinement, assignedAuthorId } = req.body || {};
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

    // Author assignment — same contract as the batch build-briefs path: resolve
    // assignedAuthorId from factualGround.authors and embed the snapshot in
    // brief_data so downstream stages (enricher author override, content-gen
    // byline) read it from one place. Lookup miss = no author, never an error.
    const ftAuthors = Array.isArray(fg.authors) ? fg.authors : [];
    const ftAssignedAuthor = (assignedAuthorId && typeof assignedAuthorId === 'string')
      ? (ftAuthors.find(a => a && a.id === assignedAuthorId) || null)
      : null;
    const ftAuthorContext = ftAssignedAuthor
      ? `ASSIGNED SME AUTHOR (build the brief from this person's vantage; their expertise should shape the angle):\n` +
        `  Name: ${ftAssignedAuthor.name || ''}\n` +
        `  Title: ${ftAssignedAuthor.title || ''}\n` +
        `  Expertise: ${ftAssignedAuthor.expertise || ''}\n` +
        `  Credentials: ${ftAssignedAuthor.credentials || ''}\n` +
        (ftAssignedAuthor.bio ? `  Background: ${String(ftAssignedAuthor.bio).slice(0, 600)}\n` : '') + '\n'
      : '';

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

${factualContext ? 'FACTUAL GROUND (use verbatim):\n' + factualContext + '\n\n' : ''}${ftAuthorContext}${brainContext}

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

    // 3) Persist the brief (author snapshot embedded when one was assigned —
    //    same shape as the batch build-briefs path)
    const briefDataToPersist = ftAssignedAuthor ? { ...briefData, assignedAuthor: { ...ftAssignedAuthor } } : briefData;
    const briefInsert = await pool.query(
      `INSERT INTO geo_topic_briefs (opportunity_id, brand_profile_id, brief_data, brain_version, status)
       VALUES ($1, $2, $3, $4, 'briefed') RETURNING id, created_at`,
      [opportunityId, brandProfileId, JSON.stringify(briefDataToPersist), profile.version || 1]
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


// POST /api/geo/cold-scan — public AI Visibility scan (the lead magnet at /scan).
// Scrape a prospect's homepage, infer the buyer questions their category gets asked,
// then probe all four engines to MEASURE how often AI cites them vs who it cites
// instead. Synchronous (30-90s): the four-engine probe runs inline.
//
// PUBLIC + rate-limited: each scan spends SerpAPI + LLM credits, so anonymous callers
// are capped per-IP and globally per-day to bound spend. adminPassword bypasses the
// cap (testing). The limiter is in-memory — approximate across Render instances; a
// Redis/DB-backed limiter is the hardening follow-up before heavy traffic.
const _coldScanIpHits = new Map();        // ip -> [timestamps within the hour]
let _coldScanDay = { day: '', count: 0 }; // global daily counter
const COLD_SCAN_PER_IP_PER_HOUR = 3;
const COLD_SCAN_GLOBAL_PER_DAY = 250;
function coldScanRateCheck(ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (_coldScanDay.day !== today) _coldScanDay = { day: today, count: 0 };
  if (_coldScanDay.count >= COLD_SCAN_GLOBAL_PER_DAY) return 'global';
  const recent = (_coldScanIpHits.get(ip) || []).filter(t => now - t < 3600000);
  if (recent.length >= COLD_SCAN_PER_IP_PER_HOUR) return 'ip';
  recent.push(now); _coldScanIpHits.set(ip, recent); _coldScanDay.count++;
  return null;
}

app.post('/api/geo/cold-scan', async (req, res) => {
  const isAdmin = req.body?.adminPassword && req.body.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
  if (!isAdmin) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const limited = coldScanRateCheck(ip);
    if (limited === 'ip') return res.status(429).json({ success: false, error: "You've run a few scans already — try again in an hour." });
    if (limited === 'global') return res.status(429).json({ success: false, error: "We've hit today's free-scan limit. Check back tomorrow, or book a teardown." });
  }

  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ success: false, error: 'url is required' });
  const brandDomain = extractDomain(url);
  if (!brandDomain) return res.status(400).json({ success: false, error: 'Could not parse a domain from url' });

  const startTime = Date.now();
  try {
    // 1. Scrape the homepage to understand what they do.
    const page = await getBrandPageContent(url.startsWith('http') ? url : `https://${url}`, { caller: 'cold-scan' });
    if (!page.success || !page.markdown) {
      return res.status(422).json({ success: false, error: `Could not read ${brandDomain}: ${page.error || 'no content'}` });
    }
    const pageText = page.markdown.slice(0, 6000);

    // 2. Infer the brand name + the brand-free buyer questions their category gets asked.
    const qRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: `From this company's homepage, identify the brand name and write 10 natural questions a buyer or customer (B2B or consumer, whichever fits) would type into ChatGPT or Perplexity when researching this category — the questions where this company would WANT to be recommended. Do NOT mention the company's own name in any question (we are measuring unprompted visibility). Keep each question under 110 characters.

HOMEPAGE (${brandDomain}):
${pageText}

Return ONLY a raw JSON object: {"brandName":"string","questions":["q1",...]}. No markdown, no explanation.` }],
    });
    let parsed = {};
    try { parsed = JSON.parse(extractJSON(qRes.content[0].text, 'object') || '{}'); } catch { parsed = {}; }
    const brandName = (req.body.brandName || parsed.brandName || brandDomain).trim();
    const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 10) : [];
    if (!questions.length) return res.status(502).json({ success: false, error: 'Could not generate buyer questions for this site' });

    // 3. Probe all enabled engines and measure.
    const result = await coldScan({ brandName, brandDomain, questions });
    const latencyMs = Date.now() - startTime;
    console.log(`[COLD-SCAN] ${brandDomain} — visibility ${result.visibility}% across ${result.enginesProbed.join(',')} | ${latencyMs}ms`);
    res.json({ success: true, latencyMs, questions, ...result });
  } catch (e) {
    console.error('[COLD-SCAN] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/geo/track-all — WEEKLY citation-tracking entrypoint for an external
// cron (EasyCron). adminPassword-gated. Loops active brands and kicks the
// per-brand /api/geo/track (fire-and-forget) with a stagger so the four-engine
// probes don't thunder. Brands with no published content no-op cheaply (no
// engine calls). Deliberately NOT an in-process setInterval: with autoscale
// (2-4 instances) a timer fires on every instance — multiplying engine cost —
// and resets on every deploy. A single weekly external trigger is the right,
// idempotent cadence.
app.post('/api/geo/track-all', async (req, res) => {
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  res.json({ success: true, status: 'started' }); // ack fast; process in background
  (async () => {
    try {
      const brandsRes = await pool.query('SELECT id FROM brand_profiles WHERE is_active = true');
      const baseUrl = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
      console.log(`[CitationTracking] weekly run — ${brandsRes.rows.length} active brand(s)`);
      let kicked = 0;
      for (const { id } of brandsRes.rows) {
        try {
          await fetch(`${baseUrl}/api/geo/track/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminPassword: process.env.ADMIN_RELAY_PASSWORD })
          });
          kicked++;
        } catch (e) {
          console.error(`[CitationTracking] ${id} failed:`, e.message);
        }
        await new Promise(r => setTimeout(r, 8000)); // stagger background probe jobs
      }
      console.log(`[CitationTracking] weekly run complete — kicked ${kicked}/${brandsRes.rows.length} brand(s)`);
    } catch (e) {
      console.error('[CitationTracking]', e.message);
    }
  })();
});

app.post('/api/geo/track/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  // Allow cron/admin bypass with adminPassword, otherwise require Clerk JWT
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'], clockTolerance: '30s' });
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
          // Probe every configured engine identically. Perplexity + ChatGPT were
          // here before; Gemini + Google AI Overviews are now measured the same way
          // (see src/server/geoProbe.js). A missing API key disables that engine.
          await Promise.allSettled(CITATION_ENGINES.filter(e => e.enabled()).map(async engine => {
            try {
              const { text, urls } = await engine.probe(question, fetchWithTimeout);
              const cited = isCited({ text, urls, brandDomain });
              const citedSection = cited ? findCitedSection({ text, urls, brandDomain, sections, faqs }) : null;
              await pool.query(
                `INSERT INTO geo_citations (brand_profile_id, content_id, engine, query, is_cited, cited_url, cited_section, response_snippet, raw_citations, checked_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
                 ON CONFLICT (brand_profile_id, content_id, engine, query)
                 DO UPDATE SET is_cited=$5, cited_url=$6, cited_section=$7, response_snippet=$8, raw_citations=$9, checked_at=NOW()`,
                [brandProfileId, article.id, engine.id, question, cited,
                 (urls || []).find(u => urlHasDomain(u, brandDomain)) || null,
                 citedSection, (text || '').slice(0, 300), JSON.stringify(urls || [])]
              ).catch(e => console.error('[GEO-DB]', e.message));
            } catch(e) { console.error(`[GEO-${engine.id.toUpperCase()}]`, e.message); }
          }));
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
// (analytics route/helper moved to src/server/routes/analytics.js)

// POST /api/analytics/decay/:brandProfileId/resolve/:contentId
// (analytics route/helper moved to src/server/routes/analytics.js)

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

// ── Lovable Integration ──────────────────────────────────────────────────────
// POST /api/forge/prompt-pack/lovable
// Turns a Brand Intelligence Profile into a deterministic, URL-encoded prompt
// for Lovable's public Build-with-URL flow. No LLM calls — pure templating.
// Spec: docs/LOVABLE_INTEGRATION.md (FI-LOVABLE-001).

// Lovable prompt-pack helpers + consts now live in src/server/lovable.js
// (imported at top). Pure templating, no LLM/DB/network. The route handler
// below consumes the exported builders, formatters, and LOVABLE_* consts.

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


