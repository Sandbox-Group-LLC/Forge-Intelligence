import { describe, it, expect } from 'vitest';
import { extractJSON, safeParseLLM } from '../src/server/llm-json.js';

describe('extractJSON', () => {
  it('extracts a balanced object from surrounding text', () => {
    expect(extractJSON('prefix {"a":1} suffix')).toBe('{"a":1}');
  });

  it('extracts an array when type=array', () => {
    expect(extractJSON('noise [1, 2, 3] more', 'array')).toBe('[1, 2, 3]');
  });

  it('returns null when there is no opening token', () => {
    expect(extractJSON('no json here')).toBeNull();
  });

  it('recovers a truncated string value by closing open structures', () => {
    const out = extractJSON('{"a": "hello wor');
    expect(out).not.toBeNull();
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('returns null for truncation it cannot repair (cut mid-structure, no value yet)', () => {
    expect(extractJSON('{"a": {"b": 1')).toBeNull();
  });
});

describe('safeParseLLM', () => {
  it('parses clean JSON', () => {
    expect(safeParseLLM('{"x": 1}')).toEqual({ x: 1 });
  });

  it('strips code fences before parsing', () => {
    expect(safeParseLLM('```json\n{"x": 2}\n```')).toEqual({ x: 2 });
  });

  it('recovers trailing commas', () => {
    expect(safeParseLLM('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
  });

  it('throws after exhausting recovery on non-JSON', () => {
    expect(() => safeParseLLM('not json at all', 'object', 'test')).toThrow();
  });
});
