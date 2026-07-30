import { describe, it, expect } from 'vitest';
import {
  normalizeNarrativeIdentity,
  lintNarrativePerspective
} from '../src/server/narrative-identity.js';

describe('normalizeNarrativeIdentity', () => {
  it('missing identity preserves institutional (company/third-plural) voice', () => {
    const n = normalizeNarrativeIdentity(undefined, { brandName: 'Acme' });
    expect(n.explicit).toBe(false);
    expect(n.speakerType).toBe('company');
    expect(n.grammaticalPerson).toBe('third_plural');
    expect(n.speakerName).toBe('Acme');
    expect(n.personalExperienceAllowed).toBe(false);
  });

  // Bug fix: an explicit first-person-singular contract that omits speakerType
  // must resolve to a PERSON speaker (not collapse to 'company'), and the
  // speakerName must be the author, not the brand.
  it('explicit first_singular without speakerType resolves to the author, not the company', () => {
    const n = normalizeNarrativeIdentity(
      { grammaticalPerson: 'first_singular' },
      { brandName: 'Acme', author: { name: 'Jane Founder', id: 'auth_jane' } }
    );
    expect(n.speakerType).toBe('person');
    expect(n.grammaticalPerson).toBe('first_singular');
    expect(n.speakerName).toBe('Jane Founder');
    expect(n.speakerName).not.toBe('Acme');
    expect(n.personalExperienceAllowed).toBe(true);
    expect(n.allowedSelfReferences).toContain('I');
  });

  it('an explicit speakerType is always honored, even against the grammatical person', () => {
    const n = normalizeNarrativeIdentity(
      { speakerType: 'person', grammaticalPerson: 'first_plural' },
      { brandName: 'Acme', author: { name: 'Jane' } }
    );
    expect(n.speakerType).toBe('person');
    expect(n.speakerName).toBe('Jane');
  });

  it('a non-first-singular explicit contract without speakerType stays company', () => {
    const n = normalizeNarrativeIdentity(
      { grammaticalPerson: 'third_plural' },
      { brandName: 'Acme', author: { name: 'Jane' } }
    );
    expect(n.speakerType).toBe('company');
    expect(n.speakerName).toBe('Acme');
  });

  it('passes a caller-provided bylineAuthorId through untouched (source must be correct)', () => {
    const n = normalizeNarrativeIdentity(
      { grammaticalPerson: 'third_plural', bylineAuthorId: 'auth_correct' },
      { brandName: 'Acme' }
    );
    expect(n.bylineAuthorId).toBe('auth_correct');
  });
});

describe('lintNarrativePerspective', () => {
  it('flags first-person singular in a company third-plural contract', () => {
    const identity = normalizeNarrativeIdentity({ grammaticalPerson: 'third_plural' }, { brandName: 'Acme' });
    const res = lintNarrativePerspective('I built this platform myself.', identity);
    expect(res.ok).toBe(false);
    expect(res.issues.some(i => i.type === 'unexpected_first_person')).toBe(true);
  });

  it('flags unsupported personal anecdote when personal experience is not allowed', () => {
    const identity = normalizeNarrativeIdentity({ grammaticalPerson: 'third_plural' }, { brandName: 'Acme' });
    const res = lintNarrativePerspective('In my experience, the market always rewards speed.', identity);
    expect(res.issues.some(i => i.type === 'unsupported_personal_experience' && i.severity === 'red')).toBe(true);
  });

  it('clean company-voice prose passes', () => {
    const identity = normalizeNarrativeIdentity({ grammaticalPerson: 'third_plural' }, { brandName: 'Acme' });
    const res = lintNarrativePerspective('Acme helps teams ship faster with less overhead.', identity);
    expect(res.ok).toBe(true);
  });
});
