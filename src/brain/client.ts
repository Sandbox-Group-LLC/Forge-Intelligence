import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config();

const sql = neon(process.env.NEON_DATABASE_URL!);

export { sql };

export async function queryBrain(
  clientId: string,
  table: 'memories' | 'patterns' | 'mistakes' | 'agent_coordination',
  filter?: Record<string, unknown>
) {
  const rows = await sql(
    `SELECT * FROM ${table} WHERE client_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [clientId]
  );
  return rows;
}

export async function writeToBrain(
  table: string,
  payload: Record<string, unknown>
) {
  const keys = Object.keys(payload);
  const values = Object.values(payload);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const cols = keys.join(', ');

  const result = await sql(
    `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  return result[0];
}
