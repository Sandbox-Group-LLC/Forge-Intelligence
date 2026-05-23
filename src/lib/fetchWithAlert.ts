// Lightweight fetch wrapper that auto-reports failures to the alerts store.
// Pages opt in by importing this instead of `fetch` for user-initiated calls.
// On non-OK responses or network errors, it calls reportError() with the
// captured status, then throws (default) so existing try/catch keeps working.

export type ReportErrorFn = (
  err: unknown,
  ctx: { area?: string; url?: string; httpStatus?: number }
) => void;

export interface FetchWithAlertOptions extends RequestInit {
  area?: string;
  /** When false, return the Response on non-2xx instead of throwing. Default: true. */
  throwOnHttpError?: boolean;
}

export async function fetchWithAlert(
  input: RequestInfo | URL,
  init: FetchWithAlertOptions | undefined,
  reportError: ReportErrorFn
): Promise<Response> {
  const area = init?.area;
  const reqUrl =
    typeof input === 'string' ? input :
    input instanceof URL ? input.toString() :
    input.url;
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    reportError(err, { area, url: window.location.pathname });
    throw err;
  }
  if (!res.ok) {
    let raw: string | undefined;
    try {
      const clone = res.clone();
      const text = await clone.text();
      raw = text.slice(0, 500);
    } catch { /* ignore */ }
    const fakeErr = new Error(`HTTP ${res.status} ${res.statusText || ''} ${raw || ''}`.trim()) as
      Error & { status?: number; url?: string };
    fakeErr.status = res.status;
    fakeErr.url = reqUrl;
    reportError(fakeErr, { area, url: window.location.pathname, httpStatus: res.status });
    if (init?.throwOnHttpError !== false) {
      throw fakeErr;
    }
  }
  return res;
}
