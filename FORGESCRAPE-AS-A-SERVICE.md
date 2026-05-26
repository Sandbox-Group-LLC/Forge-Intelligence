# forgeScrape as a Service — Integration Guide

> How another app (Sandbox-XM, Sandbox-GTM, a new project) can call Forge's
> scrape primitive. `forgeScrape` is currently an **internal** function in
> Forge Intelligence's `server.js` — there is no HTTP surface yet. This doc
> covers the two integration models, a drop-in HTTP wrapper to expose it, the
> request/response contract, client examples, and the cost/security guardrails
> you need before pointing a second app at it.

---

## 0. What forgeScrape is (recap)

A two-tier Bright Data scrape primitive. Returns clean HTML (or markdown) for any
URL, JS-rendering automatically when the cheap tier returns an SPA shell.

```
Tier 1: Bright Data Web Unlocker      (cheap, fast HTTP)
Tier 2: Bright Data Scraping Browser  (puppeteer-core CDP; real browser, JS-render)
        — auto-fallback on SPA shell or Tier 1 failure
```

Signature (internal):

```js
forgeScrape(url, {
  format = 'raw',     // 'raw' = HTML | 'markdown' = cleaned text
  timeout = 60000,    // ms
  country = null,     // optional ISO geo-target
  caller = 'unknown', // logged to scrape_log
  metadata = {},
  render = 'auto',    // 'auto' | 'always' (skip Tier 1) | 'never' (no fallback)
}) → { success, status, html, source, latencyMs, error }
//     source: 'brightdata_unlocker' | 'brightdata_browser'
```

There's also `getBrandPageContent(url)` one level up (Jina Reader → forgeScrape →
Readability+Turndown) if the caller wants **markdown** instead of raw HTML.

---

## 1. Two integration models — pick one

### Model A — HTTP service (recommended for cross-app)

Expose `forgeScrape` behind an authenticated endpoint on the Forge Intelligence
server. Other apps POST a URL and get back HTML/markdown. **One Bright Data
account, one scrape_log, one place to tune.**

✅ Single source of truth, centralized cost + audit, no dependency duplication.
✅ Other apps need zero Bright Data setup — just a shared secret.
⚠️ Adds load to the FI server; needs auth + rate limiting (see §4).
⚠️ Cross-app network hop (~50-200ms + scrape latency).

### Model B — lift the code

Copy `forgeScrape` + its helpers into the other app. Each app gets its own Bright
Data zone/credentials.

✅ No coupling to FI uptime; no extra network hop.
⚠️ Duplicated code drifts. Two Bright Data bills, two scrape_logs.
⚠️ Each app needs `puppeteer-core`, `@mozilla/readability`, `jsdom`, `turndown`
   deps + the three `BRIGHTDATA_*` env vars.

**Recommendation:** Model A unless the calling app must keep working when FI is
down. The whole point of a primitive is one well-tuned implementation; forking it
across apps reintroduces the "fetcher zoo" forgeScrape was built to kill.

---

## 2. Model A — the HTTP wrapper (SHIPPED)

Live in `server.js` as `POST /api/forge-scrape`. A thin authenticated endpoint
over the existing function. The shipped version adds a per-key rate limiter and
a `503` when the key isn't configured, on top of the skeleton below.

```js
// POST /api/forge-scrape — cross-app scrape service.
// Auth: shared secret in X-Forge-Scrape-Key header (NOT a Clerk user token —
// this is service-to-service, not a logged-in human). Set FORGE_SCRAPE_SERVICE_KEY
// in the FI environment and in each calling app.
app.post('/api/forge-scrape', express.json({ limit: '16kb' }), async (req, res) => {
  // 1) Service auth — constant-time compare to avoid timing leaks
  const provided = req.get('X-Forge-Scrape-Key') || '';
  const expected = process.env.FORGE_SCRAPE_SERVICE_KEY || '';
  if (!expected || provided.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // 2) Input validation
  const { url, format = 'raw', render = 'auto', country = null, timeout = 60000, caller } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ success: false, error: 'url required' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ success: false, error: 'invalid url' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ success: false, error: 'http/https only' });
  // SSRF guard — block internal hosts. Reject localhost, RFC1918, link-local, metadata IPs.
  const host = parsed.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0)/i.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return res.status(400).json({ success: false, error: 'host not allowed' });
  }

  // 3) Clamp the knobs callers can set (don't let a caller request a 10-min timeout)
  const safeTimeout = Math.min(Math.max(Number(timeout) || 60000, 5000), 90000);
  const safeRender = ['auto', 'always', 'never'].includes(render) ? render : 'auto';
  const safeFormat = ['raw', 'markdown'].includes(format) ? format : 'raw';

  // 4) Delegate to the existing primitive — caller tag namespaced by the app
  const result = await forgeScrape(url, {
    format: safeFormat,
    render: safeRender,
    country: country || null,
    timeout: safeTimeout,
    caller: `svc:${(caller || 'external').slice(0, 40)}`,
    metadata: { service: true },
  });

  // 5) Return the primitive's shape verbatim (html may be large — gzip at the proxy)
  res.json(result);
});
```

> `crypto` is already imported in `server.js`. If you want markdown-with-Jina
> instead of raw HTML, add a `mode: 'page-content'` branch that calls
> `getBrandPageContent(url)` and returns `{ success, markdown, source }`.

---

## 3. Calling it from the other app

### fetch (Node / browser-server)

```js
async function scrape(url, opts = {}) {
  const res = await fetch('https://forgeintelligence.ai/api/forge-scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forge-Scrape-Key': process.env.FORGE_SCRAPE_SERVICE_KEY,
    },
    body: JSON.stringify({
      url,
      format: opts.format || 'raw',   // 'raw' | 'markdown'
      render: opts.render || 'auto',  // 'auto' | 'always' | 'never'
      caller: 'sandbox-gtm',          // shows up in scrape_log as svc:sandbox-gtm
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`forgeScrape failed: ${data.error}`);
  return data.html; // or data.markdown if format:'markdown' + page-content mode
}
```

### curl (smoke test)

```bash
curl -sS -X POST https://forgeintelligence.ai/api/forge-scrape \
  -H "Content-Type: application/json" \
  -H "X-Forge-Scrape-Key: $FORGE_SCRAPE_SERVICE_KEY" \
  -d '{"url":"https://example.com","render":"auto","caller":"smoke-test"}' \
  | head -c 500
```

### Response shape

```json
{
  "success": true,
  "status": 200,
  "html": "<!doctype html>...",
  "source": "brightdata_unlocker",   // or "brightdata_browser" if it escalated
  "latencyMs": 4210,
  "error": null
}
```

On failure: `{ "success": false, "status": null|<code>, "html": null, "source": "...", "error": "<reason>" }`.

---

## 3.5. Consuming-app setup (SYSOI.ai)

Concrete steps to wire a consuming app (SYSOI.ai is the first) to the live
endpoint.

### Env vars

**On Forge Intelligence (Render):** the endpoint validates against this.
```
FORGE_SCRAPE_SERVICE_KEY = <openssl rand -hex 32>     # the shared secret
FORGE_SCRAPE_RATE_PER_MIN = 60                          # optional, defaults to 60
```

**On the consuming app (SYSOI):** same secret, plus the endpoint URL.
```
FORGE_SCRAPE_URL         = https://forgeintelligence.ai/api/forge-scrape
FORGE_SCRAPE_SERVICE_KEY = <same value as on FI>
```

FI validates the key; the consuming app sends it. They MUST match. Generate once
(`openssl rand -hex 32`) and paste the same value into both environments. Rotate
by regenerating and updating both sides.

### Client helper (drop into the consuming repo)

```js
// forgeScrape — call Forge's scrape service. Returns raw HTML by default.
export async function forgeScrape(url, opts = {}) {
  const res = await fetch(process.env.FORGE_SCRAPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forge-Scrape-Key': process.env.FORGE_SCRAPE_SERVICE_KEY,
    },
    body: JSON.stringify({
      url,
      format: opts.format || 'raw',    // 'raw' (HTML) | 'markdown'
      render: opts.render || 'auto',   // 'auto' | 'always' (skip Tier 1) | 'never' (Tier 1 only)
      caller: 'sysoi',                 // appears in FI's scrape_log as svc:sysoi
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`forgeScrape failed: ${data.error}`);
  return data.html;                    // (markdown only if FI ships the page-content mode)
}
```

### Smoke test (after FI deploys + env is set)

```bash
curl -sS -X POST https://forgeintelligence.ai/api/forge-scrape \
  -H "Content-Type: application/json" \
  -H "X-Forge-Scrape-Key: $FORGE_SCRAPE_SERVICE_KEY" \
  -d '{"url":"https://example.com","render":"auto","caller":"smoke-test"}' | head -c 300
```

Expected error responses while wiring up:
- `401 Unauthorized` — key missing or doesn't match FI's value.
- `503 Service not configured` — `FORGE_SCRAPE_SERVICE_KEY` not set on FI.
- `400 host not allowed` — target resolved to localhost/RFC1918/metadata.
- `429 Rate limit exceeded` — >`FORGE_SCRAPE_RATE_PER_MIN` requests in a minute.

### Cost dial for SYSOI

If SYSOI scrapes mostly static pages, set `render: 'never'` per call to hard-cap
at Tier 1 (cheap Unlocker) and never escalate to the bandwidth-billed Scraping
Browser. Use `render: 'auto'` (default) only when SYSOI expects JS-heavy SPAs.

---

## 4. Guardrails before you point a second app at it

These are not optional — a shared scrape service is an SSRF + cost-blowout vector
if you skip them.

1. **Service auth.** `X-Forge-Scrape-Key` is a long random secret (`openssl rand -hex 32`),
   set in FI's env and each caller's env. NOT a Clerk token — this is
   machine-to-machine. Rotate it the same way you rotate any shared secret.
2. **SSRF guard** (in the wrapper above) — reject localhost / RFC1918 / link-local /
   cloud-metadata hosts so a compromised caller can't make FI scrape internal infra.
3. **Rate limiting.** Bright Data is usage-billed. Add a per-key limiter
   (e.g. 60 req/min) so a runaway loop in another app doesn't run up the bill.
   `express-rate-limit` keyed on the service key is enough.
4. **Timeout clamp** (in the wrapper) — callers can't request > 90s.
5. **scrape_log attribution.** The `caller: 'svc:<app>'` tag means every external
   scrape is auditable in `scrape_log` by app — you can see which app drove cost.
6. **Cost awareness.** Tier 1 (Unlocker) is cheap per-request; Tier 2 (Scraping
   Browser) is **bandwidth-billed** and ~10-20× the cost. `render:'auto'` only
   escalates to Tier 2 on SPA shells, but a high-volume caller hitting JS-heavy
   sites will live in Tier 2. If another app scrapes mostly static pages, consider
   `render:'never'` to hard-cap it at Tier 1.

---

## 5. Model B — lifting the code (if you go that route)

Copy these from `server.js` into the other app:

- `forgeScrape`, `_tryUnlocker`, `_tryScrapingBrowser`, `looksLikeSpaShell`, `SPA_SHELL_RE`
- `_logScrape` (or stub it if the other app has no `scrape_log` table)
- For markdown: `getBrandPageContent`, `htmlToMarkdown`, `_turndown`

Dependencies (`package.json`):

```
puppeteer-core  @mozilla/readability  jsdom  turndown
```

Env vars:

```
BRIGHTDATA_API_KEY         # bearer token
BRIGHTDATA_UNLOCKER_ZONE   # Unlocker zone name
BRIGHTDATA_BROWSER_AUTH    # 'brd-customer-<ID>-zone-<ZONE>:<PASSWORD>'  (optional;
                           #  if absent, Tier 2 is skipped — SPA shells return as-is)
```

ESM note: `puppeteer-core` must be imported at the top of the file
(`import puppeteer from 'puppeteer-core'`) — a mid-file `require()` breaks on ESM
boot (this exact bug bit FI once on Render).

---

## 6. Decision summary

| Question | Model A (service) | Model B (lift) |
|----------|-------------------|----------------|
| Bright Data accounts | 1 | per app |
| Code duplication | none | full |
| Calling app deps | none | 4 npm pkgs + 3 env vars |
| Survives FI downtime | no | yes |
| Centralized cost/audit | yes (scrape_log) | no |
| Setup effort | ship 1 endpoint + share 1 secret | copy code + provision BD per app |

**Default to Model A.** The `POST /api/forge-scrape` wrapper is shipped — share the
service key and go. Only lift the code (Model B) if the calling app has a hard
requirement to scrape while FI is unavailable.

> **Status: Model A is live.** Endpoint shipped in `server.js`; SYSOI.ai is the
> first consumer (see §3.5 for env vars + client helper). Set
> `FORGE_SCRAPE_SERVICE_KEY` on the FI Render service before first use — the
> endpoint returns `503` until it's configured.
