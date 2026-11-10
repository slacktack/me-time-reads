import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fmtAuthor } from './public/lib.js';

const DATA = path.join(import.meta.dirname, 'data');
const CSV_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz';
const TOP_URL = 'https://www.gutenberg.org/browse/scores/top';
const WEEK = 7 * 864e5;

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "Austen, Jane, 1775-1817 [Editor]; ..." -> "Jane Austen"
export const cleanAuthor = a => fmtAuthor((a || '').split(';')[0].replace(/\[.*?\]/g, '').replace(/,[^,]*\d[^,]*$/, '').trim());

export function toBook(r, rank) {
  return {
    id: r.id, key: `g:${r.id}`, title: r.title, author: r.author, rank,
    cover: `https://www.gutenberg.org/cache/epub/${r.id}/pg${r.id}.cover.medium.jpg`,
    subjects: r.subjects ? r.subjects.split('; ') : [],
  };
}

let books = [], byId = new Map(), top = [], topRank = new Map();

async function fresh(file, maxAge) {
  try { return Date.now() - (await fs.stat(file)).mtimeMs < maxAge; } catch { return false; }
}

async function download(url, file, gz) {
  const res = await fetch(url, { headers: { 'User-Agent': 'KindleCloneReader/1.0' }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (gz) buf = zlib.gunzipSync(buf);
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(file, buf);
}

export async function loadCatalog({ refresh = !process.env.VERCEL } = {}) {
  const csv = path.join(DATA, 'pg_catalog.csv'), topFile = path.join(DATA, 'top.html');
  // On Vercel the files come from the build step and the filesystem is read-only.
  if (!refresh) return parseFiles(csv, topFile);
  if (!(await fresh(csv, WEEK))) await download(CSV_URL, csv, true).catch(e => console.warn('catalog refresh failed:', e.message));
  if (!(await fresh(topFile, 864e5))) await download(TOP_URL, topFile).catch(e => console.warn('top list refresh failed:', e.message));
  return parseFiles(csv, topFile);
}

async function parseFiles(csv, topFile) {
  const [head, ...rows] = parseCsv(await fs.readFile(csv, 'utf8'));
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  books = rows.filter(r => r[col.Type] === 'Text').map(r => ({
    id: +r[col['Text#']], title: r[col.Title].replace(/\s*\n\s*/g, ': '), author: cleanAuthor(r[col.Authors]),
    lang: r[col.Language], subjects: r[col.Subjects], shelves: r[col.Bookshelves],
  }));
  books.forEach(b => { b.hay = `${b.title} ${b.author}`.toLowerCase(); b.topics = `${b.subjects} ${b.shelves}`.toLowerCase(); });
  byId = new Map(books.map(b => [b.id, b]));
  try {
    const ids = [...(await fs.readFile(topFile, 'utf8')).matchAll(/href="\/ebooks\/(\d+)"/g)].map(m => +m[1]);
    top = [...new Set(ids)].filter(id => byId.has(id));
    topRank = new Map(top.map((id, i) => [id, i]));
  } catch {}
  console.log(`Gutenberg catalog: ${books.length} books, ${top.length} ranked`);
}

const rankOf = b => topRank.get(b.id) ?? 1e6 + b.id;

export function search({ q = '', topic = '', page = 1, lang = 'en', per = 32 }) {
  let list;
  if (!q && !topic) list = top.map(id => byId.get(id));
  else {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const t = topic.toLowerCase();
    const ql = q.toLowerCase().trim();
    list = books.filter(b => (!lang || b.lang.split('; ').includes(lang)) && words.every(w => b.hay.includes(w)) && (!t || b.topics.includes(t)));
    const score = b => (b.title.toLowerCase() === ql ? 0 : b.title.toLowerCase().startsWith(ql) ? 1 : 2);
    list.sort((a, b) => (q ? score(a) - score(b) : 0) || rankOf(a) - rankOf(b));
  }
  const start = (page - 1) * per;
  return { books: list.slice(start, start + per).map(b => toBook(b, topRank.get(b.id))), more: list.length > start + per, count: list.length };
}

export const book = id => { const b = byId.get(+id); return b && toBook(b, topRank.get(b.id)); };

// `npm run build`: fetch the catalog so a deploy ships with it.
if (process.argv[1] === import.meta.filename) {
  await fs.rm(path.join(DATA, 'pg_catalog.csv'), { force: true });
  await fs.rm(path.join(DATA, 'top.html'), { force: true });
  await loadCatalog({ refresh: true });
}
