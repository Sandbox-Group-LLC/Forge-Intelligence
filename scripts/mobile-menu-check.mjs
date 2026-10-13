/**
 * Functional check of the mobile nav menu: it opens, lists the links, locks
 * background scroll, closes on Escape, and routes on tap.
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] || 'http://localhost:4000/';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 45000 });
await new Promise((r) => setTimeout(r, 600));

const check = (label, pass, detail = '') =>
  console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  — ' + detail : ''));

const toggle = 'span.fi-nav__toggle button';
check('toggle is visible', !!(await page.$(toggle)));
check('menu closed initially', (await page.$('#fi-nav-menu')) === null);

await page.click(toggle);
await new Promise((r) => setTimeout(r, 250));

const panel = await page.$('#fi-nav-menu');
check('menu opens on tap', !!panel);

const linkText = await page.$$eval('#fi-nav-menu .fi-nav__link', (els) => els.map((e) => e.textContent.trim()));
check('menu lists nav links', linkText.length === 3, linkText.join(', '));

const ctas = await page.$$eval('#fi-nav-menu .fi-nav__panelactions .fi-btn', (els) => els.map((e) => e.textContent.trim()));
check('menu carries CTA + sign in', ctas.length === 2, ctas.join(' | '));

const expanded = await page.$eval(toggle, (el) => el.getAttribute('aria-expanded'));
check('toggle reports aria-expanded=true', expanded === 'true', 'got ' + expanded);

const locked = await page.evaluate(() => getComputedStyle(document.body).overflow);
check('background scroll locked', locked === 'hidden', 'body overflow=' + locked);

const panelOverflow = await page.evaluate(() => {
  const d = document.documentElement;
  return d.scrollWidth - d.clientWidth;
});
check('no overflow while menu open', panelOverflow <= 0, '+' + panelOverflow + 'px');

await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 250));
check('Escape closes menu', (await page.$('#fi-nav-menu')) === null);
const restored = await page.evaluate(() => getComputedStyle(document.body).overflow);
check('scroll lock released', restored !== 'hidden', 'body overflow=' + restored);

// tapping a link should route and close
await page.click(toggle);
await new Promise((r) => setTimeout(r, 200));
await page.$$eval('#fi-nav-menu .fi-nav__link', (els) => els.find((e) => e.textContent.includes('Product')).click());
await new Promise((r) => setTimeout(r, 600));
check('tapping a link routes', page.url().includes('/product'), page.url());
check('menu closes after routing', (await page.$('#fi-nav-menu')) === null);

check('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' // '));

await browser.close();
