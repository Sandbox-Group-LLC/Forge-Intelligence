import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared anthropic client (llm.js) so the prompt builders run without
// network. generateHeroImage / generateSocialImage are pure fal.ai fetch
// wrappers — exercised via the live publish path, not here.
const create = vi.fn();
vi.mock('../src/server/llm.js', () => ({
  anthropic: { messages: { create: (...a) => create(...a) } },
}));

const { buildImagePrompt, buildSocialImagePrompt } = await import('../src/server/images.js');

beforeEach(() => create.mockReset());

describe('buildImagePrompt', () => {
  it('returns the model text when the response is a text block', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '  a quiet workshop at dawn  ' }] });
    const out = await buildImagePrompt('My Title', { brand_name: 'Acme' }, 'body');
    expect(out).toBe('a quiet workshop at dawn');
  });

  it('falls back to a deterministic prompt when the response is not text', async () => {
    create.mockResolvedValue({ content: [{ type: 'tool_use' }] });
    const out = await buildImagePrompt('Widgets 101', {}, '');
    expect(out).toContain('Widgets 101');
    expect(out).toContain('natural available light');
  });

  it('passes brand visual context into the instruction when present', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    await buildImagePrompt('T', { visualStyle: 'brutalist', accentColor: '#f00' }, '');
    const sentInstruction = create.mock.calls[0][0].messages[0].content;
    expect(sentInstruction).toContain('visual identity'); // hasBrandVisual branch
    expect(sentInstruction).toContain('brutalist');
  });
});

describe('buildSocialImagePrompt', () => {
  it('returns model text on success', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: 'bold square shot' }] });
    expect(await buildSocialImagePrompt({ hook: 'launch day' }, {}, 'Acme')).toBe('bold square shot');
  });

  it('returns the deterministic fallback when the response is not a text block', async () => {
    // Same fallback string the catch path returns, so this covers the
    // "unusable model response" branch without a thrown-mock unhandled-rejection.
    create.mockResolvedValue({ content: [{ type: 'tool_use' }] });
    const out = await buildSocialImagePrompt({ hook: 'launch day' }, {}, 'Acme');
    expect(out).toContain('scroll-stopping social composition');
  });
});
