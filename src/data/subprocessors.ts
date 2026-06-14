// Single source of truth for Forge Intelligence's sub-processors.
//
// Consumed by: /subprocessors (public page), the Privacy Policy (Section 6),
// the DPA page (Annex), and the attorney-review Word export. Update HERE when a
// vendor is added or removed — never maintain a second copy in prose. (Adding
// Jina / Bright Data / OpenAI / Gemini / ValueSERP in #357 required hand-editing
// the privacy policy; this module exists so that never happens again.)
//
// `customerDirected: true` = the customer connects the service and data flows at
// THEIR instruction (publishing/CRM channels). These are onward recipients the
// customer chooses, legally distinct from sub-processors Forge engages to deliver
// the core service — the DPA separates them accordingly.

export interface SubProcessor {
  name: string;
  url: string;
  purpose: string;            // what it does + what data flows
  dataCategories: string;     // categories of personal/operational data sent
  region: string;             // hosting / processing region
  customerDirected?: boolean; // customer-connected integration vs. Forge sub-processor
}

export const SUBPROCESSORS_UPDATED = '2026-06-13';

// Forge-engaged sub-processors (deliver the core service).
export const subProcessors: SubProcessor[] = [
  { name: 'Clerk', url: 'clerk.com', purpose: 'Authentication, session management, and user identity.', dataCategories: 'Account email, user identifier', region: 'United States' },
  { name: 'Neon', url: 'neon.tech', purpose: 'Primary database (serverless Postgres) with Row Level Security; stores all brand workspace data.', dataCategories: 'All customer + brand workspace data', region: 'United States (us-west-2)' },
  { name: 'Render', url: 'render.com', purpose: 'Application hosting and deployment.', dataCategories: 'All data in transit through the application', region: 'United States' },
  { name: 'Anthropic', url: 'anthropic.com', purpose: 'LLM inference (Claude) for all AI-powered stages. API terms prohibit using inputs for model training.', dataCategories: 'Brand voice, personas, competitive analysis, brain data, article content', region: 'United States' },
  { name: 'Perplexity AI', url: 'perplexity.ai', purpose: 'Web-sourced market research, competitor analysis, source discovery, and AI-visibility probing (Sonar).', dataCategories: 'Brand/competitor URLs, market-context queries, brand-free buyer questions', region: 'United States' },
  { name: 'Jina Reader', url: 'jina.ai', purpose: 'Primary web-content extraction for brand and competitor site crawls.', dataCategories: 'Publicly available page URLs', region: 'Global' },
  { name: 'Bright Data', url: 'brightdata.com', purpose: 'Fallback web-content extraction (Web Unlocker / Scraping Browser) when a public page cannot be read directly.', dataCategories: 'Publicly available page URLs', region: 'Global' },
  { name: 'OpenAI', url: 'openai.com', purpose: 'AI-visibility probing only — measuring whether ChatGPT cites a brand. No brand content or personal data is sent.', dataCategories: 'Brand-free, category-level buyer questions', region: 'United States' },
  { name: 'Google (Gemini API)', url: 'ai.google.dev', purpose: 'AI-visibility probing only, via Gemini with Search grounding.', dataCategories: 'Brand-free buyer questions', region: 'United States / Global' },
  { name: 'ValueSERP / SerpAPI', url: 'valueserp.com', purpose: 'SERP data providers used to read Google AI Overviews for visibility measurement.', dataCategories: 'Buyer-question search queries', region: 'United States' },
  { name: 'fal.ai', url: 'fal.ai', purpose: 'Hero image generation via Flux models.', dataCategories: 'Image prompts derived from article content', region: 'United States' },
  { name: 'Resend', url: 'resend.com', purpose: 'Transactional email delivery (account notifications, review requests, digests).', dataCategories: 'Recipient email, message content', region: 'United States' },
  { name: 'PayPal', url: 'paypal.com', purpose: 'Payment processing. Forge does not receive or store card/bank details.', dataCategories: 'Payment confirmation only', region: 'Global' },
  { name: 'Pipedream Connect', url: 'pipedream.com', purpose: 'OAuth connection management for customer-connected channels; raw tokens are not stored in Forge’s database.', dataCategories: 'OAuth account identifiers', region: 'United States' },
  { name: 'Bitly', url: 'bitly.com', purpose: 'URL shortening for social post copy.', dataCategories: 'Article URLs and UTM parameters', region: 'United States' },
  { name: 'EasyCron', url: 'easycron.com', purpose: 'Scheduled job triggers (pattern extraction, decay monitoring, GEO refresh).', dataCategories: 'No personal data (trigger signals only)', region: 'Global' },
  { name: 'HubSpot', url: 'hubspot.com', purpose: 'CRM sync of the account holder on sign-in.', dataCategories: 'Account email and sign-in timestamp', region: 'United States' },
];

// Customer-directed integrations — connected by the customer; data flows at the
// customer's instruction. Onward recipients, not Forge sub-processors.
export const customerDirectedRecipients: SubProcessor[] = [
  { name: 'LinkedIn', url: 'linkedin.com', purpose: 'Publishing articles/posts and syncing engagement metrics to a connected account.', dataCategories: 'Published content; engagement metrics', region: 'Global', customerDirected: true },
  { name: 'X (Twitter)', url: 'x.com', purpose: 'Publishing posts and syncing engagement; OAuth 2.0 tokens stored encrypted and refreshed.', dataCategories: 'Published content; engagement metrics', region: 'Global', customerDirected: true },
  { name: 'Facebook', url: 'facebook.com', purpose: 'Publishing to connected Pages and syncing engagement.', dataCategories: 'Published content; engagement metrics', region: 'Global', customerDirected: true },
  { name: 'Reddit', url: 'reddit.com', purpose: 'Publishing articles to designated subreddits.', dataCategories: 'Published content', region: 'Global', customerDirected: true },
  { name: 'Medium', url: 'medium.com', purpose: 'Publishing articles to a connected Medium account.', dataCategories: 'Published content', region: 'Global', customerDirected: true },
  { name: 'Ghost / WordPress / Webflow', url: 'ghost.org', purpose: 'Publishing articles to a connected CMS; credentials managed via Pipedream Connect.', dataCategories: 'Published content', region: 'Global', customerDirected: true },
  { name: 'Google Search Console', url: 'search.google.com/search-console', purpose: 'SEO performance data, synced on demand with the customer’s authorization (read-only scope).', dataCategories: 'Search performance metrics', region: 'United States', customerDirected: true },
];
