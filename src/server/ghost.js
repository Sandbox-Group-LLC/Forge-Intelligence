// Ghost CMS auth helper, extracted from server.js during the decomposition.
// buildGhostJWT mints a short-lived (5-min) HS256 admin JWT from a Ghost Admin
// API key ("keyId:hexSecret"), per Ghost's /admin/ token scheme. Used by the
// Ghost publish handler + analytics sync.
import { createHmac } from 'crypto';

export function buildGhostJWT(apiKey) {
  const [keyId, secret] = apiKey.split(':');
  const secretBytes = Buffer.from(secret, 'hex');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).toString('base64url');
  const sigInput = `${header}.${payload}`;
  const sig = createHmac('sha256', secretBytes).update(sigInput).digest('base64url');
  return `${sigInput}.${sig}`;
}
