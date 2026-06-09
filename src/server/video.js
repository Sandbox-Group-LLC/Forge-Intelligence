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
- Output ONLY JSON: { "scenes": [ { "id":"kebab-name", "type":..., ...fields, "voiceover":"..." } ] }`;

export async function storyboardFromBrief({ brief, brandName }) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a brand video director for "${brandName}". Turn this brief into a short product reel storyboard.\n\nBRIEF:\n${brief}\n\n${SCENE_GUIDE}`,
    }],
  });
  const text = msg?.content?.[0]?.text || '';
  const parsed = safeParseLLM(text);
  const scenes = parsed?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Storyboard agent returned no scenes');
  }
  return scenes;
}

// ── Per-scene TTS -> S3 (presigned URL) ───────────────────────────────────
// Estimate spoken length from word count (~2.3 words/sec) so the scene is never
// shorter than its audio; add a short tail. Avoids needing ffprobe on the dyno.
export function framesForVoiceover(vo) {
  const words = String(vo || '').trim().split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(2.2, words / 2.3 + 0.8);
  return Math.round(seconds * FPS);
}

async function ttsToBuffer(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      input: text,
      instructions: 'Brisk, confident, modern brand voice. Natural energy, not robotic.',
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
export async function synthesizeScenes(scenes, jobId) {
  const out = [];
  for (let i = 0; i < scenes.length; i++) {
    const { voiceover, ...scene } = scenes[i];
    scene.durationInFrames = scene.durationInFrames || framesForVoiceover(voiceover);
    if (voiceover && process.env.OPENAI_API_KEY) {
      const buf = await ttsToBuffer(voiceover);
      scene.audio = await uploadAndPresign(buf, `forge-audio/${jobId}/${scene.id || i}.mp3`);
    }
    out.push(scene);
  }
  return out;
}

// ── Lambda render ─────────────────────────────────────────────────────────
export async function renderReel({ brand, scenes, orientation }) {
  const { renderMediaOnLambda } = await lambdaClient();
  // orientation flows into inputProps; the site's calculateMetadata maps it to
  // 1080x1920 (portrait) or 1920x1080 (landscape).
  const o = orientation === 'portrait' ? 'portrait' : 'landscape';
  const { renderId, bucketName } = await renderMediaOnLambda({
    region: process.env.REMOTION_AWS_REGION,
    functionName: process.env.REMOTION_LAMBDA_FUNCTION_NAME,
    serveUrl: process.env.REMOTION_LAMBDA_SERVE_URL,
    composition: 'DataReel',
    inputProps: { brand, scenes, orientation: o },
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
