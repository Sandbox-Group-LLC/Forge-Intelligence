// ── Stage 7: Performance Dashboard — Analytics API Routes ─────────────────────
// Reads from content_analytics (written by publish_log after each publish)
// and from publishing_channels (for credential-based LinkedIn sync).
// All three routes are consumed directly by PerformanceDashboardPage.tsx.

import express from 'express';
const router = express.Router();

export default function analyticsRoutes(pool) {

  // ── POST /api/analytics/sync/:brandProfileId ──────────────────────────────
  // Pulls live LinkedIn post stats for every published post belonging to this brand
  // and upserts them into content_analytics.
  router.post('/sync/:brandProfileId', async (req, res) => {
    const { brandProfileId } = req.params;
    if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

    try {
      // Load LinkedIn credentials from publishing_channels (correct table)
      const chRes = await pool.query(
        `SELECT credentials FROM publishing_channels
         WHERE brand_profile_id = $1 AND channel = 'linkedin' AND is_active = true
         LIMIT 1`,
        [brandProfileId]
      );
      const creds = chRes.rows[0]?.credentials || {};
      const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;

      // Fetch all published LinkedIn entries from publish_log for this brand
      const logRes = await pool.query(
        `SELECT pl.content_id, pl.published_url, pl.response_data, pl.attempted_at
         FROM publish_log pl
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'linkedin' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      );

      const synced = [];
      const errors = [];

      for (const row of logRes.rows) {
        const postId = row.response_data?.postId || row.response_data?.id;
        if (!postId || !token) {
          errors.push({ contentId: row.content_id, reason: !token ? 'no_token' : 'no_post_id' });
          continue;
        }

        try {
          // LinkedIn Share Statistics API (v2)
          const statsUrl = `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(postId)}`;
          const liRes = await fetch(statsUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Restli-Protocol-Version': '2.0.0',
              'LinkedIn-Version': '202304'
            }
          });

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;

          if (liRes.ok) {
            const liData = await liRes.json();
            const stats = liData.elements?.[0]?.totalShareStatistics || {};
            impressions  = stats.impressionCount  || 0;
            clicks       = stats.clickCount       || 0;
            reactions    = stats.likeCount        || 0;
            comments     = stats.commentCount     || 0;
            reposts      = stats.shareCount       || 0;
          }
          // If the org stats endpoint 404s (personal posts), try the UGC post stats endpoint
          if (!liRes.ok || impressions === 0) {
            const ugcRes = await fetch(
              `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postId)}`,
              { headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' } }
            );
            if (ugcRes.ok) {
              const ugcData = await ugcRes.json();
              reactions = ugcData.likes?.count || 0;
              comments  = ugcData.comments?.count || 0;
            }
          }

          const ctr = impressions > 0 ? Number((clicks / impressions * 100).toFixed(2)) : 0;
          const engagementRate = impressions > 0
            ? Number(((reactions + comments + reposts + clicks) / impressions * 100).toFixed(2))
            : 0;

          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id,
                impressions, clicks, reactions, comments, reposts,
                ctr, engagement_rate, published_at, synced_at)
             VALUES ($1,$2,'linkedin',$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
             ON CONFLICT (content_id, channel)
             DO UPDATE SET
               impressions      = EXCLUDED.impressions,
               clicks           = EXCLUDED.clicks,
               reactions        = EXCLUDED.reactions,
               comments         = EXCLUDED.comments,
               reposts          = EXCLUDED.reposts,
               ctr              = EXCLUDED.ctr,
               engagement_rate  = EXCLUDED.engagement_rate,
               synced_at        = NOW()`,
            [
              brandProfileId, row.content_id, postId,
              impressions, clicks, reactions, comments, reposts,
              ctr, engagementRate, row.attempted_at
            ]
          );

          synced.push({ contentId: row.content_id, impressions, clicks, reactions, comments, reposts, ctr, engagementRate });
        } catch (e) {
          errors.push({ contentId: row.content_id, reason: e.message });
        }
      }

      res.json({ success: true, synced: synced.length, errors, data: synced });
    } catch (err) {
      console.error('[ANALYTICS-SYNC]', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // ── GET /api/analytics/dashboard/:brandProfileId ──────────────────────────
  // Aggregated totals + 30-day trend + top posts + full post list.
  // Consumed by the KPI cards, trend chart, and posts table in the UI.
  router.get('/dashboard/:brandProfileId', async (req, res) => {
    const { brandProfileId } = req.params;
    if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

    try {
      // Totals
      const totalsRes = await pool.query(
        `SELECT
           COALESCE(SUM(impressions),0)     AS total_impressions,
           COALESCE(SUM(clicks),0)          AS total_clicks,
           COALESCE(SUM(reactions),0)       AS total_reactions,
           COALESCE(SUM(comments),0)        AS total_comments,
           COALESCE(SUM(reposts),0)         AS total_reposts,
           COALESCE(AVG(ctr),0)             AS avg_ctr,
           COALESCE(AVG(engagement_rate),0) AS avg_engagement_rate,
           COUNT(*)                         AS total_posts
         FROM content_analytics
         WHERE brand_profile_id = $1`,
        [brandProfileId]
      );
      const totals = totalsRes.rows[0];

      // 30-day daily trend (impressions + engagement grouped by day)
      const trendRes = await pool.query(
        `SELECT
           DATE_TRUNC('day', COALESCE(published_at, synced_at)) AS day,
           SUM(impressions)    AS impressions,
           SUM(clicks)         AS clicks,
           SUM(reactions)      AS reactions,
           AVG(engagement_rate) AS engagement_rate
         FROM content_analytics
         WHERE brand_profile_id = $1
           AND COALESCE(published_at, synced_at) >= NOW() - INTERVAL '30 days'
         GROUP BY 1
         ORDER BY 1 ASC`,
        [brandProfileId]
      );

      // Top 5 posts by engagement rate
      const topPostsRes = await pool.query(
        `SELECT ca.content_id, ca.channel, ca.post_id, ca.impressions, ca.clicks,
                ca.reactions, ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
                ca.published_at, ca.synced_at
         FROM content_analytics ca
         WHERE ca.brand_profile_id = $1
         ORDER BY ca.engagement_rate DESC
         LIMIT 5`,
        [brandProfileId]
      );

      // All posts with titles joined from publish_log
      const allPostsRes = await pool.query(
        `SELECT ca.content_id, ca.channel, ca.post_id, ca.impressions, ca.clicks,
                ca.reactions, ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
                ca.published_at, ca.synced_at,
                pq.title
         FROM content_analytics ca
         LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
         WHERE ca.brand_profile_id = $1
         ORDER BY ca.published_at DESC NULLS LAST`,
        [brandProfileId]
      );

      res.json({
        success: true,
        data: {
          totals: {
            impressions:     Number(totals.total_impressions),
            clicks:          Number(totals.total_clicks),
            reactions:       Number(totals.total_reactions),
            comments:        Number(totals.total_comments),
            reposts:         Number(totals.total_reposts),
            avgCtr:          Number(Number(totals.avg_ctr).toFixed(2)),
            avgEngagement:   Number(Number(totals.avg_engagement_rate).toFixed(2)),
            totalPosts:      Number(totals.total_posts),
          },
          trend:    trendRes.rows,
          topPosts: topPostsRes.rows,
          posts:    allPostsRes.rows,
        }
      });
    } catch (err) {
      console.error('[ANALYTICS-DASHBOARD]', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // ── GET /api/analytics/channels/:brandProfileId ───────────────────────────
  // Returns which channels have analytics data + per-channel aggregates.
  // Used to show/hide channel tabs in the UI.
  router.get('/channels/:brandProfileId', async (req, res) => {
    const { brandProfileId } = req.params;
    if (!brandProfileId) return res.status(400).json({ error: 'brandProfileId required' });

    try {
      const result = await pool.query(
        `SELECT
           channel,
           COUNT(*)                          AS post_count,
           COALESCE(SUM(impressions),0)      AS impressions,
           COALESCE(SUM(clicks),0)           AS clicks,
           COALESCE(SUM(reactions),0)        AS reactions,
           COALESCE(AVG(engagement_rate),0)  AS avg_engagement_rate,
           MAX(synced_at)                    AS last_synced
         FROM content_analytics
         WHERE brand_profile_id = $1
         GROUP BY channel
         ORDER BY impressions DESC`,
        [brandProfileId]
      );

      res.json({
        success: true,
        channels: result.rows.map(r => ({
          channel:           r.channel,
          postCount:         Number(r.post_count),
          impressions:       Number(r.impressions),
          clicks:            Number(r.clicks),
          reactions:         Number(r.reactions),
          avgEngagementRate: Number(Number(r.avg_engagement_rate).toFixed(2)),
          lastSynced:        r.last_synced,
        }))
      });
    } catch (err) {
      console.error('[ANALYTICS-CHANNELS]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
