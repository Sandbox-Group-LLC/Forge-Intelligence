/**
 * Forge My Website analytics beacon
 * Drop-in snippet for customer article pages.
 *
 * Usage:
 *   <script
 *     src="https://forgeintelligence.ai/forge-beacon.js"
 *     data-brand="YOUR_BRAND_PROFILE_ID"
 *     data-key="forge_beacon_…"
 *     data-slug="optional-article-slug"
 *     data-content-id="optional-content-id"
 *     data-api="https://forgeintelligence.ai"
 *     defer
 *   ></script>
 *
 * Events: pageview (once), scroll depth milestones, read_time heartbeats, optional [data-forge-cta] clicks.
 */
(function () {
  'use strict';
  try {
    var s = document.currentScript;
    if (!s) return;
    var brand = s.getAttribute('data-brand') || '';
    var key = s.getAttribute('data-key') || '';
    var slug = s.getAttribute('data-slug') || '';
    var contentId = s.getAttribute('data-content-id') || '';
    var apiBase = (s.getAttribute('data-api') || 'https://forgeintelligence.ai').replace(/\/+$/, '');
    if (!brand || !key) return;
    if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return;

    var endpoint = apiBase + '/api/analytics/website-beacon';
    var started = Date.now();
    var maxScroll = 0;
    var lastReadSent = 0;
    var scrollMarks = { 25: false, 50: false, 75: false, 100: false };

    function pageUrl() {
      try { return location.href.split('#')[0]; } catch (e) { return ''; }
    }

    function send(event, extra) {
      var body = {
        brandProfileId: brand,
        event: event,
        url: pageUrl(),
        slug: slug || undefined,
        contentId: contentId || undefined
      };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] != null) body[k] = extra[k];
        }
      }
      var payload = JSON.stringify(body);
      try {
        if (navigator.sendBeacon) {
          var blob = new Blob([payload], { type: 'application/json' });
          // sendBeacon cannot set Authorization — key rides in body.beaconKey
          body.beaconKey = key;
          payload = JSON.stringify(body);
          blob = new Blob([payload], { type: 'application/json' });
          if (navigator.sendBeacon(endpoint, blob)) return;
        }
      } catch (e) { /* fall through */ }
      try {
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + key
          },
          body: payload,
          keepalive: true,
          mode: 'cors',
          credentials: 'omit'
        }).catch(function () {});
      } catch (e2) { /* ignore */ }
    }

    function scrollPct() {
      var doc = document.documentElement;
      var body = document.body;
      var scrollTop = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
      var height = Math.max(
        body.scrollHeight || 0,
        doc.scrollHeight || 0,
        body.offsetHeight || 0,
        doc.offsetHeight || 0
      );
      var win = window.innerHeight || doc.clientHeight || 0;
      if (height <= win) return 100;
      return Math.min(100, Math.round((scrollTop + win) / height * 100));
    }

    function onScroll() {
      var pct = scrollPct();
      if (pct > maxScroll) maxScroll = pct;
      [25, 50, 75, 100].forEach(function (m) {
        if (!scrollMarks[m] && maxScroll >= m) {
          scrollMarks[m] = true;
          send('scroll', { scrollDepth: m, readSeconds: Math.round((Date.now() - started) / 1000) });
        }
      });
    }

    function heartbeat() {
      var secs = Math.round((Date.now() - started) / 1000);
      if (secs - lastReadSent < 15) return;
      lastReadSent = secs;
      send('read_time', { readSeconds: secs, scrollDepth: maxScroll });
    }

    function flush() {
      var secs = Math.round((Date.now() - started) / 1000);
      if (secs > lastReadSent) {
        lastReadSent = secs;
        send('read_time', { readSeconds: secs, scrollDepth: maxScroll });
      }
    }

    send('pageview', { readSeconds: 0, scrollDepth: 0 });

    var scrollTimer = null;
    window.addEventListener('scroll', function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        onScroll();
      }, 200);
    }, { passive: true });

    var hb = setInterval(heartbeat, 15000);
    window.addEventListener('pagehide', function () {
      clearInterval(hb);
      flush();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });

    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var el = t.closest('[data-forge-cta]');
      if (!el) return;
      send('cta_click', {
        readSeconds: Math.round((Date.now() - started) / 1000),
        scrollDepth: maxScroll
      });
    }, true);
  } catch (err) {
    /* never break the host page */
  }
})();
