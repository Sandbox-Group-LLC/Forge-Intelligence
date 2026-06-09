import { describe, it, expect } from 'vitest';
import { buildBrand } from '../src/server/video.js';

describe('buildBrand (visual injector)', () => {
  it('uses a measured hex from brandVisual', () => {
    const b = buildBrand('Acme', { brandVisual: { accentColor: '#16A34A' } });
    expect(b.colors.accent).toBe('#16a34a');
    expect(b.colors.accent2).toMatch(/^#[0-9a-f]{6}$/); // derived lighter shade
    expect(b.colors.accent2).not.toBe('#16a34a');
  });

  it('prefers brandVisual.accentColor over voiceProfile.accentColor', () => {
    const b = buildBrand('Acme', {
      brandVisual: { accentColor: '#ff0000' },
      voiceProfile: { accentColor: '#0000ff' },
    });
    expect(b.colors.accent).toBe('#ff0000');
  });

  it('falls back to voiceProfile.accentColor when brandVisual is absent', () => {
    const b = buildBrand('Acme', { voiceProfile: { accentColor: '#123ABC' } });
    expect(b.colors.accent).toBe('#123abc');
  });

  it('ignores descriptor (non-hex) accent colors — no color override', () => {
    const b = buildBrand('Acme', { voiceProfile: { accentColor: 'deep indigo' } });
    expect(b.colors).toBeUndefined();
  });

  it('expands 3-digit hex', () => {
    const b = buildBrand('Acme', { brandVisual: { accentColor: '#0a0' } });
    expect(b.colors.accent).toBe('#00aa00');
  });

  it('takes logo from brandVisual, then the logo_url column, http(s) only', () => {
    expect(buildBrand('Acme', { brandVisual: { logoUrl: 'https://x/l.png' } }).logo).toBe('https://x/l.png');
    expect(buildBrand('Acme', {}, 'https://cdn/logo.svg').logo).toBe('https://cdn/logo.svg');
    expect(buildBrand('Acme', {}, '/relative/logo.png').logo).toBeUndefined();
  });

  it('always sets the name and never throws on empty profile', () => {
    expect(buildBrand('Forge Intelligence', null, null)).toEqual({ name: 'Forge Intelligence' });
  });
});
