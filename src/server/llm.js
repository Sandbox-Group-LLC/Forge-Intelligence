// LLM client + prompt helpers, extracted from server.js during the decomposition.
// `anthropic` is the shared Claude client (20-minute timeout for long-form
// generations). dateContext anchors prompts to "today" so models don't drift to
// their training-cutoff year.
import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 1200000 }); // 20min

export function dateContext() {
  const now = new Date();
  const formatted = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
  const isoDate = now.toISOString().slice(0, 10);
  const year = now.getFullYear();
  return `TODAY IS ${formatted} (ISO: ${isoDate}). The current year is ${year}. ` +
    `When you reference dates, time periods, or 'recent' events, anchor them to this date — ` +
    `do not assume an earlier year. If you write phrases like 'in ${year - 1}' or 'this year', ` +
    `they must be accurate against ${year}, not your training cutoff.`;
}

// ── Model roster + resilient streaming ───────────────────────────────────────
// Article writer runs Sonnet 5 primary, prior-gen Sonnet 4.6 as the fallback —
// mirrors the OpenClaw primary→fallback pattern. Ordered: try index 0 first.
export const ARTICLE_WRITER_MODELS = ['claude-sonnet-5', 'claude-sonnet-4-6'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transient = capacity/infra, safe to retry or fall back. A 529 overloaded_error
// (the failure seen 2026-07-28) lands here; a 4xx request error does NOT — that's
// our bug, not Anthropic's load, so we fail fast instead of masking it.
function isTransientLLMError(err) {
  const type = err?.error?.type || err?.type;
  if (type === 'overloaded_error') return true;
  const status = err?.status ?? err?.statusCode;
  if (typeof status === 'number') return status === 429 || status === 529 || (status >= 500 && status < 600);
  return /Connection|Timeout|ECONNRESET|socket hang up/i.test(err?.name || err?.message || '');
}

/**
 * Stream a Claude completion across an ordered model list with bounded retry.
 *
 * @param {string[]} models   Tried in order (e.g. ARTICLE_WRITER_MODELS).
 * @param {function} onText   Called with each streamed text delta.
 * @returns {Promise<{text:string, model:string}>} full text + the model that produced it.
 *
 * Fallback safety: we only retry or advance to the next model while ZERO text has
 * been emitted for the current attempt. Once real content has streamed to the
 * caller we re-throw on failure rather than splice a second model's output into
 * the same response. Overload errors strike at stream-open (0 emitted), so the
 * common case falls back cleanly and invisibly.
 */
export async function streamTextWithFallback({
  models, max_tokens, system, messages,
  onText = () => {}, log = () => {}, client = anthropic, attemptsPerModel = 2,
}) {
  let lastErr;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
      let emitted = 0;
      try {
        const stream = await client.messages.stream({ model, max_tokens, system, messages });
        let fullText = '';
        const usage = { input_tokens: 0, output_tokens: 0 };
        for await (const chunk of stream) {
          if (chunk.type === 'message_start') {
            usage.input_tokens = chunk.message?.usage?.input_tokens ?? usage.input_tokens;
            usage.output_tokens = chunk.message?.usage?.output_tokens ?? usage.output_tokens;
          } else if (chunk.type === 'message_delta' && chunk.usage?.output_tokens != null) {
            usage.output_tokens = chunk.usage.output_tokens; // cumulative
          } else if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
            fullText += chunk.delta.text;
            emitted += chunk.delta.text.length;
            onText(chunk.delta.text);
          }
        }
        if (m > 0 || attempt > 1) log(`[LLM] recovered on ${model} (model #${m + 1}, attempt ${attempt})`);
        return { text: fullText, model, usage };
      } catch (err) {
        lastErr = err;
        if (emitted > 0) throw err;                 // content already streamed — no safe swap
        if (!isTransientLLMError(err)) throw err;    // real error — surface it
        const moreOnThisModel = attempt < attemptsPerModel;
        const moreModels = m < models.length - 1;
        if (!moreOnThisModel && !moreModels) throw err;
        const label = err?.error?.type || err?.status || err?.name || 'transient';
        if (moreOnThisModel) {
          const backoffMs = 400 * 2 ** (attempt - 1); // 400ms, 800ms, …
          log(`[LLM] ${model} ${label}; retry ${attempt + 1}/${attemptsPerModel} in ${backoffMs}ms`);
          await sleep(backoffMs);
        } else {
          log(`[LLM] ${model} ${label} after ${attemptsPerModel} attempts; falling back to ${models[m + 1]}`);
        }
      }
    }
  }
  throw lastErr;
}
