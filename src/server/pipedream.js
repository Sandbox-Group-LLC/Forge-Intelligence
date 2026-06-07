// Pipedream client, extracted from server.js during the route-group phase.
// pipedreamProxy proxies Facebook Graph calls through Pipedream Connect (OAuth
// brokered per brand). Shared by the publish dispatcher (publishing-publish.js)
// AND the inline /api/admin/facebook/diag + /api/facebook/pipedream/list-pages
// routes, so it's its own module. getPipedreamAccessToken /
// getPipedreamAccountCredentials are internal. Deps: fetch + PIPEDREAM_* env.

// Pipedream OAuth access token, cached for 55 min.
let _pdAccessToken = null;
let _pdTokenExpiresAt = 0;

async function getPipedreamAccessToken() {
  if (_pdAccessToken && Date.now() < _pdTokenExpiresAt) return _pdAccessToken;
  const clientId = process.env.PIPEDREAM_CLIENT_ID;
  const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Pipedream credentials not configured');
  const r = await fetch('https://api.pipedream.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Pipedream auth failed: ' + JSON.stringify(d));
  _pdAccessToken = d.access_token;
  _pdTokenExpiresAt = Date.now() + 55 * 60 * 1000;
  return _pdAccessToken;
}

// Fetch a connected account's credentials from Pipedream's accounts API
// This returns the real OAuth token (including Page access token for facebook_pages)

async function getPipedreamAccountCredentials(accountId, externalUserId) {
  const projectId = process.env.PIPEDREAM_PROJECT_ID;
  const environment = process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'development';
  if (!projectId) throw new Error('PIPEDREAM_PROJECT_ID not configured');
  
  const pdToken = await getPipedreamAccessToken();
  const url = `https://api.pipedream.com/v1/connect/${projectId}/accounts/${accountId}?include_credentials=true&external_user_id=${encodeURIComponent(externalUserId)}`;
  
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${pdToken}`,
      'x-pd-environment': environment,
    }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Pipedream account fetch error ${r.status}: ${JSON.stringify(d)}`);
  return d.data || d;
}

// Proxy an upstream request through Pipedream Connect — handles token refresh transparently

export async function pipedreamProxy({ externalUserId, accountId, url, method = 'GET', headers = {}, data }) {
  const projectId = process.env.PIPEDREAM_PROJECT_ID;
  const environment = process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'development';
  if (!projectId) throw new Error('PIPEDREAM_PROJECT_ID not configured');
  
  const pdToken = await getPipedreamAccessToken();
  // URL-safe base64 encode the upstream URL
  const b64Url = Buffer.from(url).toString('base64url');
  const proxyUrl = `https://api.pipedream.com/v1/connect/${projectId}/proxy/${b64Url}?external_user_id=${encodeURIComponent(externalUserId)}&account_id=${encodeURIComponent(accountId)}`;
  
  const r = await fetch(proxyUrl, {
    method: 'POST',  // Proxy always takes POST — upstream method goes in body
    headers: {
      'Authorization': `Bearer ${pdToken}`,
      'x-pd-environment': environment,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: '',  // Using full URL in path
      method,
      headers,
      ...(data !== undefined ? { data } : {}),
    })
  });
  
  const respText = await r.text();
  let respData;
  try { respData = JSON.parse(respText); } catch { respData = respText; }
  if (!r.ok) throw new Error(`Pipedream proxy error ${r.status}: ${typeof respData === 'string' ? respData : JSON.stringify(respData)}`);
  return respData;
}

// ── Pipedream Connect ─────────────────────────────────────────────────────────

// POST /api/pipedream/token
