// Live log ring buffer + console capture, extracted from server.js during the
// decomposition. captureLog mirrors every console.log/error/warn into an
// in-memory ring buffer (logBuffer), aggregates errors (errorAggregates), and
// fans entries out to connected SSE clients (logSSEClients) for the live-log
// admin view. installLogCapture() patches the console methods — call it once at
// boot, before anything that should be captured.
//
// logBuffer / logSSEClients / errorAggregates are exported as stable references
// and only ever mutated in place (push/shift/add/delete) — never reassigned —
// so the route handlers that import them observe the same live containers.

export const LOG_BUFFER_SIZE = 500;
export const logBuffer = [];
export const logSSEClients = new Set();
export const errorAggregates = [];

function captureLog(level, args) {
  // Stringify non-string args defensively: JSON.stringify throws on circular
  // structures (and BigInt), and captureLog runs INSIDE the patched console.*,
  // so an unguarded throw would propagate to whoever called console.log. Fall
  // back to String(a) (then a literal marker) rather than break the caller.
  const msg = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { try { return String(a); } catch { return '[unserializable]'; } }
  }).join(' ');
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: msg.slice(0, 2000),
    isError: level === 'error' || /\b(error|fail|crash|ECONNREFUSED|FATAL|uncaught|unhandled)\b/i.test(msg),
    isWarn: level === 'warn' || /\b(warn|deprecat|timeout|retry)\b/i.test(msg),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();

  // Aggregate errors
  if (entry.isError) {
    const errorKey = msg.slice(0, 120).replace(/[0-9a-f-]{36}/gi, '{id}').replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, '{ts}');
    const existing = errorAggregates.find(e => e.key === errorKey);
    if (existing) { existing.count++; existing.lastSeen = entry.ts; existing.lastMsg = msg.slice(0, 300); }
    else { errorAggregates.push({ key: errorKey, count: 1, firstSeen: entry.ts, lastSeen: entry.ts, lastMsg: msg.slice(0, 300), level }); }
    if (errorAggregates.length > 100) errorAggregates.shift();
  }

  // Push to SSE clients
  for (const client of logSSEClients) {
    try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { logSSEClients.delete(client); }
  }
}

let installed = false;
// Patch console.{log,error,warn} so every call is mirrored into the ring buffer.
// Idempotent — a second call is a no-op (guards against double-install).
export function installLogCapture() {
  if (installed) return;
  installed = true;
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.log = (...args) => { origLog(...args); captureLog('log', args); };
  console.error = (...args) => { origError(...args); captureLog('error', args); };
  console.warn = (...args) => { origWarn(...args); captureLog('warn', args); };
}
