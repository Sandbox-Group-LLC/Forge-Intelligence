// Video Generator routes. Mounted at /api/video with requireAuth at the mount.
// Async by design: /generate acks immediately with a job id, then runs the
// storyboard -> TTS -> Lambda-render pipeline in the background (a render is
// ~60s and must never block the request). /:id polls status; while a render is
// in flight it queries getRenderProgress and finalizes the row on completion.
import express from 'express';
import { pool } from '../db.js';
import { verifyBrandAccess } from '../auth.js';
import {
  videoConfigured, storyboardFromBrief, synthesizeScenes,
  renderReel, getReelProgress,
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
async function runJob(id, brief, brandName, orientation) {
  try {
    await setStatus(id, { status: 'storyboarding' });
    const draft = await storyboardFromBrief({ brief, brandName });

    await setStatus(id, { status: 'voicing', scenes: JSON.stringify(draft) });
    const scenes = await synthesizeScenes(draft, id);

    await setStatus(id, { status: 'rendering', scenes: JSON.stringify(scenes) });
    const { renderId, bucketName } = await renderReel({ brand: { name: brandName }, scenes, orientation });
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
      `SELECT brand_name FROM brand_profiles WHERE id = $1`, [brandProfileId]
    );
    const brandName = r.rows[0]?.brand_name || 'Forge Intelligence';

    const ins = await pool.query(
      `INSERT INTO generated_videos (brand_profile_id, brief, status, orientation) VALUES ($1, $2, 'queued', $3) RETURNING id`,
      [brandProfileId, brief, orientation]
    );
    const id = ins.rows[0].id;
    runJob(id, brief, brandName, orientation); // fire-and-forget
    res.status(202).json({ id, status: 'queued' });
  } catch (e) {
    console.error('[VIDEO] generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
      scenes: row.scenes || null, createdAt: row.created_at,
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
