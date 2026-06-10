import { describe, it, expect, afterEach } from 'vitest';
import { resolveDirection, MUSIC_BEDS, VOICES, brandContextFor } from '../src/server/video.js';

describe('resolveDirection', () => {
  it('keeps the agent pick when no overrides', () => {
    const d = resolveDirection({ voice: 'ballad', musicBed: 'night-luxe', voiceInstructions: 'slow and rich', mood: 'luxury' }, {});
    expect(d.voice).toBe('ballad');
    expect(d.musicBed).toBe('night-luxe');
    expect(d.voiceInstructions).toBe('slow and rich');
  });

  it('user overrides beat the agent pick; auto keeps it', () => {
    const d = resolveDirection({ voice: 'ballad', musicBed: 'night-luxe' }, { voice: 'onyx', musicBed: 'auto' });
    expect(d.voice).toBe('onyx');
    expect(d.musicBed).toBe('night-luxe');
  });

  it('hallucinated ids fall back to defaults (cannot break TTS/render)', () => {
    const d = resolveDirection({ voice: 'morgan-freeman', musicBed: 'sad-trombone' }, {});
    expect(VOICES[d.voice]).toBeTruthy();
    expect(MUSIC_BEDS[d.musicBed]).toBeTruthy();
  });

  it("musicBed 'none' survives (voiceover-only reels)", () => {
    const d = resolveDirection({ musicBed: 'night-luxe' }, { musicBed: 'none' });
    expect(d.musicBed).toBe('none');
  });

  it('null agent pick yields full defaults', () => {
    const d = resolveDirection(null, null);
    expect(VOICES[d.voice]).toBeTruthy();
    expect(MUSIC_BEDS[d.musicBed]).toBeTruthy();
    expect(d.voiceInstructions.length).toBeGreaterThan(0);
  });

  it('blank voiceInstructions fall back', () => {
    const d = resolveDirection({ voiceInstructions: '   ' }, {});
    expect(d.voiceInstructions.trim().length).toBeGreaterThan(0);
  });
});

describe('brandContextFor', () => {
  it('condenses voice + visual style for the director', () => {
    const ctx = brandContextFor({ voiceProfile: {
      summary: 'Bold and editorial', visualStyle: 'dark luxury lookbook',
      positioning: 'CMO-level event studio',
      toneAttributes: [{ attribute: 'Confident' }, { attribute: 'Elegant' }],
    }});
    expect(ctx).toContain('Bold and editorial');
    expect(ctx).toContain('dark luxury lookbook');
    expect(ctx).toContain('Confident, Elegant');
  });

  it('handles empty profiles', () => {
    expect(brandContextFor(null)).toBe('');
    expect(brandContextFor({})).toBe('');
  });
});

import { enforceDuration, estimateSeconds, normalizeTargetSeconds, THEMES } from '../src/server/video.js';

describe('theme resolution', () => {
  it('agent theme survives; override wins; hallucination falls back', () => {
    expect(resolveDirection({ theme: 'editorial' }, {}).theme).toBe('editorial');
    expect(resolveDirection({ theme: 'editorial' }, { theme: 'bold' }).theme).toBe('bold');
    expect(THEMES[resolveDirection({ theme: 'vaporwave' }, {}).theme]).toBeTruthy();
  });
});

describe('duration enforcement', () => {
  const scene = (id, words) => ({ id, type: 'tags', headline: 'x', tags: ['a'], voiceover: Array(words).fill('word').join(' ') });

  it('normalizeTargetSeconds only allows known budgets', () => {
    expect(normalizeTargetSeconds(15)).toBe(15);
    expect(normalizeTargetSeconds('60')).toBe(60);
    expect(normalizeTargetSeconds(45)).toBe(30);
    expect(normalizeTargetSeconds(undefined)).toBe(30);
  });

  it('trims an over-budget storyboard down to target (drops middles, keeps hook+cta)', () => {
    // 7 scenes x 20 words ≈ 7 x 9.5s ≈ 66s — way over a 15s target
    const scenes = [scene('hook', 20), scene('a', 20), scene('b', 20), scene('c', 20), scene('d', 20), scene('e', 20), scene('cta', 20)];
    const out = enforceDuration(scenes, 15);
    expect(out[0].id).toBe('hook');
    expect(out[out.length - 1].id).toBe('cta');
    expect(out.length).toBe(3); // floor — never trims below hook + 1 + cta
  });

  it('leaves a within-budget storyboard untouched', () => {
    const scenes = [scene('hook', 8), scene('mid', 8), scene('cta', 8)];
    expect(enforceDuration(scenes, 15)).toHaveLength(3);
    expect(estimateSeconds(scenes)).toBeLessThan(15 * 1.15);
  });

  it('a 30s storyboard lands near 30s after trim', () => {
    const scenes = [scene('hook', 13), scene('a', 13), scene('b', 13), scene('c', 13), scene('d', 13), scene('cta', 13)];
    const out = enforceDuration(scenes, 30);
    expect(estimateSeconds(out)).toBeLessThanOrEqual(30 * 1.15);
  });
});

describe('expressive voice instructions', () => {
  it('default voiceInstructions are structured/multi-line (openai.fm style), not a thin sentence', () => {
    const d = resolveDirection(null, null);
    expect(d.voiceInstructions).toMatch(/Voice Affect:/);
    expect(d.voiceInstructions.split('\n').length).toBeGreaterThanOrEqual(4);
  });
  it('expressive voices are in the roster', () => {
    expect(VOICES.coral).toBeTruthy();
    expect(VOICES.verse).toBeTruthy();
  });
  it('a blank agent voiceInstruction falls back to the rich default', () => {
    const d = resolveDirection({ voiceInstructions: '   ' }, {});
    expect(d.voiceInstructions).toMatch(/Voice Affect:/);
  });
});

import { punchWordsFor, voiceInstructionsForScene } from '../src/server/video.js';

describe('per-scene voice dynamics', () => {
  it('pulls on-screen emphasis words as punch targets per scene type', () => {
    expect(punchWordsFor({ type: 'hook', emphasis: 'memory problem.' })).toContain('memory problem.');
    expect(punchWordsFor({ type: 'bars', headlineEmphasis: 'actually cites you.' })).toContain('actually cites you.');
    expect(punchWordsFor({ type: 'tags', tags: ['fast', 'generic', 'forgettable', 'extra'] })).toEqual(['fast', 'generic', 'forgettable']); // capped at 3
    expect(punchWordsFor({ type: 'screens', stat: { value: '4', label: 'engines' } })).toContain('4');
    expect(punchWordsFor(null)).toEqual([]);
  });

  it('builds per-scene instructions that demand an inflection arc + name the punch words', () => {
    const instr = voiceInstructionsForScene('Base voice.', { type: 'hook', emphasis: 'compounds.' });
    expect(instr).toContain('Base voice.');
    expect(instr).toMatch(/inflection arc/i);
    expect(instr).toContain('"compounds."');
  });

  it('still demands dynamics even with no punch words', () => {
    const instr = voiceInstructionsForScene('Base.', { type: 'curve' });
    expect(instr).toMatch(/inflection arc/i);
    expect(instr).not.toMatch(/Punch these/);
  });

  it('falls back to the default direction when base is empty', () => {
    expect(voiceInstructionsForScene('', { type: 'hook' })).toMatch(/inflection arc/i);
  });
});

import { ttsProvider } from '../src/server/video.js';

describe('ttsProvider selection', () => {
  const K = 'ELEVENLABS_API_KEY', P = 'VIDEO_TTS_PROVIDER';
  const sK = process.env[K], sP = process.env[P];
  afterEach(() => {
    sK === undefined ? delete process.env[K] : (process.env[K] = sK);
    sP === undefined ? delete process.env[P] : (process.env[P] = sP);
  });
  it('auto → elevenlabs when key present, openai when absent', () => {
    delete process.env[P];
    process.env[K] = 'x'; expect(ttsProvider()).toBe('elevenlabs');
    delete process.env[K]; expect(ttsProvider()).toBe('openai');
  });
  it('explicit override wins over the key heuristic', () => {
    process.env[K] = 'x';
    process.env[P] = 'openai'; expect(ttsProvider()).toBe('openai');
    delete process.env[K]; process.env[P] = 'elevenlabs'; expect(ttsProvider()).toBe('elevenlabs');
  });
});
