import { env, hasNango } from '../../config/env';

// Thin Nango adapter. Nango holds the OAuth token vault and runs typed syncs;
// we never store provider credentials in our own DB. This wraps the calls we
// need (connect sessions, reading synced records). Docs: https://docs.nango.dev
export function nangoConfigured(): boolean {
  return hasNango;
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

export async function nangoFetch(path: string, init: FetchInit = {}): Promise<unknown> {
  if (!hasNango) throw new Error('NANGO_SECRET_KEY not configured');
  const res = await fetch(`${env.NANGO_HOST}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${env.NANGO_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
  if (!res.ok) throw new Error(`Nango ${res.status}: ${await res.text()}`);
  return res.json();
}
