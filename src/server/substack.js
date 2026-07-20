// Substack UNOFFICIAL private-API client — read-only by design.
//
// Substack has no official API; the web app talks to a private JSON API under
// /api/v1/*. Authenticated calls ride a `connect.sid` session cookie, which is a
// FULL-ACCESS token (valid for months, survives MFA). We treat this as sensitive:
//   - GET-only. This client refuses any non-GET, so a test can never mutate or
//     blast a publication's subscribers. Write automation is a deliberate, later
//     decision, not something a test harness should be able to do by accident.
//   - The cookie is NEVER logged.
//   - Rate limited to <= ~1 req/sec (community guidance: don't exceed 1/sec).
//
// This is a super-admin-only test surface (Mission Control), against Sandbox's
// own brands. It is intentionally NOT wired as a customer-facing connector.

let _lastCall = 0;
async function throttle() {
  const wait = 1100 - (Date.now() - _lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCall = Date.now();
}

// Normalize whatever the user pastes (subdomain, full URL, sub.substack.com) to
// the publication origin. Rejects anything that isn't a clean subdomain.
export function substackBaseUrl(subdomain) {
  const s = String(subdomain || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\.substack\.com.*$/i, '')
    .replace(/\/.*$/, '');
  if (!/^[a-z0-9-]{1,63}$/i.test(s)) throw new Error('Invalid Substack subdomain');
  return `https://${s}.substack.com`;
}

// GET-only request against the private API. `path` must be an /api/ path.
// `cookie` is the raw connect.sid value (optional — public endpoints like the
// post archive need none). Returns { status, ok, json, raw } and never throws on
// a non-2xx (caller inspects .ok), so "Substack said no" is distinguishable from
// "the request blew up".
export async function substackGet(subdomain, path, cookie) {
  if (!path || !/^\/api\//.test(path)) throw new Error('Path must start with /api/');
  await throttle();
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Forge Intelligence; Substack read test)',
  };
  if (cookie) headers['Cookie'] = `connect.sid=${cookie}`;
  let res;
  try {
    res = await fetch(substackBaseUrl(subdomain) + path, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return { status: 0, ok: false, json: null, raw: `request failed: ${e.message}` };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. an HTML login redirect) */ }
  return { status: res.status, ok: res.ok, json, raw: json ? undefined : text.slice(0, 2000) };
}
