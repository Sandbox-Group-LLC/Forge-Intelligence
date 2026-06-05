// Authentication & authorization, extracted from server.js during the
// decomposition: Clerk JWT + Forge API-key middleware, brand-ownership checks,
// and the shared auth constants (clerkJWKS, SUPER_ADMIN_IDS) that the rest of
// server.js also reads.
import { pool } from './db.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'crypto';

export const CLERK_JWKS_URL = process.env.CLERK_JWKS_URL || 'https://clerk.forgeintelligence.ai/.well-known/jwks.json';
export const clerkJWKS = createRemoteJWKSet(new URL(CLERK_JWKS_URL));
// Super Admin user IDs (Clerk) — full access to all brands
export const SUPER_ADMIN_IDS = [
  'user_3BtC7nusm7CShN7EdUYaaLZcDwp', // brian@sandbox-xm.com
  'user_3CJmE0WkOj1RJC5yF99scEuwUpO', // brian — therosethyme
];

// ── Clerk Auth Middleware ─────────────────────────────────────────────────────

// Verify Clerk JWT and attach userId to req
// ── Brand ownership verification ─────────────────────────────────────────────
// Every authenticated endpoint that takes a brandProfileId MUST call this.
export async function verifyBrandAccess(brandProfileId, userId) {
  if (!brandProfileId || !userId) return false;
  if (SUPER_ADMIN_IDS.includes(userId)) return true;
  const r = await pool.query(
    'SELECT id FROM brand_profiles WHERE id = $1 AND clerk_user_id = $2',
    [brandProfileId, userId]
  );
  return r.rows.length > 0;
}


// ── Brand ownership verification ─────────────────────────────────────────────


// ── API key helpers ────────────────────────────────────────────────────
// Keys are SHA-256 hashed at rest. Plaintext format: `fik_<env>_<64-hex>`
// where env is 'live' or 'test'. ~256 bits of entropy — no brute-force risk,
// no need for bcrypt/argon2 (which exist for low-entropy human passwords).
export function hashApiKey(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex');
}

// Look up an api_keys row by the plaintext header value. Returns the row or null.
// Updates last_used_at/last_used_ip opportunistically (fire-and-forget).
export async function lookupApiKey(rawKey, clientIp) {
  if (!rawKey || typeof rawKey !== 'string' || rawKey.length < 20) return null;
  const keyHash = hashApiKey(rawKey.trim());
  try {
    const r = await pool.query(
      `SELECT id, label, brand_profile_ids, scopes, revoked_at FROM api_keys WHERE key_hash = $1 LIMIT 1`,
      [keyHash]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    if (row.revoked_at) return null;
    // Record usage without blocking the request
    pool.query(`UPDATE api_keys SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2`, [clientIp || null, row.id]).catch(() => {});
    return row;
  } catch(e) {
    console.error('[API-KEY] lookup error:', e.message);
    return null;
  }
}

export async function requireAuth(req, res, next) {
  try {
    // ── Path 1: API key via X-Api-Key header ──
    // Used by machine-to-machine integrations (Frank/ForgeOS, future CI jobs, etc.).
    // Scoped by brand_profile_ids + scopes; downstream handlers should enforce.
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const keyRow = await lookupApiKey(apiKey, req.ip || req.headers['x-forwarded-for']);
      if (!keyRow) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
      req.apiKeyAuth = {
        keyId: keyRow.id,
        label: keyRow.label,
        brandIds: keyRow.brand_profile_ids || [],
        scopes: keyRow.scopes || []
      };
      // userId stays unset — handlers check req.apiKeyAuth vs req.userId to distinguish
      return next();
    }

    // ── Path 2: Clerk JWT (unchanged) ──
    const authHeader = req.headers.authorization;
    const queryToken = req.query?.token;
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : queryToken;
    if (!rawToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = rawToken;
    if (!clerkJWKS) return res.status(500).json({ error: 'Auth not configured' });
    const { payload } = await jwtVerify(token, clerkJWKS, { algorithms: ['RS256'] });
    req.userId = payload.sub;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Scope guard for API-key-authenticated requests. If req.apiKeyAuth is set,
// verify (a) the key has the required scope and (b) the brandProfileId in
// the request body is in the key's allowed brand list. No-op for JWT auth
// (JWT auth already goes through verifyBrandAccess downstream).
export function requireApiKeyScope(scope) {
  return (req, res, next) => {
    if (!req.apiKeyAuth) return next();  // JWT path — skip, verifyBrandAccess handles it
    if (!req.apiKeyAuth.scopes.includes(scope)) {
      return res.status(403).json({ error: `API key missing required scope: ${scope}` });
    }
    const bodyBrandId = req.body?.brandProfileId || req.params?.brandProfileId;
    if (bodyBrandId && !req.apiKeyAuth.brandIds.includes(bodyBrandId)) {
      return res.status(403).json({ error: 'API key not authorized for this brand' });
    }
    next();
  };
}

// Soft auth — attaches userId if present, continues either way (for public + authed routes)
export async function softAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (clerkJWKS) {
        const { payload } = await jwtVerify(token, clerkJWKS, { algorithms: ['RS256'] });
        req.userId = payload.sub;
      }
    }
  } catch { /* no-op */ }
  next();
}

// MCP server at POST /mcp — JSON-RPC 2.0 transport for MCP clients (Viktor, Slack-Claude,
// future agentic tooling). Read-only by design. Auth: Forge api_keys (Bearer or X-Api-Key).
// Scopes: mcp:campaigns:read, mcp:emails:read.

export async function mcpAuth(req, res, next) {
  try {
    let key = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) key = authHeader.slice(7).trim();
    else if (req.headers['x-api-key']) key = String(req.headers['x-api-key']).trim();
    if (!key) return res.status(401).json({ error: 'Missing Authorization: Bearer <key> or X-Api-Key header' });
    const keyRow = await lookupApiKey(key, req.ip || req.headers['x-forwarded-for']);
    if (!keyRow) return res.status(401).json({ error: 'Invalid or revoked API key' });
    req.apiKeyAuth = {
      keyId: keyRow.id,
      label: keyRow.label,
      brandIds: keyRow.brand_profile_ids || [],
      scopes: keyRow.scopes || []
    };
    next();
  } catch(e) {
    console.error('[MCP auth]', e.message);
    res.status(500).json({ error: 'auth_internal_error' });
  }
}
