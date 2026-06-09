// Web scraping / crawl helpers, extracted from server.js during the
// decomposition. forgeScrape is the one fetch primitive (Bright Data Web
// Unlocker -> Scraping Browser cascade); the rest handle Readability
// extraction, markdown conversion, and subpage discovery.
import puppeteer from 'puppeteer-core';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
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
    await _logScrape({
      url, source: 'brightdata_unlocker',
      status_code: resp.status, body_size: responseBody.length, latency_ms: latencyMs,
      success: resp.ok, caller,
      metadata: { ...(metadata ?? {}), body_sample: resp.ok ? responseBody.slice(0, 15000) : undefined },
      error: resp.ok ? null : `HTTP ${resp.status}: ${responseBody.slice(0, 200)}`,
    });
    if (!resp.ok) {
      return { success: false, status: resp.status, html: null, source: 'brightdata_unlocker', latencyMs, error: `HTTP ${resp.status}: ${responseBody.slice(0, 200)}` };
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
// the true accent color + logo. Heuristic but measured, not guessed:
//   accent = most-weighted saturated color across CTAs/buttons (x3), header/nav
//            backgrounds (x2), link text (x1); neutrals/near-black/white dropped.
//   logo   = og:image -> rel=icon/apple-touch-icon -> header/nav/logo <img>.
// Returns { success, accentColor, bgColor, logoUrl }.
export async function captureBrandVisual(url, { caller = 'context-hub', timeout = 30000, metadata = {} } = {}) {
  const browserAuth = process.env.BRIGHTDATA_BROWSER_AUTH;
  const startTime = Date.now();
  if (!browserAuth) return { success: false, error: 'BRIGHTDATA_BROWSER_AUTH missing' };
  let browser = null;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://${browserAuth}@brd.superproxy.io:9222` });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeout);
    // Keep stylesheets (computed colors need them); drop only fonts/media for bandwidth.
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
        const m = s && s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map(x => parseFloat(x));
        if (p[3] !== undefined && p[3] < 0.5) return null; // transparent
        return { r: p[0], g: p[1], b: p[2] };
      };
      const sl = ({ r, g, b }) => {
        const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
        const l = (mx + mn) / 2;
        const s = mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
        return { s, l };
      };
      const hex = ({ r, g, b }) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
      const cand = {};
      const add = (rgb, w) => {
        if (!rgb) return;
        const { s, l } = sl(rgb);
        if (s < 0.18 || l < 0.08 || l > 0.92) return; // neutral / near-black / near-white
        const h = hex(rgb);
        cand[h] = (cand[h] || 0) + w;
      };
      document.querySelectorAll('button,[class*="btn"],[class*="Button"],[class*="cta"],[class*="Cta"]')
        .forEach(el => add(toRGB(getComputedStyle(el).backgroundColor), 3));
      document.querySelectorAll('header,nav,[class*="header"],[class*="nav"]')
        .forEach(el => add(toRGB(getComputedStyle(el).backgroundColor), 2));
      document.querySelectorAll('a').forEach(el => add(toRGB(getComputedStyle(el).color), 1));
      let accent = null, best = 0;
      for (const [h, w] of Object.entries(cand)) if (w > best) { best = w; accent = h; }
      const bodyRgb = toRGB(getComputedStyle(document.body).backgroundColor);
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
      let logo = null;
      const og = document.querySelector('meta[property="og:image"]');
      if (og && og.getAttribute('content')) logo = abs(og.getAttribute('content'));
      if (!logo) {
        const ico = [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]')].pop();
        if (ico) logo = abs(ico.getAttribute('href'));
      }
      if (!logo) {
        const img = document.querySelector('header img,nav img,[class*="logo"] img,img[class*="logo"],img[alt*="logo" i]');
        if (img) logo = abs(img.getAttribute('src'));
      }
      return { accent, bg: bodyRgb ? hex(bodyRgb) : null, logo };
    });
    await browser.close();
    browser = null;
    const latencyMs = Date.now() - startTime;
    await _logScrape({ url, source: 'brightdata_browser', status_code: 200, body_size: 0, latency_ms: latencyMs, success: true, caller, metadata: { ...(metadata ?? {}), kind: 'visual', visual } });
    return { success: true, accentColor: visual.accent, bgColor: visual.bg, logoUrl: visual.logo, latencyMs };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch {} }
    await _logScrape({ url, source: 'brightdata_browser', success: false, latency_ms: Date.now() - startTime, caller, error: e.message, metadata: { ...(metadata ?? {}), kind: 'visual' } });
    return { success: false, error: e.message };
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
  const needsBrowser = !unlockerResult.success || looksLikeSpaShell(unlockerResult.html);
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

function htmlToMarkdown(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) return '';
    return _turndown.turndown(article.content).trim();
  } catch {
    return '';
  }
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
