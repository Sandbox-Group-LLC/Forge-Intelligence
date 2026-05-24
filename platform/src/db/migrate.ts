import fs from 'node:fs';
import path from 'node:path';
import { getPool } from './pool';
import { hasDb } from '../config/env';
import { logger } from '../lib/logger';

// Minimal forward-only migration runner: applies every *.sql in migrations/
// in lexical order, tracked in a _migrations table. Each file runs in a tx.
async function migrate() {
  if (!hasDb) {
    logger.error('DATABASE_URL not set — cannot migrate');
    process.exit(1);
  }
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pool = getPool();
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())');

  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM _migrations WHERE id = $1', [file]);
    if (applied.rowCount) {
      logger.info('skip migration', { file });
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    logger.info('applying migration', { file });
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (id) VALUES ($1)', [file]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      logger.error('migration failed', { file, error: String(e) });
      process.exit(1);
    }
  }
  logger.info('migrations complete');
  await pool.end();
}

migrate();
