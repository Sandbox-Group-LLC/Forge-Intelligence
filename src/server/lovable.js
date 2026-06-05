// Lovable integration — Brand Intelligence Profile → deterministic, URL-encoded
// prompt for Lovable's public Build-with-URL flow. No LLM calls, no DB, no
// network: pure templating. Extracted verbatim from server.js during the
// decomposition. Spec: docs/LOVABLE_INTEGRATION.md (FI-LOVABLE-001).
//
// Exports are the symbols the /api/forge/prompt-pack/lovable route handler
// references. lovableTruncate / lovableSection / lovableProductTypeLabel stay
// module-private (only called by the builders/formatters in here).

export const LOVABLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LOVABLE_URL_SAFE_LIMIT = 12000;
export const LOVABLE_MAX_PROMPT_CHARS = 50000;
export const LOVABLE_SUPPORTED_APP_TYPES = new Set([
  'content-command-center',
  'geo-monitor',
  'campaign-planner',
  'brand-voice-studio',
]);

function lovableTruncate(value, maxLength) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 16)).trim() + '... [truncated]';
}

export function lovableSafeJoin(arr, maxLength) {
  if (!Array.isArray(arr)) return '';
  return lovableTruncate(arr.map(v => (v == null ? '' : String(v))).filter(Boolean).join(', '), maxLength);
}

export function lovableHasData(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

export function lovableFormatVoice(voice, compact) {
  if (!lovableHasData(voice)) return null;
  const tones = Array.isArray(voice.toneAttributes) ? voice.toneAttributes : [];
  const scoreFor = (label) => {
    const hit = tones.find(t => String(t.attribute || '').toLowerCase() === label);
    return hit && typeof hit.score === 'number' ? hit.score : null;
  };
  const formality = scoreFor('formality');
  const confidence = scoreFor('confidence');
  const complexity = scoreFor('complexity');
  const phrases = Array.isArray(voice.keyPhrases) ? voice.keyPhrases : [];
  const summary = typeof voice.summary === 'string' ? voice.summary : '';
  const style = typeof voice.writingStyle === 'string' ? voice.writingStyle : '';
  const phraseCap = compact ? 240 : 1200;
  const summaryCap = compact ? 600 : 4000;
  const styleCap = compact ? 400 : 2000;
  return {
    formality: formality != null ? `${formality}/10` : 'not measured',
    confidence: confidence != null ? `${confidence}/10` : 'not measured',
    complexity: complexity != null ? `${complexity}/10` : 'not measured',
    brandVocab: phrases.length ? lovableSafeJoin(phrases, phraseCap) : 'none recorded',
    antiPatterns: 'generic corporate copy, hype language, AI-generated cliches',
    toneSummary: summary ? lovableTruncate(summary, summaryCap) : (style ? lovableTruncate(style, styleCap) : 'voice profile present but no summary recorded'),
  };
}

export function lovableFormatPersonas(personas, compact) {
  if (!Array.isArray(personas) || personas.length === 0) return null;
  const max = compact ? 3 : personas.length;
  const perPersonaCap = compact ? 500 : 2000;
  const blocks = personas.slice(0, max).map((p, i) => {
    const name = p.name || p.role || `Persona ${i + 1}`;
    const role = p.role || '';
    const pains = lovableSafeJoin(p.painPoints || [], 240);
    const triggers = lovableSafeJoin(p.triggers || [], 240);
    const skepticism = lovableTruncate(p.skepticism || '', 200);
    const block = [
      `- ${name}${role && role !== name ? ` (${role})` : ''}`,
      pains ? `  Pain points: ${pains}` : '',
      triggers ? `  Triggers: ${triggers}` : '',
      skepticism ? `  Skepticism: ${skepticism}` : '',
    ].filter(Boolean).join('\n');
    return lovableTruncate(block, perPersonaCap);
  });
  return blocks.join('\n');
}

export function lovableFormatWhitespace(gaps, compact) {
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  const cap = compact ? 1500 : 6000;
  const lines = gaps.slice(0, compact ? 6 : gaps.length).map(g => {
    const topic = g.topic || 'Untitled gap';
    const opp = g.whitespaceOpportunity || g.opportunity || '';
    const owned = g.ownedBy ? ` (currently owned by ${g.ownedBy})` : ' (unclaimed)';
    return `- ${topic}${owned}${opp ? ` — ${opp}` : ''}`;
  });
  return lovableTruncate(lines.join('\n'), cap);
}

export function lovableFormatThirdParty(signals, compact) {
  if (!Array.isArray(signals) || signals.length === 0) return null;
  const cap = compact ? 1200 : 5000;
  const lines = signals.slice(0, compact ? 8 : signals.length).map(s => {
    const src = s.source || 'unknown source';
    const type = s.signalType || s.type || 'signal';
    const val = s.value != null ? String(s.value) : '';
    return `- [${src}] ${type}${val ? `: ${val}` : ''}`;
  });
  return lovableTruncate(lines.join('\n'), cap);
}

export function lovableFormatGeo(geoBrief, compact) {
  if (!lovableHasData(geoBrief)) return null;
  const opps = Array.isArray(geoBrief.geoOpportunitiesNorm)
    ? geoBrief.geoOpportunitiesNorm
    : (Array.isArray(geoBrief.geoOpportunities) ? geoBrief.geoOpportunities : []);
  if (!opps.length) return null;
  const cap = compact ? 1200 : 5000;
  const lines = opps.slice(0, compact ? 6 : opps.length).map(o => {
    const topic = o.topic || o.query || 'Untitled opportunity';
    const cp = typeof o.citationProbability === 'number' ? ` (citation probability ${Math.round(o.citationProbability * 100)}%)` : '';
    return `- ${topic}${cp}`;
  });
  return lovableTruncate(lines.join('\n'), cap);
}

function lovableSection(label, content, fallback) {
  if (content && String(content).trim().length > 0) return content;
  return fallback || `No ${label.toLowerCase()} data available yet. Design this section to be populated later.`;
}

export function lovableBuildContentCommandCenter(ctx) {
  const {
    brandName, appTypeDescription, voice, personas, whitespace, thirdParty, geo,
    unclaimed, brandColors, customNotes, brandProfileId,
  } = ctx;
  const voiceBlock = voice
    ? `- Formality: ${voice.formality}\n- Confidence: ${voice.confidence}\n- Complexity: ${voice.complexity}\n- Brand vocabulary: ${voice.brandVocab}\n- Anti-patterns to avoid: ${voice.antiPatterns}\n- Tone summary: ${voice.toneSummary}`
    : lovableSection('voice profile', null);

  const personasBlock = lovableSection('personas', personas);
  const whitespaceBlock = lovableSection('competitive whitespace', whitespace);
  const thirdPartyBlock = lovableSection('third-party voice', thirdParty);
  const geoBlock = lovableSection('GEO opportunities', geo);

  const notesBlock = customNotes && String(customNotes).trim().length > 0
    ? `\n## ADDITIONAL OPERATOR NOTES\n${lovableTruncate(customNotes, 1500)}\n`
    : '';

  return `You are building a production Brand Intelligence Command Center for ${brandName}.

## APP CONCEPT
A ${appTypeDescription} that helps ${brandName}'s marketing team turn brand intelligence into shipped content. The app must feel like a strategic GTM operating system, not a generic AI content generator.

## BRAND VOICE (apply to ALL UI copy and generated content)
${voiceBlock}

## TARGET PERSONAS
${personasBlock}
(Each persona: role, pain points, trigger events, skepticism objections)

## COMPETITIVE WHITESPACE
${whitespaceBlock}
Unclaimed positioning territory: ${unclaimed || 'derive from whitespace block above'}

## THIRD-PARTY VOICE THEMES
Top customer language patterns from reviews, complaints, testimonials:
${thirdPartyBlock}

## AI SEARCH / GEO OPPORTUNITIES
Top citation opportunities to optimize for:
${geoBlock}

## REQUIRED SCREENS
1. Dashboard — brand health, content velocity, AI citation score
2. Brand Brain — voice profile, personas, whitespace (read-only)
3. Content Generator — articles/social/email with confidence scores
4. Campaign Planner — 8-article campaign with rotating angles
5. AI Citation Monitor — track GEO opportunities and citation status
6. Approval Queue — review with E-E-A-T flags before publish

## DATA MODEL (use Supabase — Lovable native)
- brand_context (singleton, holds profile passed in this prompt)
- generated_content (id, type, body, confidence_scores, status, created_at)
- campaigns (id, topic_cluster, article_count, status)
- citation_opportunities (id, prompt, current_status, target_status)

## CORE WORKFLOW
1. User opens dashboard.
2. User reviews the Brand Brain.
3. User selects a topic cluster or content opportunity.
4. App generates a campaign plan.
5. User reviews generated content with confidence scores, source needs, and E-E-A-T flags.
6. User approves or edits outputs.
7. Approved content moves into publishing queue.

## INTEGRATIONS
- Supabase for persistence (Lovable native)
- Resend for content preview emails
- Stripe (optional, for app monetization)

## VISUAL DIRECTION
- Match brand colors: ${brandColors}
- Typography: clean sans-serif, generous spacing
- UI copy tone: matches brand voice profile above
- Avoid generic AI-app aesthetics (no purple gradients, no robot icons)

## SUCCESS CRITERIA
A marketer at ${brandName} should say "this knows our brand better than our agency does" within 2 minutes of opening the app.
${notesBlock}
## TECHNICAL NOTES
Forge Intelligence API base: https://api.forgeintelligence.ai/v1
Brand Profile ID: ${brandProfileId}
(Optional: prompt user for FORGE_API_KEY env var to enable live content generation. If not provided, scaffold with static brand data from this prompt.)`;
}

// Directive-led prompt — used when the brand profile carries a buildIntent
// (Quick Start brains). Lovable reads what to build FIRST, then the brand
// intelligence acts as design + voice guardrails for that specific build —
// rather than the legacy structure where we prescribed a Content Command
// Center concept and force-fit every brand into it.
function lovableProductTypeLabel(productType) {
  switch (productType) {
    case 'marketing-site': return 'a marketing site';
    case 'saas-app': return 'a SaaS app';
    case 'landing-page': return 'a landing page';
    case 'waitlist': return 'a waitlist';
    case 'internal-tool': return 'an internal tool';
    default: return 'a product';
  }
}

export function lovableBuildWithDirective(ctx, buildIntent) {
  const {
    brandName, voice, personas, whitespace, thirdParty,
    brandColors, customNotes, brandProfileId, factualGround,
  } = ctx;

  const directiveDescription = lovableTruncate(buildIntent.description || '', 4000);
  const productType = buildIntent.productType && buildIntent.productType !== 'not-sure'
    ? buildIntent.productType
    : null;
  const productLabel = lovableProductTypeLabel(productType);

  const voiceBlock = voice
    ? `- Formality: ${voice.formality}\n- Confidence: ${voice.confidence}\n- Complexity: ${voice.complexity}\n- Brand vocabulary: ${voice.brandVocab}\n- Anti-patterns to avoid: ${voice.antiPatterns}\n- Tone summary: ${voice.toneSummary}`
    : lovableSection('voice profile', null);

  const personasBlock = lovableSection('personas', personas);
  const whitespaceBlock = lovableSection('competitive whitespace', whitespace);
  const thirdPartyBlock = lovableSection('third-party voice', thirdParty);

  // Founder-Brief fields (only present on Quick Start brains) — pass through
  // verbatim so Lovable can echo the founder's own words rather than the
  // Stage-1 synthesized paraphrase. The factualGround block lives inside the
  // brand profile JSONB; missing on URL-based brains, gracefully skipped.
  const fg = factualGround || {};
  const fgWhatWeDo = typeof fg.whatWeDo === 'string' && fg.whatWeDo.trim() ? lovableTruncate(fg.whatWeDo, 1500) : '';
  const fgWhatWeDoNot = typeof fg.whatWeDoNot === 'string' && fg.whatWeDoNot.trim() ? lovableTruncate(fg.whatWeDoNot, 1500) : '';
  const fgCompetitors = typeof fg.competitors === 'string' && fg.competitors.trim() ? lovableTruncate(fg.competitors, 1000) : '';
  const fgFoundingStory = typeof fg.foundingStory === 'string' && fg.foundingStory.trim() ? lovableTruncate(fg.foundingStory, 1500) : '';
  const fgQuotablePositions = typeof fg.quotablePositions === 'string' && fg.quotablePositions.trim() ? lovableTruncate(fg.quotablePositions, 1200) : '';
  const fgNamedAuthors = typeof fg.namedAuthors === 'string' && fg.namedAuthors.trim() ? lovableTruncate(fg.namedAuthors, 600) : '';

  const notesBlock = customNotes && String(customNotes).trim().length > 0
    ? `\n## ADDITIONAL OPERATOR NOTES\n${lovableTruncate(customNotes, 1500)}\n`
    : '';

  // Build the brand-intelligence section line by line so we only emit fields
  // that actually have content (URL-based brains skip the founder-brief lines,
  // Quick Start brains keep them).
  const biLines = [`Brand: ${brandName}`];
  if (fgWhatWeDo) biLines.push(`What this product does: ${fgWhatWeDo}`);
  if (fgWhatWeDoNot) biLines.push(`What it does NOT do (strategic moats — do not contradict): ${fgWhatWeDoNot}`);
  biLines.push(`Voice profile:\n${voiceBlock}`);
  biLines.push(`Target personas:\n${personasBlock}`);
  if (lovableHasData(whitespace)) biLines.push(`Competitive whitespace:\n${whitespaceBlock}`);
  if (fgCompetitors) biLines.push(`Competitors: ${fgCompetitors}`);
  if (fgFoundingStory) biLines.push(`Founding story: ${fgFoundingStory}`);
  if (fgQuotablePositions) biLines.push(`Brand positions: ${fgQuotablePositions}`);
  if (fgNamedAuthors) biLines.push(`Attributed authors: ${fgNamedAuthors}`);
  if (lovableHasData(thirdParty)) biLines.push(`Third-party voice themes:\n${thirdPartyBlock}`);
  const brandIntelligence = biLines.join('\n\n');

  return `You are building ${productLabel} for ${brandName}.

## BUILD DIRECTIVE
${directiveDescription}${productType ? `\nProduct type: ${productType}` : ''}

## BRAND INTELLIGENCE — provided by Forge Intelligence
The brand intelligence below is DESIGN + VOICE guardrails for the build directive above. It tells you HOW the brand behaves, not WHAT to build. Apply the voice to all UI copy. Honor the personas in the navigation, onboarding, and core flows. Respect what the brand explicitly does NOT do — those are strategic moats and must not appear as product features.

${brandIntelligence}

## VISUAL DIRECTION
- Match brand colors: ${brandColors}
- Typography: clean sans-serif, generous spacing
- UI copy tone: matches brand voice profile above
- Avoid generic AI-app aesthetics (no purple gradients, no robot icons)
${notesBlock}
## TECHNICAL NOTES
Forge Intelligence Brand Profile ID: ${brandProfileId}
Forge Intelligence API base: https://api.forgeintelligence.ai/v1
(Optional: prompt user for FORGE_API_KEY env var if the build needs live brand-aware content generation. Otherwise scaffold with the static brand data from this prompt.)`;
}

export function lovableStubPrompt(appType, brandName, brandProfileId) {
  return `[Lovable prompt template TODO]
appType "${appType}" is recognized but not yet shipped in v1. Only "content-command-center" is fully built. Tracked as a post-ship follow-up in docs/LOVABLE_INTEGRATION.md §11.

Brand: ${brandName}
Brand Profile ID: ${brandProfileId}`;
}

export function lovableRecommendedAppName(appType, brandName) {
  const friendly = brandName && brandName !== 'this brand' ? brandName : 'Your Brand';
  switch (appType) {
    case 'content-command-center': return `${friendly} Content Intelligence Command Center`;
    case 'geo-monitor':              return `${friendly} GEO Citation Monitor`;
    case 'campaign-planner':         return `${friendly} Campaign Planner`;
    case 'brand-voice-studio':       return `${friendly} Brand Voice Studio`;
    default:                          return `${friendly} Lovable App`;
  }
}

export function lovableAppTypeDescription(appType) {
  switch (appType) {
    case 'content-command-center': return 'Brand Intelligence Command Center';
    case 'geo-monitor':            return 'GEO Citation Monitor';
    case 'campaign-planner':       return 'Campaign Planner';
    case 'brand-voice-studio':     return 'Brand Voice Studio';
    default:                        return 'brand-aware marketing application';
  }
}
