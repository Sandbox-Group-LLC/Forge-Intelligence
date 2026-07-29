import { describe, it, expect } from 'vitest';
import { truncateStr, truncateAtSentence, stripSocialMarkdown, quickStartTruncate, stripScaffoldingArtifacts, stripEmDashes, stripEmDashesFromArticle, finalizeArticleForStorage } from '../src/server/text.js';

describe('truncateStr', () => {
  it('returns null for null/undefined', () => {
    expect(truncateStr(null, 5)).toBeNull();
    expect(truncateStr(undefined, 5)).toBeNull();
  });
  it('leaves short strings unchanged', () => {
    expect(truncateStr('hi', 5)).toBe('hi');
  });
  it('hard-truncates longer strings with no ellipsis', () => {
    expect(truncateStr('hello world', 5)).toBe('hello');
  });
  it('coerces non-strings', () => {
    expect(truncateStr(12345, 3)).toBe('123');
  });
});

describe('truncateAtSentence', () => {
  it('returns empty string for non-string input', () => {
    expect(truncateAtSentence(null, 10)).toBe('');
  });
  it('returns trimmed text when under the limit', () => {
    expect(truncateAtSentence('  short.  ', 100)).toBe('short.');
  });
  it('prefers a sentence boundary', () => {
    expect(truncateAtSentence('First sentence. Second sentence that overflows the window.', 20)).toBe('First sentence.');
  });
  it('falls back to a word boundary with an ellipsis', () => {
    const out = truncateAtSentence('one two three four five six seven', 18);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('one two')).toBe(true);
  });
});

describe('stripSocialMarkdown', () => {
  it('removes heading markers', () => {
    expect(stripSocialMarkdown('# Title\n## Sub')).toBe('Title\nSub');
  });
  it('unwraps **bold** and __bold__', () => {
    expect(stripSocialMarkdown('a **bold** and __also__ here')).toBe('a bold and also here');
  });
  it('passes non-strings through unchanged', () => {
    expect(stripSocialMarkdown(null)).toBeNull();
  });
});

describe('quickStartTruncate', () => {
  it('returns empty string for non-strings', () => {
    expect(quickStartTruncate(123, 5)).toBe('');
    expect(quickStartTruncate(null, 5)).toBe('');
  });
  it('leaves short strings unchanged (no ellipsis)', () => {
    expect(quickStartTruncate('hi', 5)).toBe('hi');
  });
  it('slices and appends an ellipsis when over the limit', () => {
    expect(quickStartTruncate('hello world', 5)).toBe('hello…');
  });
  it('trims trailing whitespace before the ellipsis', () => {
    expect(quickStartTruncate('hello     world', 8)).toBe('hello…');
  });
});

describe('stripScaffoldingArtifacts', () => {
  it('returns non-article input untouched', () => {
    expect(stripScaffoldingArtifacts(null)).toBeNull();
    expect(stripScaffoldingArtifacts({ no: 'sections' })).toEqual({ no: 'sections' });
  });
  it('removes inline bracketed scaffolding but keeps legit refs like [1]', () => {
    const article = { sections: [{ body: 'Real prose [CTA: sign up now] and a citation [1].' }] };
    const out = stripScaffoldingArtifacts(article);
    expect(out.sections[0].body).toContain('Real prose');
    expect(out.sections[0].body).toContain('[1]');
    expect(out.sections[0].body).not.toContain('CTA');
  });
  it('drops standalone bracketed-instruction paragraphs', () => {
    const article = { sections: [{ body: 'Keep this.\n\n[SME Hook: add an anecdote here]\n\nKeep this too.' }] };
    const out = stripScaffoldingArtifacts(article);
    expect(out.sections[0].body).toBe('Keep this.\n\nKeep this too.');
  });
  it('cleans both body and content fields', () => {
    const article = { sections: [{ content: 'Hello [TODO: finish] world' }] };
    expect(stripScaffoldingArtifacts(article).sections[0].content).toBe('Hello world');
  });
});

describe('stripEmDashes', () => {
  it('replaces a spaced em dash with a comma', () => {
    expect(stripEmDashes('Intelligence compounds — the content proves it.'))
      .toBe('Intelligence compounds, the content proves it.');
  });
  it('replaces an unspaced em dash with a comma', () => {
    expect(stripEmDashes('one—two')).toBe('one, two');
  });
  it('keeps numeric en-dash ranges as hyphens', () => {
    expect(stripEmDashes('the 2024–2026 window')).toBe('the 2024-2026 window');
  });
  it('turns a non-numeric en dash into a comma', () => {
    expect(stripEmDashes('strategy – not tactics')).toBe('strategy, not tactics');
  });
  it('does not double up when a comma already follows', () => {
    expect(stripEmDashes('X —, Y')).toBe('X, Y');
  });
  it('is null-safe / passes non-strings through', () => {
    expect(stripEmDashes(null)).toBeNull();
    expect(stripEmDashes(42)).toBe(42);
  });
  it('leaves clean prose (no dashes, hyphens intact) untouched', () => {
    expect(stripEmDashes('a well-built, dash-free sentence')).toBe('a well-built, dash-free sentence');
  });
});

describe('stripEmDashes — semicolon when the sentence already has 2+ commas', () => {
  it('uses a semicolon when 2+ commas precede in the sentence', () => {
    expect(stripEmDashes('It reads voice, audience, and gaps — then it writes.'))
      .toBe('It reads voice, audience, and gaps; then it writes.');
  });
  it('still uses a comma when only 1 comma is in the sentence', () => {
    expect(stripEmDashes('Strategy, not tactics — that is the point.'))
      .toBe('Strategy, not tactics, that is the point.');
  });
  it('decides per sentence (semicolon in one, comma in the next)', () => {
    expect(stripEmDashes('A, B, C — done. Quick — go.'))
      .toBe('A, B, C; done. Quick, go.');
  });
});

// Helper: no em/en dash survives anywhere in the stored article JSON — the same
// recursive check used to audit live articles in the DB.
const hasWideDash = (obj) => /[—–]/.test(JSON.stringify(obj));

describe('stripEmDashesFromArticle', () => {
  it('strips em dashes from every prose field the writer produces', () => {
    const article = {
      title: 'The Collaboration Tax — Why Per-Seat Pricing Drags',
      metaDescription: 'Per-seat pricing is a hidden drag — here is the math.',
      keyTakeaway: 'Seats gate access — access gates speed.',
      sections: [
        { heading: 'The Setup — First', body: 'Each access workaround — waiting for a screenshot, reformatting a file, re-entering data — can cost 5 to 7 senior hours.', content: 'inline — dash' },
      ],
      faqs: [
        { question: 'What is the tax — really?', answer: 'It is the overhead — measured in senior hours.' },
      ],
    };
    const out = stripEmDashesFromArticle(article);
    expect(hasWideDash(out)).toBe(false);
    expect(out.title).toBe('The Collaboration Tax, Why Per-Seat Pricing Drags');
    expect(out.sections[0].heading).toBe('The Setup, First');
    expect(out.faqs[0].answer).toBe('It is the overhead, measured in senior hours.');
  });

  it('returns non-article input untouched and does not mutate the input', () => {
    expect(stripEmDashesFromArticle(null)).toBeNull();
    expect(stripEmDashesFromArticle('nope')).toBe('nope');
    const input = { title: 'a — b', sections: [{ body: 'c — d' }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    stripEmDashesFromArticle(input);
    expect(input).toEqual(snapshot); // original object unchanged (new object returned)
  });

  it('leaves numeric ranges as hyphens, not comma splices', () => {
    const out = stripEmDashesFromArticle({ sections: [{ body: 'the 2024–2026 window' }] });
    expect(out.sections[0].body).toBe('the 2024-2026 window');
  });
});

describe('finalizeArticleForStorage — the shared net for every write path', () => {
  it('strips scaffolding AND em dashes in one pass', () => {
    const article = {
      title: 'Launch Playbook — Enterprise',
      sections: [
        { body: '[SME Hook: get an expert quote here]\n\nBoutique operators move fast — that is the edge.' },
      ],
      faqs: [{ question: 'Why boutique?', answer: 'Speed — and focus.' }],
    };
    const out = finalizeArticleForStorage(article);
    expect(hasWideDash(out)).toBe(false);                 // em dashes gone
    expect(out.sections[0].body).not.toMatch(/SME Hook/); // scaffolding gone
    expect(out.sections[0].body).toContain('Boutique operators move fast');
    expect(out.faqs[0].answer).toBe('Speed, and focus.');
  });

  it('is safe on minimal / malformed articles', () => {
    expect(finalizeArticleForStorage(null)).toBeNull();
    expect(finalizeArticleForStorage({ title: 'clean title' }).title).toBe('clean title');
    // sections with a null entry must not throw
    const out = finalizeArticleForStorage({ title: 'x — y', sections: [null, { body: 'a — b' }] });
    expect(hasWideDash(out)).toBe(false);
  });
});
