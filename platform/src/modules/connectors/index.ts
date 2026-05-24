import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { resolveTenant } from '../../middleware/tenant';
import { listProviders } from './registry';
import { nangoConfigured } from './nango';
import { notImplemented } from '../../lib/respond';

// Connector Fabric — BYO tools. Nango backbone for durable two-way syncs;
// Pipedream for long-tail automations.
const router = Router();

// List available providers (registry metadata only, no tenant data).
router.get('/', requireAuth, (_req, res) => {
  res.json({ nangoConfigured: nangoConfigured(), providers: listProviders() });
});

// Inbound webhook ingest (provider → unified record). Verified by the
// provider's own signature (HMAC), NOT Clerk auth — so it sits before the
// auth gate below. Port: Forge /api/webhooks/* + signature verification.
router.post('/:providerId/webhook', (_req, res) =>
  notImplemented(res, { phase: 'Phase 2', portFrom: 'Forge /api/webhooks/*', note: 'verified by provider signature, not Clerk auth' }),
);

router.use(requireAuth, resolveTenant);

// Begin a connect flow (Nango connect session).
router.post('/:providerId/connect', (_req, res) =>
  notImplemented(res, { phase: 'Phase 2', portFrom: 'Forge publishing_channels + OAuth setup' }),
);

export default router;
