import { describe, it, expect } from 'vitest';
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
