import { Request, Response, NextFunction } from 'express';
import { forbidden } from '../lib/errors';

// Role gate. Roles: 'owner' | 'admin' | 'member' | 'viewer'.
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.auth?.role;
    if (!role || !roles.includes(role)) {
      return next(forbidden(`Requires role: ${roles.join(' | ')}`));
    }
    next();
  };
}
