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
        ...globals.node,
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
