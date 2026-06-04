import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectRoutes } from './route-inventory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The safety net for the server.js decomposition. Routes are MOVED, never
// changed, during extraction — so the full "METHOD /path" inventory must stay
// byte-identical. This catches the only failure modes that matter in a refactor
// with no behavioral tests: a dropped route, a duplicate, or an accidental
// rename.
describe('route inventory guard', () => {
  it('matches the committed snapshot — no route added, dropped, or renamed', () => {
    const current = collectRoutes();
    const expected = JSON.parse(
      readFileSync(join(__dirname, 'routes.snapshot.json'), 'utf8')
    );

    const added = current.filter((r) => !expected.includes(r));
    const removed = expected.filter((r) => !current.includes(r));

    // If this fails during an INTENTIONAL route change, confirm the diff below
    // is what you meant, then run `npm run routes:snapshot` and commit it.
    expect({ added, removed }).toEqual({ added: [], removed: [] });

    // Length check catches duplicate-count drift the set comparison misses
    // (e.g. a route registered 3x collapsing to 1x).
    expect(current.length).toBe(expected.length);
  });
});
