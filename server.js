import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID, randomBytes, createHmac } from 'crypto';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

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

  // ── enriched_briefs table ─────────────────────────────────────────────────
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
  } catch(e) { console.log('NeonDB: Brain tables note:', e.message); }


initDB().catch(err => console.error('DB init error:', err));

app.use(express.json());

// ── Shared: Build brand-voice-aware Flux image prompt ────────────────────────
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

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: `Write a single-sentence Flux image generation prompt for a B2B article hero image.

Article title: "${title}"
${brandContext ? brandContext + '\n' : ''}${bodySnippet ? 'Article context: ' + bodySnippet : ''}

Rules:
- Directly reflect the article topic and brand identity above
- Photorealistic editorial photography — Wired, HBR, or Fast Company cover energy
- Abstract macro, architectural detail, natural textures, or environmental storytelling
- Dark cinematic lighting with intentional shadows; muted palette with one accent color${accentColor ? ' (' + accentColor + ')' : ' (deep indigo, slate, or warm amber)'}
- NO floating UI elements, holographic screens, neon data walls, or sci-fi aesthetics
- NO stock-photo clichés (handshakes, lightbulbs, generic offices)
- 1 sentence only, no explanation, no quotes

Output only the prompt.` }]
  });

  return res.content[0]?.type === 'text'
    ? res.content[0].text.trim()
    : `Professional B2B editorial photography for article about ${title}, dark cinematic lighting`;
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
app.get('/api/publishing/sync/:queueItemId', async (req, res) => {
  const { queueItemId } = req.params;
  try {
    const logRes = await pool.query(
      'SELECT pl.*, pc.credentials FROM publish_log pl LEFT JOIN publishing_channels pc ON pc.brand_profile_id = pl.brand_profile_id AND pc.channel = pl.channel WHERE pl.queue_item_id = $1',
      [queueItemId]
    );
    if (!logRes.rows.length) return res.json({ success: true, results: {} });

    const results = {};
    for (const row of logRes.rows) {
      let liveStatus = row.live_status || 'published';
      const creds = row.credentials || {};

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
          // Check X tweet status via v2 API with OAuth 1.0a
          const tweetId = row.response_data?.tweetId || row.response_data?.id;
          const xApiKey    = creds.apiKey    || process.env.X_API_KEY;
          const xApiSecret = creds.apiSecret || process.env.X_API_SECRET;
          const xAccessToken  = creds.accessToken  || process.env.X_ACCESS_TOKEN;
          const xAccessSecret = creds.accessSecret || process.env.X_ACCESS_SECRET;

          if (tweetId && xApiKey && xAccessToken) {
            const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;
            const oauthParams = {
              oauth_consumer_key: xApiKey,
              oauth_nonce: randomBytes(16).toString('hex'),
              oauth_signature_method: 'HMAC-SHA1',
              oauth_timestamp: String(Math.floor(Date.now() / 1000)),
              oauth_token: xAccessToken,
              oauth_version: '1.0',
            };
            const paramStr = Object.entries(oauthParams)
              .sort(([a],[b]) => a.localeCompare(b))
              .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
            const baseStr = `GET&${encodeURIComponent(endpoint)}&${encodeURIComponent(paramStr)}`;
            const sigKey = `${encodeURIComponent(xApiSecret)}&${encodeURIComponent(xAccessSecret)}`;
            oauthParams['oauth_signature'] = createHmac('sha1', sigKey).update(baseStr).digest('base64');
            const authHeader = 'OAuth ' + Object.entries(oauthParams)
              .sort(([a],[b]) => a.localeCompare(b))
              .map(([k,v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ');

            const xRes = await fetch(endpoint, { headers: { 'Authorization': authHeader } });
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
app.post('/api/publishing/republish', async (req, res) => {
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
    const publishRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/publishing/publish`, {
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
app.get('/api/publishing/log/:queueItemId', async (req, res) => {
  try {
    const logRes = await pool.query(
      'SELECT id, channel, status, live_status, published_url, error_message, attempted_at, last_synced_at FROM publish_log WHERE queue_item_id = $1 ORDER BY attempted_at DESC',
      [req.params.queueItemId]
    );
    res.json({ success: true, log: logRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── On-demand hero image regeneration ────────────────────────────────────────
app.post('/api/content/regenerate-image/:contentId', async (req, res) => {
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

    const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fluxPrompt, image_size: 'landscape_16_9', num_inference_steps: 4, num_images: 1 })
    });
    if (!falRes.ok) throw new Error(`fal.ai ${falRes.status}: ${await falRes.text()}`);
    const falData = await falRes.json();
    const imageUrl = falData?.images?.[0]?.url;
    if (!imageUrl) throw new Error('No image URL returned');

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
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      messages: [{ role: 'user', content: `Write a Flux image generation prompt for a B2B editorial hero image for this article: "${article.title}". Context: ${firstBody}. Output only the prompt, no quotes, no preamble. Professional photography style, 16:9, no text in image.` }]
    });
    const fluxPrompt = imgPromptRes.content[0]?.type === 'text' ? imgPromptRes.content[0].text.trim() : `Professional B2B editorial hero image for article about ${article.title}`;

    const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fluxPrompt, image_size: 'landscape_16_9', num_inference_steps: 4, num_images: 1 })
    });
    if (!falRes.ok) throw new Error(`fal.ai ${falRes.status}: ${await falRes.text()}`);
    const falData = await falRes.json();
    const imageUrl = falData?.images?.[0]?.url;
    if (!imageUrl) throw new Error('No image URL returned');

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

    const html = await fs.readFile(path.join(__dirname, 'dist', 'index.html'), 'utf8');
    const ogTags = `
  <title>${title} | ${brandName}</title>
  <meta name="description" content="${description}" />
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
  <meta property="article:published_time" content="${new Date().toISOString()}" />
  <meta name="author" content="${authorName}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  ${imageUrl ? `<meta name="twitter:image" content="${imageUrl}" />` : ''}`;

    const injected = html
      .replace(/<title>[^<]*<\/title>/, '')
      .replace('<head>', '<head>' + ogTags);

    res.set('Cache-Control', 'no-cache');
    return res.send(injected);
  } catch(e) {
    console.error('[OG-META]', e.message);
    return res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  }
});

app.use(express.static(path.join(__dirname, 'dist')));

// ── Content fetch for preview ─────────────────────────────────────────────────
app.get('/api/content/:safeId/:contentId', async (req, res) => {
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

// -- GET /api/brand-profiles/list
app.get('/api/brand-profiles/list', async (req, res) => {
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
  "discoveredCompetitors": ["string"],
  "marketCategory": "string"
}
Requirements: 5 toneAttributes, 2-3 personas, 4-6 thirdPartySignals, 3-5 competitiveGaps, 4-6 strategicRecommendations. Use the ICP and market context provided to make personas and gaps highly specific. For visualStyle and accentColor: infer carefully from the brand website design, color palette, imagery, and overall aesthetic — these feed directly into AI hero image generation and must reflect the real brand identity. For industry, positioning, and targetPersona: be specific and commercially precise, not generic.`;

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
        } else {
          const normalized = { topicalAuthorityMap: cachedTopical, geoOpportunities: cachedGeo, entitySchemaMap: bd.entitySchemaMap, geoBrief: bd.geoBrief };
          return res.json({ success: true, cached: true, data: {
            id: r.id, brandProfileId: r.brand_profile_id,
            brandUrl: r.brand_url, brandName: r.brand_name,
            version: r.version, opportunityScore: r.opportunity_score,
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
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
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
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `You are the GEO Opportunity Scorer for Forge Intelligence.

BRAND: ${profile.brand_name} (${profile.brand_url})
TOPICAL GAPS: ${JSON.stringify(topicalMap.gapsByCluster.slice(0, 10))}
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
    const { topicalAuthorityMap, geoOpportunities: geoOpportunitiesNorm, entitySchemaMap, geoBrief } = normalizeGeoData(briefData, topicalMap, geoOpportunities, entitySchema, profile);
    const fullBriefData = { ...briefData, topicalMap, geoOpportunities, entitySchema, topicalAuthorityMap, geoOpportunitiesNorm, entitySchemaMap, geoBrief };

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

    console.log('[GEO] FINAL topicalAuthorityMap[0]:', JSON.stringify(topicalAuthorityMap[0]));
    console.log('[GEO] FINAL geoOpportunities[0]:', JSON.stringify(geoOpportunitiesNorm[0]));
    console.log('[GEO] FINAL counts — topical:', topicalAuthorityMap.length, 'geo:', geoOpportunitiesNorm.length);
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



// ── Authenticity Enricher API (Stage 3) ──────────────────────────────────────

app.get('/api/authenticity-enricher/briefs', async (req, res) => {
  try {
    const { brandProfileId } = req.query;
    const query = brandProfileId
      ? `SELECT id, brand_profile_id, geo_brief_id, brand_url, brand_name, version,
                confidence_score, enriched_data, created_at, updated_at
         FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY updated_at DESC`
      : `SELECT id, brand_profile_id, geo_brief_id, brand_url, brand_name, version,
                confidence_score, enriched_data, created_at, updated_at
         FROM enriched_briefs ORDER BY updated_at DESC`;
    const result = brandProfileId
      ? await pool.query(query, [brandProfileId])
      : await pool.query(query);
    res.json({ success: true, data: result.rows.map(r => ({
      id: r.id, brandProfileId: r.brand_profile_id, geoBriefId: r.geo_brief_id,
      brandUrl: r.brand_url, brandName: r.brand_name, version: r.version,
      confidenceScore: r.confidence_score, createdAt: r.created_at, updatedAt: r.updated_at,
      ...r.enriched_data
    }))});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/authenticity-enricher/analyze', async (req, res) => {
  const { brandProfileId, geoBriefId, manualInputs = {}, force = false } = req.body;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId is required' });
  const startTime = Date.now();

  try {
    // ── Brain-First ──────────────────────────────────────────────────────────
    let brainPatterns = [], brainMistakes = [];
    try {
      const [pRes, mRes] = await Promise.all([
        pool.query(`SELECT pattern_type, success_rate, tags FROM patterns ORDER BY success_rate DESC LIMIT 10`),
        pool.query(`SELECT mistake_type, human_feedback, guardrail_created FROM mistakes ORDER BY created_at DESC LIMIT 10`)
      ]);
      brainPatterns = pRes.rows;
      brainMistakes = mRes.rows;
    } catch(e) { console.log('[ENRICH] Brain cold:', e.message); }

    // ── Load brand profile ───────────────────────────────────────────────────
    const profileResult = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [brandProfileId]);
    if (!profileResult.rows.length) return res.status(404).json({ success: false, error: 'Brand profile not found. Run Stage 1 first.' });
    const profile = profileResult.rows[0];
    const pd = profile.profile_data || {};

    // ── Load GEO brief if available ──────────────────────────────────────────
    let geoBrief = null;
    if (geoBriefId) {
      const gbRes = await pool.query(`SELECT * FROM geo_briefs WHERE id = $1`, [geoBriefId]);
      if (gbRes.rows.length) geoBrief = { ...gbRes.rows[0].brief_data, brandName: gbRes.rows[0].brand_name };
    } else {
      const gbRes = await pool.query(
        `SELECT * FROM geo_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`, [brandProfileId]
      );
      if (gbRes.rows.length) geoBrief = { ...gbRes.rows[0].brief_data, briefId: gbRes.rows[0].id, brandName: gbRes.rows[0].brand_name };
    }

    // ── Cache check ──────────────────────────────────────────────────────────
    if (!force && !Object.keys(manualInputs).length) {
      const existing = await pool.query(
        `SELECT * FROM enriched_briefs WHERE brand_profile_id = $1 ORDER BY version DESC LIMIT 1`, [brandProfileId]
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
        if (isReal) {
          console.log(`[ENRICH] Cache hit for ${r.brand_url} — eeat:${hasEEAT} injections:${hasInjections} brief:${hasBrief}`);
          return res.json({ success: true, cached: true, data: {
            id: r.id, brandProfileId: r.brand_profile_id, geoBriefId: r.geo_brief_id,
            brandUrl: r.brand_url, brandName: r.brand_name, version: r.version,
            confidenceScore: r.confidence_score, createdAt: r.created_at, updatedAt: r.updated_at,
            ...r.enriched_data
          }});
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
    const manualCtx = Object.keys(manualInputs).length
      ? `\nMANUAL INPUTS PROVIDED BY USER (treat as verified, high-confidence):\n${JSON.stringify(manualInputs, null, 2)}`
      : '';

    // ── Tool 1: SME Signal Scraper ────────────────────────────────────────────
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
          max_tokens: 1000
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

    // ── Tool 2: E-E-A-T Confidence Scorer + Gap Detector ─────────────────────
    console.log('[ENRICH] Tool 2: E-E-A-T Confidence Scorer...');

    const scorerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
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

    // ── Tool 3: Voice + Persona Injection Mapper ──────────────────────────────
    console.log('[ENRICH] Tool 3: Voice & Persona Injection Mapper...');

    const injectionRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
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
    console.log('[ENRICH] Tool 4: Enriched Brief Assembler...');

    const assemblerRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
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
{"enrichedTitle":"","enrichedH1":"","enrichedSections":[{"heading":"","eeatInjections":[],"confidenceFlag":"green|yellow|red","flagReason":null,"smeRequired":false}],"enrichedFAQ":[{"q":"","a":"","eeatSignal":""}],"authorSchemaMarkup":{},"overallConfidence":0,"readyForStage4":true,"humanReviewItems":[]}` },
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
        authorSchemaMarkup: {},
        overallConfidence: scorerData.overallEEATScore || 0,
        readyForStage4: fallbackSections.length > 0,
        humanReviewItems: ['Tool 4 used fallback — re-run for full enrichment']
      };
      console.log('[ENRICH] Tool 4 fallback brief built from GEO brief —', fallbackSections.length, 'sections');
    }

    const enrichedData = {
      eeatScores: scorerData.scores,
      overallEEATScore: scorerData.overallEEATScore,
      gaps,
      needsManualInput,
      smeSignals: scorerData.smeSignals,
      injectionMap: injectionData.injectionMap,
      powerPhrases: injectionData.powerPhrases,
      authorSchema: injectionData.authorSchema,
      contentHooks: injectionData.contentHooks,
      voiceConsistencyScore: injectionData.voiceConsistencyScore,
      ...assembledBrief,
      sonarSignals,
      manualInputsProvided: manualInputs,
      geoBriefId: geoBrief?.briefId || geoBriefId || null
    };

    const confidenceScore = assembledBrief.overallConfidence || scorerData.overallEEATScore || 0;

    await pool.query(
      `INSERT INTO enriched_briefs (id, brand_profile_id, geo_brief_id, brand_url, brand_name, version, confidence_score, enriched_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId, brandProfileId, enrichedData.geoBriefId, profile.brand_url, brandName, nextVersion, confidenceScore, JSON.stringify(enrichedData)]
    );

    const latencyMs = Date.now() - startTime;
    console.log(`[ENRICH] Complete — Score: ${confidenceScore} | Gaps: ${gaps.length} | NeedsManual: ${needsManualInput} | Latency: ${latencyMs}ms`);

    res.json({ success: true, cached: false, data: {
      id: newId, brandProfileId, brandUrl: profile.brand_url, brandName,
      version: nextVersion, confidenceScore, latencyMs, needsManualInput,
      ...enrichedData
    }});

  } catch (err) {
    console.error('[ENRICH] Error:', err);
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
  return tableName;
}

app.get('/api/content-generator/generate', async (req, res) => {
  const { brandProfileId, enrichedBriefId, force } = req.query;
  if (!brandProfileId) return res.status(400).json({ success: false, error: 'brandProfileId required' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => clearInterval(keepalive));

  try {
    // ── Brain-First: load all context ────────────────────────────────────────
    const [profileRes, patternsRes, mistakesRes] = await Promise.all([
      pool.query('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]),
      pool.query('SELECT pattern_type, success_rate, tags FROM patterns ORDER BY success_rate DESC LIMIT 10').catch(() => ({ rows: [] })),
      pool.query('SELECT mistake_type, human_feedback FROM mistakes ORDER BY created_at DESC LIMIT 10').catch(() => ({ rows: [] }))
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
    const userPrompt = `Generate a long-form article using the following Brand Intelligence context.

BRAND PROFILE:
${trimTo(profileData, 6000)}

GEO BRIEF:
${geoBrief ? trimTo(geoBrief, 4000) : 'Not available — infer topical strategy from brand profile.'}

ENRICHED BRIEF:
${enrichedBrief ? trimTo(enrichedBrief, 6000) : 'Not available — use brand profile voice and personas.'}

BRAIN PATTERNS (what worked):
${trimTo(patternsRes.rows, 2000)}

BRAIN MISTAKES (what to avoid):
${trimTo(mistakesRes.rows, 2000)}

Return ONLY valid JSON matching the specified output format. No markdown, no code fences, no commentary.`;

    send('chunk', 'Brain loaded. Building article...');

    // ── Stream from Claude ────────────────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let fullText = '';
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 8096,
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
              send('error', 'JSON parse failed: ' + e.message);
              return res.end();
            }
          } catch(e3) {
            send('error', 'JSON parse failed: ' + e.message);
            return res.end();
          }
        }
      }
    } catch(e) {
      send('error', 'JSON parse failed: ' + e.message);
      return res.end();
    }

    // Strip AI artifact placeholders from section bodies before saving
    if (parsed.sections) {
      const artifactRx = /\[NEEDS CITATION:[^\]]*\]|\[CITATION:[^\]]*\]|\[SOURCE:[^\]]*\]/gi;
      parsed.sections = parsed.sections.map((s) => ({
        ...s,
        body: s.body ? s.body.replace(artifactRx, '').trim() : s.body,
        content: s.content ? s.content.replace(artifactRx, '').trim() : s.content,
      }));
    }

    const tableName = await ensureGeneratedContentTable(brandProfileId);
    const contentInsert = await pool.query(
      `INSERT INTO ${tableName} (brand_profile_id, enriched_brief_id, title, article_json, overall_confidence, brain_match_score, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft') RETURNING id`,
      [brandProfileId, enrichedBriefId || null, parsed.title, JSON.stringify(parsed),
       parsed.overallConfidence || null, parsed.brainMatchScore || null]
    );
    const contentId = contentInsert.rows[0]?.id;

    await pool.query(
      `INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['stage4_content_generator', brandProfileId, 'success',
       (stream.usage?.input_tokens || 0) + (stream.usage?.output_tokens || 0),
       0, JSON.stringify({ title: parsed.title, overallConfidence: parsed.overallConfidence })]
    ).catch(() => {});

    send('done', JSON.stringify(parsed));

    // Fire Flux image generation in parallel — don't block the done event
    (async () => {
      try {
        const streamFirstBody = (parsed.sections?.[0]?.body || parsed.sections?.[0]?.content || '').slice(0, 250);
        const fluxPrompt = await buildImagePrompt(parsed.title, profileData?.voice_profile || {}, streamFirstBody);

        const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
          method: 'POST',
          headers: {
            'Authorization': `Key ${process.env.FAL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: fluxPrompt,
            image_size: 'landscape_16_9',
            num_inference_steps: 4,
            num_images: 1,
            enable_safety_checker: true,
          })
        });

        if (!falRes.ok) throw new Error(`fal.ai ${falRes.status}`);
        const falData = await falRes.json();
        const imageUrl = falData?.images?.[0]?.url;
        if (!imageUrl) throw new Error('No image URL from fal.ai');

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
app.post('/api/campaign/plan', async (req, res) => {
  const { brandProfileId } = req.body;
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

BRAND PROFILE:
${trimTo(profileData, 4000)}

GEO BRIEF:
${geoBrief ? trimTo(geoBrief, 4000) : 'Not available — infer from brand profile.'}

ENRICHED BRIEF:
${enrichedBrief ? trimTo(enrichedBrief, 4000) : 'Not available — infer from brand profile.'}

Return ONLY valid JSON matching the output format. No markdown, no commentary.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = message.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const plan = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

    res.json({ success: true, plan });
  } catch (err) {
    console.error('Campaign plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaign/create — save campaign plan to DB
// ── Test: image generation endpoint (no article needed) ──────────────────────
app.get('/api/test/image', async (req, res) => {
  try {
    const title = req.query.title || 'The Future of B2B Marketing Intelligence';
    const voiceProfile = { tone_summary: req.query.tone || 'Professional, strategic, data-driven' };
    const fluxPrompt = await buildImagePrompt(title, voiceProfile, '');
    const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fluxPrompt, image_size: 'landscape_16_9', num_inference_steps: 4, num_images: 1 })
    });
    const falData = await falRes.json();
    res.json({ prompt: fluxPrompt, imageUrl: falData?.images?.[0]?.url, raw: falData });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/campaign/create', async (req, res) => {
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
app.get('/api/campaign/list/:brandProfileId', async (req, res) => {
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
app.get('/api/campaign/generate/:id', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Keepalive ping every 30s so Render/proxies don't drop the SSE connection
  const keepalive = setInterval(() => res.write(': ping\n\n'), 30000);
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

        const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
          method: 'POST',
          headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: fluxPrompt, image_size: 'landscape_16_9', num_inference_steps: 4, num_images: 1 })
        });
        if (!falRes.ok) throw new Error(`fal.ai error ${falRes.status}`);
        const falData = await falRes.json();
        const imageUrl = falData?.images?.[0]?.url;
        if (!imageUrl) throw new Error('No image URL');

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
        model: 'claude-sonnet-4-5',
        max_tokens: 8096,
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
        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : fullText);
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
app.get('/api/compliance/latest/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const tableName = `generated_content_${safeId}`;
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
app.post('/api/compliance/critique', async (req, res) => {
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
    const mistakesRes = await pool.query(`SELECT * FROM mistakes ORDER BY created_at DESC LIMIT 20`).catch(() => ({ rows: [] }));
    const mistakes = mistakesRes.rows;

    const systemPrompt = `You are a compliance and brand voice auditor. Analyze this article against the brand profile and known mistakes. Return a JSON compliance report.

Brand Voice Profile:
${JSON.stringify(brand?.voice_profile || {}, null, 2)}

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
      "sectionIndex": <number>,
      "sectionHeading": "<heading>",
      "severity": "yellow" | "red",
      "type": "brand_voice" | "factual_claim" | "legal_risk" | "sme_required",
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
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Article to audit:\n\n${JSON.stringify(articleJson, null, 2)}` }]
      })
    });
    const critiqueData = await critiqueRes.json();
    const rawText = critiqueData.content?.[0]?.text || '{}';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const report = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);

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

// POST approve — save human edits, write mistakes to brain, mark approved
app.post('/api/compliance/approve', async (req, res) => {
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
          const orig = articleJson.sections[edit.sectionIndex].content;
          if (orig !== edit.content) {
            // Write to brain mistakes table
            pool.query(
              `INSERT INTO mistakes (id, mistake_type, human_feedback, guardrail_created, severity, created_at)
               VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW())`,
              [
                'human_edit',
                `Section "${articleJson.sections[edit.sectionIndex].heading}": original phrase edited by human reviewer`,
                `Avoid phrasing: "${orig.substring(0, 200)}..." — prefer: "${edit.content.substring(0, 200)}..."`,
                'yellow'
              ]
            ).catch(e => console.error('[COMPLIANCE] Mistake write error:', e.message));
            articleJson.sections[edit.sectionIndex].content = edit.content;
          }
        }
      });
    }

    // Handle red section decisions
    const finalStatus = reviewMode === 'auto-ship' ? 'approved' :
      decisions && Object.values(decisions).some(d => d === 'rejected') ? 'rejected' : 'approved';

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

// GET /api/publishing/queue/:brandProfileId
app.get('/api/publishing/queue/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM publishing_queue WHERE brand_profile_id = $1 ORDER BY created_at DESC`,
      [brandProfileId]
    );
    res.json({ success: true, items: result.rows });
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

app.get('/api/publishing/queue', async (req, res) => {
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
  const { channels, scheduledAt, status } = req.body;
  try {
    const fields = [];
    const vals = [];
    let i = 1;
    if (channels !== undefined) { fields.push(`channels = $${i++}`); vals.push(JSON.stringify(channels)); }
    if (scheduledAt !== undefined) { fields.push(`scheduled_at = $${i++}`); vals.push(scheduledAt || null); }
    if (status !== undefined) { fields.push(`status = $${i++}`); vals.push(status); }
    fields.push(`updated_at = NOW()`);
    vals.push(itemId);
    await pool.query(`UPDATE publishing_queue SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/publishing/queue/:itemId
app.delete('/api/publishing/queue/:itemId', async (req, res) => {
  const { itemId } = req.params;
  try {
    await pool.query('DELETE FROM publishing_queue WHERE id = $1', [itemId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/publishing/channels/:brandProfileId
app.get('/api/publishing/channels/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, brand_profile_id, channel, utm_template, is_active, last_tested_at, test_status, created_at, updated_at
       FROM publishing_channels WHERE brand_profile_id = $1 ORDER BY channel`,
      [brandProfileId]
    );
    res.json({ success: true, channels: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/publishing/channels — upsert channel connection
app.post('/api/publishing/channels', async (req, res) => {
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
app.delete('/api/publishing/channels/:id', async (req, res) => {
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
  const redirectUri = encodeURIComponent('https://forgeintelligence.ai/auth/linkedin/callback');
  const brandProfileId = req.query.brandProfileId || 'system';
  const nonce = randomBytes(16).toString('hex');
  // Embed brandProfileId in state so callback knows which brand to save to
  const state = `${brandProfileId}|${nonce}`;
  const scopes = 'openid profile email w_member_social';
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scopes)}`;
  res.json({ authUrl: url, state });
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/app/integrations?linkedin_error=${error}`);
  if (!code) return res.redirect('/app/integrations?linkedin_error=no_code');
  try {
    const clientId     = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const redirectUri  = 'https://forgeintelligence.ai/auth/linkedin/callback';
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
    const authorUrn = `urn:li:person:${profile.sub}`;

    // Parse brandProfileId from state param
    const stateDecoded = decodeURIComponent(state || '');
    const brandProfileId = stateDecoded.includes('|') ? stateDecoded.split('|')[0] : 'system';

    await pool.query(`
      INSERT INTO publishing_channels (brand_profile_id, channel, credentials, is_connected, connected_at)
      VALUES ($1, 'linkedin', $2, true, NOW())
      ON CONFLICT (brand_profile_id, channel) DO UPDATE
        SET credentials = $2, is_connected = true, connected_at = NOW()
    `, [brandProfileId, JSON.stringify({ accessToken: tokenData.access_token, expiresIn: tokenData.expires_in, authorUrn, name: profile.name })]);

    res.redirect('/app/integrations?linkedin_connected=true');
  } catch (err) {
    console.error('LinkedIn callback error:', err);
    res.redirect(`/app/integrations?linkedin_error=${encodeURIComponent(err.message)}`);
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Generate LinkedIn post copy preview ───────────────────────────────────────
app.post('/api/publishing/generate-post-copy', async (req, res) => {
  const { title, headings, readMinutes, articleUrl } = req.body;
  try {
    const copyRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: `Write a LinkedIn post to promote this B2B article. Give a compelling overview of what the reader will learn — NOT a quote from the intro paragraph.

Article title: "${title}"
Sections covered: ${headings || 'not provided'}
Read time: ${readMinutes} min read
Article URL: ${articleUrl}

Rules:
- 3-4 short paragraphs
- Lead with the core insight or tension, not a question
- No emojis, no hashtags
- Every sentence must be complete — no ellipsis cutoffs
- Last line must be exactly: Read more: ${articleUrl}
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
    const brandSlug = (brand.brand_url || 'brand').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const articleSlug = (article.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

    // Load channel connections for this brand
    const channelsRes = await pool.query(
      'SELECT * FROM publishing_channels WHERE brand_profile_id = $1',
      [item.brand_profile_id]
    );
    const channelMap = {};
    for (const ch of channelsRes.rows) channelMap[ch.channel] = ch;

    const targets = selectedChannels || item.channels || [];
    const results = {};

    for (const channel of targets) {
      const chConfig = channelMap[channel];
      if (!chConfig) { results[channel] = { status: 'error', error: 'Channel not connected' }; continue; }

      const utmCtx = { channel, brandSlug, articleSlug, campaignSlug: article.campaign_id || 'forge-content' };
      const utmParams = resolveUtmParams(chConfig.utm_template || {}, utmCtx);
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
          const webflowToken = creds.apiToken || process.env.WEBFLOW_API_TOKEN;
          const siteId = creds.siteId || '69c715bf39ddf47aae9481b1';
          const collectionId = creds.collectionId || '69c7189df169a5faf671dba4';
          if (!webflowToken) throw new Error('Missing Webflow API token');

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
          const publishedUrl = `https://${brand.brand_url || siteId}/articles/${slug}`;
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
            const liBrandSlug = (brand.brand_url || brand.brand_name || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().split('-').slice(0,3).join('-');
            const liBaseDomain = process.env.BASE_DOMAIN || 'forgeintelligence.ai';
            const articleUrl = `https://${liBaseDomain}/articles/${liBrandSlug}/${articleSlug}${utmString ? '?' + utmString : ''}`;

            // Generate or use provided post copy
            let postText = postCopyOverride;
            if (!postText) {
              const wordCount = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
              const readMinutes = Math.max(2, Math.round(wordCount / 200));
              const sectionHeadings = sections.slice(1, 5).map(s => s.heading).filter(Boolean).join(', ');
              try {
                const copyRes = await anthropic.messages.create({
                  model: 'claude-haiku-4-5',
                  max_tokens: 400,
                  messages: [{ role: 'user', content: `Write a LinkedIn post to promote this article. It should be a compelling overview (NOT the intro paragraph), end with a clear CTA, and the last line should be exactly "Read more: ${articleUrl}"

Article title: "${article.title}"
Key sections covered: ${sectionHeadings}
Read time: ${readMinutes} min read

Rules:
- 3-5 short paragraphs max
- Lead with the core insight or tension, not a question
- No emojis
- No hashtags  
- No ellipsis (...) cutoffs — complete every sentence
- Last line must be exactly: Read more: ${articleUrl}
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
          // ── Real X (Twitter) API v2 publish via OAuth 1.0a ──
          const xApiKey       = creds.apiKey       || process.env.X_API_KEY;
          const xApiSecret    = creds.apiSecret    || process.env.X_API_SECRET;
          const xAccessToken  = creds.accessToken  || process.env.X_ACCESS_TOKEN;
          const xAccessSecret = creds.accessSecret || process.env.X_ACCESS_SECRET;
          if (!xApiKey || !xApiSecret || !xAccessToken || !xAccessSecret) throw new Error('Missing X credentials');

          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const excerpt = (sections[0]?.content || sections[0]?.body || article.title || '').slice(0, 200);
          const xBrandSlug = (brand.brand_url || brand.brand_name || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().split('-').slice(0, 3).join('-');
          const xArticleSlug = (article.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '').slice(0, 80);
          const xBaseDomain = process.env.BASE_DOMAIN || 'forgeintelligence.ai';
          const articleUrl = `https://${xBaseDomain}/articles/${xBrandSlug}/${xArticleSlug}`;
          const tweetText = `${excerpt}... ${articleUrl}${utmString ? '?' + utmString : ''}`.slice(0, 280);

          // Build OAuth 1.0a signature
          const tweetUrl = 'https://api.twitter.com/2/tweets';
          const oauthParams = {
            oauth_consumer_key: xApiKey,
            oauth_nonce: randomBytes(16).toString('hex'),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: String(Math.floor(Date.now() / 1000)),
            oauth_token: xAccessToken,
            oauth_version: '1.0',
          };
          const sortedParams = Object.entries(oauthParams).sort(([a],[b]) => a.localeCompare(b))
            .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
          const baseString = `POST&${encodeURIComponent(tweetUrl)}&${encodeURIComponent(sortedParams)}`;
          const signingKey = `${encodeURIComponent(xApiSecret)}&${encodeURIComponent(xAccessSecret)}`;
          const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
          oauthParams['oauth_signature'] = signature;
          const authHeader = 'OAuth ' + Object.entries(oauthParams).sort(([a],[b]) => a.localeCompare(b))
            .map(([k,v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ');

          const xRes = await fetch(tweetUrl, {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: tweetText })
          });
          const xData = await xRes.json();
          if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
          const tweetId = xData.data?.id;
          // Look up authenticated user's handle to build the correct tweet URL
          let twitterHandle = 'i';
          try {
            const meRes = await fetch('https://api.twitter.com/2/users/me', {
              headers: { 'Authorization': authHeader }
            });
            if (meRes.ok) {
              const meData = await meRes.json();
              twitterHandle = meData.data?.username || 'i';
            }
          } catch(e) { /* fall back to /i/status/ path */ }
          const tweetUrl2 = `https://x.com/${twitterHandle}/status/${tweetId}`;
          results[channel] = { status: 'published', url: tweetUrl2, tweetId, utmParams };

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

    await pool.query(
      `UPDATE publishing_queue SET status = $1, channels = $2, publish_results = $3, published_at = $4, updated_at = NOW() WHERE id = $5`,
      [newStatus, JSON.stringify(targets), JSON.stringify(results), allPublished ? new Date() : null, queueItemId]
    );

    // Write memory to Brain on any successful publish
    const successfulChannels = targets.filter(ch => results[ch]?.status === 'published' || results[ch]?.status === 'staged');
    if (successfulChannels.length > 0) {
      pool.query(
        `INSERT INTO memories (id, raw_content, metadata, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, NOW())`,
        [
          `Published: ${article.title}`,
          JSON.stringify({ contentId: item.content_id, channels: successfulChannels, brandProfileId: item.brand_profile_id, publishedAt: new Date(), utmResults: results })
        ]
      ).catch(e => console.error('[MEMORY] Write error:', e.message));
    }

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
app.post('/api/analytics/sync/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  const { channel = 'linkedin' } = req.body;
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const synced = [];
    const errors = [];

    if (channel === 'linkedin' || channel === 'all') {
      // Get all LinkedIn published posts from publish_log
      const logRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                ct.title
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'linkedin' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      // Get LinkedIn credentials from publishing_channels (primary) or channel_credentials (legacy)
      const credRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'linkedin' AND is_active = true
         UNION ALL
         SELECT credentials FROM channel_credentials WHERE brand_profile_id = $1 AND channel = 'linkedin'
         LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const creds = credRes.rows[0]?.credentials || {};
      const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;

      for (const row of logRes.rows) {
        try {
          const postId = row.response_data?.postId || row.response_data?.post_id || row.response_data?.id;
          if (!postId || !token) {
            if (!token) errors.push({ contentId: row.content_id, error: 'no_linkedin_token' });
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
            }
          } catch(e) { /* socialActions unavailable — continue */ }

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
          } catch(e) { /* MDP not yet approved — expected */ }

          // Engagement rate: use impressions if available, else use total engagements as proxy
          const totalEngagement = reactions + comments + reposts + clicks;
          const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
          const engagementRate = impressions > 0
            ? parseFloat((totalEngagement / impressions * 100).toFixed(2))
            : 0;

          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
             ON CONFLICT (content_id, channel) DO UPDATE SET
               impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
               reactions=EXCLUDED.reactions, comments=EXCLUDED.comments,
               reposts=EXCLUDED.reposts, ctr=EXCLUDED.ctr,
               engagement_rate=EXCLUDED.engagement_rate,
               raw_data=EXCLUDED.raw_data, synced_at=NOW()`,
            [brandProfileId, row.content_id, 'linkedin', postId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at]
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
        `SELECT content_id, response_data, attempted_at AS published_at, published_url
         FROM publish_log
         WHERE brand_profile_id = $1 AND channel = 'x' AND status = 'published'
         ORDER BY attempted_at DESC`,
        [brandProfileId]
      );

      const xCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels
         WHERE brand_profile_id = $1 AND channel = 'x' AND is_active = true
         LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const xCreds = xCredRes.rows[0]?.credentials || {};
      const xApiKey       = xCreds.apiKey       || process.env.X_API_KEY;
      const xApiSecret    = xCreds.apiSecret    || process.env.X_API_SECRET;
      const xAccessToken  = xCreds.accessToken  || process.env.X_ACCESS_TOKEN;
      const xAccessSecret = xCreds.accessSecret || process.env.X_ACCESS_SECRET;

      for (const row of xLogRes.rows) {
        try {
          // Extract tweetId — from response_data, queue publish_results, or parse from published_url
          const rd = row.response_data || row.queue_results?.x || {};
          const tweetId = rd.tweetId || rd.id
            || (row.published_url?.match(/\/status\/(\d+)/)?.[1]);
          if (!tweetId || !xApiKey || !xAccessToken) {
            if (!xApiKey || !xAccessToken) errors.push({ contentId: row.content_id, error: 'no_x_credentials' });
            else if (!tweetId) errors.push({ contentId: row.content_id, error: 'no_tweet_id_in:' + row.published_url });
            continue;
          }

          // Build OAuth 1.0a header for GET request
          const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;
          const oauthParams = {
            oauth_consumer_key: xApiKey,
            oauth_nonce: randomBytes(16).toString('hex'),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: String(Math.floor(Date.now() / 1000)),
            oauth_token: xAccessToken,
            oauth_version: '1.0',
          };
          const queryString = 'tweet.fields=public_metrics,created_at,author_id';
          const paramStr = Object.entries({ ...oauthParams, ...Object.fromEntries(new URLSearchParams(queryString)) })
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
          const baseStr = `GET&${encodeURIComponent(endpoint)}&${encodeURIComponent(paramStr)}`;
          const sigKey = `${encodeURIComponent(xApiSecret)}&${encodeURIComponent(xAccessSecret)}`;
          oauthParams['oauth_signature'] = createHmac('sha1', sigKey).update(baseStr).digest('base64');
          const authHeader = 'OAuth ' + Object.entries(oauthParams).sort(([a],[b]) => a.localeCompare(b))
            .map(([k,v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ');

          const tweetRes = await fetch(`${endpoint}?${queryString}`, {
            headers: { 'Authorization': authHeader }
          });

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};

          if (tweetRes.ok) {
            const tweetData = await tweetRes.json();
            const metrics = tweetData.data?.public_metrics || {};
            // X public_metrics: impression_count, like_count, reply_count, retweet_count, quote_count, bookmark_count, url_link_clicks
            impressions = metrics.impression_count  || 0;
            reactions   = metrics.like_count        || 0;
            comments    = metrics.reply_count       || 0;
            reposts     = (metrics.retweet_count || 0) + (metrics.quote_count || 0);
            clicks      = metrics.url_link_clicks   || metrics.user_profile_clicks || 0;
            rawData     = metrics;
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
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
             ON CONFLICT (content_id, channel) DO UPDATE SET
               impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
               reactions=EXCLUDED.reactions, comments=EXCLUDED.comments,
               reposts=EXCLUDED.reposts, ctr=EXCLUDED.ctr,
               engagement_rate=EXCLUDED.engagement_rate,
               raw_data=EXCLUDED.raw_data, synced_at=NOW()`,
            [brandProfileId, row.content_id, 'x', tweetId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at]
          );
          synced.push({ contentId: row.content_id, title: row.title, tweetId, impressions, reactions, comments, reposts, clicks });
        } catch(e) {
          errors.push({ contentId: row.content_id, error: e.message });
        }
      }
    }

    res.json({ success: true, channel, synced: synced.length, errors: errors.length, data: synced, errs: errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/analytics/dashboard/:brandProfileId — aggregated dashboard stats
app.get('/api/analytics/dashboard/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
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

    // Top 5 posts by impressions
    const top = await pool.query(
      `SELECT ca.content_id, ca.impressions, ca.clicks, ca.reactions,
              ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
              ca.synced_at AS published_at, ca.synced_at,
              pl.published_url, pq.title
       FROM content_analytics ca
       LEFT JOIN publish_log pl ON pl.content_id = ca.content_id AND pl.channel = ca.channel AND pl.status = 'published'
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id=$1 AND ca.channel=$2
       ORDER BY ca.impressions DESC, ca.reactions DESC
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

    // All posts for table — join publish_log for title/url, no generated_content join
    const posts = await pool.query(
      `SELECT ca.content_id, ca.impressions, ca.clicks, ca.reactions,
              ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
              ca.synced_at AS published_at, ca.synced_at, ca.channel,
              pl.published_url, pq.title
       FROM content_analytics ca
       LEFT JOIN publish_log pl ON pl.content_id = ca.content_id AND pl.channel = ca.channel AND pl.status = 'published'
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id=$1 AND ca.channel=$2
       ORDER BY ca.impressions DESC, ca.synced_at DESC`,
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
app.get('/api/analytics/channels/:brandProfileId', async (req, res) => {
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


app.listen(PORT, '0.0.0.0', function () {
  console.log('Forge Intelligence running on port ' + PORT);
});

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

