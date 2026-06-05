import { describe, it, expect } from 'vitest';
import { zernioGuard } from '../src/server/zernio.js';

// Temporarily set env (restoring afterward) so the guard's process.env reads are controlled.
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const callGuard = (host, body, env) => withEnv(env, () => {
  let status = null;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  const out = zernioGuard({ headers: { host }, body }, res);
  return { out, status };
});

const OK_ENV = { ADMIN_RELAY_PASSWORD: 'secret', ZERNIO_API_KEY: 'zk_live_test' };

describe('zernioGuard', () => {
  it('rejects on the production host (403)', () => {
    expect(callGuard('forgeintelligence.ai', { adminPassword: 'secret' }, OK_ENV))
      .toEqual({ out: false, status: 403 });
  });

  it('allows the dev host through the host check', () => {
    expect(callGuard('dev.forgeintelligence.ai', { adminPassword: 'secret' }, OK_ENV))
      .toEqual({ out: true, status: null });
  });

  it('rejects a wrong admin password (403)', () => {
    expect(callGuard('dev.forgeintelligence.ai', { adminPassword: 'nope' }, OK_ENV))
      .toEqual({ out: false, status: 403 });
  });

  it('500s when ZERNIO_API_KEY is unset', () => {
    expect(callGuard('dev.forgeintelligence.ai', { adminPassword: 'secret' }, { ADMIN_RELAY_PASSWORD: 'secret', ZERNIO_API_KEY: undefined }))
      .toEqual({ out: false, status: 500 });
  });

  it('passes a non-Forge host with the right password + key', () => {
    expect(callGuard('localhost:3000', { adminPassword: 'secret' }, OK_ENV))
      .toEqual({ out: true, status: null });
  });
});
