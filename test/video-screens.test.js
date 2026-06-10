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
