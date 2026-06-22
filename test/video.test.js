import { describe, it, expect, afterEach } from 'vitest';
import { videoConfigured, framesForVoiceover, guardRefineInstruction } from '../src/server/video.js';

describe('videoConfigured', () => {
  const KEYS = [
    'REMOTION_LAMBDA_FUNCTION_NAME', 'REMOTION_LAMBDA_SERVE_URL',
    'REMOTION_AWS_REGION', 'REMOTION_AWS_ACCESS_KEY_ID', 'REMOTION_AWS_SECRET_ACCESS_KEY',
  ];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('is false when any var is missing', () => {
    for (const k of KEYS) delete process.env[k];
    expect(videoConfigured()).toBe(false);
    for (const k of KEYS.slice(1)) process.env[k] = 'x';
    expect(videoConfigured()).toBe(false); // first one still missing
  });

  it('is true only when all five are set', () => {
    for (const k of KEYS) process.env[k] = 'x';
    expect(videoConfigured()).toBe(true);
  });
});

describe('framesForVoiceover', () => {
  it('enforces a minimum so short lines are never starved', () => {
    expect(framesForVoiceover('Go.')).toBeGreaterThanOrEqual(66); // 2.2s * 30fps
  });

  it('scales with word count (longer VO -> more frames)', () => {
    const short = framesForVoiceover('A short line of voiceover here.');
    const long = framesForVoiceover('A much longer line of voiceover that keeps going on and on with many more words to speak.');
    expect(long).toBeGreaterThan(short);
  });

  it('is generous enough to outlast the audio (>= ~1s per ~2.3 words)', () => {
    const words = 23;
    const frames = framesForVoiceover(Array(words).fill('word').join(' '));
    expect(frames / 30).toBeGreaterThanOrEqual(words / 2.3); // seconds >= speaking time
  });

  it('handles empty/undefined safely', () => {
    expect(framesForVoiceover('')).toBeGreaterThanOrEqual(66);
    expect(framesForVoiceover(undefined)).toBeGreaterThanOrEqual(66);
  });
});

describe('guardRefineInstruction (deterministic short-circuits)', () => {
  it('rejects empty / whitespace input before any model call', async () => {
    expect(await guardRefineInstruction('')).toEqual({ allowed: false, reason: 'empty' });
    expect(await guardRefineInstruction('   ')).toEqual({ allowed: false, reason: 'empty' });
    expect(await guardRefineInstruction(null)).toEqual({ allowed: false, reason: 'empty' });
  });

  it('rejects over-long input (>400 chars) before any model call', async () => {
    const long = 'a'.repeat(401);
    expect(await guardRefineInstruction(long)).toEqual({ allowed: false, reason: 'too_long' });
  });
});
