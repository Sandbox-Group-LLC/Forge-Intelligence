import { describe, it, expect } from 'vitest';
import { readZernioAnalytics } from '../src/server/zernio.js';

// Payloads below are trimmed copies of real GET /v1/analytics?postId=... bodies
// captured live on 2026-10-11. The shape matters more than the numbers: metrics
// live at platformAnalytics[].analytics, and Zernio returns a flat union of every
// platform's metric names on each entry.
const syncedLinkedIn = {
  postId: '6aaf8e309698db23be69c549',
  status: 'published',
  syncStatus: 'synced',
  analytics: {},
  platformAnalytics: [{
    platform: 'linkedin',
    status: 'published',
    analytics: {
      impressions: 115, reach: 57, likes: 2, comments: 2, shares: 0, saves: 0,
      clicks: 0, views: 0, follows: 0,
      // IG-only fields ride along on LinkedIn entries — must be ignored.
      igReelsAvgWatchTime: 0, reelsSkipRate: 0, completionRate: 0,
    },
  }],
};

// Observed on three Sept LinkedIn posts: HTTP 200, but analytics is null and
// syncStatus is 'unavailable'. LinkedIn does not backfill org post analytics
// collected late, so this state is terminal.
const unavailableLinkedIn = {
  postId: '6aaf7dc8054da2c669a67bfb',
  status: 'published',
  syncStatus: 'unavailable',
  analytics: {},
  platformAnalytics: [{ platform: 'linkedin', status: 'published', analytics: null }],
};

const syncedInstagram = {
  postId: '6ab2a8d2867a569f242756cf',
  syncStatus: 'synced',
  analytics: {},
  platformAnalytics: [{
    platform: 'instagram',
    status: 'published',
    analytics: { impressions: 9, reach: 9, likes: 0, comments: 0, shares: 0, saves: 2, clicks: 0 },
  }],
};

describe('readZernioAnalytics', () => {
  it('reads metrics out of platformAnalytics for a synced post', () => {
    expect(readZernioAnalytics(syncedLinkedIn, 'linkedin')).toEqual({
      state: 'ok',
      syncStatus: 'synced',
      metrics: { impressions: 115, clicks: 0, reactions: 2, comments: 2, reposts: 0 },
    });
  });

  // The regression this whole change exists for: a 200 with analytics:null used
  // to collapse to {} and be stored as a real row of zeros, which the upsert then
  // refused to ever overwrite (it only updates when impressions > 0).
  it('reports unavailable instead of zeros when analytics is null', () => {
    const out = readZernioAnalytics(unavailableLinkedIn, 'linkedin');
    expect(out.state).toBe('unavailable');
    expect(out.metrics).toBeNull();
    expect(out.syncStatus).toBe('unavailable');
  });

  it('reports pending when metrics are absent but not terminally unavailable', () => {
    const stillComputing = {
      syncStatus: 'pending',
      platformAnalytics: [{ platform: 'linkedin', analytics: null }],
    };
    expect(readZernioAnalytics(stillComputing, 'linkedin').state).toBe('pending');
  });

  it('treats a missing platform entry as pending, not zeros', () => {
    expect(readZernioAnalytics(syncedLinkedIn, 'facebook').state).toBe('pending');
  });

  it('does not fall back to the response envelope when the platform is absent', () => {
    // Old code did `|| analytics || {}`, so it read impressions off the envelope.
    const envelopeTrap = {
      syncStatus: 'synced',
      impressions: 9999,
      analytics: { impressions: 8888 },
      platformAnalytics: [],
    };
    expect(readZernioAnalytics(envelopeTrap, 'facebook').metrics).toBeNull();
  });

  it('selects the requested platform when several are present', () => {
    const multi = {
      syncStatus: 'synced',
      platformAnalytics: [
        { platform: 'linkedin',  analytics: { impressions: 10, likes: 1 } },
        { platform: 'instagram', analytics: { impressions: 20, likes: 2 } },
      ],
    };
    expect(readZernioAnalytics(multi, 'instagram').metrics.impressions).toBe(20);
    expect(readZernioAnalytics(multi, 'linkedin').metrics.impressions).toBe(10);
  });

  it('maps instagram canonical keys and leaves saves to the caller', () => {
    const out = readZernioAnalytics(syncedInstagram, 'instagram');
    expect(out.metrics).toEqual({ impressions: 9, clicks: 0, reactions: 0, comments: 0, reposts: 0 });
  });

  it('survives a malformed or empty body without throwing', () => {
    for (const body of [null, undefined, {}, { platformAnalytics: null }]) {
      expect(readZernioAnalytics(body, 'linkedin').state).toBe('pending');
    }
  });
});
