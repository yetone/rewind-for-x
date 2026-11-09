// Searching the text in images: turn it on in the drawer, the language data
// downloads (from jsdelivr, so this needs the network), every image is read,
// and search finds a post by the words in its picture.
//   node test/ocr.mjs   (needs Playwright with Chromium)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS || path.join(ext, 'test', 'out');
fs.mkdirSync(shots, { recursive: true });

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  locale: 'zh-CN',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--lang=zh-CN'],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const get = async (k) => (await sw.evaluate((k) => chrome.storage.local.get(k), k))[k];

// Pictures with words in them, and one without.
const painter = await ctx.newPage();
const paint = (lines, bg) => painter.evaluate(([lines, bg]) => {
  const c = Object.assign(document.createElement('canvas'), { width: 900, height: 500 });
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 900, 500);
  g.fillStyle = '#111';
  g.font = 'bold 64px "PingFang SC", "Noto Sans CJK SC", sans-serif';
  lines.forEach((l, i) => g.fillText(l, 60, 160 + i * 110));
  if (!lines.length) {
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `hsl(${i * 37 % 360} 60% 50%)`;
      g.beginPath();
      g.arc((i * 97) % 900, (i * 53) % 500, 18, 0, 7);
      g.fill();
    }
  }
  return c.toDataURL('image/png');
}, [lines, bg]);
const pics = {
  en: await paint(['Hello Rewind', 'Meeting at 3pm'], '#fff'),
  zh: await paint(['图片里的文字', '明天见', '11月9日 3点'], '#f5f0e0'),
  none: await paint([], '#9bd'),
};
await painter.close();

const tweet = (id, handle, name, text, src) => `
  <div data-testid="cellInnerDiv"><article data-testid="tweet" role="article">
    <div data-testid="User-Name"><a href="/${handle}"><span>${name}</span></a>
      <div><a href="/${handle}">@${handle}</a> · <a href="/${handle}/status/${id}"><time datetime="2026-11-09T10:00:00.000Z">1h</time></a></div></div>
    <div data-testid="tweetText"><span>${text}</span></div>
    <a href="/${handle}/status/${id}/photo/1"><div data-testid="tweetPhoto"><img src="${src}"></div></a>
  </article></div>`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; } article { height: 240px; overflow: hidden; } img { height: 120px; }
</style></head><body><main>
${tweet('11', 'ann', 'Ann', 'look', pics.en)}${tweet('12', 'ben', 'Ben', '看图', pics.zh)}${tweet('13', 'cy', 'Cy', 'dots', pics.none)}
</main></body></html>`;
await ctx.route(/^https:\/\/x\.com\//, (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));

const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('https://x.com/home');
await page.waitForFunction(() => document.getElementById('x-rewind'));
await page.waitForTimeout(2500);
assert.equal((await get('items')).length, 3);

const names = () => page.locator('#x-rewind .card .name').allTextContents();
const find = async (q) => {
  await page.locator('#x-rewind .search').fill(q);
  return names();
};
await page.locator('#x-rewind .fab').click();
const ocrBtn = page.locator('#x-rewind .ocr');
assert.equal(await ocrBtn.getAttribute('aria-pressed'), 'false');
assert.deepEqual(await find('rewind'), [], 'off: only the post text is searched');
console.log('ok  off by default');

// Turn it on: the ring fills while the language data downloads.
const t0 = Date.now();
await ocrBtn.click();
assert.equal(await ocrBtn.getAttribute('aria-pressed'), 'true');
await page.waitForFunction(() => document.getElementById('x-rewind').shadowRoot.querySelector('.ocr.loading'), null, { timeout: 30_000 });
await page.mouse.move(10, 790);
await page.waitForTimeout(400);
await page.screenshot({ path: `${shots}/ocr-download.png` });
const progress = [];
for (let s; (s = await get('ocrState'))?.phase !== 'ready';) {
  assert.notEqual(s?.phase, 'error', 'download or reading failed');
  if (s?.phase === 'download') progress.push(s.progress);
  assert.ok(Date.now() - t0 < 180_000, `stuck at ${JSON.stringify(s)}`);
  await page.waitForTimeout(200);
}
console.log(`    ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, progress seen: ${[...new Set(progress)].slice(0, 8).join(' ')}…`);
assert.ok(new Set(progress).size > 2, 'progress moves in steps, not all at once');
assert.equal(await ocrBtn.evaluate((b) => b.classList.contains('loading')), false);

const ocr = await get('ocr');
const items = await get('items');
const textOf = (h) => ocr[items.find((i) => i.handle === h).media[0]];
console.log('    read:', JSON.stringify({ ann: textOf('ann'), ben: textOf('ben'), cy: textOf('cy') }));
assert.match(textOf('ann'), /Hello Rewind/i);
assert.match(textOf('ben'), /图片里的文字/);
assert.equal(textOf('cy').length < 4, true, 'a picture without words reads as (next to) nothing');
console.log('ok  downloads with progress, reads every image');

assert.deepEqual(await find('hello rewind'), ['Ann']);
assert.deepEqual(await find('图片里'), ['Ben']);
assert.deepEqual(await find('明天见'), ['Ben']);
// Tesseract puts a space between Chinese and digits ("11 月 9 日"), and a
// phrase can run over a line break; neither stops a match.
assert.deepEqual(await find('11月9日'), ['Ben']);
assert.deepEqual(await find('文字明天'), ['Ben']);
await page.locator('#x-rewind .search').fill('图片里');
await page.mouse.move(10, 790);
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/ocr-search.png` });
console.log('ok  search finds posts by the words in their images');

// Off again: images are left out of search; on again: nothing to download.
await ocrBtn.click();
assert.deepEqual(await find('hello rewind'), []);
await ocrBtn.click();
assert.deepEqual(await find('hello rewind'), ['Ann']);
await page.waitForTimeout(1500);
assert.equal((await get('ocrState')).phase, 'ready');
console.log('ok  toggles; the second time needs no download');

// Clearing the list drops what was read from its images.
await page.locator('#x-rewind .clear').click();
await page.locator('#x-rewind .clear').click();
await page.waitForFunction(async () => true);
for (let i = 0; i < 40 && Object.keys((await get('ocr')) || {}).length; i++) await page.waitForTimeout(250);
assert.deepEqual(await get('ocr'), {});
console.log('ok  clearing drops the text too');

assert.deepEqual(errors, []);
await ctx.close();
console.log('all passed');
