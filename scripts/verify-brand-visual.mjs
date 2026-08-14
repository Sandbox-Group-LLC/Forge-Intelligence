import { captureBrandVisual, buildBrandVisualPayload } from '../src/server/scrape.js';
import { buildBrand } from '../src/server/video.js';

const domains = [
  'https://www.adyen.com',
  'https://www.hubspot.com',
  'https://www.intel.com',
];

const out = {};
for (const url of domains) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  console.error(`\n=== capturing ${host} ===`);
  const t0 = Date.now();
  try {
    const cap = await captureBrandVisual(url, {
      caller: 'verify-brand-visual',
      timeout: 45000,
      metadata: { verify: true },
    });
    const ms = Date.now() - t0;
    console.error(
      `done ${host} success=${cap.success} latency=${cap.latencyMs || ms}ms err=${cap.error || ''}`
    );
    if (!cap.success) {
      out[host] = { error: cap.error, latencyMs: ms };
      continue;
    }
    out[host] = buildBrandVisualPayload(cap);
    out[host]._latencyMs = cap.latencyMs || ms;
  } catch (e) {
    out[host] = { error: e.message };
  }
}

const oldShape = {
  brandVisual: {
    accentColor: '#16A34A',
    bgColor: '#ffffff',
    logoUrl: 'https://example.com/logo.png',
  },
};
out._legacyBuildBrand = buildBrand('LegacyCo', oldShape);

console.log(JSON.stringify(out, null, 2));
