// Identity resolution for the golden record. Deterministic matching on a
// normalized email/phone key; probabilistic (fuzzy name + company) matching is
// a Phase 2 follow-up. Survivorship rules decide which value wins on merge.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

export interface IdentityInput {
  email?: string;
  phone?: string;
}

// A stable key used for deterministic dedupe. Email wins over phone.
export function deterministicKey(input: IdentityInput): string | null {
  if (input.email && input.email.trim()) return `email:${normalizeEmail(input.email)}`;
  if (input.phone && input.phone.trim()) return `phone:${normalizePhone(input.phone)}`;
  return null;
}
