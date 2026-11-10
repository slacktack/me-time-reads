import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as catalog from './catalog.js';
import { mergeLibrary } from './public/lib.js';

const PORT = process.env.PORT || 5173;
const ROOT = path.join(import.meta.dirname, 'public');
const ALLOWED = new Set(['gutendex.com', 'www.gutenberg.org', 'gutenberg.org', 'standardebooks.org']);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// shortcut: in-memory cache, unbounded beyond MAX entries; swap for disk/Redis if hosting publicly.
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
  if (!url) { res.writeHead(400).end('host not allowed'); return; }
  const hit = cache.get(url.href);
  if (hit) { res.writeHead(200, hit.headers).end(hit.body); return; }
  try {
    const { res: up, finalUrl } = await fetchAllowed(url);
    const body = Buffer.from(await up.arrayBuffer());
    const headers = { 'Content-Type': up.headers.get('content-type') || 'text/plain', 'X-Final-Url': finalUrl, 'Cache-Control': 'public, max-age=3600' };
    if (up.ok) {
      if (cache.size >= MAX) cache.delete(cache.keys().next().value);
      cache.set(url.href, { headers, body });
    }
    res.writeHead(up.status, headers).end(body);
  } catch (e) {
    res.writeHead(502).end(String(e.message || e));
  }
}

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(ROOT, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const summaries = new Map();

async function gutenbergApi(res, u) {
  const m = u.pathname.match(/^\/api\/gutenberg\/book\/(\d+)$/);
  if (!m) {
    const p = Object.fromEntries(u.searchParams);
    return json(res, 200, catalog.search({ q: p.q?.slice(0, 200), topic: p.topic?.slice(0, 100), page: Math.max(1, +p.page || 1) }));
  }
  const b = catalog.book(m[1]);
  if (!b) return json(res, 404, { error: 'No such book' });
  if (!summaries.has(b.id)) {
    try {
      const { res: r } = await fetchAllowed(new URL(`https://www.gutenberg.org/ebooks/${b.id}`));
      const html = r.ok ? await r.text() : '';
      const m = html.match(/class="summary-text-container">([\s\S]*?)<\/div>/);
      summaries.set(b.id, m ? m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<label[\s\S]*?<\/label>/g, '').replace(/<[^>]+>/g, ' ')
        .replace(/\(This is an automatically generated summary\.\)/, '').replace(/\s+/g, ' ').trim() : '');
    } catch { /* leave uncached so a later visit retries */ }
  }
  json(res, 200, { ...b, summary: summaries.get(b.id) || '' });
}

// shortcut: one shared library for everyone using this server; add per-user sync codes before hosting publicly.
const LIB = path.join(import.meta.dirname, 'data', 'library.json');
let libWrite = Promise.resolve();
async function libraryApi(req, res) {
  let stored = {};
  try { stored = JSON.parse(await fs.readFile(LIB, 'utf8')); } catch {}
  if (req.method !== 'PUT') return json(res, 200, stored);
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 2e6) return json(res, 413, { error: 'Library too large' }); }
  let incoming;
  try { incoming = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return json(res, 400, { error: 'Expected an object' });
  const merged = mergeLibrary(stored, incoming);
  libWrite = libWrite.then(() => fs.writeFile(LIB + '.tmp', JSON.stringify(merged)).then(() => fs.rename(LIB + '.tmp', LIB)));
  await libWrite;
  json(res, 200, merged);
}

await catalog.loadCatalog();
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/proxy') return proxy(req, res, u.searchParams.get('url'));
  if (u.pathname === '/api/library') return libraryApi(req, res);
  if (u.pathname.startsWith('/api/gutenberg')) return gutenbergApi(res, u);
  return serveStatic(res, decodeURIComponent(u.pathname));
}).listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal);
  console.log(`Reader on http://localhost:${PORT}${lan ? `  (phone: http://${lan.address}:${PORT})` : ''}`);
});
