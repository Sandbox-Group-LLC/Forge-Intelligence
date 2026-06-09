// Context Hub (Stage 1 crawl) routes, extracted from server.js during the
// route-group phase. Mounted at /api/context-hub with NO mount-level auth —
// MIXED group (brains + analyze use softAuth; history + brand/:id are open;
// brains/:id is requireAuth), so auth stays per-route. handleQuickStartSynthesis
// (the Quick Start brain synthesis, context-hub-only) moved in. Pure move:
// bodies verbatim, only registration lines changed.
import express from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../db.js';
import { anthropic, dateContext } from '../llm.js';
import { safeParseLLM } from '../llm-json.js';
import { requireAuth, softAuth, verifyBrandAccess, SUPER_ADMIN_IDS } from '../auth.js';
import { forgeScrape, getBrandPageContent, discoverSubpages } from '../scrape.js';
import { quickStartTruncate } from '../text.js';

const router = express.Router();

router.get('/brains', softAuth, async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    
    // Unauthenticated: check session ID, filter expired
    if (!req.userId) {
      if (!sessionId) {
        return res.json({ success: true, data: [] });
      }
      const sessResult = await pool.query(
        `SELECT id, brand_url, brand_name, version, is_active, cache_status,
                created_at, updated_at, profile_data
         FROM brand_profiles 
         WHERE is_active = true 
           AND onboard_session_id = $1 
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY updated_at DESC`,
        [sessionId]
      );
      const sessData = sessResult.rows.map(r => ({
        id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
        version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
        createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
      }));
      return res.json({ success: true, data: sessData });
    }
    
    // Authenticated: show user's brains (super admins see all)
    const isSuperAdmin = SUPER_ADMIN_IDS.includes(req.userId);
    const result = isSuperAdmin
      ? await pool.query(
          `SELECT id, brand_url, brand_name, version, is_active, cache_status,
                  created_at, updated_at, profile_data,
                  (settings->'factualGround') IS NOT NULL AND settings->'factualGround' != '{}'::jsonb as has_factual_ground,
                  settings->'factualGround'->>'_updatedAt' as factual_ground_updated_at
           FROM brand_profiles WHERE is_active = true ORDER BY updated_at DESC`
        )
      : await pool.query(
          `SELECT id, brand_url, brand_name, version, is_active, cache_status,
                  created_at, updated_at, profile_data,
                  (settings->'factualGround') IS NOT NULL AND settings->'factualGround' != '{}'::jsonb as has_factual_ground,
                  settings->'factualGround'->>'_updatedAt' as factual_ground_updated_at
           FROM brand_profiles WHERE is_active = true AND clerk_user_id = $1 ORDER BY updated_at DESC`,
          [req.userId]
        );
    const data = result.rows.map(r => ({
      id: r.id,
      brandUrl: r.brand_url,
      brandName: r.brand_name,
      version: r.version,
      isActive: r.is_active,
      cacheStatus: r.cache_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      hasFactualGround: r.has_factual_ground,
      factualGroundUpdatedAt: r.factual_ground_updated_at,
      ...r.profile_data
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/brains/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM brand_profiles WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const r = result.rows[0];
    res.json({ success: true, data: {
      id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
      version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
      createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/history/:encodedUrl', async (req, res) => {
  try {
    const brandUrl = decodeURIComponent(req.params.encodedUrl);
    const result = await pool.query(
      `SELECT id, brand_url, brand_name, version, is_active, cache_status, created_at, updated_at,
              (settings->'factualGround') IS NOT NULL AND settings->'factualGround' != '{}'::jsonb as has_factual_ground,
              settings->'factualGround'->>'_updatedAt' as factual_ground_updated_at
       FROM brand_profiles WHERE brand_url = $1 ORDER BY version DESC`, [brandUrl]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function handleQuickStartSynthesis(req, res) {
  const startTime = Date.now();
  try {
    const fg = req.body.factualGround || {};
    const required = ['brandName', 'whatWeDo', 'whatWeDoNot', 'competitors'];
    for (const k of required) {
      if (typeof fg[k] !== 'string' || fg[k].trim().length === 0) {
        return res.status(400).json({ success: false, error: `factualGround.${k} is required` });
      }
    }

    const brandName = fg.brandName.trim();
    const sessionId = req.body.sessionId || null;
    const syntheticBrandUrl = `quickstart://${randomUUID()}`;

    const briefLines = [
      `**Brand Name:** ${brandName}`,
      ``,
      `**What we actually do (founder's own words):**`,
      quickStartTruncate(fg.whatWeDo, 2000),
      ``,
      `**What we explicitly do NOT do (out of scope, common misconceptions):**`,
      quickStartTruncate(fg.whatWeDoNot, 2000),
      ``,
      `**Competitors / who buyers also evaluate:**`,
      quickStartTruncate(fg.competitors, 1500),
    ];
    if (fg.foundingStory && fg.foundingStory.trim()) {
      briefLines.push('', `**Founding story:**`, quickStartTruncate(fg.foundingStory, 1500));
    }
    if (fg.methodology && fg.methodology.trim()) {
      briefLines.push('', `**Methodology / approach:**`, quickStartTruncate(fg.methodology, 1500));
    }
    if (fg.teamComposition && fg.teamComposition.trim()) {
      briefLines.push('', `**Team composition:**`, quickStartTruncate(fg.teamComposition, 1000));
    }
    if (fg.quotablePositions && fg.quotablePositions.trim()) {
      briefLines.push('', `**Quotable positions / hot takes:**`, quickStartTruncate(fg.quotablePositions, 1500));
    }
    if (fg.namedAuthors && fg.namedAuthors.trim()) {
      briefLines.push('', `**Named authors (real humans to attribute):**`, quickStartTruncate(fg.namedAuthors, 800));
    }
    const founderBrief = briefLines.join('\n');

    const prompt = `You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

The following brand context was provided DIRECTLY by the founder via a Quick Start form. There is no website to scrape and no third-party signals. Generate a complete brand profile using ONLY the provided information.

CRITICAL RULES:
- Do NOT hallucinate details not present in the Founder Brief. If you don't know something, say so or omit it — never invent personas, competitors, or positioning that isn't supported by the brief.
- The "What we explicitly do NOT do" content is INTENTIONAL — those non-actions surface as strategicMoats, NOT as competitiveGaps. competitiveGaps should be derived from what the brand CAN compete on but isn't yet talking about.
- discoveredCompetitors must come from the founder's competitors list verbatim. Do not invent additional competitors.
- For visualStyle / accentColor: with no website to inspect, use conservative defaults grounded in the brand category. Mark accentColor as a descriptor like 'neutral slate' or 'deep indigo' rather than guessing a hex.

## FOUNDER BRIEF

${founderBrief}

Return ONLY valid JSON (no markdown, no explanation, no newlines inside string values — use spaces instead):
{
  "brandName": "${brandName.replace(/"/g, '\\"')}",
  "voiceProfile": {
    "summary": "string",
    "toneAttributes": [{ "attribute": "string", "score": 0-100, "description": "string" }],
    "writingStyle": "string",
    "keyPhrases": ["string"],
    "industry": "string",
    "positioning": "string — one tight sentence: what they do, for whom, why they win",
    "targetPersona": "string — primary buyer in plain language",
    "visualStyle": "string — conservative descriptor since there's no site to inspect",
    "accentColor": "string — descriptor like 'deep indigo' or 'neutral slate', not a guessed hex"
  },
  "personas": [{
    "id": "string", "name": "string", "role": "string",
    "painPoints": ["string"], "triggers": ["string"],
    "skepticism": "string", "motivations": ["string"]
  }],
  "thirdPartySignals": [],
  "competitiveGaps": [{ "topic": "string", "ownedBy": "string or null", "whitespaceOpportunity": "string", "priority": "high|medium|low" }],
  "strategicMoats": [{ "capability": "string — drawn directly from 'What we do NOT do'", "rationale": "string", "protects": "string" }],
  "strategicRecommendations": [{ "id": "string", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }],
  "campaignArcs": [{ "id": "string", "title": "string", "thesis": "string", "acts": [{ "actNumber": 1, "actTitle": "string", "actPremise": "string" }], "recommendedLength": "number 3-8", "targetPersona": "string" }],
  "businessProfile": {
    "whatTheyDo": "string — drawn from 'What we actually do'",
    "productsOrServices": ["string"],
    "revenueModel": "string",
    "targetBuyer": "string",
    "companyScale": "string",
    "geography": "string"
  },
  "discoveredCompetitors": ["string — verbatim from founder's competitors list"],
  "marketCategory": "string"
}
Requirements: 5 toneAttributes, 2-3 personas, 0 thirdPartySignals (no website to inspect), 3-5 competitiveGaps (real missed opportunities), 1-4 strategicMoats (one per item in 'What we do NOT do'), 4-6 strategicRecommendations, 2-4 campaignArcs, 1 businessProfile (all fields required). Ground every field in the Founder Brief.`;

    let profileData;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }]
        });
        const raw = message.content[0].text;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { lastErr = new Error('Claude returned no valid JSON'); continue; }
        try {
          profileData = safeParseLLM(jsonMatch[0], 'object', 'quick-start');
          break;
        } catch (parseErr) {
          const fixed = jsonMatch[0].replace(/:\s*"([\s\S]*?)"/g, (m, val) => ': "' + val.replace(/\n/g, ' ').replace(/\r/g, ' ') + '"');
          profileData = JSON.parse(fixed);
          break;
        }
      } catch (e) { lastErr = e; }
    }
    if (!profileData) {
      console.error('[QUICK-START] Claude synthesis failed:', lastErr?.message);
      return res.status(502).json({ success: false, error: 'Synthesis failed', details: lastErr?.message || 'Unknown error' });
    }

    // Stamp Quick Start provenance into the JSONB so downstream tooling can
    // distinguish profiles built from a Founder Brief vs. ones built from a
    // real website scan, without requiring a schema migration.
    profileData.source = 'quick-start';
    profileData.factualGround = {
      brandName,
      whatWeDo: quickStartTruncate(fg.whatWeDo, 4000),
      whatWeDoNot: quickStartTruncate(fg.whatWeDoNot, 4000),
      competitors: quickStartTruncate(fg.competitors, 2000),
      foundingStory: quickStartTruncate(fg.foundingStory || '', 4000),
      methodology: quickStartTruncate(fg.methodology || '', 3000),
      teamComposition: quickStartTruncate(fg.teamComposition || '', 2000),
      quotablePositions: quickStartTruncate(fg.quotablePositions || '', 3000),
      namedAuthors: quickStartTruncate(fg.namedAuthors || '', 1500),
      logoUrl: typeof fg.logoUrl === 'string' ? fg.logoUrl.slice(0, 500) : '',
    };

    // Build directive — what the founder is going to build on Lovable. Drives
    // the BUILD DIRECTIVE section of the prompt-pack so Lovable knows what to
    // build before it processes how the brand behaves. Optional at the
    // analyze-time level (the form gates the description; we only persist
    // what's actually present).
    const biIn = req.body.buildIntent || {};
    if (typeof biIn.description === 'string' && biIn.description.trim().length > 0) {
      const allowedProductTypes = new Set(['marketing-site', 'saas-app', 'landing-page', 'waitlist', 'internal-tool', 'not-sure']);
      const productType = (typeof biIn.productType === 'string' && allowedProductTypes.has(biIn.productType))
        ? biIn.productType
        : 'not-sure';
      profileData.buildIntent = {
        description: quickStartTruncate(biIn.description, 4000),
        productType,
      };
    }

    const id = randomUUID();
    const logoUrl = typeof fg.logoUrl === 'string' && fg.logoUrl.trim() ? fg.logoUrl.trim() : '';
    const expiresClause = req.userId ? 'NULL' : "NOW() + INTERVAL '24 hours'";
    const inserted = await pool.query(
      `INSERT INTO brand_profiles
         (id, brand_url, brand_name, version, is_active, cache_status, profile_data, logo_url, clerk_user_id, onboard_session_id, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 1, true, 'fresh', $4, $5, $6, $7, ${expiresClause}, NOW(), NOW())
       RETURNING *`,
      [id, syntheticBrandUrl, brandName, JSON.stringify(profileData), logoUrl, req.userId || null, sessionId]
    );
    const r = inserted.rows[0];
    const latencyMs = Date.now() - startTime;
    console.log(`[QUICK-START] Created brand ${r.id} for "${brandName}" in ${latencyMs}ms`);

    return res.json({
      success: true,
      cached: false,
      data: {
        id: r.id,
        brandUrl: r.brand_url,
        brandName: r.brand_name,
        version: r.version,
        isActive: r.is_active,
        cacheStatus: r.cache_status,
        latencyMs,
        discoveredCompetitors: Array.isArray(profileData.discoveredCompetitors) ? profileData.discoveredCompetitors : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        ...profileData,
      },
    });
  } catch (err) {
    console.error('[QUICK-START]', err.message);
    return res.status(500).json({ success: false, error: 'Internal error', details: err.message });
  }
}

router.post('/analyze', softAuth, async (req, res) => {
  const { brandUrl, competitorUrls = [], audienceNotes = '', strategicNotes = '', checkBrainFirst = true, saveToBrain = true } = req.body;

  // ── Quick Start branch ────────────────────────────────────────────────────
  // No website to scrape — the founder gave us a structured Founder Brief
  // (factualGround) and we synthesize a profile from those fields alone.
  // Skips Firecrawl, Sonar, and cache check (each Quick Start run gets a
  // synthetic unique brand_url so it never collides with a real domain).
  if (!brandUrl && req.body.factualGround && typeof req.body.factualGround === 'object') {
    return handleQuickStartSynthesis(req, res);
  }

  if (!brandUrl) {
    return res.status(400).json({ success: false, error: 'brandUrl is required' });
  }
  // Validate domain format — block gibberish / bot submissions
  const domainCleaned = brandUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  if (!domainCleaned.includes('.') || !/^[a-zA-Z0-9.-]+$/.test(domainCleaned)) {
    return res.status(400).json({ success: false, error: 'Invalid domain format' });
  }
  const tld = domainCleaned.split('.').pop();
  if (!tld || tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) {
    return res.status(400).json({ success: false, error: 'Invalid domain — must have a valid TLD (e.g. .com, .io)' });
  }

  const domainToName = (url) => {
    const clean = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  };
  const brandName = domainToName(brandUrl);
  const startTime = Date.now();

  try {
    // ── Brain-First: cache check ──────────────────────────────────────────────
    // Claim-gate aware: only return cached data if the caller is authorized to see it.
    //   - The signed-in account that owns it (clerk_user_id match)
    //   - The anonymous session that originally scanned it (onboard_session_id match) AND within 24h window
    // Everyone else gets 409 with a human-readable message. This prevents User B from reading
    // User A's scan inside the 24h window; after 24h the row is expired and not considered active.
    if (checkBrainFirst) {
      const existing = await pool.query(
        `SELECT * FROM brand_profiles
         WHERE brand_url = $1 AND is_active = true
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0];
        const callerSessionId = req.body.sessionId || null;
        const callerUserId = req.userId || null;

        const isOwnerByAccount = r.clerk_user_id && callerUserId && r.clerk_user_id === callerUserId;
        const isOwnerBySession = r.onboard_session_id && callerSessionId && r.onboard_session_id === callerSessionId;

        if (isOwnerByAccount || isOwnerBySession) {
          await pool.query(`UPDATE brand_profiles SET cache_status = 'cached' WHERE id = $1`, [r.id]);
          console.log(`[Context Hub] Cache hit for ${brandUrl} (authorized: ${isOwnerByAccount ? 'account' : 'session'})`);
          return res.json({ success: true, cached: true, data: {
            id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
            version: r.version, isActive: r.is_active, cacheStatus: 'cached',
            createdAt: r.created_at, updatedAt: r.updated_at, ...r.profile_data
          }});
        }

        // Unauthorized cache hit — someone else has an active claim/reservation.
        if (r.clerk_user_id) {
          return res.status(409).json({
            success: false,
            reason: 'owned_by_account',
            message: 'This domain is already claimed by an active Forge account. If this is your brand, sign in. If you believe this is an error, contact hello@forgeintelligence.ai with proof of domain ownership.'
          });
        }
        if (r.onboard_session_id && r.expires_at) {
          const expiresAt = new Date(r.expires_at);
          const hoursRemaining = Math.max(0, Math.round((expiresAt - new Date()) / 36e5));
          return res.status(409).json({
            success: false,
            reason: 'reserved_by_other_session',
            hoursRemaining,
            message: `Someone else scanned this domain in the past 24 hours and has ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'} left to claim it. After that the reservation expires. If you believe this is an error, contact hello@forgeintelligence.ai to dispute.`
          });
        }
        // Orphan row with no owner info — treat as not claimed; let the scan proceed
      }
    }

    // Sonar competitor/ICP discovery runs AFTER the scrape (Tool 1.5) so it can
    // be grounded in the brand's ACTUAL site content rather than its domain name.
    // Declared here so the vars are in scope for the Claude prompt below.
    let sonarCompetitors = [];
    let sonarICP = '';
    let sonarContext = '';

    // ── Tool 1: Website Scraper — actual content extraction ───────────────────
    // Two-tier fetch per page via getBrandPageContent:
    //   Tier A: Jina Reader (semantic markdown — fast, free, the common case)
    //   Tier B: forgeScrape (BD Tier 1 → Tier 2 cascade) + local Readability+Turndown
    // Pages: homepage + up to 8 high-signal subpages discovered via sitemap.xml
    // (link-extraction fallback). All fetched in parallel; every attempt logged
    // to scrape_log with caller='context-hub'.
    console.log(`[Context Hub] Tool 1.5: Scraping website content for ${brandUrl}...`);
    let scrapedContent = '';
    let workingBaseUrl = '';
    // Masked-subdomain support: if the user set a scrapeUrlOverride in Brand Settings
    // (e.g., brand_url is a vanity domain pointing to a Render subservice), use the
    // override as the actual scrape target instead of the public-facing URL.
    let scrapeInputUrl = brandUrl;
    try {
      const ovRes = await pool.query(
        `SELECT settings->>'scrapeUrlOverride' as override FROM brand_profiles WHERE brand_url = $1 ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );
      const override = ovRes.rows[0]?.override?.trim();
      if (override) {
        scrapeInputUrl = override;
        console.log(`[Context Hub] Using scrape URL override: ${override} (public: ${brandUrl})`);
      }
    } catch { /* no profile yet, use brandUrl directly */ }
    try {
      const inputUrl = scrapeInputUrl.startsWith('http') ? scrapeInputUrl : `https://${scrapeInputUrl}`;
      const u = new URL(inputUrl);
      workingBaseUrl = `${u.protocol}//${u.host}`;

      // Fetch the homepage first so we can seed subpage discovery with its
      // already-fetched content — avoids a redundant homepage fetch inside
      // discoverSubpages on SPAs where Jina has already returned clean
      // markdown. Net latency: home fetch (~5-10s Jina, longer on Tier B)
      // then parallel subpage fan-out.
      const homeContent = await getBrandPageContent(workingBaseUrl, { caller: 'context-hub' });

      const subpages = await discoverSubpages(workingBaseUrl, 8, {
        seedMarkdown: homeContent?.success ? homeContent.markdown : null,
      });

      // Fan out to all discovered subpages in parallel.
      const subContents = subpages.length
        ? await Promise.all(subpages.map(pageUrl =>
            getBrandPageContent(pageUrl, { caller: 'context-hub' }).catch(err => ({ success: false, markdown: null, source: 'error', error: err?.message }))
          ))
        : [];

      // Concatenate per-page markdown (20 KB per page) into the section
      // siteContentSection consumes. Tagged by URL + source so downstream
      // Claude can attribute claims to specific pages.
      if (homeContent?.success && homeContent.markdown) {
        scrapedContent += `HOMEPAGE (${workingBaseUrl}, via ${homeContent.source}):\n${homeContent.markdown.slice(0, 20000)}\n\n`;
      } else {
        console.log(`[Context Hub] Homepage fetch failed — ${homeContent?.error || 'no detail'}`);
      }
      for (let i = 0; i < subContents.length; i++) {
        const p = subContents[i];
        if (p?.success && p.markdown) {
          scrapedContent += `PAGE (${subpages[i]}, via ${p.source}):\n${p.markdown.slice(0, 20000)}\n\n`;
        }
      }

      const okPages = (homeContent?.success ? 1 : 0) + subContents.filter(p => p?.success).length;
      console.log(`[Context Hub] Scraped ${scrapedContent.length} chars from ${okPages} page(s) (base: ${workingBaseUrl}, discovered: ${subpages.length})`);
    } catch(e) {
      console.log(`[Context Hub] Scraper error (non-fatal):`, e.message);
    }

    const scraperSuccess = scrapedContent.length > 200;
    const siteContentSection = scraperSuccess
      ? `\n\nACTUAL WEBSITE CONTENT (scraped — use this as primary source, do NOT guess from domain name):\n${scrapedContent.slice(0, 100000)}`
      : '';
    if (!scraperSuccess) console.warn(`[Context Hub] ⚠️ SCRAPER FAILED for ${brandUrl} — Claude will guess from domain name + Sonar context only`);

    // ── Tool 1.5: Perplexity Sonar — competitor + ICP discovery ───────────────
    // Grounded in the SCRAPED site content, not the domain. The domain is a
    // terrible primary signal: brands like "Sommers House" on a *.forge-os.ai /
    // forgeos-*.onrender.com URL made Sonar match software "forges" (GitHub,
    // GitLab) and the defence "The Forge" instead of their real market. We feed
    // Sonar what the brand ACTUALLY does and tell it to ignore the domain name.
    console.log(`[Context Hub] Tool 1.5: Perplexity Sonar research for ${brandUrl} (grounded: ${scraperSuccess})...`);
    const brandEvidenceForSonar = scraperSuccess
      ? `What this brand actually does (from their own website — treat this as the source of truth):\n${scrapedContent.slice(0, 3000)}`
      : `Brand website: ${brandUrl} (site could not be scraped — infer carefully, do not over-index on keywords in the domain name).`;
    try {
      const sonarRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{
            role: 'user',
            content: `You are identifying the TRUE market competitors for a brand. Base your answer on what the brand actually does — NOT on coincidental keywords in its domain name (e.g. a domain containing "forge" does NOT make a software-repository tool a competitor).

${brandEvidenceForSonar}

Return ONLY valid JSON (no markdown):
{
  "brandDescription": "1-2 sentence description of what this company does",
  "competitors": ["url1", "url2", "url3"],
  "targetICP": "specific description of their ideal customer profile — job title, company size, pain points",
  "marketCategory": "the specific market category this brand competes in",
  "keyDifferentiators": ["string"],
  "contentThemes": ["main topics this brand and competitors publish content about"]
}
Return exactly 3 competitor URLs that serve the same buyers in the same market. Be specific and accurate.`
          }],
          max_tokens: 800
        })
      });

      if (sonarRes.ok) {
        const sonarData = await sonarRes.json();
        const sonarText = sonarData.choices[0].message.content;
        const sonarMatch = sonarText.match(/\{[\s\S]*\}/);
        if (sonarMatch) {
          const sonarJson = JSON.parse(sonarMatch[0]);
          // Founder-provided competitors win verbatim; Sonar only fills the gap.
          sonarCompetitors = competitorUrls.length > 0 ? competitorUrls : (sonarJson.competitors || []);
          sonarICP = sonarJson.targetICP || '';
          sonarContext = `Brand description: ${sonarJson.brandDescription}
Market category: ${sonarJson.marketCategory}
Key differentiators: ${(sonarJson.keyDifferentiators || []).join(', ')}
Content themes in this market: ${(sonarJson.contentThemes || []).join(', ')}`;
          console.log(`[Context Hub] Sonar found ${sonarCompetitors.length} competitors, ICP: ${sonarICP.slice(0, 80)}...`);
        }
      }
    } catch(e) {
      console.log('[Context Hub] Sonar research failed, proceeding without:', e.message);
    }

    // ── Tool 2: Claude — Brand Intelligence Profile ───────────────────────────
    console.log(`[Context Hub] Tool 2: Claude brand analysis...`);

    const competitorSection = sonarCompetitors.length ? `\nCompetitor URLs (auto-discovered): ${sonarCompetitors.join(', ')}` : '';
    const icpSection = sonarICP ? `\nICP context (auto-discovered): ${sonarICP}` : '';
    const marketSection = sonarContext ? `\nMarket context: ${sonarContext}` : '';
    const audienceSection = audienceNotes ? `\nAdditional audience context: ${audienceNotes}` : '';
    const strategicSection = strategicNotes ? `\nAdditional strategic context: ${strategicNotes}` : '';

    // ── Inject Stage 8 patterns from prior runs if this brand has been analyzed before ──
    let patternSection = '';
    let mistakeSection = '';
    try {
      const existingBrand = await pool.query(
        'SELECT id FROM brand_profiles WHERE brand_url = $1 ORDER BY version DESC LIMIT 1',
        [brandUrl]
      );
      if (existingBrand.rows.length) {
        const existingId = existingBrand.rows[0].id;
        const [priorPatterns, priorMistakes] = await Promise.all([
          pool.query('SELECT pattern_type, description, confidence_score FROM brain_patterns WHERE brand_profile_id = $1 ORDER BY confidence_score DESC LIMIT 5', [existingId]),
          pool.query('SELECT mistake_type, description, severity FROM brain_mistakes WHERE brand_profile_id = $1 ORDER BY severity DESC LIMIT 3', [existingId])
        ]);
        if (priorPatterns.rows.length) {
          patternSection = '\n\nPRIOR PERFORMANCE PATTERNS (from published content analytics — reinforce these in your analysis):\n' +
            priorPatterns.rows.map(p => `- [${p.pattern_type}] ${p.description} (${Math.round((p.confidence_score||0)*100)}% confidence)`).join('\n');
        }
        if (priorMistakes.rows.length) {
          mistakeSection = '\n\nCONTENT MISTAKES TO AVOID (from underperforming published content):\n' +
            priorMistakes.rows.map(m => `- [${m.severity?.toUpperCase()} severity] ${m.mistake_type}: ${m.description}`).join('\n');
        }
      }
    } catch(e) { console.log('[Context Hub] No prior patterns:', e.message); }

    const prompt = `You are the Forge Intelligence Context Agent — Stage 1 of an 8-stage Brand Intelligence platform.

Analyze the brand at: ${brandUrl}${siteContentSection}${competitorSection}${icpSection}${marketSection}${audienceSection}${strategicSection}${patternSection}${mistakeSection}

Return ONLY valid JSON (no markdown, no explanation, no newlines inside string values — use spaces instead):
{
  "brandName": "string — the brand's actual display name as it appears on the website (e.g. 'Rose + Thyme', not 'therosethyme' or 'Therosethyme')",
  "voiceProfile": {
    "summary": "string",
    "toneAttributes": [{ "attribute": "string", "score": 0-100, "description": "string" }],
    "writingStyle": "string",
    "keyPhrases": ["string"],
    "industry": "string — e.g. \'B2B SaaS\', \'Fintech\', \'Healthcare IT\', \'Manufacturing\'",
    "positioning": "string — one tight sentence: what they do, for whom, and why they win",
    "targetPersona": "string — primary buyer in plain language, e.g. \'VP of Marketing at mid-market SaaS\'",
    "visualStyle": "string — inferred from site aesthetic, e.g. \'dark editorial minimal\', \'bright human photography\', \'technical precision grids\', \'warm organic textures\'",
    "accentColor": "string — dominant brand color as hex if detectable, otherwise descriptor e.g. \'#3563FF\' or \'deep indigo\'"
  },
  "personas": [{
    "id": "string", "name": "string", "role": "string",
    "painPoints": ["string"], "triggers": ["string"],
    "skepticism": "string", "motivations": ["string"]
  }],
  "thirdPartySignals": [{ "source": "string", "signalType": "string", "value": "string or null", "confidence": 0-100, "lastChecked": "ISO8601" }],
  "competitiveGaps": [{ "topic": "string — a topic where competitors own the conversation AND the brand could plausibly compete. Do NOT include topics the brand explicitly and strategically excludes (e.g., 'we don't execute projects', 'we don't take commissions', 'we don't build X') — those are moats, not gaps. A competitiveGap is a real missed opportunity, not a deliberate positioning choice.", "ownedBy": "string or null", "whitespaceOpportunity": "string", "priority": "high|medium|low" }],
  "strategicMoats": [{ "capability": "string — something the brand deliberately does NOT do, stated on their site or implied by positioning. Examples: 'Does not execute projects (planning-only layer)', 'Does not take vendor commissions', 'No long-term contracts'", "rationale": "string — why this non-action is strategically valuable to them", "protects": "string — what this moat protects: independence, pricing power, trust, speed, etc." }],
  "strategicRecommendations": [{ "id": "string", "category": "string", "title": "string", "description": "string", "impact": "high|medium|low", "effort": "high|medium|low" }],
  "campaignArcs": [{ "id": "string — short kebab-case slug", "title": "string — name of the campaign series, evocative not generic", "thesis": "string — 1-2 sentence core argument of the whole series. THIS is what the brand is claiming, not a summary of what will be covered. Should be provocative, ownable, and tied to the brand's real point-of-view.", "acts": [{ "actNumber": 1, "actTitle": "string", "actPremise": "string — what this act establishes, proves, or resolves in the narrative" }], "recommendedLength": "number — how many distinct acts you think this arc needs (3-8). Campaign Generator will expand this into an 8-article scheduler-compatible series regardless of act count.", "targetPersona": "string — which of the brand's personas this arc is primarily aimed at" }],
  "businessProfile": {
    "whatTheyDo": "string — plain-language description of the core business, e.g. 'Designs and sells vegan skincare products direct to consumer' or 'Provides experiential marketing services for premium consumer brands'",
    "productsOrServices": ["string — specific offerings, e.g. 'Brand activations', 'Event production', 'AI-powered content platform', 'Rose hip face serum'"],
    "revenueModel": "string — how they make money, e.g. 'Project-based creative services', 'Monthly SaaS subscription', 'DTC e-commerce', 'Retainer + project fees'",
    "targetBuyer": "string — who writes the check, e.g. 'CMO at premium consumer brands', 'Individual skincare consumers age 25-45', 'VP Marketing at mid-market B2B'",
    "companyScale": "string — rough size indicator, e.g. 'Boutique agency (<50 people)', 'Enterprise ($50B+ revenue)', 'Early-stage startup', 'Mid-market SaaS'",
    "geography": "string — where they operate, e.g. 'NYC-based, US clients', 'Global', 'Portland OR, primarily US west coast'"
  },
  "discoveredCompetitors": ["string"],
  "marketCategory": "string"
}
Requirements: 5 toneAttributes, 2-3 personas, 4-6 thirdPartySignals, 3-5 competitiveGaps (ACTUAL missed opportunities, not strategic non-choices), 0-4 strategicMoats (include only if the brand explicitly states what they don't do as a strategy — some brands won't have any), 4-6 strategicRecommendations, 2-4 campaignArcs (each is a narrative series the brand could publish; focus on storylines that prove a thesis, challenge industry conventions, or crystallize the brand's worldview — not topic lists. Think of each arc as a season of television: a single argument told across multiple acts with payoff in the final act), 1 businessProfile (all fields required). Use the ICP and market context provided to make personas and gaps highly specific. For visualStyle and accentColor: infer carefully from the brand website design, color palette, imagery, and overall aesthetic — these feed directly into AI hero image generation and must reflect the real brand identity. For industry, positioning, and targetPersona: be specific and commercially precise, not generic.`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    });

    let profileData;
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = attempt === 0 ? message : await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = msg.content[0].text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { if (attempt === 1) throw new Error('Claude returned no valid JSON'); continue; }
      try {
        profileData = safeParseLLM(jsonMatch[0], 'object', 'context-hub');
        break;
      } catch(parseErr) {
        try {
          const fixed = jsonMatch[0].replace(/:\s*"([\s\S]*?)"/g, (m, val) => ': "' + val.replace(/\n/g, ' ').replace(/\r/g, ' ') + '"');
          profileData = JSON.parse(fixed);
          break;
        } catch(fixErr) {
          if (attempt === 0) {
            console.log('[Context Hub] JSON parse failed, retrying Claude call...');
            continue;
          }
          throw fixErr;
        }
      }
    }

    // Competitor precedence: a founder-provided list wins verbatim; otherwise use
    // the (now content-grounded) Sonar list. Never wipe a non-empty list with an
    // empty one — if Sonar returned nothing, keep whatever Claude derived from the
    // scraped content rather than blanking it.
    if (competitorUrls.length > 0) {
      profileData.discoveredCompetitors = competitorUrls;
    } else if (Array.isArray(sonarCompetitors) && sonarCompetitors.length > 0) {
      profileData.discoveredCompetitors = sonarCompetitors;
    } // else: keep profileData.discoveredCompetitors as Claude derived it

    const latencyMs = Date.now() - startTime;
    console.log(`[Context Hub] Complete — ${brandName} | Latency: ${latencyMs}ms | Competitors found: ${sonarCompetitors.length}`);

    profileData.scraperSuccess = scraperSuccess;

    // ── Stamp server-side time on every signal ────────────────────────────
    // The schema asks the LLM for a 'lastChecked' ISO8601 date per signal, but
    // the LLM has no current-date awareness and routinely hallucinates dates
    // 6-18 months in the past (matching its training-data prior). Override
    // every signal's lastChecked with the actual scan time. Server clock is
    // the only source of truth here — never trust LLM-supplied timestamps for
    // anything user-facing or audit-relevant.
    if (Array.isArray(profileData.thirdPartySignals)) {
      const nowIso = new Date().toISOString();
      profileData.thirdPartySignals = profileData.thirdPartySignals.map(sig => ({
        ...sig,
        lastChecked: nowIso
      }));
    }

    if (saveToBrain) {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const resolvedBrandName = (profileData.brandName && !uuidPattern.test(profileData.brandName))
        ? profileData.brandName : brandName;

      // Check if brand already exists — UPDATE in place to preserve UUID and all content references
      const existing = await pool.query(
        `SELECT id, version, profile_data FROM brand_profiles WHERE brand_url = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
        [brandUrl]
      );

      let r;
      if (existing.rows.length > 0) {
        // UPDATE existing — preserves UUID, content tables, queue, analytics, brain data
        const ex = existing.rows[0];

        // ── Preserve customer-managed fields across rescan ───────────────────────
        // The rescan synthesizes a fresh profileData from scratch, but customers may
        // have manually corrected fields (wrong persona, missed competitor, brand
        // domain quirk) or the founder may have stamped strategic_injections. Without
        // preservation every rescan wipes those edits — a trust killer that makes
        // customers afraid to rerun their own brain.
        //
        // Two-tier preservation:
        //   1) `strategic_injections`: append-only log, copied verbatim
        //   2) `manual_overrides`: JSONB whose top-level keys overwrite the
        //      synthesized fields. Example:
        //        {"discoveredCompetitors": [...corrected list...]}
        //      lets a customer permanently override what Context Hub re-derives.
        const oldProfile = ex.profile_data || {};
        const preservedKeys = [];
        if (oldProfile.strategic_injections) {
          profileData.strategic_injections = oldProfile.strategic_injections;
          preservedKeys.push('strategic_injections');
        }
        if (oldProfile.manual_overrides && typeof oldProfile.manual_overrides === 'object') {
          profileData.manual_overrides = oldProfile.manual_overrides;
          for (const [k, v] of Object.entries(oldProfile.manual_overrides)) {
            if (k === 'manual_overrides' || k === 'strategic_injections') continue;
            profileData[k] = v;
          }
          preservedKeys.push(`manual_overrides(${Object.keys(oldProfile.manual_overrides).length})`);
        }

        const updated = await pool.query(
          `UPDATE brand_profiles SET profile_data = $1, brand_name = $2, version = $3, cache_status = 'fresh', updated_at = NOW()
           WHERE id = $4 RETURNING *`,
          [JSON.stringify(profileData), resolvedBrandName, ex.version + 1, ex.id]
        );
        r = updated.rows[0];
        const preservedNote = preservedKeys.length ? ` [preserved: ${preservedKeys.join(', ')}]` : '';
        console.log(`[Context Hub] Updated existing brand ${r.id} to v${r.version}${preservedNote}`);
      } else {
        // INSERT new — first-time analysis for this URL
        const versionResult = await pool.query(
          `SELECT COALESCE(MAX(version), 0) as max_v FROM brand_profiles WHERE brand_url = $1`, [brandUrl]
        );
        const nextVersion = versionResult.rows[0].max_v + 1;
        const id = randomUUID();
        const sessionId = req.body.sessionId || null;
        const expiresAt = req.userId ? null : "NOW() + INTERVAL '24 hours'";
        const inserted = await pool.query(
          `INSERT INTO brand_profiles (id, brand_url, brand_name, version, is_active, cache_status, profile_data, clerk_user_id, onboard_session_id, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, true, 'fresh', $5, $6, $7, ${expiresAt ? expiresAt : 'NULL'}, NOW(), NOW())
           ON CONFLICT (brand_url) WHERE is_active = true
           DO UPDATE SET profile_data = $5, brand_name = $3, version = brand_profiles.version + 1, cache_status = 'fresh', updated_at = NOW()
           RETURNING *`,
          [id, brandUrl, resolvedBrandName, nextVersion, JSON.stringify(profileData), req.userId || null, sessionId]
        );
        r = inserted.rows[0];
        console.log(`[Context Hub] Created/merged brand ${r.id} v${r.version}`);
      }

      return res.json({ success: true, cached: false, data: {
        id: r.id, brandUrl: r.brand_url, brandName: r.brand_name,
        version: r.version, isActive: r.is_active, cacheStatus: r.cache_status,
        latencyMs, discoveredCompetitors: sonarCompetitors,
        createdAt: r.created_at, updatedAt: r.updated_at, ...profileData
      }});

    }
    await pool.query('INSERT INTO agent_activity_log (agent_name, brand_profile_id, status, tokens_used, latency_ms) VALUES ($1,$2,$3,$4,$5)', ['stage1_context_agent', null, 'success', (message?.usage?.input_tokens||0)+(message?.usage?.output_tokens||0), Date.now()-startTime]).catch(()=>{});
        res.json({ success: true, cached: false, data: {
      id: randomUUID(), brandUrl, brandName,
      version: 1, isActive: false, cacheStatus: 'fresh',
      latencyMs, discoveredCompetitors: sonarCompetitors, scraperSuccess,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...profileData
    }});

  } catch (err) {
    console.error('[Context Hub] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/brand/:brandId', async (req, res) => {
  const { brandId } = req.params;
  try {
    const r = await pool.query(
      `SELECT * FROM brand_profiles WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
      [brandId]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Brand not found or expired' });
    const row = r.rows[0];
    res.json({ success: true, data: {
      id: row.id, brandUrl: row.brand_url, brandName: row.brand_name,
      version: row.version, isActive: row.is_active, cacheStatus: row.cache_status,
      expiresAt: row.expires_at, createdAt: row.created_at, isPaid: !!row.clerk_user_id,
      ...row.profile_data
    }});
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
