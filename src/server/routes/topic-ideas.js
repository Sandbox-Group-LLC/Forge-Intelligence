// Topic Ideas routes, extracted from server.js during the route-group phase.
// Mounted at /api/topic-ideas with requireAuth at the mount in server.js (all 5
// routes are authed). Simple CRUD on the topic_ideas store — only dependency is
// the shared pool. Pure move: bodies verbatim, only registration lines changed
// (app.METHOD('/api/topic-ideas/x', requireAuth, …) -> router.METHOD('/x', …)).
import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.get('/:brandProfileId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM topic_ideas WHERE brand_profile_id = $1 ORDER BY created_at DESC`,
      [req.params.brandProfileId]
    );
    res.json({ success: true, ideas: r.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/topic-ideas
router.post('/', async (req, res) => {
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
router.post('/bulk', async (req, res) => {
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
router.patch('/:id', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM topic_ideas WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

export default router;
