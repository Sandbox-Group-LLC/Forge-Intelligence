// Shared Neon Postgres connection pool — the single source of truth for the DB
// handle. Imported by server.js today; as the server.js decomposition proceeds,
// every extracted route module imports `pool` from here instead of receiving it
// as a parameter.
//
// ARCHITECTURE RULE: NEON_DATABASE_URL must stay on the
// ep-odd-waterfall-akyrdo6x-pooler endpoint — never revert to ep-cool-firefly.
import pkg from 'pg';

const { Pool } = pkg;

export const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
