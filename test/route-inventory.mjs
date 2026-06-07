// Route-inventory helper for the decomposition safety net.
//
// Statically scans the backend for Express route registrations and returns a
// sorted `"METHOD /path"` list. No app boot, no DB, no env — pure text scan, so
// it runs anywhere (CI, local, this harness).
//
// MOUNT-PREFIX RESOLUTION (added for the route-group phase): as route handlers
// move out of server.js into router modules mounted via
// `app.use('/prefix', router)`, a router's `router.get('/sub')` must still show
// up in the inventory as `GET /prefix/sub` — not `GET /sub` — so the snapshot
// stays byte-identical across the move. collectRoutes() therefore:
//   1. emits every top-level `app.<method>(...)` in server.js as-is, then
//   2. finds each `app.use('<prefix>', <ident>)` whose <ident> is a default/
//      named import of a local module, reads that module, and emits its
//      `<routerVar>.<method>('<sub>')` registrations as `<prefix><sub>`.
// Until the first router exists this is a no-op (server.js has no path-mounts),
// so today's output is unchanged.
//
// Keeping the snapshot green is the contract: a pure move (helper OR route) must
// not add, drop, or rename a route. After an INTENTIONAL route change, run
// `npm run routes:snapshot` and commit the diff.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const METHODS = 'get|post|put|patch|delete|all';

// Match `<obj>.<method>('<path>'` for the given object identifiers.
function routesFor(src, objectNames) {
  const names = objectNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\b(?:${names})\\.(${METHODS})\\(\\s*(['"\`])([^'"\`]+)\\2`, 'g');
  const out = [];
  for (const m of src.matchAll(re)) out.push({ method: m[1].toUpperCase(), path: m[3] });
  return out;
}

// Join a mount prefix and a sub-path into one normalized path:
// ('/api/x', '/sub') -> '/api/x/sub', ('/api/x', '/') -> '/api/x', collapse '//'.
export function joinPath(prefix, sub) {
  const joined = `${prefix}${sub}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

// Map imported identifiers -> their relative module path.
// Handles `import X from './a.js'` and `import { X, Y as Z } from './b.js'`.
export function parseImports(src) {
  const map = {};
  // Default import — also handles the combined `import X, { … } from '…'` form
  // (the optional `, { … }` is consumed so X is still captured).
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s+['"](\.[^'"]+)['"]/g)) map[m[1]] = m[2];
  // Named imports — optional leading `Default,` before the brace (combined form).
  for (const m of src.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s+['"](\.[^'"]+)['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) map[name] = m[2];
    }
  }
  return map;
}

// Find `app.use('<prefix>', [middleware, ...] <ident>)` mounts. Captures the
// LAST bare identifier in the arg list (the router; any middleware precede it).
export function parseMounts(src) {
  const mounts = [];
  for (const m of src.matchAll(/app\.use\(\s*(['"`])([^'"`]+)\1\s*,\s*([^)]*)\)/g)) {
    const prefix = m[2];
    const idents = (m[3].match(/[A-Za-z_$][\w$]*/g) || []);
    const last = idents[idents.length - 1];
    if (last) mounts.push({ prefix, ident: last });
  }
  return mounts;
}

// The router variable name in a module (`const router = express.Router()`),
// defaulting to 'router'.
function routerVar(src) {
  const m = src.match(/(?:const|let|var)\s+(\w+)\s*=\s*express\.Router\(\)/);
  return m ? m[1] : 'router';
}

// Pure core: compute the sorted route inventory from in-memory sources.
// `readModule(relPath)` returns a module's source (or null if unreadable).
// Exported so tests can exercise mount-prefixing without touching the repo.
export function resolveRoutes(serverSrc, readModule) {
  const routes = [];
  // 1. top-level routes registered directly on the app
  for (const r of routesFor(serverSrc, ['app'])) routes.push(`${r.method} ${r.path}`);
  // 2. mounted routers -> prefix each sub-path
  const imports = parseImports(serverSrc);
  for (const { prefix, ident } of parseMounts(serverSrc)) {
    const relPath = imports[ident];
    if (!relPath) continue;                 // not an imported module (inline middleware, etc.)
    const routerSrc = readModule(relPath);
    if (!routerSrc) continue;               // unreadable / not a real file — skip
    const rv = routerVar(routerSrc);
    for (const r of routesFor(routerSrc, [rv])) routes.push(`${r.method} ${joinPath(prefix, r.path)}`);
  }
  return routes.sort();
}

export function collectRoutes() {
  const serverSrc = readFileSync(join(ROOT, 'server.js'), 'utf8');
  return resolveRoutes(serverSrc, (rel) => {
    try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; }
  });
}
