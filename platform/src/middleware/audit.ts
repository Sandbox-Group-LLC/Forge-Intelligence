import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';
import { hasDb } from '../config/env';
import { query } from '../db/pool';

// Lightweight access log on every request.
export function requestAudit(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
}

// Persist a security-relevant action to audit_log (best-effort; never throws
// into the request path).
export async function audit(req: Request, action: string, meta: Record<string, unknown> = {}) {
  if (!hasDb) return;
  try {
    await query(
      'INSERT INTO audit_log (organization_id, actor_user_id, action, metadata) VALUES ($1, $2, $3, $4)',
      [req.tenant?.organizationId ?? null, req.auth?.userId ?? null, action, JSON.stringify(meta)],
    );
  } catch (e) {
    logger.error('audit insert failed', { error: String(e), action });
  }
}
