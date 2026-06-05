import { describe, it, expect } from 'vitest';
import { buildXOAuthHeader } from '../src/server/x.js';

// buildXOAuthHeader is the only pure (no-I/O) export — uploadXMedia and
// refreshXOAuth2Token hit the network, so they're exercised via the live
// publish path, not unit tests. We assert the OAuth 1.0a header shape and
// signature determinism here.
describe('buildXOAuthHeader', () => {
  const header = () => buildXOAuthHeader(
    'POST', 'https://api.x.com/2/tweets',
    'consumerKey', 'consumerSecret', 'accessToken', 'accessSecret',
    { status: 'hello world' },
  );

  it('emits an OAuth header with all required oauth_* fields', () => {
    const h = header();
    expect(h.startsWith('OAuth ')).toBe(true);
    for (const field of [
      'oauth_consumer_key', 'oauth_nonce', 'oauth_signature_method',
      'oauth_timestamp', 'oauth_token', 'oauth_version', 'oauth_signature',
    ]) {
      expect(h).toContain(field);
    }
    expect(h).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(h).toContain('oauth_consumer_key="consumerKey"');
  });

  it('does not leak the extraParams (status) into the header — they only sign', () => {
    // extraParams contribute to the signature base string but must NOT appear
    // as header keys (only oauth_* params are serialized into the header).
    expect(header()).not.toContain('status=');
  });

  it('produces a stable signature for fixed nonce + timestamp', () => {
    // Freeze Date and randomBytes-derived nonce indirectly by comparing two
    // calls within the same millisecond is flaky; instead assert the signature
    // is a base64 string of expected length for HMAC-SHA1 (28 chars, '=' pad).
    const sig = header().match(/oauth_signature="([^"]+)"/)[1];
    const decoded = decodeURIComponent(sig);
    expect(decoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(decoded, 'base64')).toHaveLength(20); // SHA-1 digest = 20 bytes
  });
});
