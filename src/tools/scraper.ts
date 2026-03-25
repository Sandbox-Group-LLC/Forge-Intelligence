import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

/**
 * Scrapes a domain using Anthropic's built-in web search tool
 * Returns raw text signals: copy patterns, tone, vocabulary, structure
 */
export async function scrapeDomain(url: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `Visit ${url} and extract:
1. Exact vocabulary and phrases used (not paraphrased)
2. Tone signals: formal/casual, confident/hedged, simple/complex
3. Value propositions and pain points addressed
4. Content types and structure patterns
5. Any customer-facing social proof or testimonials

Return raw extracted signals only. No editorializing.`
    }]
  });

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return textBlocks;
}

/**
 * Scrapes review platforms for third-party voice signals
 */
export async function scrapeReviews(brandName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `Search for customer reviews of "${brandName}" on G2, Glassdoor, Reddit, and Trustpilot.
Extract:
1. Exact phrases customers use to describe value (verbatim quotes preferred)
2. Recurring complaints or friction points
3. Competitor comparisons mentioned
4. Emotional triggers (what made them switch / what keeps them loyal)

Return raw signals only. No editorializing.`
    }]
  });

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return textBlocks;
}

/**
 * Scrapes competitor sites for topical coverage gaps
 */
export async function scrapeCompetitors(urls: string[]): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `Analyze these competitor sites: ${urls.join(', ')}
For each, identify:
1. The 3 core content topics they own
2. Their primary value proposition language
3. What they do NOT cover or address

Return structured competitor signals only.`
    }]
  });

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return textBlocks;
}
