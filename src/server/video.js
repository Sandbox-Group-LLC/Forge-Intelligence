// Video generation — Remotion Lambda render orchestration + storyboard agent +
// per-scene TTS. The render runs on AWS Lambda (NOT on this web dyno — a 60s
// render here would saturate a worker), invoked via renderMediaOnLambda against
// the deployed 'forge-reels' site (REMOTION_LAMBDA_SERVE_URL). The Remotion
// template source lives in remotion/ at the repo root; this module never bundles
// it — it just passes inputProps = { brand, scenes } to the deployed site.
//
// Flow: brief -> storyboardFromBrief (Claude) -> scenes[] -> synthesizeScenes
// (OpenAI TTS, uploaded to S3 as presigned URLs) -> renderReel (kick off) ->
// getReelProgress (poll). The route layer (routes/video.js) drives this async.
import { anthropic } from './llm.js';
import { safeParseLLM } from './llm-json.js';

// New AWS accounts cap Lambda concurrency at 10. Pinning a high frames-per-lambda
// keeps the chunk count under that cap so renders never hit "Rate Exceeded".
// Once the quota increase (requested: 5000) lands, this can drop for speed.
const FRAMES_PER_LAMBDA = 400;
const FPS = 30;

// Remotion's programmatic Lambda client + the AWS SDK (S3 upload/presign,
// renderMediaOnLambda) resolve credentials via the SDK default chain — i.e. the
// AWS_* env names, not the REMOTION_AWS_* ones the Remotion CLI reads. Render
// only carries REMOTION_AWS_*, so mirror them to AWS_* (without clobbering any
// real AWS_* already present) or every render dies with "Could not load
// credentials from any providers."
if (process.env.REMOTION_AWS_ACCESS_KEY_ID && !process.env.AWS_ACCESS_KEY_ID) {
  process.env.AWS_ACCESS_KEY_ID = process.env.REMOTION_AWS_ACCESS_KEY_ID;
  process.env.AWS_SECRET_ACCESS_KEY = process.env.REMOTION_AWS_SECRET_ACCESS_KEY;
  if (process.env.REMOTION_AWS_REGION && !process.env.AWS_REGION) {
    process.env.AWS_REGION = process.env.REMOTION_AWS_REGION;
  }
}

export function videoConfigured() {
  return !!(
    process.env.REMOTION_LAMBDA_FUNCTION_NAME &&
    process.env.REMOTION_LAMBDA_SERVE_URL &&
    process.env.REMOTION_AWS_REGION &&
    process.env.REMOTION_AWS_ACCESS_KEY_ID &&
    process.env.REMOTION_AWS_SECRET_ACCESS_KEY
  );
}

// ── Visual brand injector ──────────────────────────────────────────────────
// Build the reel's brand object from the Context Hub profile so it renders in
// the brand's REAL colors/logo, not Forge's. Source: profileData.brandVisual
// (measured from the live site by captureBrandVisual) with voiceProfile.accentColor
// + logo_url as fallbacks. Only accent colors and logo are overridden; the reel
// keeps its light background + dark body text so contrast is always safe.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normHex(s) {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  if (!HEX.test(v)) return null; // descriptors ("deep indigo") are not usable as a hex
  return v.length === 4 ? '#' + [...v.slice(1)].map(c => c + c).join('') : v.toLowerCase();
}

// Mix a hex toward white (amt 0..1) for the lighter companion shade (orbit gradient).
function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c) => Math.round(c + (255 - c) * amt);
  return '#' + [mix(r), mix(g), mix(b)].map(c => c.toString(16).padStart(2, '0')).join('');
}

// Perceived lightness 0..1 (rec601 luma) — guards the bg override.
function lightness(hex) {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16 & 255) * 0.299 + (n >> 8 & 255) * 0.587 + (n & 255) * 0.114) / 255;
}

export function buildBrand(brandName, profileData, logoUrl) {
  const brand = { name: brandName };
  const v = profileData?.brandVisual || {};
  const accent = normHex(v.accentColor) || normHex(profileData?.voiceProfile?.accentColor);
  if (accent) brand.colors = { accent, accent2: lighten(accent, 0.45) };
  // Canvas takes the brand's measured page background ONLY when it's clearly
  // light — the reel's text/cards are designed for a light canvas, so a dark
  // site bg (or a mid-tone) would break contrast. Dark-mode reels are a
  // template variant, not a color swap.
  const bg = normHex(v.bgColor);
  if (bg && lightness(bg) >= 0.88) {
    brand.colors = { ...(brand.colors || {}), bg };
  }
  const logo = v.logoUrl || logoUrl;
  if (typeof logo === 'string' && /^https?:\/\//.test(logo)) brand.logo = logo;
  return brand;
}

// Lazy-load the heavy SDKs so they only resolve when video is actually used.
async function lambdaClient() {
  return import('@remotion/lambda/client');
}

// Derive the render bucket from the serve URL:
// https://<bucket>.s3.<region>.amazonaws.com/sites/forge-reels/index.html
function renderBucket() {
  const host = new URL(process.env.REMOTION_LAMBDA_SERVE_URL).hostname;
  return host.split('.s3.')[0];
}

// ── Creative direction vocabulary ──────────────────────────────────────────
// A curated, finite deck the storyboard agent picks from (grounded in the brand
// brain) and the user can override via the UI pickers. Finite = QA-able and
// repeatable; the brain picks the default, the human holds a veto.
//
// Music beds are pre-generated (fal.ai Stable Audio, instrumental, ~47s, loop
// in the template) and live in the render bucket under forge-music/. Presigned
// per render like the VO clips.
export const MUSIC_BEDS = {
  'uplift-tech':    { key: 'forge-music/uplift-tech.mp3',    desc: 'uplifting minimal electronic pulse — modern SaaS optimism' },
  'warm-editorial': { key: 'forge-music/warm-editorial.mp3', desc: 'warm cinematic piano + soft strings — elegant, editorial, luxury' },
  'bold-energy':    { key: 'forge-music/bold-energy.mp3',    desc: 'bold punchy electronic beat — confident, driving' },
  'calm-minimal':   { key: 'forge-music/calm-minimal.mp3',   desc: 'calm ambient pads — spacious, clean, serene' },
  'corporate-rise': { key: 'forge-music/corporate-rise.mp3', desc: 'inspiring build, light percussion + hopeful piano — momentum' },
  'night-luxe':     { key: 'forge-music/night-luxe.mp3',     desc: 'smooth dark downtempo groove — luxury, sophisticated, deep' },
};

// OpenAI gpt-4o-mini-tts voices, curated with delivery characters the agent
// can match to the brand's tone. Expressiveness comes from the `instructions`
// (see voiceInstructions / the directionGuide spec), not the voice id alone —
// this is the same steerable model openai.fm demos.
export const VOICES = {
  ash:     { desc: 'confident, brisk, modern — default tech/product energy' },
  onyx:    { desc: 'deep, measured, authoritative — premium and serious' },
  ballad:  { desc: 'smooth, cinematic, unhurried — editorial luxury' },
  sage:    { desc: 'warm, calm, reassuring — human and trustworthy' },
  nova:    { desc: 'bright, friendly, upbeat — consumer warmth' },
  shimmer: { desc: 'energetic, crisp, lively — launch-day excitement' },
  coral:   { desc: 'warm, expressive, characterful — conversational and human' },
  verse:   { desc: 'dynamic, narrative, emotive — storytelling range' },
};

// Visual themes — implemented in the Remotion template (remotion/src/DataReel.tsx
// THEMES map: palette, typography, motion physics).
export const THEMES = {
  clean:     { desc: 'light, modern product look — crisp sans, smooth motion (the default)' },
  editorial: { desc: 'luxury magazine — serif headlines, lighter weight, slow elegant glide' },
  bold:      { desc: 'dark canvas, huge type, high contrast — confident and dramatic' },
  kinetic:   { desc: 'springy, fast, punchy entrances — launch-day energy' },
};

// Rich, structured default delivery (openai.fm style) — multi-dimensional
// direction is what makes gpt-4o-mini-tts sound human instead of robotic.
const DEFAULT_VOICE_INSTRUCTIONS = `Voice Affect: Confident, modern, and genuinely engaged — like a smart founder who believes what they're saying.
Tone: Warm and conversational, never an announcer or a robot.
Pacing: Natural and varied — quicker through setup, slowing to land the key phrase. Avoid a flat, even cadence.
Emotion: Real conviction and a little energy.
Pauses: Brief, natural breaths between sentences; a beat before the payoff line.`;

const DEFAULT_DIRECTION = {
  voice: 'ash',
  voiceInstructions: DEFAULT_VOICE_INSTRUCTIONS,
  musicBed: 'uplift-tech',
  theme: 'clean',
  mood: 'modern tech optimism',
};

// Merge the agent's pick with user overrides ('auto'/absent = keep the pick).
// Unknown ids fall back to defaults so a hallucinated bed/voice can't break TTS
// or the render. Pure — unit-tested.
export function resolveDirection(agentPick, overrides) {
  const d = { ...DEFAULT_DIRECTION, ...(agentPick || {}) };
  const o = overrides || {};
  if (o.voice && o.voice !== 'auto') d.voice = o.voice;
  if (o.musicBed && o.musicBed !== 'auto') d.musicBed = o.musicBed;
  if (o.theme && o.theme !== 'auto') d.theme = o.theme;
  if (!VOICES[d.voice]) d.voice = DEFAULT_DIRECTION.voice;
  if (d.musicBed !== 'none' && !MUSIC_BEDS[d.musicBed]) d.musicBed = DEFAULT_DIRECTION.musicBed;
  if (!THEMES[d.theme]) d.theme = DEFAULT_DIRECTION.theme;
  if (typeof d.voiceInstructions !== 'string' || !d.voiceInstructions.trim()) {
    d.voiceInstructions = DEFAULT_DIRECTION.voiceInstructions;
  }
  return d;
}

// ── Duration budget ─────────────────────────────────────────────────────────
// Scene durations derive from VO word counts (framesForVoiceover), so "make it
// 15 seconds" in a brief was decorative — the agent wrote 5-7 scenes and blew
// the budget every time. Two layers:
//   1) the prompt gets a hard scene-count + VO word budget for the target
//   2) enforceDuration() deterministically trims AFTER storyboarding (and
//      before paying for TTS): drop middle scenes (never the hook or CTA)
//      until the estimate fits target + 15% slack.
export const LENGTH_BUDGETS = {
  15: { scenes: '3 (hook, ONE middle beat, cta)', maxVoWords: 9 },
  30: { scenes: '4', maxVoWords: 13 },
  60: { scenes: '5-6', maxVoWords: 18 },
};

export function normalizeTargetSeconds(v) {
  const n = Number(v);
  return LENGTH_BUDGETS[n] ? n : 30;
}

export function estimateSeconds(scenes) {
  return scenes.reduce((a, s) => a + (s.durationInFrames || framesForVoiceover(s.voiceover)), 0) / FPS;
}

export function enforceDuration(scenes, targetSeconds) {
  const cap = targetSeconds * 1.15;
  const out = [...scenes];
  while (out.length > 3 && estimateSeconds(out) > cap) {
    out.splice(Math.floor(out.length / 2), 1); // drop a middle beat, keep hook + cta
  }
  return out;
}

// ── Storyboard agent ──────────────────────────────────────────────────────
// Brief -> scenes[] matching remotion/src/types.ts. The agent picks scene
// archetypes and copy + writes a short voiceover line per scene. Frame
// durations are computed here from the VO word count (see synthesizeScenes),
// not by the model.
const SCENE_GUIDE = `
Scene archetypes (pick the right one per beat, 5-7 scenes total):
- hook:     { type:"hook", eyebrow?, headline, emphasis?, sub? }  — opening punch. emphasis renders as a colored 2nd line.
- tags:     { type:"tags", headline, tags:[3-4 short words] }     — a claim + chips.
- orbit:    { type:"orbit", centerLabel (use \\n for 2 lines), facets:[3-4], caption?, captionEmphasis? } — a hub concept with orbiting ideas.
- pipeline: { type:"pipeline", headline, headlineEmphasis?, stages:[5-8 short labels] } — a process/flow.
- bars:     { type:"bars", headline, headlineEmphasis?, bars:[{label,pct}], footnoteLabel?, footnoteChips?:[] } — a metric/comparison. pct 0-100.
- curve:    { type:"curve", headline, headlineEmphasis?, flatLabel? } — a "compounds over time" idea.
- cta:      { type:"cta", title, sub?, cta } — the closing call to action.

Rules:
- Always open with exactly one "hook" and close with exactly one "cta".
- Copy is punchy and concrete. Headlines <= 8 words. NO em dashes.
- Every scene MUST include a "voiceover" string: one spoken sentence (8-22 words) that matches the on-screen beat.
- Output ONLY JSON: { "direction": {...}, "scenes": [ { "id":"kebab-name", "type":..., ...fields, "voiceover":"..." } ] }`;

function directionGuide() {
  const beds = Object.entries(MUSIC_BEDS).map(([id, b]) => `  - "${id}": ${b.desc}`).join('\n');
  const voices = Object.entries(VOICES).map(([id, v]) => `  - "${id}": ${v.desc}`).join('\n');
  const themes = Object.entries(THEMES).map(([id, t]) => `  - "${id}": ${t.desc}`).join('\n');
  return `
Creative direction — pick ONE music bed, ONE voice, and ONE visual theme that match this brand's personality (use the BRAND PROFILE below; e.g. a luxury editorial brand wants ballad/onyx + warm-editorial/night-luxe + the editorial theme, not the default tech treatment):

Music beds:
${beds}

Voices:
${voices}

Visual themes:
${themes}

Include in the output JSON:
"direction": {
  "musicBed": "<bed id>",
  "voice": "<voice id>",
  "theme": "<theme id>",
  "voiceInstructions": "<see spec below>",
  "mood": "2-4 word creative mood"
}

voiceInstructions is the single biggest lever on whether the voiceover sounds human or robotic. Do NOT write one flat sentence. Write a SHORT, MULTI-LINE delivery direction for a real voice actor, tuned to THIS brand, using these labeled lines (omit any that don't apply):
Voice Affect: <the persona behind the mic — e.g. "a calm luxury creative director", "a sharp, excited founder">
Tone: <warm/commanding/playful/intimate — and what to AVOID, e.g. "never an announcer">
Pacing: <fast/slow/varied; tell it where to speed up and where to slow down and land a line>
Emotion: <the feeling to convey>
Emphasis: <which words/phrases to stress>
Pauses: <where to breathe or hold a beat>
Keep it punchy (5-7 short lines). Match it to the brand: a luxury brand = unhurried, intimate, composed; a launch = fast, bright, energetic.`;
}

function lengthGuide(targetSeconds) {
  const b = LENGTH_BUDGETS[targetSeconds];
  return `
HARD LENGTH BUDGET — the video must run ~${targetSeconds} seconds. Scene durations are computed from voiceover length, so the ONLY way to hit the budget is:
- Use exactly ${b.scenes} scenes. No more.
- Every voiceover is AT MOST ${b.maxVoWords} words. Count them.
Scenes beyond the budget get cut in post (middle scenes dropped), so do not write extra scenes hoping they survive.`;
}

export async function storyboardFromBrief({ brief, brandName, brandContext = '', targetSeconds = 30 }) {
  const contextBlock = brandContext ? `\n\nBRAND PROFILE (ground the creative direction in this):\n${brandContext}` : '';
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `You are a brand video director for "${brandName}". Turn this brief into a short product reel storyboard.\n\nBRIEF:\n${brief}${contextBlock}\n${lengthGuide(targetSeconds)}\n\n${SCENE_GUIDE}\n${directionGuide()}`,
    }],
  });
  const text = msg?.content?.[0]?.text || '';
  const parsed = safeParseLLM(text);
  let scenes = parsed?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Storyboard agent returned no scenes');
  }
  // Deterministic backstop — the model's word counting is advisory; this isn't.
  scenes = enforceDuration(scenes, targetSeconds);
  return { scenes, direction: parsed?.direction || null };
}

// Condense the profile fields the director actually needs (voice + aesthetic).
export function brandContextFor(profileData) {
  const vp = profileData?.voiceProfile || {};
  const parts = [];
  if (vp.summary) parts.push(`Voice: ${vp.summary}`);
  if (vp.visualStyle) parts.push(`Visual style: ${vp.visualStyle}`);
  if (vp.positioning) parts.push(`Positioning: ${vp.positioning}`);
  if (Array.isArray(vp.toneAttributes) && vp.toneAttributes.length) {
    parts.push(`Tone: ${vp.toneAttributes.map(t => t.attribute).filter(Boolean).join(', ')}`);
  }
  return parts.join('\n').slice(0, 2000);
}

// ── Per-scene TTS -> S3 (presigned URL) ───────────────────────────────────
// Estimate spoken length from word count (~2.3 words/sec) so the scene is never
// shorter than its audio; add a short tail. Avoids needing ffprobe on the dyno.
export function framesForVoiceover(vo) {
  const words = String(vo || '').trim().split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(2.2, words / 2.3 + 0.8);
  return Math.round(seconds * FPS);
}

async function ttsToBuffer(text, voice, instructions) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: voice || 'ash',
      input: text,
      instructions: instructions || 'Brisk, confident, modern brand voice. Natural energy, not robotic.',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadAndPresign(buf, key) {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({ region: process.env.REMOTION_AWS_REGION });
  const Bucket = renderBucket();
  await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: buf, ContentType: 'audio/mpeg' }));
  // Presigned GET avoids bucket-ACL/Object-Ownership headaches; 6h is well past any render.
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: 6 * 3600 });
}

// Synthesize VO for each scene, attach audio URL + computed duration, and strip
// the voiceover field (the template doesn't read it). Returns render-ready scenes.
export async function synthesizeScenes(scenes, jobId, direction) {
  const d = direction || {};
  const out = [];
  for (let i = 0; i < scenes.length; i++) {
    const { voiceover, ...scene } = scenes[i];
    scene.durationInFrames = scene.durationInFrames || framesForVoiceover(voiceover);
    if (voiceover && process.env.OPENAI_API_KEY) {
      const buf = await ttsToBuffer(voiceover, d.voice, d.voiceInstructions);
      scene.audio = await uploadAndPresign(buf, `forge-audio/${jobId}/${scene.id || i}.mp3`);
    }
    out.push(scene);
  }
  return out;
}

// Presigned URL for a curated music bed ('none' or unknown -> null).
export async function presignMusicBed(bedId) {
  const bed = MUSIC_BEDS[bedId];
  if (!bed) return null;
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({ region: process.env.REMOTION_AWS_REGION });
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: renderBucket(), Key: bed.key }), { expiresIn: 6 * 3600 });
}

// ── Lambda render ─────────────────────────────────────────────────────────
export async function renderReel({ brand, scenes, orientation, music, theme }) {
  const { renderMediaOnLambda } = await lambdaClient();
  // orientation flows into inputProps; the site's calculateMetadata maps it to
  // 1080x1920 (portrait) or 1920x1080 (landscape).
  const o = orientation === 'portrait' ? 'portrait' : 'landscape';
  const { renderId, bucketName } = await renderMediaOnLambda({
    region: process.env.REMOTION_AWS_REGION,
    functionName: process.env.REMOTION_LAMBDA_FUNCTION_NAME,
    serveUrl: process.env.REMOTION_LAMBDA_SERVE_URL,
    composition: 'DataReel',
    inputProps: { brand, scenes, orientation: o, ...(music ? { music } : {}), ...(theme ? { theme } : {}) },
    codec: 'h264',
    framesPerLambda: FRAMES_PER_LAMBDA,
    privacy: 'public',
    downloadBehavior: { type: 'download', fileName: 'forge-reel.mp4' },
  });
  return { renderId, bucketName };
}

export async function getReelProgress(renderId, bucketName) {
  const { getRenderProgress } = await lambdaClient();
  return getRenderProgress({
    renderId,
    bucketName,
    functionName: process.env.REMOTION_LAMBDA_FUNCTION_NAME,
    region: process.env.REMOTION_AWS_REGION,
  });
}
