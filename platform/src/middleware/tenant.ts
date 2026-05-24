import { Request, Response, NextFunction } from 'express';
import { badRequest } from '../lib/errors';

// Resolves the active tenant (organization) for the request. MVP trusts the
// Clerk org claim, falling back to an x-org-id header for service calls.
// TODO(phase-0): validate the user's membership against the memberships table.
export function resolveTenant(req: Request, _res: Response, next: NextFunction) {
  const orgId = req.auth?.orgId ?? (req.headers['x-org-id'] as string | undefined);
  if (!orgId) return next(badRequest('No organization context'));
  req.tenant = { organizationId: orgId };
  next();
}
