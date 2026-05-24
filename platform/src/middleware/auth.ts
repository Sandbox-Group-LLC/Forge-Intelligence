import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { env, hasClerk } from '../config/env';
import { unauthorized } from '../lib/errors';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!hasClerk) throw unauthorized('Auth not configured (CLERK_JWKS_URL missing)');
  if (!jwks) jwks = createRemoteJWKSet(new URL(env.CLERK_JWKS_URL as string));
  return jwks;
}

async function verify(token: string): Promise<JWTPayload> {
  const opts = env.CLERK_ISSUER ? { issuer: env.CLERK_ISSUER } : undefined;
  const { payload } = await jwtVerify(token, getJwks(), opts);
  return payload;
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

function claims(payload: JWTPayload) {
  const p = payload as JWTPayload & { org_id?: string; org_role?: string; role?: string };
  return { userId: String(payload.sub), orgId: p.org_id, role: p.org_role ?? p.role };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    if (!token) throw unauthorized('Missing bearer token');
    req.auth = claims(await verify(token));
    next();
  } catch (e) {
    next(e);
  }
}

// Optional auth: attaches identity if a valid token is present, never blocks.
export async function softAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    if (token && hasClerk) req.auth = claims(await verify(token));
  } catch {
    /* ignore — soft */
  }
  next();
}
