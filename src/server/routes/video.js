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
  renderReel, getReelProgress, videoArcs, presignShotKeys, MAX_USER_SHOTS,
  ttsHealth, pronunciationsFor, VOICES, MUSIC_BEDS, THEMES, LENGTH_BUDGETS,
  refineStoryboard, guardRefineInstruction, screensEnabled,
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
  // Refine support: storyboard = the voiceover-bearing draft (never overwritten
  // by synthesize, so a touch-up can edit it); target_seconds + screenshot_keys
  // let a refine re-render with the same length + uploads; parent_id /
  // refine_instruction record the edit lineage.
  await pool.query(`ALTER TABLE generated_videos ADD COLUMN IF NOT EXISTS storyboard JSONB`);
  await pool.query(`ALTER TABLE generated_videos ADD COLUMN IF NOT EXISTS target_seconds INTEGER DEFAULT 30`);
  await pool.query(`ALTER TABLE generated_videos ADD COLUMN IF NOT EXISTS screenshot_keys JSONB`);
  await pool.query(`ALTER TABLE generated_videos ADD COLUMN IF NOT EXISTS parent_id TEXT`);
  await pool.query(`ALTER TABLE generated_videos ADD COLUMN IF NOT EXISTS refine_instruction TEXT`);
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

// Shared back half of every job: a voiceover-bearing draft -> TTS -> Lambda
// render. Persists `storyboard` (the VO-bearing draft, kept for refine) once,
// then the synthesized (VO-stripped) scenes for the render. Used by both the
// initial generate and the refine path.
async function synthAndRender(id, brand, draft, direction, { orientation, siteUrl, uploadedShots, pronunciations }) {
  await setStatus(id, {
    status: 'voicing',
    scenes: JSON.stringify(draft),
    storyboard: JSON.stringify(draft),
    direction: JSON.stringify(direction),
  });
  // uploadedShots (user's product screenshots) are the primary source for
  // "screens" beats; siteUrl auto-capture is the fallback (gated by
  // VIDEO_SCREENS_ENABLED).
  const scenes = await synthesizeScenes(draft, id, direction, { siteUrl, orientation, uploadedShots, pronunciations });
  const musicSrc = direction.musicBed === 'none' ? null : await presignMusicBed(direction.musicBed);
  await setStatus(id, { status: 'rendering', scenes: JSON.stringify(scenes) });
  const { renderId, bucketName } = await renderReel({
    brand, scenes, orientation,
    music: musicSrc ? { src: musicSrc } : null,
    theme: direction.theme,
  });
  await setStatus(id, { render_id: renderId, bucket_name: bucketName });
}

// Background pipeline — not awaited by the request.
async function runJob(id, brief, brand, orientation, brandContext, directionOverrides, targetSeconds, siteUrl, uploadedShots, pronunciations) {
  try {
    const hasUploads = Array.isArray(uploadedShots) && uploadedShots.length > 0;
    await setStatus(id, { status: 'storyboarding' });
    const { scenes: draft, direction: agentPick } = await storyboardFromBrief({ brief, brandName: brand.name, brandContext, targetSeconds, forceScreens: hasUploads });

    // Agent proposes the creative direction from the brand brain; user
    // overrides win; unknown ids fall back to safe defaults.
    const direction = resolveDirection(agentPick, directionOverrides);
    await synthAndRender(id, brand, draft, direction, { orientation, siteUrl, uploadedShots, pronunciations });
  } catch (e) {
    console.error('[VIDEO] job failed:', id, e.message);
    await setStatus(id, { status: 'error', error: e.message }).catch(() => {});
  }
}

// Refine pipeline — edit a parent's stored storyboard with one guarded
// instruction, then re-voice + re-render. The guardrail already passed in the
// route; here the contract backstop holds: refineStoryboard can only emit a
// storyboard, validated before it ever reaches TTS/render.
async function runRefineJob(id, parentStoryboard, parentDirection, instruction, brand, orientation, brandContext, targetSeconds, siteUrl, uploadedShots, pronunciations, allowScreens) {
  try {
    await setStatus(id, { status: 'storyboarding' });
    const { scenes: draft, direction: refinedPick } = await refineStoryboard({
      storyboard: parentStoryboard, direction: parentDirection, instruction,
      brandName: brand.name, brandContext, targetSeconds, allowScreens,
    });
    const direction = resolveDirection(refinedPick, {});
    await synthAndRender(id, brand, draft, direction, { orientation, siteUrl, uploadedShots, pronunciations });
  } catch (e) {
    console.error('[VIDEO] refine job failed:', id, e.message);
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
    // Per-brand "say-it-like" dictionary (e.g. SYSOI -> Sis-Oy), merged with any
    // one-off overrides from the request. Rewrites the spoken VO only.
    const pronunciations = {
      ...(pronunciationsFor(row.profile_data) || {}),
      ...(req.body?.pronunciations && typeof req.body.pronunciations === 'object' ? req.body.pronunciations : {}),
    };
    // UI pickers: { voice, musicBed } with 'auto' (or absence) = brain decides.
    const directionOverrides = {
      voice: typeof req.body?.voice === 'string' ? req.body.voice : 'auto',
      musicBed: typeof req.body?.musicBed === 'string' ? req.body.musicBed : 'auto',
      theme: typeof req.body?.theme === 'string' ? req.body.theme : 'auto',
    };
    const targetSeconds = normalizeTargetSeconds(req.body?.targetSeconds);
    // User-uploaded product screenshots: client passes durable S3 keys from
    // /upload-shot; re-presign them fresh (scoped to this brand's prefix).
    const screenshotKeys = Array.isArray(req.body?.screenshotKeys) ? req.body.screenshotKeys.slice(0, MAX_USER_SHOTS) : [];
    const uploadedShots = await presignShotKeys(screenshotKeys, brandProfileId);

    const ins = await pool.query(
      `INSERT INTO generated_videos (brand_profile_id, brief, status, orientation, target_seconds, screenshot_keys)
       VALUES ($1, $2, 'queued', $3, $4, $5) RETURNING id`,
      [brandProfileId, brief, orientation, targetSeconds, JSON.stringify(screenshotKeys)]
    );
    const id = ins.rows[0].id;
    runJob(id, brief, brand, orientation, brandContext, directionOverrides, targetSeconds, row.brand_url, uploadedShots, pronunciations); // fire-and-forget
    res.status(202).json({ id, status: 'queued' });
  } catch (e) {
    console.error('[VIDEO] generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/video/tts-check — probe the selected TTS provider server-side and
// return the raw result (so an ElevenLabs failure on Render is visible, not
// silently swallowed by the OpenAI fallback). Before /:id.
router.get('/tts-check', async (_req, res) => {
  try {
    res.json(await ttsHealth());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/video/arcs — a slate of 8 video concepts for the brand (the "knock
// out 8 arcs" feature). Each arc is a ready-to-run brief + length + orientation.
// Registered before /:id so the param route doesn't capture it.
router.post('/arcs', async (req, res) => {
  try {
    const { brandProfileId } = req.body || {};
    if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const r = await pool.query(`SELECT brand_name, profile_data FROM brand_profiles WHERE id = $1`, [brandProfileId]);
    const row = r.rows[0] || {};
    const arcs = await videoArcs(row.brand_name || 'this brand', row.profile_data, 8);
    res.json({ arcs });
  } catch (e) {
    console.error('[VIDEO] arcs error:', e.message);
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

// POST /api/video/:id/refine { instruction } — a guarded touch-up. Edits the
// parent's stored storyboard with ONE plain-language change and renders a NEW
// video (the parent is preserved). The instruction passes a strict intent
// filter first (guardRefineInstruction) so the box can't be abused as a general
// assistant. Registered before GET /:id (different method, but keep it close).
router.post('/:id/refine', async (req, res) => {
  try {
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
    if (!instruction) return res.status(400).json({ error: 'Describe the change you want.', code: 'empty' });
    if (!videoConfigured()) return res.status(503).json({ error: 'Video rendering is not configured (REMOTION_* env vars missing)' });

    const pr = await pool.query(`SELECT * FROM generated_videos WHERE id = $1`, [req.params.id]);
    const parent = pr.rows[0];
    if (!parent) return res.status(404).json({ error: 'Not found' });
    if (!(await verifyBrandAccess(parent.brand_profile_id, req.userId))) return res.status(403).json({ error: 'Access denied' });

    const storyboard = parent.storyboard; // JSONB -> parsed array
    if (!Array.isArray(storyboard) || storyboard.length === 0) {
      return res.status(409).json({ error: 'This video can’t be refined (it predates the refine feature). Generate a new one to enable edits.', code: 'no_storyboard' });
    }

    // ── Strict guardrail — classify intent before any expensive work ──
    const verdict = await guardRefineInstruction(instruction);
    if (!verdict.allowed) {
      const msg = verdict.reason === 'too_long'
        ? 'Keep your change under 400 characters.'
        : verdict.reason === 'guard_error'
          ? 'Couldn’t check that request just now — please try again.'
          : 'I can only edit this video — its script, voice, music, style, pacing, length, or call to action. Try something like “make the hook punchier” or “use a calmer voice.”';
      return res.status(400).json({ error: msg, code: 'rejected' });
    }

    const r = await pool.query(
      `SELECT brand_name, profile_data, logo_url, brand_url FROM brand_profiles WHERE id = $1`, [parent.brand_profile_id]
    );
    const row = r.rows[0] || {};
    const brand = buildBrand(row.brand_name || 'Forge Intelligence', row.profile_data, row.logo_url);
    const brandContext = brandContextFor(row.profile_data);
    const pronunciations = pronunciationsFor(row.profile_data) || {};
    const targetSeconds = normalizeTargetSeconds(parent.target_seconds);
    // Re-presign the parent's uploaded shots (scoped to this brand's prefix) so
    // a "screens" beat re-renders with the same product images.
    const screenshotKeys = Array.isArray(parent.screenshot_keys) ? parent.screenshot_keys.slice(0, MAX_USER_SHOTS) : [];
    const uploadedShots = await presignShotKeys(screenshotKeys, parent.brand_profile_id);
    const allowScreens = screensEnabled() || uploadedShots.length > 0 || storyboard.some(s => s && s.type === 'screens');

    const ins = await pool.query(
      `INSERT INTO generated_videos (brand_profile_id, brief, status, orientation, target_seconds, screenshot_keys, parent_id, refine_instruction)
       VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7) RETURNING id`,
      [parent.brand_profile_id, parent.brief, parent.orientation, targetSeconds, JSON.stringify(screenshotKeys), parent.id, instruction]
    );
    const id = ins.rows[0].id;
    runRefineJob(id, storyboard, parent.direction, instruction, brand, parent.orientation, brandContext, targetSeconds, row.brand_url, uploadedShots, pronunciations, allowScreens); // fire-and-forget
    res.status(202).json({ id, status: 'queued' });
  } catch (e) {
    console.error('[VIDEO] refine error:', e.message);
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
      scenes: row.scenes || null, direction: row.direction || null,
      parentId: row.parent_id || null, refineInstruction: row.refine_instruction || null,
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
