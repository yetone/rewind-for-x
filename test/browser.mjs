// Shared Puppeteer setup for Chrome and Firefox, plus helpers for the
// extension's open shadow DOM (#x-rewind).
//
// Why Puppeteer: Playwright can't load extensions into Firefox. Why UI
// assertions instead of reading chrome.storage: Firefox's background page is
// not exposed through WebDriver BiDi, so we assert against the rendered
// drawer — which also lets the exact same assertions run on both browsers.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');
export const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isFirefox = process.argv.includes('--firefox');

export async function launch({ viewport = { width: 1280, height: 800 }, prefs = {} } = {}) {
  const browser = isFirefox
    ? await puppeteer.launch({
        browser: 'firefox',
        executablePath: process.env.FIREFOX_PATH || undefined,
        headless: true,
        defaultViewport: viewport,
        extraPrefsFirefox: { 'xpinstall.signatures.required': false, 'intl.locale.requested': 'zh-CN', ...prefs },
      })
    : await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || undefined,
        headless: true,
        defaultViewport: viewport,
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--lang=zh-CN', '--no-sandbox'],
      });
  if (isFirefox) await browser.installExtension(EXT);
  return browser;
}

// Serve the mock timeline at https://x.com/* so the real content script runs.
// body may be a function so the theme can change between navigations.
export async function mockX(page, body) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (/^https:\/\/x\.com\//.test(req.url())) {
      req.respond({ contentType: 'text/html', body: typeof body === 'function' ? body() : body }).catch(() => {});
    } else req.continue().catch(() => {});
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openDrawer(page) {
  await page.evaluate(() => {
    const r = document.getElementById('x-rewind').shadowRoot;
    if (!r.querySelector('.panel').classList.contains('open')) r.querySelector('.fab').click();
  });
  await sleep(450);
}

export async function closeDrawer(page) {
  await page.evaluate(() => {
    const r = document.getElementById('x-rewind').shadowRoot;
    if (r.querySelector('.panel').classList.contains('open')) r.querySelector('.fab').click();
  });
  await sleep(300);
}

export const panelOpen = (page) =>
  page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.panel').classList.contains('open'));

export const fabHidden = (page) =>
  page.evaluate(() => document.getElementById('x-rewind')?.shadowRoot.querySelector('.fab').hidden ?? true);

// Every card in the drawer, flattened to the fields the assertions need.
export const cards = (page) =>
  page.evaluate(() => {
    const root = document.getElementById('x-rewind').shadowRoot;
    return [...root.querySelectorAll('a.card')].map((a) => {
      const q = (s) => a.querySelector(s);
      return {
        id: (a.getAttribute('href').match(/status\/(\d+)/) || [])[1],
        url: a.getAttribute('href'),
        target: a.getAttribute('target'),
        name: q('.name')?.textContent,
        handle: q('.handle')?.textContent,
        text: q('.text')?.textContent,
        context: q('.ctx')?.textContent,
        quoteName: q('.quote b')?.textContent,
        quoteText: q('.quote span')?.textContent,
        media: a.querySelectorAll('.media .cell').length,
        play: !!q('.play'),
      };
    });
  });

export const ids = async (page) => (await cards(page)).map((c) => c.id).sort();
export const names = async (page) => (await cards(page)).map((c) => c.name);
export const count = (page) =>
  page.evaluate(() => document.getElementById('x-rewind').shadowRoot.querySelector('.count').textContent);
