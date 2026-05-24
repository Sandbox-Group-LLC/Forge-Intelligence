import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { resolveTenant } from '../../middleware/tenant';
import { notImplemented } from '../../lib/respond';

// Layer 3 (data) — Unified Event Record / golden record. Event → Sessions →
// Contacts ↔ Accounts with identity resolution and lifecycle stages.
const router = Router();
router.use(requireAuth, resolveTenant);

router.get('/contacts', (_req, res) =>
  notImplemented(res, { phase: 'Phase 2', portFrom: 'CDP golden-record pattern (see record/identity.ts)' }),
);
router.get('/accounts', (_req, res) => notImplemented(res, { phase: 'Phase 2' }));
router.get('/events/:eventId/timeline', (_req, res) =>
  notImplemented(res, { phase: 'Phase 2', note: 'lifecycle: registered → checked_in → session_attended → lead_scanned → opportunity' }),
);

export default router;
