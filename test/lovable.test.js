import { describe, it, expect } from 'vitest';
import {
  LOVABLE_UUID_RE, LOVABLE_SUPPORTED_APP_TYPES,
  lovableSafeJoin, lovableHasData, lovableFormatVoice, lovableFormatPersonas,
  lovableFormatGeo, lovableBuildContentCommandCenter, lovableBuildWithDirective,
  lovableStubPrompt, lovableRecommendedAppName, lovableAppTypeDescription,
} from '../src/server/lovable.js';

describe('lovable helpers', () => {
  it('UUID regex accepts a valid uuid, rejects junk', () => {
    expect(LOVABLE_UUID_RE.test('cde5feeb-b3d7-4990-adee-a54977ab9c52')).toBe(true);
    expect(LOVABLE_UUID_RE.test('not-a-uuid')).toBe(false);
  });

  it('supported app types set is the v1 four', () => {
    expect(LOVABLE_SUPPORTED_APP_TYPES.has('content-command-center')).toBe(true);
    expect(LOVABLE_SUPPORTED_APP_TYPES.has('nonsense')).toBe(false);
  });

  it('lovableHasData discriminates empties', () => {
    expect(lovableHasData(null)).toBe(false);
    expect(lovableHasData([])).toBe(false);
    expect(lovableHasData({})).toBe(false);
    expect(lovableHasData('  ')).toBe(false);
    expect(lovableHasData(['x'])).toBe(true);
    expect(lovableHasData('hi')).toBe(true);
  });

  it('lovableSafeJoin filters falsy and joins', () => {
    expect(lovableSafeJoin(['a', '', null, 'b'], 1000)).toBe('a, b');
    expect(lovableSafeJoin('not-array', 1000)).toBe('');
  });

  it('formatVoice maps tone scores and falls back', () => {
    const out = lovableFormatVoice({
      toneAttributes: [{ attribute: 'Formality', score: 7 }],
      keyPhrases: ['ship fast'],
      summary: 'punchy and direct',
    }, true);
    expect(out.formality).toBe('7/10');
    expect(out.confidence).toBe('not measured');
    expect(out.brandVocab).toContain('ship fast');
    expect(out.toneSummary).toContain('punchy');
    expect(lovableFormatVoice(null, true)).toBeNull();
  });

  it('formatPersonas compacts to 3 in compact mode', () => {
    const personas = Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, painPoints: ['x'] }));
    const out = lovableFormatPersonas(personas, true);
    expect(out).toContain('P0');
    expect(out).not.toContain('P3');
    expect(lovableFormatPersonas([], true)).toBeNull();
  });

  it('formatGeo renders citation probability and reads both shapes', () => {
    const out = lovableFormatGeo({ geoOpportunities: [{ topic: 'AI search', citationProbability: 0.42 }] }, true);
    expect(out).toContain('AI search');
    expect(out).toContain('42%');
  });

  it('builders emit the brand name and required anchors', () => {
    const ctx = { brandName: 'Acme', appTypeDescription: 'Command Center', brandColors: '#000', brandProfileId: 'abc' };
    const ccc = lovableBuildContentCommandCenter(ctx);
    expect(ccc).toContain('Acme');
    expect(ccc).toContain('## REQUIRED SCREENS');

    const directive = lovableBuildWithDirective(
      { brandName: 'Acme', brandColors: '#000', brandProfileId: 'abc' },
      { description: 'a waitlist for launch', productType: 'waitlist' },
    );
    expect(directive).toContain('## BUILD DIRECTIVE');
    expect(directive).toContain('waitlist');
  });

  it('directive omits empty whitespace/third-party sections (no placeholder leak)', () => {
    // whitespace/thirdParty are formatter outputs: null when the brand has no
    // data. The directive prompt must drop those sections entirely, not inject
    // the "Design this section to be populated later" scaffolding placeholder.
    const directive = lovableBuildWithDirective(
      { brandName: 'Acme', brandColors: '#000', brandProfileId: 'abc', whitespace: null, thirdParty: null },
      { description: 'a landing page', productType: 'landing-page' },
    );
    expect(directive).not.toContain('Competitive whitespace:');
    expect(directive).not.toContain('Third-party voice themes:');

    // Populated sections still render.
    const withData = lovableBuildWithDirective(
      { brandName: 'Acme', brandColors: '#000', brandProfileId: 'abc',
        whitespace: '- unclaimed topic X', thirdParty: '- [G2] review: loved it' },
      { description: 'a landing page', productType: 'landing-page' },
    );
    expect(withData).toContain('Competitive whitespace:');
    expect(withData).toContain('unclaimed topic X');
    expect(withData).toContain('Third-party voice themes:');
  });

  it('stub + naming helpers map app types', () => {
    expect(lovableStubPrompt('geo-monitor', 'Acme', 'abc')).toContain('not yet shipped');
    expect(lovableRecommendedAppName('campaign-planner', 'Acme')).toBe('Acme Campaign Planner');
    expect(lovableAppTypeDescription('geo-monitor')).toBe('GEO Citation Monitor');
    expect(lovableAppTypeDescription('unknown')).toBe('brand-aware marketing application');
  });
});
