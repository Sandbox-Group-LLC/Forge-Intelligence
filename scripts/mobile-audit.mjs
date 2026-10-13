/**
 * Mobile layout audit for the marketing surface.
 *
 * Renders a page at a set of real device widths and reports anything that
 * would read as "wonky" on a phone: horizontal overflow, elements wider than
 * the viewport, tap targets under 44px, and text under 12px.
 *
 * Usage: node scripts/mobile-audit.mjs [url] [...widths]
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] || 'http://localhost:4000/';
const WIDTHS = process.argv.slice(3).map(Number).filter(Boolean);
const VIEWPORTS = WIDTHS.length ? WIDTHS : [320, 360, 390, 414, 768];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const audit = async (width) => {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 45000 });
  // let Reveal's IntersectionObserver settle so nothing is measured at opacity 0
  await new Promise((r) => setTimeout(r, 600));

  const result = await page.evaluate((vw) => {
    const doc = document.documentElement;
    const overflow = {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowPx: doc.scrollWidth - doc.clientWidth,
    };

    const describe = (el) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
    };

    const wide = [];
    const smallTaps = [];
    const smallText = [];

    for (const el of document.querySelectorAll('[data-forge-ds] *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;

      // elements physically sticking past the right edge or wider than viewport
      if (r.right > vw + 1 || r.width > vw + 1) {
        wide.push({ el: describe(el), width: Math.round(r.width), right: Math.round(r.right) });
      }

      // interactive targets that are too small to hit reliably
      const interactive = el.matches('a,button,input,select,textarea,[role="button"]');
      if (interactive && r.width > 0 && (r.height < 44 || r.width < 44)) {
        smallTaps.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 28) });
      }

      // text too small to read on a phone
      const fs = parseFloat(cs.fontSize);
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (ownText && fs < 12) {
        smallText.push({ el: describe(el), px: +fs.toFixed(1), text: (el.textContent || '').trim().slice(0, 32) });
      }
    }

    const dedupe = (arr, key) => {
      const seen = new Set();
      return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
    };

    return {
      overflow,
      wide: dedupe(wide, (x) => x.el + x.width).slice(0, 12),
      smallTaps: dedupe(smallTaps, (x) => x.el + x.h).slice(0, 12),
      smallText: dedupe(smallText, (x) => x.el + x.px).slice(0, 12),
    };
  }, width);

  await page.close();
  return result;
};

for (const w of VIEWPORTS) {
  const r = await audit(w);
  console.log('\n===== ' + w + 'px =====');
  console.log('overflow: ' + (r.overflow.overflowPx > 0 ? 'YES +' + r.overflow.overflowPx + 'px' : 'none') +
    ' (scroll ' + r.overflow.scrollWidth + ' vs client ' + r.overflow.clientWidth + ')');
  if (r.wide.length) {
    console.log('-- wider than viewport / overflowing:');
    for (const x of r.wide) console.log('   ' + x.el + '  w=' + x.width + ' right=' + x.right);
  }
  if (r.smallTaps.length) {
    console.log('-- tap targets under 44px:');
    for (const x of r.smallTaps) console.log('   ' + x.el + '  ' + x.w + 'x' + x.h + '  "' + x.text + '"');
  }
  if (r.smallText.length) {
    console.log('-- text under 12px:');
    for (const x of r.smallText) console.log('   ' + x.el + '  ' + x.px + 'px  "' + x.text + '"');
  }
}

await browser.close();
