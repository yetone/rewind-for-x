// Searching the text in images: turn it on in the drawer, the language data
// downloads (from jsdelivr, so this needs the network), every image is read,
// and search finds a post by the words in its picture.
//   node test/ocr.mjs --chrome     (needs Puppeteer with Chrome)
//   node test/ocr.mjs --firefox    (needs Puppeteer with Firefox)
// Same UI assertions run on both browsers (see test/browser.mjs for why).
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { EXT, launch, mockX, sleep, openDrawer, names, count } from './browser.mjs';

const shots = process.env.SHOTS || path.join(EXT, 'test', 'out');
fs.mkdirSync(shots, { recursive: true });
const browser = await launch();

// Pictures with words in them, and one without.
const painter = await browser.newPage();
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

const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await mockX(page, PAGE);
await page.goto('https://x.com/home');
await sleep(2500);

// The OCR button and its progress ring are the only status UI on Firefox too;
// its background page storage is not reachable through WebDriver BiDi.
const setSearch = (q) => page.evaluate((q) => {
  const s = document.getElementById('x-rewind').shadowRoot.querySelector('.search');
  s.value = q;
  s.dispatchEvent(new Event('input', { bubbles: true }));
}, q);
const find = async (q) => {
  await setSearch(q);
  await sleep(400);
  return names(page);
};
const ocrClick = () => page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.ocr').click());
const clearClick = () => page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.clear').click());
const ocrState = () => page.evaluate(() => {
  const b = document.getElementById('x-rewind').shadowRoot.querySelector('.ocr');
  const offset = Number(b.querySelector('.ring .bar').getAttribute('stroke-dashoffset'));
  return {
    pressed: b.getAttribute('aria-pressed'),
    loading: b.classList.contains('loading'),
    error: b.classList.contains('error'),
    title: b.title,
    progress: 100 - offset,
  };
});

await openDrawer(page);
assert.equal((await names(page)).length, 3);
const chineseUI = await page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.search').placeholder === '搜索');
const idleTitle = (await ocrState()).title;
assert.equal((await ocrState()).pressed, 'false');
assert.deepEqual(await find('rewind'), [], 'off: only the post text is searched');
console.log('ok  off by default');

// Turn it on: the ring fills while the language data downloads.
const t0 = Date.now();
await ocrClick();
assert.equal((await ocrState()).pressed, 'true');
await page.waitForFunction(() => {
  const b = document.getElementById('x-rewind').shadowRoot.querySelector('.ocr');
  return b.classList.contains('loading') || b.classList.contains('error');
}, { timeout: 30_000 });
assert.equal((await ocrState()).error, false, 'download failed');
await page.mouse.move(10, 790);
await sleep(400);
await page.screenshot({ path: `${shots}/ocr-download.png` });
const progress = [];
for (;;) {
  const s = await ocrState();
  assert.equal(s.error, false, 'download or reading failed');
  if (!s.loading && s.title === idleTitle) break; // ready, in either UI language
  if (s.loading) progress.push(s.progress);
  assert.ok(Date.now() - t0 < 180_000, `stuck at ${JSON.stringify(s)}`);
  await sleep(200);
}
console.log(`    ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, progress seen: ${[...new Set(progress)].slice(0, 8).join(' ')}…`);
assert.ok(new Set(progress).size > 2, 'progress moves in steps, not all at once');
assert.equal((await ocrState()).loading, false);
console.log('ok  downloads with progress and reads every image');

assert.deepEqual(await find('hello rewind'), ['Ann']);
if (chineseUI) {
  assert.deepEqual(await find('图片里'), ['Ben']);
  assert.deepEqual(await find('明天见'), ['Ben']);
  // Tesseract puts a space between Chinese and digits ("11 月 9 日"), and a
  // phrase can run over a line break; neither stops a match.
  assert.deepEqual(await find('11月9日'), ['Ben']);
  assert.deepEqual(await find('文字明天'), ['Ben']);
  await find('图片里');
} else {
  // Without a Chinese browser language pack Firefox selects English OCR only.
  // Chinese recognition is covered by the Chrome run with a Chinese UI.
  console.log('    English UI: skipping Chinese OCR assertions');
}
await page.mouse.move(10, 790);
await sleep(300);
await page.screenshot({ path: `${shots}/ocr-search.png` });
console.log('ok  search finds posts by the words in their images');

// Off again: images are left out of search; on again: nothing to download.
await ocrClick();
assert.deepEqual(await find('hello rewind'), []);
await ocrClick();
assert.deepEqual(await find('hello rewind'), ['Ann']);
await sleep(1500);
assert.equal((await ocrState()).title, idleTitle);
assert.equal((await ocrState()).loading, false);
console.log('ok  toggles; the second time needs no download');

// Clearing the list also empties the drawer while an image-text search is on.
await clearClick();
await clearClick();
await sleep(400);
assert.deepEqual(await find('hello rewind'), []);
assert.equal(await count(page), '');
console.log('ok  clearing empties the list');

assert.deepEqual(errors, []);
await browser.close();
console.log('all passed');
