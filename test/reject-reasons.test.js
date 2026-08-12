import { describe, it, expect } from 'vitest';
import {
  validateRejectReasons,
  isValidRejectReason,
  REJECT_REASON_CODES,
} from '../src/server/reject-reasons.js';

describe('reject reasons taxonomy', () => {
  it('lists expected codes', () => {
    expect(REJECT_REASON_CODES).toContain('invented_claim');
    expect(REJECT_REASON_CODES).toContain('other');
  });

  it('allows approve-only decisions without reasons', () => {
    const r = validateRejectReasons({ 0: 'approved' }, {});
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([]);
  });

  it('requires reason on reject', () => {
    const r = validateRejectReasons({ 2: 'rejected' }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('reject_reason_required');
  });

  it('accepts valid reject reason', () => {
    const r = validateRejectReasons(
      { 1: 'rejected' },
      { 1: { code: 'too_salesy', note: 'hype abstract' } }
    );
    expect(r.ok).toBe(true);
    expect(r.rejected[0].code).toBe('too_salesy');
  });

  it('requires note for other', () => {
    const r = validateRejectReasons({ 0: 'rejected' }, { 0: { code: 'other', note: '' } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('reject_note_required');
  });

  it('validates codes', () => {
    expect(isValidRejectReason('nda_risk')).toBe(true);
    expect(isValidRejectReason('nope')).toBe(false);
  });
});
