import { describe, it, expect } from 'vitest';
import { claudeText } from '../src/server/llm.js';

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
});
