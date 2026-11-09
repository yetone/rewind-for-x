// Reads the text in a post's images, on this device, for search. The service
// worker sends one image at a time; this page keeps a Tesseract worker for
// it and lets the worker go after a quiet spell.
//
// The recognizer ships with the extension; the language data (a few MB)
// is downloaded the first time and kept in IndexedDB. It is downloaded here
// rather than by Tesseract so the drawer can show real progress, and stored
// where Tesseract's worker looks for it (idb-keyval's "keyval-store").
'use strict';

const DATA = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';
const IDLE = 30_000;
const MIN_CONFIDENCE = 60; // words below this are mostly noise from photos

let worker = null;
let workerLangs = '';
let idleTimer = 0;

// ------------------------------------------------------------------ storage

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store');
    req.onupgradeneeded = () => req.result.createObjectStore('keyval');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction('keyval', mode);
      const req = fn(tx.objectStore('keyval'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
const cacheKey = (lang) => `./${lang}.traineddata`;
const cached = async (lang) => (await idb('readonly', (s) => s.getKey(cacheKey(lang)))) !== undefined;

// Download what isn't cached yet, reporting progress across all of it.
async function download(langs) {
  const missing = [];
  for (const l of langs) if (!(await cached(l))) missing.push(l);
  if (!missing.length) return;
  const got = new Map(missing.map((l) => [l, 0]));
  const total = new Map();
  let sent = -1;
  const report = () => {
    let sum = 0;
    for (const l of missing) sum += total.get(l) ? got.get(l) / total.get(l) : 0;
    const p = Math.floor((sum / missing.length) * 100) / 100;
    if (p === sent) return;
    sent = p;
    chrome.runtime.sendMessage({ type: 'ocr-progress', progress: p }).catch(() => {});
  };
  report();
  await Promise.all(missing.map(async (lang) => {
    const url = `${DATA}/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    total.set(lang, Number(res.headers.get('content-length')) || 0);
    const reader = res.body.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got.set(lang, got.get(lang) + value.length);
      report();
    }
    const data = new Uint8Array(await new Blob(parts).arrayBuffer());
    await idb('readwrite', (s) => s.put(data, cacheKey(lang)));
  }));
}

// ------------------------------------------------------------------- reading

async function getWorker(langs) {
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (worker) await worker.terminate().catch(() => {});
  worker = null;
  await download(langs);
  worker = await Tesseract.createWorker(key, Tesseract.OEM.LSTM_ONLY, {
    workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
    corePath: chrome.runtime.getURL('ocr/tesseract-core-simd-lstm.js'),
    langPath: `${DATA}/${langs[0]}/4.0.0_best_int`,
    workerBlobURL: false,
    cacheMethod: 'readOnly',
  });
  // Sparse text: posts' images are screenshots, memes and photos with a
  // caption, not pages. It also reads short CJK lines the default mode
  // gets wrong, and finds less noise in photos.
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
  workerLangs = key;
  return worker;
}

const CJK = '\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef';
const BETWEEN_CJK = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g');
const WORDLIKE = /[\p{L}\p{N}]{2,}/u; // a line of lone letters is noise

// The confident words, line by line; Chinese and Japanese come back with a
// space between every character, which would defeat search.
function textOf(data) {
  const lines = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const words = l.words.filter((w) => w.confidence >= MIN_CONFIDENCE).map((w) => w.text.trim()).filter(Boolean);
        const line = words.join(' ').replace(BETWEEN_CJK, '');
        if (WORDLIKE.test(line)) lines.push(line);
      }
    }
  }
  return lines.join('\n');
}

async function read({ src, langs }) {
  const w = await getWorker(langs);
  let image;
  try {
    const res = await fetch(src);
    if (!res.ok) return { text: '' };
    image = await res.blob();
  } catch {
    return { text: '' }; // gone or offline: nothing to read
  }
  try {
    const { data } = await w.recognize(image, {}, { text: false, blocks: true });
    return { text: textOf(data) };
  } catch {
    return { text: '' }; // not an image Tesseract can open
  }
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.target !== 'ocr') return;
  clearTimeout(idleTimer);
  read(m)
    .then(reply, (e) => reply({ error: String(e?.message || e) }))
    .finally(() => {
      idleTimer = setTimeout(() => {
        worker?.terminate().catch(() => {});
        worker = null;
      }, IDLE);
    });
  return true;
});
