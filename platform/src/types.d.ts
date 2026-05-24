import 'express';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; orgId?: string; role?: string };
      tenant?: { organizationId: string };
    }
  }
}

export {};
