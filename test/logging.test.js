import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installLogCapture, logBuffer, errorAggregates, logSSEClients, LOG_BUFFER_SIZE } from '../src/server/logging.js';

// installLogCapture patches the real console; restore it after the suite so it
// doesn't leak into other test files.
let restore;
beforeAll(() => {
  const { log, error, warn } = console;
  restore = () => Object.assign(console, { log, error, warn });
  installLogCapture();
});
afterAll(() => restore());

describe('logging ring buffer', () => {
  it('mirrors console.log into the buffer', () => {
    const before = logBuffer.length;
    console.log('hello-capture-test');
    expect(logBuffer.length).toBe(before + 1);
    expect(logBuffer.at(-1).msg).toContain('hello-capture-test');
    expect(logBuffer.at(-1).level).toBe('log');
  });

  it('flags and aggregates errors', () => {
    const beforeAgg = errorAggregates.length;
    console.error('boom failure ECONNREFUSED on widget 11111111-2222-3333-4444-555555555555');
    const entry = logBuffer.at(-1);
    expect(entry.isError).toBe(true);
    // Same error shape (id masked) aggregates rather than appending a new key.
    console.error('boom failure ECONNREFUSED on widget 99999999-8888-7777-6666-555555555555');
    expect(errorAggregates.length).toBe(beforeAgg + 1);
    expect(errorAggregates.at(-1).count).toBe(2);
  });

  it('caps the buffer at LOG_BUFFER_SIZE', () => {
    for (let i = 0; i < LOG_BUFFER_SIZE + 50; i++) console.log('fill', i);
    expect(logBuffer.length).toBeLessThanOrEqual(LOG_BUFFER_SIZE);
  });

  it('is idempotent — re-install does not double-wrap', () => {
    installLogCapture();
    console.log('single-entry-unique-marker');
    // A double-wrapped console would capture the same call twice. Assert the
    // marker lands exactly once (buffer may be at its cap, so don't lean on length).
    const hits = logBuffer.filter(e => e.msg.includes('single-entry-unique-marker'));
    expect(hits.length).toBe(1);
  });

  it('exposes logSSEClients as a Set', () => {
    expect(logSSEClients).toBeInstanceOf(Set);
  });
});
