import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

// Centralized error handler. Known AppErrors map to their status; everything
// else is a 500 with no internal detail leaked to the client.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  logger.error('unhandled error', { error: String(err) });
  return res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
}
