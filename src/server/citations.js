// Citation-source research, extracted from server.js during the decomposition.
// findCitationSources queries Perplexity Sonar for sources that support a given
// claim, then filters by domain quality + self-domain exclusion. Used by the
// compliance find-sources and verify-and-rewrite routes. Imports the shared pool
// for brand-domain lookup; LOW_QUALITY_CITATION_DOMAINS is module-private.
import { pool } from './db.js';

const LOW_QUALITY_CITATION_DOMAINS = new Set([
  'quora.com', 'answers.yahoo.com', 'reddit.com', 'stackexchange.com',
  'wikihow.com', 'ehow.com', 'ask.com',
  // AI content farms / SEO spam that often crowd the top results
  'contentatscale.ai', 'seowriting.ai', 'copyai.com',
  // LinkedIn posts are user-generated opinion — not a citation-grade source (LinkedIn company
  // pages/articles are fine, but /pulse/ and /posts/ URLs come back as random user posts)
]);

export async function findCitationSources({ claim, sectionBody, brandProfileId, maxResults = 3 }) {
  // Pull brand context for self-domain exclusion.
  let brandDomain = '';
  if (brandProfileId) {
    try {
      const r = await pool.query('SELECT brand_url FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (r.rows[0]) {
        const rawUrl = r.rows[0].brand_url || '';
        brandDomain = rawUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      }
    } catch(e) { /* non-fatal */ }
  }

  const claimText = (claim || '').trim().slice(0, 500);
  const sectionContext = (sectionBody || '').trim().slice(0, 800);

  const systemPrompt = `You are a citation researcher finding sources for a B2B thought-leadership article. Return sources that ACTUALLY SUPPORT the specific claim — not just topically-related articles. Prioritize in this order:
1. Primary sources (peer-reviewed research, government data, original surveys, SEC filings, company earnings reports)
2. Industry research firms (Gartner, Forrester, IDC, McKinsey, Deloitte, HubSpot/Salesforce/similar with original data)
3. Established trade publications (HBR, MIT Sloan, Wall Street Journal, Bloomberg, industry-leader publications)
4. Authoritative trade publications with named authors and clear methodology

Avoid: forums (Quora, Reddit, Stack Exchange), personal blogs, AI-generated content farms, press release aggregators, Wikipedia (except for well-sourced definitional claims), and LinkedIn user posts. Avoid sources older than 3 years for trend claims; older sources are acceptable for definitional or historical claims.

If the claim is definitional (e.g. "X is defined as..."), return authoritative definitional sources. If statistical (e.g. "73% of..."), return the primary survey/study. If a trend (e.g. "X is growing"), return recent industry reports. If a company-specific claim, return that company's own statement or filing.`;

  const claimTypeHints = [];
  if (/\b\d+\s*%|\b\d+x|\b\d+-fold/.test(claimText)) claimTypeHints.push('STATISTICAL — return the primary survey or study containing this exact data point.');
  if (/\bis defined as|means that|refers to\b/i.test(claimText)) claimTypeHints.push('DEFINITIONAL — return an authoritative industry or academic definition source.');
  if (/\bincreasing|growing|declining|trending|shift toward\b/i.test(claimText)) claimTypeHints.push('TREND — return recent (past 24 months) industry reports with data.');
  if (/\breport(ed)?|announced|stated\b/i.test(claimText) && /[A-Z][a-zA-Z]+\s+(Inc|LLC|Corp|Ltd)/.test(claimText)) claimTypeHints.push("COMPANY-SPECIFIC — return that company's own press release, earnings, or official blog.");

  const userMessage = `CLAIM TO SUPPORT:\n"${claimText}"\n\nCONTEXT (surrounding article text, for understanding — do NOT cite this):\n${sectionContext}\n${claimTypeHints.length ? '\nCLAIM TYPE: ' + claimTypeHints.join(' ') : ''}`;

  let sonarData = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const sonarRes = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        search_recency_filter: 'year',
      })
    });
    if (sonarRes.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!sonarRes.ok) {
      const err = await sonarRes.text();
      console.error('[FIND-SOURCES] Perplexity', sonarRes.status, err.slice(0, 200));
      throw new Error(`Source search failed (${sonarRes.status})`);
    }
    sonarData = await sonarRes.json();
    break;
  }
  if (!sonarData) throw new Error('Source search timed out');

  const searchResults = sonarData.search_results || [];
  const getDomain = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
  const seenDomains = new Set();
  const filtered = [];
  for (const r of searchResults) {
    const url = r.url || '';
    if (!url) continue;
    const domain = getDomain(url);
    if (brandDomain && domain === brandDomain) continue;
    if (seenDomains.has(domain)) continue;
    if (LOW_QUALITY_CITATION_DOMAINS.has(domain)) continue;
    if (domain === 'linkedin.com' && /\/(pulse|posts)\//i.test(url)) continue;
    seenDomains.add(domain);
    filtered.push({
      title: r.title || '',
      url,
      snippet: r.snippet || '',
      year: r.date ? String(r.date).slice(0, 4) : (r.last_updated ? String(r.last_updated).slice(0, 4) : ''),
      domain,
    });
    if (filtered.length >= maxResults) break;
  }
  console.log(`[FIND-SOURCES] claim="${claimText.slice(0,80)}..." returned=${filtered.length} (from ${searchResults.length} raw)`);
  return filtered;
}
