import { esc, fmtAuthor, textToHtml, ocrToHtml, isJunkTitle, parseRoute, geometry, mergeLibrary } from './lib.js';

const app = document.getElementById('app');
const SE = 'https://standardebooks.org';
const GENRES = [
  ['Adventure', 'adventure'], ['Mystery', 'detective'], ['Science fiction', 'science fiction'], ['Romance', 'love stories'],
  ['Horror', 'horror'], ['Fantasy', 'fantasy'], ['Philosophy', 'philosophy'], ['Poetry', 'poetry'],
  ['Children', 'children'], ['History', 'history'], ['Short stories', 'short stories'], ['Drama', 'drama'],
];

/* ---------- storage ---------- */
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let library = load('pw.lib', {});
const settings = Object.assign({ mode: matchMedia('(pointer: coarse) and (max-width: 760px)').matches ? 'scroll' : 'paged', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'black' : 'white', font: 'Literata', size: 19, lh: 1.6, margin: 24, align: 'justify' }, load('pw.settings', {}));
let syncTimer;
const saveLib = () => { save('pw.lib', library); clearTimeout(syncTimer); syncTimer = setTimeout(sync, 2000); };

// Progress syncs through this server so phone and computer share one library.
async function sync(keepalive = false) {
  clearTimeout(syncTimer);
  try {
    const res = await fetch('/api/library', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(library), keepalive });
    if (!res.ok) return false;
    const merged = await res.json();
    const changed = JSON.stringify(merged) !== JSON.stringify(library);
    library = mergeLibrary(library, merged);
    save('pw.lib', library);
    return changed;
  } catch { return false; }
}
addEventListener('visibilitychange', () => document.visibilityState === 'hidden' ? sync(true) : sync().then(c => c && rerenderLists()));
const inLibrary = key => library[key] && !library[key].deleted;
const meta = new Map(); // key -> book record seen this session

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name=theme-color]').content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
}
applyTheme();
const THEME_ICONS = document.getElementById('themebtn').innerHTML;
function cycleTheme() {
  const order = ['white', 'paper', 'black'];
  settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
  save('pw.settings', settings);
  applyTheme();
  document.dispatchEvent(new Event('themechange'));
}
document.getElementById('themebtn').onclick = cycleTheme;

/* ---------- network ---------- */
async function get(url, as = 'json') {
  const res = await fetch('/proxy?url=' + encodeURIComponent(url));
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return as === 'json' ? res.json() : { text: await res.text(), url: res.headers.get('X-Final-Url') || url };
}

function seList(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('li[typeof="schema:Book"]')].map(li => {
    const img = li.querySelector('img');
    return {
      key: 'se:' + li.getAttribute('about').replace(/^\/ebooks\//, ''),
      title: li.querySelector('p [property="schema:name"]')?.textContent.trim() || 'Untitled',
      author: li.querySelector('.author [property="schema:name"]')?.textContent.trim() || '',
      cover: img ? new URL(img.getAttribute('src'), SE).href : null,
    };
  });
}

const sources = {
  async gutenberg({ q = '', topic = '', page = 1 } = {}) {
    const res = await fetch(`/api/gutenberg?${new URLSearchParams({ q, topic, page })}`);
    if (!res.ok) throw new Error(`catalog answered ${res.status}`);
    return res.json();
  },
  // Every other book: catalog only. Copyrighted, so we link out to legal free reading.
  async openlibrary({ q = '', page = 1 } = {}) {
    const u = new URL('https://openlibrary.org/search.json');
    u.searchParams.set('q', q);
    u.searchParams.set('page', page);
    u.searchParams.set('limit', 24);
    u.searchParams.set('fields', 'key,title,author_name,cover_i,ebook_access,ia,first_publish_year,isbn');
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
    const d = await res.json();
    const seen = new Set();
    const books = d.docs.filter(x => x.key?.startsWith('/works/') && !isJunkTitle(x.title, q)).filter(x => {
      const k = `${x.title}|${x.author_name?.[0]}`.toLowerCase();
      return !seen.has(k) && seen.add(k);
    }).map(x => ({
      key: 'ol:' + x.key.slice(7), title: x.title, author: x.author_name?.[0] || '',
      cover: x.cover_i ? `https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg` : null,
      access: x.ebook_access || 'no_ebook', ia: x.ia?.[0] || null, year: x.first_publish_year,
      isbn: (x.isbn || []).find(i => /^97[89]\d{10}$/.test(i)) || x.isbn?.[0] || null,
    }));
    return { books, more: d.num_found > page * 24 };
  },
  async standard({ q = '', page = 1, sort = '' } = {}) {
    const u = new URL(SE + '/ebooks');
    if (q) u.searchParams.set('query', q);
    if (sort) u.searchParams.set('sort', sort);
    u.searchParams.set('per-page', 24);
    u.searchParams.set('page', page);
    const books = seList((await get(u.href, 'text')).text);
    return { books, more: books.length === 24 };
  },
};

async function bookInfo(key) {
  const m = meta.get(key);
  if (m?.summary !== undefined) return m;
  const [src, id] = splitKey(key);
  let b;
  if (src === 'ol') {
    const res = await fetch(`https://openlibrary.org/works/${id}.json`);
    if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
    const w = await res.json();
    const d = typeof w.description === 'string' ? w.description : w.description?.value || '';
    let m = meta.get(key) || library[key] || {};
    if (!m.access) {
      const r = await fetch(`https://openlibrary.org/search.json?q=key:/works/${id}&fields=author_name,cover_i,ebook_access,ia,first_publish_year,isbn`).then(r => r.json()).catch(() => ({}));
      const x = r.docs?.[0] || {};
      m = { ...m, author: m.author || x.author_name?.[0] || '', access: x.ebook_access || 'no_ebook', ia: x.ia?.[0] || null, year: x.first_publish_year,
        isbn: (x.isbn || []).find(i => /^97[89]\d{10}$/.test(i)) || x.isbn?.[0] || null, cover: m.cover || (x.cover_i ? `https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg` : null) };
    }
    b = { ...m, key, title: w.title, summary: d.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').split(/\n-{3,}|\n\*{3,}/)[0].trim(),
      subjects: (w.subjects || []).slice(0, 6), cover: m.cover || (w.covers?.[0] > 0 ? `https://covers.openlibrary.org/b/id/${w.covers[0]}-M.jpg` : null) };
  } else if (src === 'g') {
    const res = await fetch(`/api/gutenberg/book/${id}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'This book is not in the catalog.' : `catalog answered ${res.status}`);
    b = await res.json();
  }
  else {
    const doc = new DOMParser().parseFromString((await get(`${SE}/ebooks/${id}`, 'text')).text, 'text/html');
    const cover = doc.querySelector('#reading-ease ~ * img, .ebook img, picture img, img[property="schema:image"]');
    b = {
      key, title: doc.querySelector('h1')?.textContent.trim() || 'Untitled',
      author: doc.querySelector('[property="schema:author"] [property="schema:name"], .author')?.textContent.trim() || '',
      cover: cover ? new URL(cover.getAttribute('src'), SE).href : (meta.get(key)?.cover ?? null),
      summary: [...doc.querySelectorAll('#description p')].slice(0, 3).map(p => p.textContent.trim()).join('\n\n'),
      subjects: [...doc.querySelectorAll('.tags a')].map(a => a.textContent.trim()),
    };
  }
  meta.set(key, { ...meta.get(key), ...b });
  return b;
}

const splitKey = key => { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; };
const routeOf = key => splitKey(key).join('/');

async function bookText(key) {
  const [src, id] = splitKey(key);
  const hit = await idb('get', key);
  if (hit) return hit;
  let html;
  if (src === 'ol') {
    const b = await bookInfo(key);
    if (b.access !== 'public' || !b.ia) throw new Error('This book can only be borrowed, not read here.');
    const md = await get(`https://archive.org/metadata/${b.ia}`);
    const file = md.files?.find(f => f.name.endsWith('_djvu.txt'))?.name;
    if (!file) throw new Error('The Internet Archive has no text for this scan.');
    html = ocrToHtml((await get(`https://archive.org/download/${b.ia}/${encodeURIComponent(file)}`, 'text')).text);
  } else if (src === 'se') {
    const r = await get(`${SE}/ebooks/${id}/text/single-page`, 'text');
    html = clean(r.text, r.url);
  } else {
    try { const r = await get(`https://www.gutenberg.org/ebooks/${id}.html.images`, 'text'); html = clean(r.text, r.url); }
    catch { html = textToHtml((await get(`https://www.gutenberg.org/ebooks/${id}.txt.utf-8`, 'text')).text); }
    if (!html.trim()) throw new Error('This book has no readable text edition.');
  }
  await idb('put', key, html);
  return html;
}

// Downloaded books live in IndexedDB so they open offline.
let dbp;
function idb(op, key, val) {
  dbp ??= new Promise((ok, no) => {
    const r = indexedDB.open('paperwhite', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('books');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  return dbp.then(db => new Promise(ok => {
    const store = db.transaction('books', op === 'get' ? 'readonly' : 'readwrite').objectStore('books');
    const r = op === 'get' ? store.get(key) : store.put(val, key);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ok(null);
  })).catch(() => null);
}

// Third-party book HTML: strip anything executable and the Gutenberg licence boilerplate.
function clean(raw, base) {
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  doc.querySelectorAll('script,style,link,meta,iframe,object,embed,form,input,button,noscript,base,.pg-boilerplate,#pg-header,#pg-footer,#pg-machine-header').forEach(n => n.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'srcset') el.removeAttribute(a.name);
    }
    if (el.hasAttribute('src')) {
      try { const u = new URL(el.getAttribute('src'), base); /^https?:$/.test(u.protocol) ? el.setAttribute('src', u.href) : el.remove(); } catch { el.remove(); }
    }
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      const h = el.getAttribute('href');
      if (!h.startsWith('#')) {
        try {
          const u = new URL(h, base);
          if (u.href.split('#')[0] === base.split('#')[0] && u.hash) el.setAttribute('href', u.hash);
          else if (/^https?:$/.test(u.protocol)) { el.setAttribute('href', u.href); el.target = '_blank'; el.rel = 'noopener'; }
          else el.removeAttribute('href');
        } catch { el.removeAttribute('href'); }
      }
    }
  }
  return doc.body.innerHTML;
}

/* ---------- UI pieces ---------- */
const coverFallback = b => `<div class="cover-type"><b>${esc(b.title)}</b><i>${esc(b.author)}</i></div>`;
const cover = (b, eager) => `<div class="cover">${b.cover
  ? `${coverFallback(b)}<img src="${esc(b.cover)}" alt="" decoding="async" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} onload="this.classList.add('in')" onerror="this.remove()">`
  : coverFallback(b)}${b.key.startsWith('se:') ? '<span class="badge">SE</span>' : b.key.startsWith('ol:') ? (b.access === 'public' ? '<span class="badge">Free scan</span>' : '<span class="badge out">Borrow</span>') : ''}</div>`;

const progressBar = p => `<div class="progress" role="progressbar" aria-valuenow="${Math.round(p * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(p * 100).toFixed(1)}%"></span></div>`;

function tile(b) {
  meta.set(b.key, { ...meta.get(b.key), ...b });
  const lib = library[b.key];
  return `<a class="book" href="#/book/${routeOf(b.key)}">${cover(b)}<div class="meta"><div class="t">${esc(b.title)}</div><div class="a">${esc(b.author)}</div>
    ${lib?.progress ? `${progressBar(lib.progress)}<div class="pct">${Math.round(lib.progress * 100)}%</div>` : ''}</div></a>`;
}
const skeletons = n => Array.from({ length: n }, () => '<div class="book skeleton" aria-hidden="true"><div class="cover"></div><div class="meta"><div class="line"></div><div class="line short"></div></div></div>').join('');
const errorNote = e => `<p class="note">Couldn't load these books: ${esc(e.message)}. Check your connection and reload.</p>`;

function shelf(title, loader, link) {
  const id = 's' + Math.random().toString(36).slice(2);
  queueMicrotask(async () => {
    const row = document.getElementById(id);
    try {
      const books = await loader();
      if (row) row.innerHTML = books.length ? books.map(tile).join('') : '<p class="note">Nothing here yet.</p>';
    } catch (e) { if (row) row.outerHTML = errorNote(e); }
  });
  return `<section class="shelf"><h2>${esc(title)}${link ? `<a href="${link}">See all</a>` : ''}</h2><div class="shelf-row" id="${id}">${skeletons(8)}</div></section>`;
}

const recent = () => Object.values(library).filter(b => !b.deleted).sort((a, b) => b.updated - a.updated);

/* ---------- views ---------- */
const views = {
  home() {
    const nav = navId;
    const [last] = recent().filter(b => b.progress > 0 && b.progress < 0.995);
    const heroHtml = (b, label, cta) => `<section class="hero">
      <div class="glow" style="background-image:url('${esc(b.cover || '')}')" aria-hidden="true"></div>
      <a class="hero-cover" href="#/book/${routeOf(b.key)}" aria-label="${esc(b.title)} details">${cover(b, true)}</a>
      <div class="hero-text">
        <p class="kicker">${label}</p>
        <h1>${esc(b.title)}</h1>
        <p class="by">${esc(b.author)}</p>
        ${b.progress ? `<div class="hero-progress">${progressBar(b.progress)}<span>${Math.round(b.progress * 100)}%</span></div>` : ''}
        <div class="actions"><a class="btn" href="#/read/${routeOf(b.key)}">${cta}</a><a class="btn ghost" href="#/book/${routeOf(b.key)}">About this book</a></div>
      </div></section>`;
    app.innerHTML = `<div id="hero">${last ? heroHtml(last, 'Continue reading', 'Resume') : '<section class="hero skeleton-hero"></section>'}</div>
      ${recent().length ? `<section class="shelf"><h2>Your library<a href="#/library">See all</a></h2><div class="shelf-row">${recent().slice(0, 14).map(tile).join('')}</div></section>` : ''}
      ${shelf('Most read this month', async () => {
        const { books } = await sources.gutenberg();
        if (!last && nav === navId) document.getElementById('hero').innerHTML = heroHtml(books[0], 'Most read on Project Gutenberg', 'Start reading');
        return books;
      }, '#/search?src=g')}
      <section class="shelf"><h2>Browse by genre</h2><div class="genres">${GENRES.map(([n, t]) => `<a class="genre" href="#/search?topic=${encodeURIComponent(t)}">${n}</a>`).join('')}</div></section>
      ${shelf('New from Standard Ebooks', async () => (await sources.standard({ sort: 'newest' })).books, '#/search?src=se')}
      ${shelf('Mystery and detective', async () => (await sources.gutenberg({ topic: 'detective' })).books, '#/search?topic=detective')}
      ${shelf('Science fiction', async () => (await sources.gutenberg({ topic: 'science fiction' })).books, '#/search?topic=science%20fiction')}
      ${shelf('Adventure', async () => (await sources.gutenberg({ topic: 'adventure' })).books, '#/search?topic=adventure')}`;
  },

  library() {
    const books = recent();
    app.innerHTML = `<header class="page-head"><h1>Library</h1><p>${books.length} ${books.length === 1 ? 'book' : 'books'}, most recent first</p></header>
      ${books.length ? `<div class="grid">${books.map(tile).join('')}</div>` : `<div class="empty"><h2>No books yet</h2><p>Books you open are kept here with your place saved.</p><a class="btn" href="#/search">Find a book</a></div>`}`;
  },

  search({ params }) {
    const { q = '', topic = '', src = '' } = params;
    app.innerHTML = `<header class="page-head"><h1>Discover</h1><p>Search any book by title or author. 78,000 classics are free to read here.</p></header>
      <form class="searchbox" role="search"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.8 4.8-1.4 1.4-4.8-4.8A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>
        <label class="sr-only" for="q">Search by title or author</label><input id="q" type="search" placeholder="Search titles and authors" value="${esc(q)}" autocomplete="off" enterkeyhint="search"></form>
      <div class="chips">${GENRES.map(([n, t]) => `<button class="chip" data-topic="${esc(t)}" aria-pressed="${t === topic}">${n}</button>`).join('')}</div>
      <div id="results"></div>`;
    const input = app.querySelector('#q');
    app.querySelector('form').onsubmit = e => { e.preventDefault(); input.blur(); location.hash = `#/search?q=${encodeURIComponent(input.value.trim())}`; };
    app.querySelectorAll('.chip').forEach(c => c.onclick = () => {
      location.hash = c.dataset.topic === topic ? '#/search' : `#/search?topic=${encodeURIComponent(c.dataset.topic)}`;
    });
    if (!q && !topic && !src) input.focus({ preventScroll: true });

    const out = app.querySelector('#results');
    const block = (title, fn, hideEmpty) => {
      const sec = document.createElement('section');
      sec.className = 'shelf';
      sec.innerHTML = `<h2>${esc(title)}</h2><div class="grid">${skeletons(6)}</div>`;
      out.append(sec);
      const grid = sec.querySelector('.grid');
      let page = 1;
      const run = async () => {
        try {
          const r = await fn(page);
          if (page === 1) grid.innerHTML = '';
          grid.insertAdjacentHTML('beforeend', r.books.map(tile).join(''));
          if (page === 1 && !r.books.length) {
            if (hideEmpty) return sec.remove();
            sec.innerHTML = `<h2>${esc(title)}</h2><p class="note">No matches. Try an author's last name or a shorter title.</p>`;
          }
          sec.querySelector('.more')?.remove();
          if (r.more) {
            sec.insertAdjacentHTML('beforeend', '<div class="more"><button class="btn ghost">Show more</button></div>');
            sec.querySelector('.more button').onclick = e => { e.target.disabled = true; e.target.textContent = 'Loading…'; page++; run(); };
          }
        } catch (e) { grid.outerHTML = errorNote(e); }
      };
      run();
    };
    if (topic) block(GENRES.find(g => g[1] === topic)?.[0] || topic, page => sources.gutenberg({ topic, page }));
    else {
      if (src !== 'g') block(q ? 'Free to read here: Standard Ebooks' : 'Standard Ebooks, newest first', page => sources.standard({ q, page, sort: q ? '' : 'newest' }), !!q);
      if (src !== 'se') block(q ? 'Free to read here: Project Gutenberg' : 'Most read on Project Gutenberg', page => sources.gutenberg({ q, page }), !!q);
      if (q) block('All other books: borrow or preview', page => sources.openlibrary({ q, page }));
    }
  },

  async book({ key }) {
    const seen = meta.get(key) || library[key];
    const render = b => {
      const inLib = inLibrary(key);
      const [src, id] = splitKey(key);
      const pct = library[key]?.progress || 0;
      app.innerHTML = `<div class="glow detail-glow" style="background-image:url('${esc(b.cover || '')}')" aria-hidden="true"></div>
        <button class="back" onclick="history.length > 1 ? history.back() : location.hash = '#/'">${ICON.back}<span>Back</span></button>
        <article class="detail"><div class="detail-cover">${cover(b, true)}</div><div>
          <h1>${esc(b.title)}</h1><p class="by">${esc(b.author)}</p>
          ${src === 'ol' && !(b.access === 'public' && b.ia) ? outActions(b, inLib) : `<div class="actions">
            <a class="btn" href="#/read/${routeOf(key)}">${pct > 0 ? `Continue at ${Math.round(pct * 100)}%` : 'Read now'}</a>
            <button class="btn ghost" id="libtoggle">${inLib ? 'Remove from library' : 'Add to library'}</button>
            ${src === 'g' ? `<a class="btn ghost" href="https://www.gutenberg.org/ebooks/${esc(id)}.kf8.images" target="_blank" rel="noopener">Download for Kindle</a>`
              : src === 'ol' ? `<a class="btn ghost" href="https://archive.org/details/${esc(b.ia)}" target="_blank" rel="noopener">Original scan ↗</a>`
              : `<a class="btn ghost" href="${SE}/ebooks/${esc(id)}" target="_blank" rel="noopener">Downloads</a>`}
          </div>`}
          ${b.summary ? `<div class="blurb">${b.summary.split(/\n{2,}/).map(p => `<p>${esc(p.replace(/\s*\(This is an automatically generated summary\.\)/, ''))}</p>`).join('')}</div>` : b.summary === undefined ? '<div class="blurb"><div class="line"></div><div class="line"></div><div class="line short"></div></div>' : ''}
          ${src === 'ol' && b.access === 'public' ? '<p class="out-note">Free public-domain scan from the Internet Archive. The text comes from OCR, so expect the odd typo.</p>' : ''}
          <p class="facts">${src === 'ol' ? `Open Library${b.year ? `, first published ${b.year}` : ''}` : src === 'g' ? 'Project Gutenberg' : 'Standard Ebooks edition'}${b.downloads ? `, downloaded ${b.downloads.toLocaleString()} times last month` : ''}${b.subjects?.length ? `<br>${esc(b.subjects.slice(0, 5).map(s => s.split(' -- ')[0]).join(', '))}` : ''}</p>
        </div></article>`;
      app.querySelector('#libby')?.addEventListener('click', e => { if (!settings.libby) { e.preventDefault(); libraryPicker(() => render(b)); } });
      app.querySelector('#libchange')?.addEventListener('click', () => libraryPicker(() => render(b)));
      app.querySelector('#libtoggle').onclick = () => {
        if (inLib) library[key] = { key, deleted: true, updated: Date.now() };
        else library[key] = { key, title: b.title, author: b.author, cover: b.cover, access: b.access, ia: b.ia, isbn: b.isbn, year: b.year, progress: 0, updated: Date.now() };
        saveLib(); render(b);
      };
    };
    if (seen) render(seen);
    else app.innerHTML = '<p class="note">Loading book…</p>';
    const nav = navId;
    try { const b = await bookInfo(key); if (nav === navId) render({ ...seen, ...b }); }
    catch (e) { if (!seen) app.innerHTML = errorNote(e); }
  },

  read: reader,
};
let navId = 0;

function outActions(b, inLib) {
  const ext = (href, label, primary) => `<a class="btn${primary ? '' : ' ghost'}" href="${esc(href)}" target="_blank" rel="noopener">${label} <span aria-hidden="true">↗</span></a>`;
  const q = encodeURIComponent(`${b.title} ${b.author || ''}`.trim());
  const olPage = `https://openlibrary.org/works/${splitKey(b.key)[1]}`;
  const links = [];
  if (b.access === 'public' && b.ia) links.push(ext(`https://archive.org/details/${b.ia}`, 'Read free on Internet Archive', true));
  else if (b.access === 'borrowable' || b.access === 'printdisabled') links.push(ext(olPage, 'Borrow free on Open Library', true));
  const lib = settings.libby;
  links.push(`<a class="btn${links.length ? ' ghost' : ''}" id="libby" href="${lib ? `https://libbyapp.com/search/${encodeURIComponent(lib.key)}/search/query-${q}/page-1` : '#'}" ${lib ? 'target="_blank" rel="noopener"' : ''}>${lib ? `Borrow from ${esc(lib.name)}` : 'Borrow from your library'} <span aria-hidden="true">↗</span></a>`);
  links.push(ext(b.isbn ? `https://books.google.com/books?vid=ISBN${b.isbn}` : `https://www.google.com/search?tbm=bks&q=${q}`, 'Preview on Google Books'));
  return `<p class="out-note">${b.access === 'public' ? 'This book is free to read on the Internet Archive.' : 'This book is still under copyright, so its full text isn\'t free to read here. These are free, legal ways to read it.'}</p>
    <div class="actions">${links.join('')}<button class="btn ghost" id="libtoggle">${inLib ? 'Remove from library' : 'Want to read'}</button></div>
    ${lib ? `<p class="facts">Borrowing through Libby with ${esc(lib.name)}. <button class="linkish" id="libchange">Change library</button></p>` : ''}`;
}

// Pick a Libby library once; later "Borrow" links search that library directly.
function libraryPicker(done) {
  const dlg = document.createElement('dialog');
  dlg.className = 'picker';
  dlg.innerHTML = `<form method="dialog" class="picker-head"><h2>Your library</h2><button class="icon-btn" aria-label="Close">×</button></form>
    <p>Libby lends ebooks free with a library card. Search for your public library by name or city.</p>
    <div class="searchbox"><label class="sr-only" for="libq">Library name or city</label><input id="libq" type="search" placeholder="e.g. New York Public Library" autocomplete="off"></div>
    <ul class="lib-results" aria-live="polite"></ul>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  const input = dlg.querySelector('#libq'), out = dlg.querySelector('.lib-results');
  let t, seq = 0;
  input.oninput = () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { out.innerHTML = ''; return; }
    t = setTimeout(async () => {
      const mine = ++seq;
      out.innerHTML = '<li class="note">Searching…</li>';
      try {
        const d = await (await fetch(`https://locate.libbyapp.com/autocomplete/${encodeURIComponent(q)}`)).json();
        if (mine !== seq) return;
        const libs = new Map();
        for (const br of d.branches || []) for (const sys of br.systems || []) {
          if (sys.fulfillmentId && !libs.has(sys.fulfillmentId)) libs.set(sys.fulfillmentId, { key: sys.fulfillmentId, name: sys.name, place: [br.city, br.region || br.country].filter(Boolean).join(', ') });
        }
        out.innerHTML = libs.size ? [...libs.values()].slice(0, 12).map((l, i) => `<li><button data-i="${i}"><b>${esc(l.name)}</b><span>${esc(l.place)}</span></button></li>`).join('')
          : '<li class="note">No libraries found. Try your city name.</li>';
        const list = [...libs.values()];
        out.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
          settings.libby = list[+b.dataset.i];
          save('pw.settings', settings);
          dlg.close();
          done?.();
        });
      } catch { out.innerHTML = '<li class="note">Couldn\'t reach Libby. Check your connection.</li>'; }
    }, 250);
  };
  input.focus();
}

/* ---------- reader ---------- */
const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 4.6 14 3.2 5.2 12l8.8 8.8 1.4-1.4L8 12z"/></svg>',
  mark: '<svg viewBox="0 0 24 24"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-4.5L5 22V3a1 1 0 0 1 1-1zm1 2v14.3l5-3.2 5 3.2V4z"/></svg>',
  markOn: '<svg viewBox="0 0 24 24"><path d="M6 2h12a1 1 0 0 1 1 1v19l-7-4.5L5 22V3a1 1 0 0 1 1-1z"/></svg>',
  toc: '<svg viewBox="0 0 24 24"><path d="M3 5h2v2H3zm4 0h14v2H7zM3 11h2v2H3zm4 0h14v2H7zm-4 6h2v2H3zm4 0h14v2H7z"/></svg>',
};

async function reader({ key }) {
  if (key.startsWith('ol:')) {
    const b = meta.get(key) || library[key] || await bookInfo(key).catch(() => ({}));
    if (b.access !== 'public' || !b.ia) { location.replace('#/book/' + routeOf(key)); return; }
  }
  const nav = navId;
  document.body.classList.add('reading');
  const info = meta.get(key) || library[key] || { key, title: '', author: '' };
  app.innerHTML = `<div class="reader">
    <div class="r-top"><span class="ttl">${esc(info.title)}</span></div>
    <div class="pages"><div class="flow" lang="en"></div><div class="loading">Opening book…</div></div>
    <div class="r-bottom"><span id="loc"></span><span id="pct"></span></div>
    <button class="ribbon-hit" id="ribbonhit" aria-label="Bookmark this page"></button><div class="ribbon" aria-hidden="true"></div>
    <div class="chrome" hidden>
      <div class="bar-top"><button class="icon-btn" id="close" aria-label="Back to library">${ICON.back}</button><div class="ttl">${esc(info.title)}</div>
        <button class="icon-btn theme-btn" id="rthemebtn" aria-label="Change theme (white, paper, black)">${THEME_ICONS}</button>
        <button class="icon-btn" id="markbtn" aria-label="Bookmark this page" aria-pressed="false">${ICON.mark}</button>
        <button class="icon-btn" id="tocbtn" aria-label="Contents and bookmarks">${ICON.toc}</button><button class="icon-btn aa" id="aabtn" aria-label="Display settings">Aa</button></div>
      <div class="bar-bottom"><div class="loc"><span id="loc2"></span><span id="left"></span></div>
        <label class="sr-only" for="scrub">Position in book</label><input type="range" id="scrub" min="0" value="0"></div>
    </div>
    <div class="sheet" hidden></div>
  </div>`;
  const R = app.querySelector('.reader'), pagesEl = R.querySelector('.pages'), flow = R.querySelector('.flow');
  const chrome = R.querySelector('.chrome'), sheet = R.querySelector('.sheet'), scrub = R.querySelector('#scrub');
  let page = 0, total = 1, W = 0, toc = [], tocTab = 'toc';

  R.querySelector('#close').onclick = () => { location.hash = '#/book/' + routeOf(key); };

  let html;
  try {
    [html] = await Promise.all([bookText(key), bookInfo(key).then(b => Object.assign(info, b)).catch(() => {})]);
  } catch (e) {
    R.querySelector('.loading').innerHTML = `<div><p>Couldn't open this book: ${esc(e.message)}</p><a class="btn" href="#/book/${routeOf(key)}">Go back</a></div>`;
    return;
  }
  if (nav !== navId) return;
  R.querySelectorAll('.ttl').forEach(t => t.textContent = info.title);
  flow.innerHTML = html;
  R.querySelector('.loading').remove();

  if (library[key]?.deleted) library[key] = {};
  library[key] = { ...library[key], key, title: info.title, author: info.author, cover: info.cover, access: info.access, ia: info.ia, progress: library[key]?.progress || 0, updated: Date.now() };
  saveLib();

  function style() {
    const s = flow.style;
    s.setProperty('--read-font', `'${settings.font}'`);
    s.setProperty('--read-size', settings.size + 'px');
    s.setProperty('--read-lh', settings.lh);
    s.setProperty('--read-align', settings.align);
  }

  const scrollMode = () => settings.mode === 'scroll';
  let pageH = 1, flowTop = 0, fl = 0;
  // Page index of an element, in either mode.
  const pageOf = el => {
    const r = el.getBoundingClientRect();
    return Math.max(0, scrollMode() ? Math.floor((r.top - flowTop + pagesEl.scrollTop) / pageH) : Math.floor((r.left - fl) / W));
  };

  function layout() {
    const progress = Number.isFinite(library[key].progress) ? library[key].progress : 0;
    if (!pagesEl.clientWidth) return;
    W = pagesEl.clientWidth;
    pageH = pagesEl.clientHeight;
    const g = geometry(W, settings.margin);
    pagesEl.classList.toggle('scroll', scrollMode());
    flow.style.setProperty('--page-h', pageH + 'px');
    if (scrollMode()) {
      const width = Math.min(W - 2 * settings.margin, 680);
      Object.assign(flow.style, { width: width + 'px', marginLeft: Math.round((W - width) / 2) + 'px', columnWidth: 'auto', columnGap: 'normal', columnCount: 'auto', transform: 'none' });
      flowTop = flow.getBoundingClientRect().top + pagesEl.scrollTop;
      total = Math.max(1, Math.ceil((pagesEl.scrollHeight - pageH) / pageH) + 1);
    } else {
      pagesEl.scrollTop = 0;
      Object.assign(flow.style, { width: W - 2 * g.m + 'px', marginLeft: g.m + 'px', columnWidth: g.colWidth + 'px', columnGap: g.gap + 'px', columnCount: g.cols, transform: 'none' });
      flow.classList.remove('anim');
      total = Math.max(1, Math.round((flow.scrollWidth + g.gap) / W));
      fl = flow.getBoundingClientRect().left - g.m;
    }
    toc = [...flow.querySelectorAll('h1, h2, h3')].filter(h => h.textContent.trim()).slice(0, 400)
      .map(h => ({ el: h, lvl: +h.tagName[1], text: headingText(h), page: pageOf(h) }));
    scrub.max = total - 1;
    let target = Math.round(progress * (total - 1));
    // First open: skip covers, contents and imprint to the start of the story.
    if (!library[key].opened && !progress) {
      const start = flow.querySelector('[epub\\:type~="bodymatter"]')
        || toc.find(t => /^(chapter|book|part|act|stave|letter|canto)\s+(1|i|one)\b|^(1|i)\.?$/i.test(t.text))?.el;
      if (start) target = pageOf(start);
      library[key].opened = true;
    }
    go(target, false);
  }

  function go(p, animate = true) {
    const to = Math.max(0, Math.min(total - 1, p || 0));
    if (scrollMode()) {
      // Overlap a few lines so the eye keeps its place.
      pagesEl.scrollTo({ top: to * pageH, behavior: animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    } else {
      flow.classList.toggle('anim', animate);
      flow.style.transform = `translate3d(${-to * W}px,0,0)`;
    }
    setPage(to);
  }

  function setPage(p) {
    page = p;
    const pct = total > 1 ? page / (total - 1) : 1;
    const chapter = [...toc].reverse().find(t => t.page <= page);
    const next = toc.find(t => t.page > page);
    R.querySelector('#loc').textContent = scrollMode() ? (chapter?.text || info.title || '') : `Page ${page + 1} of ${total}`;
    R.querySelector('#pct').textContent = `${Math.round(pct * 100)}%`;
    R.querySelector('#loc2').textContent = chapter ? chapter.text : `Page ${page + 1} of ${total}`;
    const left = (next ? next.page : total) - page - 1;
    R.querySelector('#left').textContent = `${left} ${left === 1 ? (scrollMode() ? 'screen' : 'page') : (scrollMode() ? 'screens' : 'pages')} left in ${next ? 'chapter' : 'book'}`;
    scrub.value = page;
    showRibbon();
    library[key].progress = pct;
    library[key].updated = Date.now();
    saveLib();
  }

  let raf = 0;
  pagesEl.addEventListener('scroll', () => {
    if (!scrollMode() || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const p = Math.min(total - 1, Math.round(pagesEl.scrollTop / pageH));
      if (p !== page) setPage(p);
    });
  }, { passive: true });

  const toggleChrome = force => { chrome.hidden = force ?? !chrome.hidden; if (chrome.hidden) sheet.hidden = true; };
  const openSheet = render => { if (!sheet.hidden && sheet.dataset.kind === render.name) { sheet.hidden = true; return; } sheet.dataset.kind = render.name; render(); sheet.hidden = false; };

  function settingsSheet() {
    const seg = (name, opts) => `<div class="seg" data-k="${name}">${opts.map(([v, label, extra = '']) => `<button data-v="${v}" aria-pressed="${String(settings[name]) === String(v)}" ${extra}>${label}</button>`).join('')}</div>`;
    sheet.innerHTML = `<h3>Theme</h3>${seg('theme', [['white', 'White', 'class="swatch" style="--sw-paper:#fff;--sw-ink:#000"'], ['paper', 'Paper', 'class="swatch" style="--sw-paper:#e7e5e0;--sw-ink:#1b1c2e"'], ['sepia', 'Sepia', 'class="swatch" style="--sw-paper:#f8eedb;--sw-ink:#3b2f20"'], ['green', 'Green', 'class="swatch" style="--sw-paper:#cfe7d1;--sw-ink:#13261a"'], ['black', 'Black', 'class="swatch" style="--sw-paper:#000;--sw-ink:#d6d6d6"']])}
      <h3>Page turning</h3>${seg('mode', [['paged', 'Turn pages'], ['scroll', 'Scroll']])}
      <h3>Font</h3>${seg('font', [['Literata', '<span style="font-family:Literata">Literata</span>'], ['Source Serif 4', '<span style="font-family:\'Source Serif 4\'">Source</span>'], ['Atkinson Hyperlegible', '<span style="font-family:\'Atkinson Hyperlegible\'">Atkinson</span>']])}
      <h3>Size ${settings.size}px</h3><div class="seg"><button data-size="-1" aria-label="Smaller text" style="font-size:14px">A</button><button data-size="1" aria-label="Larger text" style="font-size:22px">A</button></div>
      <h3>Line spacing</h3>${seg('lh', [[1.4, 'Tight'], [1.6, 'Normal'], [1.85, 'Loose']])}
      <h3>Margins</h3>${seg('margin', [[16, 'Narrow'], [24, 'Normal'], [44, 'Wide']])}
      <h3>Alignment</h3>${seg('align', [['left', 'Left'], ['justify', 'Justified']])}`;
    sheet.querySelectorAll('.seg[data-k] button').forEach(b => b.onclick = () => {
      const k = b.closest('.seg').dataset.k;
      settings[k] = typeof settings[k] === 'number' ? +b.dataset.v : b.dataset.v;
      changed();
    });
    sheet.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { settings.size = Math.max(13, Math.min(34, settings.size + +b.dataset.size)); changed(); });
  }
  function changed() {
    save('pw.settings', settings);
    applyTheme(); style(); settingsSheet();
    requestAnimationFrame(layout);
  }

  /* bookmarks: stored as a fraction of the book so they survive font and size changes */
  const marks = () => library[key].marks || [];
  const markPage = m => Math.round(m.pct * (total - 1));
  const markHere = () => marks().find(m => markPage(m) === page);
  const chapterAt = p => [...toc].reverse().find(t => t.page <= p);

  function showRibbon() {
    const on = !!markHere();
    R.querySelector('.ribbon').classList.toggle('on', on);
    const btn = R.querySelector('#markbtn');
    btn.setAttribute('aria-pressed', on);
    btn.innerHTML = on ? ICON.markOn : ICON.mark;
    btn.setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark this page');
    R.querySelector('#ribbonhit').setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark this page');
  }

  function pageExcerpt() {
    const v = pagesEl.getBoundingClientRect();
    for (const el of flow.querySelectorAll('p, blockquote, li, h1, h2, h3, div:not(:has(*))')) {
      for (const r of el.getClientRects()) {
        if (r.width && r.right > v.left + 1 && r.left < v.right - 1 && r.bottom > v.top + 1 && r.top < v.bottom - 1) {
          return el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
        }
      }
    }
    return '';
  }

  let toastTimer;
  function toast(msg) {
    R.querySelector('.toast')?.remove();
    R.insertAdjacentHTML('beforeend', `<div class="toast" role="status">${esc(msg)}</div>`);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => R.querySelector('.toast')?.remove(), 1600);
  }

  function toggleMark() {
    const here = markHere();
    const pct = total > 1 ? page / (total - 1) : 0;
    library[key].marks = here ? marks().filter(m => m !== here)
      : [...marks(), { pct, chapter: chapterAt(page)?.text || '', text: pageExcerpt(), at: Date.now() }].sort((a, b) => a.pct - b.pct);
    library[key].updated = Date.now();
    saveLib();
    showRibbon();
    toast(here ? 'Bookmark removed' : 'Page bookmarked');
    if (!sheet.hidden && sheet.dataset.kind === 'tocSheet') tocSheet();
  }

  function tocSheet() {
    const cur = chapterAt(page);
    const tabs = `<div class="seg" style="margin-bottom:12px"><button data-tab="toc" aria-pressed="${tocTab === 'toc'}">Contents</button><button data-tab="marks" aria-pressed="${tocTab === 'marks'}">Bookmarks${marks().length ? ` (${marks().length})` : ''}</button></div>`;
    if (tocTab === 'marks') {
      sheet.innerHTML = tabs + (marks().length
        ? `<ul class="marks">${marks().map((m, i) => `<li><a href="#" data-m="${i}"><div class="m-head"><span>${esc(m.chapter || 'Bookmark')}</span><span>${Math.round(m.pct * 100)}%</span></div>${m.text ? `<div class="m-text">${esc(m.text)}</div>` : ''}</a><button data-del="${i}" aria-label="Remove bookmark">×</button></li>`).join('')}</ul>`
        : '<p class="note">No bookmarks yet. Tap the top-right corner of any page, or the ribbon button, to bookmark it.</p>');
      sheet.querySelectorAll('[data-m]').forEach(a => a.onclick = e => { e.preventDefault(); go(markPage(marks()[+a.dataset.m])); toggleChrome(true); });
      sheet.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
        library[key].marks = marks().filter((_, i) => i !== +b.dataset.del);
        library[key].updated = Date.now();
        saveLib(); showRibbon(); tocSheet();
      });
    } else {
      sheet.innerHTML = tabs + (toc.length
        ? `<ul class="toc">${toc.map((t, i) => `<li><a href="#" data-i="${i}" class="lvl${Math.max(2, t.lvl)}${t === cur ? ' cur' : ''}">${esc(t.text)}</a></li>`).join('')}</ul>`
        : '<p class="note">This edition has no chapter headings. Use the slider to move through the book.</p>');
      sheet.querySelectorAll('[data-i]').forEach(a => a.onclick = e => { e.preventDefault(); go(toc[+a.dataset.i].page); toggleChrome(true); });
      sheet.querySelector('.cur')?.scrollIntoView({ block: 'center' });
    }
    sheet.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tocTab = b.dataset.tab; tocSheet(); });
  }
  R.querySelector('#markbtn').onclick = toggleMark;
  R.querySelector('#rthemebtn').onclick = cycleTheme;
  const onTheme = () => { if (!sheet.hidden && sheet.dataset.kind === 'settingsSheet') settingsSheet(); };
  document.addEventListener('themechange', onTheme);
  R.querySelector('#ribbonhit').onclick = toggleMark;
  R.querySelector('#aabtn').onclick = () => openSheet(settingsSheet);
  R.querySelector('#tocbtn').onclick = () => openSheet(tocSheet);
  scrub.oninput = () => go(+scrub.value, false);

  // Taps: left third back, centre toggles menus, right forward. Links still work.
  let swiped = false;
  pagesEl.addEventListener('click', e => {
    if (swiped) { swiped = false; return; }
    if (getSelection().toString()) return;
    const a = e.target.closest('a[href]');
    if (a) {
      const h = a.getAttribute('href');
      if (h.startsWith('#')) {
        e.preventDefault();
        const t = flow.querySelector(h.length > 1 ? '#' + CSS.escape(decodeURIComponent(h.slice(1))) + ', [name="' + CSS.escape(decodeURIComponent(h.slice(1))) + '"]' : null);
        if (t) go(pageOf(t));
      }
      return;
    }
    if (!chrome.hidden) return toggleChrome(true);
    const x = (e.clientX - pagesEl.getBoundingClientRect().left) / W;
    if (x < 0.28) go(page - 1); else if (x > 0.72) go(page + 1); else toggleChrome(false);
  });
  let tx = 0, ty = 0;
  pagesEl.addEventListener('touchstart', e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  pagesEl.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { swiped = true; go(page + (dx < 0 ? 1 : -1)); setTimeout(() => swiped = false, 400); }
  }, { passive: true });
  const onKey = e => {
    if (e.target.closest?.('input')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(page + 1); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(page - 1); }
    else if (e.key === 'b' && !e.metaKey && !e.ctrlKey) toggleMark();
    else if (e.key === 'Escape') chrome.hidden ? toggleChrome(false) : toggleChrome(true);
  };
  let rt;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(layout, 150); };
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  cleanup = () => { document.removeEventListener('themechange', onTheme); removeEventListener('keydown', onKey); removeEventListener('resize', onResize); document.body.classList.remove('reading'); };

  style();
  await document.fonts.ready;
  if (nav !== navId) return;
  layout();
  // Late-loading images change the page count.
  flow.querySelectorAll('img').forEach(img => img.complete || img.addEventListener('load', onResize, { once: true }));
}

function headingText(h) {
  const c = h.cloneNode(true);
  c.querySelectorAll('.pagenum, .pageno, [class*="pagenum"], a[id^="page"], sup').forEach(n => n.remove());
  return c.textContent.replace(/[\[{]\s*[\divxlc]+\s*[\]}]/gi, ' ').replace(/\s+/g, ' ').replace(/[\s,;:]+$/, '').trim().slice(0, 80);
}

function rerenderLists() {
  const v = parseRoute(location.hash).view;
  if (v === 'home' || v === 'library') route();
}

/* ---------- router ---------- */
let cleanup = null;
function route() {
  cleanup?.(); cleanup = null;
  const r = parseRoute(location.hash);
  const view = views[r.view] ? r.view : 'home';
  navId++;
  const tab = { home: 'home', library: 'library', search: 'search' }[view];
  document.querySelectorAll('.tabbar a').forEach(a => a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  if (view !== 'read') scrollTo(0, 0);
  views[view](r);
}
addEventListener('hashchange', route);
route();
sync().then(c => c && rerenderLists());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
