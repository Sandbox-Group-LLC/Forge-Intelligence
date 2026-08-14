// Web scraping / crawl helpers, extracted from server.js during the
// decomposition. forgeScrape is the one fetch primitive (Bright Data Web
// Unlocker -> Scraping Browser cascade); the rest handle Readability
// extraction, markdown conversion, and subpage discovery.
import puppeteer from 'puppeteer-core';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { pool } from './db.js';

// Detects an unhydrated SPA shell (empty root/__next/app/svelte/nuxt div) so the
// scraper can escalate to the JS-rendering tier.
const SPA_SHELL_RE = /<body[^>]*>\s*(?:<noscript>[\s\S]*?<\/noscript>\s*)?<div\s+id=["'](?:root|__next|app|svelte|nuxt)["'][^>]*>\s*<\/div>/i;

// Dependency-free per-key fixed-window rate limiter for the cross-app scrape
// service. Bright Data is usage-billed; this caps a runaway loop in a calling
// app. Only valid keys reach this Map (auth runs first). FORGE_SCRAPE_RATE_PER_MIN
// is exported so the /api/forge-scrape route can cite it in its 429 message.
const _forgeScrapeHits = new Map(); // key -> { count, windowStart }
export const FORGE_SCRAPE_RATE_PER_MIN = Number(process.env.FORGE_SCRAPE_RATE_PER_MIN) || 60;

export function looksLikeSpaShell(html) {
  if (!html) return false;
  if (SPA_SHELL_RE.test(html)) return true;
  // Fallback heuristic: tiny body content (after stripping scripts/styles)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return false;
  const cleanedBody = bodyMatch[1]
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .trim();
  return cleanedBody.length < 500;
}

async function _logScrape(row) {
  try {
    await pool.query(
      `INSERT INTO scrape_log (url, source, status_code, body_size, latency_ms, success, caller, error, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.url, row.source, row.status_code ?? null, row.body_size ?? null, row.latency_ms ?? null,
       row.success, row.caller ?? 'unknown', row.error ?? null, JSON.stringify(row.metadata ?? {})]
    );
  } catch { /* logging is best-effort */ }
}

async function _tryUnlocker(url, { format, timeout, country, caller, metadata }) {
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  const startTime = Date.now();
  if (!apiKey || !zone) {
    const err = 'Bright Data Unlocker not configured (BRIGHTDATA_API_KEY / BRIGHTDATA_UNLOCKER_ZONE missing)';
    await _logScrape({ url, source: 'brightdata_unlocker', success: false, latency_ms: 0, caller, error: err, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_unlocker', latencyMs: 0, error: err };
  }
  try {
    const body = { zone, url, format };
    if (country) body.country = country;
    if (format === 'markdown') body.data_format = 'markdown';
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), timeout);
    let resp;
    try {
      resp = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally { clearTimeout(tid); }
    const responseBody = await resp.text();
    const latencyMs = Date.now() - startTime;
    // An HTTP 200 with an empty body is a FAILURE, not a success. Bright Data
    // occasionally returns 200/0-bytes (seen on oooagency.com 2026-07-06);
    // logging it as success:true both lied in scrape_log and — worse —
    // prevented forgeScrape's auto mode from escalating to the browser tier
    // (looksLikeSpaShell('') is false), so the whole scrape died silently.
    const bodyOk = resp.ok && responseBody.trim().length > 0;
    const failReason = !resp.ok
      ? `HTTP ${resp.status}: ${responseBody.slice(0, 200)}`
      : (bodyOk ? null : `HTTP ${resp.status} but empty body`);
    await _logScrape({
      url, source: 'brightdata_unlocker',
      status_code: resp.status, body_size: responseBody.length, latency_ms: latencyMs,
      success: bodyOk, caller,
      metadata: { ...(metadata ?? {}), body_sample: bodyOk ? responseBody.slice(0, 15000) : undefined },
      error: failReason,
    });
    if (!bodyOk) {
      return { success: false, status: resp.status, html: null, source: 'brightdata_unlocker', latencyMs, error: failReason };
    }
    return { success: true, status: resp.status, html: responseBody, source: 'brightdata_unlocker', latencyMs, error: null };
  } catch (e) {
    const latencyMs = Date.now() - startTime;
    await _logScrape({ url, source: 'brightdata_unlocker', success: false, latency_ms: latencyMs, caller, error: e.message, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_unlocker', latencyMs, error: e.message };
  }
}

async function _tryScrapingBrowser(url, { timeout, caller, metadata }) {
  const browserAuth = process.env.BRIGHTDATA_BROWSER_AUTH;
  const startTime = Date.now();
  if (!browserAuth) {
    const err = 'Bright Data Scraping Browser not configured (BRIGHTDATA_BROWSER_AUTH missing)';
    await _logScrape({ url, source: 'brightdata_browser', success: false, latency_ms: 0, caller, error: err, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_browser', latencyMs: 0, error: err };
  }
  let browser = null;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://${browserAuth}@brd.superproxy.io:9222`,
      // Each connection is single-shot; tear down promptly.
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeout);
    // Block heavy resources we don't need for DOM extraction. Cuts bandwidth
    // cost (Scraping Browser is bandwidth-billed) ~70% on most sites.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    // Wait for actual article-shaped content, not just any DOM. The previous
    // heuristic (root has children + 1KB innerHTML) fires the moment the
    // layout shell mounts — well before the article body actually renders,
    // which is why Tier 2 was returning 10KB pages with no article in them.
    // Now: require an h1 with real text AND at least 3 paragraphs. If that
    // doesn't fire within 15s we take what we have rather than fail.
    try {
      await page.waitForFunction(() => {
        const h1 = document.querySelector('h1');
        const paragraphs = document.querySelectorAll('p').length;
        return h1 && h1.textContent.trim().length > 10 && paragraphs >= 3;
      }, { timeout: 15_000 });
    } catch { /* content heuristic didn't fire — continue with what we have */ }
    const html = await page.content();
    await browser.close();
    browser = null;
    const latencyMs = Date.now() - startTime;
    await _logScrape({
      url, source: 'brightdata_browser',
      status_code: 200, body_size: html.length, latency_ms: latencyMs,
      success: true, caller,
      metadata: { ...(metadata ?? {}), body_sample: html.slice(0, 15000) },
    });
    return { success: true, status: 200, html, source: 'brightdata_browser', latencyMs, error: null };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch {} }
    const latencyMs = Date.now() - startTime;
    await _logScrape({ url, source: 'brightdata_browser', success: false, latency_ms: latencyMs, caller, error: e.message, metadata });
    return { success: false, status: null, html: null, source: 'brightdata_browser', latencyMs, error: e.message };
  }
}

// ── captureBrandVisual — measure a brand's REAL visual identity ─────────────
// The markdown scrape strips all color/imagery, so accentColor was being
// hallucinated. This loads the homepage in the headless browser WITH stylesheets
// (unlike _tryScrapingBrowser, which blocks them) and reads computed CSS to pull
// the true visual basics — not guessed:
//   accent/bg   = weighted saturated colors + body background (legacy keys)
//   palette     = 4–8 role-tagged colors from CSS vars + computed styles
//   typography  = heading/body font families from @font-face / <link> / computed
//   fonts        = @font-face metadata (family/weight/url/bytes/role) — NEVER binaries
//   logo        = header/nav mark preferred; favicon as iconUrl; skip consent junk
//   buttonStyle = primary CTA radius + filled|outline|pill
//   imageryStyle= coarse photo/illustration/3d/mixed + short treatment
// Returns { success, accentColor, bgColor, logoUrl, palette?, typography?, fonts?, logo?,
//           buttonStyle?, imageryStyle?, scrapeVersion, latencyMs }.
// Additive only — legacy accentColor/bgColor/logoUrl always present when found.
// brandVisual/3 = webfont metadata capture (fonts[]); still additive JSONB, no binaries.
export const BRAND_VISUAL_SCRAPE_VERSION = 'brandVisual/3';

// Font binaries are licensed IP — never auto-store them in JSONB/DB/repo.
// includeFontBinaries is accepted for future object-storage archival only and is
// ignored by the default metadata path (see probeBrandFonts).
const FONT_FILE_RE = /\.(woff2?|ttf|otf)(?:$|[?#])/i;
const WOFF2_MAGIC = Buffer.from('wOF2');
const WOFF_MAGIC = Buffer.from('wOFF');
const TTF_OTF_MAGIC_HEAD = 0x00010000;
const OTF_MAGIC = Buffer.from('OTTO');
const CJK_FAMILY_RE = /(?:^|[\s_-])(?:sc|tc|jp|kr|cjk|hangul|kana|hans|hant|tpj|noto\s*sans\s*(?:sc|tc|jp|kr)|source\s*han)(?:$|[\s_-])/i;
const MONO_FAMILY_RE = /mono|menlo|consolas|courier|source\s*code|fira\s*code|jetbrains|roboto\s*mono|ibm\s*plex\s*mono/i;

// Pure helpers exported for unit tests (page.evaluate embeds its own copies).
export function nearHex(a, b, maxDist = 28) {
  if (!a || !b) return false;
  const pa = /^#?([0-9a-f]{6})$/i.exec(String(a).trim());
  const pb = /^#?([0-9a-f]{6})$/i.exec(String(b).trim());
  if (!pa || !pb) return false;
  const n = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = n(pa[1]), [r2, g2, b2] = n(pb[1]);
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db) <= maxDist;
}

export function dedupePalette(entries, max = 8) {
  const out = [];
  for (const e of entries || []) {
    if (!e?.hex) continue;
    const hex = String(e.hex).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) continue;
    const hit = out.find((x) => nearHex(x.hex, hex));
    if (hit) {
      // Keep higher-weight entry as representative; fill missing role from either side.
      if ((e.weight || 0) > (hit.weight || 0)) {
        hit.hex = hex;
        hit.source = e.source || hit.source;
        hit.weight = e.weight;
        if (e.role) hit.role = e.role;
      } else if (!hit.role && e.role) {
        hit.role = e.role;
      }
      if (e.source === 'css-var' && hit.source !== 'css-var') hit.source = 'css-var';
      continue;
    }
    out.push({ hex, role: e.role, source: e.source, weight: e.weight || 0 });
  }
  out.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return out.slice(0, max).map(({ hex, role, source }) => ({ hex, role, source }));
}

export function pickFontFamily(stack) {
  if (!stack || typeof stack !== 'string') return null;
  const parts = stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', '-apple-system', 'blinkmacsystemfont']);
  for (const p of parts) {
    if (!p) continue;
    if (generic.has(p.toLowerCase())) continue;
    // Skip obvious system stacks disguised as families
    if (/^segoe ui$/i.test(p) || /^roboto$/i.test(p) && parts.length > 3) {
      // still a real family name — keep it
    }
    return p;
  }
  return null;
}

export function isJunkLogoUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const u = url.toLowerCase();
  // Consent / cookie managers, tracking pixels, tiny spacers, data URIs without svg
  if (/cookiebot|onetrust|cookielaw|consentmanager|trustarc|quantcast|ketch\.com|osano\.com|usercentrics|didomi|iubenda|cookie-script|cookieyes|termly\.io|securiti\.ai/.test(u)) return true;
  if (/\/pixel\.|\/spacer\.|1x1\.|tracking\.|analytics/.test(u)) return true;
  if (u.startsWith('data:') && !u.startsWith('data:image/svg')) return true;
  return false;
}

export function guessImageFormat(url) {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/\.(svg|png|jpe?g|webp|gif|ico|avif)(?:[?#]|$)/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  if (String(url).startsWith('data:image/svg')) return 'svg';
  if (String(url).startsWith('data:image/png')) return 'png';
  return null;
}

/** Strip quotes/whitespace from a CSS font-family token. */
export function normalizeFontFamilyName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const name = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  if (!name) return null;
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset']);
  if (generic.has(name.toLowerCase())) return null;
  return name;
}

/**
 * Parse @font-face blocks from CSS text. Captures family, weight range, style,
 * format() hint, and resolved absolute font URL (woff2/woff/ttf/otf only).
 * Pure — no network. Does not download binaries.
 */
export function parseFontFaceBlocks(cssText, baseUrl) {
  if (!cssText || typeof cssText !== 'string') return [];
  const faces = [];
  const re = /@font-face\s*\{([\s\S]*?)\}/gi;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const body = m[1] || '';
    const prop = (name) => {
      const pm = body.match(new RegExp(`${name}\s*:\s*([^;}{]+)`, 'i'));
      return pm ? pm[1].trim() : null;
    };
    const family = normalizeFontFamilyName(prop('font-family'));
    if (!family) continue;

    const weightRaw = prop('font-weight') || '400';
    // CSS Fonts 4 allows ranged weights on variable faces: "400 700"
    const weightRange = /\d{1,4}\s+\d{1,4}/.test(weightRaw)
      ? weightRaw.replace(/\s+/g, ' ').trim()
      : String(parseInt(weightRaw, 10) || weightRaw).trim();
    const isVariable = /\d{1,4}\s+\d{1,4}/.test(weightRaw)
      || /variations?/i.test(body);

    const styleRaw = (prop('font-style') || 'normal').toLowerCase();
    const style = styleRaw === 'normal' ? undefined : styleRaw;

    // Prefer woff2, then woff, then ttf/otf. Collect url()+optional format().
    const src = prop('src') || '';
    const srcParts = [];
    const srcRe = /url\(([^)]+)\)(?:\s*format\(([^)]+)\))?/gi;
    let sm;
    while ((sm = srcRe.exec(src)) !== null) {
      let u = sm[1].trim().replace(/^['"]|['"]$/g, '');
      if (!u || u.startsWith('data:')) continue;
      if (!FONT_FILE_RE.test(u)) continue;
      let abs = u;
      try { abs = baseUrl ? new URL(u, baseUrl).href : u; } catch { /* keep raw */ }
      if (!/^https?:\/\//i.test(abs)) continue;
      const fmt = sm[2] ? sm[2].trim().replace(/^['"]|['"]$/g, '') : null;
      srcParts.push({ url: abs, formatHint: fmt });
    }
    if (!srcParts.length) continue;

    // Prefer woff2 > woff > ttf/otf
    const rank = (p) => {
      const f = (p.formatHint || p.url).toLowerCase();
      if (f.includes('woff2')) return 3;
      if (f.includes('woff')) return 2;
      if (f.includes('ttf') || f.includes('truetype') || f.includes('otf') || f.includes('opentype')) return 1;
      return 0;
    };
    srcParts.sort((a, b) => rank(b) - rank(a));
    const best = srcParts[0];
    let formatHint = best.formatHint || null;
    if (!formatHint) {
      if (/\.woff2/i.test(best.url)) formatHint = 'woff2';
      else if (/\.woff/i.test(best.url)) formatHint = 'woff';
      else if (/\.ttf/i.test(best.url)) formatHint = 'truetype';
      else if (/\.otf/i.test(best.url)) formatHint = 'opentype';
    }

    faces.push({
      family,
      weightRange,
      ...(style ? { style } : {}),
      formatHint,
      url: best.url,
      isVariable: !!isVariable,
    });
  }
  // Dedupe identical family+weight+url
  const seen = new Set();
  const out = [];
  for (const f of faces) {
    const key = `${f.family}::${f.weightRange}::${f.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Role heuristic for a captured face.
 * - mono: family name looks monospaced OR used on code/pre selectors
 * - cjk-subset: CJK-ish family name OR huge subset file (>= ~1.2MB)
 * - primary: used on Latin h1/body
 * - unknown: everything else
 * Never label a multi-MB CJK subset as the brand primary face.
 */
export function classifyFontRole(face, { headingFont = null, bodyFont = null, monoFont = null } = {}) {
  if (!face?.family) return 'unknown';
  const fam = String(face.family);
  const bytes = Number(face.bytes) || 0;
  const looksCjk = CJK_FAMILY_RE.test(fam) || bytes >= 1_200_000;
  const looksMono = MONO_FAMILY_RE.test(fam)
    || (monoFont && fam.toLowerCase() === String(monoFont).toLowerCase());

  if (looksCjk) return 'cjk-subset';
  if (looksMono) return 'mono';

  const h = headingFont ? String(headingFont).toLowerCase() : null;
  const b = bodyFont ? String(bodyFont).toLowerCase() : null;
  const fl = fam.toLowerCase();
  if ((h && fl === h) || (b && fl === b)) return 'primary';
  // Loose match: "Adyen" face vs computed "Adyen, sans-serif" already picked
  if (h && (fl.includes(h) || h.includes(fl))) return 'primary';
  if (b && (fl.includes(b) || b.includes(fl))) return 'primary';
  return 'unknown';
}

/** True if buf starts with a known font magic (woff2/woff/ttf/otf). */
export function verifyFontMagicBytes(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 4) return false;
  if (buf.subarray(0, 4).equals(WOFF2_MAGIC)) return true;
  if (buf.subarray(0, 4).equals(WOFF_MAGIC)) return true;
  if (buf.subarray(0, 4).equals(OTF_MAGIC)) return true;
  // sfnt / TrueType version 1.0
  if (buf.readUInt32BE(0) === TTF_OTF_MAGIC_HEAD) return true;
  // TrueType collection
  if (buf.subarray(0, 4).toString('ascii') === 'ttcf') return true;
  return false;
}

/**
 * HEAD (or ranged GET) a font URL for byte size + magic-byte verification.
 * Never stores the binary — only metadata. HTML error pages fail magic check.
 */
export async function probeFontUrl(fontUrl, { timeout = 12000, fetchImpl = fetch } = {}) {
  const out = { url: fontUrl, bytes: null, verifiedMagicBytes: false };
  if (!fontUrl || !/^https?:\/\//i.test(fontUrl)) return out;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeout);
  try {
    // Prefer ranged GET so we can verify magic without a full multi-MB download.
    // Some CDNs ignore Range; we still only read a small prefix from the body.
    let res = await fetchImpl(fontUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-15', 'User-Agent': 'ForgeIntelligenceBrandVisual/3' },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!res.ok && res.status !== 206) {
      // Fall back to HEAD for size only
      res = await fetchImpl(fontUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': 'ForgeIntelligenceBrandVisual/3' },
        signal: ac.signal,
        redirect: 'follow',
      });
      if (res.ok) {
        const cl = res.headers.get('content-length');
        if (cl && /^\d+$/.test(cl)) out.bytes = Number(cl);
      }
      return out;
    }
    const cl = res.headers.get('content-length');
    const cr = res.headers.get('content-range'); // bytes 0-15/12345
    if (cr) {
      const total = /\/(\d+)\s*$/.exec(cr);
      if (total) out.bytes = Number(total[1]);
    } else if (cl && /^\d+$/.test(cl)) {
      out.bytes = Number(cl);
    }
    // Read at most 16 bytes for magic — discard the rest.
    const reader = res.body?.getReader?.();
    let prefix = Buffer.alloc(0);
    if (reader) {
      while (prefix.length < 16) {
        const { done, value } = await reader.read();
        if (done) break;
        prefix = Buffer.concat([prefix, Buffer.from(value)]);
        if (prefix.length >= 16) break;
      }
      try { await reader.cancel(); } catch { /* noop */ }
    } else {
      // fetch impl without streaming — arrayBuffer then slice (still not stored)
      const ab = await res.arrayBuffer();
      prefix = Buffer.from(ab).subarray(0, 16);
      if (out.bytes == null) out.bytes = ab.byteLength;
    }
    out.verifiedMagicBytes = verifyFontMagicBytes(prefix);
    return out;
  } catch {
    return out;
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Probe a list of parsed faces (metadata only). Caps concurrency.
 * includeFontBinaries is intentionally ignored — binaries are licensed IP and
 * must never land in JSONB; gate any future archive path behind object storage.
 */
export async function enrichFontFaces(faces, {
  headingFont = null,
  bodyFont = null,
  monoFont = null,
  includeFontBinaries = false, // accepted + ignored: binaries are licensed IP; never store in JSONB
  timeout = 12000,
  fetchImpl = fetch,
  concurrency = 4,
} = {}) {
  if (!Array.isArray(faces) || !faces.length) return [];
  // Explicit no-op so the flag is part of the public API without enabling storage.
  if (includeFontBinaries) {
    // Future: object-storage archive only. Metadata path must stay binary-free.
  }
  const queue = [];
  let i = 0;
  async function worker() {
    while (i < faces.length) {
      const idx = i++;
      const face = faces[idx];
      const probe = await probeFontUrl(face.url, { timeout, fetchImpl });
      const enriched = {
        family: face.family,
        weightRange: face.weightRange,
        ...(face.style ? { style: face.style } : {}),
        formatHint: face.formatHint || null,
        url: face.url,
        bytes: probe.bytes,
        isVariable: !!face.isVariable,
        verifiedMagicBytes: !!probe.verifiedMagicBytes,
      };
      enriched.role = classifyFontRole(enriched, { headingFont, bodyFont, monoFont });
      queue[idx] = enriched;
    }
  }
  const n = Math.min(concurrency, faces.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return queue.filter(Boolean);
}

/** Build the stored brandVisual object (profile.brandVisual) from a capture result. */
export function buildBrandVisualPayload(capture, { capturedAt = new Date().toISOString() } = {}) {
  if (!capture?.success) return null;
  const out = {
    accentColor: capture.accentColor || null,
    bgColor: capture.bgColor || null,
    logoUrl: capture.logoUrl || null,
    capturedAt,
    scrapeVersion: capture.scrapeVersion || BRAND_VISUAL_SCRAPE_VERSION,
  };
  if (Array.isArray(capture.palette) && capture.palette.length) out.palette = capture.palette;
  if (capture.typography && (capture.typography.headingFont || capture.typography.bodyFont)) {
    out.typography = capture.typography;
  }
  // Metadata only — never font binaries / base64 payloads.
  if (Array.isArray(capture.fonts) && capture.fonts.length) {
    out.fonts = capture.fonts.map((f) => ({
      family: f.family,
      weightRange: f.weightRange,
      ...(f.style ? { style: f.style } : {}),
      formatHint: f.formatHint ?? null,
      url: f.url,
      bytes: f.bytes ?? null,
      isVariable: !!f.isVariable,
      role: f.role || 'unknown',
      verifiedMagicBytes: !!f.verifiedMagicBytes,
    }));
  }
  if (capture.logo && (capture.logo.primaryUrl || capture.logo.iconUrl)) out.logo = capture.logo;
  if (capture.buttonStyle && (capture.buttonStyle.radiusPx != null || capture.buttonStyle.style)) {
    out.buttonStyle = capture.buttonStyle;
  }
  if (capture.imageryStyle?.style) out.imageryStyle = capture.imageryStyle;
  return out;
}

export async function captureBrandVisual(url, { caller = 'context-hub', timeout = 30000, metadata = {} } = {}) {
  const browserAuth = process.env.BRIGHTDATA_BROWSER_AUTH;
  const startTime = Date.now();
  if (!browserAuth) return { success: false, error: 'BRIGHTDATA_BROWSER_AUTH missing' };
  let browser = null;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://${browserAuth}@brd.superproxy.io:9222` });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeout);
    // Keep stylesheets (computed colors need them). Font *files* still aborted for
    // bandwidth — family *names* come from CSSOM / computed style, not the binary.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      if (['font', 'media'].includes(t)) req.abort();
      else req.continue();
    });
    // domcontentloaded + a settle delay, NOT networkidle2: heavy sites (analytics,
    // animations — e.g. duolingo.com) never go network-idle and time out the whole
    // capture. Computed styles only need stylesheets applied, which happens well
    // before idle. If even DCL times out, proceed anyway — whatever rendered is
    // usually measurable; a hard failure surfaces at evaluate().
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const visual = await page.evaluate(() => {
      const toRGB = (s) => {
        if (!s || s === 'transparent' || s === 'inherit' || s === 'currentcolor') return null;
        // hex
        const hx = String(s).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
        if (hx) {
          let h = hx[1];
          if (h.length === 3) h = h.split('').map((c) => c + c).join('');
          if (h.length === 8) h = h.slice(0, 6);
          return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
          };
        }
        const m = s && s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[\s,\/]+/).map((x) => parseFloat(x)).filter((n) => !Number.isNaN(n));
        if (p.length < 3) return null;
        if (p[3] !== undefined && p[3] < 0.5) return null; // transparent
        return { r: p[0], g: p[1], b: p[2] };
      };
      const sl = ({ r, g, b }) => {
        const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
        const l = (mx + mn) / 2;
        const s = mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
        return { s, l };
      };
      const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
      const dist = (a, b) => {
        const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
        return Math.sqrt(dr * dr + dg * dg + db * db);
      };
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
      const isJunkLogo = (u) => {
        if (!u) return true;
        const s = u.toLowerCase();
        if (/cookiebot|onetrust|cookielaw|consentmanager|trustarc|quantcast|ketch\.com|osano\.com|usercentrics|didomi|iubenda|cookie-script|cookieyes|termly\.io|securiti\.ai/.test(s)) return true;
        if (/\/pixel\.|\/spacer\.|1x1\.|tracking\.|analytics/.test(s)) return true;
        if (s.startsWith('data:') && !s.startsWith('data:image/svg')) return true;
        return false;
      };
      const fmtOf = (u) => {
        if (!u) return null;
        const m = u.toLowerCase().match(/\.(svg|png|jpe?g|webp|gif|ico|avif)(?:[?#]|$)/);
        if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
        if (u.startsWith('data:image/svg')) return 'svg';
        if (u.startsWith('data:image/png')) return 'png';
        return null;
      };
      const pickFont = (stack) => {
        if (!stack) return null;
        const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', '-apple-system', 'blinkmacsystemfont']);
        for (const raw of stack.split(',')) {
          const p = raw.trim().replace(/^["']|["']$/g, '');
          if (!p || generic.has(p.toLowerCase())) continue;
          return p;
        }
        return null;
      };

      // ── legacy accent weighting (kept for accentColor key) ────────────────
      const cand = {};
      const addAccent = (rgb, w) => {
        if (!rgb) return;
        const { s, l } = sl(rgb);
        if (s < 0.18 || l < 0.08 || l > 0.92) return;
        const h = hex(rgb);
        cand[h] = (cand[h] || 0) + w;
      };
      document.querySelectorAll('button,[class*="btn"],[class*="Button"],[class*="cta"],[class*="Cta"],[role="button"]')
        .forEach((el) => addAccent(toRGB(getComputedStyle(el).backgroundColor), 3));
      document.querySelectorAll('header,nav,[class*="header"],[class*="nav"]')
        .forEach((el) => addAccent(toRGB(getComputedStyle(el).backgroundColor), 2));
      document.querySelectorAll('a').forEach((el) => addAccent(toRGB(getComputedStyle(el).color), 1));
      let accent = null, best = 0;
      for (const [h, w] of Object.entries(cand)) if (w > best) { best = w; accent = h; }
      const bodyRgb = toRGB(getComputedStyle(document.body).backgroundColor);
      const bg = bodyRgb ? hex(bodyRgb) : null;

      // ── palette: CSS vars + computed styles with roles ────────────────────
      const paletteRaw = []; // {hex, role, source, weight}
      const pushColor = (rgb, role, source, weight) => {
        if (!rgb) return;
        const h = hex(rgb);
        paletteRaw.push({ hex: h, role, source, weight: weight || 1, rgb });
      };

      // CSS custom properties on :root / html / body
      const rootEls = [document.documentElement, document.body].filter(Boolean);
      for (const el of rootEls) {
        const cs = getComputedStyle(el);
        // cssText on computed style is empty in most browsers; walk stylesheets instead below.
        // Also sample a known set of common brand tokens via getPropertyValue.
        const tokenHints = [
          '--color-primary', '--color-secondary', '--color-accent', '--color-background', '--color-bg',
          '--color-text', '--color-foreground', '--color-neutral', '--brand-color', '--brand-primary',
          '--primary', '--secondary', '--accent', '--background', '--foreground', '--text',
          '--primary-color', '--secondary-color', '--accent-color', '--bg-color', '--text-color',
          '--brand', '--brand-secondary', '--brand-accent', '--theme-primary', '--theme-color',
        ];
        for (const name of tokenHints) {
          const v = cs.getPropertyValue(name);
          if (!v || !v.trim()) continue;
          const rgb = toRGB(v.trim());
          if (!rgb) continue;
          let role = 'accent';
          const n = name.toLowerCase();
          if (/primary|brand(?!-secondary|-accent)/.test(n) && !/text|bg|background|foreground/.test(n)) role = 'primary';
          else if (/secondary/.test(n)) role = 'secondary';
          else if (/accent/.test(n)) role = 'accent';
          else if (/background|bg$|--bg/.test(n)) role = 'background';
          else if (/text|foreground|fg/.test(n)) role = 'text';
          else if (/neutral|muted|gray|grey/.test(n)) role = 'neutral';
          pushColor(rgb, role, 'css-var', 5);
        }
      }

      // Walk stylesheets for --*color* / --brand* / --primary* custom props
      try {
        for (const sheet of Array.from(document.styleSheets || [])) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; } // cross-origin
          if (!rules) continue;
          const walk = (list) => {
            for (const rule of Array.from(list || [])) {
              if (rule.type === 1 /* CSSRule.STYLE_RULE */ && rule.style) {
                for (let i = 0; i < rule.style.length; i++) {
                  const prop = rule.style[i];
                  if (!prop || !prop.startsWith('--')) continue;
                  if (!/(color|brand|primary|secondary|accent|background|foreground|theme|palette|ink|surface)/i.test(prop)) continue;
                  const val = rule.style.getPropertyValue(prop);
                  const rgb = toRGB(val);
                  if (!rgb) continue;
                  let role = 'accent';
                  const n = prop.toLowerCase();
                  if (/primary|brand(?!-secondary|-accent)/.test(n) && !/text|bg|background|foreground/.test(n)) role = 'primary';
                  else if (/secondary/.test(n)) role = 'secondary';
                  else if (/accent/.test(n)) role = 'accent';
                  else if (/background|bg|surface/.test(n)) role = 'background';
                  else if (/text|foreground|ink|fg/.test(n)) role = 'text';
                  else if (/neutral|muted|gray|grey/.test(n)) role = 'neutral';
                  pushColor(rgb, role, 'css-var', 4);
                }
              } else if (rule.cssRules) {
                try { walk(rule.cssRules); } catch { /* noop */ }
              }
            }
          };
          walk(rules);
        }
      } catch { /* stylesheet walk is best-effort */ }

      // Computed styles on structural / interactive elements
      const sample = (sel, prop, role, weight) => {
        document.querySelectorAll(sel).forEach((el, idx) => {
          if (idx > 24) return;
          const rgb = toRGB(getComputedStyle(el)[prop]);
          pushColor(rgb, role, 'computed', weight);
        });
      };
      sample('header,nav,[class*="header" i],[class*="nav" i]', 'backgroundColor', 'background', 3);
      sample('button,[class*="btn" i],[class*="Button"],[class*="cta" i],[role="button"],a[class*="button" i]', 'backgroundColor', 'primary', 4);
      sample('button,[class*="btn" i],[role="button"]', 'color', 'text', 1);
      sample('a', 'color', 'accent', 2);
      sample('h1,h2,.hero,[class*="hero" i]', 'color', 'text', 2);
      sample('h1,h2,.hero,[class*="hero" i]', 'backgroundColor', 'background', 1);
      sample('body,main', 'backgroundColor', 'background', 3);
      sample('body,main,p', 'color', 'text', 2);

      // Dedupe near-identical (RGB distance) and rank
      const clusters = [];
      for (const e of paletteRaw) {
        if (!e.rgb) continue;
        const { s, l } = sl(e.rgb);
        // Keep near-black/white only if role is text/background/neutral
        const isExtreme = l < 0.06 || l > 0.94;
        const isNeutralish = s < 0.12;
        if (isExtreme && !['text', 'background', 'neutral'].includes(e.role)) continue;
        if (isNeutralish && !['text', 'background', 'neutral', 'secondary'].includes(e.role) && s < 0.08) {
          e.role = e.role === 'primary' ? 'neutral' : e.role;
        }
        let hit = clusters.find((c) => dist(c.rgb, e.rgb) <= 28);
        if (!hit) {
          hit = { hex: e.hex, role: e.role, source: e.source, weight: e.weight, rgb: e.rgb };
          clusters.push(hit);
        } else {
          hit.weight += e.weight;
          // Prefer css-var source; prefer more "brand" roles
          const roleRank = { primary: 5, accent: 4, secondary: 3, text: 2, background: 2, neutral: 1 };
          if (e.source === 'css-var' && hit.source !== 'css-var') hit.source = 'css-var';
          if ((roleRank[e.role] || 0) > (roleRank[hit.role] || 0)) hit.role = e.role;
          // Prefer more saturated representative for brand roles
          if ((roleRank[e.role] || 0) >= 3 && sl(e.rgb).s > sl(hit.rgb).s) {
            hit.hex = e.hex; hit.rgb = e.rgb;
          }
        }
      }
      clusters.sort((a, b) => b.weight - a.weight);
      // Ensure roles unique-ish: if two primaries, demote lower weight to secondary/accent
      const seenRoles = new Set();
      for (const c of clusters) {
        if (seenRoles.has(c.role) && ['primary', 'accent', 'secondary'].includes(c.role)) {
          c.role = c.role === 'primary' ? 'secondary' : 'neutral';
        }
        seenRoles.add(c.role);
      }
      let palette = clusters.slice(0, 8).map(({ hex: h, role, source }) => ({ hex: h, role, source }));
      // Guarantee accent/bg represented if measured
      if (accent && !palette.some((p) => dist(toRGB(p.hex) || { r: 0, g: 0, b: 0 }, toRGB(accent) || { r: 0, g: 0, b: 0 }) <= 28)) {
        palette = [{ hex: accent, role: 'accent', source: 'computed' }, ...palette].slice(0, 8);
      }
      if (bg && !palette.some((p) => p.role === 'background')) {
        palette = [...palette, { hex: bg, role: 'background', source: 'computed' }].slice(0, 8);
      }
      // Drop palette if empty after filters
      if (!palette.length) palette = null;

      // ── typography + webfont source harvest ───────────────────────────────
      // Collect @font-face NAMES via CSSOM (cross-origin sheets may throw) and
      // stylesheet hrefs / inline CSS text for Node-side regex parse + probe.
      // Font *binaries* stay aborted at the network layer — we only want metadata.
      const faceNames = new Set();
      const fontFaceCssChunks = []; // { base, text } — capped later
      try {
        for (const sheet of Array.from(document.styleSheets || [])) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          let faceCss = '';
          for (const rule of Array.from(rules || [])) {
            if (rule.type === 5 /* CSSRule.FONT_FACE_RULE */) {
              if (rule.style) {
                const fam = rule.style.getPropertyValue('font-family') || rule.style.fontFamily;
                const name = pickFont(fam);
                if (name) faceNames.add(name);
              }
              if (rule.cssText) faceCss += rule.cssText + '\n';
            }
          }
          if (faceCss) {
            fontFaceCssChunks.push({ base: sheet.href || location.href, text: faceCss });
          }
        }
      } catch { /* noop */ }
      // Inline <style> blocks (often hold @font-face on simpler sites)
      document.querySelectorAll('style').forEach((s) => {
        const t = s.textContent || '';
        if (t && /@font-face/i.test(t)) {
          fontFaceCssChunks.push({ base: location.href, text: t });
        }
      });
      // Stylesheet hrefs for Node fetch (same-origin Nuxt/Vite bundles etc.)
      const stylesheetHrefs = [];
      document.querySelectorAll('link[rel="stylesheet"][href]').forEach((l) => {
        try {
          const u = new URL(l.getAttribute('href') || '', location.href).href;
          if (/^https?:\/\//i.test(u) && !stylesheetHrefs.includes(u)) stylesheetHrefs.push(u);
        } catch { /* noop */ }
      });
      // Google / Adobe font <link>s
      const linkFonts = [];
      document.querySelectorAll('link[rel="stylesheet"][href],link[href*="fonts.googleapis"],link[href*="use.typekit"],link[href*="fonts.adobe"]').forEach((l) => {
        const href = l.getAttribute('href') || '';
        // Google: family=Roboto:wght@400;700 | family=Open+Sans&family=Roboto
        try {
          const u = new URL(href, location.href);
          if (/fonts\.googleapis\.com/.test(u.host)) {
            const fams = u.searchParams.getAll('family');
            for (const f of fams) {
              const name = decodeURIComponent(f.split(':')[0]).replace(/\+/g, ' ').trim();
              if (name) linkFonts.push(name);
            }
            // older ?family=Foo|Bar
            if (!fams.length && u.searchParams.get('family')) {
              for (const f of u.searchParams.get('family').split('|')) {
                const name = decodeURIComponent(f.split(':')[0]).replace(/\+/g, ' ').trim();
                if (name) linkFonts.push(name);
              }
            }
          }
          if (/typekit|fonts\.adobe/.test(u.host + u.pathname)) {
            // can't resolve kit → family without network; skip names
          }
        } catch { /* noop */ }
      });

      const hEl = document.querySelector('h1') || document.querySelector('h2');
      const pEl = document.querySelector('p') || document.body;
      const monoEl = document.querySelector('code, pre, kbd, samp, [class*="mono" i]');
      const headingStack = hEl ? getComputedStyle(hEl).fontFamily : '';
      const bodyStack = pEl ? getComputedStyle(pEl).fontFamily : '';
      const monoStack = monoEl ? getComputedStyle(monoEl).fontFamily : '';
      const headingFont = pickFont(headingStack) || linkFonts[0] || [...faceNames][0] || null;
      const bodyFont = pickFont(bodyStack) || linkFonts[1] || linkFonts[0] || [...faceNames][1] || [...faceNames][0] || null;
      const monoFont = pickFont(monoStack) || null;
      let typography = null;
      if (headingFont || bodyFont) {
        let source = 'computed';
        if (linkFonts.length) source = 'link';
        else if (faceNames.size) source = 'font-face';
        typography = {
          headingFont: headingFont || null,
          bodyFont: bodyFont || null,
          fallbackStack: (bodyStack || headingStack || '').trim() || null,
          source,
        };
        if (!typography.fallbackStack) delete typography.fallbackStack;
      }
      // Cap CSS chunks shipped out of the page (keep @font-face sources, not whole bundles
      // when CSSOM already gave us face rules; full bundles come from stylesheetHrefs).
      const cssChunks = fontFaceCssChunks
        .map((c) => ({ base: c.base, text: String(c.text || '').slice(0, 200000) }))
        .slice(0, 30);
      const styleHrefs = stylesheetHrefs.slice(0, 25);

      // ── logo (richer) ─────────────────────────────────────────────────────
      // Prefer header/nav <img> or inline SVG; skip consent-manager junk.
      let primaryUrl = null;
      let darkVariantUrl = null;
      let iconUrl = null;
      const logoImgs = Array.from(document.querySelectorAll(
        'header img, nav img, [class*="logo" i] img, a[class*="logo" i] img, img[class*="logo" i], img[alt*="logo" i], img[alt*="brand" i]'
      ));
      for (const img of logoImgs) {
        // skip if inside cookie/consent container
        if (img.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i]')) continue;
        const src = abs(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '');
        if (!src || isJunkLogo(src)) continue;
        const cls = `${img.className || ''} ${img.alt || ''} ${src}`.toLowerCase();
        if (/dark|inverted|white|mono-on-dark/.test(cls) && !darkVariantUrl) {
          darkVariantUrl = src;
          continue;
        }
        if (!primaryUrl) primaryUrl = src;
        if (primaryUrl && darkVariantUrl) break;
      }
      // Inline SVG in header/nav marked as logo
      if (!primaryUrl) {
        const svg = document.querySelector('header svg, nav svg, [class*="logo" i] svg, a[class*="logo" i] svg');
        if (svg && !svg.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]')) {
          try {
            const s = new globalThis.XMLSerializer().serializeToString(svg);
            if (s && s.length < 200000) {
              primaryUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s)));
            }
          } catch { /* noop */ }
        }
      }
      // Icons / favicons
      const touch = document.querySelector('link[rel="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"]');
      if (touch) {
        const t = abs(touch.getAttribute('href'));
        if (t && !isJunkLogo(t)) iconUrl = t;
      }
      if (!iconUrl) {
        const icons = [...document.querySelectorAll('link[rel~="icon"]')]
          .map((l) => ({ href: l.getAttribute('href'), size: parseInt((l.getAttribute('sizes') || '0').split('x')[0], 10) || 0 }))
          .filter((i) => i.href)
          .sort((a, b) => b.size - a.size);
        if (icons[0]) {
          const t = abs(icons[0].href);
          if (t && !isJunkLogo(t)) iconUrl = t;
        }
      }
      // last resort primary: icon, then og:image (often a share card — only if nothing else)
      if (!primaryUrl && iconUrl) primaryUrl = iconUrl;
      if (!primaryUrl) {
        const og = document.querySelector('meta[property="og:image"]');
        if (og && og.getAttribute('content')) {
          const t = abs(og.getAttribute('content'));
          if (t && !isJunkLogo(t)) primaryUrl = t;
        }
      }
      // legacy logoUrl = primary preferred, else icon
      const logo = primaryUrl || iconUrl || null;
      const logoObj = (primaryUrl || iconUrl) ? {
        primaryUrl: primaryUrl || iconUrl,
        format: fmtOf(primaryUrl || iconUrl) || 'unknown',
        ...(darkVariantUrl ? { darkVariantUrl } : {}),
        ...(iconUrl && iconUrl !== primaryUrl ? { iconUrl } : (iconUrl ? { iconUrl } : {})),
      } : null;

      // ── buttonStyle from primary CTA ──────────────────────────────────────
      let buttonStyle = null;
      const ctaSelectors = [
        'a[class*="cta" i]', 'button[class*="cta" i]',
        'a[class*="btn-primary" i]', 'button[class*="btn-primary" i]',
        'a[class*="primary" i]', 'button[class*="primary" i]',
        '[class*="btn" i][class*="primary" i]',
        'header a[class*="btn" i]', 'header button',
        'a[class*="button" i]', 'button',
      ];
      let cta = null;
      for (const sel of ctaSelectors) {
        const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 20) return false;
          if (el.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]')) return false;
          return true;
        });
        if (els.length) { cta = els[0]; break; }
      }
      if (cta) {
        const cs = getComputedStyle(cta);
        const br = cs.borderRadius || '0';
        // parse first radius value → px
        let radiusPx = null;
        const rm = String(br).match(/([\d.]+)(px|rem|em|%)/);
        if (rm) {
          let v = parseFloat(rm[1]);
          if (rm[2] === 'rem' || rm[2] === 'em') v *= 16;
          if (rm[2] === '%') {
            // percent of height roughly
            v = (parseFloat(rm[1]) / 100) * (cta.getBoundingClientRect().height || 40);
          }
          radiusPx = Math.round(v);
        }
        const bgC = toRGB(cs.backgroundColor);
        const bw = parseFloat(cs.borderTopWidth || '0') || 0;
        const height = cta.getBoundingClientRect().height || 40;
        let style = 'filled';
        if (!bgC || (sl(bgC).l > 0.95 && bw >= 1) || (cs.backgroundColor === 'transparent' && bw >= 1)) style = 'outline';
        else if (radiusPx != null && radiusPx >= height * 0.45) style = 'pill';
        buttonStyle = { radiusPx: radiusPx != null ? radiusPx : undefined, style };
        if (buttonStyle.radiusPx == null) delete buttonStyle.radiusPx;
      }

      // ── imageryStyle (cheap DOM heuristic, one structured line) ───────────
      let imageryStyle = null;
      const imgs = Array.from(document.querySelectorAll('img, picture source, video, canvas, [class*="illustration" i], [class*="hero" i] img'))
        .slice(0, 40);
      let photo = 0, illustration = 0, threeD = 0, total = 0;
      for (const el of imgs) {
        const tag = el.tagName.toLowerCase();
        const meta = `${el.getAttribute('src') || ''} ${el.getAttribute('alt') || ''} ${el.className || ''} ${el.getAttribute('type') || ''}`.toLowerCase();
        if (el.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]')) continue;
        if (tag === 'img' || tag === 'source') {
          total++;
          if (/\.svg(?:[?#]|$)/.test(meta) || /illustrat|icon|draw|vector|graphic/.test(meta)) illustration++;
          else if (/3d|render|isometric|clay|blender|cgi/.test(meta)) threeD++;
          else if (/photo|image|jpg|jpeg|png|webp|avif|headshot|team|office|product/.test(meta) || true) {
            // default raster → photography-leaning unless named otherwise
            if (/\.svg/.test(meta)) illustration++;
            else photo++;
          }
        } else if (tag === 'video') { total++; photo++; }
        else if (/illustrat/.test(meta)) { total++; illustration++; }
        else if (/3d|isometric/.test(meta)) { total++; threeD++; }
      }
      // background-image on hero
      document.querySelectorAll('[class*="hero" i],header,main').forEach((el, idx) => {
        if (idx > 6) return;
        const bi = getComputedStyle(el).backgroundImage || '';
        if (bi && bi !== 'none' && /url\(/.test(bi)) {
          total++;
          if (/\.svg/.test(bi)) illustration++;
          else photo++;
        }
      });
      if (total > 0) {
        const scores = [
          ['photography', photo],
          ['illustration', illustration],
          ['3d', threeD],
        ].sort((a, b) => b[1] - a[1]);
        let style = scores[0][0];
        const top = scores[0][1];
        const second = scores[1][1];
        if (top > 0 && second > 0 && second >= top * 0.5) style = 'mixed';
        if (top === 0) style = 'mixed';
        const treatmentParts = [];
        if (photo) treatmentParts.push(`${photo} raster/photo`);
        if (illustration) treatmentParts.push(`${illustration} illustration/svg`);
        if (threeD) treatmentParts.push(`${threeD} 3d`);
        imageryStyle = {
          style,
          treatment: treatmentParts.length
            ? `Hero/content media leans ${style} (${treatmentParts.join(', ')} signals on homepage).`
            : `Homepage media classified as ${style}.`,
        };
      }

      return {
        accent,
        bg,
        logo,
        palette,
        typography,
        monoFont: monoFont || null,
        cssChunks,
        styleHrefs,
        logoObj,
        buttonStyle,
        imageryStyle,
      };
    });
    await browser.close();
    browser = null;
    const latencyMs = Date.now() - startTime;
    const logoObj = visual.logoObj || null;
    // Prefer non-junk primary. Legacy logoUrl is consumed by video/buildBrand which
    // only accepts http(s) — so prefer an https mark, then https icon, then data SVG.
    let logoUrl = visual.logo || null;
    if (logoUrl && isJunkLogoUrl(logoUrl)) logoUrl = null;
    const httpsPrimary = logoObj?.primaryUrl && /^https?:\/\//i.test(logoObj.primaryUrl) && !isJunkLogoUrl(logoObj.primaryUrl)
      ? logoObj.primaryUrl : null;
    const httpsIcon = logoObj?.iconUrl && /^https?:\/\//i.test(logoObj.iconUrl) && !isJunkLogoUrl(logoObj.iconUrl)
      ? logoObj.iconUrl : null;
    logoUrl = httpsPrimary || httpsIcon || logoUrl || null;

    const result = {
      success: true,
      accentColor: visual.accent || null,
      bgColor: visual.bg || null,
      logoUrl,
      scrapeVersion: BRAND_VISUAL_SCRAPE_VERSION,
      latencyMs,
    };
    if (Array.isArray(visual.palette) && visual.palette.length) {
      result.palette = dedupePalette(visual.palette, 8);
      // Legacy accent/bg: if the CTA heuristic missed, promote from measured palette.
      // Prefer saturated brand roles; never invent — only use palette entries we already captured.
      if (!result.accentColor) {
        const rank = { accent: 4, primary: 3, secondary: 2 };
        const pick = [...result.palette]
          .filter((p) => rank[p.role])
          .sort((a, b) => (rank[b.role] || 0) - (rank[a.role] || 0))[0]
          || result.palette.find((p) => p.role !== 'background' && p.role !== 'text' && p.role !== 'neutral');
        if (pick?.hex) result.accentColor = pick.hex;
      }
      if (!result.bgColor) {
        const bg = result.palette.find((p) => p.role === 'background');
        if (bg?.hex) result.bgColor = bg.hex;
      }
    }
    if (visual.typography && (visual.typography.headingFont || visual.typography.bodyFont)) {
      result.typography = visual.typography;
    }
    // ── webfont metadata (brandVisual/3) ────────────────────────────────────
    // Parse @font-face from CSSOM face rules + fetched stylesheets, then HEAD/
    // ranged-GET each font URL for bytes + magic. NEVER store binaries in JSONB.
    try {
      const parsed = [];
      for (const chunk of visual.cssChunks || []) {
        parsed.push(...parseFontFaceBlocks(chunk.text, chunk.base || url));
      }
      // Fetch linked stylesheets (same-origin Nuxt/Vite CSS that CSSOM may not
      // expose fully cross-origin). Cap size/count for bandwidth.
      const hrefs = Array.isArray(visual.styleHrefs) ? visual.styleHrefs.slice(0, 15) : [];
      await Promise.all(hrefs.map(async (href) => {
        try {
          const ac = new AbortController();
          const tid = setTimeout(() => ac.abort(), 10000);
          let res;
          try {
            res = await fetch(href, {
              headers: { 'User-Agent': 'ForgeIntelligenceBrandVisual/3', Accept: 'text/css,*/*' },
              signal: ac.signal,
              redirect: 'follow',
            });
          } finally { clearTimeout(tid); }
          if (!res?.ok) return;
          // Read at most ~1.5MB of CSS text — enough for face tables, not whole design systems.
          const text = (await res.text()).slice(0, 1_500_000);
          if (/@font-face/i.test(text)) parsed.push(...parseFontFaceBlocks(text, href));
        } catch { /* stylesheet fetch is best-effort */ }
      }));

      // Dedupe before probe
      const seenFace = new Set();
      const unique = [];
      for (const f of parsed) {
        const key = `${f.family}::${f.weightRange}::${f.url}`;
        if (seenFace.has(key)) continue;
        seenFace.add(key);
        unique.push(f);
      }

      if (unique.length) {
        const headingFont = result.typography?.headingFont || null;
        const bodyFont = result.typography?.bodyFont || null;
        const monoFont = visual.monoFont || null;
        const fonts = await enrichFontFaces(unique.slice(0, 40), {
          headingFont,
          bodyFont,
          monoFont,
          includeFontBinaries: !!metadata?.includeFontBinaries,
          timeout: 12000,
          concurrency: 4,
        });
        if (fonts.length) {
          result.fonts = fonts;
          // Cross-fill typography from verified primary faces when computed stack was generic
          if (!result.typography) result.typography = {};
          const primary = fonts.find((f) => f.role === 'primary');
          if (primary) {
            if (!result.typography.headingFont) result.typography.headingFont = primary.family;
            if (!result.typography.bodyFont) result.typography.bodyFont = primary.family;
            if (!result.typography.source) result.typography.source = 'font-face';
          }
          // Drop empty typography shell
          if (!result.typography.headingFont && !result.typography.bodyFont) delete result.typography;
        }
      }
    } catch { /* font harvest is additive / best-effort */ }

    if (logoObj && (logoObj.primaryUrl || logoObj.iconUrl)) {
      // re-filter junk
      const clean = { ...logoObj };
      if (clean.primaryUrl && isJunkLogoUrl(clean.primaryUrl)) delete clean.primaryUrl;
      if (clean.iconUrl && isJunkLogoUrl(clean.iconUrl)) delete clean.iconUrl;
      if (clean.darkVariantUrl && isJunkLogoUrl(clean.darkVariantUrl)) delete clean.darkVariantUrl;
      if (!clean.primaryUrl && clean.iconUrl) clean.primaryUrl = clean.iconUrl;
      if (clean.primaryUrl) {
        clean.format = guessImageFormat(clean.primaryUrl) || clean.format || 'unknown';
        result.logo = clean;
        if (!result.logoUrl) result.logoUrl = clean.primaryUrl;
      }
    }
    if (visual.buttonStyle && (visual.buttonStyle.radiusPx != null || visual.buttonStyle.style)) {
      result.buttonStyle = visual.buttonStyle;
    }
    if (visual.imageryStyle?.style) result.imageryStyle = visual.imageryStyle;

    await _logScrape({
      url,
      source: 'brightdata_browser',
      status_code: 200,
      body_size: 0,
      latency_ms: latencyMs,
      success: true,
      caller,
      metadata: {
        ...(metadata ?? {}),
        kind: 'visual',
        scrapeVersion: BRAND_VISUAL_SCRAPE_VERSION,
        visual: {
          accent: result.accentColor,
          bg: result.bgColor,
          logo: result.logoUrl,
          paletteCount: result.palette?.length || 0,
          hasTypography: !!result.typography,
          fontCount: result.fonts?.length || 0,
          hasButtonStyle: !!result.buttonStyle,
          imageryStyle: result.imageryStyle?.style || null,
        },
      },
    });
    return result;
  } catch (e) {
    if (browser) { try { await browser.close(); } catch {} }
    await _logScrape({ url, source: 'brightdata_browser', success: false, latency_ms: Date.now() - startTime, caller, error: e.message, metadata: { ...(metadata ?? {}), kind: 'visual' } });
    return { success: false, error: e.message };
  }
}

// ── captureProductShots — REAL screenshots of the brand's live site ─────────
// Powers the video generator's "screens" scene (the single biggest lever on
// looking like the actual product vs an abstract reel). Reuses the same Bright
// Data browser as captureBrandVisual, but at the render's viewport and WITH
// images/styles (we're taking pictures, not reading computed CSS). Grabs up to
// `max` evenly-spaced sections by scrolling. Best-effort: any failure returns
// { success:false, shots:[] } and the reel falls back to non-screenshot scenes.
export async function captureProductShots(url, { orientation = 'landscape', max = 3, caller = 'video', timeout = 30000, metadata = {} } = {}) {
  const browserAuth = process.env.BRIGHTDATA_BROWSER_AUTH;
  const startTime = Date.now();
  if (!browserAuth) return { success: false, error: 'BRIGHTDATA_BROWSER_AUTH missing', shots: [] };
  if (!/^https?:\/\//.test(String(url || ''))) return { success: false, error: 'invalid url', shots: [] };
  const portrait = orientation === 'portrait';
  const width = portrait ? 1080 : 1920;
  const height = portrait ? 1920 : 1080;
  let browser = null;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://${browserAuth}@brd.superproxy.io:9222` });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeout);
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    // Keep images + stylesheets (we want a real picture); drop only fonts/media for bandwidth.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      if (['font', 'media'].includes(t)) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500)); // settle layout + lazy hero imagery
    // Remove the usual cookie/consent overlays and top sticky bars so they don't ruin the shot.
    await page.evaluate(() => {
      const kill = (el) => { try { el && el.remove(); } catch { /* noop */ } };
      document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i]').forEach(kill);
      document.querySelectorAll('body *').forEach((el) => {
        const cs = getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'sticky') && el.getBoundingClientRect().top < 4) kill(el);
      });
    }).catch(() => { /* overlays are best-effort */ });
    const pageHeight = await page.evaluate(() => Math.min(document.body.scrollHeight, 12000)).catch(() => height);
    const span = Math.max(0, pageHeight - height);
    // Only take multiple shots if there's real page below the fold.
    const n = Math.max(1, Math.min(max, span > height * 0.6 ? max : 1));
    const shots = [];
    for (let i = 0; i < n; i++) {
      const y = n === 1 ? 0 : Math.round((span / (n - 1)) * i);
      await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
      await new Promise((r) => setTimeout(r, 600)); // let scroll-triggered content paint
      const buf = await page.screenshot({ type: 'png' });
      shots.push(Buffer.from(buf));
    }
    await browser.close();
    browser = null;
    await _logScrape({ url, source: 'brightdata_browser', status_code: 200, body_size: 0, latency_ms: Date.now() - startTime, success: true, caller, metadata: { ...(metadata ?? {}), kind: 'product_shots', count: shots.length, orientation } });
    return { success: true, shots };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
    await _logScrape({ url, source: 'brightdata_browser', success: false, latency_ms: Date.now() - startTime, caller, error: e.message, metadata: { ...(metadata ?? {}), kind: 'product_shots' } });
    return { success: false, error: e.message, shots: [] };
  }
}

export async function forgeScrape(url, opts = {}) {
  const {
    format = 'raw',           // 'raw' = HTML, 'markdown' = cleaned content
    timeout = 60000,          // ms — Bright Data can take 5-15s on complex sites
    country = null,           // optional ISO country code for geo-targeting
    caller = 'unknown',       // string identifier for the log
    metadata = {},
    render = 'auto',          // 'auto' = Unlocker → Browser fallback on SPA shell
                              // 'always' = skip Unlocker, go straight to Browser
                              // 'never' = Unlocker only, no fallback
  } = opts;

  // 'always': caller knows this is a JS-heavy site, skip Tier 1
  if (render === 'always') {
    return await _tryScrapingBrowser(url, { timeout, caller, metadata });
  }

  // Tier 1: Web Unlocker
  const unlockerResult = await _tryUnlocker(url, { format, timeout, country, caller, metadata });

  // 'never': don't fall back even if shell detected
  if (render === 'never') return unlockerResult;

  // 'auto': fall back to Scraping Browser when Tier 1 returned a SPA shell
  // OR when Tier 1 failed entirely (network/HTTP error). Markdown format
  // skips the shell-detection branch since the body is reformatted text,
  // not HTML.
  if (format !== 'raw') return unlockerResult;
  // Escalate on failure, SPA shell, OR a near-empty body — a "successful"
  // fetch under 500 chars can't contain a real page and looksLikeSpaShell
  // returns false for empty html, so it must be checked explicitly.
  const needsBrowser = !unlockerResult.success
    || !unlockerResult.html
    || unlockerResult.html.trim().length < 500
    || looksLikeSpaShell(unlockerResult.html);
  if (!needsBrowser) return unlockerResult;

  console.log(`[forgeScrape] Tier 1 ${unlockerResult.success ? 'returned shell' : 'failed'} for ${url} (caller=${caller}) — escalating to Scraping Browser`);
  const browserResult = await _tryScrapingBrowser(url, { timeout, caller, metadata });
  // If browser also failed, return whichever attempt produced more useful
  // content (browser preferred when both have errors, since it's the
  // higher-tier tool).
  if (browserResult.success) return browserResult;
  return unlockerResult.success ? unlockerResult : browserResult;
}

// ── getBrandPageContent — Stage 1 page-content primitive ───────────────────
// Returns clean markdown for a single brand page. Two-tier:
//
//   Tier A: Jina Reader (r.jina.ai) — semantic content extraction with built-in
//           JS rendering. Returns markdown directly. Fast on the common case.
//   Tier B: forgeScrape (Tier 1 → Tier 2 cascade) + local Mozilla Readability
//           + Turndown. For sites Jina can't reach (rate-limit, geo-block,
//           outright failure) — we render via Bright Data and extract locally.
//
// Returns { success, markdown, source, latencyMs, error }
//   source: 'jina_reader' | 'brightdata_unlocker' | 'brightdata_browser'
//
// Every attempt is logged to scrape_log with caller='context-hub' for audit.
const _turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '_' });

// jsdom's CSS parser (rrweb-cssom) chokes on modern CSS — nested rules, @layer,
// @container, :has(), etc. — and emits noisy "Could not parse CSS stylesheet"
// jsdomError events on the default virtual console, which forwards straight to
// console.error and spams scrape logs. We only build the DOM for Readability
// text extraction; CSS is irrelevant here. Swallow the CSS-parse noise while
// still surfacing any other jsdom error.
const _scrapeConsole = new VirtualConsole();
_scrapeConsole.on('jsdomError', (err) => {
  if (err && /Could not parse CSS stylesheet/.test(err.message || '')) return;
  console.error(err);
});

function htmlToMarkdown(html, url) {
  try {
    const dom = new JSDOM(html, { url, virtualConsole: _scrapeConsole });
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) return '';
    return _turndown.turndown(article.content).trim();
  } catch {
    return '';
  }
}

// ── extractEmbeddedStateText — last-chance extraction for JS-state sites ────
// Cargo Collective, Next/Nuxt exports, and similar builders ship the entire
// page content inside an embedded JSON blob (window.__PRELOADED_STATE__ =
// {...} or a <script type="application/json"> tag) with almost no semantic
// DOM — Readability extracts 0 chars even though the raw HTML holds the full
// site copy (oooagency.com, 2026-07-06: 81KB of HTML, all of it in
// __PRELOADED_STATE__). This walks those blobs and harvests human-prose
// strings so the brand profile is grounded in the brand's actual copy.

// Balanced-brace scan: return the JSON object literal starting at html[start]
// (which must be '{'), respecting string literals and escapes. Null if
// unbalanced within the cap.
function _sliceBalancedJson(html, start, cap = 2_000_000) {
  let depth = 0, inStr = false, esc = false;
  const end = Math.min(html.length, start + cap);
  for (let i = start; i < end; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

// Recursively collect prose-looking strings from a parsed JSON value.
// Skips URLs/paths/colors/dates/identifiers; strips tags from HTML fragments
// (builders store content as HTML strings inside the state).
function _collectHumanStrings(node, out, seen, budget) {
  if (budget.nodes-- <= 0 || budget.chars <= 0) return;
  if (typeof node === 'string') {
    let s = node.trim();
    if (s.length < 20) return;
    if (/^(https?:\/\/|\/\/|data:|#[0-9a-f]{3,8}$|[{[])/i.test(s)) return;
    if (/^[\w.-]+\.(png|jpe?g|gif|svg|webp|css|js|woff2?)($|\?)/i.test(s)) return;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return;                 // ISO dates
    if (/[{}]/.test(s) && /[:;]/.test(s)) return;              // inline CSS blobs
    if (/<[a-z][^>]*>/i.test(s)) s = s.replace(/<[^>]+>/g, ' '); // strip HTML tags
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (s.length < 20 || !s.includes(' ')) return;              // require multi-word prose
    if (!/[a-z]{3}/i.test(s)) return;                           // require real words
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
    budget.chars -= s.length;
    return;
  }
  if (Array.isArray(node)) { for (const v of node) _collectHumanStrings(v, out, seen, budget); return; }
  if (node && typeof node === 'object') { for (const v of Object.values(node)) _collectHumanStrings(v, out, seen, budget); }
}

export function extractEmbeddedStateText(html) {
  if (!html || html.length < 500) return '';
  const out = [];
  const seen = new Set();
  const budget = { nodes: 50_000, chars: 30_000 };
  try {
    // Pattern 1: window.__PRELOADED_STATE__ = {...} / __NEXT_DATA__ = {...} etc.
    for (const m of html.matchAll(/(?:window\.)?__[A-Z][A-Z0-9_]+__\s*=\s*/g)) {
      const at = m.index + m[0].length;
      if (html[at] !== '{') continue;
      const blob = _sliceBalancedJson(html, at);
      if (!blob || blob.length < 1000) continue;
      try { _collectHumanStrings(JSON.parse(blob), out, seen, budget); } catch { /* not clean JSON */ }
      if (budget.chars <= 0) break;
    }
    // Pattern 2: <script type="application/json"> payloads (__NEXT_DATA__ style)
    if (budget.chars > 0) {
      for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        const raw = m[1].trim();
        if (raw.length < 1000 || raw[0] !== '{') continue;
        try { _collectHumanStrings(JSON.parse(raw), out, seen, budget); } catch { /* skip */ }
        if (budget.chars <= 0) break;
      }
    }
  } catch { /* extraction is best-effort */ }
  const text = out.join('\n').trim();
  return text.length >= 200 ? text : '';
}

export async function getBrandPageContent(url, { caller = 'context-hub', metadata = {}, jinaTimeout = 15000 } = {}) {
  // ── Tier A: Jina Reader ──────────────────────────────────────────────────
  const jinaStart = Date.now();
  try {
    // X-With-Links-Summary asks Jina to append a "Links/Buttons:" section
    // after the readability-extracted markdown. Crucial for SPA marketing
    // pages: readability drops the <nav>/<header> region, so without this
    // header the markdown contains content-area links only — missing the
    // primary nav (pricing, blog, book-demo, etc.) that we need for
    // subpage discovery. The appended section uses standard [text](url)
    // syntax, so our existing extractMarkdownLinks regex picks it up
    // automatically.
    const headers = { 'Accept': 'text/plain', 'X-With-Links-Summary': 'true' };
    if (process.env.JINA_API_KEY) headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), jinaTimeout);
    let resp;
    try {
      resp = await fetch(`https://r.jina.ai/${url}`, { headers, signal: ac.signal });
    } finally { clearTimeout(tid); }
    const latencyMs = Date.now() - jinaStart;
    if (resp.ok) {
      const markdown = (await resp.text()).trim();
      const usable = markdown.length > 500;
      await _logScrape({
        url, source: 'jina_reader', status_code: resp.status, body_size: markdown.length,
        latency_ms: latencyMs, success: usable, caller,
        metadata: { ...metadata, body_sample: markdown.slice(0, 2000) },
        error: usable ? null : `markdown under threshold (${markdown.length} chars)`,
      });
      if (usable) return { success: true, markdown, source: 'jina_reader', latencyMs, error: null };
    } else {
      await _logScrape({
        url, source: 'jina_reader', status_code: resp.status, body_size: 0,
        latency_ms: latencyMs, success: false, caller, metadata,
        error: `HTTP ${resp.status}`,
      });
    }
  } catch (e) {
    await _logScrape({
      url, source: 'jina_reader', success: false, latency_ms: Date.now() - jinaStart,
      caller, metadata, error: e.message,
    });
  }

  // ── Tier B: forgeScrape → Readability + Turndown ─────────────────────────
  // forgeScrape logs its own attempts (Tier 1 + Tier 2 rows) — no double-log here.
  const fetched = await forgeScrape(url, { caller, metadata });
  if (!fetched.success || !fetched.html) {
    return { success: false, markdown: null, source: fetched.source, latencyMs: fetched.latencyMs, error: fetched.error || 'forgeScrape returned no html' };
  }
  const markdown = htmlToMarkdown(fetched.html, url);
  if (markdown.length < 200) {
    // Tier C: embedded-JSON state extraction. Cargo/Next/Nuxt-style sites keep
    // all page copy inside a preloaded-state blob that Readability can't see.
    const embedded = extractEmbeddedStateText(fetched.html);
    if (embedded) {
      console.log(`[getBrandPageContent] Readability empty for ${url} — recovered ${embedded.length} chars from embedded JSON state`);
      return { success: true, markdown: embedded, source: `${fetched.source}+embedded_json`, latencyMs: fetched.latencyMs, error: null };
    }
    return { success: false, markdown: null, source: fetched.source, latencyMs: fetched.latencyMs, error: `Readability extracted ${markdown.length} chars (under threshold)` };
  }
  return { success: true, markdown, source: fetched.source, latencyMs: fetched.latencyMs, error: null };
}

// ── discoverSubpages — sitemap.xml first, link-extraction fallback ─────────
// Returns up to `max` same-origin URLs likely to contain brand-defining
// content (about, customers, pricing, integrations, FAQ, etc.). Skips noise
// (login, legal, blog post slugs, search/tag/category aggregates) and
// non-page assets (.css, .js, images, fonts, JSON, etc.).
//
// Discovery priority:
//   1. sitemap.xml (most reliable, follows sitemapindex)
//   2. seedMarkdown — parse [text](url) links from already-fetched home
//      content. Avoids a redundant homepage fetch when the caller already
//      has Jina markdown in hand.
//   3. seedHtml — parse <a href> links from already-fetched home HTML
//      (forgeScrape fallback path).
//   4. Last resort: forgeScrape the homepage just to get its links. Tight
//      20s timeout — we'd rather return [] than spend 60s here.
function rankBrandPages(urls) {
  const HIGH = /\/(about|story|mission|team|company|why-us|our-)/i;
  const MED  = /\/(product|service|customer|case-stud|pricing|integration|faq|how-it-works|solution|platform)/i;
  // Block non-page assets and admin/auth/legal noise. Asset extensions are
  // the common bleed source — link-extraction picks up <link rel="stylesheet">,
  // <link rel="icon">, font preconnects, etc. We reject them here as a
  // belt-and-suspenders alongside the anchor-only regex in extractAnchorHrefs.
  const SKIP_PATH = /\/(login|signup|sign-in|sign-up|legal|privacy|terms|cookie|sitemap|robots|admin|account|password|settings|cart|checkout|search\?|tag\/|tags\/|category\/|categories\/|author\/|feed|rss|wp-json|wp-admin|api\/)/i;
  const SKIP_EXT  = /\.(css|js|mjs|cjs|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|pdf|xml|json|txt|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|zip|gz)(\?|$)/i;
  const seen = new Set();
  const scored = [];
  for (const raw of urls) {
    // Strip fragment, query, AND trailing slash so /about and /about/ dedupe
    // and don't appear as two distinct subpages.
    const u = raw.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '');
    if (!u || seen.has(u) || SKIP_PATH.test(u) || SKIP_EXT.test(u)) continue;
    seen.add(u);
    scored.push({ url: u, score: HIGH.test(u) ? 3 : MED.test(u) ? 2 : 1 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.url);
}

// Extract only anchor-tag hrefs (<a href="...">) from HTML — ignores
// <link>, <img>, <script>, <iframe>, etc. The naive /href="[^"]+"/ regex
// scoops up stylesheet links, favicon preconnects, and font URLs, which
// then ride through ranking as fake "subpages."
function extractAnchorHrefs(html) {
  return [...html.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
}

// Extract URLs from Markdown link syntax [text](url) — used when we already
// have Jina markdown for the homepage and want to skip a second fetch.
function extractMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]);
}

export async function discoverSubpages(baseUrl, max = 8, { seedMarkdown = null, seedHtml = null } = {}) {
  const baseHost = new URL(baseUrl).host;
  const origin = new URL(baseUrl).origin;
  const sameOrigin = (u) => { try { return new URL(u).host === baseHost; } catch { return false; } };
  // Strip fragment and trailing slash for comparison/dedup. Without this,
  // [See How It Works](https://example.com/#capabilities) escapes the
  // baseUrl filter (URL with fragment !== baseUrl) and rides through as
  // a "subpage" — even though it's literally the homepage with an anchor.
  const canonical = (u) => u.replace(/#.*$/, '').replace(/\/+$/, '');
  const baseCanonical = canonical(baseUrl);
  const normalize = (u) => u.startsWith('/') ? origin + u : u;
  const isPage = (u) => /^https?:\/\//i.test(u) && sameOrigin(u) && canonical(u) !== baseCanonical;

  // Step 1: sitemap.xml (handles sitemapindex by following the first child)
  try {
    // SSRF-safe: fetch sitemaps through forgeScrape (Bright Data) like every
    // other external fetch, rather than hitting the URL directly from this
    // server. baseUrl and the child <loc> are attacker-controllable, so a direct
    // fetch could reach internal/metadata endpoints. render:'never' = Unlocker
    // only (sitemaps are static XML — no browser tier needed); it also gets the
    // sitemap past Cloudflare/WAF on protected sites. Tight 12s budget — if it's
    // slow we'd rather fall through to link extraction.
    const sm = await forgeScrape(new URL('/sitemap.xml', baseUrl).href, { render: 'never', caller: 'context-hub-sitemap', timeout: 12000 });
    if (sm.success && sm.html) {
      let xml = sm.html;
      let urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
      if (/<sitemapindex/i.test(xml) && urls.length) {
        const child = await forgeScrape(urls[0], { render: 'never', caller: 'context-hub-sitemap', timeout: 12000 });
        if (child.success && child.html) {
          urls = [...child.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
        }
      }
      const ranked = rankBrandPages(urls.filter(sameOrigin).filter(u => u !== baseUrl && u !== `${baseUrl}/`));
      if (ranked.length) return ranked.slice(0, max);
    }
  } catch { /* sitemap missing/slow — fall through to link extraction */ }

  // Step 2: parse Jina markdown the caller already fetched. Cheap, zero
  // additional latency. Works for any site Jina could read.
  if (seedMarkdown) {
    const links = extractMarkdownLinks(seedMarkdown).map(normalize).filter(isPage);
    const ranked = rankBrandPages(links);
    if (ranked.length) return ranked.slice(0, max);
  }

  // Step 3: parse anchor hrefs from HTML the caller already has (Tier B path).
  if (seedHtml) {
    const links = extractAnchorHrefs(seedHtml).map(normalize).filter(isPage);
    const ranked = rankBrandPages(links);
    if (ranked.length) return ranked.slice(0, max);
  }

  // Step 4: last resort — forgeScrape the homepage just for its links.
  // Tight 20s timeout: if the home is a slow SPA we'd rather return [] than
  // spend 60s on a discovery fetch that the analyze handler already paid
  // separately for as primary content.
  try {
    const home = await forgeScrape(baseUrl, { caller: 'context-hub-discover', timeout: 20000 });
    if (home.success && home.html) {
      const links = extractAnchorHrefs(home.html).map(normalize).filter(isPage);
      return rankBrandPages(links).slice(0, max);
    }
  } catch { /* all discovery paths failed — caller continues with home only */ }

  return [];
}

export function _forgeScrapeRateLimited(key) {
  const now = Date.now();
  const windowMs = 60_000;
  const entry = _forgeScrapeHits.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    _forgeScrapeHits.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > FORGE_SCRAPE_RATE_PER_MIN;
}
