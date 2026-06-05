// Image generation helpers, extracted from server.js during the decomposition.
// Two pairs: a prompt builder (brand-voice-aware, via Claude Haiku) and a
// fal.ai Ideogram v2 generator, for hero (16:9) and social (1:1) images.
//   - buildImagePrompt / generateHeroImage   — article hero, 16:9
//   - buildSocialImagePrompt / generateSocialImage — social post, 1:1
// Deps: the shared `anthropic` client (llm.js) + fetch/process.env (FAL_API_KEY).
// HERO_IMAGE_NEGATIVE_PROMPT is shared by both generators and stays private.
import { anthropic } from './llm.js';

const HERO_IMAGE_NEGATIVE_PROMPT = "airbrushed skin, smooth skin, plastic skin, waxy skin, overproduced, HDR, oversaturated, hyperreal, AI art, digital painting, 3D render, cartoon, illustration, distorted hands, extra fingers, malformed fingers, mutated anatomy, stock photo, generic corporate stock image, blurry faces in background blobbing together, text artifacts";

export async function generateHeroImage(prompt) {
  const falRes = await fetch('https://fal.run/fal-ai/ideogram/v2', {
    method: 'POST',
    headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspect_ratio: '16:9',
      style: 'realistic',
      // expand_prompt OFF: our prompt is already a carefully brand-voice-tuned
      // sentence (buildImagePrompt, with explicit anti-AI-stock + don't-take-
      // brand-name-literally constraints). Ideogram's MagicPrompt rewrites the
      // prompt and can re-inject the generic/stock aesthetic we deliberately
      // excluded, so we hand it our prompt verbatim.
      expand_prompt: false,
      negative_prompt: HERO_IMAGE_NEGATIVE_PROMPT,
      num_images: 1
    }),
    // Cap a hung fal.ai call. Image gen runs ~10-20s; 60s is generous headroom
    // while still preventing an indefinite block on the generate/publish path.
    signal: AbortSignal.timeout(60000)
  });
  if (!falRes.ok) throw new Error(`fal.ai ${falRes.status}: ${await falRes.text()}`);
  const falData = await falRes.json();
  const imageUrl = falData?.images?.[0]?.url;
  if (!imageUrl) throw new Error('No image URL returned from fal.ai');
  return imageUrl;
}

// ── Shared: Build brand-voice-aware image prompt ─────────────────────────────
export async function buildImagePrompt(title, voiceProfile = {}, firstBody = '') {
  const brandName = voiceProfile.brand_name || '';
  // tone: handle both snake_case (legacy) and camelCase (Context Agent output)
  const toneAttrStr = Array.isArray(voiceProfile.toneAttributes)
    ? voiceProfile.toneAttributes.map(a => a.attribute).join(', ')
    : '';
  const toneSummary = voiceProfile.tone_summary || voiceProfile.summary || voiceProfile.writingStyle || toneAttrStr || '';
  const industry = voiceProfile.industry || voiceProfile.target_industry || voiceProfile.marketCategory || '';
  const positioning = voiceProfile.positioning || voiceProfile.brand_positioning || '';
  const targetPersona = voiceProfile.targetPersona || voiceProfile.target_persona || voiceProfile.primary_persona || '';
  const visualStyle = voiceProfile.visualStyle || voiceProfile.visual_style || voiceProfile.brand_aesthetic || '';
  const accentColor = voiceProfile.accentColor || voiceProfile.accent_color || voiceProfile.brand_color || '';

  const brandContext = [
    brandName && `Brand: ${brandName}`,
    industry && `Industry: ${industry}`,
    toneSummary && `Tone: ${toneSummary}`,
    positioning && `Positioning: ${positioning}`,
    targetPersona && `Audience: ${targetPersona}`,
    visualStyle && `Visual style: ${visualStyle}`,
    accentColor && `Brand accent color: ${accentColor}`,
  ].filter(Boolean).join('\n');

  const bodySnippet = (firstBody || '').slice(0, 250);

  const hasBrandVisual = !!(visualStyle || accentColor);

  const imagePromptInstruction = hasBrandVisual
    ? `Write a single-sentence image generation prompt for an article hero image that reflects this brand's visual identity and the article topic.

Article title: "${title}"
${brandContext ? brandContext + '\n' : ''}${bodySnippet ? 'Article context: ' + bodySnippet : ''}

Rules:
- One sentence. Describe the concrete scene — what's happening, who is in it (if anyone), where, what the mood is.
- Editorial/documentary photography feel: natural available light, real moment, candid — not posed. If humans are present, describe what they are doing, not how they look.
- Let the brand's visual style, tone, and color palette shape the aesthetic.
- Avoid words that signal AI-generated stock imagery: "photorealistic", "professional", "polished", "corporate", "stock", "perfect", "high-quality". Use concrete sensory details instead.
- No illustrations, 3D renders, cartoons, or surrealism.
- NEVER interpret the brand name literally (e.g. 'Forge' is software, not a blacksmith).
- Output only the prompt. No quotes, no preamble, no explanation.`
    : `Write a single-sentence image generation prompt for an article hero image.

Article title: "${title}"
${bodySnippet ? 'Article context: ' + bodySnippet : ''}

Rules:
- One sentence. Describe the concrete scene — what's happening, who is in it (if anyone), where, what the mood is.
- Editorial/documentary photography feel: natural available light, real moment, candid — not posed. If humans are present, describe what they are doing, not how they look.
- Avoid words that signal AI-generated stock imagery: "photorealistic", "professional", "polished", "corporate", "stock", "perfect", "high-quality". Use concrete sensory details instead.
- No illustrations, 3D renders, cartoons, or surrealism.
- Output only the prompt. No quotes, no preamble, no explanation.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: imagePromptInstruction }]
  });

  return res.content[0]?.type === 'text'
    ? res.content[0].text.trim()
    : `A candid documentary moment capturing the world of ${title}, natural available light, shallow depth of field`;
}

export async function buildSocialImagePrompt(post, voiceProfile = {}, brandName = '') {
  const visualStyle = voiceProfile.visualStyle || voiceProfile.visual_style || voiceProfile.brand_aesthetic || '';
  const accentColor = voiceProfile.accentColor || voiceProfile.accent_color || voiceProfile.brand_color || '';
  const tone = voiceProfile.summary || voiceProfile.writingStyle || '';

  const hint = post?.imagePromptHint || post?.hook || post?.body?.slice(0, 200) || '';
  const angle = post?.angle || 'general';

  const brandContext = [
    brandName && `Brand: ${brandName}`,
    visualStyle && `Visual style: ${visualStyle}`,
    accentColor && `Brand accent: ${accentColor}`,
    tone && `Tone: ${tone}`,
  ].filter(Boolean).join('\n');

  const instruction = `Write a one-sentence Flux Schnell image prompt for a SQUARE (1:1) social media post. The image must work scrolling on phones — single focal subject, strong silhouette, type-friendly negative space, NOT a busy editorial scene.

Post concept: ${hint}
Post angle: ${angle}
${brandContext ? brandContext + '\n' : ''}
Rules:
- One sentence describing a clear, graphic, scroll-stopping visual.
- Single dominant subject. Strong composition. Centered or rule-of-thirds.
- 1:1 square aspect ratio in mind. Avoid wide cinematic compositions.
- Reflect the brand's accent color in the lighting or palette if specified.
- Concrete sensory details — no "professional", "polished", "corporate", "stock photo".
- No illustrations, 3D renders, cartoons. No text, no logos, no UI elements.
- NEVER interpret the brand name literally.
- Output only the prompt. No quotes, no preamble.`;

  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: instruction }]
    });
    return res.content[0]?.type === 'text'
      ? res.content[0].text.trim()
      : `A clean square composition with a single focal subject illuminated by natural light, related to ${hint}, scroll-stopping social composition`;
  } catch (e) {
    console.error('[SOCIAL-IMG-PROMPT]', e.message);
    return `A clean square composition with a single focal subject illuminated by natural light, related to ${hint}, scroll-stopping social composition`;
  }
}

// fal.ai Ideogram v2 wrapper for square social images. Mirrors generateHeroImage but with 1:1.
export async function generateSocialImage(prompt) {
  const falRes = await fetch('https://fal.run/fal-ai/ideogram/v2', {
    method: 'POST',
    headers: { 'Authorization': `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspect_ratio: '1:1',
      style: 'realistic',
      // expand_prompt OFF — see generateHeroImage. Our buildSocialImagePrompt
      // output is already tuned; MagicPrompt would rewrite it and can undo the
      // anti-stock / single-focal-subject constraints.
      expand_prompt: false,
      negative_prompt: HERO_IMAGE_NEGATIVE_PROMPT,
      num_images: 1
    }),
    signal: AbortSignal.timeout(60000) // cap a hung fal.ai call (see generateHeroImage)
  });
  if (!falRes.ok) throw new Error(`fal.ai social ${falRes.status}: ${await falRes.text()}`);
  const falData = await falRes.json();
  const imageUrl = falData?.images?.[0]?.url;
  if (!imageUrl) throw new Error('No image URL returned from fal.ai');
  return imageUrl;
}
