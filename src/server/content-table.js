// Per-brand generated-content table helper, extracted from server.js during the
// route-group phase. ensureGeneratedContentTable idempotently creates/upgrades
// the `generated_content_<brandId>` table and returns its name. Shared by the
// content-generator and campaign-generator flows (server.js + routes/campaign.js).
import { pool } from './db.js';

export async function ensureGeneratedContentTable(brandProfileId) {
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
