/**
 * Origami website-visitor snippet — first-party proxy (vendor "setup 1").
 *
 * Forwards exactly three browser-facing Origami paths from our own domain so
 * ad blockers don't stop the tag, attaching two headers the browser never sees:
 *
 *   X-Origami-Client-IP  the visitor's real IP, from our view of the connection
 *   Authorization        Bearer <ORIGAMI_VISITORS_SECRET_KEY>, server-side only
 *
 * Without both, Origami sees every visit as coming from our container's IP and
 * can't resolve which company visited.
 *
 * ── Why an explicit allowlist, not a catch-all ────────────────────────────────
 * This proxy attaches the secret key, and `/v1/s` is Origami's server-only
 * endpoint that accepts `forget` deletions. Proxying `/_ov/*` wholesale would
 * let any visitor delete our visitor data through it, signed with our own key.
 * So: three paths, 404 for everything else. Do not widen this.
 *
 * ── Why the IP is read from x-forwarded-for ──────────────────────────────────
 * The app runs behind Coolify's Traefik proxy and does NOT set express
 * `trust proxy`, so `req.ip` is the proxy hop, not the visitor. Reading the
 * forwarded header directly matches what auth.js / audit.js already do here.
 * Getting this wrong fails *silently* — Origami's `ipLooksReal` reads true
 * until ~50 pageviews — so ORIGAMI_DEBUG_IP below exists to check it once.
 */
import express from 'express';

const router = express.Router();

const ORIGAMI_ORIGIN = 'https://origami-web-visitors.com';

// The only paths the browser may reach through us. `/v1/s` is deliberately absent.
const ALLOWED_PATHS = new Set(['o.js', 'e', 'identify']);

// Request headers worth passing through. Cookies are dropped: the vendor doesn't
// need them and they'd be our own session cookies leaving our domain.
const FORWARD_HEADERS = ['user-agent', 'origin', 'referer', 'content-type', 'accept'];

/**
 * The visitor's IP as this process can best determine it.
 *
 * Traefik appends the real client to x-forwarded-for, so the left-most entry is
 * the visitor. We overwrite whatever the browser sent — a client-set
 * X-Origami-Client-IP must never be trusted, it would let a visitor claim to be
 * any company.
 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    const first = fwd.split(',')[0].trim();
    if (first) return first;
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || req.ip || '';
}

router.all('/:path', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  const secret = process.env.ORIGAMI_VISITORS_SECRET_KEY;
  const path = req.params.path;

  // Single-segment only. Anything with a slash is handled by the catch-all below.
  if (!ALLOWED_PATHS.has(path)) {
    return res.status(404).end();
  }

  // Fail closed rather than silently relaying unsigned traffic that Origami
  // would attribute to this container's IP.
  if (!secret) {
    console.error('[ORIGAMI] ORIGAMI_VISITORS_SECRET_KEY not set — refusing to proxy');
    return res.status(503).end();
  }

  const ip = clientIp(req);

  // One-shot install verification. Origami's own `ipLooksReal` can't confirm a
  // test install, so set ORIGAMI_DEBUG_IP=1 for a single test visit, compare the
  // logged value against ifconfig.me from the same browser, then unset it.
  // A private address (10.x, 172.16-31.x, 192.168.x) means we're reading the
  // wrong hop.
  if (process.env.ORIGAMI_DEBUG_IP === '1') {
    console.log(`[ORIGAMI][debug] path=${path} X-Origami-Client-IP=${ip} xff=${req.headers['x-forwarded-for'] || '(none)'}`);
  }

  const headers = {
    'X-Origami-Client-IP': ip,
    Authorization: `Bearer ${secret}`,
  };
  for (const h of FORWARD_HEADERS) {
    const v = req.headers[h];
    if (typeof v === 'string' && v.length) headers[h] = v;
  }

  const search = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : '';

  try {
    const upstream = await fetch(`${ORIGAMI_ORIGIN}/v1/${path}${search}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      signal: AbortSignal.timeout(5000),
    });

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    const cc = upstream.headers.get('cache-control');
    if (cc) res.set('Cache-Control', cc);

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (e) {
    // Never let analytics break a page load: the tag is fire-and-forget.
    console.error('[ORIGAMI] proxy error:', e.message);
    return res.status(204).end();
  }
});

// Anything deeper than /_ov/<one-segment> — e.g. /_ov/v1/s — is not one of the
// three allowed paths. Without this it would fall through to express.static and
// the SPA catch-all, answering 200 with index.html instead of a clean 404.
// NOTE: this is express 4, so the wildcard is '/*', not express 5's '/*splat'
// (which matches nothing here and fails open to the SPA).
router.all('/*', (_req, res) => res.status(404).end());

export default router;
