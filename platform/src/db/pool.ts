import { Pool } from 'pg';
import { env, hasDb } from '../config/env';
import { logger } from '../lib/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!hasDb) throw new Error('DATABASE_URL not configured');
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
    pool.on('error', (err) => logger.error('pg pool error', { error: String(err) }));
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query(text, params as unknown[]);
  return res.rows as T[];
}

export async function pingDb(): Promise<boolean> {
  if (!hasDb) return false;
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
