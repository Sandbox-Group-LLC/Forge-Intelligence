// Publishing dispatcher (generate-post-copy + the publish fan-out) — part 3 of 3
// of the publishing subsystem. Mounted at /api/publishing (shares the prefix
// with publishing-queue + publishing-channels). Both routes are open (they do
// inline cron-bypass-OR-Clerk auth via jwtVerify). runScheduledPublishes (the
// scheduled-publish runner) is exported for the cron tick in server.js.
import express from 'express';
import { jwtVerify } from 'jose';
import { createHmac } from 'crypto';
import { pool } from '../db.js';
import { anthropic } from '../llm.js';
import { clerkJWKS, verifyBrandAccess } from '../auth.js';
import { resolveUtmParams, buildUtmString } from '../utm.js';
import { stripSocialMarkdown } from '../text.js';
import { callZernio, zernioPublish, getOrCreateZernioProfile } from '../zernio.js';
import { buildXOAuthHeader, uploadXMedia, refreshXOAuth2Token } from '../x.js';
import { buildGhostJWT } from '../ghost.js';

// Visible TL;DR / Key Takeaway block, prepended to every published article body
// across ALL channels (the AI-citation anchor + skim aid that earns the traction
// Frank's Sandbox-XM articles see). keyTakeaway is generated for every article;
// this surfaces it everywhere — not just Forge's own page + Smart Export.
function tldrHtmlBlock(aj) {
  const t = String(aj?.keyTakeaway || '').trim();
  if (!t) return '';
  // Class-only, NO inline styling. The Site Template scraper's contract is "class
  // names + DOM structure, no styling copied" — the destination site's own
  // .article-tldr CSS owns the look. Inline styles here override that (inline beats
  // class selectors) and shipped an off-brand indigo box onto a dark site.
  return `<aside class="article-tldr"><p class="article-tldr-label">TL;DR</p><p class="article-tldr-body">${t.replace(/</g, '&lt;')}</p></aside>\n`;
}
function tldrMarkdownBlock(aj) {
  const t = String(aj?.keyTakeaway || '').trim();
  return t ? `> **TL;DR** — ${t}\n\n` : '';
}
import { generateHeroImage } from '../images.js';
import { pipedreamProxy } from '../pipedream.js';

const PORT = process.env.PORT || 3000;

const router = express.Router();

router.post('/generate-post-copy', async (req, res) => {
  const { title, headings, readMinutes, articleUrl } = req.body;
  try {
    const copyRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: `Write a LinkedIn post designed to drive link clicks to this B2B article. Goal: make the reader feel they MUST click to get the full answer. Do NOT summarize — create a curiosity gap.

Article title: "${title}"
Sections covered: ${headings || 'not provided'}
Read time: ${readMinutes} min read
Article URL: ${articleUrl}

Structure (follow exactly):
Line 1: One punchy statement of the core tension or counterintuitive insight. Must hook in under 200 characters — this is what shows before 'see more'.
Lines 2-4: 2-3 short lines that deepen the tension or name the specific problem. Do NOT resolve it — leave the answer in the article.
Final line: Exactly this and nothing else: Read more: ${articleUrl}

Hard rules:
- Total post: 500-800 characters including the URL line
- No emojis, no hashtags, no bullet points
- No summarizing the article — create hunger for it
- No ellipsis cutoffs — every sentence complete
- Plain text only

Output only the post text.` }]
    });
    const copy = stripSocialMarkdown(copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '');
    res.json({ success: true, copy });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/publish', async (req, res) => {
  // Allow scheduler to call without user auth via adminPassword
  const isCron = req.body?.adminPassword === process.env.ADMIN_RELAY_PASSWORD;
  if (!isCron) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { payload } = await jwtVerify(authHeader.split(' ')[1], clerkJWKS, { algorithms: ['RS256'], clockTolerance: '30s' });
      req.userId = payload.sub;
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  }
  const startTime = Date.now();
  const { queueItemId, channels: selectedChannels } = req.body;
  if (!queueItemId) return res.status(400).json({ error: 'queueItemId required' });
  try {
    // Load queue item + article
    const queueRes = await pool.query('SELECT * FROM publishing_queue WHERE id = $1', [queueItemId]);
    if (!queueRes.rows.length) return res.status(404).json({ error: 'Queue item not found' });
    const item = queueRes.rows[0];

    const safeId = item.brand_profile_id.replace(/-/g, '_');
    const contentTable = `generated_content_${safeId}`;

    // Article-only queue: load from the per-brand generated_content_* table.
    // (Social-post queue items removed in the May 2 unwind.)
    const contentRes = await pool.query(`SELECT * FROM ${contentTable} WHERE id = $1`, [item.content_id]);
    if (!contentRes.rows.length) return res.status(404).json({ error: 'Article not found' });
    const article = contentRes.rows[0];

    // Load brand profile
    const brandRes = await pool.query('SELECT * FROM brand_profiles WHERE id = $1', [item.brand_profile_id]);
    const brand = brandRes.rows[0] || {};
    const brandSlug = (brand.brand_url || 'brand').replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    const articleSlug = (article.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    // Use BYO domain if configured, otherwise default to Forge article URL
    const articleBaseDomain = process.env.BASE_DOMAIN || 'forgeintelligence.ai';
    const articleBaseUrl = brand.article_base_url
      ? brand.article_base_url.replace(/\/+$/, '')
      : `https://${articleBaseDomain}/articles/${brandSlug}`;
    const articleUrlSuffix = (brand.article_url_suffix || '').trim();
    const forgeArticleUrl = `${articleBaseUrl}/${articleSlug}${articleUrlSuffix}`;

    // Load channel connections for this brand
    const channelsRes = await pool.query(
      'SELECT * FROM publishing_channels WHERE brand_profile_id = $1',
      [item.brand_profile_id]
    );
    const channelMap = {};
    for (const ch of channelsRes.rows) channelMap[ch.channel] = ch;

    const targets = selectedChannels || item.channels || [];
    const results = {};

    // ── Ensure hero image exists before publishing ────────────────────────────
    // Campaign generator doesn't pre-generate images — create one now if missing.
    if (!article.hero_image_url) {
      try {
        const aj = article.article_json || {};
        const sections = aj.sections || [];
        const firstBody = (sections[0]?.body || sections[0]?.content || '').slice(0, 300);
        const imgPromptRes = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: `Write a Flux image generation prompt for a B2B editorial hero image for this article: "${article.title}". Context: ${firstBody}. Output only the prompt, no quotes, no preamble. Professional photography style, 16:9, no text in image.` }]
        });
        const fluxPrompt = imgPromptRes.content[0]?.type === 'text'
          ? imgPromptRes.content[0].text.trim()
          : `Professional B2B editorial hero image for: ${article.title}`;

        const imageUrl = await generateHeroImage(fluxPrompt);
        await pool.query(
          `UPDATE ${contentTable} SET hero_image_url = $1, hero_image_prompt = $2, updated_at = NOW() WHERE id = $3`,
          [imageUrl, fluxPrompt, article.id]
        );
        article.hero_image_url = imageUrl;
        console.log(`[PUBLISH] Generated hero image for "${article.title}"`);
      } catch (imgErr) {
        console.warn('[PUBLISH] Hero image generation failed, continuing without:', imgErr.message);
        // Non-fatal — publish continues without image
      }
    }

    // Load existing publish_log entries for this queue item — used to skip already-published channels.
    // Critical: also require live_status to still be live. After an unpublish, status stays
    // 'published' (it really did publish, that's history) but live_status flips to 'deleted'.
    // The old query (status='published' alone) treated unpublished-then-republished targets as
    // duplicates and silently skipped them with a fake "Already published" response — the toast
    // would say success but nothing actually hit the channel.
    const existingLogRes = await pool.query(
      `SELECT channel FROM publish_log
       WHERE queue_item_id = $1
         AND status = 'published'
         AND (live_status IS NULL OR live_status = 'published')`,
      [queueItemId]
    ).catch(() => ({ rows: [] }));
    const alreadyPublished = new Set(existingLogRes.rows.map(r => r.channel));

    for (const channel of targets) {
      const chConfig = channelMap[channel];
      if (!chConfig) { results[channel] = { status: 'error', error: 'Channel not connected' }; continue; }

      // Skip channels already successfully published — prevents double-posting.
      // Pull the prior published URL from the publish_log so the response object has
      // it (FE needs url to render the View post link). Without this, the response
      // object has no url for the skipped channel and the FE falls back to no-link.
      if (alreadyPublished.has(channel)) {
        let priorUrl = null;
        try {
          const pr = await pool.query(
            `SELECT published_url FROM publish_log
             WHERE queue_item_id = $1 AND channel = $2 AND status = 'published'
             ORDER BY attempted_at DESC LIMIT 1`,
            [queueItemId, channel]
          );
          priorUrl = pr.rows[0]?.published_url || null;
        } catch {}
        results[channel] = {
          status: 'published',
          skipped: true,
          message: 'Already published to this channel',
          ...(priorUrl ? { url: priorUrl } : {}),
        };
        continue;
      }

      // campaign_id is a UUID — derive a readable slug from the queue item's campaign_id
      // Fall back to the campaigns table name if we have it, otherwise use the UUID prefix
      let campaignSlug = 'forge-content';
      if (item.campaign_id) {
        try {
          const campRow = await pool.query('SELECT name FROM campaigns WHERE id = $1', [item.campaign_id]);
          campaignSlug = campRow.rows[0]?.name
            ? campRow.rows[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
            : item.campaign_id.split('-')[0];
        } catch { campaignSlug = item.campaign_id.split('-')[0]; }
      }
      const utmCtx = { channel, brandSlug, articleSlug, campaignSlug };
      // Default UTM template if channel has none configured
      const defaultUtmTemplate = {
        utm_source: '{channel}',
        utm_medium: 'social',
        utm_campaign: '{campaign_slug}',
        utm_content: '{article_slug}'
      };
      // utm_template may come back as a string from DB — parse if needed
      let rawTemplate = chConfig.utm_template;
      if (typeof rawTemplate === 'string') {
        try { rawTemplate = JSON.parse(rawTemplate); } catch { rawTemplate = {}; }
      }
      const utmTemplate = (rawTemplate && Object.keys(rawTemplate).length > 0)
        ? rawTemplate
        : defaultUtmTemplate;
      const utmParams = resolveUtmParams(utmTemplate, utmCtx);
      const utmString = buildUtmString(utmParams);

      const creds = chConfig.credentials || {};

      try {
        if (channel === 'wordpress') {
          // ── Real WordPress REST API publish ──
          const wpUrl = creds.siteUrl?.replace(/\/+$/, '');
          if (!wpUrl || !creds.username || !creds.appPassword) throw new Error('Missing WordPress credentials');

          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const htmlContent = tldrHtmlBlock(articleJson) + sections.map(s =>
            `${s.heading ? `<h2>${s.heading}</h2>` : ''}<p>${s.body || s.content || ''}</p>`
          ).join('\n');

          const authHeader = 'Basic ' + Buffer.from(`${creds.username}:${creds.appPassword}`).toString('base64');
          const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: article.title,
              content: htmlContent + (utmString ? `\n<!-- UTM: ${utmString} -->` : ''),
              status: 'publish',
              excerpt: sections[0]?.content?.slice(0, 160) || '',
              meta: { forge_utm: utmString, forge_brain: item.brand_profile_id }
            })
          });
          const wpData = await wpRes.json();
          if (!wpRes.ok) throw new Error(wpData.message || 'WordPress publish failed');
          results[channel] = { status: 'published', url: wpData.link, postId: wpData.id, utmParams };

        } else if (channel === 'webflow') {
          // ── Real Webflow CMS publish ──
          const webflowToken = creds.accessToken || creds.apiToken;
          const siteId = creds.selectedSite?.id || creds.siteId;
          const collectionId = creds.selectedCollection?.id || creds.collectionId;
          if (!webflowToken) throw new Error('Webflow not connected — visit Integrations to authorize via OAuth');
          if (!siteId) throw new Error('Webflow site not selected — visit Integrations to pick a site');
          if (!collectionId) throw new Error('Webflow collection not selected — visit Integrations to pick a collection');

          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const bodyHtml = tldrHtmlBlock(articleJson) + sections.map(s =>
            `${s.heading ? `<h2>${s.heading}</h2>` : ''}<p>${s.body || s.content || ''}</p>`
          ).join('\n');
          const excerpt = (sections[0]?.body || sections[0]?.content || '').slice(0, 160);
          const slug = (article.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

          const wfRes = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${webflowToken}`,
              'Content-Type': 'application/json',
              'accept-version': '1.0.0'
            },
            body: JSON.stringify({
              isArchived: false,
              isDraft: false,
              fieldData: {
                name: article.title || 'Untitled',
                slug,
                excerpt,
                body: bodyHtml,
                'published-on': new Date().toISOString(),
                category: articleJson.category || 'Thought Leadership',
                'forge-utm': utmString,
                'forge-brain-id': item.brand_profile_id,
              }
            })
          });
          const wfData = await wfRes.json();
          if (!wfRes.ok) throw new Error(wfData.message || JSON.stringify(wfData));
          // Build Webflow URL from site info or item response
          // Prefer explicit customDomain, then shortName, then fall back to site ID
          const wfSiteDomain = creds.selectedSite?.customDomain
            || (creds.selectedSite?.shortName ? `${creds.selectedSite.shortName}.webflow.io` : null)
            || siteId;
          // Webflow CMS URLs are just domain/article-slug — collection slug is internal, not in the URL
          const publishedUrl = `https://${wfSiteDomain}/${slug}`;
          results[channel] = { status: 'published', url: publishedUrl, itemId: wfData.id, utmParams };

        } else if (channel === 'hubspot') {
          results[channel] = { status: 'staged', message: 'HubSpot: credentials saved, live API wired in Stage 6.1', utmParams };

        } else if (channel === 'linkedin') {
          // ── Zernio-routed LinkedIn publish (preferred) ──
          // If this brand has been migrated to Zernio (zernioAccountId set on the
          // channel credentials), route through Zernio's API. Otherwise fall through
          // to the legacy direct LinkedIn UGC Posts API. Per-brand opt-in.
          if (creds.zernioAccountId) {
            try {
              const articleJson = article.article_json || {};
              const sections = articleJson.sections || [];
              const postCopyOverride = (req.body.postCopy || {})[channel];
              const articleUrl = `${forgeArticleUrl}${utmString ? '?' + utmString : ''}`;

              // Generate post copy the same way as the legacy path so behavior matches.
              let postText = postCopyOverride;
              if (!postText) {
                const wordCount = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
                const readMinutes = Math.max(2, Math.round(wordCount / 200));
                const sectionHeadings = sections.slice(1, 5).map(s => s.heading).filter(Boolean).join(', ');
                try {
                  const copyRes = await anthropic.messages.create({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 400,
                    messages: [{ role: 'user', content: `Write a LinkedIn post designed to drive link clicks to this B2B article. Goal: make the reader feel they MUST click to get the full answer. Do NOT summarize — create a curiosity gap.

Article title: "${article.title}"
Key sections covered: ${sectionHeadings}
Read time: ${readMinutes} min read

Structure (follow exactly):
Line 1: One punchy statement of the core tension or counterintuitive insight. Must hook in under 200 characters — this is what shows before 'see more'.
Lines 2-4: 2-3 short lines that deepen the tension or name the specific problem. Do NOT resolve it — leave the answer in the article.
Final line: Exactly this and nothing else: Read more: ${articleUrl}

Hard rules:
- Total post: 500-800 characters including the URL line
- No emojis, no hashtags, no bullet points
- No summarizing the article — create hunger for it
- No ellipsis cutoffs — every sentence complete
- Plain text only, no markdown

Output only the post text.` }]
                  });
                  postText = stripSocialMarkdown(copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '');
                } catch(e) {
                  postText = `${article.title}\n\n${sections.slice(0,3).map(s => s.heading).filter(Boolean).join(' · ')}\n\nRead more: ${articleUrl}`;
                }
              }

              const zr = await zernioPublish({
                platform: 'linkedin',
                accountId: creds.zernioAccountId,
                content: postText
              });
              results[channel] = {
                status: 'published',
                url: zr.postUrl,
                postId: zr.postId,
                // Zernio's internal _id — needed by analytics sync for Zernio lookups
                zernioPostId: zr.zernioPostId,
                via: 'zernio',
                utmParams
              };
              // Write publish_log entry HERE (the one at the end of the for-loop body
              // is skipped by `continue` below). Without this, publish_log stays empty
              // for Zernio publishes — breaking analytics sync, unpublish, and the
              // 'Live'/'Deleted' chips in the queue UI that read from publish_log.
              await pool.query(
                `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                  queueItemId, item.brand_profile_id, item.content_id, channel,
                  'published',
                  JSON.stringify(results[channel]),
                  JSON.stringify(utmParams),
                  zr.postUrl,
                  null
                ]
              ).catch(e => console.error('[PUBLISH] zernio publish_log insert failed:', e.message));
              continue;  // skip the legacy direct-API code below
            } catch (zerr) {
              // Zernio failed — record the error and fall through to legacy path so we have a fallback.
              // If creds.zernioOnly is set, throw instead of falling through.
              if (creds.zernioOnly) {
                throw zerr;
              }
              console.warn(`[PUBLISH] Zernio LinkedIn publish failed, falling back to direct API: ${zerr.message}`);
              // continue into legacy block below
            }
          }

          // ── Legacy direct LinkedIn UGC Posts API (fallback) ──
          const liToken   = creds.accessToken || process.env.LINKEDIN_ACCESS_TOKEN;
          const authorUrn = creds.authorUrn   || process.env.LINKEDIN_AUTHOR_URN;
          if (!liToken || !authorUrn) {
            results[channel] = { status: 'staged', message: 'LinkedIn not yet authorized — visit /app/integrations to connect', utmParams };
          } else {
            const articleJson = article.article_json || {};
            const sections = articleJson.sections || [];
            const postCopyOverride = (req.body.postCopy || {})[channel];
            const articleUrl = `${forgeArticleUrl}${utmString ? '?' + utmString : ''}`;

            // Generate or use provided post copy
            let postText = postCopyOverride;
            if (!postText) {
              const wordCount = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
              const readMinutes = Math.max(2, Math.round(wordCount / 200));
              const sectionHeadings = sections.slice(1, 5).map(s => s.heading).filter(Boolean).join(', ');
              try {
                const copyRes = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 400,
                  messages: [{ role: 'user', content: `Write a LinkedIn post designed to drive link clicks to this B2B article. Goal: make the reader feel they MUST click to get the full answer. Do NOT summarize — create a curiosity gap.

Article title: "${article.title}"
Key sections covered: ${sectionHeadings}
Read time: ${readMinutes} min read

Structure (follow exactly):
Line 1: One punchy statement of the core tension or counterintuitive insight. Must hook in under 200 characters — this is what shows before 'see more'.
Lines 2-4: 2-3 short lines that deepen the tension or name the specific problem. Do NOT resolve it — leave the answer in the article.
Final line: Exactly this and nothing else: Read more: ${articleUrl}

Hard rules:
- Total post: 500-800 characters including the URL line
- No emojis, no hashtags, no bullet points
- No summarizing the article — create hunger for it
- No ellipsis cutoffs — every sentence complete
- Plain text only, no markdown

Output only the post text.` }]
                });
                postText = stripSocialMarkdown(copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '');
              } catch(e) {
                const wordCount2 = sections.reduce((acc, s) => acc + ((s.body || s.content || '').split(' ').length), 0);
                const readMin = Math.max(2, Math.round(wordCount2 / 200));
                postText = `${article.title}\n\n${sections.slice(0,3).map(s => s.heading).filter(Boolean).join(' · ')}\n\n${readMin} min read\n\nRead more: ${articleUrl}`;
              }
            }

            const liRes = await fetch('https://api.linkedin.com/v2/ugcPosts', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${liToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
              body: JSON.stringify({
                author: authorUrn,
                lifecycleState: 'PUBLISHED',
                specificContent: {
                  'com.linkedin.ugc.ShareContent': {
                    shareCommentary: { text: postText },
                    shareMediaCategory: 'ARTICLE',
                    media: [{ status: 'READY', originalUrl: articleUrl, title: { text: article.title || 'New Article' } }]
                  }
                },
                visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
              })
            });
            const liData = await liRes.json();
            if (!liRes.ok) throw new Error(liData.message || JSON.stringify(liData));
            const postId = liData.id?.replace('urn:li:ugcPost:', '');
            const postUrl = `https://www.linkedin.com/feed/update/${liData.id}/`;
            results[channel] = { status: 'published', url: postUrl, postId: liData.id, utmParams };
          }

        } else if (channel === 'x') {
          // ── X (Twitter) API v2 publish — OAuth 2.0 preferred, 1.0a fallback ──
          const articleUrl = forgeArticleUrl;
          const fullTweetUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

          // Priority 1: user-edited/generated post copy from the UI (postCopy[channel]).
          // Priority 2: fallback to a trimmed title + URL that fits X's 280-char limit.
          //
          // X length math note: X auto-wraps every URL into t.co, which counts as exactly
          // 23 characters in X's tweet length count regardless of the real URL length.
          // So we compute X-equivalent length by replacing every URL with 23 placeholder
          // chars before measuring — otherwise long UTM-laden URLs (200+ chars) make our
          // math think the title has zero room and we ship "GE" + URL or just a bare URL.
          const URL_RE = /https?:\/\/[^\s]+/g;
          const xLen = (s) => s.replace(URL_RE, 'x'.repeat(23)).length;
          const X_URL_COST = 23;

          const postCopyOverride = (req.body.postCopy || {})[channel];
          let tweetText;
          if (postCopyOverride && postCopyOverride.trim()) {
            tweetText = postCopyOverride.trim();
            // Hard enforce 280 limit using X-aware character counting
            if (xLen(tweetText) > 280) {
              console.warn(`[X] Post copy was ${xLen(tweetText)} X-chars, truncating to 280`);
              // Find the LAST URL in the text — typically at end after "\n\nRead more: "
              const urls = [...tweetText.matchAll(URL_RE)];
              const lastUrlMatch = urls[urls.length - 1];
              if (lastUrlMatch && lastUrlMatch.index > 0) {
                const urlPart = lastUrlMatch[0];
                const bodyPart = tweetText.slice(0, lastUrlMatch.index).trim();
                const maxBody = 280 - X_URL_COST - 2; // 2 for \n\n separator
                tweetText = bodyPart.slice(0, Math.max(0, maxBody)).trim() + '\n\n' + urlPart;
              } else {
                tweetText = tweetText.slice(0, 277) + '...';
              }
            }
          } else {
            // Fallback — title-first, fits under 280. Use X_URL_COST not the raw URL length.
            const titleMax = 280 - X_URL_COST - 2; // 2 for \n\n separator
            const titleTrimmed = (article.title || '').slice(0, Math.max(0, titleMax));
            tweetText = `${titleTrimmed}\n\n${fullTweetUrl}`;
          }
          const tweetEndpoint = 'https://api.twitter.com/2/tweets';

          let authHeader;
          let twitterHandle = creds.username || 'i';

          if (creds.oauth2AccessToken) {
            // OAuth 2.0 path (preferred — from Connect flow)
            let token = creds.oauth2AccessToken;
            // Try posting; if 401, refresh and retry
            let xRes = await fetch(tweetEndpoint, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: tweetText })
            });
            if (xRes.status === 401 && creds.oauth2RefreshToken) {
              try {
                const refreshed = await refreshXOAuth2Token(creds.oauth2RefreshToken);
                token = refreshed.access_token;
                // Update stored tokens
                await pool.query(
                  `UPDATE publishing_channels SET credentials = credentials || $1 WHERE brand_profile_id = $2 AND channel = 'x'`,
                  [JSON.stringify({ oauth2AccessToken: refreshed.access_token, oauth2RefreshToken: refreshed.refresh_token || creds.oauth2RefreshToken }), item.brand_profile_id]
                );
                xRes = await fetch(tweetEndpoint, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: tweetText })
                });
              } catch(e) {
                console.error('[X] Token refresh failed:', e.message);
                // Invalid refresh token — clear tokens so user is prompted to reconnect
                if (e.message && (e.message.includes('invalid') || e.message.includes('revoked') || e.message.includes('expired'))) {
                  await pool.query(
                    `UPDATE publishing_channels SET credentials = credentials - 'oauth2AccessToken' - 'oauth2RefreshToken' WHERE brand_profile_id = $1 AND channel = 'x'`,
                    [item.brand_profile_id]
                  ).catch(() => {});
                  console.error(`[X] Cleared expired tokens for brand ${item.brand_profile_id} — user must reconnect`);
                  throw new Error('X authentication expired. Please reconnect X in Integrations.');
                }
                throw e;
              }
            }
            const xData = await xRes.json();
            if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
            const tweetId = xData.data?.id;
            const tweetUrl2 = `https://x.com/${twitterHandle}/status/${tweetId}`;
            results[channel] = { status: 'published', url: tweetUrl2, tweetId, utmParams };
          } else {
            // OAuth 1.0a fallback (legacy manual tokens)
            const xApiKey       = creds.apiKey       || process.env.X_OAUTH1CONSUMER_KEY;
            const xApiSecret    = creds.apiSecret    || process.env.X_OAUTH1CONSUMER_SECRET;
            const xAccessToken  = creds.accessToken  || process.env.X_OAUTH1ACCESS_TOKEN;
            const xAccessSecret = creds.accessSecret || process.env.X_OAUTH1ACCESS_SECRET;
            if (!xApiKey || !xApiSecret || !xAccessToken || !xAccessSecret) throw new Error('Missing X credentials — use Connect X to authorize');
            authHeader = buildXOAuthHeader('POST', tweetEndpoint, xApiKey, xApiSecret, xAccessToken, xAccessSecret);
            const xRes = await fetch(tweetEndpoint, {
              method: 'POST',
              headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: tweetText })
            });
            const xData = await xRes.json();
            if (!xRes.ok) throw new Error(xData.detail || xData.title || JSON.stringify(xData));
            const tweetId = xData.data?.id;
            try {
              const meRes = await fetch('https://api.twitter.com/2/users/me', { headers: { 'Authorization': authHeader } });
              if (meRes.ok) { twitterHandle = (await meRes.json()).data?.username || 'i'; }
            } catch(e) {}
            const tweetUrl2 = `https://x.com/${twitterHandle}/status/${tweetId}`;
            results[channel] = { status: 'published', url: tweetUrl2, tweetId, utmParams };
          }

        } else if (channel === 'facebook') {
          const creds = chConfig.credentials || {};

          // ── Priority 0: Zernio publish path ──
          if (creds.zernioAccountId) {
            const articleUrl = forgeArticleUrl;
            const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;
            const fbPostCopyOverride = (req.body.postCopy || {})[channel];
            let fbMessage;
            if (fbPostCopyOverride && fbPostCopyOverride.trim()) {
              fbMessage = fbPostCopyOverride.trim();
            } else {
              fbMessage = `${article.title}\n\n${utmUrl}`;
              try {
                const haiku = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 600,
                  messages: [{ role: 'user', content: `Write a compelling Facebook post for a company page promoting this article. 2–3 short paragraphs. No hashtag spam — max 3 relevant tags. Include the URL ${utmUrl} naturally.\n\nPlain text only — Facebook does not render markdown. Do not use # for headings or **double asterisks** for emphasis.\n\nArticle title: ${article.title}\n\nArticle excerpt: ${(article.article_json?.sections?.[0]?.body || '').slice(0, 500)}` }]
                });
                fbMessage = stripSocialMarkdown(haiku.content[0]?.text) || fbMessage;
              } catch(e) {
                console.warn('[FB-ZERNIO] Haiku post copy failed:', e.message);
              }
            }

            try {
              const zr = await zernioPublish({
                platform: 'facebook',
                accountId: creds.zernioAccountId,
                content: fbMessage
              });
              results[channel] = {
                status: 'published',
                url: zr.postUrl,
                postId: zr.postId,
                // Zernio's internal _id — needed by analytics sync for Zernio lookups.
                // Zernio's /analytics endpoint expects this, NOT the Facebook platform URN
                // (pageId_postId). Without it, the sync hits 404 on every Zernio-published
                // Facebook post — which is what was happening before this was added.
                zernioPostId: zr.zernioPostId,
                via: 'zernio',
                utmParams
              };
              await pool.query(
                `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [queueItemId, item.brand_profile_id, item.content_id, channel, 'published',
                 JSON.stringify(results[channel]), JSON.stringify(utmParams), zr.postUrl, null]
              ).catch(e => console.error('[PUBLISH] zernio facebook publish_log insert failed:', e.message));
              continue;
            } catch(zerr) {
              if (creds.zernioOnly || creds.provider === 'zernio') {
                throw new Error(`Facebook via Zernio: ${zerr.message}`);
              }
              console.error('[FB-ZERNIO] Failed, falling through to legacy:', zerr.message);
            }
          }

          // ── Legacy: Pipedream / direct Graph API paths ──
          const pipedreamAccountId = creds.pipedream_account_id;

          // ─── Priority 1: Pipedream workflow URL (global env var, multi-tenant) ───
          // Pipedream's connector AI builder gave us a workflow URL that uses the right
          // Facebook Pages connector with proper scopes. The workflow URL is global Forge
          // infrastructure (env var, not per-brand) — every customer's publish hits the same
          // URL. Pipedream looks up which customer's stored Facebook OAuth tokens to use via
          // the x-pd-external-user-id header (which is the brand_profile_id, set during the
          // existing Connect flow when the customer authorized Pipedream's pre-approved app).
          const pipedreamWorkflowUrl = process.env.FACEBOOK_PIPEDREAM_WORKFLOW_URL;
          if (pipedreamWorkflowUrl && pipedreamAccountId) {
            const articleUrlWf = forgeArticleUrl;
            const utmUrlWf = `${articleUrlWf}${utmString ? '?' + utmString : ''}`;
            const fbPostCopyOverrideWf = (req.body.postCopy || {})[channel];
            let fbMessageWf;
            if (fbPostCopyOverrideWf && fbPostCopyOverrideWf.trim()) {
              fbMessageWf = fbPostCopyOverrideWf.trim();
            } else {
              fbMessageWf = `${article.title}\n\n${utmUrlWf}`;
              try {
                const haiku = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 600,
                  messages: [{ role: 'user', content: `Write a compelling Facebook post for a company page promoting this article. 2–3 short paragraphs. No hashtag spam — max 3 relevant tags. Include the URL ${utmUrlWf} naturally.\n\nPlain text only — Facebook does not render markdown. Do not use # for headings or **double asterisks** for emphasis.\n\nArticle title: ${article.title}\n\nArticle excerpt: ${(article.article_json?.sections?.[0]?.body || '').slice(0, 500)}` }]
                });
                fbMessageWf = stripSocialMarkdown(haiku.content[0]?.text) || fbMessageWf;
              } catch (e) {
                console.warn('[FB] Haiku post copy failed:', e.message);
              }
            }
            try {
              // Pipedream Connect lookup: x-pd-external-user-id tells Pipedream which customer's
              // stored OAuth credentials to use when the workflow's Facebook step fires.
              // pageId comes from creds.pageId (set when customer picked a Page after OAuth).
              const wfRes = await fetch(pipedreamWorkflowUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-pd-external-user-id': item.brand_profile_id,
                  'x-pd-environment': process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'production',
                },
                body: JSON.stringify({
                  pageId: creds.pageId || null,
                  title: article.title,
                  message: fbMessageWf,
                  link: utmUrlWf,
                  forgeMeta: { brandProfileId: item.brand_profile_id, contentId: item.content_id, queueItemId: queueItemId, publishedAt: new Date().toISOString() }
                }),
              });
              const wfData = await wfRes.json().catch(() => ({}));
              if (!wfRes.ok || wfData.error || wfData.success === false) {
                throw new Error(wfData.error || wfData.message || `Pipedream workflow returned ${wfRes.status}`);
              }
              const fbPostId = wfData.postId || wfData.id || null;
              const fbPostUrl = wfData.url || (fbPostId ? `https://facebook.com/${fbPostId}` : null);
              results[channel] = { status: 'published', postId: fbPostId, url: fbPostUrl, utmParams, via: 'pipedream-workflow' };
              continue;  // skip the legacy path — we've already published via workflow
            } catch(e) {
              console.error('[FB-WORKFLOW]', e.message);
              throw new Error(e.message);
            }
          }

          // Legacy path: pipedreamProxy via Pipedream Connect (existing infrastructure) — falls through if no workflow URL.
                    
          const articleUrl = forgeArticleUrl;
          const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

          // Priority 1: user-edited/generated post copy from the UI.
          // Priority 2: generate via Haiku at publish time.
          // Priority 3 (fallback): title + URL.
          const fbPostCopyOverride = (req.body.postCopy || {})[channel];
          let fbMessage;
          if (fbPostCopyOverride && fbPostCopyOverride.trim()) {
            fbMessage = fbPostCopyOverride.trim();
          } else {
            fbMessage = `${article.title}\n\n${utmUrl}`;
            try {
              const haiku = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                messages: [{
                  role: 'user',
                  content: `Write a compelling Facebook post for a company page promoting this article. 2–3 short paragraphs. No hashtag spam — max 3 relevant tags. Include the URL on its own line at the end.\n\nPlain text only — Facebook does not render markdown. Do not use # for headings or **double asterisks** for emphasis.\n\nArticle title: ${article.title}\nArticle URL: ${utmUrl}`
                }]
              });
              fbMessage = stripSocialMarkdown(haiku.content[0]?.text) || fbMessage;
            } catch (e) {
              console.warn('[FB] Haiku post copy failed, using fallback:', e.message);
            }
          }

          if (pipedreamAccountId) {
            // Pipedream Connect path — post directly to stored page ID via proxy.
            // Pipedream holds the page access token from the OAuth consent flow.
            // We do NOT call /me/accounts — that requires permissions Pipedream's built-in app doesn't have.
            try {
              const pageId = creds.pageId;
              if (!pageId) {
                throw new Error('No Facebook Page ID configured. Go to Integrations → Facebook → select a page.');
              }
              console.log('[FB-PIPEDREAM] Publishing to page', pageId, 'via proxy account', pipedreamAccountId);

              // Post directly to /{pageId}/feed — Pipedream proxy injects the page token
              const fbRes = await pipedreamProxy({
                externalUserId: item.brand_profile_id,
                accountId: pipedreamAccountId,
                url: `https://graph.facebook.com/v21.0/${pageId}/feed`,
                method: 'POST',
                data: { message: fbMessage, link: utmUrl },
              });

              console.log('[FB-PIPEDREAM] Post response:', JSON.stringify(fbRes).slice(0, 300));
              if (fbRes.error) throw new Error(fbRes.error.message || 'Facebook publish failed');
              const fbPostId = fbRes.id || fbRes.post_id;
              results[channel] = { status: 'published', postId: fbPostId, url: `https://facebook.com/${fbPostId}`, utmParams };
              
              // Page ID is set via Integrations page picker (/api/facebook/pipedream/select-page), no runtime discovery needed.
            } catch(e) {
              console.error('[FB-PIPEDREAM]', e.message);
              throw new Error(e.message);
            }
          } else {
            // Legacy native path — direct pageId + pageAccessToken
            const { pageId, pageAccessToken } = creds;
            if (!pageId || !pageAccessToken) throw new Error('Facebook not connected. Connect via Pipedream in Integrations.');
            
            const fbRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: fbMessage, link: utmUrl, access_token: pageAccessToken })
            });
            const fbData = await fbRes.json();
            if (!fbRes.ok || fbData.error) throw new Error(fbData.error?.message || 'Facebook publish failed');
            const fbPostUrl = `https://www.facebook.com/${fbData.id?.replace('_', '/posts/')}`;
            results[channel] = { status: 'published', url: fbPostUrl, postId: fbData.id, utmParams };
          }

        } else if (channel === 'reddit') {
          // ── Reddit publish via Zernio — brand-owned subreddits ONLY ──
          // Reddit is NOT like LinkedIn/Facebook. The destination is per-post and
          // posting to the wrong sub gets brands banned. So we enforce two rules:
          //   1) The brand must have an allowedSubreddits[] in their channel creds,
          //      populated via the Integrations UI. Each entry is a subreddit name
          //      the brand has explicit permission to post in (typically subs they mod
          //      or actively contribute to).
          //   2) The publish call must specify which subreddit from that allowlist
          //      to target this time (publishOptions.reddit.subreddit). If unspecified,
          //      we default to the FIRST allowed subreddit.
          //
          // Anything outside the allowlist is rejected with a clear error so brands
          // can't accidentally post to r/marketing or any random sub Zernio might
          // have a default for.

          if (!creds.zernioAccountId) {
            throw new Error('Reddit must be connected via Zernio. Visit /app/integrations to connect.');
          }

          const allowedSubreddits = Array.isArray(creds.allowedSubreddits) ? creds.allowedSubreddits.filter(Boolean) : [];
          if (allowedSubreddits.length === 0) {
            throw new Error('No allowed subreddits configured. Add subreddits you have permission to post in under Integrations → Reddit → Allowed subreddits.');
          }

          // Per-publish target selection. Order of precedence:
          //   1) req.body.publishOptions.reddit.subreddit (per-publish picker, future Phase 4)
          //   2) creds.defaultSubreddit (brand default set in Integrations)
          //   3) first entry in allowedSubreddits (sane fallback)
          const requestedSub = (req.body.publishOptions?.reddit?.subreddit || creds.defaultSubreddit || allowedSubreddits[0] || '').replace(/^r\//, '');
          if (!allowedSubreddits.map(s => s.replace(/^r\//, '')).includes(requestedSub)) {
            throw new Error(`Subreddit '${requestedSub}' is not in your allowed list. Add it under Integrations → Reddit → Allowed subreddits before publishing.`);
          }

          const articleUrl = forgeArticleUrl;
          const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

          // For Reddit link posts, `content` is the post TITLE (not a body). Reddit titles
          // are permanent and capped at 300 chars. The article URL handles the rest — Reddit
          // fetches OG preview from it. No Haiku body generation needed for link posts.
          //
          // User override flow: if postCopy[reddit] is set, use its first line as the title.
          // Otherwise default to the article title verbatim.
          const postCopyOverride = (req.body.postCopy || {})[channel];
          const redditTitle = (postCopyOverride && postCopyOverride.trim().split('\n')[0].slice(0, 300)) || (article.title || '').slice(0, 300);
          let redditText = redditTitle;  // back-compat name in case anything below references it

          // Skip Haiku generation — link post only needs the title.
          if (false) {
            const articleJson = article.article_json || {};
            const sections = articleJson.sections || [];
            try {
              const copyRes = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                messages: [{ role: 'user', content: `Write a Reddit text-post body for r/${requestedSub} promoting this article. Format: 2-3 short paragraphs that introduce the core insight without giving away the answer. End with a single line: "Full breakdown: ${utmUrl}"\n\nTone: conversational, like a practitioner sharing what they learned, NOT corporate marketing. No hashtags, no emojis, no headlines, no marketing-speak.\n\nArticle title: ${article.title}\nKey sections: ${sections.slice(1,4).map(s => s.heading).filter(Boolean).join(', ')}\n\nOutput only the post body, plain text.` }]
              });
              redditText = copyRes.content[0]?.type === 'text' ? copyRes.content[0].text.trim() : '';
            } catch(e) {
              console.warn('[REDDIT-ZERNIO] Haiku post copy failed:', e.message);
              redditText = `${article.title}\n\n${utmUrl}`;
            }
          }

          // Zernio's /posts API for Reddit takes the subreddit via platformSpecificData.
          // We can't use zernioPublish() helper because Reddit needs platformSpecificData;
          // inline the callZernio() request. See Zernio_API_Docs L9430+ for Reddit schema:
          // when platformSpecificData.url is set, content becomes the post title (link post).
          // For text posts, omit url and content's first line becomes the title.
          try {
            const zResult = await callZernio('POST', '/posts', {
              content: redditTitle,
              publishNow: true,
              platforms: [{
                platform: 'reddit',
                accountId: creds.zernioAccountId,
                platformSpecificData: {
                  subreddit: requestedSub,
                  url: utmUrl  // presence of url makes this a link post; content becomes the title
                }
              }]
            });

            if (!zResult.ok) {
              throw new Error(`Zernio reddit publish failed (${zResult.status}): ${zResult.raw?.slice(0, 300) || 'no body'}`);
            }
            const post = zResult.parsed?.post;
            const platformResult = (post?.platforms || []).find(p => p.platform === 'reddit');
            if (!platformResult || platformResult.status !== 'published') {
              const errMsg = platformResult?.error || platformResult?.platformSpecificData?.lastError || 'Zernio did not publish';
              throw new Error(`Reddit (Zernio): ${errMsg}`);
            }

            results[channel] = {
              status: 'published',
              url: platformResult.platformPostUrl,
              postId: platformResult.platformPostId || post._id,
              subreddit: requestedSub,
              via: 'zernio',
              utmParams
            };

            // Write publish_log inside the dispatch (continue skips the loop-end writer).
            await pool.query(
              `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                queueItemId, item.brand_profile_id, item.content_id, channel,
                'published',
                JSON.stringify(results[channel]),
                JSON.stringify(utmParams),
                platformResult.platformPostUrl,
                null
              ]
            ).catch(e => console.error('[PUBLISH] reddit zernio publish_log insert failed:', e.message));
            continue;
          } catch (rzerr) {
            // No fallback for Reddit — if Zernio fails, the publish fails. We don't have
            // direct OAuth tokens for migrated brands, and even if we did, the brand-owned
            // allowlist guarantee would still be the right safety bound.
            throw rzerr;
          }

        } else if (channel === 'medium') {
          // ── Medium API publish ──
          const { integrationToken } = chConfig.credentials || {};
          if (!integrationToken) throw new Error('Medium integration token is required');

          // Get the authenticated user's Medium ID
          const meRes = await fetch('https://api.medium.com/v1/me', {
            headers: { 'Authorization': `Bearer ${integrationToken}`, 'Content-Type': 'application/json' }
          });
          if (!meRes.ok) throw new Error('Medium token invalid or expired');
          const meData = await meRes.json();
          const authorId = meData.data?.id;
          if (!authorId) throw new Error('Could not retrieve Medium author ID');

          const articleUrl = forgeArticleUrl;
          const utmUrl = `${articleUrl}${utmString ? '?' + utmString : ''}`;

          // Build HTML content from article sections
          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const htmlBody = tldrHtmlBlock(articleJson) + sections.map(s =>
            `<h2>${s.heading || ''}</h2><p>${(s.body || '').split('\n').join('</p><p>')}</p>`
          ).join('\n');

          const canonicalNote = `<p><em>Originally published at <a href="${utmUrl}">${process.env.BASE_DOMAIN || 'forgeintelligence.ai'}</a></em></p>`;

          const medRes = await fetch(`https://api.medium.com/v1/users/${authorId}/posts`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${integrationToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: article.title,
              contentFormat: 'html',
              content: `<h1>${article.title}</h1>
${htmlBody}
${canonicalNote}`,
              canonicalUrl: utmUrl,
              publishStatus: 'public',
              notifyFollowers: true,
            })
          });
          const medData = await medRes.json();
          if (!medRes.ok || medData.errors) throw new Error(medData.errors?.[0]?.message || 'Medium publish failed');

          results[channel] = { status: 'published', url: medData.data?.url, postId: medData.data?.id, utmParams };

        } else if (channel === 'ghost') {
          // ── Ghost Admin API publish ──
          // Ghost uses JWT auth derived from the Admin API key (format: id:secret)
          const { adminUrl, adminApiKey } = chConfig.credentials || {};
          if (!adminUrl || !adminApiKey) throw new Error('Ghost Admin URL and Admin API Key are required');

          const [keyId, keySecret] = adminApiKey.split(':');
          if (!keyId || !keySecret) throw new Error('Admin API Key must be in format id:secret — copy it directly from Ghost Admin');

          // Build JWT — Ghost uses HS256 with the hex secret decoded to bytes
          const now = Math.floor(Date.now() / 1000);
          const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
          const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
          const secretBytes = Buffer.from(keySecret, 'hex');
          const sig = createHmac('sha256', secretBytes)
            .update(`${header}.${payload}`)
            .digest('base64url');
          const ghostJwt = `${header}.${payload}.${sig}`;

          const ghostBase = adminUrl.replace(/\/+$/, '');
          const articleUrl = forgeArticleUrl;
          // Use resolved utmParams (utm_source, utm_medium, utm_campaign, utm_content) not raw utmCtx tokens
          const utmUrl = utmParams && Object.keys(utmParams).length > 0
            ? articleUrl + '?' + buildUtmString(utmParams)
            : articleUrl;

          // Build HTML from article sections — Ghost v5 accepts HTML via ?source=html
          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const htmlBody = tldrHtmlBlock(articleJson) + sections.map(s =>
            `<h2>${s.heading || ''}</h2>\n${(s.body || '').split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('\n')}`
          ).join('\n\n');
          const canonicalNote = `<p><em>Originally published at <a href="${utmUrl}">${process.env.BASE_DOMAIN || 'forgeintelligence.ai'}</a></em></p>`;
          const htmlContent = `${htmlBody}\n\n${canonicalNote}`;

          // feature_image: Ghost v5 accepts external URLs directly
          const ghostFeatureImageUrl = article.hero_image_url || null;
          console.log('[GHOST] feature_image:', ghostFeatureImageUrl || '(none)', '| hero_image_url:', article.hero_image_url || '(null)');

          const ghostRes = await fetch(`${ghostBase}/ghost/api/admin/posts/?source=html`, {
            method: 'POST',
            headers: {
              'Authorization': `Ghost ${ghostJwt}`,
              'Content-Type': 'application/json',
              'Accept-Version': 'v5.0'
            },
            body: JSON.stringify({
              posts: [{
                title: article.title,
                html: htmlContent,
                status: 'published',
                canonical_url: utmUrl,
                meta_title: article.title,
                meta_description: (articleJson.metaDescription || '').slice(0, 300),
                ...(ghostFeatureImageUrl && { feature_image: ghostFeatureImageUrl }),
              }]
            })
          });

          const ghostData = await ghostRes.json();
          if (!ghostRes.ok || ghostData.errors) {
            throw new Error(ghostData.errors?.[0]?.message || `Ghost API error ${ghostRes.status}`);
          }

          const ghostPost = ghostData.posts?.[0];
          results[channel] = { status: 'published', url: ghostPost?.url, postId: ghostPost?.id, utmParams };

        } else if (channel === 'website') {
          // ── My Website webhook publish ──
          // POSTs the article to the customer-configured endpoint with a
          // bearer token. The customer's receiver is responsible for storing
          // / rendering the content. We include both html and markdown in
          // the payload by default (format='both'); customers can narrow
          // to one if they want a smaller payload.
          if (!creds.endpointUrl) throw new Error('My Website: endpointUrl not configured');
          if (!creds.bearerToken) throw new Error('My Website: bearerToken not generated');

          const articleJson = article.article_json || {};
          const sections = articleJson.sections || [];
          const faqs = Array.isArray(articleJson.faqs) ? articleJson.faqs.filter(f => f?.question && f?.answer) : [];
          const htmlContent = tldrHtmlBlock(articleJson) + sections.map(s =>
            `${s.heading ? `<h2>${s.heading}</h2>` : ''}<p>${s.body || s.content || ''}</p>`
          ).join('\n') + (faqs.length
            ? `\n<section class="article-faqs">\n<h2>Frequently asked questions</h2>\n${faqs.map(f => `<h3>${f.question}</h3>\n<p>${f.answer}</p>`).join('\n')}\n</section>`
            : '');
          const markdownContent = tldrMarkdownBlock(articleJson) + sections.map(s =>
            `${s.heading ? `## ${s.heading}\n\n` : ''}${s.body || s.content || ''}`
          ).join('\n\n') + (faqs.length
            ? `\n\n## Frequently asked questions\n\n${faqs.map(f => `### ${f.question}\n\n${f.answer}`).join('\n\n')}`
            : '');
          // Prefer the article's own meta description for excerpt — it's the
          // hand-curated short summary. Falls back to a slice of the first
          // section body only when the description is missing. Without this
          // preference, receivers that render `excerpt` as a subtitle/lead
          // end up showing the first paragraph twice (once as subtitle,
          // once as the opening body paragraph).
          const excerpt = (articleJson.metaDescription || '').trim()
            || (sections[0]?.body || sections[0]?.content || '').replace(/<[^>]+>/g, '').slice(0, 200);

          const payload = {
            slug: articleSlug,
            title: article.title,
            excerpt,
            heroImageUrl: article.hero_image_url || articleJson.hero_image_url || null,
            canonical: forgeArticleUrl,
            publishedAt: new Date().toISOString(),
            meta: {
              description: articleJson.metaDescription || excerpt,
              ogImage: article.hero_image_url || articleJson.hero_image_url || null,
              utm: utmParams,
            },
            // Structured Q&A — always present (empty array if none). The same
            // FAQs are also embedded in html/markdown above; this field is for
            // receivers that want to render/store them without parsing markup.
            faqs: faqs.map(f => ({ question: f.question, answer: f.answer })),
            ...(creds.format !== 'markdown' && { html: htmlContent }),
            ...(creds.format !== 'html' && { markdown: markdownContent }),
          };

          const start = Date.now();
          const r = await fetch(creds.endpointUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${creds.bearerToken}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Forge-Intelligence/1.0',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
          });
          const respText = (await r.text()).slice(0, 2000);
          if (!r.ok) throw new Error(`Receiver returned HTTP ${r.status}: ${respText.slice(0, 300)}`);

          // If the receiver returns JSON with a `url` field, use it as the
          // published_url so the Publishing Queue's "View on site" link works.
          let publishedUrl = null;
          try {
            const parsed = JSON.parse(respText);
            if (typeof parsed?.url === 'string') publishedUrl = parsed.url;
          } catch { /* receiver returned non-JSON, that's fine */ }
          if (!publishedUrl) publishedUrl = payload.canonical;

          results[channel] = {
            status: 'published',
            url: publishedUrl,
            postId: payload.slug,
            latencyMs: Date.now() - start,
            utmParams,
          };

        } else {
          results[channel] = { status: 'error', error: `Unknown channel: ${channel}` };
        }
      } catch (chErr) {
        results[channel] = { status: 'error', error: chErr.message };
      }

      // Write publish log
      await pool.query(
        `INSERT INTO publish_log (queue_item_id, brand_profile_id, content_id, channel, status, response_data, utm_params, published_url, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          queueItemId, item.brand_profile_id, item.content_id, channel,
          results[channel].status,
          JSON.stringify(results[channel]),
          JSON.stringify(utmParams),
          results[channel].url || null,
          results[channel].error || null
        ]
      );
    }

    // Update queue item status
    const allPublished = targets.every(ch => results[ch]?.status === 'published');
    const anyError = targets.some(ch => results[ch]?.status === 'error');
    const newStatus = allPublished ? 'published' : anyError ? 'partial' : 'staged';

    // Strip transient fields before persisting. CRITICAL: skipped channels are
    // EXCLUDED from persistResults entirely — their state is already in the JSONB
    // from the original publish call. Including them would let the shallow-merge
    // operator (||) overwrite their existing url-bearing entry with a status-only
    // shape (the bug that wrecked X and LinkedIn URLs in real data on May 5–6).
    const persistResults = Object.fromEntries(
      Object.entries(results)
        .filter(([_ch, r]) => !r.skipped)
        .map(([ch, r]) => [
          ch,
          r.status === 'published'
            ? { status: r.status, ...(r.url ? { url: r.url } : {}), ...(r.itemId ? { itemId: r.itemId } : {}) }
            : r  // keep error detail for genuinely failed channels
        ])
    );
    // Merge new results into existing publish_results — preserves prior channel results
    await pool.query(
      `UPDATE publishing_queue SET
         status = $1,
         channels = $2,
         publish_results = COALESCE(publish_results, '{}'::jsonb) || $3::jsonb,
         published_at = COALESCE($4, published_at),
         updated_at = NOW()
       WHERE id = $5`,
      [newStatus, JSON.stringify(targets), JSON.stringify(persistResults), allPublished ? new Date() : null, queueItemId]
    );

    // Mirror status onto the parent generated_content_<brand> row so the
    // Performance Dashboard (which filters on content.status='published')
    // sees it. Before this, the publish endpoint updated publishing_queue
    // + publish_log + memories but left content.status stuck at 'draft' —
    // every successfully-published article was invisible in analytics
    // until manual SQL backfill.
    //
    // Brand-scoped table name: generated_content_{brand_profile_id-with-dashes-as-underscores}.
    // Wrapped in try/catch — channel publishes already succeeded; status
    // sync is best-effort and a write failure here shouldn't 500 the
    // response.
    if (allPublished || newStatus === 'published') {
      try {
        const brandTable = `generated_content_${item.brand_profile_id.replace(/-/g, '_')}`;
        await pool.query(
          `UPDATE ${brandTable}
              SET status = 'published',
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('draft', 'pending_review')`,
          [item.content_id]
        );
      } catch (e) {
        console.error('[PUBLISH] Parent content status sync failed:', e.message);
      }
    }

    // Write memory to Brain on any successful publish
    const successfulChannels = targets.filter(ch => results[ch]?.status === 'published' || results[ch]?.status === 'staged');
    if (successfulChannels.length > 0) {
      pool.query(
        `INSERT INTO memories (id, client_id, raw_content, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, NOW())`,
        [
          item.brand_profile_id,
          `Published: ${article.title}`,
          JSON.stringify({ contentId: item.content_id, channels: successfulChannels, brandProfileId: item.brand_profile_id, publishedAt: new Date(), utmResults: results })
        ]
      ).catch(e => console.error('[MEMORY] Write error:', e.message));
    }

        await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage6_publisher', item?.brand_profile_id||null, 'success', 0, Date.now()-startTime]).catch(e => console.error('[ACTIVITY LOG]', e.message));
        res.json({ success: true, status: newStatus, results });
  } catch (err) {
    console.error('[PUBLISH] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export async function runScheduledPublishes() {
  try {
    const due = await pool.query(
      `SELECT * FROM publishing_queue
       WHERE status = 'scheduled'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 10`
    );
    if (!due.rows.length) return;

    console.log(`[SCHEDULER] ${due.rows.length} item(s) due for publish`);

    for (const item of due.rows) {
      try {
        // Mark as publishing so concurrent ticks don't double-fire
        await pool.query(
          `UPDATE publishing_queue SET status = 'publishing', updated_at = NOW() WHERE id = $1 AND status = 'scheduled'`,
          [item.id]
        );

        // Load channel connections
        const channelsRes = await pool.query(
          'SELECT * FROM publishing_channels WHERE brand_profile_id = $1',
          [item.brand_profile_id]
        );
        const channelMap = {};
        for (const ch of channelsRes.rows) channelMap[ch.channel] = ch;

        const targets = item.channels || [];
        if (!targets.length) {
          await pool.query(
            `UPDATE publishing_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`,
            [item.id]
          );
          console.warn('[SCHEDULER] No channels set on item', item.id);
          continue;
        }

        // Use the existing publish endpoint internally via a fetch to itself
        // This reuses all the channel logic (LinkedIn, X, Ghost, etc.) without duplicating it
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        const publishRes = await fetch(`${baseUrl}/api/publishing/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queueItemId: item.id, channels: targets, adminPassword: process.env.ADMIN_RELAY_PASSWORD })
        });
        const publishData = await publishRes.json();

        if (publishData.success) {
          console.log(`[SCHEDULER] Published item ${item.id} to ${targets.join(', ')} — status: ${publishData.status}`);
        } else {
          console.error(`[SCHEDULER] Publish failed for item ${item.id}:`, publishData.error);
          await pool.query(
            `UPDATE publishing_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`,
            [item.id]
          );
        }
      } catch (itemErr) {
        console.error(`[SCHEDULER] Error processing item ${item.id}:`, itemErr.message);
        await pool.query(
          `UPDATE publishing_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [item.id]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[SCHEDULER] Poll error:', err.message);
  }
}




export default router;
