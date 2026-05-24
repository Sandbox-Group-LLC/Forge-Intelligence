import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { resolveTenant } from '../../middleware/tenant';
import { notImplemented } from '../../lib/respond';

// Layer 7 — Sales Readiness & Handoff (the differentiator). Scores engagement
// across all connected tools, decides sales-readiness, and hands off enriched
// records to the CRM (HubSpot first). This is the market's weakest-served,
// highest-value link. Port: Forge analytics→pattern loop.
const router = Router();
router.use(requireAuth, resolveTenant);

router.get('/events/:eventId/scores', (_req, res) =>
  notImplemented(res, { phase: 'Phase 4', note: 'engagement-weighted readiness scoring (hot/warm/cold)' }),
);
router.post('/events/:eventId/handoff', (_req, res) =>
  notImplemented(res, { phase: 'Phase 4', portFrom: 'Forge CRM sync', note: 'push sales-ready contacts to HubSpot/Salesforce/Attio' }),
);

export default router;
