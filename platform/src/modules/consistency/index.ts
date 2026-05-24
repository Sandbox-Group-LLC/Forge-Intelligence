import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { resolveTenant } from '../../middleware/tenant';
import { notImplemented } from '../../lib/respond';

// The Consistency Engine ("forensic AI"). Compares cross-tool reality against
// the North-Star and emits drift signals across five dimensions: kpi, voice,
// audience, content, context. Human-in-the-loop review. Port: Forge Compliance
// Gate (/api/compliance/critique) + decay_alerts + Brain-First Protocol.
// Model routing: Opus (deep) / Sonnet (reason) / Haiku (fast) — see lib/claude.
const router = Router();
router.use(requireAuth, resolveTenant);

router.get('/events/:eventId/signals', (_req, res) =>
  notImplemented(res, { phase: 'Phase 3', portFrom: 'Forge decay_alerts + Compliance Gate' }),
);
router.post('/events/:eventId/scan', (_req, res) =>
  notImplemented(res, { phase: 'Phase 3', portFrom: 'Forge /api/compliance/critique', note: 'runs the forensic consistency scan' }),
);

export default router;
