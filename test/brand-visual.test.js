import { describe, it, expect, vi } from 'vitest';
import {
  nearHex,
  dedupePalette,
  hexChroma,
  refinePaletteRoles,
  pickBrandAccent,
  pickFontFamily,
  isJunkLogoUrl,
  guessImageFormat,
  buildBrandVisualPayload,
  parseFontFaceBlocks,
  classifyFontRole,
  verifyFontMagicBytes,
  enrichFontFaces,
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

describe('hexChroma / refinePaletteRoles / pickBrandAccent (Adyen greyscale trap)', () => {
  // Real first brandVisual/2 shape: slate won accent, brand green buried as neutral.
  const ADYEN_BAD = [
    { hex: '#001222', role: 'primary', source: 'css-var' },
    { hex: '#ffffff', role: 'background', source: 'computed' },
    { hex: '#5c6874', role: 'accent', source: 'css-var' },
    { hex: '#ecedef', role: 'neutral', source: 'css-var' },
    { hex: '#d1d5d8', role: 'neutral', source: 'css-var' },
    { hex: '#8c959d', role: 'neutral', source: 'css-var' },
    { hex: '#2f3e4d', role: 'neutral', source: 'css-var' },
    { hex: '#00d16a', role: 'neutral', source: 'css-var' },
  ];

  it('reports low chroma on slate and high on brand green', () => {
    expect(hexChroma('#5c6874')).toBeLessThan(0.18);
    expect(hexChroma('#00d16a')).toBeGreaterThan(0.35);
    // Near-black ink must NOT look "saturated" via chroma (HSL-S trap)
    expect(hexChroma('#001222')).toBeLessThan(0.2);
  });

  it('promotes mis-tagged vivid green to accent and demotes grey accent', () => {
    const fixed = refinePaletteRoles(ADYEN_BAD);
    const green = fixed.find((p) => p.hex === '#00d16a');
    const slate = fixed.find((p) => p.hex === '#5c6874');
    expect(green.role).toBe('accent');
    expect(slate.role).toBe('neutral');
  });

  it('pickBrandAccent chooses green over grey CTA/heuristic', () => {
    const fixed = refinePaletteRoles(ADYEN_BAD);
    expect(pickBrandAccent(fixed, '#5c6874')).toBe('#00d16a');
    expect(pickBrandAccent(fixed, null)).toBe('#00d16a');
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

describe('parseFontFaceBlocks / roles / magic', () => {
  const ADYEN_CSS = `
@font-face{font-display:swap;font-family:Adyen;font-weight:400 700;src:url(./Adyen-Variable.s-8vvc6Q.woff2) format("woff2-variations")}
@font-face{font-display:swap;font-family:AdyenTPJ;font-weight:400;src:url(./AdyenTPJ-Regular.Btmc2TWI.woff2) format("woff2")}
@font-face{font-display:swap;font-family:AdyenTPJ;font-weight:700;src:url(./AdyenTPJ-Bold.DloV__Yc.woff2) format("woff2")}
@font-face{font-display:swap;font-family:AdyenSC;font-weight:400;src:url(./Adyen-SC-Regular.C4bdbWJk.woff2) format("woff2")}
@font-face{font-display:swap;font-family:AdyenSC;font-weight:700;src:url(./Adyen-SC-Bold.BkVbOu0-.woff2) format("woff2")}
@font-face{font-display:swap;font-family:AdyenMono;font-weight:400 700;src:url(./Adyen-Mono-Variable.BG3e1ATU.woff2) format("woff2-variations")}
`;

  it('parses adyen-style @font-face blocks with absolute urls + variable weights', () => {
    const faces = parseFontFaceBlocks(ADYEN_CSS, 'https://www.adyen.com/main_nuxt/entry.css');
    expect(faces).toHaveLength(6);
    const primary = faces.find((f) => f.family === 'Adyen');
    expect(primary.weightRange).toBe('400 700');
    expect(primary.isVariable).toBe(true);
    expect(primary.formatHint).toMatch(/woff2/i);
    expect(primary.url).toBe('https://www.adyen.com/main_nuxt/Adyen-Variable.s-8vvc6Q.woff2');
    expect(faces.filter((f) => f.family === 'AdyenSC')).toHaveLength(2);
    expect(faces.filter((f) => f.family === 'AdyenTPJ')).toHaveLength(2);
    expect(faces.find((f) => f.family === 'AdyenMono').isVariable).toBe(true);
  });

  it('skips data: urls and non-font assets', () => {
    const css = `
      @font-face { font-family: X; src: url(data:font/woff2;base64,AA) format("woff2"); }
      @font-face { font-family: Y; src: url(./icon.svg); }
      @font-face { font-family: "Real"; font-weight: 400; src: url(https://cdn.example/r.woff2) format("woff2"); }
    `;
    const faces = parseFontFaceBlocks(css, 'https://example.com/');
    expect(faces).toHaveLength(1);
    expect(faces[0].family).toBe('Real');
  });

  it('classifies primary / mono / cjk-subset roles (never primary on huge CJK)', () => {
    expect(classifyFontRole(
      { family: 'Adyen', bytes: 80_000 },
      { headingFont: 'Adyen', bodyFont: 'Adyen' },
    )).toBe('primary');
    expect(classifyFontRole(
      { family: 'AdyenMono', bytes: 40_000 },
      { headingFont: 'Adyen', monoFont: 'AdyenMono' },
    )).toBe('mono');
    expect(classifyFontRole(
      { family: 'AdyenSC', bytes: 4_400_000 },
      { headingFont: 'Adyen', bodyFont: 'Adyen' },
    )).toBe('cjk-subset');
    // Huge file without CJK name still treated as subset — never brand primary
    expect(classifyFontRole(
      { family: 'BrandFace', bytes: 3_000_000 },
      { headingFont: 'BrandFace' },
    )).toBe('cjk-subset');
  });

  it('verifies wOFF2 / wOFF / OTTO / sfnt magic and rejects HTML', () => {
    expect(verifyFontMagicBytes(Buffer.from('wOF2....'))).toBe(true);
    expect(verifyFontMagicBytes(Buffer.from('wOFF....'))).toBe(true);
    expect(verifyFontMagicBytes(Buffer.from('OTTO....'))).toBe(true);
    const ttf = Buffer.alloc(4); ttf.writeUInt32BE(0x00010000, 0);
    expect(verifyFontMagicBytes(ttf)).toBe(true);
    expect(verifyFontMagicBytes(Buffer.from('<!DOCTYPE html>'))).toBe(false);
    expect(verifyFontMagicBytes(Buffer.from(''))).toBe(false);
  });

  it('enrichFontFaces probes metadata only (no binary payload fields)', async () => {
    const faces = parseFontFaceBlocks(
      '@font-face{font-family:Adyen;font-weight:400 700;src:url(https://cdn.example/Adyen.woff2) format("woff2-variations")}',
      'https://cdn.example/',
    );
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 206,
      headers: {
        get: (k) => {
          if (k === 'content-range') return 'bytes 0-15/81234';
          if (k === 'content-length') return '16';
          return null;
        },
      },
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true };
              done = true;
              return { done: false, value: Buffer.from('wOF2xxxxxxxxxxxx') };
            },
            cancel: async () => {},
          };
        },
      },
    }));
    const out = await enrichFontFaces(faces, {
      headingFont: 'Adyen',
      bodyFont: 'Adyen',
      fetchImpl,
      includeFontBinaries: true, // must still NOT attach binary data
    });
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe('Adyen');
    expect(out[0].bytes).toBe(81234);
    expect(out[0].verifiedMagicBytes).toBe(true);
    expect(out[0].role).toBe('primary');
    expect(out[0].isVariable).toBe(true);
    expect(out[0].data).toBeUndefined();
    expect(out[0].base64).toBeUndefined();
    expect(out[0].buffer).toBeUndefined();
  });
});

describe('buildBrandVisualPayload', () => {
  it('keeps legacy keys and layers additive fields including fonts[]', () => {
    const payload = buildBrandVisualPayload({
      success: true,
      accentColor: '#0abf53',
      bgColor: '#ffffff',
      logoUrl: 'https://x/logo.svg',
      palette: [{ hex: '#0abf53', role: 'primary', source: 'css-var' }],
      typography: { headingFont: 'Adyen', bodyFont: 'Adyen', source: 'font-face' },
      fonts: [{
        family: 'Adyen',
        weightRange: '400 700',
        formatHint: 'woff2-variations',
        url: 'https://www.adyen.com/main_nuxt/Adyen-Variable.woff2',
        bytes: 81234,
        isVariable: true,
        role: 'primary',
        verifiedMagicBytes: true,
      }],
      logo: { primaryUrl: 'https://x/logo.svg', format: 'svg', iconUrl: 'https://x/favicon.ico' },
      buttonStyle: { radiusPx: 8, style: 'filled' },
      imageryStyle: { style: 'photography', treatment: 'Hero photos dominate.' },
      scrapeVersion: BRAND_VISUAL_SCRAPE_VERSION,
    }, { capturedAt: '2026-08-14T00:00:00.000Z' });

    expect(payload.accentColor).toBe('#0abf53');
    expect(payload.bgColor).toBe('#ffffff');
    expect(payload.logoUrl).toBe('https://x/logo.svg');
    expect(payload.scrapeVersion).toBe('brandVisual/3');
    expect(payload.palette).toHaveLength(1);
    expect(payload.typography.headingFont).toBe('Adyen');
    expect(payload.fonts).toHaveLength(1);
    expect(payload.fonts[0].role).toBe('primary');
    expect(payload.fonts[0].verifiedMagicBytes).toBe(true);
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
    expect(payload.fonts).toBeUndefined();
    expect(payload.logo).toBeUndefined();
    expect(payload.buttonStyle).toBeUndefined();
    expect(payload.imageryStyle).toBeUndefined();
    expect(payload.scrapeVersion).toBe('brandVisual/3');
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
