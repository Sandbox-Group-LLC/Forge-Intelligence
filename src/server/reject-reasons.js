// Shared reject / editorial-signal taxonomy for Compliance Gate + The Post.
// Rejecting a compliance warning WITHOUT a reason is not allowed.

export const REJECT_REASON_CODES = Object.freeze([
  'invented_claim',
  'wrong_voice',
  'nda_risk',
  'off_thesis',
  'too_salesy',
  'factual_error',
  'legal_risk',
  'other',
]);

export const REJECT_REASON_LABELS = Object.freeze({
  invented_claim: 'Invented or unsupported claim',
  wrong_voice: 'Off-brand voice / tone',
  nda_risk: 'NDA / naming risk',
  off_thesis: 'Off thesis / wrong framing',
  too_salesy: 'Too salesy / hype',
  factual_error: 'Factual error',
  legal_risk: 'Legal / compliance risk',
  other: 'Other',
});

export function isValidRejectReason(code) {
  return REJECT_REASON_CODES.includes(String(code || '').trim());
}

/**
 * Normalize decisions + rejectReasons from the client.
 * decisions: { [sectionIdx]: 'approved' | 'rejected' }
 * rejectReasons: { [sectionIdx]: { code, note? } }
 * Returns { ok, error?, rejected: [{ idx, code, note, label }] }
 */
export function validateRejectReasons(decisions = {}, rejectReasons = {}) {
  const rejected = [];
  const entries = Object.entries(decisions || {});
  for (const [key, value] of entries) {
    if (value !== 'rejected') continue;
    const idx = String(key);
    const rr = rejectReasons?.[key] || rejectReasons?.[idx] || {};
    const code = String(rr.code || rr.reason || '').trim();
    if (!isValidRejectReason(code)) {
      return {
        ok: false,
        error: `Reject of section ${idx} requires a reason code (${REJECT_REASON_CODES.join(', ')})`,
        code: 'reject_reason_required',
        sectionIndex: Number.isFinite(Number(idx)) ? Number(idx) : idx,
      };
    }
    const note = rr.note != null ? String(rr.note).trim().slice(0, 500) : '';
    if (code === 'other' && note.length < 3) {
      return {
        ok: false,
        error: `Reject reason "other" on section ${idx} requires a short note`,
        code: 'reject_note_required',
        sectionIndex: Number.isFinite(Number(idx)) ? Number(idx) : idx,
      };
    }
    rejected.push({
      idx: Number.isFinite(Number(idx)) ? Number(idx) : idx,
      code,
      note,
      label: REJECT_REASON_LABELS[code] || code,
    });
  }
  return { ok: true, rejected };
}

export function formatRejectBrainFeedback({ code, label, note, flagReason, sectionHeading }) {
  const bits = [
    `REJECT reason: ${label || code}`,
    note ? `Operator note: ${note}` : null,
    flagReason ? `Flag context: ${String(flagReason).slice(0, 280)}` : null,
    sectionHeading ? `Section: ${sectionHeading}` : null,
    'Do NOT regenerate similar content for this brand.',
  ].filter(Boolean);
  return bits.join(' — ').slice(0, 900);
}
