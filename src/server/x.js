// X (Twitter) platform helpers, extracted from server.js during the
// decomposition. Three self-contained primitives for talking to X's API:
//   - buildXOAuthHeader: OAuth 1.0a HMAC-SHA1 Authorization header (env-var
//     system creds path).
//   - uploadXMedia: upload an image, return media_id_string (v2 for OAuth 2.0,
//     v1.1 for OAuth 1.0a — see the inline note on the 2026-05-13 deprecation).
//   - refreshXOAuth2Token: exchange a refresh_token for a fresh access token.
// No DB, no other server.js helpers — only crypto + Node globals (fetch/Buffer).
import { randomBytes, createHmac } from 'crypto';

export function buildXOAuthHeader(method, url, apiKey, apiSecret, accessToken, accessSecret, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const allParams = { ...oauthParams, ...extraParams };
  const paramStr = Object.entries(allParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`;
  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessSecret)}`;
  oauthParams['oauth_signature'] = createHmac('sha1', signingKey).update(baseString).digest('base64');
  return 'OAuth ' + Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(', ');
}

export async function uploadXMedia({ imageUrl, oauth2Token, oauth1Header, additionalOwners }) {
  // Upload an image to X and return the media_id_string.
  //
  // Why v1.1: X's v2 /2/media/upload demands `additional_owners` as a JSON array, which can't
  // be expressed in multipart form-data (the only way to send binary). v1.1 accepts a
  // comma-separated string in multipart, and v1.1 media_ids are fully accepted by the v2
  // /2/tweets POST endpoint (same underlying media system).
  //
  // additional_owners (optional) — comma-separated X user IDs that are explicitly granted
  // permission to attach this media to their own tweets. Required when the brand's OAuth 2.0
  // user (the one posting the tweet) is different from the user whose creds upload the media
  // (the system @makemysandbox via env-var OAuth 1.0a). Without this, X rejects the tweet
  // POST with "One or more parameters to your request was invalid."

  // 1. Fetch the image bytes from the source URL (Forge's image generation pipeline)
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

  // 2. Build multipart body + select endpoint. Branch by auth method because
  //    X enforced v1.1 deprecation for OAuth 2.0 tokens on 2026-05-13 (last
  //    successful publish via v1.1+OAuth2 was 06:06 UTC; subsequent attempts
  //    returned 403 empty body with NO Forge code change between them — X-side
  //    rollout). v1.1 still accepts OAuth 1.0a signatures, so the env-var
  //    fallback path keeps using it.
  //
  //    OAuth 2.0 path: v2 /media/upload, binary 'media' part + 'media_category'.
  //    OAuth 1.0a path: v1.1 /media/upload.json, base64 'media_data' + optional 'additional_owners'.
  //    additional_owners is only meaningful for the cross-user v1.1 path (system
  //    user uploads, brand user attaches). On OAuth 2.0 the uploader IS the
  //    attacher, so additional_owners is irrelevant and v2 doesn't accept it.
  const boundary = '----ForgeMediaBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  let body, uploadUrl, authHeader;

  if (oauth2Token) {
    // v2 endpoint expects binary 'media' part + 'media_category' text part
    const parts = [];
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="media_category"${CRLF}${CRLF}tweet_image${CRLF}`, 'utf8'));
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="media"; filename="image.png"${CRLF}Content-Type: image/png${CRLF}${CRLF}`, 'utf8'));
    parts.push(imgBuffer);
    parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'));
    body = Buffer.concat(parts);
    uploadUrl = 'https://api.x.com/2/media/upload';
    authHeader = `Bearer ${oauth2Token}`;
  } else if (oauth1Header) {
    // v1.1 endpoint expects base64 'media_data' + optional 'additional_owners'
    const partsList = [];
    if (additionalOwners) {
      partsList.push(`--${boundary}${CRLF}Content-Disposition: form-data; name="additional_owners"${CRLF}${CRLF}${additionalOwners}${CRLF}`);
    }
    partsList.push(`--${boundary}${CRLF}Content-Disposition: form-data; name="media_data"${CRLF}${CRLF}${imgBuffer.toString('base64')}${CRLF}`);
    const head = Buffer.from(partsList.join(''), 'utf8');
    const tail = Buffer.from(`--${boundary}--${CRLF}`, 'utf8');
    body = Buffer.concat([head, tail]);
    uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
    authHeader = oauth1Header;
  } else {
    throw new Error('No auth header for media upload');
  }

  const headers = {
    'Authorization': authHeader,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
  };

  const upRes = await fetch(uploadUrl, { method: 'POST', headers, body });
  const rawText = await upRes.text();
  let upData = {};
  try { upData = JSON.parse(rawText); } catch {}
  if (!upRes.ok) {
    console.error('[X-MEDIA-DIAG] HTTP', upRes.status, '| raw body:', rawText.slice(0, 500));
    console.error('[X-MEDIA-DIAG] auth method:', oauth1Header ? 'oauth1' : 'oauth2');
    if (oauth1Header) {
      console.error('[X-MEDIA-DIAG] env vars set?',
        'CK=' + (process.env.X_OAUTH1CONSUMER_KEY ? 'yes(' + process.env.X_OAUTH1CONSUMER_KEY.length + ')' : 'NO'),
        'CS=' + (process.env.X_OAUTH1CONSUMER_SECRET ? 'yes(' + process.env.X_OAUTH1CONSUMER_SECRET.length + ')' : 'NO'),
        'AT=' + (process.env.X_OAUTH1ACCESS_TOKEN ? 'yes(' + process.env.X_OAUTH1ACCESS_TOKEN.length + ')' : 'NO'),
        'AS=' + (process.env.X_OAUTH1ACCESS_SECRET ? 'yes(' + process.env.X_OAUTH1ACCESS_SECRET.length + ')' : 'NO')
      );
      console.error('[X-MEDIA-DIAG] auth header (first 200 chars):', oauth1Header.slice(0, 200));
    }
    const err = (upData.errors && upData.errors[0] && upData.errors[0].message) || upData.detail || upData.title || rawText.slice(0, 200) || `HTTP ${upRes.status}`;
    throw new Error(`X media upload failed: ${err}`);
  }
  const mediaId = upData.media_id_string || upData.data?.id || upData.media_id || upData.id;
  if (!mediaId) throw new Error(`X media upload returned no media id: ${JSON.stringify(upData)}`);
  return mediaId;
}

// Helper: refresh X OAuth 2.0 token
export async function refreshXOAuth2Token(refreshToken) {
  const clientId = process.env.X_OAUTH2CLIENT_ID;
  const clientSecret = process.env.X_OAUTH2CLIENT_SECRET;
  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  const data = await tokenRes.json();
  if (!data.access_token) throw new Error(data.error_description || 'X token refresh failed');
  return data;
}
