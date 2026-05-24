import { Response } from 'express';

// Uniform placeholder for planned-but-unbuilt capabilities. Names the plan
// phase and the Forge pattern to port so the scaffold is self-documenting.
export function notImplemented(
  res: Response,
  info: { phase: string; portFrom?: string; note?: string },
) {
  res.status(501).json({
    error: 'not_implemented',
    message: 'Planned capability — not yet built.',
    ...info,
  });
}
