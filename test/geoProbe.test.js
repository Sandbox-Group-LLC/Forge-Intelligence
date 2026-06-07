import { describe, it, expect } from 'vitest';
import { hostOf, gradeAnswer, scoreFromGrades, defaultQueries } from '../src/server/geoProbe.js';

describe('hostOf', () => {
  it('extracts host from a full URL and strips www', () => {
    expect(hostOf('https://www.forge.example.com/path?q=1')).toBe('forge.example.com');
  });
  it('handles a bare domain', () => {
    expect(hostOf('forge.example.com')).toBe('forge.example.com');
  });
  it('is null-safe', () => {
    expect(hostOf(null)).toBe('');
    expect(hostOf(undefined)).toBe('');
  });
});

describe('gradeAnswer', () => {
  const brand = { brandDomain: 'forge.example.com', brandName: 'Forge' };
  it('scores 100 when the brand domain is in the citation URLs', () => {
    const g = gradeAnswer({ text: 'Some answer.', urls: ['https://forge.example.com/post'], ...brand });
    expect(g).toEqual({ score: 100, status: 'cited' });
  });
  it('scores 100 when the brand domain appears in the answer text', () => {
    const g = gradeAnswer({ text: 'According to forge.example.com it works.', urls: [], ...brand });
    expect(g.score).toBe(100);
  });
  it('scores 50 when the brand is named but not linked', () => {
    const g = gradeAnswer({ text: 'Forge is one option in this space.', urls: ['https://competitor.com'], ...brand });
    expect(g).toEqual({ score: 50, status: 'mentioned' });
  });
  it('scores 0 when the brand is absent', () => {
    const g = gradeAnswer({ text: 'Competitors A and B lead here.', urls: ['https://competitor.com'], ...brand });
    expect(g).toEqual({ score: 0, status: 'absent' });
  });
  it('prefers cited over mentioned when both are true', () => {
    const g = gradeAnswer({ text: 'Forge says so.', urls: ['https://forge.example.com'], ...brand });
    expect(g.status).toBe('cited');
  });
  it('ignores a too-short brand name to avoid false mentions', () => {
    const g = gradeAnswer({ text: 'an example of work', urls: [], brandDomain: 'x.io', brandName: 'X' });
    expect(g.status).toBe('absent');
  });
});

describe('scoreFromGrades', () => {
  it('averages and rounds the grades', () => {
    expect(scoreFromGrades([{ score: 100 }, { score: 50 }, { score: 0 }])).toBe(50);
  });
  it('rounds to nearest integer', () => {
    expect(scoreFromGrades([{ score: 100 }, { score: 0 }, { score: 0 }])).toBe(33);
  });
  it('returns null (no observation) for an all-failed set, distinct from a measured 0', () => {
    expect(scoreFromGrades([null, null])).toBeNull();
    expect(scoreFromGrades([])).toBeNull();
  });
  it('excludes failed observations from the average', () => {
    expect(scoreFromGrades([{ score: 100 }, null])).toBe(100);
  });
});

describe('defaultQueries', () => {
  it('returns 3 brand-free queries including the bare topic', () => {
    const qs = defaultQueries('event attribution');
    expect(qs).toHaveLength(3);
    expect(qs[0]).toBe('event attribution');
    expect(qs.every(q => !/forge/i.test(q))).toBe(true);
  });
});
