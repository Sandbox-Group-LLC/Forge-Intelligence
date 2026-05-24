import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// All integration vars are optional so the app can boot for review/health
// without secrets. Helper booleans below gate features that actually need them.
const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().optional(),
  CLERK_JWKS_URL: z.string().url().optional(),
  CLERK_ISSUER: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  NANGO_SECRET_KEY: z.string().optional(),
  NANGO_HOST: z.string().default('https://api.nango.dev'),
  PIPEDREAM_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const hasDb = Boolean(env.DATABASE_URL);
export const hasClerk = Boolean(env.CLERK_JWKS_URL);
export const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
export const hasNango = Boolean(env.NANGO_SECRET_KEY);
