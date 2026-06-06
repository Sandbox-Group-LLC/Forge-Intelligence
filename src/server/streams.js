// Shared SSE stream registry, extracted from server.js during the route-group
// phase. Dedupes Generate clicks so a user firing twice doesn't spawn two
// streams. globalThis-backed so the same Map is shared no matter how many
// modules import it (and survives module re-evaluation).
export const activeStreams = (typeof globalThis.__activeStreams === 'object' && globalThis.__activeStreams)
  ? globalThis.__activeStreams
  : (globalThis.__activeStreams = new Map());
