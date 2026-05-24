import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { resolveTenant } from '../../middleware/tenant';
import { notImplemented } from '../../lib/respond';

// Layer 1 — Pre-event intelligence / North-Star. The source of truth (goals,
// KPIs, target ICP, brand voice, themes) every other layer is measured
// against. Port: Forge voice_profile + settings.factualGround + Territory
// injection + Brain-First Protocol.
const router = Router();
router.use(requireAuth, resolveTenant);

router.get('/events/:eventId', (_req, res) =>
  notImplemented(res, { phase: 'Phase 1', portFrom: 'Forge brand_profiles.voice_profile / factualGround' }),
);
router.put('/events/:eventId', (_req, res) =>
  notImplemented(res, { phase: 'Phase 1', portFrom: 'Forge Context Hub Stage 1', note: 'North-Star wizard + light audience/account enrichment' }),
);

export default router;
