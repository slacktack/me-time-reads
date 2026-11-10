export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Gutenberg stores "Austen, Jane"; show "Jane Austen".
export const fmtAuthor = name => {
  if (!name) return 'Unknown author';
  const [last, first] = name.split(/,\s*/, 2);
  return first ? `${first.replace(/\s*\(.*\)/, '')} ${last}` : name;
};

export function textToHtml(txt) {
  const start = txt.search(/^\*\*\* ?START OF.*$/m);
  const end = txt.search(/^\*\*\* ?END OF.*$/m);
  let body = txt.slice(start >= 0 ? txt.indexOf('\n', start) + 1 : 0, end >= 0 ? end : undefined);
  return body.replace(/\r/g, '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
    .map(s => `<p>${esc(s).replace(/\n/g, ' ')}</p>`).join('\n');
}

// "#/read/se/jane-austen/persuasion?x=1" -> { view: 'read', key: 'se:jane-austen/persuasion', params }
export function parseRoute(hash) {
  const [path, qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(qs));
  const view = parts[0] || 'home';
  const key = parts[1] ? `${parts[1]}:${parts.slice(2).join('/')}` : null;
  return { view, key, params };
}

// Page geometry: two columns per spread on wide screens, line length capped.
export function geometry(W, margin) {
  const cols = W >= 1100 ? 2 : 1;
  const maxLine = cols === 2 ? 520 : 680;
  const m = Math.max(margin, Math.round((W / cols - maxLine) / 2));
  const gap = 2 * m;
  return { cols, m, gap, colWidth: (W - 2 * m - gap * (cols - 1)) / cols };
}

// Per book, the most recently updated copy wins (deletions are { deleted: true } tombstones).
export function mergeLibrary(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || (v?.updated || 0) > (out[k].updated || 0)) out[k] = v;
  return out;
}

// Internet Archive OCR text: drop scan noise, rejoin hyphenated and wrapped lines.
export function ocrToHtml(txt) {
  return txt.replace(/\r/g, '').split(/\n\s*\n/).map(p => p.replace(/-\n(?=[a-z])/g, '').replace(/\s*\n\s*/g, ' ').trim())
    .filter(p => {
      const letters = (p.match(/[A-Za-z]/g) || []).length;
      return p.length >= 3 && letters / p.length > 0.6 && (p.length > 30 || /^[A-Z][A-Za-z .,'’-]{2,}$/.test(p));
    })
    .map(p => p.length < 60 && p === p.toUpperCase() ? `<h3>${esc(p)}</h3>` : `<p>${esc(p)}</p>`).join('\n');
}

// Study guides, summaries and other knock-offs that crowd search results.
export function isJunkTitle(title = '', query = '') {
  const junk = /\b(summary|summaries|study guide|analysis|workbook|trivia|quiz|cliffs ?notes|sparknotes|book notes|conversation starters|lesson plans?|key takeaways)\b/i;
  return /^(paperback|hardcover|hardback|ebook|kindle edition|audiobook)\s*[-:–]/i.test(title) || (junk.test(title) && !junk.test(query));
}
