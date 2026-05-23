// Translates any thrown/rejected value into a short, user-safe string.
// Never returns raw stack traces, SQL, or internal paths. The verbose form
// goes into `rawMessage` (admin-only) — see reportError() in AppContext.

export type AlertSeverity = 'error' | 'warn' | 'info';

export interface HumanizeContext {
  area?: string;
  url?: string;
  httpStatus?: number;
}

export interface HumanizeResult {
  shortMessage: string;
  severity: AlertSeverity;
  httpStatus?: number;
  rawMessage?: string;
  /** When true, the caller should NOT surface this alert (e.g. AbortError). */
  suppress?: boolean;
}

function statusToMessage(status: number): { msg: string; sev: AlertSeverity } | null {
  if (status === 401 || status === 403) {
    return { msg: "You don't have access to that. Try signing in again.", sev: 'warn' };
  }
  if (status === 404) {
    return { msg: "We couldn't find that — it may have been removed.", sev: 'warn' };
  }
  if (status === 408 || status === 504) {
    return { msg: "That took too long. Please retry.", sev: 'warn' };
  }
  if (status === 429) {
    return { msg: "You're going a little fast — slow down and retry.", sev: 'warn' };
  }
  if (status >= 500 && status < 600) {
    return { msg: "Our server hiccupped. We logged it.", sev: 'error' };
  }
  if (status >= 400 && status < 500) {
    return { msg: "That request didn't go through. Please retry.", sev: 'warn' };
  }
  return null;
}

function rawFromError(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`.slice(0, 2000);
  }
  if (typeof err === 'string') return err.slice(0, 2000);
  try { return JSON.stringify(err).slice(0, 2000); } catch { return String(err).slice(0, 2000); }
}

export function humanize(err: unknown, ctx: HumanizeContext = {}): HumanizeResult {
  const raw = rawFromError(err);

  // HTTP status hint (caller-provided or extracted from a Response)
  let status: number | undefined = ctx.httpStatus;
  if (status == null && typeof err === 'object' && err && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') status = s;
  }
  if (status != null) {
    const mapped = statusToMessage(status);
    if (mapped) {
      return { shortMessage: mapped.msg, severity: mapped.sev, httpStatus: status, rawMessage: raw };
    }
  }

  // Common message-substring heuristics
  const msg = (err instanceof Error ? err.message : typeof err === 'string' ? err : '') || '';
  const name = err instanceof Error ? err.name : '';

  if (name === 'AbortError' || /aborted/i.test(msg)) {
    return { shortMessage: 'Request cancelled.', severity: 'info', rawMessage: raw, suppress: true };
  }
  if (name === 'TimeoutError' || /timeout/i.test(msg)) {
    return { shortMessage: 'That took too long. Please retry.', severity: 'warn', rawMessage: raw };
  }
  if (/NetworkError|Failed to fetch|Load failed|network request failed/i.test(msg)) {
    return { shortMessage: 'Network issue — check your connection.', severity: 'warn', rawMessage: raw };
  }
  if (/quota|rate limit|too many requests/i.test(msg)) {
    return { shortMessage: "You're going a little fast — slow down and retry.", severity: 'warn', rawMessage: raw };
  }
  if (/unauthorized|forbidden|not authenticated|invalid token/i.test(msg)) {
    return { shortMessage: "You don't have access to that. Try signing in again.", severity: 'warn', rawMessage: raw };
  }
  if (/not found/i.test(msg)) {
    return { shortMessage: "We couldn't find that — it may have been removed.", severity: 'warn', rawMessage: raw };
  }

  return {
    shortMessage: "Something didn't work as expected. We've logged it.",
    severity: 'error',
    rawMessage: raw,
  };
}
