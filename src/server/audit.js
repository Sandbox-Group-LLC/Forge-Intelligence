// Audit log — the security / GDPR evidence trail (issue #25 substrate).
//
// Records privileged + PII-touching actions: admin relay queries, brand
// mutations, data exports, and — as they land — DSAR export/delete. Surfaced
// read-only at Settings → Audit Log (super-admin only).
//
// recordAudit() is BEST-EFFORT: it never throws and never blocks the request it
// is logging, the same discipline as raiseAnomaly / `void notifyX(...)`. A
// logging outage must never break the action being logged.
//
// The table IS the evidence, so it is NEVER auto-purged — the boot-time
// orphan-data purge that hits brain tables must not touch audit_log. If a
// retention cap is ever wanted it is a deliberate, years-scale, separate job.
import { pool } from './db.js';

let ensured = false;

export async function ensureAuditLogTable() {
  if (ensured) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_clerk_user_id TEXT,         -- JWT sub; null for password-gated/system actions
      actor_email TEXT,                 -- best-effort label (no users table in Forge)
      action TEXT NOT NULL,             -- e.g. 'relay.query', 'brand.reset_paid', 'audit_log.export'
      target_type TEXT,                 -- 'brand' | 'relay' | 'audit_log' | ...
      target_id TEXT,                   -- plain text, no FK (survives target deletion)
      brand_profile_id TEXT,            -- scope when brand-specific; null = platform-level
      summary TEXT,                     -- human-readable one-liner for the UI row
      metadata JSONB DEFAULT '{}',
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_clerk_user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_brand   ON audit_log(brand_profile_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action, created_at DESC)`);
    ensured = true;
  } catch (e) { console.error('[AUDIT] table init:', e.message); }
}
ensureAuditLogTable();

// Record one audit event. Pass `req` for actor/ip/user-agent capture; pass an
// explicit `actorLabel` for password-gated routes that carry no JWT actor.
export async function recordAudit({ req = null, actorLabel = null, action, targetType = null, targetId = null, brandProfileId = null, summary = null, metadata = {} }) {
  try {
    if (!ensured) await ensureAuditLogTable();
    const ip = req ? (req.headers?.['x-forwarded-for'] || req.ip || null) : null;
    const ua = req ? (req.headers?.['user-agent'] || null) : null;
    await pool.query(
      `INSERT INTO audit_log (actor_clerk_user_id, actor_email, action, target_type, target_id, brand_profile_id, summary, metadata, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req?.userId || null, actorLabel || null, action, targetType, targetId, brandProfileId, summary, JSON.stringify(metadata || {}), ip, ua]
    );
  } catch (e) { console.error('[AUDIT] write:', e.message); }
}
