// Toolbar icon (or Alt+Shift+R): toggle the drawer on an x.com tab; anywhere
// else, or on an x.com tab opened before the extension was installed, open
// the home timeline.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    chrome.tabs.create({ url: 'https://x.com/home' });
  }
});

// ------------------------------------------------------------ text in images
//
// With "ocrOn" set, every image of a recorded post is read once, newest
// first, and its text kept in "ocr" (src -> text) for the drawer's search.
// "ocrState" tells the drawer how it is going:
// {phase: 'download', progress} | {phase: 'working', left} | {phase: 'ready'}
// | {phase: 'error'}. Everything is worked out again from storage, so a
// service worker that was stopped half way just carries on.

const OCR_DOC = 'ocr/offscreen.html';
const FLUSH_EVERY = 3; // images read between writes

// Chrome MV3 has chrome.offscreen + chrome.runtime.getContexts; Firefox has
// neither. In Firefox the manifest's background.scripts load tesseract.min.js
// and offscreen.js into this same background page, so read() is a global here.
const USE_OFFSCREEN = typeof chrome.offscreen !== 'undefined' && typeof chrome.runtime.getContexts === 'function';

function ocrLangs() {
  const l = chrome.i18n.getUILanguage().toLowerCase();
  const extra = l.startsWith('zh') ? (/tw|hk|mo|hant/.test(l) ? 'chi_tra' : 'chi_sim')
    : l.startsWith('ja') ? 'jpn'
    : l.startsWith('ko') ? 'kor'
    : '';
  return extra ? [extra, 'eng'] : ['eng']; // the first is Tesseract's main language
}

// X serves a post's photo in several sizes; text reads best from the 1200px one.
function sourceFor(src) {
  try {
    const u = new URL(src);
    if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/') && u.searchParams.has('name')) {
      u.searchParams.set('name', 'medium');
      return u.href;
    }
  } catch {}
  return src;
}

// --------- Chrome MV3 offscreen document management ---------

async function hasDoc() {
  if (!USE_OFFSCREEN) return true; // Firefox: OCR lives here, always "present"
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
}
async function openDoc() {
  if (!USE_OFFSCREEN) return;
  if (await hasDoc()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OCR_DOC,
      reasons: ['WORKERS'],
      justification: 'Reads the text in images of posts, on this device, so search can find it.',
    });
  } catch (e) {
    if (!/single offscreen/i.test(String(e?.message))) throw e;
  }
}
async function closeDoc() {
  if (!USE_OFFSCREEN) return;
  if (await hasDoc()) await chrome.offscreen.closeDocument().catch(() => {});
}

// --------- OCR read: two paths depending on environment ---------

async function readImage(src, langs) {
  if (USE_OFFSCREEN) {
    return await chrome.runtime.sendMessage({ target: 'ocr', src, langs });
  }
  // Firefox: offscreen.js runs in this background page, so call read() directly.
  return await read({ src, langs }, (progress) => {
    setState({ phase: 'download', progress });
  });
}

// --------- pump state machine ---------

let lastState = '';
function setState(state) {
  const s = JSON.stringify(state);
  if (s === lastState) return;
  lastState = s;
  return chrome.storage.local.set({ ocrState: state });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'ocr-progress') setState({ phase: 'download', progress: m.progress });
});

let pumping = false;
let again = false;
let failed = false; // stay put after a failed download until asked to retry

async function pumpOnce() {
  const { ocrOn, items = [], ocr = {} } = await chrome.storage.local.get(['ocrOn', 'items', 'ocr']);
  if (!ocrOn) {
    await closeDoc();
    return;
  }
  if (failed) return;

  const keep = new Set();
  const todo = [];
  for (const it of items) {
    for (const src of it.media || []) {
      keep.add(src);
      if (!(src in ocr)) todo.push(src);
    }
  }
  let dirty = false;
  for (const src of Object.keys(ocr)) {
    if (!keep.has(src)) {
      delete ocr[src];
      dirty = true;
    }
  }
  if (!todo.length) {
    if (dirty) await chrome.storage.local.set({ ocr });
    await setState({ phase: 'ready' });
    return;
  }

  await openDoc();
  const langs = ocrLangs();
  let since = 0;
  for (let i = 0; i < todo.length && !again; i++) {
    // The first image may wait on the download, whose progress the
    // offscreen page reports meanwhile; after that, count down.
    if (i === 0 && !lastState.includes('download')) await setState({ phase: 'working', left: todo.length });
    const res = await readImage(sourceFor(todo[i]), langs);
    if (!res || res.error) {
      failed = true;
      console.warn('[rewind] ocr', res?.error);
      if (dirty) await chrome.storage.local.set({ ocr });
      await setState({ phase: 'error' });
      return;
    }
    ocr[todo[i]] = res.text;
    dirty = true;
    if (++since >= FLUSH_EVERY || i === 0) {
      since = 0;
      dirty = false;
      await chrome.storage.local.set({ ocr });
      await setState({ phase: 'working', left: todo.length - i - 1 });
    }
  }
  if (dirty) await chrome.storage.local.set({ ocr });
  if (!again) await setState({ phase: 'ready' });
}

async function pump() {
  if (pumping) {
    again = true;
    return;
  }
  pumping = true;
  try {
    do {
      again = false;
      await pumpOnce();
    } while (again);
  } catch (e) {
    console.warn('[rewind] ocr', e);
  } finally {
    pumping = false;
  }
}

let pumpTimer = 0;
function schedulePump(delay) {
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(pump, delay);
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c.ocrOn || c.ocrRetry) {
    failed = false;
    schedulePump(0);
  } else if (c.items) {
    schedulePump(3000); // posts arrive in bursts while scrolling
  }
});
schedulePump(1000);
