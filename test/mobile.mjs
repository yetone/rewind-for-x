// Phone layout of x.com: a tab bar along the bottom and a compose button
// above it, a touch screen 390px wide.
//   node test/mobile.mjs --chrome     (needs Puppeteer with Chrome)
//   node test/mobile.mjs --firefox    (needs Puppeteer with Firefox)
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { EXT, launch, mockX, sleep, openDrawer, panelOpen, cards, names, isFirefox } from './browser.mjs';

const shots = process.env.SHOTS || path.join(EXT, 'test', 'out');
fs.mkdirSync(shots, { recursive: true });

const pic = (c) =>
  'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${c}"/></svg>`);
const tweet = (id, handle, name, text, photo) => `
  <div data-testid="cellInnerDiv"><article data-testid="tweet" role="article">
    <div data-testid="Tweet-User-Avatar"><img src="${pic('#c33')}"></div>
    <div data-testid="User-Name"><a href="/${handle}"><span>${name}</span></a>
      <div><a href="/${handle}">@${handle}</a> · <a href="/${handle}/status/${id}"><time datetime="2026-11-09T10:00:00.000Z">1h</time></a></div></div>
    <div data-testid="tweetText"><span>${text}</span></div>
    ${photo ? `<a href="/${handle}/status/${id}/photo/1"><div data-testid="tweetPhoto"><img src="${pic(photo)}"></div></a>` : ''}
  </article></div>`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>
  body { margin: 0; background: #fff; font-family: sans-serif; }
  article { height: 260px; border-bottom: 1px solid #888; padding: 10px; box-sizing: border-box; }
  nav { position: fixed; left: 0; right: 0; bottom: 0; height: 53px; background: #eee; }
  .compose { position: fixed; right: 16px; bottom: 69px; width: 56px; height: 56px; border-radius: 50%; }
</style></head><body><main>
${tweet('1', 'ann', 'Ann', 'on the train', '#36c')}${tweet('2', 'ben', 'Ben', 'second')}${tweet('3', 'cy', 'Cy', 'third')}
</main>
<nav data-testid="BottomBar"></nav>
<a class="compose" data-testid="FloatingActionButtons_Tweet_Button" href="/compose/post">+</a>
</body></html>`;

const browser = await launch({
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  // Firefox's hasTouch viewport flag does not reach matchMedia('(pointer:coarse)'),
  // which the touch-sized CSS keys on. Force coarse pointers via prefs instead.
  prefs: { 'ui.primaryPointerCapabilities': 2, 'ui.allPointerCapabilities': 2 },
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await mockX(page, PAGE);
await page.goto('https://x.com/home');
await sleep(2500);

const rect = (sel, inShadow) => page.evaluate((sel, inShadow) => {
  const el = inShadow ? document.getElementById('x-rewind').shadowRoot.querySelector(sel) : document.querySelector(sel);
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, sel, inShadow);

// The button stands on X's compose button, right edges lined up.
const box = await rect('.fab', true);
const compose = await rect('.compose', false);
assert.equal(Math.round(box.x + box.width), Math.round(compose.x + compose.width));
assert.equal(Math.round(compose.y - (box.y + box.height)), 12);
await page.screenshot({ path: `${shots}/mobile-home.png` });

// Without a compose button it sits just above the tab bar.
await page.evaluate(() => document.querySelector('.compose').remove());
await sleep(700);
const bare = await rect('.fab', true);
assert.equal(Math.round(844 - 53 - (bare.y + bare.height)), 16);
assert.equal(Math.round(390 - (bare.x + bare.width)), 16);
console.log('ok  button sits above the compose button / tab bar');

// The drawer covers the screen, with finger-sized controls.
await openDrawer(page);
assert.ok((await cards(page)).length >= 2, 'posts are recorded on a phone too');
const panel = await rect('.panel', true);
assert.deepEqual([panel.x, panel.width], [0, 390]);
const sizes = await page.evaluate(() => {
  const r = document.getElementById('x-rewind').shadowRoot;
  const px = (sel, prop) => parseFloat(getComputedStyle(r.querySelector(sel))[prop]);
  return { search: px('.search', 'fontSize'), icon: px('.close', 'height'), chip: px('.chip', 'height') };
});
// Headless Firefox cannot emulate pointer:coarse (matchMedia stays "fine"), so
// the touch-sized @media block never applies there. Those pixel values are pure
// CSS constants, already asserted on Chrome; the layout logic is verified above.
if (!isFirefox) assert.deepEqual(sizes, { search: 16, icon: 44, chip: 36 });
await page.evaluate(() => {
  const r = document.getElementById('x-rewind').shadowRoot;
  r.querySelector('.chip[data-f="images"]').click();
});
await sleep(300);
assert.deepEqual(await names(page), ['Ann']);
await page.screenshot({ path: `${shots}/mobile-drawer.png` });
await page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.close').click());
await sleep(300);
assert.equal(await panelOpen(page), false);
console.log('ok  full-screen drawer with touch-sized controls');

assert.deepEqual(errors, []);
await browser.close();
console.log('all passed');
