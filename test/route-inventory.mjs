// Route-inventory helper for the decomposition safety net.
//
// Statically scans the backend source for Express route registrations and
// returns a sorted `"METHOD /path"` list. No app boot, no DB, no env — pure
// text scan, so it runs anywhere (CI, local, this harness).
//
// As server.js is decomposed into src/server/*.js route modules, ADD each new
// module to BACKEND_FILES. If a module is mounted under a prefix via
// app.use('/prefix', factory(...)), extend collectRoutes() to prepend that
// prefix so the full path stays identical across the move. Keeping the snapshot
// green is the contract: an extraction must not add, drop, or rename a route.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const BACKEND_FILES = ['server.js'];

export const ROUTE_RE = /\b(?:app|router)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2/g;

export function collectRoutes() {
  const routes = [];
  for (const rel of BACKEND_FILES) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(ROUTE_RE)) {
      routes.push(`${m[1].toUpperCase()} ${m[3]}`);
    }
  }
  return routes.sort();
}
