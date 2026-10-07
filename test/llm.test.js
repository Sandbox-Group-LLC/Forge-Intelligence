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
