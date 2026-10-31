import { describe, it, expect, vi, afterEach } from 'vitest';
import { claudeText, streamOpenAIChat } from '../src/server/llm.js';

// Build a fake SSE response body from raw strings, optionally splitting each
// into sub-chunks so lines straddle chunk boundaries (the buffering trap).
function sseBody(raw, splitEvery = 0) {
  const encoder = new TextEncoder();
  const pieces = [];
  if (!splitEvery) {
    pieces.push(raw);
  } else {
    for (let i = 0; i < raw.length; i += splitEvery) pieces.push(raw.slice(i, i + splitEvery));
  }
  return new ReadableStream({
    start(controller) {
      for (const p of pieces) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
}

const okRes = (body) => ({ ok: true, status: 200, body });

describe('streamOpenAIChat', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('streams text deltas, captures finish_reason + usage, calls onText', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const events = [
      'data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"posts\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"[]}"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":0},"total_tokens":17}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    globalThis.fetch = vi.fn(async () => okRes(sseBody(events)));
    const seen = [];
    const out = await streamOpenAIChat({
      model: 'gpt-6.1-terra', max_completion_tokens: 16000, reasoning_effort: 'none',
      system: 'sys', messages: [{ role: 'user', content: 'hi' }],
      onText: (t) => seen.push(t),
    });
    expect(out.text).toBe('{"posts":[]}');
    expect(seen).toEqual(['{"posts":', '[]}']);
    expect(out.finishReason).toBe('stop');
    expect(out.usage.completion_tokens_details.reasoning_tokens).toBe(0);
    // Request shape: the two reasoning-era rules — max_completion_tokens (never
    // max_tokens) and the pinned reasoning_effort.
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(16000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('none');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('reassembles SSE lines split across chunk boundaries', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const events = 'data: {"choices":[{"delta":{"content":"abc"}}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = vi.fn(async () => okRes(sseBody(events, 7)));
    const out = await streamOpenAIChat({
      model: 'gpt-6.1-terra', max_completion_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.text).toBe('abc');
  });

  it('collects a refusal delta instead of crashing, keeps text empty', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const events = 'data: {"choices":[{"delta":{"refusal":"cannot help"}}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = vi.fn(async () => okRes(sseBody(events)));
    const out = await streamOpenAIChat({
      model: 'gpt-6.1-terra', max_completion_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.text).toBe('');
    expect(out.refusal).toBe('cannot help');
  });

  it('throws with status + body slice on a non-ok response (e.g. max_tokens 400)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 400,
      text: async () => '{"error":{"message":"Unsupported parameter: \'max_tokens\'"}}',
    }));
    await expect(streamOpenAIChat({
      model: 'gpt-6.1-terra', max_completion_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/openai gpt-6.1-terra 400: .*max_tokens/);
  });

  it('fails honestly when OPENAI_API_KEY is missing', async () => {
    await expect(streamOpenAIChat({
      model: 'gpt-6.1-terra', max_completion_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow('OPENAI_API_KEY not configured');
  });
});

describe('claudeText', () => {
  it('joins text blocks and skips thinking blocks', () => {
    const message = {
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: '{"ok":true}' },
      ],
    };
    expect(claudeText(message)).toBe('{"ok":true}');
  });

  it('returns empty string when there is no text block', () => {
    expect(claudeText({ content: [{ type: 'thinking', thinking: 'x' }] })).toBe('');
    expect(claudeText({})).toBe('');
  });

  it('does not collapse a critique to {} when thinking leads', () => {
    const message = {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'score the draft' },
        { type: 'text', text: '{"overallScore":80,"summary":"Fine.","flags":[]}' },
      ],
    };
    const oldRead = message.content?.[0]?.text || '{}';
    expect(oldRead).toBe('{}');
    expect(claudeText(message)).toContain('"overallScore":80');
  });
});
