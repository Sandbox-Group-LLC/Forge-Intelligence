// Video Generator routes. Mounted at /api/video with requireAuth at the mount.
// Async by design: /generate acks immediately with a job id, then runs the
// storyboard -> TTS -> Lambda-render pipeline in the background (a render is
// ~60s and must never block the request). /:id polls status; while a render is
// in flight it queries getRenderProgress and finalizes the row on completion.
import express from 'express';
import { pool } from '../db.js';
import { verifyBrandAccess } from '../auth.js';
import {
  videoConfigured, buildBrand, brandContextFor, storyboardFromBrief,
  resolveDirection, presignMusicBed, synthesizeScenes, normalizeTargetSeconds,
  renderReel, getReelProgress, VOICES, MUSIC_BEDS, THEMES, LENGTH_BUDGETS,
} from '../video.js';

async function ensureVideosTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS generated_videos (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    brand_profile_id TEXT NOT NULL,
    brief TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    scenes JSONB,
    render_id TEXT,
    bucket_name TEXT,
    output_url TEXT,
    error TEXT,
    orientation TEXT DEFAULT 'landscape',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  // CREATE IF NOT EXISTS won't add columns to a pre-existing table — backfill.
  await pool.query(`ALTER TABLE generated_videos ADD COLUMN IF NOT EXISTS orientation TEXT DEFAULT 'landscape'`);
  await pool.query(`ALTER TABLE generated_videos ADD COLUMN IF NOT EXISTS direction JSONB`);
}
ensureVideosTable().catch(e => console.error('[VIDEO] table init failed:', e.message));

async function setStatus(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE generated_videos SET ${sets}, updated_at = NOW() WHERE id = $1`,
    [id, ...keys.map(k => fields[k])]
  );
}

// Background pipeline — not awaited by the request.
async function runJob(id, brief, brand, orientation, brandContext, directionOverrides, targetSeconds, siteUrl) {
  try {
    await setStatus(id, { status: 'storyboarding' });
    const { scenes: draft, direction: agentPick } = await storyboardFromBrief({ brief, brandName: brand.name, brandContext, targetSeconds });

    // Agent proposes the creative direction from the brand brain; user
    // overrides win; unknown ids fall back to safe defaults.
    const direction = resolveDirection(agentPick, directionOverrides);
    await setStatus(id, { status: 'voicing', scenes: JSON.stringify(draft), direction: JSON.stringify(direction) });
    // siteUrl lets synthesizeScenes capture real product screenshots for any
    // "screens" scenes (gated by VIDEO_SCREENS_ENABLED).
    const scenes = await synthesizeScenes(draft, id, direction, { siteUrl, orientation });

    const musicSrc = direction.musicBed === 'none' ? null : await presignMusicBed(direction.musicBed);
    await setStatus(id, { status: 'rendering', scenes: JSON.stringify(scenes) });
    const { renderId, bucketName } = await renderReel({
      brand, scenes, orientation,
      music: musicSrc ? { src: musicSrc } : null,
      theme: direction.theme,
    });
    await setStatus(id, { render_id: renderId, bucket_name: bucketName });
  } catch (e) {
    console.error('[VIDEO] job failed:', id, e.message);
    await setStatus(id, { status: 'error', error: e.message }).catch(() => {});
  }
}

const router = express.Router();

// POST /api/video/generate { brandProfileId, brief }
router.post('/generate', async (req, res) => {
  try {
    const { brandProfileId, brief } = req.body || {};
    const orientation = req.body?.orientation === 'portrait' ? 'portrait' : 'landscape';
    if (!brandProfileId || !brief) return res.status(400).json({ error: 'brandProfileId and brief are required' });
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    if (!videoConfigured()) return res.status(503).json({ error: 'Video rendering is not configured (REMOTION_* env vars missing)' });

    const r = await pool.query(
      `SELECT brand_name, profile_data, logo_url, brand_url FROM brand_profiles WHERE id = $1`, [brandProfileId]
    );
    const row = r.rows[0] || {};
    const brand = buildBrand(row.brand_name || 'Forge Intelligence', row.profile_data, row.logo_url);
    const brandContext = brandContextFor(row.profile_data);
    // UI pickers: { voice, musicBed } with 'auto' (or absence) = brain decides.
    const directionOverrides = {
      voice: typeof req.body?.voice === 'string' ? req.body.voice : 'auto',
      musicBed: typeof req.body?.musicBed === 'string' ? req.body.musicBed : 'auto',
      theme: typeof req.body?.theme === 'string' ? req.body.theme : 'auto',
    };
    const targetSeconds = normalizeTargetSeconds(req.body?.targetSeconds);

    const ins = await pool.query(
      `INSERT INTO generated_videos (brand_profile_id, brief, status, orientation) VALUES ($1, $2, 'queued', $3) RETURNING id`,
      [brandProfileId, brief, orientation]
    );
    const id = ins.rows[0].id;
    runJob(id, brief, brand, orientation, brandContext, directionOverrides, targetSeconds, row.brand_url); // fire-and-forget
    res.status(202).json({ id, status: 'queued' });
  } catch (e) {
    console.error('[VIDEO] generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/video/options — the curated creative-direction vocabulary for the
// UI pickers. MUST be registered before /:id or the param route captures it.
router.get('/options', (_req, res) => {
  res.json({
    voices: Object.entries(VOICES).map(([id, v]) => ({ id, desc: v.desc })),
    musicBeds: Object.entries(MUSIC_BEDS).map(([id, b]) => ({ id, desc: b.desc })),
    themes: Object.entries(THEMES).map(([id, t]) => ({ id, desc: t.desc })),
    lengths: Object.keys(LENGTH_BUDGETS).map(Number),
  });
});

// GET /api/video/:id — poll. Advances a 'rendering' job via getRenderProgress.
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM generated_videos WHERE id = $1`, [req.params.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!(await verifyBrandAccess(row.brand_profile_id, req.userId))) return res.status(403).json({ error: 'Access denied' });

    let progress = null;
    if (row.status === 'rendering' && row.render_id && row.bucket_name) {
      try {
        const p = await getReelProgress(row.render_id, row.bucket_name);
        progress = p.overallProgress;
        if (p.fatalErrorEncountered) {
          await setStatus(row.id, { status: 'error', error: (p.errors?.[0]?.message || 'render failed').slice(0, 500) });
          row.status = 'error';
        } else if (p.done) {
          await setStatus(row.id, { status: 'done', output_url: p.outputFile });
          row.status = 'done';
          row.output_url = p.outputFile;
        }
      } catch (e) {
        console.error('[VIDEO] progress poll error:', e.message);
      }
    }
    res.json({
      id: row.id, status: row.status, progress,
      outputUrl: row.output_url || null, error: row.error || null,
      scenes: row.scenes || null, direction: row.direction || null,
      createdAt: row.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/video?brandProfileId= — list recent jobs for a brand.
router.get('/', async (req, res) => {
  try {
    const { brandProfileId } = req.query;
    if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const r = await pool.query(
      `SELECT id, status, output_url, error, created_at FROM generated_videos
       WHERE brand_profile_id = $1 ORDER BY created_at DESC LIMIT 25`, [brandProfileId]
    );
    res.json({ videos: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
