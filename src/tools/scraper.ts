import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

/**
 * Scrapes a domain using Claude's reasoning.
 * No tool-calling needed — Claude reasons directly from URL context.
 */
export async function scrapeDomain(url: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Analyze the brand at this URL: ${url}

Extract the following signals based on everything you know about this brand and its public web presence:

1. VOCABULARY: List 5-10 exact words or phrases this brand uses repeatedly in their copy
2. TONE SCORES: Rate Formality (1-10), Confidence (1-10), Complexity (1-10)
3. TONE SUMMARY: One punchy sentence describing how they actually write (not what they say about themselves)
4. VALUE PROPS: 3 core value propositions extracted from their messaging
5. PAIN POINTS: 3 customer pain points they address
6. CONTENT STRUCTURE: How do they organize their pages? (e.g., hero → problem → solution → social proof)

Return raw extracted signals only. No editorializing. Be specific and literal.`
    }]
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * Extracts third-party voice signals for a brand.
 * Claude reasons from training data on reviews, Reddit, G2 etc.
 */
export async function scrapeReviews(brandName: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Based on your knowledge of "${brandName}" and what customers say about them publicly (G2, Reddit, Glassdoor, Trustpilot, Twitter/X):

1. CUSTOMER POWER PHRASES: 3 exact phrases customers use to describe the value (verbatim customer language, not marketing copy)
2. FRICTION POINTS: 2 recurring complaints or unmet needs customers mention
3. SWITCH TRIGGERS: What made customers look for this solution in the first place?
4. LOYALTY SIGNALS: What keeps customers from leaving?

If you have limited data on this brand, state that clearly rather than guessing.
Return raw signals only.`
    }]
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * Analyzes competitor positioning and content gaps.
 */
export async function scrapeCompetitors(urls: string[]): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Analyze these competitor brands/URLs: ${urls.join(', ')}

For each competitor identify:
1. The 2-3 core content topics they dominate
2. Their primary positioning angle (what makes them unique in their messaging)
3. What they conspicuously DO NOT address or cover

Then identify:
4. WHITE SPACE: One high-value topic that none of them own that a new entrant could dominate

Return structured competitor signals only. Be specific.`
    }]
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}
