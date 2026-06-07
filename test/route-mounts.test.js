import { describe, it, expect } from 'vitest';
import { resolveRoutes, joinPath, parseImports, parseMounts } from './route-inventory.mjs';

describe('joinPath', () => {
  it('joins prefix + sub and collapses slashes', () => {
    expect(joinPath('/api/x', '/sub')).toBe('/api/x/sub');
    expect(joinPath('/api/x', '/')).toBe('/api/x');      // index route -> the prefix itself
    expect(joinPath('/api/x/', '/sub')).toBe('/api/x/sub');
    expect(joinPath('/', '/')).toBe('/');
  });
});

describe('parseImports / parseMounts', () => {
  it('maps default + named imports to module paths', () => {
    const m = parseImports(`
      import compliance from './src/server/routes/compliance.js';
      import { zernio as zRouter, other } from './src/server/routes/zernio.js';
    `);
    expect(m.compliance).toBe('./src/server/routes/compliance.js');
    expect(m.zRouter).toBe('./src/server/routes/zernio.js');
    expect(m.other).toBe('./src/server/routes/zernio.js');
  });

  it('captures the router identifier even with middleware in front', () => {
    expect(parseMounts(`app.use('/api/compliance', requireAuth, compliance);`))
      .toEqual([{ prefix: '/api/compliance', ident: 'compliance' }]);
  });

  it('parses the combined `import Default, { Named } from` form (both sides)', () => {
    const m = parseImports(`import pubRouter, { runScheduledPublishes } from './src/server/routes/publishing-publish.js';`);
    expect(m.pubRouter).toBe('./src/server/routes/publishing-publish.js');         // default
    expect(m.runScheduledPublishes).toBe('./src/server/routes/publishing-publish.js'); // named
  });

  it('a combined-import router still resolves through resolveRoutes (regression for #260)', () => {
    const server = `
      import publishRouter, { runScheduledPublishes } from './src/server/routes/publishing-publish.js';
      app.use('/api/publishing', publishRouter);
      runScheduledPublishes();
    `;
    const router = `const router = express.Router(); router.post('/publish', h); router.post('/generate-post-copy', h);`;
    expect(resolveRoutes(server, () => router)).toEqual([
      'POST /api/publishing/generate-post-copy',
      'POST /api/publishing/publish',
    ]);
  });
});

describe('resolveRoutes — mount-prefix resolution', () => {
  it('prefixes a mounted router\'s sub-paths with its mount path', () => {
    const server = `
      import compliance from './src/server/routes/compliance.js';
      app.get('/health', (req, res) => {});
      app.use('/api/compliance', requireAuth, compliance);
    `;
    const router = `
      const router = express.Router();
      router.post('/approve', h);
      router.get('/find-sources', h);
      export default router;
    `;
    const out = resolveRoutes(server, (rel) => rel.endsWith('compliance.js') ? router : null);
    expect(out).toEqual([
      'GET /api/compliance/find-sources',
      'GET /health',
      'POST /api/compliance/approve',
    ]);
  });

  it('honors a non-default router variable name', () => {
    const server = `
      import { zRouter } from './src/server/routes/zernio.js';
      app.use('/api/zernio', zRouter);
    `;
    const router = `const zernioRtr = express.Router(); zernioRtr.get('/status', h);`;
    expect(resolveRoutes(server, () => router)).toEqual(['GET /api/zernio/status']);
  });

  it('ignores path-mounts whose identifier is not an imported module', () => {
    // express.static / inline middleware must NOT be treated as routers.
    const server = `app.use('/assets', express.static('dist')); app.get('/x', h);`;
    expect(resolveRoutes(server, () => 'SHOULD_NOT_BE_READ')).toEqual(['GET /x']);
  });

  it('maps a router index route (/) to the bare prefix', () => {
    const server = `import api from './src/server/routes/api.js'; app.use('/api', api);`;
    const router = `const router = express.Router(); router.get('/', h);`;
    expect(resolveRoutes(server, () => router)).toEqual(['GET /api']);
  });
});
