// Connection-drop recovery for /api/context-hub/analyze.
//
// /analyze is a single synchronous request that holds the connection open for
// the full 3-4 minute scan. If the connection dies mid-flight (proxy idle
// timeout, tab throttling, network blip) the SERVER finishes and saves fine,
// but the browser's fetch never settles — the UI spins forever. These helpers
// let every analyze call site (a) put a hard deadline on the fetch and
// (b) recover the completed brain by polling the open history endpoint for a
// version bump, then loading /brand/:id (same payload shape as analyze).

export const ANALYZE_DEADLINE_MS = 8 * 60_000; // >> any real scan (3-4 min)

// Snapshot the brand's current max version so recovery can detect the bump.
export async function baselineVersionFor(brandUrl: string): Promise<number> {
  try {
    const h = await fetch(`/api/context-hub/history/${encodeURIComponent(brandUrl)}`).then(r => r.json());
    if (h?.success && Array.isArray(h.data) && h.data.length) {
      return Math.max(...h.data.map((r: any) => r.version || 0));
    }
  } catch { /* best-effort */ }
  return 0;
}

// Race the analyze fetch against a deadline; a fetch whose connection has
// silently died never settles on its own.
export function withDeadline<T>(p: Promise<T>, ms = ANALYZE_DEADLINE_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('analyze-connection-lost')), ms)),
  ]);
}

// True only for network-level death (dropped connection / our deadline) —
// real server errors (409 domain-claimed, !success payloads) must NOT recover.
export function isConnectionDeath(err: unknown): boolean {
  return err instanceof Error &&
    (err.message === 'analyze-connection-lost' ||
     err.name === 'TypeError' ||
     /failed to fetch|load failed|network/i.test(err.message));
}

// Poll history for a version newer than baseline; on bump, load the full brain.
// Returns the analyze-shaped response ({ success, data }) or null on timeout.
export async function recoverAnalyze(brandUrl: string, baselineVersion: number): Promise<any | null> {
  const POLL_MS = 10_000;
  const MAX_MS = 6 * 60_000;
  const deadline = Date.now() + MAX_MS;
  while (Date.now() < deadline) {
    try {
      const h = await fetch(`/api/context-hub/history/${encodeURIComponent(brandUrl)}`).then(r => r.json());
      const rows: any[] = h?.success && Array.isArray(h.data) ? h.data : [];
      const fresh = rows.find(r => (r.version || 0) > baselineVersion && r.is_active !== false);
      if (fresh?.id) {
        const b = await fetch(`/api/context-hub/brand/${fresh.id}`).then(r => r.json());
        if (b?.success && b.data) return b;
      }
    } catch { /* transient — keep polling */ }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  return null;
}
