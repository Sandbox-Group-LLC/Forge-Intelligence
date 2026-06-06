// Publishing channels routes (CRUD + reddit allowed-subreddits), extracted
// from server.js — part 2 of 3 for the publishing subsystem. Mounted at
// /api/publishing (shares the prefix with publishing-queue + the publish
// dispatcher). Auth stays PER-ROUTE (all 4 are requireAuth) — NOT mount-level:
// a mount-level requireAuth on a shared-prefix router would leak auth onto the
// other /api/publishing/* routes that fall through to this mount. Pure move.
import express from 'express';
import { pool } from '../db.js';
import { requireAuth, verifyBrandAccess } from '../auth.js';

const router = express.Router();

router.get('/channels/:brandProfileId', requireAuth, async (req, res) => {
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

router.post('/channels', requireAuth, async (req, res) => {
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

router.post('/channels/reddit/allowed-subreddits', requireAuth, async (req, res) => {
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

router.delete('/channels/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM publishing_channels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
