// Zernio core routes (/api/zernio/*), extracted during the route-group phase.
// Mounted at /api/zernio with NO mount-level auth — MIXED (GET /connect/:platform
// is the OAuth-initiation redirect, unauthed; disconnect + connect are
// requireAuth). The OAuth callbacks (/auth/zernio/callback, /integrations/zernio/
// callback) and the admin test endpoints live elsewhere (see zernio-admin.js).
import express from 'express';
import { pool } from '../db.js';
import { requireAuth, verifyBrandAccess } from '../auth.js';
import { callZernio, getOrCreateZernioProfile } from '../zernio.js';

const router = express.Router();

router.get('/connect/:platform', async (req, res) => {
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

router.post('/disconnect', requireAuth, async (req, res) => {
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

router.post('/connect', requireAuth, async (req, res) => {
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

export default router;
