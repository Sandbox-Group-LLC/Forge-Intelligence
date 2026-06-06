// Zernio admin/test routes (/api/admin/zernio/*), extracted during the
// route-group phase. Dev/strategy-only probes — every handler gates on
// zernioGuard (host + adminPassword + ZERNIO_API_KEY check). Mounted at
// /api/admin/zernio with NO mount-level auth (the guard runs inside each).
import express from 'express';
import { pool } from '../db.js';
import { zernioGuard, callZernio, getOrCreateZernioProfile, zernioPublish } from '../zernio.js';

const router = express.Router();

router.post('/profiles', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const result = await callZernio('GET', '/profiles');
    res.json({ success: true, stage: 'list-profiles', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'list-profiles', error: e.message });
  }
});

router.post('/accounts', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const result = await callZernio('GET', '/accounts');
    res.json({ success: true, stage: 'list-accounts', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'list-accounts', error: e.message });
  }
});

router.post('/post', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { adminPassword, ...postBody } = req.body;
    const result = await callZernio('POST', '/posts', postBody);
    res.json({ success: true, stage: 'create-post', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'create-post', error: e.message });
  }
});

router.post('/probe-connect', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { platform, profileId, returnUrl, ...extras } = req.body;
    const params = new URLSearchParams();
    if (profileId) params.set('profileId', profileId);
    if (returnUrl) params.set('returnUrl', returnUrl);
    // Forward any extra body keys as query params for probing
    for (const [k, v] of Object.entries(extras)) {
      if (k !== 'adminPassword' && typeof v === 'string') params.set(k, v);
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    const result = await callZernio('GET', `/connect/${platform}${qs}`);
    res.json({ success: true, stage: 'probe-connect', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'probe-connect', error: e.message });
  }
});

router.post('/connect-test', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { profileId, platform, redirectUrl, state } = req.body;
    if (!profileId || !platform) return res.status(400).json({ success: false, error: 'profileId + platform required' });

    const params = new URLSearchParams({ profileId });
    if (redirectUrl) params.set('redirectUrl', redirectUrl);
    if (state) params.set('state', state);

    const path = `/connect/${platform}?${params.toString()}`;
    const result = await callZernio('GET', path);
    res.json({ success: true, stage: 'connect-init', path, ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'connect-init', error: e.message });
  }
});

router.post('/create-profile', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const result = await callZernio('POST', '/profiles', { name, description });
    res.json({ success: true, stage: 'create-profile', ...result });
  } catch (e) {
    res.status(500).json({ success: false, stage: 'create-profile', error: e.message });
  }
});

router.post('/raw', async (req, res) => {
  if (!zernioGuard(req, res)) return;
  try {
    const { method = 'GET', path, body } = req.body;
    if (!path) return res.status(400).json({ success: false, error: 'path required' });
    const result = await callZernio(method, path, body);
    res.json({ success: true, request: { method, path, body }, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
