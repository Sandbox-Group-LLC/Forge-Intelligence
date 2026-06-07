import { describe, it, expect } from 'vitest';
import { PROMO_CODES } from '../src/server/promo.js';

describe('PROMO_CODES', () => {
  it('is a Map of known comp codes', () => {
    expect(PROMO_CODES).toBeInstanceOf(Map);
    expect(PROMO_CODES.get('FORGEFRIEND')).toEqual({ discount: 100, description: 'Friend of Forge' });
    expect(PROMO_CODES.get('NANGO').discount).toBe(100);
  });
  it('returns undefined for unknown codes', () => {
    expect(PROMO_CODES.get('NOPE')).toBeUndefined();
  });
});
