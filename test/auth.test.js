import { describe, it, expect } from 'vitest';
import { hashApiKey, requireApiKeyScope } from '../src/server/auth.js';

describe('hashApiKey', () => {
  it('sha256-hex hashes its input (known vector for "abc")', () => {
    expect(hashApiKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is deterministic and 64 hex chars', () => {
    const h = hashApiKey('fik_live_deadbeef');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('fik_live_deadbeef')).toBe(h);
  });
});

describe('requireApiKeyScope', () => {
  const run = (apiKeyAuth, body = {}) => {
    const req = { apiKeyAuth, body, params: {} };
    let status = null;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    let nexted = false;
    requireApiKeyScope('emails:read')(req, res, () => { nexted = true; });
    return { status, nexted };
  };

  it('skips (JWT path) when there is no apiKeyAuth', () => {
    expect(run(undefined)).toEqual({ status: null, nexted: true });
  });
  it('403s when the key lacks the required scope', () => {
    expect(run({ scopes: ['campaigns:read'], brandIds: [] })).toEqual({ status: 403, nexted: false });
  });
  it('403s when the brand is not in the key allowlist', () => {
    expect(run({ scopes: ['emails:read'], brandIds: ['brand-a'] }, { brandProfileId: 'brand-b' }))
      .toEqual({ status: 403, nexted: false });
  });
  it('passes when both scope and brand are allowed', () => {
    expect(run({ scopes: ['emails:read'], brandIds: ['brand-a'] }, { brandProfileId: 'brand-a' }))
      .toEqual({ status: null, nexted: true });
  });
});
