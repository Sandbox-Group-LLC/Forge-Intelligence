// Marketing/SEO server-side rendering, extracted from server.js during the
// decomposition. Static metadata (FAQ content, JSON-LD blocks, per-route meta)
// + renderMarketingPage, which injects head tags + crawler-visible body content
// into the SSR'd index.html for the public marketing routes (/, /product, /faq).
// Pure templating — no DB/network. Only MARKETING_META + renderMarketingPage are
// consumed by the route handler; the rest are module-private.

const FAQ_PAIRS = [
  // What it is — define the category
  { q: "What's the difference between AI content generation and AI content intelligence?", a: "AI content generation produces output. AI content intelligence builds the strategic worldview that makes the output worth producing. Generation tools take a prompt and write an article. Intelligence systems extract competitive gaps, audience blind spots, and topical whitespace first — then condition every word against that worldview. Forge inverts the order: intelligence is upstream of generation." },
  { q: "What is a Context Agent Architecture?", a: "A Context Agent Architecture is a sequenced system of specialized AI agents where each stage conditions the next. Forge's pipeline runs eight: Context Hub, GEO Strategist, Authenticity Enricher, Content Generator, Compliance Gate, Publishing Queue, Performance Dashboard, and Brain Memory. By stage four, the model isn't writing from a prompt. It's writing from a fully constructed competitive worldview." },
  { q: "What is Generative Engine Optimization (GEO) and how is it different from SEO?", a: "GEO optimizes content to be cited by AI engines like ChatGPT, Perplexity, and Gemini. SEO optimizes content to rank in search results. Different inputs, different ranking signals, different success metrics. SEO rewards keyword authority and backlinks. GEO rewards distinctive concepts, named frameworks, and citeable definitions that AI engines can attribute back to you. Same goal — visibility — different game." },
  { q: "What is Voice of Market and how is it different from Share of Voice?", a: "Share of Voice measures how often your brand shows up versus competitors. It's a backward-looking scoreboard. Voice of Market measures the unspoken market tension no competitor has named yet — the strategic angle that hasn't been claimed. Share of voice tells you where you stand. Voice of market tells you where to attack. One is a metric. The other is an advantage." },
  { q: 'What does "compounding" mean in B2B content operations?', a: "Compounding content operations get smarter every cycle through an explicit feedback loop. Performance data writes back into strategy via Brain Memory — the 8th and final agent in Forge's Context Agent Architecture. Patterns that worked become reusable templates. Mistakes get flagged and avoided. The system never starts from scratch. Every published article makes the next one easier to brief, faster to write, and more likely to convert." },
  { q: "What does it mean for an AI content tool to be stateful?", a: "A stateful AI content tool remembers everything across sessions: brand voice rules, founder facts, competitive positioning, what content converted, what failed. In Forge's Context Agent Architecture this is implemented through Brain Memory — the 8th agent that writes patterns back after every cycle. Most AI tools are stateless: each session is a fresh prompt with no history. Stateful systems compound. Stateless ones repeat themselves." },
  { q: "What is brand brain memory in an AI content system?", a: "Brand brain memory is the persistent intelligence layer that stores everything an AI content system has ever learned: voice rules, founder facts, positioning claims, performance patterns, competitive context. In Forge's Context Agent Architecture this layer is named Brain Memory — the 8th and final agent that writes patterns back after every cycle. Without it, the system restarts from zero each session. The brain is the moat — not the model." },
  { q: "What is a citation heat map?", a: "A citation heat map is a per-section, per-FAQ view of where AI engines actually pull from in your content corpus. It distinguishes prose authority — when engines cite specific paragraphs — from domain authority, when they cite the URL without quoting. It also surfaces FAQ ROI: which questions actually get picked up as AI answers and which ones engines ignore." },
  // What it isn't — reframe the incumbents
  { q: "Why do AI content tools get worse the longer you use them?", a: "Most don't get worse — they stay exactly the same. Every AI content tool is stateless. Each session starts from zero, with no memory of what worked, what failed, or what your competitive position looked like last quarter. Output gets repetitive because there's no compounding learning. Forge inverts that entirely with Brain Memory — the 8th agent in its Context Agent Architecture — writing performance patterns back into the brand profile after every cycle." },
  { q: "Why does AI content sound generic even when the brief is good?", a: "Briefs describe topics. They don't capture the competitive worldview required to write content that differentiates. A brief tells the model what to write about. It doesn't tell the model what your competitors are weak on, where you have right-to-win, or which angles only you can defend. Without that context, even the best models produce content that any competitor could have written." },
  { q: "Why isn't faster content faster ROI?", a: "Content velocity only compounds when each piece adds intelligence to the next. Volume without intelligence produces faster mediocrity, not faster results. Ten articles that don't differentiate your positioning cost more than two that do — they consume editorial bandwidth, fragment topical authority, and train your audience to ignore you. Speed is a feature only after intelligence is solved." },
  { q: "What's the difference between AI content tools and AI content infrastructure?", a: "A tool executes prompts. Infrastructure compounds intelligence across cycles. Tools are bought to solve a specific task: write a blog post, summarize a transcript, draft a social caption. Infrastructure is bought to build a long-term capability: persistent brand memory, competitive intelligence, performance feedback, and topical authority that grows every quarter. Different purchase decision. Different outcomes. Different commercial relationship." },
  { q: "What's the limit of agentic AI in content marketing?", a: "Agents fail without state. Most agentic AI in content marketing chains together prompts but loses everything between sessions — every agent restarts the conversation. That's not autonomy, that's amnesia. Real agentic content systems require persistent memory across sequenced agents — the pattern Forge calls Context Agent Architecture. Without that scaffolding, agents produce coordinated mediocrity faster than humans can review it." },
  { q: "What's the difference between content marketing and content intelligence operations?", a: "Content marketing executes the plan. Content intelligence operations decides the plan. Marketing teams produce calendars, ship articles, and measure traffic. Intelligence operations runs upstream: scoping competitive gaps, identifying audience blind spots, mapping topical authority whitespace, deciding what content to ship and what to skip. Most companies have content marketing. Almost none have content intelligence. That gap is where the moat sits." },
  { q: "Why does most AI-generated B2B content get ignored by AI engines?", a: "AI engines cite content with distinctive concepts, named frameworks, and original definitions — content the engine can attribute back to a specific source. Most AI-generated B2B content has none of that. It paraphrases the same topics every competitor covers, with no original framework worth quoting. The fix isn't better prompts. It's a competitive worldview before generation, so the output contains things only your brand could have said." },
  // How it works — method/decision frame
  { q: "Why is the brief more important than the model in B2B content?", a: "Models converge. Briefs differentiate. Claude, GPT-4, and Gemini all produce competent prose from a strong brief. None of them can compensate for a brief that lacks competitive context, audience specificity, or strategic angle. The intelligence is upstream of generation. A weak brief with the best model in the world still produces forgettable content. A strong brief makes any modern model look brilliant." },
  { q: "How do you measure ROI of AI content beyond cost-per-article?", a: "Cost-per-article is the wrong unit. The right metrics: AI citation rate (how often engines cite your content), cited section breakdown (which sections get pulled), pipeline contribution per article, and competitive gap closure. A $200 article that gets cited weekly by ChatGPT for a high-intent query is worth more than 50 articles that fade into the volume noise. Measure outcomes, not output." },
  { q: "When should you NOT use AI content generation?", a: "When you don't have a competitive worldview to write from. AI content generation amplifies whatever you feed it — including the absence of strategy. Without competitive intelligence, audience clarity, and a defensible positioning angle, generated content sounds exactly like every competitor's generated content. The right move is to invest in intelligence first. Faster mediocrity isn't a win." },
  { q: "Why don't AI content tools learn from the content that converted?", a: "Most don't have a feedback loop. They generate content, hand it off, and forget. Performance data lives in analytics tools that the content system never reads. So the same patterns that failed get tried again. The same titles that flopped get rewritten. Forge closes that loop: engagement and citation data write back into the brain, conditioning every future generation." },
  { q: "How should mid-market B2B teams structure briefs for AI content generation?", a: "The order matters. Competitive intelligence first — what gaps exist, where you have right-to-win. Topical territory second — what conversations you can claim that competitors can't. Voice rules third — how your brand sounds, what it never says. Topic and angle last. Most teams flip this: they start with the topic and bolt on context. The result is generic content with brand paint." },
  // Decision-frame addition (May 6 evening). Surfaced from v10 brain rescan as top whitespace gap.
  { q: "How do you assess if your B2B content team is AI-ready?", a: "AI readiness for content teams isn't about whether the tools work — it's about whether your team has the upstream conditions to make AI output meaningful. Forge's five-dimension framework: brand intelligence depth, content brief discipline, performance feedback structure, voice rule clarity, and competitive worldview. Teams strong on all five get distinctive output from any AI model. Teams weak on any one dimension get generic content competitors could have written." }
];

// HTML body version — visible to crawlers in the SSR'd root div. Each Q&A is an h2/p pair so
// keyword-focused crawlers (not just FAQPage-aware ones) extract the content cleanly.
const FAQ_BODY_HTML = `
  <h1>Forge Intelligence FAQ</h1>
  <p>Twenty questions about AI content. Each answer leads with a definition and includes a named concept Forge has staked.</p>
${FAQ_PAIRS.map(p => `  <h2>${p.q.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h2>\n  <p>${p.a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('\n')}
`;

// FAQPage JSON-LD — machine-readable Q&A schema. AI engines parse this directly and use it
// as candidate answers for relevant queries. Critical for citation; bare HTML alone won't trigger
// the same FAQPage classification.
const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": FAQ_PAIRS.map(p => ({
    "@type": "Question",
    "name": p.q,
    "acceptedAnswer": { "@type": "Answer", "text": p.a }
  }))
};

export const MARKETING_META = {
  '/': {
    title: 'Forge Intelligence — Brand Intelligence That Compounds',
    // Meta description: 150 chars. Bing truncates at 160; Google at ~155. Keep strongest hook + specific claim.
    description: 'Forge extracts competitive intelligence from brand websites using an 8-stage AI pipeline. Intelligence compounds. The content proves it.',
    bodyContent: `
      <h1>Brand Intelligence That Compounds</h1>
      <p>Forge Intelligence extracts competitive intelligence from brand websites using an 8-stage AI pipeline. Every stage conditions the next. By the time content is generated, it's not writing from a prompt — it's writing from a fully constructed competitive worldview unique to your brand.</p>
      <h2>What Forge Does</h2>
      <p>Forge surfaces what the best brand strategists charge $50,000 and six weeks to find: competitive gaps, undefended market positions, audience blind spots, messaging fault lines. Then it turns that intelligence into content, closes the loop with performance data, and writes what it learns back into your brand brain automatically.</p>
      <h2>What Forge Is Not</h2>
      <p>Forge is not a content marketing agency. Forge does not automate marketing workflows. Forge is the intelligence layer your marketing operation never had.</p>
      <h2>The 8-Stage Context Agent Architecture</h2>
      <p>Context Hub scrapes your brand and maps the competitive landscape. GEO Strategist finds topical territory your competitors haven't claimed. Authenticity Enricher injects E-E-A-T signals that make content rank and resonate. Content Generator writes from a fully constructed brand worldview. Compliance Gate critiques before anything goes live. Publishing Queue schedules and distributes with UTM tracking. Performance Dashboard pulls real engagement data back into the system. Brain Memory writes every pattern back automatically.</p>
      <h2>Who Forge Is For</h2>
      <p>Mid-market B2B companies building content operations that can compete with teams ten times their size. Bootstrapped. Portland, Oregon. Founded 2025 by Brian Morgan after a decade running Sandbox Group.</p>
    `
  },
  '/product': {
    title: 'The Forge Product — Context Agent Architecture',
    // 155-char ceiling — dropped the agent name list (it's in the page body already).
    description: 'Eight specialized AI agents. One compounding intelligence system. Each stage conditions the next — from brand scrape to published content that cites.',
    bodyContent: `
      <h1>The Forge Product</h1>
      <p>Eight specialized agents. One compounding system. Each stage doesn't just execute — it conditions the next.</p>
      <h2>Context Hub</h2>
      <p>Scrapes your brand and maps the competitive landscape. Identifies competitive gaps, personas, voice attributes, and whitespace your competitors haven't claimed.</p>
      <h2>GEO Strategist</h2>
      <p>Finds the topical territory your competitors haven't claimed. Builds a topical authority map and GEO opportunity set specific to your positioning.</p>
      <h2>Authenticity Enricher</h2>
      <p>Injects E-E-A-T signals — expertise, experience, authoritativeness, trustworthiness — that make content both rank and resonate.</p>
      <h2>Content Generator</h2>
      <p>Writes from a fully constructed brand worldview, not a prompt. Uses Factual Ground — founder-provided facts and credentials — as verbatim source material.</p>
      <h2>Compliance Gate</h2>
      <p>Critiques every article before publishing. Flags factual confidence issues, voice drift, and brand violations section-by-section.</p>
      <h2>Publishing Queue</h2>
      <p>Schedules and distributes across LinkedIn, X, HubSpot, Facebook, and your own site with UTM tracking baked in.</p>
      <h2>Performance Dashboard</h2>
      <p>Pulls real engagement data back into the system — tracks what landed, what decayed, what drove action.</p>
      <h2>Brain Memory</h2>
      <p>Closes the loop. Every pattern that worked, every mistake flagged, every competitive insight surfaced — written back into the brain automatically, informing every agent on the next cycle.</p>
    `
  },
  '/faq': {
    title: 'Frequently Asked Questions — AI Content Intelligence | Forge Intelligence',
    // 155-char ceiling. Lead with the category-defining hook.
    description: 'AI content generation produces output. AI content intelligence builds the worldview that makes the output worth producing. Twenty answers from Forge.',
    bodyContent: FAQ_BODY_HTML
  }
};

// Shared JSON-LD blocks — Organization + WebSite go on every marketing page for Knowledge Panel eligibility
// and site-wide entity grounding. The SearchAction on WebSite is what enables Google's sitelinks search box.
const ORG_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Forge Intelligence",
  "url": "https://forgeintelligence.ai",
  "logo": "https://forgeintelligence.ai/forge-logo-white.png",
  "description": "Forge Intelligence extracts competitive intelligence from brand websites using an 8-stage AI pipeline. Intelligence compounds. The content proves it.",
  "foundingDate": "2025",
  "founder": { "@type": "Person", "name": "Brian Morgan" },
  "address": { "@type": "PostalAddress", "addressLocality": "Portland", "addressRegion": "OR", "addressCountry": "US" },
  "knowsAbout": ["B2B content marketing", "Generative Engine Optimization", "brand intelligence", "AI content generation", "competitive intelligence", "E-E-A-T optimization"]
};
const WEBSITE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Forge Intelligence",
  "url": "https://forgeintelligence.ai",
  "publisher": { "@type": "Organization", "name": "Forge Intelligence" },
  "potentialAction": {
    "@type": "SearchAction",
    "target": { "@type": "EntryPoint", "urlTemplate": "https://forgeintelligence.ai/?q={search_term_string}" },
    "query-input": "required name=search_term_string"
  }
};
// Branded OG card — 2500x1313 (aspect ratio 1.904:1, same as 1200x630). Social platforms scale as needed.
const DEFAULT_OG_IMAGE = 'https://forgeintelligence.ai/og-card.png';

export function renderMarketingPage(meta, html, pathOverride = '/') {
  const escapedDesc = meta.description.replace(/"/g, '&quot;');
  const escapedTitle = meta.title.replace(/"/g, '&quot;');
  const canonicalUrl = `https://forgeintelligence.ai${pathOverride}`;
  const ogImage = meta.ogImage || DEFAULT_OG_IMAGE;
  const headTags = `
  <title>${escapedTitle}</title>
  <meta name="description" content="${escapedDesc}" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Forge Intelligence" />
  <meta property="og:title" content="${escapedTitle}" />
  <meta property="og:description" content="${escapedDesc}" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="2500" />
  <meta property="og:image:height" content="1313" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapedTitle}" />
  <meta name="twitter:description" content="${escapedDesc}" />
  <meta name="twitter:image" content="${ogImage}" />
  <script type="application/ld+json">${JSON.stringify(ORG_JSON_LD)}</script>
  <script type="application/ld+json">${JSON.stringify(WEBSITE_JSON_LD)}</script>${pathOverride === '/faq' ? `
  <script type="application/ld+json">${JSON.stringify(FAQ_JSON_LD)}</script>` : ''}`;
  // Inject head tags AND body content. Content sits inside #root so React hydrates over it on the client.
  const withMeta = html.replace(/<title>[^<]*<\/title>/, '').replace('<head>', '<head>' + headTags);
  const withBody = withMeta.replace('<div id="root"></div>', `<div id="root"><div style="position:absolute;left:-99999px;top:-99999px" aria-hidden="true">${meta.bodyContent}</div></div>`);
  return withBody;
}
