import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import * as catalog from './catalog.js';
import { mergeLibrary } from './public/lib.js';

const ALLOWED = new Set(['gutendex.com', 'www.gutenberg.org', 'gutenberg.org', 'standardebooks.org', 'covers.openlibrary.org']);
// shortcut: per-instance memory cache; the CDN (s-maxage) does the heavy lifting on Vercel.
const cache = new Map();
const MAX = 300;

function allowed(u) {
  try {
    const x = new URL(u);
    const ok = ALLOWED.has(x.hostname) || x.hostname === 'archive.org' || x.hostname.endsWith('.archive.org');
    return x.protocol === 'https:' && ok ? x : null;
  } catch { return null; }
}

// Follow redirects by hand so a redirect can't escape the allowlist.
async function fetchAllowed(url, tries = 3) {
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'KindleCloneReader/1.0' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      if (next.protocol === 'http:') next.protocol = 'https:';
      url = allowed(next.href);
      if (!url) throw new Error('redirect outside allowlist');
      continue;
    }
    if (res.status >= 500 && tries > 1) { await new Promise(r => setTimeout(r, 800)); return fetchAllowed(url, tries - 1); }
    return { res, finalUrl: url.href };
  }
  throw new Error('too many redirects');
}

async function proxy(req, res, target) {
  const url = allowed(target);
  if (!url) return json(req, res, 400, { error: 'Host not allowed' });
  const hit = cache.get(url.href);
  if (hit) return send(req, res, 200, hit.headers, hit.body);
  try {
    const { res: up, finalUrl } = await fetchAllowed(url);
    const body = Buffer.from(await up.arrayBuffer());
    const type = up.headers.get('content-type') || 'text/plain';
    const image = type.startsWith('image/');
    const headers = { 'Content-Type': type, 'X-Final-Url': finalUrl,
      'Cache-Control': !up.ok ? 'no-store' : image ? 'public, max-age=2592000, s-maxage=31536000, immutable' : 'public, max-age=3600, s-maxage=86400' };
    if (up.ok && !image) {
      if (cache.size >= MAX) cache.delete(cache.keys().next().value);
      cache.set(url.href, { headers, body });
    }
    send(req, res, up.status, headers, body);
  } catch (e) {
    res.writeHead(502).end(String(e.message || e));
  }
}

// Gzip big bodies: Vercel caps function responses at 4.5 MB and book HTML can be large.
function send(req, res, code, headers, body) {
  if (body.length > 1024 && !/^image\//.test(headers['Content-Type'] || '') && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body);
    headers = { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' };
  }
  res.writeHead(code, headers).end(body);
}
const json = (req, res, code, body, cache = 'no-store') =>
  send(req, res, code, { 'Content-Type': 'application/json', 'Cache-Control': cache }, Buffer.from(JSON.stringify(body)));
const summaries = new Map();

let ready;
async function gutenbergApi(req, res, u, id) {
  await (ready ??= catalog.loadCatalog());
  const CACHE = 'public, max-age=600, s-maxage=86400';
  if (!id) {
    const p = Object.fromEntries(u.searchParams);
    return json(req, res, 200, catalog.search({ q: p.q?.slice(0, 200), topic: p.topic?.slice(0, 100), page: Math.max(1, +p.page || 1) }), CACHE);
  }
  const b = catalog.book(id);
  if (!b) return json(req, res, 404, { error: 'No such book' });
  if (!summaries.has(b.id)) {
    try {
      const { res: r } = await fetchAllowed(new URL(`https://www.gutenberg.org/ebooks/${b.id}`));
      const html = r.ok ? await r.text() : '';
      const m = html.match(/class="summary-text-container">([\s\S]*?)<\/div>/);
      summaries.set(b.id, m ? m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<label[\s\S]*?<\/label>/g, '').replace(/<[^>]+>/g, ' ')
        .replace(/\(This is an automatically generated summary\.\)/, '').replace(/\s+/g, ' ').trim() : '');
    } catch { /* leave uncached so a later visit retries */ }
  }
  json(req, res, 200, { ...b, summary: summaries.get(b.id) || '' }, summaries.has(b.id) ? CACHE : 'no-store');
}

// shortcut: one shared library for everyone using this server; add per-user sync codes before hosting publicly.
const LIB = path.join(import.meta.dirname, 'data', 'library.json');
let libWrite = Promise.resolve();
async function libraryApi(req, res) {
  // shortcut: Vercel's filesystem is read-only, so sync is off there until a store (e.g. Upstash Redis) is wired in.
  if (process.env.VERCEL) return json(req, res, 501, { error: 'Sync is not set up on this host' });
  let stored = {};
  try { stored = JSON.parse(await fs.readFile(LIB, 'utf8')); } catch {}
  if (req.method !== 'PUT') return json(req, res, 200, stored);
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 2e6) return json(req, res, 413, { error: 'Library too large' }); }
  let incoming;
  try { incoming = JSON.parse(body); } catch { return json(req, res, 400, { error: 'Invalid JSON' }); }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return json(req, res, 400, { error: 'Expected an object' });
  const merged = mergeLibrary(stored, incoming);
  libWrite = libWrite.then(() => fs.writeFile(LIB + '.tmp', JSON.stringify(merged)).then(() => fs.rename(LIB + '.tmp', LIB)));
  await libWrite;
  json(req, res, 200, merged);
}


// Routes are read from the path locally, or from ?route= when Vercel rewrites to the function.
export async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const route = u.searchParams.get('route');
  const book = u.pathname.match(/^\/api\/gutenberg\/book\/(\d+)$/)?.[1] || (route === 'book' && /^\d+$/.test(u.searchParams.get('id')) && u.searchParams.get('id'));
  if (u.pathname === '/proxy' || route === 'proxy') return proxy(req, res, u.searchParams.get('url')), true;
  if (u.pathname === '/api/library' || route === 'library') return libraryApi(req, res), true;
  if (book) return gutenbergApi(req, res, u, book), true;
  if (u.pathname === '/api/gutenberg' || route === 'search') return gutenbergApi(req, res, u), true;
  return false;
}
