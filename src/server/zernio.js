// Zernio social-publishing client + helpers, extracted from server.js during
// the decomposition. callZernio is the single HTTP primitive; the rest layer on
// top (publish, profile create/ensure) plus the dev-only test guard.
import { pool } from './db.js';
import { verifyBrandAccess } from './auth.js';

// Helper: ensure the brand has a Zernio profile, creating one if needed.
export async function ensureZernioProfile(brandProfileId) {
  const r = await pool.query('SELECT zernio_profile_id, brand_name, brand_url FROM brand_profiles WHERE id = $1', [brandProfileId]);
  if (!r.rows.length) throw new Error('Brand not found');
  const brand = r.rows[0];
  if (brand.zernio_profile_id) return brand.zernio_profile_id;

  // Create a new Zernio profile named after the brand
  const name = brand.brand_name || brand.brand_url || `Forge brand ${brandProfileId.slice(0, 8)}`;
  const createRes = await callZernio('POST', '/profiles', {
    name: name.slice(0, 100),
    description: `Forge Intelligence — ${brand.brand_url || brandProfileId}`
  });
  if (!createRes.ok) throw new Error(`Zernio profile create failed (${createRes.status}): ${createRes.raw?.slice(0, 200)}`);
  const newProfileId = createRes.parsed?.profile?._id;
  if (!newProfileId) throw new Error('Zernio profile create returned no _id');

  await pool.query('UPDATE brand_profiles SET zernio_profile_id = $1, updated_at = NOW() WHERE id = $2', [newProfileId, brandProfileId]);
  return newProfileId;
}

export const zernioGuard = (req, res) => {
  // Reject on production
  const host = req.headers.host || '';
  if (host.includes('forgeintelligence.ai') && !host.startsWith('dev.') && !host.startsWith('strategy.')) {
    res.status(403).json({ success: false, error: 'Zernio test endpoints are dev/strategy only' });
    return false;
  }
  // Admin password gate
  if (req.body?.adminPassword !== process.env.ADMIN_RELAY_PASSWORD) {
    res.status(403).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  // Env var check
  if (!process.env.ZERNIO_API_KEY) {
    res.status(500).json({ success: false, error: 'ZERNIO_API_KEY not set on this service' });
    return false;
  }
  return true;
};

// stripSocialMarkdown — Claude defaults to producing markdown structure
// (# headings, **bold**) because it's been trained to. Social platforms
// like Facebook, LinkedIn, X, and Reddit don't render markdown — they
// show the raw characters. Result: posts that open with a literal '#'
// and have '**word**' embedded inline.
//
// Apply this to any Haiku-generated post copy before sending to a
// platform that renders plain text. Conservative by design — only
// strips the two patterns that demonstrably leak (leading H1-H6 and
// double-asterisk/underscore bold). Single asterisks, backticks, list
// markers, and link syntax are left intact: they appear naturally in
// URLs and prose, and stripping them risks corrupting real content.
//
// NOT applied to user-supplied postCopy overrides — if a human typed
// asterisks they wanted them literal.
export const callZernio = async (method, path, body) => {
  const url = `https://zernio.com/api/v1${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.ZERNIO_API_KEY}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  let parsed = null;
  const raw = await r.text();
  try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
  return { status: r.status, ok: r.ok, raw, parsed };
};

// Production helper for publishing through Zernio's social media API. Used by the
// /api/publishing/publish handler when a channel's credentials include
// zernioAccountId. Returns a normalized { status, postId, postUrl, raw } object
// regardless of which platform was published to.
//
// Throws on failure — caller wraps in try/catch and reports to results[channel].
export const zernioPublish = async ({ platform, accountId, content }) => {
  if (!process.env.ZERNIO_API_KEY) throw new Error('ZERNIO_API_KEY not configured on this service');
  if (!platform) throw new Error('zernioPublish: platform required');
  if (!accountId) throw new Error('zernioPublish: accountId required');
  if (!content) throw new Error('zernioPublish: content required');

  const result = await callZernio('POST', '/posts', {
    content,
    publishNow: true,
    platforms: [{ platform, accountId }]
  });

  if (!result.ok) {
    throw new Error(`Zernio ${platform} publish failed (${result.status}): ${result.raw?.slice(0, 300) || 'no response body'}`);
  }

  const post = result.parsed?.post;
  const platformResult = (post?.platforms || []).find(p => p.platform === platform);
  if (!platformResult) {
    throw new Error(`Zernio response missing platform result for ${platform}: ${result.raw?.slice(0, 300)}`);
  }
  if (platformResult.status !== 'published') {
    const errorMsg = platformResult.error || platformResult.platformSpecificData?.lastError || 'Zernio did not publish (status: ' + platformResult.status + ')';
    throw new Error(`Zernio ${platform}: ${errorMsg}`);
  }

  return {
    status: 'published',
    // platformPostId is the platform-native ID (LinkedIn URN, X tweetId, etc).
    // This is what platform-direct APIs use and what appears in user-visible URLs.
    postId: platformResult.platformPostId,
    // Zernio's internal _id. REQUIRED for Zernio's /analytics endpoint — it
    // does NOT accept platformPostId. Saving both means the analytics sync
    // can use zernioPostId for Zernio lookups while preserving platform ID
    // for everything else.
    zernioPostId: post._id,
    postUrl: platformResult.platformPostUrl,
    publishedAt: platformResult.publishedAt,
    raw: post
  };
};

export const getOrCreateZernioProfile = async (brandProfileId) => {
  const brandRes = await pool.query(
    `SELECT id, brand_name, brand_url, zernio_profile_id FROM brand_profiles WHERE id = $1`,
    [brandProfileId]
  );
  if (!brandRes.rows.length) throw new Error('Brand not found');
  const brand = brandRes.rows[0];
  if (brand.zernio_profile_id) return brand.zernio_profile_id;

  const slug = (brand.brand_url || brand.brand_name || brand.id)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const profileName = `forge-${slug}`;

  const createRes = await callZernio('POST', '/profiles', {
    name: profileName,
    description: `Forge Intelligence brand: ${brand.brand_name || brand.brand_url || brand.id}`
  });
  if (!createRes.ok) throw new Error(`Zernio profile creation failed (${createRes.status}): ${createRes.raw?.slice(0, 200)}`);
  const profileId = createRes.parsed?.profile?._id;
  if (!profileId) throw new Error('Zernio create-profile response missing _id');

  await pool.query(
    `UPDATE brand_profiles SET zernio_profile_id = $1, updated_at = NOW() WHERE id = $2`,
    [profileId, brandProfileId]
  );
  return profileId;
};
