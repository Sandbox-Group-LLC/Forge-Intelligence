// Publishing queue routes (CRUD + lifecycle), extracted from server.js during
// the route-group phase — part 1 of 3 for the publishing subsystem (queue /
// channels / publish-dispatcher). Mounted at /api/publishing with NO mount-level
// auth — MIXED (queue/:id/title, backfill-queue, queue/:itemId PATCH are open;
// rest requireAuth). Multiple routers share the /api/publishing mount (channels
// + publish dispatcher follow in their own files). Pure move: bodies verbatim,
// only registration lines changed. NOTE: 2 dead duplicate POST backfill-queue
// registrations (unreachable in Express) were dropped here -> route count 213->211.
import express from 'express';
import { createHmac, randomBytes } from 'crypto';
import { pool } from '../db.js';
import { requireAuth, verifyBrandAccess } from '../auth.js';
import { buildXOAuthHeader } from '../x.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const router = express.Router();

router.get('/sync/:queueItemId', requireAuth, async (req, res) => {
  const { queueItemId } = req.params;
  try {
    // Only process the most recent log entry per channel — older entries are historical
    const logRes = await pool.query(
      `SELECT DISTINCT ON (pl.channel) pl.*, pc.credentials
       FROM publish_log pl
       LEFT JOIN publishing_channels pc ON pc.brand_profile_id = pl.brand_profile_id AND pc.channel = pl.channel
       WHERE pl.queue_item_id = $1
       ORDER BY pl.channel, pl.attempted_at DESC`,
      [queueItemId]
    );
    if (!logRes.rows.length) return res.json({ success: true, results: {} });

    const results = {};
    for (const row of logRes.rows) {
      let liveStatus = row.live_status || 'published';
      const creds = row.credentials || {};

      // If we already know it's deleted (set by unpublish endpoint), don't re-check
      if (liveStatus === 'deleted') {
        await pool.query(
          'UPDATE publish_log SET last_synced_at = NOW(), synced_count = synced_count + 1 WHERE id = $1',
          [row.id]
        );
        results[row.channel] = { channel: row.channel, liveStatus: 'deleted' };
        continue;
      }

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
          // Check X tweet status via v2 API — OAuth 2.0 preferred, 1.0a fallback
          const tweetId = row.response_data?.tweetId || row.response_data?.id;
          let xAuth = '';
          if (creds.oauth2AccessToken) {
            xAuth = `Bearer ${creds.oauth2AccessToken}`;
          } else {
            const xApiKey    = creds.apiKey    || process.env.X_OAUTH1CONSUMER_KEY;
            const xApiSecret = creds.apiSecret || process.env.X_OAUTH1CONSUMER_SECRET;
            const xAccessToken  = creds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
            const xAccessSecret = creds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
            if (xApiKey && xAccessToken) {
              const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;
              xAuth = buildXOAuthHeader('GET', endpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret);
            }
          }

          if (tweetId && xAuth) {
            const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;

            const xRes = await fetch(endpoint, { headers: { 'Authorization': xAuth } });
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
        } else if (row.channel === 'facebook') {
          // Facebook Graph API — check post still exists
          const { pageAccessToken } = creds;
          const postId = row.response_data?.postId;
          if (postId && pageAccessToken) {
            const fbCheck = await fetch(
              `https://graph.facebook.com/v21.0/${postId}?fields=id&access_token=${pageAccessToken}`
            );
            if (fbCheck.status === 404) liveStatus = 'deleted';
            else if (fbCheck.ok) liveStatus = 'published';
          }
        } else if (row.channel === 'reddit') {
          // Reddit link posts — no lightweight status endpoint without heavy OAuth; preserve existing status
          liveStatus = row.live_status || 'published';
        } else if (row.channel === 'medium') {
          // Medium posts don't have a status API — once published they stay published
          liveStatus = row.live_status || 'published';
        } else if (row.channel === 'ghost') {
          // Check Ghost post still exists via Admin API
          const { adminUrl, adminApiKey } = creds;
          const postId = row.response_data?.postId;
          if (postId && adminUrl && adminApiKey) {
            try {
              const [keyId, keySecret] = adminApiKey.split(':');
              const now = Math.floor(Date.now() / 1000);
              const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
              const p = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
              const { createHmac } = await import('node:crypto');
              const sig = createHmac('sha256', Buffer.from(keySecret, 'hex')).update(`${h}.${p}`).digest('base64url');
              const jwt = `${h}.${p}.${sig}`;
              const chkRes = await fetch(`${adminUrl.replace(/\/+$/, '')}/ghost/api/admin/posts/${postId}/`, {
                headers: { 'Authorization': `Ghost ${jwt}`, 'Accept-Version': 'v5.0' }
              });
              if (chkRes.status === 404) liveStatus = 'deleted';
              else if (chkRes.ok) {
                const chkData = await chkRes.json();
                liveStatus = chkData.posts?.[0]?.status === 'published' ? 'published' : 'unpublished';
              }
            } catch { liveStatus = row.live_status || 'published'; }
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

router.post('/republish', requireAuth, async (req, res) => {
  const { queueItemId, channel } = req.body;
  if (!queueItemId || !channel) return res.status(400).json({ error: 'queueItemId and channel required' });
  try {
    const queueRes = await pool.query('SELECT * FROM publishing_queue WHERE id = $1', [queueItemId]);
    if (!queueRes.rows.length) return res.status(404).json({ error: 'Queue item not found' });

    // Mark any previous log entry for this channel as 'republishing'. We
    // ALSO have to roll this back if the inner publish call fails — otherwise
    // the row stays in 'republishing' forever and the UI thinks the operation
    // is still in flight (Brian hit this after a disconnect/reconnect when
    // the server-to-server publish call was 401'ing).
    await pool.query(
      "UPDATE publish_log SET live_status = 'republishing' WHERE queue_item_id = $1 AND channel = $2",
      [queueItemId, channel]
    );

    // Forward to main publish route. The publish handler accepts EITHER a
    // Clerk bearer token OR an adminPassword for cron-style server-to-server
    // calls. We're already past requireAuth on the outer republish call so
    // the user is verified — using adminPassword here is the right shape for
    // the server-to-server hop. Without it the fetch lands on the 401 path
    // and the publish never runs.
    const publishRes = await fetch(`${process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}/api/publishing/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queueItemId,
        channels: [channel],
        adminPassword: process.env.ADMIN_RELAY_PASSWORD,
      })
    });
    const publishData = await publishRes.json();

    if (publishRes.ok && publishData.success) {
      return res.json({ success: true, result: publishData.results?.[channel] });
    }

    // Inner publish failed — unstick the 'republishing' state so the queue
    // card doesn't show "republishing…" forever. Reset to NULL (the canonical
    // "no live status known" value, same as a fresh log row).
    await pool.query(
      "UPDATE publish_log SET live_status = NULL WHERE queue_item_id = $1 AND channel = $2 AND live_status = 'republishing'",
      [queueItemId, channel]
    ).catch(() => {});

    const errMsg = publishData?.error || `Republish failed (HTTP ${publishRes.status})`;
    console.error(`[REPUBLISH] queueItemId=${queueItemId} channel=${channel} status=${publishRes.status} error=${errMsg}`);
    return res.status(500).json({ error: errMsg });
  } catch (err) {
    // Catch-path: also unstick the row if the fetch itself threw.
    await pool.query(
      "UPDATE publish_log SET live_status = NULL WHERE queue_item_id = $1 AND channel = $2 AND live_status = 'republishing'",
      [queueItemId, channel]
    ).catch(() => {});
    console.error('[REPUBLISH]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/log/:queueItemId', requireAuth, async (req, res) => {
  try {
    const logRes = await pool.query(
      `SELECT DISTINCT ON (channel) id, channel, status, live_status, published_url, error_message, attempted_at, last_synced_at
       FROM publish_log WHERE queue_item_id = $1
       ORDER BY channel, attempted_at DESC`,
      [req.params.queueItemId]
    );
    res.json({ success: true, log: logRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/queue/:id/title', async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  try {
    await pool.query(
      `UPDATE publishing_queue SET title = $1, updated_at = NOW() WHERE id = $2`,
      [title.trim(), req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/queue/:id/archive', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE publishing_queue SET status = 'archived', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/queue/:id/unarchive', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE publishing_queue SET status = 'staged', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/queue/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    // Base queue items
    const result = await pool.query(
      `SELECT pq.*,
              c.name        AS campaign_name,
              c.topic_cluster AS campaign_topic,
              c.status      AS campaign_status,
              bp.brand_url  AS brand_url,
              bp.brand_name AS brand_name
       FROM publishing_queue pq
       LEFT JOIN campaigns c ON c.id = pq.campaign_id
       LEFT JOIN brand_profiles bp ON bp.id = pq.brand_profile_id
       WHERE pq.brand_profile_id = $1
       ORDER BY pq.campaign_id NULLS LAST, pq.created_at DESC`,
      [brandProfileId]
    );

    const items = result.rows;

    // For campaign articles, enrich with week/publish_day/angle from generated_content + campaign_articles
    const safeId = brandProfileId.replace(/-/g, '_');
    const campaignItemIds = items
      .filter(i => i.campaign_id && i.content_id)
      .map(i => i.content_id);

    let angleMap = {};
    if (campaignItemIds.length > 0) {
      // Get campaign_article_index from generated_content
      const gcRes = await pool.query(
        `SELECT id::text, campaign_article_index FROM generated_content_${safeId}
         WHERE id::text = ANY($1) AND campaign_article_index IS NOT NULL`,
        [campaignItemIds]
      ).catch(() => ({ rows: [] }));

      // Build a map of content_id -> article_index
      const indexMap = {};
      for (const row of gcRes.rows) indexMap[row.id] = row.campaign_article_index;

      // For each campaign, get angle_profiles from campaign_articles
      const campaignIds = [...new Set(items.filter(i => i.campaign_id).map(i => i.campaign_id))];
      for (const campId of campaignIds) {
        const caRes = await pool.query(
          `SELECT article_index, angle_profile, week_number FROM campaign_articles WHERE campaign_id = $1`,
          [campId]
        ).catch(() => ({ rows: [] }));
        for (const ca of caRes.rows) {
          angleMap[`${campId}:${ca.article_index}`] = {
            week_number: ca.week_number,
            angle: ca.angle_profile
          };
        }
      }

      // Attach angle data to each item
      for (const item of items) {
        if (item.campaign_id && item.content_id) {
          const idx = indexMap[item.content_id];
          if (idx !== undefined) {
            const key = `${item.campaign_id}:${idx}`;
            const meta = angleMap[key];
            if (meta) {
              item.campaign_article_index = idx;
              item.week_number = meta.week_number;
              item.publish_day = meta.angle?.publish_day || null;
              item.content_type = meta.angle?.content_type || null;
              item.funnel_position = meta.angle?.funnel_position || null;
              item.primary_persona = meta.angle?.primary_persona || null;
            }
          }
        }
      }
    }

    // Fetch Pre-cog scores for all items
    const contentIds = items.filter(i => i.content_id).map(i => i.content_id);
    if (contentIds.length > 0) {
      const precogRes = await pool.query(
        `SELECT id::text, precog_score FROM generated_content_${safeId} WHERE id::text = ANY($1)`,
        [contentIds]
      ).catch(() => ({ rows: [] }));
      const precogMap = {};
      for (const row of precogRes.rows) precogMap[row.id] = row.precog_score;
      for (const item of items) {
        if (item.content_id && precogMap[item.content_id] !== undefined) {
          item.precog_score = precogMap[item.content_id];
        }
      }
    }

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/backfill-queue', async (req, res) => {
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

router.get('/queue', requireAuth, async (req, res) => {
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

router.patch('/queue/:itemId', async (req, res) => {
  const { itemId } = req.params;
  const { channels, scheduledAt, status, publishResults } = req.body;
  try {
    const fields = [];
    const vals = [];
    let i = 1;
    if (channels !== undefined) { fields.push(`channels = $${i++}`); vals.push(JSON.stringify(channels)); }
    if (scheduledAt !== undefined) { fields.push(`scheduled_at = $${i++}`); vals.push(scheduledAt || null); }
    if (status !== undefined) { fields.push(`status = $${i++}`); vals.push(status); }
    if (publishResults !== undefined) {
      // Merge into existing publish_results, not overwrite
      fields.push(`publish_results = COALESCE(publish_results, '{}'::jsonb) || $${i++}::jsonb`);
      vals.push(JSON.stringify(publishResults));
    }
    fields.push(`updated_at = NOW()`);
    vals.push(itemId);
    await pool.query(`UPDATE publishing_queue SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/queue/:itemId', requireAuth, async (req, res) => {
  const { itemId } = req.params;
  try {
    await pool.query('DELETE FROM publishing_queue WHERE id = $1', [itemId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/queue/:id/reset-channel', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  try {
    // Remove this channel from publish_results so the card goes back to staged
    const row = await pool.query('SELECT publish_results, brand_profile_id FROM publishing_queue WHERE id = $1', [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Not found' });
    const results = row.rows[0].publish_results || {};
    delete results[channel];
    // If no channels left, reset status to staged
    const hasAnyPublished = Object.values(results).some((r) => r && r.status === 'published');
    const newStatus = hasAnyPublished ? 'partial' : 'staged';
    await pool.query(
      'UPDATE publishing_queue SET publish_results = $1, status = $2, updated_at = NOW() WHERE id = $3',
      [JSON.stringify(results), newStatus, id]
    );
    // Clear from publish_log — single shared table
    await pool.query(
      'DELETE FROM publish_log WHERE queue_item_id = $1 AND channel = $2',
      [id, channel]
    ).catch(() => {});
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/unpublish', requireAuth, async (req, res) => {
  const { queueItemId, channel, deleteFromChannel = true, removeFromQueue = false } = req.body;
  if (!queueItemId || !channel) return res.status(400).json({ error: 'queueItemId and channel required' });

  try {
    // Load publish log entry for this channel
    const logRes = await pool.query(
      'SELECT pl.*, pc.credentials FROM publish_log pl LEFT JOIN publishing_channels pc ON pc.brand_profile_id = pl.brand_profile_id AND pc.channel = pl.channel WHERE pl.queue_item_id = $1 AND pl.channel = $2 ORDER BY pl.attempted_at DESC LIMIT 1',
      [queueItemId, channel]
    );
    if (!logRes.rows.length) return res.status(404).json({ error: 'No publish log entry found for this channel' });
    const row = logRes.rows[0];
    const creds = row.credentials || {};
    let channelResult = { deleted: false, message: 'Not attempted' };

    if (deleteFromChannel) {
      try {
        if (channel === 'linkedin') {
          const postId = row.response_data?.postId || row.published_url?.split('/').pop();
          const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
          if (!postId || !token) throw new Error('Missing LinkedIn post ID or token');
          const encodedId = encodeURIComponent(postId);
          const delRes = await fetch(`https://api.linkedin.com/v2/ugcPosts/${encodedId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' }
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`LinkedIn delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from LinkedIn' };

        } else if (channel === 'x') {
          const tweetId = row.response_data?.tweetId
            || (row.published_url?.match(/\/status\/(\d+)/)?.[1]);
          const { accessToken, accessSecret } = creds;
          const apiKey    = creds.apiKey    || process.env.X_OAUTH1CONSUMER_KEY;
          const apiSecret = creds.apiSecret || process.env.X_OAUTH1CONSUMER_SECRET;
          if (!tweetId) throw new Error('No tweet ID found');
          if (!apiKey || !apiSecret || !accessToken || !accessSecret) throw new Error('Missing X credentials');

          // OAuth 1.0a signature for DELETE
          const tweetUrl = `https://api.twitter.com/2/tweets/${tweetId}`;
          const authHeader = buildXOAuthHeader('DELETE', tweetUrl, apiKey, apiSecret, accessToken, accessSecret);

          const xDelRes = await fetch(tweetUrl, {
            method: 'DELETE',
            headers: { 'Authorization': authHeader }
          });
          if (!xDelRes.ok && xDelRes.status !== 404) throw new Error(`X delete failed: ${xDelRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from X' };

        } else if (channel === 'ghost') {
          const postId = row.response_data?.postId;
          const { adminUrl, adminApiKey } = creds;
          if (!postId || !adminUrl || !adminApiKey) throw new Error('Missing Ghost post ID or credentials');
          const [keyId, keySecret] = adminApiKey.split(':');
          const now = Math.floor(Date.now() / 1000);
          const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
          const p = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
          const sig = createHmac('sha256', Buffer.from(keySecret, 'hex')).update(`${h}.${p}`).digest('base64url');
          const jwt = `${h}.${p}.${sig}`;
          const ghostBase = adminUrl.replace(/\/+$/, '');
          const delRes = await fetch(`${ghostBase}/ghost/api/admin/posts/${postId}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Ghost ${jwt}`, 'Accept-Version': 'v5.0' }
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`Ghost delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from Ghost' };

        } else if (channel === 'wordpress') {
          const postId = row.response_data?.postId;
          const { siteUrl, username, appPassword } = creds;
          if (!postId || !siteUrl) throw new Error('Missing WordPress post ID or credentials');
          const wpUrl = siteUrl.replace(/\/+$/, '');
          const basicAuth = Buffer.from(`${username}:${appPassword}`).toString('base64');
          const delRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${postId}?force=true`, {
            method: 'DELETE',
            headers: { 'Authorization': `Basic ${basicAuth}` }
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`WordPress delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from WordPress' };

        } else if (channel === 'facebook') {
          const postId = row.response_data?.postId;
          const { pageAccessToken } = creds;
          if (!postId || !pageAccessToken) throw new Error('Missing Facebook post ID or token');
          const delRes = await fetch(`https://graph.facebook.com/v21.0/${postId}?access_token=${pageAccessToken}`, {
            method: 'DELETE'
          });
          if (!delRes.ok && delRes.status !== 404) throw new Error(`Facebook delete failed: ${delRes.status}`);
          channelResult = { deleted: true, message: 'Deleted from Facebook' };

        } else {
          channelResult = { deleted: false, message: `Channel ${channel} does not support remote delete` };
        }
      } catch (delErr) {
        channelResult = { deleted: false, message: delErr.message };
      }
    }

    // Update publish_log status — if user explicitly requested delete, mark deleted
    // regardless of whether the API call succeeded (expired token etc.)
    // This prevents sync from seeing 'published' and re-checking a post we've intentionally removed
    const finalStatus = deleteFromChannel ? 'deleted' : (channelResult.deleted ? 'deleted' : 'published');
    await pool.query(
      `UPDATE publish_log SET live_status = $1, last_synced_at = NOW()
       WHERE id = (
         SELECT id FROM publish_log
         WHERE queue_item_id = $2 AND channel = $3
         ORDER BY attempted_at DESC LIMIT 1
       )`,
      [finalStatus, queueItemId, channel]
    );

    // Also remove the channel from publishing_queue.publish_results JSONB.
    // The PUBLISHED TO panel in the UI iterates over publish_results, so
    // until this entry is cleared the unpublished channel keeps showing up
    // (with whatever live_status the most recent log row has — including
    // 'published' if a republish followed the unpublish). The reset-channel
    // endpoint at server.js:9806 does this same write; mirroring here.
    if (deleteFromChannel) {
      const qrRow = await pool.query(
        'SELECT publish_results FROM publishing_queue WHERE id = $1',
        [queueItemId]
      ).catch(() => ({ rows: [] }));
      if (qrRow.rows.length) {
        const updatedResults = qrRow.rows[0].publish_results || {};
        delete updatedResults[channel];
        await pool.query(
          'UPDATE publishing_queue SET publish_results = $1 WHERE id = $2',
          [JSON.stringify(updatedResults), queueItemId]
        ).catch(() => {});
      }
    }

    // Recompute queue status from remaining live publish_log entries
    // Don't blindly set 'staged' — if other channels are still live, it's 'partial'
    const remainingLog = await pool.query(
      `SELECT live_status FROM publish_log WHERE queue_item_id = $1 AND (live_status IS NULL OR live_status != 'deleted')`,
      [queueItemId]
    ).catch(() => ({ rows: [] }));
    const anyStillLive = remainingLog.rows.some(r => !r.live_status || r.live_status === 'published');
    const recomputedStatus = anyStillLive ? 'partial' : 'staged';
    await pool.query(
      `UPDATE publishing_queue SET status = $1, updated_at = NOW() WHERE id = $2`,
      [recomputedStatus, queueItemId]
    ).catch(() => {});

    // If remove from queue entirely
    if (removeFromQueue) {
      await pool.query('DELETE FROM publishing_queue WHERE id = $1', [queueItemId]);
    }

    res.json({ success: true, channel, ...channelResult });
  } catch (err) {
    console.error('[UNPUBLISH]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/queue/:id/request-review', requireAuth, async (req, res) => {
  const { reviewerId } = req.body;
  try {
    const token = randomBytes(24).toString('hex');

    // Get article title for the email
    const qItem = await pool.query(
      'SELECT title, brand_profile_id FROM publishing_queue WHERE id = $1',
      [req.params.id]
    );
    const item = qItem.rows[0];

    await pool.query(
      `UPDATE publishing_queue
       SET review_token = $1, review_status = 'pending', review_requested_at = NOW(),
           reviewer_id = $3, updated_at = NOW()
       WHERE id = $2`,
      [token, req.params.id, reviewerId || null]
    );

    const reviewUrl = `https://dev.forgeintelligence.ai/review/${token}`;

    // Send email if reviewer specified
    if (reviewerId && RESEND_API_KEY) {
      const reviewer = await pool.query('SELECT * FROM reviewers WHERE id = $1', [reviewerId]);
      const r = reviewer.rows[0];
      if (r) {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'Forge-Intelligence-Server/1.0' },
          body: JSON.stringify({
            from: 'Forge Intelligence <hello@forgeintelligence.ai>',
            to: r.email,
            subject: `Review requested: ${item?.title || 'Article'}`,
            html: `
              <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: #0F172A; color: #F8FAFC; border-radius: 12px;">
                <div style="margin-bottom: 32px;">
                  <span style="font-family: Inter, sans-serif; font-size: 16px; font-weight: 800; color: #3563FF; letter-spacing: -0.02em;">⬡ Forge Intelligence</span>
                </div>
                <h1 style="font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #F8FAFC;">Review requested</h1>
                <p style="color: #94A3B8; margin-bottom: 24px;">Hi ${r.name}, you've been asked to review an article before it goes live.</p>
                <div style="background: #1E293B; border-radius: 8px; padding: 20px 24px; margin-bottom: 28px; border-left: 3px solid #3563FF;">
                  <p style="font-size: 16px; font-weight: 600; color: #F8FAFC; margin: 0;">${item?.title || 'Article for Review'}</p>
                </div>
                <a href="${reviewUrl}" style="display: inline-block; background: #3563FF; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">Review Article →</a>
                <p style="color: #475569; font-size: 12px; margin-top: 32px;">This link is unique to you and expires after your review is submitted. Powered by Forge Intelligence.</p>
              </div>
            `
          })
        });
        const emailData = await emailRes.json();
        console.log('[REVIEW EMAIL]', emailRes.status, JSON.stringify(emailData));
      }
    }

    res.json({ success: true, token, reviewUrl });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
