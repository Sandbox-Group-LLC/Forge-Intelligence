import { describe, it, expect } from 'vitest';
import { buildGhostJWT } from '../src/server/ghost.js';

const decode = (seg) => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));

describe('buildGhostJWT', () => {
  // "keyId:hexSecret" — secret is hex; use a valid hex string.
  const jwt = buildGhostJWT('64ef…id:deadbeefcafe');

  it('returns three base64url segments', () => {
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('header is HS256 with the kid from the key id', () => {
    const header = decode(jwt.split('.')[0]);
    expect(header).toMatchObject({ alg: 'HS256', typ: 'JWT', kid: '64ef…id' });
  });

  it('payload targets /admin/ with a 5-minute expiry', () => {
    const payload = decode(jwt.split('.')[1]);
    expect(payload.aud).toBe('/admin/');
    expect(payload.exp - payload.iat).toBe(300);
  });
});
