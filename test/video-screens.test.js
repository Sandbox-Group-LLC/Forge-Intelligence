import { describe, it, expect } from 'vitest';
import { assignShotsToScreens, hostLabel, screensEnabled } from '../src/server/video.js';

const screens = (id) => ({ id, type: 'screens', headline: 'See it', stat: { value: '35', label: 'sources' }, voiceover: 'watch this', durationInFrames: 90 });
const hook = (id) => ({ id, type: 'hook', headline: 'Hi', voiceover: 'hi', durationInFrames: 60 });

describe('assignShotsToScreens', () => {
  it('fills shots + urlLabel on screens scenes, leaves others untouched', () => {
    const out = assignShotsToScreens([hook('a'), screens('b'), hook('c')], ['u0', 'u1'], 'acme.com');
    expect(out[0]).toEqual(hook('a'));
    expect(out[1].type).toBe('screens');
    expect(out[1].shots.length).toBeGreaterThan(0);
    expect(out[1].urlLabel).toBe('acme.com');
    expect(out[1].voiceover).toBe('watch this'); // VO preserved for the TTS pass
  });

  it('a single screens scene crossfades through ALL shots', () => {
    const out = assignShotsToScreens([screens('b')], ['u0', 'u1', 'u2'], 'acme.com');
    expect(out[0].shots).toEqual(['u0', 'u1', 'u2']);
  });

  it('multiple screens scenes get distinct striped shots', () => {
    const out = assignShotsToScreens([screens('b'), screens('c')], ['u0', 'u1', 'u2'], 'x.com');
    expect(out[0].shots).toEqual(['u0', 'u2']);
    expect(out[1].shots).toEqual(['u1']);
  });

  it('more screens scenes than shots: each still gets one (never empty)', () => {
    const out = assignShotsToScreens([screens('a'), screens('b'), screens('c')], ['u0', 'u1'], 'x.com');
    expect(out.every((s) => s.type === 'screens' && s.shots.length >= 1)).toBe(true);
  });

  it('downgrades screens -> hook when there are no shots (never a missing image)', () => {
    const out = assignShotsToScreens([screens('b')], [], null);
    expect(out[0].type).toBe('hook');
    expect(out[0].shots).toBeUndefined();
    expect(out[0].headline).toBe('See it');
    expect(out[0].sub).toBe('35 sources'); // stat folded into the hook sub-line
    expect(out[0].durationInFrames).toBe(90); // timing + id + VO preserved
    expect(out[0].voiceover).toBe('watch this');
  });

  it('is a no-op when there are no screens scenes', () => {
    const input = [hook('a'), hook('b')];
    expect(assignShotsToScreens(input, ['u0'], 'x.com')).toEqual(input);
  });
});

describe('hostLabel', () => {
  it('strips protocol + www', () => {
    expect(hostLabel('https://www.acme.com/path')).toBe('acme.com');
    expect(hostLabel('http://app.acme.io')).toBe('app.acme.io');
  });
  it('returns null for junk', () => {
    expect(hostLabel('not a url')).toBeNull();
    expect(hostLabel('')).toBeNull();
  });
});

describe('screensEnabled', () => {
  it('reads the VIDEO_SCREENS_ENABLED flag', () => {
    const prev = process.env.VIDEO_SCREENS_ENABLED;
    process.env.VIDEO_SCREENS_ENABLED = '1';
    expect(screensEnabled()).toBe(true);
    process.env.VIDEO_SCREENS_ENABLED = 'false';
    expect(screensEnabled()).toBe(false);
    delete process.env.VIDEO_SCREENS_ENABLED;
    expect(screensEnabled()).toBe(false);
    if (prev !== undefined) process.env.VIDEO_SCREENS_ENABLED = prev;
  });
});

import { ensureScreensScene } from '../src/server/video.js';

describe('ensureScreensScene (uploads always make the cut)', () => {
  const sc = (id, type, extra = {}) => ({ id, type, voiceover: `vo ${id}`, durationInFrames: 90, headline: `H ${id}`, ...extra });

  it('converts a middle beat to screens when none exists, keeping hook + cta', () => {
    const out = ensureScreensScene([sc('a', 'hook'), sc('b', 'bars'), sc('c', 'orbit'), sc('d', 'cta')]);
    expect(out[0].type).toBe('hook');
    expect(out[out.length - 1].type).toBe('cta');
    expect(out.filter(s => s.type === 'screens')).toHaveLength(1);
  });

  it('preserves the converted scene voiceover + duration + a headline', () => {
    const out = ensureScreensScene([sc('a', 'hook'), sc('b', 'bars', { voiceover: 'keep me', durationInFrames: 123 }), sc('c', 'cta')]);
    const screens = out.find(s => s.type === 'screens');
    expect(screens.voiceover).toBe('keep me');
    expect(screens.durationInFrames).toBe(123);
    expect(screens.headline).toBeTruthy();
    expect(screens.shots).toEqual([]);
  });

  it('leaves a storyboard that already has a screens scene untouched', () => {
    const input = [sc('a', 'hook'), sc('b', 'screens', { shots: ['x'] }), sc('c', 'cta')];
    expect(ensureScreensScene(input)).toBe(input);
  });

  it('does not crash on a hook+cta-only reel (no room to inject)', () => {
    const out = ensureScreensScene([sc('a', 'hook'), sc('b', 'cta')]);
    expect(out.some(s => s.type === 'screens')).toBe(false);
  });
});
