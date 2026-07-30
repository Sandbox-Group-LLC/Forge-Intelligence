const VALID_PERSONS = new Set(['first_singular', 'first_plural', 'third_plural', 'third_singular']);
const VALID_SPEAKERS = new Set(['company', 'person']);
const VALID_SUBJECTS = new Set(['company', 'person']);

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegex(value) {
  return asText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function boolValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

function defaultReferences(person) {
  switch (person) {
    case 'first_singular': return ['I', 'my', 'me', 'mine'];
    case 'first_plural': return ['we', 'our', 'us', 'ours'];
    case 'third_singular': return [];
    default: return [];
  }
}

/**
 * Normalize the optional brief-level identity into a stable, prompt-safe contract.
 * Missing identity intentionally preserves the historical institutional voice.
 */
export function normalizeNarrativeIdentity(identity, { brandName = '', author = null } = {}) {
  const source = identity && typeof identity === 'object' ? identity : {};
  const explicit = Object.keys(source).length > 0;
  const authorName = asText(source.speakerName) || asText(author?.name) || null;
  const grammaticalPerson = VALID_PERSONS.has(source.grammaticalPerson)
    ? source.grammaticalPerson
    : 'third_plural';
  // Infer speaker from the grammatical person when speakerType is missing/invalid:
  // a first-person-singular contract is an individual speaking, so it must not
  // collapse to a 'company' speaker (which would pair company voice with I/me/my
  // and force speakerName to the brand instead of the author).
  const speakerType = VALID_SPEAKERS.has(source.speakerType)
    ? source.speakerType
    : (explicit && grammaticalPerson === 'first_singular' ? 'person' : 'company');
  const subjectType = VALID_SUBJECTS.has(source.subjectType) ? source.subjectType : 'company';
  const personalExperienceAllowed = explicit
    ? boolValue(source.personalExperienceAllowed, grammaticalPerson === 'first_singular' && speakerType === 'person')
    : false;

  return {
    subjectType,
    speakerType,
    grammaticalPerson,
    speakerName: asText(source.speakerName) || (speakerType === 'company' ? asText(brandName) || null : authorName),
    bylineAuthorId: asText(source.bylineAuthorId) || null,
    allowedSelfReferences: Array.isArray(source.allowedSelfReferences) && source.allowedSelfReferences.length
      ? source.allowedSelfReferences.map(asText).filter(Boolean)
      : defaultReferences(grammaticalPerson),
    personalExperienceAllowed,
    notes: asText(source.notes) || '',
    explicit
  };
}

export function narrativeIdentityPromptBlock(identity, options = {}) {
  const normalized = normalizeNarrativeIdentity(identity, options);
  const speaker = normalized.speakerName || (normalized.speakerType === 'person' ? 'the named author' : 'the company');
  const perspective = {
    first_singular: 'first-person singular',
    first_plural: 'first-person plural',
    third_plural: 'third-person company voice',
    third_singular: 'third-person individual voice'
  }[normalized.grammaticalPerson];

  return `\nNARRATIVE IDENTITY — NON-NEGOTIABLE\n\n` +
    `Subject: ${normalized.subjectType}. Speaker: ${normalized.speakerType}, ${speaker}. Perspective: ${perspective}.\n` +
    `Allowed self-references: ${normalized.allowedSelfReferences.length ? normalized.allowedSelfReferences.join(', ') : 'refer to the subject by name or role'}.\n` +
    `Personal experience claims: ${normalized.personalExperienceAllowed ? 'allowed only when supported by the named author profile or Factual Ground' : 'forbidden; do not turn company facts into personal anecdotes'}.\n` +
    `${normalized.notes ? `Editorial note: ${normalized.notes}\n` : ''}` +
    `Do not silently change who is speaking. Brand voice controls tone; this block controls narrator, pronouns, attribution, and experience claims.\n`;
}

export function lintNarrativePerspective(text, identity, options = {}) {
  const body = asText(text);
  const normalized = normalizeNarrativeIdentity(identity, options);
  const issues = [];
  if (!body) return { ok: true, issues, identity: normalized };

  const add = (type, severity, phrase, message) => issues.push({ type, severity, phrase, message });
  const firstSingular = /\b(?:I|me|my|mine)\b/i;
  const personalAnecdote = /\b(?:I learned|I have learned|in my experience|from my experience|when I|I built|I saw|I found|I've seen|my experience)\b/i;

  if (normalized.grammaticalPerson !== 'first_singular' && firstSingular.test(body)) {
    add('unexpected_first_person', 'yellow', body.match(firstSingular)?.[0] || 'I', 'The article uses first-person singular language even though the selected narrator is not an individual first-person speaker.');
  }
  if (!normalized.personalExperienceAllowed && personalAnecdote.test(body)) {
    add('unsupported_personal_experience', 'red', body.match(personalAnecdote)?.[0] || 'personal experience', 'The article makes a personal experience claim without permission from the narrative identity.');
  }

  if (normalized.grammaticalPerson === 'first_singular' && normalized.speakerName) {
    const name = escapeRegex(normalized.speakerName);
    const thirdPersonSelf = new RegExp(`\\b${name}\\b\\s+(?:is|was|believes|says|has|had|learned|built|found)\\b`, 'i');
    const match = body.match(thirdPersonSelf) || body.match(/\bthe founder\b\s+(?:is|was|believes|says|has|had|learned|built|found)\b/i);
    if (match) add('third_person_self_reference', 'yellow', match[0], 'A first-person author is referred to in the third person.');
  }

  return { ok: issues.length === 0, issues, identity: normalized };
}

export const narrativeIdentityContract = {
  subjectType: 'company|person',
  speakerType: 'company|person',
  grammaticalPerson: 'first_singular|first_plural|third_plural|third_singular',
  speakerName: 'string|null',
  bylineAuthorId: 'string|null',
  allowedSelfReferences: 'string[]',
  personalExperienceAllowed: 'boolean',
  notes: 'string'
};
