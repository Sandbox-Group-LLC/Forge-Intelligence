// Analytics routes, extracted from server.js during the route-group phase.
// Mounted at /api/analytics with NO mount-level auth — MIXED group
// (POST /extract-patterns/:id and POST /sync/:id are open/cron; the other 9 are
// requireAuth), so auth stays per-route. refreshGSCToken (GSC OAuth token
// refresh, analytics-only) moved in. Pure move: bodies verbatim, only
// registration lines changed (app.METHOD('/api/analytics/x', …) -> router.METHOD('/x', …)).
import express from 'express';
import { jwtVerify } from 'jose';
import { pool } from '../db.js';
import { anthropic } from '../llm.js';
import { safeParseLLM } from '../llm-json.js';
import { requireAuth, verifyBrandAccess, clerkJWKS } from '../auth.js';
import { callZernio } from '../zernio.js';
import { buildXOAuthHeader, refreshXOAuth2Token } from '../x.js';
import { buildGhostJWT } from '../ghost.js';

const router = express.Router();

router.get('/patterns/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  try {
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const [pRes, mRes] = await Promise.all([
      pool.query(
        'SELECT id, pattern_type, description, confidence_score, success_rate, tags, created_at FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC, created_at DESC',
        [brandProfileId]
      ),
      pool.query(
        'SELECT id, mistake_type, description, human_feedback, guardrail_created, severity, created_at FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC',
        [brandProfileId]
      )
    ]);
    res.json({ success: true, patterns: pRes.rows, mistakes: mRes.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/extract-patterns/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  // Allow cron/admin bypass with adminPassword, otherwise require Clerk JWT
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'], clockTolerance: '30s' });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  }
  try {
    if (!isCron && !(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
    const safeId = brandProfileId.replace(/-/g, '_');

    // Fetch analytics data
    const analyticsRes = await pool.query(
      `SELECT ca.content_id, ca.channel, ca.impressions, ca.clicks, ca.reactions,
              ca.ctr, ca.engagement_rate, ca.reading_time, ca.positive_feedback,
              ca.negative_feedback, ca.published_at,
              pq.title
       FROM content_analytics ca
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id = $1
       ORDER BY ca.impressions DESC, ca.clicks DESC`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    if (analyticsRes.rows.length === 0) {
      return res.json({ success: true, patternsWritten: 0, mistakesWritten: 0, patterns: [], mistakes: [], message: 'No analytics data to extract from' });
    }

    // Build summary for Claude
    const topPosts = analyticsRes.rows.slice(0, 10);
    const bottomPosts = analyticsRes.rows.slice(-5);
    const avgImpressions = analyticsRes.rows.reduce((a, r) => a + (r.impressions || 0), 0) / analyticsRes.rows.length;
    const avgCtr = analyticsRes.rows.reduce((a, r) => a + (r.ctr || 0), 0) / analyticsRes.rows.length;

    const prompt = `You are a content intelligence analyst. Analyze this performance data and extract actionable patterns and mistakes.

ANALYTICS SUMMARY:
- Total articles tracked: ${analyticsRes.rows.length}
- Average impressions: ${Math.round(avgImpressions)}
- Average CTR: ${avgCtr.toFixed(2)}%

TOP PERFORMING (highest impressions/engagement):
${topPosts.map(p => `- "${p.title || 'Untitled'}" | Channel: ${p.channel} | Impressions: ${p.impressions || 0} | Clicks: ${p.clicks || 0} | CTR: ${p.ctr || 0}% | Reactions: ${p.reactions || 0} | Reading time: ${p.reading_time || 0}min`).join('\n')}

UNDERPERFORMING (lowest engagement):
${bottomPosts.map(p => `- "${p.title || 'Untitled'}" | Channel: ${p.channel} | Impressions: ${p.impressions || 0} | Clicks: ${p.clicks || 0} | CTR: ${p.ctr || 0}%`).join('\n')}

Return ONLY a JSON object with this exact structure:
{
  "patterns": [
    { "pattern_type": "short label", "description": "1-2 sentence actionable insight about what's working", "confidence_score": 0.0-1.0, "tags": ["tag1"] }
  ],
  "mistakes": [
    { "mistake_type": "short label", "description": "1-2 sentence insight about what to avoid", "severity": "high|medium|low" }
  ]
}

Extract 3-6 patterns and 2-4 mistakes. Be specific and actionable. Focus on content type, topic, channel, format, timing patterns.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';
    let extracted = { patterns: [], mistakes: [] };
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      extracted = safeParseLLM(clean, 'object', 'pattern-extractor');
    } catch(e) { console.error('[EXTRACT-PATTERNS] JSON parse error:', e.message); }

    // Write patterns to brain_patterns
    let patternsWritten = 0;
    for (const p of (extracted.patterns || [])) {
      await pool.query(
        `INSERT INTO brain_patterns (brand_profile_id, pattern_type, description, confidence_score, tags)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [brandProfileId, p.pattern_type || 'general', p.description || '', p.confidence_score || 0.5, JSON.stringify(p.tags || [])]
      ).catch(() => {});
      patternsWritten++;
    }

    // Write mistakes to brain_mistakes
    let mistakesWritten = 0;
    for (const m of (extracted.mistakes || [])) {
      await pool.query(
        `INSERT INTO brain_mistakes (brand_profile_id, mistake_type, description, severity)
         VALUES ($1, $2, $3, $4)`,
        [brandProfileId, m.mistake_type || 'general', m.description || '', m.severity || 'low']
      ).catch(() => {});
      mistakesWritten++;
    }

    // Return fresh patterns and mistakes
    const [pRes, mRes] = await Promise.all([
      pool.query('SELECT * FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC', [brandProfileId]),
      pool.query('SELECT * FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC, created_at DESC', [brandProfileId])
    ]);

    res.json({ success: true, patternsWritten, mistakesWritten, patterns: pRes.rows, mistakes: mRes.rows });
  } catch(e) {
    console.error('[EXTRACT-PATTERNS]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

async function refreshGSCToken(refreshToken) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET
    })
  });
  const data = await tokenRes.json();
  if (!data.access_token) throw new Error('GSC token refresh failed');
  return data.access_token;
}

// POST /api/analytics/sync-gsc/:brandProfileId — pull GSC data for brand's domain

router.post('/sync-gsc/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  const { days = 28 } = req.body;
  try {
    // Get GSC credentials
    const credRes = await pool.query(
      'SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2 AND is_active = true LIMIT 1',
      [brandProfileId, 'gsc']
    );
    if (!credRes.rows.length) return res.status(400).json({ error: 'GSC not connected for this brand' });
    let creds = credRes.rows[0].credentials;

    // Get brand domain from brand_profiles
    const brandRes = await pool.query('SELECT brand_url, article_base_url FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const brand = brandRes.rows[0];
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Determine which GSC property to query
    const brandDomain = (brand.brand_url || brand.article_base_url || '').replace(/https?:\/\//, '').replace(/\/.*/, '').replace(/^www\./, '');
    const verifiedSites = creds.verifiedSites || [];
    const siteUrl = verifiedSites.find(s => s.includes(brandDomain))
      || verifiedSites.find(s => s.includes('sc-domain:'))
      || verifiedSites[0];

    if (!siteUrl) return res.status(400).json({ error: `No verified GSC property found for ${brandDomain}. Verify site ownership in Google Search Console first.` });

    // Refresh token if needed
    let accessToken = creds.accessToken;
    try {
      // Try a test call — if it fails, refresh
      const testRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (testRes.status === 401 && creds.refreshToken) {
        accessToken = await refreshGSCToken(creds.refreshToken);
        // Update stored token
        await pool.query(
          'UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = $3',
          [JSON.stringify({ accessToken }), brandProfileId, 'gsc']
        );
      }
    } catch(e) { console.log('[GSC] Token test error:', e.message); }

    // Date range
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    // Query GSC Search Analytics — by page, last N days
    const gscRes = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate, endDate,
          dimensions: ['page'],
          rowLimit: 500,
          dataState: 'all'
        })
      }
    );
    const gscData = await gscRes.json();
    if (gscData.error) throw new Error(gscData.error.message);

    const rows = gscData.rows || [];
    let synced = 0;

    // Match GSC pages to content_analytics by URL or publishing_queue by title slug
    for (const row of rows) {
      const pageUrl = row.keys[0];
      // Skip /app/ routes — accept all domains matching the brand's GSC property
      try {
        const u = new URL(pageUrl);
        if (u.pathname.startsWith('/app/')) continue;
      } catch { continue; }
      const clicks = Math.round(row.clicks || 0);
      const impressions = Math.round(row.impressions || 0);
      const ctr = parseFloat((row.ctr * 100).toFixed(2));
      const position = parseFloat((row.position || 0).toFixed(1));

      // Try to find matching content_id from publishing_queue by URL slug match
      const urlSlug = pageUrl.replace(/\/$/, '').split('/').pop()?.replace(/\.html$/, '') || '';
      const queueRes = await pool.query(
        `SELECT content_id FROM publishing_queue WHERE brand_profile_id = $1 AND LOWER(REPLACE(REPLACE(title, ' ', '-'), ',', '')) LIKE $2 LIMIT 1`,
        [brandProfileId, `%${urlSlug.slice(0, 20)}%`]
      ).catch(() => ({ rows: [] }));

      const contentId = queueRes.rows[0]?.content_id || `gsc_${Buffer.from(pageUrl).toString('base64').slice(0, 16)}`;

      await pool.query(
        `INSERT INTO content_analytics
          (brand_profile_id, content_id, channel, post_id, impressions, clicks, ctr, engagement_rate,
           reactions, comments, reposts, raw_data, published_at, synced_at)
         VALUES ($1,$2,'gsc',$3,$4,$5,$6,$7,0,0,0,$8,NOW(),NOW())
         ON CONFLICT (brand_profile_id, content_id, channel)
         DO UPDATE SET impressions=$4, clicks=$5, ctr=$6, engagement_rate=$7,
           raw_data=$8, synced_at=NOW()`,
        [brandProfileId, contentId, pageUrl, impressions, clicks, ctr, position,
         JSON.stringify({ pageUrl, clicks, impressions, ctr, position, startDate, endDate, siteUrl })]
      );
      synced++;
    }

    res.json({ success: true, synced, siteUrl, dateRange: { startDate, endDate }, totalRows: rows.length });
  } catch(err) {
    console.error('[GSC-SYNC]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/webflow-seo/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    // 1. Get all Webflow-published URLs
    const wfRes = await pool.query(
      `SELECT pl.content_id, pl.published_url, pl.attempted_at, pl.response_data,
              ct.title, ct.hero_image_url
       FROM publish_log pl
       LEFT JOIN generated_content_${brandProfileId.replace(/-/g, '_')} ct ON ct.id::text = pl.content_id
       WHERE pl.brand_profile_id = $1 AND pl.channel = 'webflow' AND pl.status = 'published'
       ORDER BY pl.attempted_at DESC`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // 2. Check GSC connection (before early return so empty state knows)
    const gscCred = await pool.query(
      'SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = $2 AND is_active = true LIMIT 1',
      [brandProfileId, 'gsc']
    ).catch(() => ({ rows: [] }));
    const gscConnected = gscCred.rows.length > 0;

    if (!wfRes.rows.length) {
      return res.json({ success: true, articles: [], totals: { published: 0, impressions: 0, clicks: 0, avgCtr: 0, avgPosition: 0 }, gscConnected });
    }

    // 3. Get GSC data for all pages
    const gscRes = await pool.query(
      `SELECT content_id, post_id AS page_url, impressions, clicks, ctr, engagement_rate AS position, raw_data
       FROM content_analytics
       WHERE brand_profile_id = $1 AND channel = 'gsc'`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // Build URL lookup from GSC data
    const gscByUrl = {};
    for (const row of gscRes.rows) {
      if (row.page_url) gscByUrl[row.page_url] = row;
    }

    // 4. Match Webflow articles to GSC data by URL
    const articles = wfRes.rows.map(wf => {
      const url = wf.published_url || wf.response_data?.url || '';
      // Try exact match, then slug match
      let gsc = gscByUrl[url] || gscByUrl[url.replace(/\/$/, '')] || null;
      if (!gsc && url) {
        const slug = url.replace(/\/$/, '').split('/').pop();
        gsc = Object.values(gscByUrl).find(g => g.page_url && g.page_url.includes(slug)) || null;
      }
      return {
        content_id: wf.content_id,
        title: wf.title || 'Untitled',
        hero_image_url: wf.hero_image_url || null,
        url,
        published_at: wf.attempted_at,
        impressions: gsc ? (gsc.impressions || 0) : 0,
        clicks: gsc ? (gsc.clicks || 0) : 0,
        ctr: gsc ? (gsc.ctr || 0) : 0,
        position: gsc ? (gsc.position || 0) : 0,
        hasGscData: !!gsc,
      };
    });

    // 5. Compute totals
    const withData = articles.filter(a => a.hasGscData);
    const totals = {
      published: articles.length,
      impressions: articles.reduce((s, a) => s + a.impressions, 0),
      clicks: articles.reduce((s, a) => s + a.clicks, 0),
      avgCtr: withData.length ? parseFloat((withData.reduce((s, a) => s + a.ctr, 0) / withData.length).toFixed(2)) : 0,
      avgPosition: withData.length ? parseFloat((withData.reduce((s, a) => s + a.position, 0) / withData.length).toFixed(1)) : 0,
    };

    res.json({ success: true, articles, totals, gscConnected });
  } catch(e) {
    console.error('[WEBFLOW-SEO]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/sync/:brandProfileId', async (req, res) => {
  const { brandProfileId } = req.params;
  // Allow cron/admin bypass with adminPassword, otherwise require Clerk JWT
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'], clockTolerance: '30s' });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  }
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  const { channel = 'linkedin' } = req.body;
  try {
    const safeId = brandProfileId.replace(/-/g, '_');
    const synced = [];
    const errors = [];

    if (channel === 'linkedin' || channel === 'all') {
      const logRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                ct.title, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'linkedin' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      const credRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'linkedin' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const creds = credRes.rows[0]?.credentials || {};
      const isZernio = creds.provider === 'zernio' && !!process.env.ZERNIO_API_KEY;
      const token = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
      console.log(`[Analytics/LinkedIn] Found ${logRes.rows.length} published posts, provider=${isZernio ? 'zernio' : 'legacy'}, hasToken=${!!token}`);

      for (const row of logRes.rows) {
        try {
          const rd = row.response_data || {};
          const postId = rd.postId || rd.post_id || rd.id;
          // Zernio's internal _id, populated for posts published after the
          // Zernio migration. Pre-migration posts have null here; sync routes
          // them via legacy LinkedIn API fallback below.
          const zernioPostId = rd.zernioPostId || rd.zernio_post_id || null;
          if (!postId) { errors.push({ contentId: row.content_id, error: 'no_post_id' }); continue; }

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};
          let dataSource = 'none';

          // Use Zernio analytics ONLY when:
          //   1. Brand is migrated to Zernio (provider === 'zernio')
          //   2. This specific post has a Zernio _id (i.e. was published through Zernio)
          // Pre-Zernio posts on Zernio-routed brands fall through to legacy fallback.
          if (isZernio && zernioPostId) {
            // ── Zernio Analytics path (uses Zernio _id, NOT platform URN) ──
            let analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(zernioPostId)}`);
            // Zernio analytics are eventually-consistent — the first GET often returns
            // 202 (accepted, still computing). Re-poll a couple times so a manual
            // refresh resolves freshly-published posts on the spot instead of parking
            // them pending until the user happens to refresh again.
            for (let zAttempt = 0; analyticsRes.status === 202 && zAttempt < 2; zAttempt++) {
              await new Promise(r => setTimeout(r, 1500));
              analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(zernioPostId)}`);
              console.log(`[Analytics/LinkedIn] 202 re-poll #${zAttempt + 1} for ${zernioPostId}: HTTP ${analyticsRes.status}`);
            }
            console.log(`[Analytics/LinkedIn] Zernio analytics for ${zernioPostId} (URN ${postId}): HTTP ${analyticsRes.status}`);

            if (analyticsRes.status === 202) {
              // Ensure a placeholder content_analytics row exists so the article
              // appears in Performance Dashboard while we wait for Zernio. DO NOTHING
              // on conflict — never clobber real metrics that arrived in a later sync.
              await pool.query(
                `INSERT INTO content_analytics
                   (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1, $2, 'linkedin', $3, 0, 0, 0, 0, 0, 0, 0, $4::jsonb, COALESCE($5, NOW()), NOW())
                 ON CONFLICT (content_id, channel) DO NOTHING`,
                [brandProfileId, row.content_id, postId, JSON.stringify({ pending: true, zernioPostId }), row.published_at]
              ).catch(e => console.error('[Analytics/LinkedIn] pending placeholder failed:', e.message));
              console.log(`[Analytics/LinkedIn] Sync pending for ${zernioPostId} — placeholder inserted, will retry next sync`);
              continue;
            }
            if (analyticsRes.status === 424) {
              console.log(`[Analytics/LinkedIn] All platforms failed for ${zernioPostId}`);
              errors.push({ contentId: row.content_id, error: 'zernio_analytics_424' });
              continue;
            }
            if (!analyticsRes.ok) {
              console.log(`[Analytics/LinkedIn] Zernio analytics error: ${analyticsRes.status}`, analyticsRes.raw?.slice(0, 200));
              errors.push({ contentId: row.content_id, error: `zernio_analytics_${analyticsRes.status}` });
              continue;
            }

            const analytics = analyticsRes.parsed;
            // Zernio analytics response shape (verified via probe): metrics live at
            // analytics.platformAnalytics[].analytics for the LinkedIn entry, OR at
            // analytics.analytics as the rolled-up post-level metrics.
            const platformAnalytics = analytics?.platformAnalytics || [];
            const liEntry = platformAnalytics.find(p => p.platform === 'linkedin');
            const liMetrics = liEntry?.analytics
              || analytics?.analytics
              || analytics?.post?.analytics
              || {};

            impressions = liMetrics.impressions || liMetrics.views || liMetrics.impression_count || 0;
            clicks      = liMetrics.clicks || liMetrics.link_clicks || liMetrics.clickCount || 0;
            reactions   = liMetrics.likes || liMetrics.reactions || liMetrics.likeCount || 0;
            comments    = liMetrics.comments || liMetrics.replies || liMetrics.commentCount || 0;
            reposts     = liMetrics.shares || liMetrics.reposts || liMetrics.repostCount || liMetrics.shareCount || 0;
            rawData     = { zernio: analytics };
            dataSource  = 'zernio';
            console.log(`[Analytics/LinkedIn] Zernio metrics for ${zernioPostId}: ${impressions} impr, ${reactions} likes, ${comments} comments, ${reposts} shares, ${clicks} clicks`);

          } else if (token) {
            // ── Legacy direct LinkedIn API path ──
            try {
              const actRes = await fetch(
                `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postId)}?projection=(likesSummary,commentsSummary,shareSummary)`,
                { headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' } }
              );
              if (actRes.ok) {
                const actData = await actRes.json();
                reactions = actData?.likesSummary?.totalLikes || 0;
                comments  = actData?.commentsSummary?.totalFirstLevelComments || 0;
                reposts   = actData?.shareSummary?.totalShares || 0;
                rawData   = { ...rawData, socialActions: actData };
                dataSource = 'socialActions';
              }
            } catch(e) { /* socialActions unavailable */ }

            try {
              const encodedPostId = encodeURIComponent(postId);
              const statsRes = await fetch(
                `https://api.linkedin.com/v2/shareStatistics?q=shares&shares[0]=${encodedPostId}&projection=(elements*(totalShareStatistics))`,
                { headers: { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': '202401' } }
              );
              if (statsRes.ok) {
                const statsData = await statsRes.json();
                const stats = statsData?.elements?.[0]?.totalShareStatistics || {};
                if (stats.impressionCount > 0) {
                  impressions = stats.impressionCount || 0;
                  clicks      = stats.clickCount     || 0;
                  reactions   = Math.max(reactions, stats.likeCount  || 0);
                  comments    = Math.max(comments,  stats.commentCount || 0);
                  reposts     = Math.max(reposts,   stats.shareCount  || 0);
                  rawData     = { ...rawData, shareStatistics: stats };
                  dataSource  = 'shareStatistics';
                }
              }
            } catch(e) { /* MDP not approved */ }
          } else {
            console.log(`[Analytics/LinkedIn] No credentials — skipping ${postId}`);
            continue;
          }

          if (dataSource === 'none') {
            console.log(`[Analytics/LinkedIn] No data returned for ${postId} — skipping`);
            continue;
          }

          const totalEngagement = reactions + comments + reposts + clicks;
          const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
          const engagementRate = impressions > 0
            ? parseFloat((totalEngagement / impressions * 100).toFixed(2))
            : 0;

          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               impressions      = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.impressions ELSE content_analytics.impressions END,
               clicks           = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.clicks      ELSE content_analytics.clicks      END,
               ctr              = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.ctr         ELSE content_analytics.ctr         END,
               engagement_rate  = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.engagement_rate ELSE content_analytics.engagement_rate END,
               reactions        = GREATEST(COALESCE(content_analytics.reactions, 0), EXCLUDED.reactions),
               comments         = GREATEST(COALESCE(content_analytics.comments, 0),  EXCLUDED.comments),
               reposts          = GREATEST(COALESCE(content_analytics.reposts, 0),   EXCLUDED.reposts),
               raw_data         = (COALESCE(content_analytics.raw_data, '{}'::jsonb) - 'pending') || EXCLUDED.raw_data,
               synced_at        = NOW(),
               campaign_id      = COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, 'linkedin', postId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, postId, reactions, comments, reposts, impressions, dataSource });
        } catch(e) {
          errors.push({ contentId: row.content_id, error: e.message });
        }
      }
    }

    // ── X (Twitter) analytics ──────────────────────────────────────────────
    if (channel === 'x' || channel === 'all') {
      const xLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'x' AND pl.status = 'published'
           AND (pl.live_status IS NULL OR pl.live_status != 'deleted')
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      );

      const xCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels
         WHERE brand_profile_id = $1 AND channel = 'x' AND is_active = true
         LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const xCreds = xCredRes.rows[0]?.credentials || {};

      const xHasOAuth2 = !!xCreds.oauth2AccessToken;
      const xHasOAuth1 = !!(xCreds.apiKey || process.env.X_OAUTH1CONSUMER_KEY)
        && !!(xCreds.accessToken || process.env.X_OAUTH1ACCESS_TOKEN);
      const xSyncedStart = synced.length;
      const xErrorsStart = errors.length;
      console.log(`[Analytics/X] Found ${xLogRes.rows.length} published posts for brand=${brandProfileId}, oauth2=${xHasOAuth2}, oauth1=${xHasOAuth1}`);

      // Fail fast if no credentials at all — otherwise the per-row loop hits
      // the silent `if (!xApiKey || !xAccessToken) continue;` for every tweet
      // and the response comes back synced=0, errors=[] which is
      // indistinguishable from "nothing to sync."
      if (xLogRes.rows.length > 0 && !xHasOAuth2 && !xHasOAuth1) {
        console.warn(`[Analytics/X] No credentials configured (no OAuth2 token, no OAuth1 fallback) — skipping all ${xLogRes.rows.length} eligible posts`);
        errors.push({ channel: 'x', error: 'no_x_credentials_configured', detail: 'Connect X in Integrations or configure X_OAUTH1CONSUMER_KEY / X_OAUTH1ACCESS_TOKEN env vars.' });
      } else {
        // Track refresh state across the loop: refresh at most once per sync
        // call so a permanently-bad refresh_token can't burn a request per
        // tweet. Mirrors the publish path's pattern (server.js:11038-11071).
        let xRefreshAttempted = false;
        let xAuthHardFailed = false;
        for (const row of xLogRes.rows) {
          if (xAuthHardFailed) break;
          try {
            const rd = row.response_data || row.queue_results?.x || {};
            const tweetId = rd.tweetId || rd.id
              || (row.published_url?.match(/\/status\/(\d+)/)?.[1]);
            if (!tweetId) {
              console.warn(`[Analytics/X] no_tweet_id_in: ${row.published_url || '(no published_url)'} content=${row.content_id}`);
              errors.push({ contentId: row.content_id, error: 'no_tweet_id_in:' + row.published_url });
              continue;
            }

            // Build auth header — OAuth 2.0 preferred, 1.0a fallback
            const endpoint = `https://api.twitter.com/2/tweets/${tweetId}`;
            const queryString = 'tweet.fields=public_metrics,non_public_metrics,created_at,author_id';
            let authHeader;
            let usedOAuth2 = false;
            if (xCreds.oauth2AccessToken) {
              authHeader = `Bearer ${xCreds.oauth2AccessToken}`;
              usedOAuth2 = true;
            } else {
              const xApiKey       = xCreds.apiKey       || process.env.X_OAUTH1CONSUMER_KEY;
              const xApiSecret    = xCreds.apiSecret    || process.env.X_OAUTH1CONSUMER_SECRET;
              const xAccessToken  = xCreds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
              const xAccessSecret = xCreds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
              if (!xApiKey || !xAccessToken) {
                // Defense-in-depth — the pre-loop check above should have caught
                // this. If only some rows hit here it means brand credentials
                // are partial; surface it instead of silently skipping.
                console.warn(`[Analytics/X] missing OAuth1 creds mid-loop for tweet=${tweetId} content=${row.content_id} — skipping`);
                errors.push({ contentId: row.content_id, error: 'no_x_credentials_for_row' });
                continue;
              }
              authHeader = buildXOAuthHeader('GET', endpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret,
                Object.fromEntries(new URLSearchParams(queryString)));
            }

            let tweetRes = await fetch(`${endpoint}?${queryString}`, {
              headers: { 'Authorization': authHeader }
            });

            // 401 with OAuth 2.0 → access token expired. Try a one-shot
            // refresh, persist the new token, retry the request once.
            // Mirrors the publish-path refresh at server.js:11038-11071.
            if (tweetRes.status === 401 && usedOAuth2 && xCreds.oauth2RefreshToken && !xRefreshAttempted) {
              xRefreshAttempted = true;
              try {
                const refreshed = await refreshXOAuth2Token(xCreds.oauth2RefreshToken);
                xCreds.oauth2AccessToken = refreshed.access_token;
                if (refreshed.refresh_token) xCreds.oauth2RefreshToken = refreshed.refresh_token;
                await pool.query(
                  `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
                  [JSON.stringify({ oauth2AccessToken: xCreds.oauth2AccessToken, oauth2RefreshToken: xCreds.oauth2RefreshToken }), brandProfileId]
                );
                console.log(`[Analytics/X] Refreshed OAuth2 token mid-sync for brand=${brandProfileId}, retrying tweet=${tweetId}`);
                tweetRes = await fetch(`${endpoint}?${queryString}`, {
                  headers: { 'Authorization': `Bearer ${xCreds.oauth2AccessToken}` }
                });
              } catch(e) {
                console.error(`[Analytics/X] Token refresh failed for brand=${brandProfileId}: ${e.message}`);
                const msg = (e.message || '').toLowerCase();
                if (msg.includes('invalid') || msg.includes('revoked') || msg.includes('expired')) {
                  await pool.query(
                    `UPDATE publishing_channels SET credentials = credentials - 'oauth2AccessToken' - 'oauth2RefreshToken' WHERE brand_profile_id = $1 AND channel = 'x'`,
                    [brandProfileId]
                  ).catch(() => {});
                  console.error(`[Analytics/X] Cleared expired tokens for brand=${brandProfileId} — user must reconnect`);
                  errors.push({ channel: 'x', error: 'x_auth_expired', detail: 'X authentication expired. Please reconnect X in Integrations.' });
                } else {
                  errors.push({ contentId: row.content_id, error: 'token_refresh_failed:' + e.message });
                }
                // No point hammering api.twitter.com with a dead token for the
                // remaining tweets — break out and let the next sync retry.
                xAuthHardFailed = true;
                break;
              }
            }

            let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
            let rawData = {};

            if (tweetRes.ok) {
              const tweetData = await tweetRes.json();
              const pub  = tweetData.data?.public_metrics     || {};
              const priv = tweetData.data?.non_public_metrics || {};
              impressions = pub.impression_count || 0;
              reactions   = pub.like_count       || 0;
              comments    = pub.reply_count      || 0;
              reposts     = (pub.retweet_count || 0) + (pub.quote_count || 0);
              // url_link_clicks lives in non_public_metrics — falls back gracefully if unavailable
              clicks      = priv.url_link_clicks || priv.user_profile_clicks || 0;
              rawData     = { public_metrics: pub, non_public_metrics: priv };
            } else {
              const errBody = await tweetRes.json().catch(() => ({}));
              const reason = errBody?.detail || errBody?.title || `HTTP ${tweetRes.status}`;
              console.warn(`[Analytics/X] tweet=${tweetId} content=${row.content_id} → HTTP ${tweetRes.status}: ${reason}`);
              errors.push({ contentId: row.content_id, error: reason });
              continue;
            }

            const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
            const engagementRate = impressions > 0
              ? parseFloat(((reactions + comments + reposts + clicks) / impressions * 100).toFixed(2))
              : 0;

            await pool.query(
              `INSERT INTO content_analytics
                 (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14)
               ON CONFLICT (content_id, channel) DO UPDATE SET
                 post_id=EXCLUDED.post_id,
                 impressions=GREATEST(content_analytics.impressions, EXCLUDED.impressions),
                 clicks=GREATEST(content_analytics.clicks, EXCLUDED.clicks),
                 reactions=GREATEST(content_analytics.reactions, EXCLUDED.reactions),
                 comments=GREATEST(content_analytics.comments, EXCLUDED.comments),
                 reposts=GREATEST(content_analytics.reposts, EXCLUDED.reposts),
                 ctr=EXCLUDED.ctr,
                 engagement_rate=EXCLUDED.engagement_rate,
                 raw_data=EXCLUDED.raw_data, synced_at=NOW(),
                 campaign_id=COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
              [brandProfileId, row.content_id, 'x', tweetId,
               impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
               JSON.stringify(rawData), row.published_at, row.campaign_id || null]
            );
            synced.push({ contentId: row.content_id, title: row.title, tweetId, impressions, reactions, comments, reposts, clicks });
          } catch(e) {
            console.warn(`[Analytics/X] content=${row.content_id} threw: ${e.message}`);
            errors.push({ contentId: row.content_id, error: e.message });
          }
        }
      }

      const xSyncedDelta = synced.length - xSyncedStart;
      const xErrorsDelta = errors.length - xErrorsStart;
      console.log(`[Analytics/X] Done for brand=${brandProfileId}: synced=${xSyncedDelta}, errors=${xErrorsDelta}, eligible=${xLogRes.rows.length}`);
    }

    // ── Facebook analytics (via Zernio) ─────────────────────────────────────
    if (channel === 'facebook' || channel === 'all') {
      const fbLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'facebook' AND pl.status = 'published'
           AND (pl.live_status IS NULL OR pl.live_status != 'deleted')
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      const fbCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'facebook' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const fbCreds = fbCredRes.rows[0]?.credentials || {};
      const fbIsZernio = fbCreds.provider === 'zernio' && !!process.env.ZERNIO_API_KEY;
      const fbToken = fbCreds.pageAccessToken;
      console.log(`[Analytics/Facebook] Found ${fbLogRes.rows.length} published posts, provider=${fbIsZernio ? 'zernio' : 'legacy'}`);

      for (const row of fbLogRes.rows) {
        try {
          const rd = row.response_data || {};
          const postId = rd.postId || rd.post_id || rd.id;
          // Zernio's internal _id (separate from the Facebook platform URN).
          // Populated for posts published after the zernioPostId capture landed
          // in the publish handler. Older Zernio posts have null here and route
          // to the legacy Graph API fallback below.
          const zernioPostId = rd.zernioPostId || rd.zernio_post_id || null;
          if (!postId) { errors.push({ contentId: row.content_id, error: 'no_post_id' }); continue; }

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};
          let dataSource = 'none';

          // Use Zernio analytics ONLY when this specific post has a Zernio _id —
          // Zernio's /analytics endpoint expects its internal _id, NOT the
          // Facebook platform URN (pageId_postId). Posts published before the
          // zernioPostId fix have no _id stored, so they route through the
          // legacy Graph API fallback even if the brand is Zernio-routed.
          if (fbIsZernio && zernioPostId) {
            const analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(zernioPostId)}`);
            console.log(`[Analytics/Facebook] Zernio analytics for ${zernioPostId} (URN ${postId}): HTTP ${analyticsRes.status}`);

            if (analyticsRes.status === 202) {
              await pool.query(
                `INSERT INTO content_analytics
                   (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1, $2, 'facebook', $3, 0, 0, 0, 0, 0, 0, 0, $4::jsonb, COALESCE($5, NOW()), NOW())
                 ON CONFLICT (content_id, channel) DO NOTHING`,
                [brandProfileId, row.content_id, postId, JSON.stringify({ pending: true }), row.published_at]
              ).catch(e => console.error('[Analytics/Facebook] pending placeholder failed:', e.message));
              console.log(`[Analytics/Facebook] Sync pending for ${postId} — placeholder inserted, will retry next sync`);
              continue;
            }
            if (analyticsRes.status === 424 || !analyticsRes.ok) {
              errors.push({ contentId: row.content_id, error: `zernio_analytics_${analyticsRes.status}` });
              continue;
            }

            const analytics = analyticsRes.parsed;
            const platforms = analytics?.post?.platforms || analytics?.platforms || [];
            const fbMetrics = platforms.find(p => p.platform === 'facebook')?.analytics
              || analytics?.post?.analytics
              || analytics?.analytics
              || analytics || {};

            impressions = fbMetrics.impressions || fbMetrics.views || fbMetrics.reach || fbMetrics.impression_count || 0;
            clicks      = fbMetrics.clicks || fbMetrics.link_clicks || fbMetrics.post_clicks || 0;
            reactions   = fbMetrics.likes || fbMetrics.reactions || fbMetrics.total_reactions || 0;
            comments    = fbMetrics.comments || fbMetrics.comment_count || 0;
            reposts     = fbMetrics.shares || fbMetrics.reposts || fbMetrics.share_count || 0;
            rawData     = { zernio: analytics };
            dataSource  = 'zernio';
            console.log(`[Analytics/Facebook] Zernio metrics for ${postId}: ${impressions} impr, ${reactions} reactions, ${comments} comments, ${reposts} shares, ${clicks} clicks`);

          } else if (fbToken && fbCreds.pageId) {
            // Legacy direct Graph API path
            try {
              const fbRes = await fetch(
                `https://graph.facebook.com/v19.0/${postId}/insights?metric=post_impressions,post_clicks,post_reactions_like_total&access_token=${fbToken}`
              );
              if (fbRes.ok) {
                const fbData = await fbRes.json();
                for (const metric of (fbData.data || [])) {
                  const val = metric.values?.[0]?.value || 0;
                  if (metric.name === 'post_impressions') impressions = val;
                  if (metric.name === 'post_clicks') clicks = val;
                  if (metric.name === 'post_reactions_like_total') reactions = val;
                }
                rawData = { graphApi: fbData };
                dataSource = 'graphApi';
              }
            } catch(e) { /* Graph API unavailable */ }
          } else {
            continue;
          }

          if (dataSource === 'none') continue;

          const totalEngagement = reactions + comments + reposts + clicks;
          const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
          const engagementRate = impressions > 0
            ? parseFloat((totalEngagement / impressions * 100).toFixed(2))
            : 0;

          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               impressions      = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.impressions ELSE content_analytics.impressions END,
               clicks           = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.clicks      ELSE content_analytics.clicks      END,
               ctr              = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.ctr         ELSE content_analytics.ctr         END,
               engagement_rate  = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.engagement_rate ELSE content_analytics.engagement_rate END,
               reactions        = GREATEST(COALESCE(content_analytics.reactions, 0), EXCLUDED.reactions),
               comments         = GREATEST(COALESCE(content_analytics.comments, 0),  EXCLUDED.comments),
               reposts          = GREATEST(COALESCE(content_analytics.reposts, 0),   EXCLUDED.reposts),
               raw_data         = (COALESCE(content_analytics.raw_data, '{}'::jsonb) - 'pending') || EXCLUDED.raw_data,
               synced_at        = NOW(),
               campaign_id      = COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, 'facebook', postId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, postId, reactions, comments, reposts, impressions, dataSource });
        } catch(e) {
          errors.push({ contentId: row.content_id, error: e.message });
        }
      }
    }

    // ── Reddit analytics (Zernio-only) ──
    // Forge's Reddit publishing always routes through Zernio (no legacy direct OAuth path
    // for Reddit — Phase 1 of the Reddit wire-up was Zernio-first by design). So this
    // branch only handles the Zernio analytics pull.
    if (channel === 'reddit' || channel === 'all') {
      const rdLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.title, ct.campaign_id
           FROM publish_log pl
           LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
          WHERE pl.brand_profile_id = $1 AND pl.channel = 'reddit' AND pl.status = 'published'
            AND (pl.live_status IS NULL OR pl.live_status != 'deleted')
          ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      const rdCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'reddit' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const rdCreds = rdCredRes.rows[0]?.credentials || {};
      const rdIsZernio = !!rdCreds.zernioAccountId && !!process.env.ZERNIO_API_KEY;
      console.log(`[Analytics/Reddit] Found ${rdLogRes.rows.length} published posts, provider=${rdIsZernio ? 'zernio' : 'unsupported'}`);

      for (const row of rdLogRes.rows) {
        try {
          const rd = row.response_data || {};
          const postId = rd.postId || rd.post_id || rd.id;
          if (!postId) { errors.push({ contentId: row.content_id, error: 'no_post_id' }); continue; }

          let impressions = 0, clicks = 0, reactions = 0, comments = 0, reposts = 0;
          let rawData = {};
          let dataSource = 'none';

          if (rdIsZernio) {
            const analyticsRes = await callZernio('GET', `/analytics?postId=${encodeURIComponent(postId)}`);
            console.log(`[Analytics/Reddit] Zernio analytics for ${postId}: HTTP ${analyticsRes.status}`);

            if (analyticsRes.status === 202) {
              await pool.query(
                `INSERT INTO content_analytics
                   (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1, $2, 'reddit', $3, 0, 0, 0, 0, 0, 0, 0, $4::jsonb, COALESCE($5, NOW()), NOW())
                 ON CONFLICT (content_id, channel) DO NOTHING`,
                [brandProfileId, row.content_id, postId, JSON.stringify({ pending: true }), row.published_at]
              ).catch(e => console.error('[Analytics/Reddit] pending placeholder failed:', e.message));
              console.log(`[Analytics/Reddit] Sync pending for ${postId} — placeholder inserted, will retry next sync`);
              continue;
            }
            if (analyticsRes.status === 424 || !analyticsRes.ok) {
              errors.push({ contentId: row.content_id, error: `zernio_analytics_${analyticsRes.status}` });
              continue;
            }

            const analytics = analyticsRes.parsed;
            const platforms = analytics?.post?.platforms || analytics?.platforms || [];
            const rdMetrics = platforms.find(p => p.platform === 'reddit')?.analytics
              || analytics?.post?.analytics
              || analytics?.analytics
              || analytics || {};

            // Reddit metric name mapping. Reddit's terminology differs from LI/FB:
            //   upvotes/score → reactions (positive engagement)
            //   crossposts    → reposts (closest analog — someone reshared to another sub)
            //   views         → impressions (Zernio surfaces this if Reddit returned it)
            //   comments      → comments (1:1)
            // Reddit's `score` is upvotes minus downvotes; we prefer raw upvotes when available
            // and fall back to score. Downvotes get parked in raw_data for later analysis.
            impressions = rdMetrics.impressions || rdMetrics.views || rdMetrics.view_count || 0;
            clicks      = rdMetrics.clicks || rdMetrics.link_clicks || rdMetrics.url_clicks || 0;
            reactions   = rdMetrics.upvotes || rdMetrics.ups || rdMetrics.score || rdMetrics.likes || 0;
            comments    = rdMetrics.comments || rdMetrics.num_comments || rdMetrics.comment_count || 0;
            reposts     = rdMetrics.crossposts || rdMetrics.num_crossposts || rdMetrics.shares || 0;
            rawData     = { zernio: analytics };
            dataSource  = 'zernio';
            console.log(`[Analytics/Reddit] Zernio metrics for ${postId}: ${impressions} views, ${reactions} upvotes, ${comments} comments, ${reposts} crossposts, ${clicks} clicks`);
          } else {
            console.log(`[Analytics/Reddit] No Zernio account on Reddit channel — skipping ${postId}`);
            continue;
          }

          if (dataSource === 'none') continue;

          const totalEngagement = reactions + comments + reposts + clicks;
          const ctr = impressions > 0 ? parseFloat((clicks / impressions * 100).toFixed(2)) : 0;
          const engagementRate = impressions > 0
            ? parseFloat((totalEngagement / impressions * 100).toFixed(2))
            : 0;

          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               impressions      = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.impressions ELSE content_analytics.impressions END,
               clicks           = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.clicks      ELSE content_analytics.clicks      END,
               ctr              = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.ctr         ELSE content_analytics.ctr         END,
               engagement_rate  = CASE WHEN EXCLUDED.impressions > 0 THEN EXCLUDED.engagement_rate ELSE content_analytics.engagement_rate END,
               reactions        = GREATEST(COALESCE(content_analytics.reactions, 0), EXCLUDED.reactions),
               comments         = GREATEST(COALESCE(content_analytics.comments, 0),  EXCLUDED.comments),
               reposts          = GREATEST(COALESCE(content_analytics.reposts, 0),   EXCLUDED.reposts),
               raw_data         = (COALESCE(content_analytics.raw_data, '{}'::jsonb) - 'pending') || EXCLUDED.raw_data,
               synced_at        = NOW(),
               campaign_id      = COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, 'reddit', postId,
             impressions, clicks, reactions, comments, reposts, ctr, engagementRate,
             JSON.stringify(rawData), row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, postId, reactions, comments, reposts, impressions, dataSource });
        } catch(e) {
          errors.push({ contentId: row.content_id, error: e.message });
        }
      }
    }

    // Ghost sync
    if (channel === 'ghost' || channel === 'all') {
      // Prefer per-brand credentials from publishing_channels, fall back to env vars
      const ghostCredRes = await pool.query(
        `SELECT credentials FROM publishing_channels WHERE brand_profile_id = $1 AND channel = 'ghost' AND is_active = true LIMIT 1`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));
      const ghostCreds  = ghostCredRes.rows[0]?.credentials || {};
      const ghostApiKey = ghostCreds.adminApiKey;
      const ghostApiUrl = (ghostCreds.adminUrl || '').replace(/\/+$/, '');
      if (!ghostApiKey || !ghostApiUrl) {
        // Ghost not configured for this brand — skip
      } else {
        const safeId = brandProfileId.replace(/-/g, '_');
        // Fetch all published posts directly from Ghost Admin API
        const jwt = buildGhostJWT(ghostApiKey);
        const ghostListRes = await fetch(
          `${ghostApiUrl}/ghost/api/admin/posts/?limit=all&filter=status:published&fields=id,title,slug,published_at,reading_time&include=count.clicks,count.positive_feedback,count.negative_feedback`,
          { headers: { 'Authorization': `Ghost ${jwt}`, 'Accept-Version': 'v5.0' } }
        );
        if (!ghostListRes.ok) {
          errors.push({ channel: 'ghost', error: `ghost_list_api_${ghostListRes.status}` });
        } else {
          const ghostListData = await ghostListRes.json();
          const ghostPosts = ghostListData.posts || [];

          // Build title->content_id map from publishing_queue
          const queueRes = await pool.query(
            `SELECT content_id, title FROM publishing_queue WHERE brand_profile_id = $1`,
            [brandProfileId]
          ).catch(() => ({ rows: [] }));
          const titleMap = {};
          for (const r of queueRes.rows) {
            if (r.title) titleMap[r.title.toLowerCase().trim()] = r.content_id;
          }

          // Also check publish_log for ghostPostId matches
          const logRes = await pool.query(
            `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at
             FROM publish_log pl
             WHERE pl.brand_profile_id = $1 AND pl.channel = 'ghost'
             ORDER BY pl.attempted_at DESC`,
            [brandProfileId]
          ).catch(() => ({ rows: [] }));
          const postIdMap = {};
          for (const r of logRes.rows) {
            const gid = r.response_data?.ghostPostId || r.response_data?.id;
            if (gid) postIdMap[gid] = r.content_id;
          }

          for (const post of ghostPosts) {
            try {
              const count = post.count || {};
              const clicks           = count.clicks || 0;
              const positiveFeedback = count.positive_feedback || 0;
              const negativeFeedback = count.negative_feedback || 0;
              const readingTime      = post.reading_time || 0;
              const publishedAt      = post.published_at;

              // Match Ghost post to a content_id — try postIdMap first, then title match
              let contentId = postIdMap[post.id]
                || titleMap[post.title?.toLowerCase().trim()]
                || null;

              // If no match, skip — only track Ghost posts Forge published
              if (!contentId) continue;

              await pool.query(
                `INSERT INTO content_analytics
                  (brand_profile_id, content_id, channel, post_id, clicks, positive_feedback, negative_feedback,
                   reading_time, impressions, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at)
                 VALUES ($1,$2,'ghost',$3,$4,$5,$6,$7,0,0,0,0,0,0,$8,$9,NOW())
                 ON CONFLICT (brand_profile_id, content_id, channel)
                 DO UPDATE SET clicks=$4, positive_feedback=$5, negative_feedback=$6,
                   reading_time=$7, raw_data=$8, published_at=$9, synced_at=NOW()`,
                [brandProfileId, contentId, post.id, clicks, positiveFeedback,
                 negativeFeedback, readingTime, JSON.stringify({ count, ghost_title: post.title }), publishedAt]
              );
              synced.push({ contentId, ghostPostId: post.id, title: post.title, clicks, positiveFeedback, negativeFeedback, readingTime });
            } catch(e) {
              errors.push({ ghostPostId: post.id, channel: 'ghost', error: e.message });
            }
          }
        }
      }
    }

    // ── WordPress sync ─────────────────────────────────────────────────────
    if (channel === 'wordpress' || channel === 'all') {
      const wpLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.title, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'wordpress' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      for (const row of wpLogRes.rows) {
        try {
          const postId = row.response_data?.postId || row.response_data?.id || null;
          const postUrl = row.published_url || row.response_data?.link || '';
          
          // WordPress doesn't have a simple analytics API — record basic publish data
          // Future: Could integrate Jetpack Stats API if available
          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,'wordpress',$3,0,0,0,0,0,0,0,$4,$5,NOW(),$6)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               post_id=COALESCE(EXCLUDED.post_id, content_analytics.post_id),
               raw_data=EXCLUDED.raw_data, synced_at=NOW(),
               campaign_id=COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, postId, 
             JSON.stringify({ title: row.title, url: postUrl, ...row.response_data }), 
             row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, postId, channel: 'wordpress', url: postUrl });
        } catch(e) {
          errors.push({ contentId: row.content_id, channel: 'wordpress', error: e.message });
        }
      }
    }

    // ── Webflow sync ──────────────────────────────────────────────────────
    if (channel === 'webflow' || channel === 'all') {
      const wfLogRes = await pool.query(
        `SELECT pl.content_id, pl.response_data, pl.attempted_at AS published_at,
                pl.published_url, ct.title, ct.campaign_id
         FROM publish_log pl
         LEFT JOIN generated_content_${safeId} ct ON ct.id::text = pl.content_id
         WHERE pl.brand_profile_id = $1 AND pl.channel = 'webflow' AND pl.status = 'published'
         ORDER BY pl.attempted_at DESC`,
        [brandProfileId]
      ).catch(() => ({ rows: [] }));

      for (const row of wfLogRes.rows) {
        try {
          const itemId = row.response_data?.itemId || row.response_data?.id || row.response_data?._id || null;
          const postUrl = row.published_url || '';
          
          // Webflow doesn't have a public analytics API — record basic publish data
          await pool.query(
            `INSERT INTO content_analytics
               (brand_profile_id, content_id, channel, post_id, impressions, clicks, reactions, comments, reposts, ctr, engagement_rate, raw_data, published_at, synced_at, campaign_id)
             VALUES ($1,$2,'webflow',$3,0,0,0,0,0,0,0,$4,$5,NOW(),$6)
             ON CONFLICT (content_id, channel) DO UPDATE SET
               post_id=COALESCE(EXCLUDED.post_id, content_analytics.post_id),
               raw_data=EXCLUDED.raw_data, synced_at=NOW(),
               campaign_id=COALESCE(EXCLUDED.campaign_id, content_analytics.campaign_id)`,
            [brandProfileId, row.content_id, itemId,
             JSON.stringify({ title: row.title, url: postUrl, ...row.response_data }),
             row.published_at, row.campaign_id || null]
          );
          synced.push({ contentId: row.content_id, title: row.title, itemId, channel: 'webflow', url: postUrl });
        } catch(e) {
          errors.push({ contentId: row.content_id, channel: 'webflow', error: e.message });
        }
      }
    }

    res.json({ success: true, channel, synced: synced.length, errors: errors.length, data: synced, errs: errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/dashboard/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  const channel = req.query.channel || 'linkedin';
  try {
    const safeId = brandProfileId.replace(/-/g, '_');

    // Totals
    // GSC math bug fix: for channel='gsc', the engagement_rate column stores search-ranking position
    // (schema overload — see sync-gsc handler). Simple AVG(position) gives equal weight to a page with
    // 1 impression at rank #50 and a page with 10,000 impressions at rank #3 — wildly overstating
    // average rank. Same problem for AVG(ctr). Google Search Console's own dashboard uses
    // impression-weighted math: SUM(metric * impressions) / SUM(impressions). Branch here so GSC
    // matches what Brian sees in GSC directly; other channels keep their existing behavior.
    const isGsc = channel === 'gsc';
    const ctrExpr = isGsc
      ? `CASE WHEN COALESCE(SUM(impressions),0) > 0 THEN SUM(clicks)::float * 100.0 / SUM(impressions) ELSE 0 END`
      : `COALESCE(AVG(NULLIF(ctr,0)),0)`;
    const engExpr = isGsc
      ? `CASE WHEN COALESCE(SUM(impressions),0) > 0 THEN SUM(engagement_rate * impressions)::float / SUM(impressions) ELSE 0 END`
      : `COALESCE(AVG(NULLIF(engagement_rate,0)),0)`;

    const totals = await pool.query(
      `SELECT
         COUNT(*) as total_posts,
         COALESCE(SUM(impressions),0) as total_impressions,
         COALESCE(SUM(clicks),0) as total_clicks,
         COALESCE(SUM(reactions),0) as total_reactions,
         COALESCE(SUM(comments),0) as total_comments,
         COALESCE(SUM(reposts),0) as total_reposts,
         ${ctrExpr} as avg_ctr,
         ${engExpr} as avg_engagement_rate,
         MAX(synced_at) as last_synced
       FROM content_analytics
       WHERE brand_profile_id=$1 AND channel=$2`,
      [brandProfileId, channel]
    );

    // Top 5 posts by impressions — DISTINCT on content_id, latest non-deleted publish_log entry
    const top = await pool.query(
      `SELECT DISTINCT ON (ca.content_id)
              ca.content_id, ca.impressions, ca.clicks, ca.reactions,
              ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
              ca.reading_time, ca.positive_feedback, ca.negative_feedback,
              ca.synced_at AS published_at, ca.synced_at, ca.post_id, ca.raw_data,
              pl.published_url, pq.title, pq.hero_image_url
       FROM content_analytics ca
       LEFT JOIN LATERAL (
         SELECT published_url FROM publish_log
         WHERE content_id = ca.content_id AND channel = ca.channel
           AND status = 'published' AND (live_status IS NULL OR live_status != 'deleted')
         ORDER BY attempted_at DESC LIMIT 1
       ) pl ON true
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id=$1 AND ca.channel=$2
       ORDER BY ca.content_id, ca.impressions DESC, ca.reactions DESC
       LIMIT 5`,
      [brandProfileId, channel]
    );

    // 30-day trend (daily impressions)
    const trend = await pool.query(
      `SELECT DATE_TRUNC('day', synced_at) as day,
              SUM(impressions) as impressions,
              SUM(clicks) as clicks,
              SUM(reactions) as reactions
       FROM content_analytics
       WHERE brand_profile_id=$1 AND channel=$2
         AND synced_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE_TRUNC('day', synced_at)
       ORDER BY day ASC`,
      [brandProfileId, channel]
    ).catch(() => ({ rows: [] }));

    // All posts for table — DISTINCT on content_id, latest non-deleted publish_log entry
    const posts = await pool.query(
      `SELECT DISTINCT ON (ca.content_id)
              ca.content_id, ca.impressions, ca.clicks, ca.reactions,
              ca.comments, ca.reposts, ca.ctr, ca.engagement_rate,
              ca.reading_time, ca.positive_feedback, ca.negative_feedback,
              ca.synced_at AS published_at, ca.synced_at, ca.channel, ca.post_id, ca.raw_data,
              pl.published_url, pq.title, pq.hero_image_url
       FROM content_analytics ca
       LEFT JOIN LATERAL (
         SELECT published_url FROM publish_log
         WHERE content_id = ca.content_id AND channel = ca.channel
           AND status = 'published' AND (live_status IS NULL OR live_status != 'deleted')
         ORDER BY attempted_at DESC LIMIT 1
       ) pl ON true
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id
       WHERE ca.brand_profile_id=$1 AND ca.channel=$2
       ORDER BY ca.content_id, ca.impressions DESC, ca.synced_at DESC`,
      [brandProfileId, channel]
    );

    const t = totals.rows[0];
    res.json({
      success: true,
      channel,
      totals: {
        posts: parseInt(t.total_posts),
        impressions: parseInt(t.total_impressions),
        clicks: parseInt(t.total_clicks),
        reactions: parseInt(t.total_reactions),
        comments: parseInt(t.total_comments),
        reposts: parseInt(t.total_reposts),
        avgCtr: parseFloat(t.avg_ctr).toFixed(2),
        avgEngagementRate: parseFloat(t.avg_engagement_rate).toFixed(2),
        lastSynced: t.last_synced
      },
      trend: trend.rows.map(r => ({
        day: r.day, impressions: parseInt(r.impressions),
        clicks: parseInt(r.clicks), reactions: parseInt(r.reactions)
      })),
      topPosts: top.rows,
      posts: posts.rows
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/channels/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
  try {
    const result = await pool.query(
      `SELECT channel, COUNT(*) as post_count, SUM(impressions) as impressions, MAX(synced_at) as last_synced
       FROM content_analytics WHERE brand_profile_id=$1
       GROUP BY channel`,
      [brandProfileId]
    );
    res.json({ success: true, channels: result.rows });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/campaigns/:brandProfileId', requireAuth, async (req, res) => {
  const { brandProfileId } = req.params;
    if (!(await verifyBrandAccess(brandProfileId, req.userId))) return res.status(403).json({ error: 'Access denied' });
  try {
    // Aggregate content_analytics by campaign, join campaigns table for name/topic
    const result = await pool.query(
      `SELECT
         ca.campaign_id,
         c.name              AS campaign_name,
         c.topic_cluster,
         c.created_at        AS campaign_created_at,
         COUNT(DISTINCT ca.content_id)              AS article_count,
         COUNT(DISTINCT ca.channel)                 AS channel_count,
         SUM(ca.impressions)                        AS total_impressions,
         SUM(ca.clicks)                             AS total_clicks,
         SUM(ca.reactions)                          AS total_reactions,
         SUM(ca.comments)                           AS total_comments,
         SUM(ca.reposts)                            AS total_reposts,
         CASE WHEN SUM(ca.impressions) > 0
              THEN ROUND((SUM(ca.clicks)::numeric / SUM(ca.impressions) * 100), 2)
              ELSE 0 END                            AS avg_ctr,
         CASE WHEN SUM(ca.impressions) > 0
              THEN ROUND(((SUM(ca.reactions)+SUM(ca.comments)+SUM(ca.reposts)+SUM(ca.clicks))::numeric
                          / SUM(ca.impressions) * 100), 2)
              ELSE 0 END                            AS avg_engagement_rate,
         MAX(ca.synced_at)                          AS last_synced
       FROM content_analytics ca
       LEFT JOIN campaigns c ON c.id = ca.campaign_id
       WHERE ca.brand_profile_id = $1
         AND ca.campaign_id IS NOT NULL
       GROUP BY ca.campaign_id, c.name, c.topic_cluster, c.created_at
       ORDER BY total_impressions DESC`,
      [brandProfileId]
    );

    // Per-campaign breakdown by channel (for channel comparison within a campaign)
    const breakdown = await pool.query(
      `SELECT
         campaign_id,
         channel,
         COUNT(DISTINCT content_id)  AS article_count,
         SUM(impressions)            AS impressions,
         SUM(clicks)                 AS clicks,
         SUM(reactions)              AS reactions,
         SUM(reposts)                AS reposts
       FROM content_analytics
       WHERE brand_profile_id = $1 AND campaign_id IS NOT NULL
       GROUP BY campaign_id, channel
       ORDER BY campaign_id, impressions DESC`,
      [brandProfileId]
    );

    // Per-campaign article leaderboard (top article per campaign by impressions)
    const safeId = brandProfileId.replace(/-/g, '_');
    const leaderboard = await pool.query(
      `SELECT
         ca.campaign_id,
         ca.content_id,
         ca.channel,
         ca.impressions,
         ca.clicks,
         ca.reactions,
         pq.title,
         pl.published_url
       FROM content_analytics ca
       LEFT JOIN publishing_queue pq ON pq.content_id = ca.content_id::text
       LEFT JOIN LATERAL (
         SELECT published_url FROM publish_log
         WHERE content_id = ca.content_id::text AND status = 'published'
           AND (live_status IS NULL OR live_status != 'deleted')
         ORDER BY attempted_at DESC LIMIT 1
       ) pl ON true
       WHERE ca.brand_profile_id = $1 AND ca.campaign_id IS NOT NULL
       ORDER BY ca.campaign_id, ca.impressions DESC`,
      [brandProfileId]
    ).catch(() => ({ rows: [] }));

    // Group breakdown and leaderboard by campaign_id for easy frontend consumption
    const breakdownByCampaign = {};
    for (const row of breakdown.rows) {
      const id = row.campaign_id;
      if (!breakdownByCampaign[id]) breakdownByCampaign[id] = [];
      breakdownByCampaign[id].push(row);
    }
    const leaderboardByCampaign = {};
    for (const row of leaderboard.rows) {
      const id = row.campaign_id;
      if (!leaderboardByCampaign[id]) leaderboardByCampaign[id] = [];
      if (leaderboardByCampaign[id].length < 3) leaderboardByCampaign[id].push(row); // top 3 per campaign
    }

    const campaigns = result.rows.map(r => ({
      ...r,
      channels: breakdownByCampaign[r.campaign_id] || [],
      top_articles: leaderboardByCampaign[r.campaign_id] || [],
    }));

    res.json({ success: true, campaigns });
  } catch(e) {
    console.error('[ANALYTICS/CAMPAIGNS]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/manual', requireAuth, async (req, res) => {
  const { brandProfileId, contentId, channel, impressions, clicks, reactions, comments, reposts } = req.body;
  if (!brandProfileId || !contentId || !channel) {
    return res.status(400).json({ success: false, error: 'brandProfileId, contentId, and channel required' });
  }
  try {
    await pool.query(
      `INSERT INTO content_analytics (brand_profile_id, content_id, channel, impressions, clicks, reactions, comments, reposts, synced_at, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), '{"source":"manual"}')
       ON CONFLICT (content_id, channel)
       DO UPDATE SET
         impressions = GREATEST(content_analytics.impressions, EXCLUDED.impressions),
         clicks = GREATEST(content_analytics.clicks, EXCLUDED.clicks),
         reactions = GREATEST(content_analytics.reactions, EXCLUDED.reactions),
         comments = GREATEST(content_analytics.comments, EXCLUDED.comments),
         reposts = GREATEST(content_analytics.reposts, EXCLUDED.reposts),
         synced_at = NOW(),
         raw_data = jsonb_set(COALESCE(content_analytics.raw_data, '{}'), '{source}', '"manual"')`,
      [brandProfileId, contentId, channel, impressions || 0, clicks || 0, reactions || 0, comments || 0, reposts || 0]
    );
    console.log(`[ANALYTICS] Manual metrics saved: ${channel} for ${contentId} — ${impressions} impr, ${clicks} clicks`);
    res.json({ success: true });
  } catch(e) {
    console.error('[ANALYTICS] Manual save error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/decay/:brandProfileId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM decay_alerts WHERE brand_profile_id = $1 AND status = 'active'
       ORDER BY decay_score DESC`,
      [req.params.brandProfileId]
    );
    res.json({ success: true, alerts: r.rows });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/decay/:brandProfileId/resolve/:contentId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE decay_alerts SET status='resolved', resolved_at=NOW()
       WHERE brand_profile_id=$1 AND content_id=$2`,
      [req.params.brandProfileId, req.params.contentId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

export default router;
