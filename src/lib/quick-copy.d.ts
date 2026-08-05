export const QUICK_COPY_FORMATS: string[];
export const QUICK_COPY_PLATFORMS: string[];
export function clampVariantCount(n: unknown): number;
export function findExcerptRange(text: string, excerpt: string): { start: number; end: number } | null;
export interface AnchoredFlag {
  n: number;
  severity: 'red' | 'yellow';
  type: string;
  excerpt: string;
  start: number;
  end: number;
  reason: string;
  suggestion?: string;
}
export function anchorComplianceFlags(body: string, rawFlags: Array<Record<string, unknown>>): AnchoredFlag[];
export type AnnotatedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'flag'; text: string; n: number; severity: 'red' | 'yellow' };
export function buildAnnotatedSegments(body: string, flags: AnchoredFlag[], dismissedNs?: Set<number> | number[]): AnnotatedSegment[];
export function cleanCopyText(body: string): string;
export function formatConstraintBlock(opts: { format: string; platform?: string; lengthHint?: string }): string;
