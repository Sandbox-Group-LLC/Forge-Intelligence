import { describe, it, expect } from 'vitest';
import {
  nearHex,
  dedupePalette,
  pickFontFamily,
  isJunkLogoUrl,
  guessImageFormat,
  buildBrandVisualPayload,
  BRAND_VISUAL_SCRAPE_VERSION,
} from '../src/server/scrape.js';

describe('nearHex / dedupePalette', () => {
  it('treats near-identical hexes as the same', () => {
    expect(nearHex('#ff0000', '#fe0100')).toBe(true);
    expect(nearHex('#ff0000', '#00ff00')).toBe(false);
  });

  it('dedupes and keeps higher-weight role/source', () => {
    const out = dedupePalette([
      { hex: '#112233', role: 'secondary', source: 'computed', weight: 1 },
      { hex: '#122334', role: 'primary', source: 'css-var', weight: 5 },
      { hex: '#abcdef', role: 'accent', source: 'computed', weight: 2 },
    ], 8);
    expect(out.length).toBe(2);
    expect(out[0].hex).toBe('#122334');
    expect(out[0].role).toBe('primary');
    expect(out[0].source).toBe('css-var');
  });
});

describe('pickFontFamily', () => {
  it('returns the first real family, not generics', () => {
    expect(pickFontFamily('"Intel One Display", "Helvetica Neue", sans-serif')).toBe('Intel One Display');
    expect(pickFontFamily('sans-serif')).toBe(null);
    expect(pickFontFamily('-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')).toBe('Segoe UI');
  });
});

describe('logo helpers', () => {
  it('flags consent-manager / junk assets', () => {
    expect(isJunkLogoUrl('https://cdn.cookiebot.com/logo.png')).toBe(true);
    expect(isJunkLogoUrl('https://cdn.cookielaw.org/logos/foo.png')).toBe(true);
    expect(isJunkLogoUrl('https://www.adyen.com/assets/logo.svg')).toBe(false);
    expect(isJunkLogoUrl('data:image/png;base64,abc')).toBe(true);
    expect(isJunkLogoUrl('data:image/svg+xml;base64,abc')).toBe(false);
  });

  it('guesses format from URL', () => {
    expect(guessImageFormat('https://x/a.SVG?v=1')).toBe('svg');
    expect(guessImageFormat('https://x/a.png')).toBe('png');
    expect(guessImageFormat('https://x/a')).toBe(null);
  });
});

describe('buildBrandVisualPayload', () => {
  it('keeps legacy keys and layers additive fields', () => {
    const payload = buildBrandVisualPayload({
      success: true,
      accentColor: '#0abf53',
      bgColor: '#ffffff',
      logoUrl: 'https://x/logo.svg',
      palette: [{ hex: '#0abf53', role: 'primary', source: 'css-var' }],
      typography: { headingFont: 'Adyen Sans', bodyFont: 'Adyen Text', source: 'computed' },
      logo: { primaryUrl: 'https://x/logo.svg', format: 'svg', iconUrl: 'https://x/favicon.ico' },
      buttonStyle: { radiusPx: 8, style: 'filled' },
      imageryStyle: { style: 'photography', treatment: 'Hero photos dominate.' },
      scrapeVersion: BRAND_VISUAL_SCRAPE_VERSION,
    }, { capturedAt: '2026-08-14T00:00:00.000Z' });

    expect(payload.accentColor).toBe('#0abf53');
    expect(payload.bgColor).toBe('#ffffff');
    expect(payload.logoUrl).toBe('https://x/logo.svg');
    expect(payload.scrapeVersion).toBe('brandVisual/2');
    expect(payload.palette).toHaveLength(1);
    expect(payload.typography.headingFont).toBe('Adyen Sans');
    expect(payload.logo.format).toBe('svg');
    expect(payload.buttonStyle.style).toBe('filled');
    expect(payload.imageryStyle.style).toBe('photography');
    expect(payload.capturedAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('omits undetectable additive keys (no hallucination)', () => {
    const payload = buildBrandVisualPayload({
      success: true,
      accentColor: '#0000ff',
      bgColor: null,
      logoUrl: null,
    });
    expect(payload.accentColor).toBe('#0000ff');
    expect(payload.palette).toBeUndefined();
    expect(payload.typography).toBeUndefined();
    expect(payload.logo).toBeUndefined();
    expect(payload.buttonStyle).toBeUndefined();
    expect(payload.imageryStyle).toBeUndefined();
    expect(payload.scrapeVersion).toBe('brandVisual/2');
  });

  it('returns null for failed capture', () => {
    expect(buildBrandVisualPayload({ success: false })).toBe(null);
  });

  it('old-shape brandVisual still readable by buildBrand (legacy keys only)', async () => {
    const { buildBrand } = await import('../src/server/video.js');
    const old = { brandVisual: { accentColor: '#16A34A', bgColor: '#ffffff', logoUrl: 'https://x/l.png' } };
    const b = buildBrand('Acme', old);
    expect(b.colors.accent).toBe('#16a34a');
    expect(b.logo).toBe('https://x/l.png');
  });
});
