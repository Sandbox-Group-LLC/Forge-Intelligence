#!/usr/bin/env node
/**
 * Surgical brandVisual/3 backfill — CSS palette/typography/fonts/logo only.
 *
 * Does NOT re-run Context Hub / LLM analysis. Patches profile_data.brandVisual
 * (+ scrapeVersion + voiceProfile.accentColor when measured) via admin SQL relay.
 *
 * Why not Jina? r.jina.ai returns markdown text. brandVisual/3 needs computed
 * CSS + @font-face harvest via Bright Data Scraping Browser (captureBrandVisual).
 *
 * Env:
 *   ADMIN_RELAY_PASSWORD   (required) — prod/dev relay gate
 *   BRIGHTDATA_BROWSER_AUTH (required) — puppeteer wss auth
 *   BRIGHTDATA_API_KEY / BRIGHTDATA_UNLOCKER_ZONE (optional; unused for visual)
 *   RELAY_URL              (default https://forgeintelligence.ai/api/admin/relay)
 *   CONCURRENCY            (default 1 — BD browser sessions are heavy)
 *   LIMIT                  (default 0 = all matching)
 *   OFFSET                 (default 0)
 *   SCOPE                  paid | owned | all  (default paid)
 *   DRY_RUN                1 = capture+report, no write
 *   ONLY_IDS               comma-separated brand profile UUIDs
 *   FORCE                  1 = re-capture even if already brandVisual/3
 *
 * Usage:
 *   node scripts/backfill-brand-visual.mjs --scope=paid
 *   node scripts/backfill-brand-visual.mjs --scope=owned --limit=10
 *   DRY_RUN=1 node scripts/backfill-brand-visual.mjs --only=aabf9273-...
 */
import { captureBrandVisual, buildBrandVisualPayload, BRAND_VISUAL_SCRAPE_VERSION } from '../src/server/scrape.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR || '/tmp/fi-backfill';
fs.mkdirSync(OUT_DIR, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const RELAY_URL = process.env.RELAY_URL || 'https://forgeintelligence.ai/api/admin/relay';
const ADMIN = process.env.ADMIN_RELAY_PASSWORD;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || args.concurrency || 1));
const LIMIT = Math.max(0, Number(process.env.LIMIT || args.limit || 0));
const OFFSET = Math.max(0, Number(process.env.OFFSET || args.offset || 0));
const SCOPE = String(process.env.SCOPE || args.scope || 'paid').toLowerCase();
const DRY_RUN = String(process.env.DRY_RUN || args['dry-run'] || '0') === '1';
const FORCE = String(process.env.FORCE || args.force || '0') === '1';
const ONLY_IDS = String(process.env.ONLY_IDS || args.only || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!ADMIN) {
  console.error('ADMIN_RELAY_PASSWORD required');
  process.exit(2);
}
if (!process.env.BRIGHTDATA_BROWSER_AUTH) {
  console.error('BRIGHTDATA_BROWSER_AUTH required (captureBrandVisual needs Scraping Browser)');
  process.exit(2);
}

async function relay(query, values = []) {
  const resp = await fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminPassword: ADMIN, query, values }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.success === false) {
    throw new Error(json.error || `relay HTTP ${resp.status}`);
  }
  return json;
}

function normalizeUrl(raw, override) {
  const candidate = (override && String(override).trim()) || String(raw || '').trim();
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  // bare host / vanity slug → https
  return `https://${candidate.replace(/^\/+/, '')}`;
}

function needsBackfill(row) {
  if (FORCE) return true;
  const bv = row.bv_version || row.scrape_version || '';
  if (bv === BRAND_VISUAL_SCRAPE_VERSION || bv === 'brandVisual/3') return false;
  return true;
}

async function loadCandidates() {
  if (ONLY_IDS.length) {
    const placeholders = ONLY_IDS.map((_, i) => `$${i + 1}`).join(', ');
    const q = `
      SELECT id, brand_url, brand_name, is_paid, logo_url,
             clerk_user_id IS NOT NULL AS owned,
             profile_data->>'scrapeVersion' AS scrape_version,
             profile_data->'brandVisual'->>'scrapeVersion' AS bv_version,
             settings->>'scrapeUrlOverride' AS scrape_override
      FROM brand_profiles
      WHERE id IN (${placeholders})
      ORDER BY updated_at DESC`;
    const { rows } = await relay(q, ONLY_IDS);
    return rows;
  }

  const where = ['is_active = true'];
  if (SCOPE === 'paid') where.push('is_paid = true');
  else if (SCOPE === 'owned') where.push('clerk_user_id IS NOT NULL');
  else if (SCOPE === 'all') { /* all active */ }
  else throw new Error(`unknown SCOPE=${SCOPE} (paid|owned|all)`);

  if (!FORCE) {
    where.push(`COALESCE(profile_data->'brandVisual'->>'scrapeVersion', profile_data->>'scrapeVersion', '') <> 'brandVisual/3'`);
  }

  const lim = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';
  const off = OFFSET > 0 ? `OFFSET ${OFFSET}` : '';
  const q = `
    SELECT id, brand_url, brand_name, is_paid, logo_url,
           clerk_user_id IS NOT NULL AS owned,
           profile_data->>'scrapeVersion' AS scrape_version,
           profile_data->'brandVisual'->>'scrapeVersion' AS bv_version,
           settings->>'scrapeUrlOverride' AS scrape_override
    FROM brand_profiles
    WHERE ${where.join(' AND ')}
    ORDER BY is_paid DESC NULLS LAST, updated_at DESC
    ${lim} ${off}`;
  const { rows } = await relay(q);
  return rows;
}

/**
 * Surgical JSONB patch — only brandVisual + scrapeVersion + optional accent.
 * Preserves the rest of profile_data (no context-hub rewrite).
 */
async function patchProfile(id, payload, { accentColor = null, logoUrl = null } = {}) {
  // jsonb_set path for brandVisual; stamp scrapeVersion at profile root too.
  // voiceProfile.accentColor only when we measured one (match context-hub inject).
  const q = `
    UPDATE brand_profiles SET
      profile_data = (
        jsonb_set(
          jsonb_set(
            CASE
              WHEN $3::text IS NOT NULL AND (profile_data->'voiceProfile') IS NOT NULL
                THEN jsonb_set(profile_data, '{voiceProfile,accentColor}', to_jsonb($3::text), true)
              WHEN $3::text IS NOT NULL
                THEN jsonb_set(profile_data, '{voiceProfile}', jsonb_build_object('accentColor', $3::text), true)
              ELSE profile_data
            END,
            '{brandVisual}',
            $2::jsonb,
            true
          ),
          '{scrapeVersion}',
          to_jsonb($4::text),
          true
        )
      ),
      logo_url = COALESCE(NULLIF($5::text, ''), logo_url),
      updated_at = NOW()
    WHERE id = $1
    RETURNING id, brand_name,
      profile_data->'brandVisual'->>'scrapeVersion' AS bv_version,
      profile_data->'brandVisual'->>'accentColor' AS accent,
      jsonb_array_length(COALESCE(profile_data->'brandVisual'->'fonts', '[]'::jsonb)) AS font_count,
      jsonb_array_length(COALESCE(profile_data->'brandVisual'->'palette', '[]'::jsonb)) AS palette_count
  `;
  return relay(q, [
    id,
    JSON.stringify(payload),
    accentColor,
    payload.scrapeVersion || BRAND_VISUAL_SCRAPE_VERSION,
    logoUrl || null,
  ]);
}

function summarizeCapture(cap, payload) {
  return {
    success: !!cap?.success,
    error: cap?.error || null,
    latencyMs: cap?.latencyMs || null,
    accent: payload?.accentColor || null,
    bg: payload?.bgColor || null,
    logo: payload?.logoUrl || null,
    palette: payload?.palette?.length || 0,
    fonts: payload?.fonts?.length || 0,
    type: payload?.typography?.headingFont || payload?.typography?.bodyFont || null,
    version: payload?.scrapeVersion || null,
  };
}

async function processOne(row, stats) {
  const label = `${row.brand_name || '?'} (${row.id.slice(0, 8)})`;
  if (!needsBackfill(row)) {
    stats.skipped += 1;
    console.log(`skip already-v3 ${label}`);
    return;
  }
  const url = normalizeUrl(row.brand_url, row.scrape_override);
  if (!url) {
    stats.failed += 1;
    stats.errors.push({ id: row.id, error: 'no url' });
    console.error(`fail no-url ${label}`);
    return;
  }

  const t0 = Date.now();
  console.log(`capture ${label} ← ${url}${row.scrape_override ? ' [override]' : ''}`);
  let cap;
  try {
    cap = await captureBrandVisual(url, {
      caller: 'backfill-brand-visual',
      timeout: 45000,
      metadata: { brandProfileId: row.id, brandUrl: row.brand_url, scope: SCOPE },
    });
  } catch (e) {
    stats.failed += 1;
    stats.errors.push({ id: row.id, brand: row.brand_name, url, error: e.message });
    console.error(`fail capture ${label}: ${e.message}`);
    return;
  }

  const payload = buildBrandVisualPayload(cap);
  const sum = summarizeCapture(cap, payload);
  sum.id = row.id;
  sum.brand = row.brand_name;
  sum.url = url;
  sum.ms = Date.now() - t0;
  stats.results.push(sum);

  if (!cap?.success || !payload) {
    stats.failed += 1;
    stats.errors.push({ id: row.id, brand: row.brand_name, url, error: cap?.error || 'empty payload' });
    console.error(`fail empty ${label}: ${cap?.error || 'no payload'} (${sum.ms}ms)`);
    return;
  }

  // Require at least one useful visual signal before writing
  const useful =
    payload.accentColor ||
    payload.logoUrl ||
    payload.palette?.length ||
    payload.typography ||
    payload.fonts?.length ||
    payload.logo;
  if (!useful) {
    stats.failed += 1;
    stats.errors.push({ id: row.id, brand: row.brand_name, url, error: 'no visual signals' });
    console.error(`fail no-signals ${label} (${sum.ms}ms)`);
    return;
  }

  if (DRY_RUN) {
    stats.dry += 1;
    console.log(
      `dry-ok ${label} accent=${sum.accent || '—'} fonts=${sum.fonts} palette=${sum.palette} type=${sum.type || '—'} (${sum.ms}ms)`
    );
    return;
  }

  try {
    const logoForCol =
      payload.logoUrl && /^https?:\/\//i.test(payload.logoUrl) ? payload.logoUrl : null;
    const { rows } = await patchProfile(row.id, payload, {
      accentColor: payload.accentColor || null,
      logoUrl: logoForCol,
    });
    const wrote = rows?.[0];
    stats.updated += 1;
    console.log(
      `ok ${label} bv=${wrote?.bv_version} accent=${wrote?.accent || sum.accent || '—'} fonts=${wrote?.font_count ?? sum.fonts} palette=${wrote?.palette_count ?? sum.palette} (${sum.ms}ms)`
    );
  } catch (e) {
    stats.failed += 1;
    stats.errors.push({ id: row.id, brand: row.brand_name, url, error: `write: ${e.message}` });
    console.error(`fail write ${label}: ${e.message}`);
  }
}

async function poolMap(items, concurrency, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(
    JSON.stringify(
      {
        scope: SCOPE,
        dryRun: DRY_RUN,
        force: FORCE,
        concurrency: CONCURRENCY,
        limit: LIMIT || null,
        offset: OFFSET || null,
        only: ONLY_IDS.length || null,
        relay: RELAY_URL,
        version: BRAND_VISUAL_SCRAPE_VERSION,
      },
      null,
      2
    )
  );

  const candidates = await loadCandidates();
  console.log(`candidates=${candidates.length}`);
  if (!candidates.length) {
    console.log('nothing to do');
    return;
  }

  const stats = {
    total: candidates.length,
    updated: 0,
    dry: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    results: [],
    startedAt: new Date().toISOString(),
  };

  await poolMap(candidates, CONCURRENCY, (row) => processOne(row, stats));

  stats.finishedAt = new Date().toISOString();
  const outPath = path.join(OUT_DIR, `brand-visual-backfill-${SCOPE}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
  console.log(
    `\nDONE updated=${stats.updated} dry=${stats.dry} skipped=${stats.skipped} failed=${stats.failed} → ${outPath}`
  );
  if (stats.failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
