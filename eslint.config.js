import globals from 'globals';

// Minimal lint gate for the server.js decomposition. The point is ONE rule:
// no-undef catches "X is not defined" — the exact failure mode of an extraction
// that forgets to import a moved symbol back. CI doesn't boot the app, so this
// is how that mistake gets caught at the PR gate instead of on deploy.
//
// Deliberately NOT the full eslint:recommended set — we don't want to surface
// pre-existing style/unused-var noise across a 20k-line file. Just no-undef.
export default [
  {
    files: ['server.js', 'src/server/**/*.js', 'test/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // nodeBuiltin (NOT node): the ESM-safe global set. It excludes the
        // CommonJS-only globals __dirname/__filename/require/module/exports,
        // which don't exist in ES modules (this codebase is "type":"module").
        // With plain globals.node, no-undef treats a bare __dirname as valid and
        // it blows up only at runtime — exactly the regression (#277) that shipped
        // when route groups were extracted into ESM modules. nodeBuiltin makes
        // no-undef flag it at the PR gate. Files that legitimately shim these
        // (server.js: `const __dirname = …`) are declarations, so they pass.
        ...globals.nodeBuiltin,
        // server.js runs browser code inside Puppeteer page.evaluate /
        // waitForFunction callbacks (forgeScrape). document/window are legit
        // there, so whitelist them rather than flag false positives.
        document: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
