// End-to-end check against a mock of X's timeline markup, served at
// https://x.com/home so the real content script runs.
//   node test/e2e.mjs --chrome     (needs Puppeteer with Chrome)
//   node test/e2e.mjs --firefox    (needs Puppeteer with Firefox)
// Same UI assertions run on both browsers (see test/browser.mjs for why).
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  EXT, launch, mockX, sleep, openDrawer, closeDrawer, panelOpen, fabHidden, cards, ids, names, count,
} from './browser.mjs';

const shots = process.env.SHOTS || path.join(EXT, 'test', 'out');
fs.mkdirSync(shots, { recursive: true });

const pic = (c) =>
  'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${c}"/></svg>`);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: BG; color: FG; font-family: sans-serif; }
  article { height: 300px; border-bottom: 1px solid #888; padding: 10px; box-sizing: border-box; }
  .dock { position: fixed; right: 20px; bottom: 16px; display: flex; flex-direction: column; gap: 12px; }
  .dock button { width: 55px; height: 55px; border-radius: 16px; }
</style></head><body><main><div id="tl"></div></main>
<div class="dock"><button data-testid="GrokDrawerHeader">G</button><button data-testid="chat-drawer-main">C</button></div><script>
  const pic = ${pic.toString()};
  window.tweet = (id, handle, name, text, o = {}) => \`
    <div data-testid="cellInnerDiv"><article data-testid="tweet" role="article">
      \${o.rt ? '<span data-testid="socialContext">' + o.rt + ' reposted</span>' : ''}
      <div data-testid="Tweet-User-Avatar"><img src="\${pic('#c33')}"></div>
      <div data-testid="User-Name"><a href="/\${handle}"><span>\${name}<img alt="🔥" src=""></span></a>
        <div><a href="/\${handle}">@\${handle}</a> · \${o.ad ? '<span>Ad</span>' : '<a href="/' + handle + '/status/' + id + '"><time datetime="2026-11-09T10:00:00.000Z">1h</time></a>'}</div></div>
      <div data-testid="tweetText"><span>\${text}\${o.tr ? '<font class="notranslate immersive-translate-target-wrapper"><br><font class="notranslate immersive-translate-target-translation-block-wrapper">' + o.tr + '</font></font>' : ''}</span></div>
      \${o.video ? '<div data-testid="videoPlayer"><video poster="' + pic('#933') + '#video_thumb"></video></div>' : ''}
      \${(o.photos || []).map(c => '<a href="/' + handle + '/status/' + id + '/photo/1"><div data-testid="tweetPhoto"><img src="' + pic(c) + '"></div></a>').join('')}
      \${o.quote ? '<div role="link" tabindex="0"><div data-testid="User-Name"><div><span>Quoted Person</span></div><div><span>@qp</span><span>·</span><time>2h</time></div></div><a href="/q/status/999"><time datetime="x">2h</time></a><div data-testid="tweetText"><span>' + o.quote + '</span></div><div data-testid="tweetPhoto"><img src="' + pic('#000') + '"></div></div>' : ''}
    </article></div>\`;
  window.setTimeline = (...html) => { document.getElementById('tl').innerHTML = html.join(''); };
  setTimeline(
    tweet('101', 'alice', 'Alice', 'first post of the morning', { photos: ['#36c', '#3c6'] }),
    tweet('102', 'bob', 'Bob', 'second post'),
    tweet('103', 'carol', 'Carol', 'third post'),
    tweet('104', 'dave', 'Dave', 'below the fold'),
  );
</script></body></html>`;

// ---- shadow-DOM helpers local to this test ----
const setSearch = (page, v) => page.evaluate((v) => {
  const s = document.getElementById('x-rewind').shadowRoot.querySelector('.search');
  s.value = v;
  s.dispatchEvent(new Event('input', { bubbles: true }));
}, v);
// Chips are matched by data-f, not by their label text, so the assertions do
// not depend on the browser's UI language (Firefox may run in English).
const clickChip = (page, f) => page.evaluate((f) => {
  const r = document.getElementById('x-rewind').shadowRoot;
  r.querySelector(`.chip[data-f="${f}"]`)?.click();
}, f);
const chipPressed = (page, f) => page.evaluate((f) => {
  const r = document.getElementById('x-rewind').shadowRoot;
  return r.querySelector(`.chip[data-f="${f}"]`)?.getAttribute('aria-pressed');
}, f);
const clearClick = (page) => page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.clear').click());
const resetCount = (page) => page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelectorAll('.reset').length);
const resetClick = (page) => page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.reset')?.click());
const focusSearch = (page) => page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.search').focus());
const rect = (page, sel, inShadow) => page.evaluate((sel, inShadow) => {
  const el = inShadow ? document.getElementById('x-rewind').shadowRoot.querySelector(sel) : document.querySelector(sel);
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, sel, inShadow);

const browser = await launch();
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let theme = { BG: '#fff', FG: '#000' };
await mockX(page, () => PAGE.replace('BG', theme.BG).replace('FG', theme.FG));
await page.goto('https://x.com/home');
await sleep(2500);

// 1. Visible posts are recorded, the one below the fold is not.
await openDrawer(page);
assert.deepEqual(await ids(page), ['101', '102', '103']);
const alice = (await cards(page)).find((c) => c.id === '101');
assert.equal(alice.name, 'Alice🔥');
assert.equal(alice.url, 'https://x.com/alice/status/101');
assert.equal(alice.media, 2);
assert.equal(alice.text, 'first post of the morning');
console.log('ok  visible posts recorded');
await closeDrawer(page);

// 2. The feed refreshes and replaces everything; the old posts stay stored.
await page.evaluate(() =>
  setTimeline(
    tweet('201', 'erin', 'Erin', 'fresh one', { rt: 'Frank', video: true }),
    tweet('202', 'gina', 'Gina', 'my take', { quote: 'the original quoted text', tr: '我的看法' }),
    tweet('900', 'brand', 'Brand', 'buy stuff', { ad: true })
  )
);
await sleep(2500);
await openDrawer(page);
assert.deepEqual(await ids(page), ['101', '102', '103', '201', '202']);
const cs2 = await cards(page);
const gina = cs2.find((c) => c.id === '202');
assert.equal(gina.text, 'my take', "a translation extension's text is left out");
assert.equal(gina.quoteText, 'the original quoted text');
assert.equal(gina.quoteName, 'Quoted Person');
assert.equal(gina.media, 0, "the quoted post's image is not the post's own");
assert.equal(cs2.find((c) => c.id === '201').context, 'Frank reposted');
console.log('ok  replaced posts kept, ads skipped, quotes and reposts parsed');
await closeDrawer(page);

// 3. Off the home timeline nothing is recorded and the button hides.
await page.evaluate(() => {
  history.pushState({}, '', '/someone/status/1');
  setTimeline(tweet('301', 'zed', 'Zed', 'a reply on a thread'));
});
await sleep(1500);
assert.equal(await fabHidden(page), true);
console.log('ok  other pages ignored, button hidden');

// 4. The drawer lists everything newest-first and searches.
await page.evaluate(() => history.pushState({}, '', '/home'));
await sleep(800);
// The button sits in X's column of floating buttons, above Grok, not on it.
const fabBox = await rect(page, '.fab', true);
const grokBox = await rect(page, '[data-testid="GrokDrawerHeader"]', false);
assert.equal(Math.round(fabBox.x + fabBox.width), Math.round(grokBox.x + grokBox.width));
assert.equal(Math.round(grokBox.y - (fabBox.y + fabBox.height)), 12);
await openDrawer(page);
assert.ok(!(await ids(page)).includes('301'), 'the thread reply was never recorded');
assert.equal(await count(page), '5');
assert.equal((await names(page)).length, 5);
assert.equal((await cards(page))[0].target, '_blank');
await page.screenshot({ path: `${shots}/light.png` });
await setSearch(page, 'quoted');
await sleep(400);
assert.deepEqual(await names(page), ['Gina🔥']);
// Typing must not reach X's own keyboard shortcuts.
await page.evaluate(() => {
  window.leaked = 0;
  document.addEventListener('keydown', () => window.leaked++);
});
await focusSearch(page);
await page.keyboard.press('j');
assert.equal(await page.evaluate(() => window.leaked), 0);
console.log('ok  drawer lists and searches');

// 4b. Filter chips narrow the list, together with search.
await setSearch(page, '');
await sleep(400);
await clickChip(page, 'images');
await sleep(300);
assert.deepEqual(await names(page), ['Alice🔥']);
assert.equal(await count(page), '1');
await clickChip(page, 'quotes');
await sleep(300);
assert.deepEqual(await names(page), ['Gina🔥']);
await clickChip(page, 'reposts');
await sleep(300);
assert.deepEqual(await names(page), ['Erin🔥']);
await setSearch(page, 'nothing like this');
await sleep(400);
assert.equal(await resetCount(page), 1);
await setSearch(page, '');
await sleep(400);
await clickChip(page, 'videos');
await sleep(300);
assert.deepEqual(await names(page), ['Erin🔥']);
assert.equal((await cards(page)).filter((c) => c.play).length, 1);
assert.equal(await chipPressed(page, 'videos'), 'true');
await page.mouse.move(600, 30);
await sleep(300);
await page.screenshot({ path: `${shots}/filter.png` });
console.log('ok  filter chips');

// 5. Escape and a click outside close it; clear needs two clicks.
await page.keyboard.press('Escape');
await sleep(300);
assert.equal(await panelOpen(page), false);
await openDrawer(page);
await page.mouse.click(200, 400);
await sleep(300);
assert.equal(await panelOpen(page), false);
await openDrawer(page);
// still the Videos filter: only Erin is listed, so clearing is visible here.
await clearClick(page);
await sleep(200);
assert.equal((await cards(page)).length, 1, 'first click only arms the clear button');
await clearClick(page);
await sleep(200);
assert.equal((await cards(page)).length, 0, 'second click clears');
console.log('ok  escape and outside click close, clear asks twice');

// 6. Dark ("Lights out") theme, with posts again (storage was cleared above).
theme = { BG: 'rgb(0, 0, 0)', FG: '#eee' };
await page.goto('https://x.com/home');
await sleep(2000);
await page.evaluate(() => window.scrollTo(0, 400));
await sleep(2000);
await openDrawer(page);
assert.equal(await page.evaluate(() => document.getElementById('x-rewind').dataset.theme), 'dark');
// The last filter is remembered: Videos again, nothing matches, "show all" resets.
assert.equal(await chipPressed(page, 'videos'), 'true');
assert.equal((await cards(page)).length, 0);
await resetClick(page);
await sleep(300);
assert.equal(await chipPressed(page, 'all'), 'true');
assert.equal(await count(page), '4');
await page.screenshot({ path: `${shots}/dark.png` });
console.log('ok  dark theme; scrolling records the post below the fold');

assert.deepEqual(errors, []);
await browser.close();
console.log('all passed');
