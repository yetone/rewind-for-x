(() => {
  'use strict';

  const MAX_ITEMS = 3000; // oldest are dropped beyond this
  const PAGE = 80; // cards rendered per "page" in the drawer
  const SESSION_GAP = 10 * 60 * 1000; // a gap this long starts a new divider
  const TWEET = 'article[data-testid="tweet"]';

  const t = (k, ...subs) => chrome.i18n.getMessage(k, subs.map(String)) || k;
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };
  const isHome = () => location.pathname === '/home';

  /** id -> item. Items: {id, url, handle, name, avatar, text, quote, media[], context, postedAt, seenAt} */
  const items = new Map();

  // ---------------------------------------------------------------- extraction

  const TRANSLATION = '[class*="immersive-translate-target"]';

  function textOf(el) {
    let out = '';
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) out += c.nodeValue;
        else if (c.nodeType === Node.ELEMENT_NODE) {
          // Translations a page-translation extension wrote into the post.
          if (c.matches(TRANSLATION)) continue;
          if (c.tagName === 'IMG') out += c.getAttribute('alt') || '';
          else if (c.tagName === 'BR') out += '\n';
          else walk(c);
        }
      }
    })(el);
    return out.trim();
  }

  // A quoted post sits in a div[role=link] inside the article.
  function inQuote(el, article) {
    const q = el.closest('div[role="link"]');
    return !!q && article.contains(q);
  }
  const own = (article, sel) => [...article.querySelectorAll(sel)].find((e) => !inQuote(e, article));
  const quoted = (article, sel) => [...article.querySelectorAll(sel)].find((e) => inQuote(e, article));
  // User-Name holds the display name, then "@handle · time".
  const displayName = (block) => textOf(block.firstElementChild || block).split('\n')[0].trim();

  function extract(article) {
    // Ads have no timestamp link; skip them.
    const time = own(article, 'a[href*="/status/"] time');
    if (!time) return null;
    const m = time.closest('a').getAttribute('href').match(/^\/([^/?#]+)\/status\/(\d+)/);
    if (!m) return null;
    const [, handle, id] = m;

    const nameBlock = own(article, '[data-testid="User-Name"]');
    const name = (nameBlock && displayName(nameBlock)) || handle;
    const text = own(article, '[data-testid="tweetText"]');
    const quoteText = quoted(article, '[data-testid="tweetText"]');
    const quoteName = quoted(article, '[data-testid="User-Name"]');
    const avatar = own(article, '[data-testid="Tweet-User-Avatar"] img');
    const context = article.querySelector('[data-testid="socialContext"]');

    const media = [];
    const mediaEls = article.querySelectorAll(
      '[data-testid="tweetPhoto"] img, [data-testid="videoPlayer"] video[poster], [data-testid="card.wrapper"] img'
    );
    for (const el of mediaEls) {
      if (inQuote(el, article)) continue;
      const src = el.tagName === 'VIDEO' ? el.getAttribute('poster') : el.currentSrc || el.src;
      if (src && !src.startsWith('blob:') && !media.includes(src)) media.push(src);
      if (media.length === 4) break;
    }

    return {
      id,
      url: `https://x.com/${handle}/status/${id}`,
      handle,
      name,
      avatar: avatar?.src || '',
      text: text ? textOf(text) : '',
      quote: quoteText
        ? { name: quoteName ? displayName(quoteName) : '', text: textOf(quoteText) }
        : null,
      media,
      context: context ? textOf(context) : '',
      postedAt: time.getAttribute('datetime') || '',
    };
  }

  // ------------------------------------------------------------------ storage

  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 800);
  }
  function sorted() {
    return [...items.values()].sort((a, b) => b.seenAt - a.seenAt);
  }
  function save() {
    if (!alive()) return;
    const arr = sorted().slice(0, MAX_ITEMS);
    if (arr.length < items.size) {
      items.clear();
      for (const it of arr) items.set(it.id, it);
    }
    chrome.storage.local.set({ items: arr }).catch(() => {});
  }

  // Merge what another x.com tab saved; the earliest sighting wins.
  function merge(list) {
    let changed = false;
    for (const it of list || []) {
      const prev = items.get(it.id);
      if (!prev) {
        items.set(it.id, it);
        changed = true;
      } else if (it.seenAt < prev.seenAt) {
        prev.seenAt = it.seenAt;
        changed = true;
      }
    }
    return changed;
  }

  function record(article) {
    if (!alive()) return;
    const data = extract(article);
    if (!data) return;
    const prev = items.get(data.id);
    if (prev) {
      // Keep the first sighting time; take fields that have since loaded.
      const next = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v) ? v.length > prev[k].length : v && !prev[k]) next[k] = v;
      }
      if (JSON.stringify(next) === JSON.stringify(prev)) return;
      items.set(data.id, next);
    } else {
      items.set(data.id, { ...data, seenAt: Date.now() });
    }
    scheduleSave();
    if (open) scheduleRender();
  }

  // ---------------------------------------------------------------- watching

  // A post counts as seen once half of it (or 40% of the screen, for tall
  // ones) is on screen. Images often arrive a moment later, so look again.
  const io = new IntersectionObserver(
    (entries) => {
      if (!isHome()) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const shown = e.intersectionRect.height;
        if (shown >= Math.min(e.boundingClientRect.height * 0.5, innerHeight * 0.4)) {
          record(e.target);
          const el = e.target;
          setTimeout(() => el.isConnected && isHome() && record(el), 1500);
        }
      }
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] }
  );
  const observed = new Set();
  let scanQueued = false;
  function scan() {
    scanQueued = false;
    for (const el of observed) {
      if (!el.isConnected) {
        io.unobserve(el);
        observed.delete(el);
      }
    }
    for (const el of document.querySelectorAll(TWEET)) {
      if (!observed.has(el)) {
        observed.add(el);
        io.observe(el);
      }
    }
  }
  const mo = new MutationObserver(() => {
    if (!alive()) {
      mo.disconnect();
      io.disconnect();
      return;
    }
    if (!scanQueued) {
      scanQueued = true;
      requestAnimationFrame(scan);
    }
  });

  // ---------------------------------------------------------------------- UI

  const svg = (d, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON_REWIND = svg('M12 3.5a8.5 8.5 0 1 1-8.3 10.3h2.06A6.5 6.5 0 1 0 7.4 7.4L10 10H3.5V3.5l2.5 2.5A8.47 8.47 0 0 1 12 3.5Zm-1 4.25h1.75v4.27l3.13 1.8-.88 1.52-4-2.31V7.75Z');
  const ICON_CLOSE = svg('M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4Z');
  const ICON_SEARCH = svg('M10.25 3.75a6.5 6.5 0 1 0 3.96 11.65l4.32 4.32 1.41-1.41-4.32-4.32A6.5 6.5 0 0 0 10.25 3.75Zm-4.5 6.5a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0Z', 'lead');
  const ICON_TRASH = svg('M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h2l.8 10h6.4L16 9h2l-.95 12H6.95L6 9Zm4 1.5h1.5V17H10v-6.5Zm2.5 0H14V17h-1.5v-6.5Z');
  const ICON_REPOST = 'M4.5 3.88 8.93 8.02 7.57 9.48 5.5 7.55V16c0 1.1.9 2 2 2H13v2H7.5c-2.21 0-4-1.79-4-4V7.55L1.43 9.48.07 8.02 4.5 3.88ZM16.5 6H11V4h5.5c2.21 0 4 1.79 4 4v8.45l2.07-1.93 1.36 1.46-4.43 4.14-4.43-4.14 1.36-1.46 2.07 1.93V8c0-1.1-.9-2-2-2Z';
  const ICON_PLAY = svg('M8 5.14v13.72L19 12 8 5.14Z');
  const ICON_OCR = svg('M3.5 3.5h5v2h-3v3h-2v-5Zm12 0h5v5h-2v-3h-3v-2Zm-12 12h2v3h3v2h-5v-5Zm15 0h2v5h-5v-2h3v-3ZM8 8h8v2h-3v6h-2v-6H8V8Z', 'glyph');

  const CSS = `
    :host { all: initial; }
    :host {
      --bg: #fff; --fg: #0f1419; --muted: #536471; --line: #eff3f4; --edge: #cfd9de;
      --hover: rgba(15,20,25,.03); --press: rgba(15,20,25,.1); --field: #eff3f4; --accent: #1d9bf0; --danger: #f4212e;
      --sheet-edge: transparent; --sheet-shadow: 0 0 30px rgba(101,119,134,.22), 0 0 4px rgba(101,119,134,.12);
      --dock-bg: rgba(255,255,255,.85); --dock-glow: 0 0 15px rgba(101,119,134,.2), 0 0 3px 1px rgba(101,119,134,.15);
      font: 15px/20px TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    :host([data-theme="dim"]) {
      --bg: #15202b; --fg: #f7f9f9; --muted: #8b98a5; --line: #38444d; --edge: #536471;
      --hover: rgba(247,249,249,.03); --press: rgba(247,249,249,.1); --field: #273340;
      --sheet-edge: #38444d; --sheet-shadow: none;
      --dock-bg: rgba(21,32,43,.65); --dock-glow: 0 0 15px rgba(255,255,255,.2), 0 0 3px 1px rgba(255,255,255,.15);
    }
    :host([data-theme="dark"]) {
      --bg: #000; --fg: #e7e9ea; --muted: #71767b; --line: #2f3336; --edge: #4b4e52;
      --hover: rgba(231,233,234,.03); --press: rgba(231,233,234,.1); --field: #202327;
      --sheet-edge: #2f3336; --sheet-shadow: none;
      --dock-bg: rgba(0,0,0,.65); --dock-glow: 0 0 15px rgba(255,255,255,.2), 0 0 3px 1px rgba(255,255,255,.15);
    }
    * { box-sizing: border-box; }
    svg { width: 20px; height: 20px; fill: currentColor; display: block; flex: none; }
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
    :focus { outline: none; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Sits in X's own column of floating buttons (Grok, chat), same shape. */
    .fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
      width: 55px; height: 55px; border-radius: 16px; display: grid; place-items: center;
      background: var(--dock-bg); color: var(--fg); border: 1px solid var(--edge); box-shadow: var(--dock-glow);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      transition: background-color .2s ease, transform .12s cubic-bezier(.23,1,.32,1);
    }
    .fab svg { width: 28px; height: 28px; }
    .fab:active { transform: scale(.97); }
    .fab[hidden] { display: none; }
    @media (hover: hover) and (pointer: fine) { .fab:hover { background: var(--field); } }

    .panel {
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483001;
      width: min(440px, 100vw); display: flex; flex-direction: column;
      background: var(--bg); border-left: 1px solid var(--sheet-edge); box-shadow: var(--sheet-shadow);
      transform: translateX(100%); visibility: hidden;
      transition: transform .18s cubic-bezier(.23,1,.32,1), visibility 0s linear .18s;
    }
    .panel.open {
      transform: none; visibility: visible;
      transition: transform .26s cubic-bezier(.23,1,.32,1), visibility 0s;
    }
    @media (prefers-reduced-motion: reduce) {
      .panel { transform: none; opacity: 0; transition: opacity .18s ease, visibility 0s linear .18s; }
      .panel.open { opacity: 1; transition: opacity .18s ease, visibility 0s; }
    }

    header { padding: env(safe-area-inset-top, 0px) 16px 12px; border-bottom: 1px solid var(--line); }
    .row { display: flex; align-items: center; gap: 4px; height: 53px; }
    h2 { margin: 0; font-size: 20px; line-height: 24px; font-weight: 800; }
    .count { margin-left: 6px; color: var(--muted); font-size: 15px; font-variant-numeric: tabular-nums; }
    .spacer { flex: 1; }
    .icon {
      height: 36px; min-width: 36px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      color: var(--fg); transition: background-color .2s ease, color .2s ease;
    }
    .icon:active { background: var(--press); }
    .clear { color: var(--muted); }
    .clear .label { display: none; font-size: 14px; font-weight: 700; }
    .clear.armed { color: var(--danger); padding: 0 12px 0 10px; background: rgba(244,33,46,.1); }
    .clear.armed .label { display: inline; }
    @media (hover: hover) and (pointer: fine) {
      .icon:hover { background: var(--hover); }
      .clear:hover { color: var(--danger); background: rgba(244,33,46,.1); }
    }
    .field { position: relative; }
    .field .lead { position: absolute; left: 16px; top: 12px; width: 18px; height: 18px; color: var(--muted); pointer-events: none; }
    .search {
      width: 100%; height: 42px; padding: 0 48px 0 44px; border-radius: 999px;
      border: 1px solid transparent; background: var(--field); color: var(--fg); font: inherit; outline: none;
    }
    .search:focus { border-color: var(--accent); background: var(--bg); }
    .search:focus + .lead { color: var(--accent); }
    .search::placeholder { color: var(--muted); }
    .search::-webkit-search-cancel-button { display: none; }
    /* Text in images: a toggle at the end of the search box. While the
       language data downloads, a ring around it fills up. */
    .ocr {
      position: absolute; right: 3px; top: 3px; width: 36px; height: 36px; border-radius: 999px;
      display: grid; place-items: center; color: var(--muted); transition: background-color .2s ease, color .2s ease;
    }
    .ocr svg { grid-area: 1 / 1; }
    .ocr .glyph { width: 18px; height: 18px; }
    .ocr[aria-pressed="true"] { color: var(--accent); }
    .ocr.error { color: var(--danger); }
    .ocr:active { background: var(--press); }
    .ring { width: 32px; height: 32px; transform: rotate(-90deg); opacity: 0; transition: opacity .2s ease; }
    .ring circle { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    .ring .track { opacity: .2; }
    .ring .bar { stroke-dasharray: 100; transition: stroke-dashoffset .2s linear; }
    .ocr.loading .ring { opacity: 1; }
    @media (hover: hover) and (pointer: fine) { .ocr:hover { background: var(--hover); } }
    .chips { display: flex; gap: 8px; margin: 12px -16px 0; padding: 0 16px; overflow-x: auto; scrollbar-width: none; }
    .chips::-webkit-scrollbar { display: none; }
    .chip {
      flex: none; height: 32px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--edge);
      font-size: 14px; line-height: 30px; font-weight: 700; color: var(--fg);
      transition: background-color .12s ease, color .12s ease, border-color .12s ease;
    }
    .chip[aria-pressed="true"] { background: var(--fg); border-color: var(--fg); color: var(--bg); }
    .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (hover: hover) and (pointer: fine) { .chip[aria-pressed="false"]:hover { background: var(--hover); } }

    .list { flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding-bottom: env(safe-area-inset-bottom, 0px); }
    .sep {
      position: sticky; top: 0; z-index: 1; padding: 10px 16px 8px;
      font-size: 13px; line-height: 16px; font-weight: 700; color: var(--muted);
      background: var(--bg); border-bottom: 1px solid var(--line);
    }
    .card {
      display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line);
      color: inherit; text-decoration: none; transition: background-color .2s ease;
    }
    .card:focus-visible { outline-offset: -2px; }
    @media (hover: hover) and (pointer: fine) { .card:hover { background: var(--hover); } }
    .avatar {
      width: 40px; height: 40px; border-radius: 50%; flex: none; object-fit: cover; background: var(--field);
      display: grid; place-items: center; font-weight: 700; color: var(--muted); overflow: hidden;
    }
    .body { min-width: 0; flex: 1; }
    .ctx { display: flex; align-items: center; gap: 6px; margin: -2px 0 2px; color: var(--muted); font-size: 13px; line-height: 16px; font-weight: 700; }
    .ctx svg { width: 14px; height: 14px; }
    .meta { display: flex; gap: 4px; white-space: nowrap; min-width: 0; }
    .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
    .handle, .ago { color: var(--muted); }
    .handle { overflow: hidden; text-overflow: ellipsis; flex: 0 1000 auto; }
    .ago { flex: none; }
    .text {
      margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden;
    }
    .quote { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--edge); border-radius: 16px; font-size: 14px; line-height: 18px; }
    .quote b { display: block; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quote span { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
    .media {
      position: relative; margin-top: 10px; display: grid; gap: 2px; aspect-ratio: 16 / 9;
      border-radius: 16px; overflow: hidden; border: 1px solid var(--edge); background: var(--edge);
    }
    .media.n2, .media.n4 { grid-template-columns: 1fr 1fr; }
    .media.n3 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
    .media.n3 .cell:first-child { grid-row: span 2; }
    .media.n4 { grid-template-rows: 1fr 1fr; }
    .cell { position: relative; min-height: 0; background: var(--field); }
    .cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .play {
      position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
      display: grid; place-items: center; background: rgba(15,20,25,.6); color: #fff; border: 2px solid #fff;
    }
    .play svg { width: 22px; height: 22px; margin-left: 2px; }
    .note { padding: 56px 40px; text-align: center; color: var(--muted); }
    .note svg { width: 40px; height: 40px; margin: 0 auto 12px; opacity: .6; }
    .note p { margin: 0; }

    /* Phones: the drawer covers the screen, controls are finger-sized, and
       the search box is 16px so iOS doesn't zoom in on focus. */
    @media (max-width: 500px) {
      .panel { border-left: 0; box-shadow: none; }
    }
    @media (pointer: coarse) {
      .icon { height: 44px; min-width: 44px; }
      .search { height: 44px; font-size: 16px; }
      .field .lead { top: 13px; }
      .ocr { top: 4px; }
      .chip { height: 36px; line-height: 34px; }
      .fab { -webkit-tap-highlight-color: transparent; }
      .card, .chip, .icon, .reset, .ocr { -webkit-tap-highlight-color: transparent; }
    }
    .note .reset {
      margin-top: 16px; height: 36px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--edge);
      color: var(--fg); font-size: 14px; font-weight: 700;
    }
  `;

  // Drawer filters: [id, message key, test]. A video's poster is a
  // video_thumb (GIFs too); a link card's picture is not an image of the post.
  const isVideo = (src) => /video_thumb/.test(src);
  const isImage = (src) => !isVideo(src) && !/\/card_img\//.test(src);
  const FILTERS = [
    ['all', 'filterAll', () => true],
    ['images', 'filterImages', (i) => i.media.some(isImage)],
    ['videos', 'filterVideos', (i) => i.media.some(isVideo)],
    ['quotes', 'filterQuotes', (i) => !!i.quote],
    ['reposts', 'filterReposts', (i) => !!i.context],
  ];

  const host = document.createElement('div');
  host.id = 'x-rewind';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <button class="fab" hidden aria-label="${t('title')}" title="${t('title')}">${ICON_REWIND}</button>
    <aside class="panel" role="dialog" aria-label="${t('title')}">
      <header>
        <div class="row">
          <h2>${t('title')}</h2><span class="count"></span><span class="spacer"></span>
          <button class="icon clear" aria-label="${t('clear')}" title="${t('clear')}">${ICON_TRASH}<span class="label">${t('confirmClear')}</span></button>
          <button class="icon close" aria-label="${t('close')}" title="${t('close')}">${ICON_CLOSE}</button>
        </div>
        <div class="field">
          <input class="search" type="search" placeholder="${t('search')}" autocomplete="off" spellcheck="false">${ICON_SEARCH}
          <button class="ocr" aria-pressed="false" aria-label="${t('ocr')}" title="${t('ocr')}">${ICON_OCR}<svg class="ring" viewBox="0 0 32 32" aria-hidden="true"><circle class="track" cx="16" cy="16" r="15"/><circle class="bar" cx="16" cy="16" r="15" pathLength="100" stroke-dashoffset="100"/></svg></button>
        </div>
        <div class="chips" role="group" aria-label="${t('filter')}">${FILTERS.map(([id, key]) =>
          `<button class="chip" data-f="${id}" aria-pressed="false">${t(key)}</button>`).join('')}</div>
      </header>
      <div class="list"></div>
    </aside>`;
  const $ = (s) => root.querySelector(s);
  const fab = $('.fab');
  const panel = $('.panel');
  const list = $('.list');
  const search = $('.search');
  const count = $('.count');
  const clearBtn = $('.clear');
  const chips = $('.chips');
  const ocrBtn = $('.ocr');
  const ring = $('.ring .bar');
  let filter = 'all';
  function setFilter(id, save) {
    if (!FILTERS.some(([f]) => f === id)) id = 'all';
    filter = id;
    for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.f === id));
    if (save && alive()) chrome.storage.local.set({ filter: id }).catch(() => {});
  }

  // Text read from images (src -> text), and how the reading is going.
  let ocr = {};
  let ocrOn = false;
  let ocrState = null;
  function showOcr() {
    const phase = ocrOn ? ocrState?.phase : '';
    const loading = phase === 'download';
    ocrBtn.setAttribute('aria-pressed', String(ocrOn));
    ocrBtn.classList.toggle('loading', loading);
    ocrBtn.classList.toggle('error', phase === 'error');
    if (loading) ring.setAttribute('stroke-dashoffset', String(100 - Math.round(ocrState.progress * 100)));
    ocrBtn.title = loading ? t('ocrDownloading', Math.round(ocrState.progress * 100))
      : phase === 'working' && ocrState.left ? t('ocrWorking', ocrState.left)
      : phase === 'error' ? t('ocrError')
      : t('ocr');
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    }
    for (const k of kids) if (k) el.append(k);
    return el;
  }

  const lang = chrome.i18n.getUILanguage();
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'narrow' });
  const clock = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' });
  const yearFmt = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric' });
  // When the post was written, the way X shows it: relative for a day, then a date.
  function posted(ts) {
    const s = Math.round((ts - Date.now()) / 1000);
    if (s > -60) return rtf.format(0, 'second');
    if (s > -3600) return rtf.format(Math.round(s / 60), 'minute');
    if (s > -86400) return rtf.format(Math.round(s / 3600), 'hour');
    return (new Date(ts).getFullYear() === new Date().getFullYear() ? dayFmt : yearFmt).format(ts);
  }
  function sessionLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const day = d >= today ? t('today') : d >= today - 86400000 ? t('yesterday') : dayFmt.format(d);
    return `${day} ${clock.format(d)}`;
  }

  function avatar(it) {
    if (it.avatar) return h('img', { class: 'avatar', src: it.avatar, loading: 'lazy', alt: '' });
    return h('div', { class: 'avatar', text: [...(it.name || it.handle)][0]?.toUpperCase() || '' });
  }

  function card(it) {
    const media = it.media.length
      ? h('div', { class: `media n${it.media.length}` },
          ...it.media.map((src) => h('div', { class: 'cell' },
            h('img', { src, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer' }),
            isVideo(src) ? h('div', { class: 'play', html: ICON_PLAY }) : null)))
      : null;
    const when = Date.parse(it.postedAt);
    return h('a', { class: 'card', href: it.url, target: '_blank', rel: 'noopener' },
      avatar(it),
      h('div', { class: 'body' },
        it.context ? h('div', { class: 'ctx', html: svg(ICON_REPOST) }, it.context) : null,
        h('div', { class: 'meta' },
          h('span', { class: 'name', text: it.name }),
          h('span', { class: 'handle', text: `@${it.handle}` }),
          h('span', { class: 'ago', text: `· ${posted(Number.isNaN(when) ? it.seenAt : when)}` })),
        it.text ? h('div', { class: 'text', text: it.text }) : null,
        it.quote ? h('div', { class: 'quote' }, it.quote.name ? h('b', { text: it.quote.name }) : null, h('span', { text: it.quote.text })) : null,
        media));
  }

  let open = false;
  let pages = 1;
  let shown = [];

  // Whether there is a space between Chinese or Japanese and a word or a
  // number varies by writer, and text read from images always has one; it
  // shouldn't decide whether a search matches.
  const CJK = '\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef';
  const NEAR_CJK = new RegExp(`(?<=[${CJK}])\\s+|\\s+(?=[${CJK}])`, 'g');
  const norm = (s) => s.toLowerCase().replace(NEAR_CJK, '');

  function render() {
    const q = norm(search.value.trim());
    shown = sorted();
    if (filter !== 'all') shown = shown.filter(FILTERS.find(([f]) => f === filter)[2]);
    if (q) {
      shown = shown.filter((i) =>
        norm(`${i.name}\n${i.handle}\n${i.text}\n${i.context}\n${i.quote ? `${i.quote.name}\n${i.quote.text}` : ''}${
          ocrOn ? i.media.map((src) => `\n${ocr[src] || ''}`).join('') : ''}`).includes(q)
      );
    }
    count.textContent = shown.length ? String(shown.length) : '';

    // New posts land on top; keep what the reader is looking at in place.
    const top = list.scrollTop;
    const before = list.scrollHeight;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const it of shown.slice(0, pages * PAGE)) {
      if (!last || last - it.seenAt > SESSION_GAP) frag.append(h('div', { class: 'sep', text: sessionLabel(it.seenAt) }));
      last = it.seenAt;
      frag.append(card(it));
    }
    if (!shown.length) {
      frag.append(h('div', { class: 'note', html: items.size ? ICON_SEARCH.replace(' class="lead"', '') : ICON_REWIND },
        h('p', { text: items.size ? t('noMatch') : t('empty') }),
        items.size && filter !== 'all' ? h('button', { class: 'reset', text: t('showAll') }) : null));
    }
    list.replaceChildren(frag);
    if (top > 0) list.scrollTop = top + (list.scrollHeight - before);
  }
  let renderTimer = 0;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 300);
  }

  function theme() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    const [r, g, b] = (m || [255, 255, 255]).map(Number);
    host.dataset.theme = r + g + b > 600 ? 'light' : r + g + b < 10 ? 'dark' : 'dim';
  }

  // Stack the button on top of X's own floating buttons (Grok, chat) so it
  // never covers them; with none on screen it takes the corner.
  // On a phone X has a tab bar along the bottom and a compose button above it.
  const DOCK = '[data-testid="GrokDrawerHeader"], [data-testid="chat-drawer-main"], [data-testid^="FloatingActionButtons"]';
  const TAB_BAR = '[data-testid="BottomBar"]';
  function place() {
    let top = Infinity;
    let right = 0;
    for (const el of document.querySelectorAll(DOCK)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.top < 80) continue;
      if (r.top < top) [top, right] = [r.top, r.right];
    }
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let pos = top === Infinity ? ['20px', '20px'] : [`${Math.round(vw - right)}px`, `${Math.round(vh - top + 12)}px`];
    if (top === Infinity) {
      const bar = document.querySelector(TAB_BAR)?.getBoundingClientRect();
      if (bar?.height && bar.top > vh / 2) pos = ['16px', `${Math.round(vh - bar.top + 16)}px`];
    }
    if (fab.style.right !== pos[0]) fab.style.right = pos[0];
    if (fab.style.bottom !== pos[1]) fab.style.bottom = pos[1];
  }

  function setOpen(v) {
    open = v;
    if (v) {
      theme();
      pages = 1;
      list.scrollTop = 0;
      render();
    }
    panel.classList.toggle('open', v);
    disarm();
  }

  fab.addEventListener('click', () => setOpen(!open));
  $('.close').addEventListener('click', () => setOpen(false));
  // A click anywhere on the page outside the drawer puts it away.
  addEventListener('pointerdown', (e) => {
    if (open && !e.composedPath().includes(host)) setOpen(false);
  }, true);
  search.addEventListener('input', () => {
    pages = 1;
    list.scrollTop = 0;
    render();
  });
  chips.addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c || c.dataset.f === filter) return;
    setFilter(c.dataset.f, true);
    pages = 1;
    list.scrollTop = 0;
    render();
  });
  ocrBtn.addEventListener('click', () => {
    if (!alive()) return;
    // After a failed download the button asks to try again.
    if (ocrOn && ocrState?.phase === 'error') {
      ocrState = { phase: 'download', progress: 0 };
      showOcr();
      chrome.storage.local.set({ ocrRetry: Date.now() }).catch(() => {});
      return;
    }
    ocrOn = !ocrOn;
    showOcr();
    chrome.storage.local.set({ ocrOn }).catch(() => {});
    if (search.value.trim()) render();
  });
  list.addEventListener('click', (e) => {
    if (!e.target.closest('.reset')) return;
    search.value = '';
    setFilter('all', true);
    render();
  });
  list.addEventListener('scroll', () => {
    if (shown.length > pages * PAGE && list.scrollTop + list.clientHeight > list.scrollHeight - 600) {
      pages++;
      render();
    }
  }, { passive: true });

  // Clearing takes two clicks instead of a confirm() dialog.
  let armTimer = 0;
  function disarm() {
    clearTimeout(armTimer);
    clearBtn.classList.remove('armed');
  }
  clearBtn.addEventListener('click', () => {
    if (!clearBtn.classList.contains('armed')) {
      clearBtn.classList.add('armed');
      armTimer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    items.clear();
    clearTimeout(saveTimer);
    if (alive()) chrome.storage.local.set({ items: [] });
    render();
  });

  // Keep X's own shortcuts (j/k, n, …) away from the search box.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    root.addEventListener(type, (e) => {
      if (e.key === 'Escape' && type === 'keydown') setOpen(false);
      e.stopPropagation();
    });
  }
  addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') setOpen(false);
  });

  // X is a single-page app: follow route changes for the button, and keep it
  // clear of X's floating buttons as they come and go.
  let lastPath = '';
  setInterval(() => {
    if (isHome()) place();
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    fab.hidden = !isHome();
    if (isHome()) theme();
  }, 500);
  addEventListener('resize', () => isHome() && place(), { passive: true });

  // ------------------------------------------------------------------- start

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === 'toggle') setOpen(!open);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ocrOn) ocrOn = !!changes.ocrOn.newValue;
    if (changes.ocrState) ocrState = changes.ocrState.newValue || null;
    if (changes.ocr) ocr = changes.ocr.newValue || {};
    if (changes.ocrOn || changes.ocrState) showOcr();
    if ((changes.ocr || changes.ocrOn) && open && search.value.trim()) scheduleRender();
    if (!changes.items) return;
    const next = changes.items.newValue || [];
    if (!next.length && items.size) items.clear(); // cleared in another tab
    if (merge(next) || !next.length) open && scheduleRender();
  });

  chrome.storage.local.get(['items', 'filter', 'ocr', 'ocrOn', 'ocrState']).then((s) => {
    merge(s.items);
    setFilter(s.filter || 'all');
    ocr = s.ocr || {};
    ocrOn = !!s.ocrOn;
    ocrState = s.ocrState || null;
    showOcr();
    document.documentElement.append(host);
    lastPath = location.pathname;
    fab.hidden = !isHome();
    theme();
    place();
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
  });
})();
